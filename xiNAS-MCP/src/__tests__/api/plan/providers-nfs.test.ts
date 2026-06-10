import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../../api/errors.js';
import { PlanEngine } from '../../../api/plan/engine.js';
import type { PlanContext, PlanProvider } from '../../../api/plan/engine.js';
import { buildNfsPlanProviders } from '../../../api/plan/providers/nfs.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { SqliteKvStore } from '../../../state/backend-sqlite.js';
import { runMigrations } from '../../../state/migrations.js';

// N4.1 — the four NFS PlanProviders (s3-nfs-executor-spec §3.1–3.3, §3.5).
// Real in-memory SqliteKvStore (mirrors apply.test.ts's harness) so revision
// pins come from genuine KV reads, not fakes.
function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  const kv = new SqliteKvStore(db);

  let idCounter = 0;
  const store = new TaskStore({
    db,
    now: () => 1_000,
    newId: () => {
      idCounter += 1;
      return `task-${String(idCounter).padStart(4, '0')}`;
    },
  });

  const ctx: PlanContext = { kv };
  const engine = new PlanEngine({ store, ctx });
  for (const p of buildNfsPlanProviders()) engine.register(p);

  return { db, kv, store, ctx, engine };
}

function providerFor(kind: string): PlanProvider {
  const p = buildNfsPlanProviders().find((x) => x.operation_kind === kind);
  if (!p) throw new Error(`no provider for ${kind}`);
  return p;
}

/** A full raw share.create / share.update spec ({ id, path, clients, fsid, ... }). */
function makeShareSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    path: '/mnt/data',
    clients: [{ pattern: '10.0.0.0/8', options: ['rw'] }],
    fsid: 42,
    ...overrides,
  };
}

/** Seed an observed ExportRule at enc(path) (the N0b shape — spec.export_path). */
function seedExportRule(kv: SqliteKvStore, encId: string, exportPath: string): void {
  kv.put(`/xinas/v1/observed/ExportRule/${encId}`, {
    kind: 'ExportRule',
    id: encId,
    spec: { export_path: exportPath },
    status: { rules: [{ host: '*', options: ['rw'] }] },
  });
}

/** Seed an observed NfsSession on exportPath (the shape routes-nfs-sessions seeds). */
function seedNfsSession(kv: SqliteKvStore, clientAddr: string, exportPath: string): void {
  kv.put(`/xinas/v1/observed/NfsSession/${clientAddr}:x`, {
    kind: 'NfsSession',
    id: `${clientAddr}:${exportPath}`,
    spec: { client_addr: clientAddr, export_path: exportPath },
    status: { proto_version: 'v4.2', locked_files: 0, observed_at: new Date().toISOString() },
  });
}

/** Seed a desired Share doc (the _helpers.ts seedShare shape). */
function seedDesiredShare(kv: SqliteKvStore, id: string, path: string): void {
  kv.put(`/xinas/v1/desired/Share/${id}`, {
    kind: 'Share',
    id,
    spec: {
      path,
      clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
      fsid: 42,
    },
  });
}

async function expectInvalidArgument(p: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ApiException);
  expect((thrown as ApiException).code).toBe('INVALID_ARGUMENT');
}

async function expectNotFound(p: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ApiException);
  expect((thrown as ApiException).code).toBe('NOT_FOUND');
}

describe('share.create plan provider', () => {
  let h: ReturnType<typeof makeHarness>;
  const provider = providerFor('share.create');
  beforeEach(() => {
    h = makeHarness();
  });

  it('happy path: desired-doc mutation, freshness rev 0, compiled diff, no blockers', async () => {
    const spec = makeShareSpec();
    const result = await provider.preflight(h.ctx, spec);

    // Desired resource with the ABSENCE pin (revision 0): the apply txn reads
    // an absent row as 0, so a duplicate-id Share appearing between plan and
    // apply fails PRECONDITION_FAILED instead of silently overwriting.
    expect(result.affected_resources).toEqual([{ kind: 'Share', id: 's1', revision: 0 }]);
    expect(result.state_revision_expected).toBeUndefined();

    // Freshness pin on the encoded observed ExportRule id; absent row → 0.
    expect(result.observed_freshness_ref).toEqual({
      kind: 'ExportRule',
      id: 'mnt/data',
      revision: 0,
    });

    // One desired put with the seedShare-shaped doc ({kind,id,spec} — id NOT in spec).
    expect(result.desired_mutations).toEqual([
      {
        key: '/xinas/v1/desired/Share/s1',
        value: {
          kind: 'Share',
          id: 's1',
          spec: {
            path: '/mnt/data',
            clients: [{ pattern: '10.0.0.0/8', options: ['rw'] }],
            fsid: 42,
          },
        },
      },
    ]);

    // The diff carries the compiled export entry (defaults folded in).
    expect(result.diff).toEqual({
      action: 'create',
      export_entry: {
        path: '/mnt/data',
        clients: [{ host: '10.0.0.0/8', options: ['rw', 'async', 'no_subtree_check'] }],
      },
    });

    expect(result.risk_level).toBe('non_disruptive');
    expect(result.rollback_model).toBe('reversible');
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.lease_resources).toBeUndefined();
  });

  it('already-exported path: EXPORT_PATH_IN_USE blocker + the observed revision pinned', async () => {
    seedExportRule(h.kv, 'mnt/data', '/mnt/data');

    const result = await provider.preflight(h.ctx, makeShareSpec());

    expect(result.blockers).toEqual([
      { code: 'EXPORT_PATH_IN_USE', message: expect.stringContaining('/mnt/data') },
    ]);
    expect(result.observed_freshness_ref?.revision).toBe(1);
  });

  it('validation: relative path → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ path: 'mnt/data' })));
  });

  it('validation: unencodable path (.. segment) → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ path: '/mnt/../etc' })));
  });

  it('validation: empty clients → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ clients: [] })));
  });

  it('validation: client with empty options → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(
      provider.preflight(
        h.ctx,
        makeShareSpec({ clients: [{ pattern: '10.0.0.0/8', options: [] }] }),
      ),
    );
  });

  it('validation: missing fsid → INVALID_ARGUMENT', async () => {
    const spec = makeShareSpec();
    delete spec.fsid;
    await expectInvalidArgument(provider.preflight(h.ctx, spec));
  });

  it('validation: non-integer fsid (42.5, "Infinity") → INVALID_ARGUMENT; "17" tolerated', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ fsid: 42.5 })));
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ fsid: 'Infinity' })));
    const ok = await provider.preflight(h.ctx, makeShareSpec({ fsid: '17' }));
    expect(ok.blockers).toEqual([]);
  });

  it('validation: bad sync / security_mode enum values → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ sync: 'both' })));
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ security_mode: 'hax' })));
  });

  it('validation: non-canonical path (trailing slash) → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ path: '/mnt/data/' })));
    await expectInvalidArgument(provider.preflight(h.ctx, makeShareSpec({ path: '/mnt//data' })));
  });
});

describe('share.update plan provider', () => {
  let h: ReturnType<typeof makeHarness>;
  const provider = providerFor('share.update');
  beforeEach(() => {
    h = makeHarness();
  });

  it('no desired Share row → NOT_FOUND', async () => {
    await expectNotFound(provider.preflight(h.ctx, makeShareSpec()));
  });

  it('pins the desired revision and emits the merged desired doc', async () => {
    seedDesiredShare(h.kv, 's1', '/mnt/data'); // revision 1

    const merged = makeShareSpec({
      clients: [{ pattern: '10.1.0.0/16', options: ['ro'] }],
    });
    const result = await provider.preflight(h.ctx, merged);

    expect(result.affected_resources).toEqual([{ kind: 'Share', id: 's1', revision: 1 }]);
    expect(result.state_revision_expected).toBe(1);
    expect(result.observed_freshness_ref).toEqual({
      kind: 'ExportRule',
      id: 'mnt/data',
      revision: 0,
    });
    expect(result.desired_mutations).toEqual([
      {
        key: '/xinas/v1/desired/Share/s1',
        value: {
          kind: 'Share',
          id: 's1',
          spec: {
            path: '/mnt/data',
            clients: [{ pattern: '10.1.0.0/16', options: ['ro'] }],
            fsid: 42,
          },
        },
      },
    ]);
    expect(result.diff).toEqual({
      action: 'update',
      export_entry: {
        path: '/mnt/data',
        clients: [{ host: '10.1.0.0/16', options: ['ro', 'async', 'no_subtree_check'] }],
      },
    });
    expect(result.risk_level).toBe('changing_access');
    expect(result.rollback_model).toBe('reversible');
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns ACTIVE_NFS_SESSIONS when an observed session is on the path', async () => {
    seedDesiredShare(h.kv, 's1', '/mnt/data');
    seedNfsSession(h.kv, '10.1.2.3', '/mnt/data');
    // A session on a DIFFERENT path must not trigger the warning by itself.
    seedNfsSession(h.kv, '10.1.2.4', '/mnt/other');

    const result = await provider.preflight(h.ctx, makeShareSpec());

    expect(result.warnings).toEqual([
      { code: 'ACTIVE_NFS_SESSIONS', message: expect.stringContaining('/mnt/data') },
    ]);
  });

  it('no warning when sessions exist only on other paths', async () => {
    seedDesiredShare(h.kv, 's1', '/mnt/data');
    seedNfsSession(h.kv, '10.1.2.4', '/mnt/other');

    const result = await provider.preflight(h.ctx, makeShareSpec());
    expect(result.warnings).toEqual([]);
  });
});

describe('share.delete plan provider', () => {
  let h: ReturnType<typeof makeHarness>;
  const provider = providerFor('share.delete');
  beforeEach(() => {
    h = makeHarness();
  });

  it('no desired Share row → NOT_FOUND', async () => {
    await expectNotFound(provider.preflight(h.ctx, { id: 's1', path: '/mnt/data' }));
  });

  it('emits a delete mutation, pins the desired revision, diff.action delete', async () => {
    seedDesiredShare(h.kv, 's1', '/mnt/data'); // revision 1
    seedExportRule(h.kv, 'mnt/data', '/mnt/data'); // revision 1

    const result = await provider.preflight(h.ctx, { id: 's1', path: '/mnt/data' });

    expect(result.affected_resources).toEqual([{ kind: 'Share', id: 's1', revision: 1 }]);
    expect(result.state_revision_expected).toBe(1);
    expect(result.observed_freshness_ref).toEqual({
      kind: 'ExportRule',
      id: 'mnt/data',
      revision: 1,
    });
    expect(result.desired_mutations).toEqual([{ key: '/xinas/v1/desired/Share/s1', delete: true }]);
    expect(result.diff).toEqual({ action: 'delete', export_path: '/mnt/data' });
    expect(result.risk_level).toBe('changing_access');
    expect(result.rollback_model).toBe('reversible');
    expect(result.blockers).toEqual([]);
  });

  it('warns ACTIVE_NFS_SESSIONS when an observed session is on the path', async () => {
    seedDesiredShare(h.kv, 's1', '/mnt/data');
    seedNfsSession(h.kv, '10.1.2.3', '/mnt/data');

    const result = await provider.preflight(h.ctx, { id: 's1', path: '/mnt/data' });
    expect(result.warnings).toEqual([
      { code: 'ACTIVE_NFS_SESSIONS', message: expect.stringContaining('/mnt/data') },
    ]);
  });

  it('validation: missing id / relative path → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, { path: '/mnt/data' }));
    await expectInvalidArgument(provider.preflight(h.ctx, { id: 's1', path: 'mnt/data' }));
  });
});

describe('nfs-idmap.set plan provider', () => {
  let h: ReturnType<typeof makeHarness>;
  const provider = providerFor('nfs-idmap.set');
  beforeEach(() => {
    h = makeHarness();
  });

  it('validation: domain without a dot → INVALID_ARGUMENT', async () => {
    await expectInvalidArgument(provider.preflight(h.ctx, { domain: 'localdomain' }));
    await expectInvalidArgument(provider.preflight(h.ctx, { domain: '' }));
    await expectInvalidArgument(provider.preflight(h.ctx, {}));
  });

  it('fresh install (no observed snapshot): revision 0 pins, idmap lease, no mutations', async () => {
    const result = await provider.preflight(h.ctx, { domain: 'corp.example.com' });

    expect(result.affected_resources).toEqual([]);
    expect(result.lease_resources).toEqual([{ kind: 'NfsIdmap', id: 'snapshot' }]);
    expect(result.observed_freshness_ref).toEqual({
      kind: 'nfs_idmap',
      id: 'snapshot',
      revision: 0,
    });
    expect(result.state_revision_expected).toBe(0);
    expect(result.desired_mutations).toEqual([]);
    expect(result.diff).toEqual({
      action: 'set_domain',
      domain: 'corp.example.com',
      prior_domain: null,
    });
    expect(result.risk_level).toBe('non_disruptive');
    expect(result.rollback_model).toBe('reversible');
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('seeded observed snapshot: pins its revision and reports the prior domain', async () => {
    h.kv.put('/xinas/v1/observed/nfs_idmap/snapshot', {
      kind: 'NfsIdmap',
      status: { domain: 'old.com', conf_present: true },
    }); // revision 1

    const result = await provider.preflight(h.ctx, { domain: 'corp.example.com' });

    expect(result.observed_freshness_ref).toEqual({
      kind: 'nfs_idmap',
      id: 'snapshot',
      revision: 1,
    });
    expect(result.state_revision_expected).toBe(1);
    expect(result.diff).toEqual({
      action: 'set_domain',
      domain: 'corp.example.com',
      prior_domain: 'old.com',
    });
  });

  it('malformed observed value: no crash, prior_domain null, revision still pinned', async () => {
    // A buggy collector wrote a non-record value — the provider must read it as
    // "no prior domain", never TypeError into a 500.
    h.kv.put('/xinas/v1/observed/nfs_idmap/snapshot', 'garbage'); // revision 1

    const result = await provider.preflight(h.ctx, { domain: 'corp.example.com' });

    expect(result.observed_freshness_ref?.revision).toBe(1);
    expect((result.diff as { prior_domain: unknown }).prior_domain).toBeNull();
  });
});

describe('PlanEngine integration (N0.2 plumbing end-to-end)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  function planArgs(operation_kind: string, spec: unknown) {
    return {
      operation_kind,
      spec,
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '11111111-1111-1111-1111-111111111111',
      correlation_id: 'corr-1',
    };
  }

  it('share.create through PlanEngine.plan persists the plan_binding fields', async () => {
    const spec = makeShareSpec();
    const { task } = await h.engine.plan(planArgs('share.create', spec));

    expect(task.state).toBe('plan_only');
    const persisted = h.store.get(task.task_id);
    expect(persisted?.plan_binding).toEqual({
      observed_freshness_ref: { kind: 'ExportRule', id: 'mnt/data', revision: 0 },
      desired_mutations: [
        {
          key: '/xinas/v1/desired/Share/s1',
          value: {
            kind: 'Share',
            id: 's1',
            spec: {
              path: '/mnt/data',
              clients: [{ pattern: '10.0.0.0/8', options: ['rw'] }],
              fsid: 42,
            },
          },
        },
      ],
    });
    // The raw request spec rides the row verbatim (T9b dispatch contract).
    expect(persisted?.spec).toEqual(spec);
  });

  it('nfs-idmap.set through PlanEngine.plan persists ALL THREE N0 fields', async () => {
    const { task } = await h.engine.plan(planArgs('nfs-idmap.set', { domain: 'corp.example.com' }));

    const persisted = h.store.get(task.task_id);
    expect(persisted?.plan_binding).toEqual({
      observed_freshness_ref: { kind: 'nfs_idmap', id: 'snapshot', revision: 0 },
      lease_resources: [{ kind: 'NfsIdmap', id: 'snapshot' }],
      desired_mutations: [],
    });
    expect(persisted?.state_revision_expected).toBe(0);
  });
});
