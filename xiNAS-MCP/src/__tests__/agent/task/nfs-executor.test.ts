/**
 * Unit tests for the five real NFS executors (S3 N3.2 + N7.3,
 * s3-nfs-executor-spec §3.1–3.5).
 *
 * Drives each executor exactly as the {@link TaskRunner} does — call each
 * `stage.run(ctx)` in order, then `executor.rollback(ctx)`, sharing the one
 * `ctx` (so the preflight-captured prior state in `ctx.stash` reaches
 * rollback). A FAKE {@link NfsHelperClient} records every call and is
 * scriptable (canned `listExports` result + a one-shot throw), and
 * `readIdmapDomain` is a plain async stub — no socket, no helper process.
 */
import { describe, expect, it } from 'vitest';
import { buildNfsExecutors, type NfsExecutorDeps } from '../../../agent/task/nfs-executor.js';
import {
  type AddExportOptions,
  type HelperExportEntry,
  NfsHelperError,
  type NfsHelperClient,
  type RenderNfsProfileResult,
} from '../../../agent/task/nfs-helper-client.js';
import type { Executor, ExecutorContext } from '../../../agent/task/types.js';

/** A recorded call against the fake helper (op name + the call arguments). */
interface RecordedCall {
  op:
    | 'listExports'
    | 'addExport'
    | 'removeExport'
    | 'updateExport'
    | 'setIdmapDomain'
    | 'renderNfsProfile';
  args: unknown[];
}

interface FakeHelper extends NfsHelperClient {
  calls: RecordedCall[];
  /** Canned result returned by listExports(). */
  listResult: HelperExportEntry[];
  /** Canned result returned by renderNfsProfile(). */
  renderResult: RenderNfsProfileResult;
  /** When set, the next call to this op throws the given error (one-shot). */
  throwOn: { op: RecordedCall['op']; error: Error } | undefined;
  /** Honor a scripted one-shot throw, then record the call. */
  record(op: RecordedCall['op'], args: unknown[]): void;
}

function makeFakeHelper(listResult: HelperExportEntry[] = []): FakeHelper {
  const calls: RecordedCall[] = [];
  const fake: FakeHelper = {
    calls,
    listResult,
    renderResult: {
      effective_files: { '/etc/nfs/nfsd.conf': 'sha256:abc' },
      restarted: false,
      reloaded: true,
    },
    throwOn: undefined,
    record(op: RecordedCall['op'], args: unknown[]): void {
      // Honor a scripted one-shot throw before recording the (failed) call.
      if (fake.throwOn && fake.throwOn.op === op) {
        const err = fake.throwOn.error;
        fake.throwOn = undefined;
        calls.push({ op, args });
        throw err;
      }
      calls.push({ op, args });
    },
    async listExports(): Promise<HelperExportEntry[]> {
      fake.record('listExports', []);
      return fake.listResult;
    },
    async addExport(entry: HelperExportEntry, opts?: AddExportOptions): Promise<void> {
      fake.record('addExport', [entry, opts]);
    },
    async removeExport(path: string): Promise<void> {
      fake.record('removeExport', [path]);
    },
    async updateExport(
      path: string,
      patch: { clients: HelperExportEntry['clients'] },
    ): Promise<void> {
      fake.record('updateExport', [path, patch]);
    },
    async setIdmapDomain(domain: string): Promise<void> {
      fake.record('setIdmapDomain', [domain]);
    },
    async renderNfsProfile(
      spec: Record<string, unknown>,
      restart: boolean,
    ): Promise<RenderNfsProfileResult> {
      fake.record('renderNfsProfile', [spec, restart]);
      return fake.renderResult;
    },
  };
  return fake;
}

/** Minimal fake ExecutorContext with a writable `stash` (shared across stages). */
function makeCtx(spec: unknown): ExecutorContext {
  return {
    spec,
    emitOutput(): void {},
    isCancelRequested(): boolean {
      return false;
    },
    stash: {},
  };
}

function getExecutor(deps: NfsExecutorDeps, kind: string): Executor {
  const ex = buildNfsExecutors(deps).find((e) => e.operation_kind === kind);
  if (!ex) throw new Error(`no executor for ${kind}`);
  return ex;
}

function stage(ex: Executor, name: string) {
  const s = ex.stages.find((st) => st.name === name);
  if (!s) throw new Error(`no stage ${name} on ${ex.operation_kind}`);
  return s;
}

/** Deps with a no-op readIdmapDomain unless overridden. */
function makeDeps(
  helper: NfsHelperClient,
  readIdmapDomain: () => Promise<string | undefined> = async () => undefined,
): NfsExecutorDeps {
  return { helper, readIdmapDomain };
}

describe('buildNfsExecutors — registration', () => {
  it('returns exactly the five expected operation kinds', () => {
    const list = buildNfsExecutors(makeDeps(makeFakeHelper()));
    expect(list.map((e) => e.operation_kind).sort()).toEqual(
      [
        'nfs-idmap.set',
        'nfs-profile.update',
        'share.create',
        'share.delete',
        'share.update',
      ].sort(),
    );
  });
});

describe('share.create', () => {
  const spec = {
    id: 's1',
    path: '/mnt/data',
    fsid: '42',
    clients: [{ pattern: '10.0.0.0/24', options: ['rw'] }],
  };

  it('apply calls addExport with the compiled entry + create_path:true', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);

    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);

    const addCall = helper.calls.find((c) => c.op === 'addExport');
    expect(addCall).toBeDefined();
    const [entry, opts] = addCall?.args as [HelperExportEntry, AddExportOptions];
    // Compiled entry: path preserved, client folded with default tokens.
    expect(entry.path).toBe('/mnt/data');
    expect(entry.clients[0]?.host).toBe('10.0.0.0/24');
    expect(entry.clients[0]?.options).toContain('rw');
    expect(entry.clients[0]?.options).toContain('no_subtree_check'); // hardening default
    expect(opts.create_path).toBe(true);
    expect(opts.path_mode).toBe('0755');
  });

  it('preflight throws EXPORT_PATH_IN_USE when listExports already has the path', async () => {
    const helper = makeFakeHelper([{ path: '/mnt/data', clients: [] }]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await expect(stage(ex, 'preflight').run(ctx)).rejects.toThrow(/EXPORT_PATH_IN_USE/);
    // It must NOT proceed to addExport.
    expect(helper.calls.some((c) => c.op === 'addExport')).toBe(false);
  });

  it('verify passes when listExports contains the path', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.listResult = [{ path: '/mnt/data', clients: [] }];
    await expect(stage(ex, 'verify').run(ctx)).resolves.toBeUndefined();
  });

  it('verify throws when listExports does NOT contain the path', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.listResult = []; // still absent
    await expect(stage(ex, 'verify').run(ctx)).rejects.toThrow();
  });

  it('rollback calls removeExport(path)', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    await ex.rollback(ctx);
    const rm = helper.calls.find((c) => c.op === 'removeExport');
    expect(rm).toBeDefined();
    expect(rm?.args[0]).toBe('/mnt/data');
  });

  it('rollback swallows NOT_FOUND (apply never wrote the export) — idempotent', async () => {
    const helper = makeFakeHelper([]);
    helper.throwOn = {
      op: 'removeExport',
      error: new NfsHelperError('NOT_FOUND', 'no such export'),
    };
    const ex = getExecutor(makeDeps(helper), 'share.create');
    // rollback must NOT throw — the line was never committed, so undo is complete.
    await expect(ex.rollback(makeCtx(spec))).resolves.toBeUndefined();
  });

  it('rollback rethrows a non-NOT_FOUND helper error', async () => {
    const helper = makeFakeHelper([]);
    helper.throwOn = {
      op: 'removeExport',
      error: new NfsHelperError('INTERNAL', 'exportfs failed'),
    };
    const ex = getExecutor(makeDeps(helper), 'share.create');
    await expect(ex.rollback(makeCtx(spec))).rejects.toThrow(/exportfs failed/);
  });
});

describe('share.update', () => {
  const spec = {
    id: 's1',
    path: '/mnt/data',
    clients: [{ pattern: '10.0.0.0/24', options: ['ro'] }],
  };
  const priorEntry: HelperExportEntry = {
    path: '/mnt/data',
    clients: [{ host: '10.0.0.0/24', options: ['rw', 'no_subtree_check'] }],
  };

  it('preflight stashes the prior entry for the path', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorEntry).toEqual(priorEntry);
  });

  it('preflight stashes null when the path is absent', async () => {
    const helper = makeFakeHelper([]); // no entry for the path
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorEntry).toBeNull();
  });

  it('apply calls updateExport(path, {clients}) with the compiled clients', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    const up = helper.calls.find((c) => c.op === 'updateExport');
    expect(up).toBeDefined();
    expect(up?.args[0]).toBe('/mnt/data');
    const patch = up?.args[1] as { clients: HelperExportEntry['clients'] };
    expect(patch.clients[0]?.host).toBe('10.0.0.0/24');
    expect(patch.clients[0]?.options).toContain('ro');
  });

  it('rollback restores prior clients via updateExport(path, {clients: prior})', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0; // isolate rollback calls
    await ex.rollback(ctx);
    const up = helper.calls.find((c) => c.op === 'updateExport');
    expect(up).toBeDefined();
    expect(up?.args[0]).toBe('/mnt/data');
    const patch = up?.args[1] as { clients: HelperExportEntry['clients'] };
    expect(patch.clients).toEqual(priorEntry.clients);
  });

  it('rollback is a no-op when prior entry was absent', async () => {
    const helper = makeFakeHelper([]); // absent at preflight
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    expect(helper.calls.some((c) => c.op === 'updateExport')).toBe(false);
  });
});

describe('share.delete', () => {
  const spec = { id: 's1', path: '/mnt/data' };
  const priorEntry: HelperExportEntry = {
    path: '/mnt/data',
    clients: [{ host: '10.0.0.0/24', options: ['rw'] }],
  };

  it('preflight stashes the prior entry', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorEntry).toEqual(priorEntry);
  });

  it('apply calls removeExport(path)', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    const rm = helper.calls.find((c) => c.op === 'removeExport');
    expect(rm).toBeDefined();
    expect(rm?.args[0]).toBe('/mnt/data');
  });

  it('apply swallows a NfsHelperError(NOT_FOUND) as already-done', async () => {
    const helper = makeFakeHelper([priorEntry]);
    helper.throwOn = { op: 'removeExport', error: new NfsHelperError('NOT_FOUND', 'gone') };
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await expect(stage(ex, 'apply').run(ctx)).resolves.toBeUndefined();
  });

  it('apply rethrows a non-NOT_FOUND helper error', async () => {
    const helper = makeFakeHelper([priorEntry]);
    helper.throwOn = { op: 'removeExport', error: new NfsHelperError('INTERNAL', 'boom') };
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await expect(stage(ex, 'apply').run(ctx)).rejects.toThrow(/boom/);
  });

  it('rollback re-adds the stashed prior entry via addExport(prior)', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    const add = helper.calls.find((c) => c.op === 'addExport');
    expect(add).toBeDefined();
    expect((add?.args[0] as HelperExportEntry).path).toBe('/mnt/data');
    expect((add?.args[0] as HelperExportEntry).clients).toEqual(priorEntry.clients);
  });

  it('rollback is a no-op when there was no prior entry', async () => {
    const helper = makeFakeHelper([]); // absent at preflight
    helper.throwOn = { op: 'removeExport', error: new NfsHelperError('NOT_FOUND', 'gone') };
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    expect(helper.calls.some((c) => c.op === 'addExport')).toBe(false);
  });
});

describe('nfs-profile.update', () => {
  /** A full NfsProfile spec (the ADR-0005 shape the route merges to). */
  function profileSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      versions: {
        v3: { enabled: false },
        v4_0: { enabled: false },
        v4_1: { enabled: true },
        v4_2: { enabled: true },
      },
      rdma: { enabled: true, port: 20049 },
      threads: { count: 64 },
      service_policy: {
        on_thread_count_change: 'reload',
        on_version_change: 'restart',
        on_rdma_change: 'restart',
        on_v3_settings_change: 'restart',
      },
      ...overrides,
    };
  }

  it('apply renders the merged profile with restart=false (thread change, reload policy)', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'nfs-profile.update');
    const prior = profileSpec();
    const profile = profileSpec({ threads: { count: 128 } }); // policy: reload
    const ctx = makeCtx({ profile, prior_profile: prior });

    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);

    const render = helper.calls.find((c) => c.op === 'renderNfsProfile');
    expect(render).toBeDefined();
    expect(render?.args[0]).toEqual(profile); // the FULL merged spec, verbatim
    expect(render?.args[1]).toBe(false); // on_thread_count_change: reload → no restart
  });

  it('apply derives restart=true when the changed dimension policy is restart', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'nfs-profile.update');
    const restartPolicy = {
      on_thread_count_change: 'restart',
      on_version_change: 'restart',
      on_rdma_change: 'restart',
      on_v3_settings_change: 'restart',
    };
    const prior = profileSpec({ service_policy: restartPolicy });
    const profile = profileSpec({ threads: { count: 256 }, service_policy: restartPolicy });
    const ctx = makeCtx({ profile, prior_profile: prior });

    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);

    const render = helper.calls.find((c) => c.op === 'renderNfsProfile');
    expect(render?.args).toEqual([profile, true]);
  });

  it('apply derives restart=false when nothing changed', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'nfs-profile.update');
    const spec = profileSpec();
    const ctx = makeCtx({ profile: spec, prior_profile: profileSpec() });

    await stage(ex, 'apply').run(ctx);

    const render = helper.calls.find((c) => c.op === 'renderNfsProfile');
    expect(render?.args[1]).toBe(false);
  });

  it('rollback re-renders the PRIOR profile with the SAME derived restart flag', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'nfs-profile.update');
    // rdma change with on_rdma_change: restart → forward restart=true.
    const prior = profileSpec();
    const profile = profileSpec({ rdma: { enabled: false, port: 20049 } });
    const ctx = makeCtx({ profile, prior_profile: prior });

    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0; // isolate rollback calls
    await ex.rollback(ctx);

    const render = helper.calls.find((c) => c.op === 'renderNfsProfile');
    expect(render).toBeDefined();
    expect(render?.args).toEqual([prior, true]); // prior spec, same flag
  });

  it('preflight throws a clear error when profile/prior_profile is missing', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'nfs-profile.update');
    await expect(stage(ex, 'preflight').run(makeCtx({ profile: profileSpec() }))).rejects.toThrow(
      /prior_profile/,
    );
    await expect(
      stage(ex, 'preflight').run(makeCtx({ prior_profile: profileSpec() })),
    ).rejects.toThrow(/spec\.profile/);
    expect(helper.calls.some((c) => c.op === 'renderNfsProfile')).toBe(false);
  });
});

describe('nfs-idmap.set', () => {
  const spec = { domain: 'new.example.com' };

  it('preflight stashes the prior domain via readIdmapDomain', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => 'old.example.com'),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorDomain).toBe('old.example.com');
  });

  it('apply calls setIdmapDomain(domain)', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => 'old.example.com'),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    const set = helper.calls.find((c) => c.op === 'setIdmapDomain');
    expect(set).toBeDefined();
    expect(set?.args[0]).toBe('new.example.com');
  });

  it('rollback restores the prior domain via setIdmapDomain(prior)', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => 'old.example.com'),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    const set = helper.calls.find((c) => c.op === 'setIdmapDomain');
    expect(set).toBeDefined();
    expect(set?.args[0]).toBe('old.example.com');
  });

  it('rollback is a no-op when the prior domain was unset', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => undefined),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    expect(helper.calls.some((c) => c.op === 'setIdmapDomain')).toBe(false);
  });
});

describe('spec narrowing', () => {
  it('share.create preflight throws a clear error on a malformed spec', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx({ id: 's1' }); // missing path/clients
    await expect(stage(ex, 'preflight').run(ctx)).rejects.toThrow();
  });

  it('nfs-idmap.set apply throws a clear error when domain is missing', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'nfs-idmap.set');
    const ctx = makeCtx({}); // no domain
    await expect(stage(ex, 'preflight').run(ctx)).resolves.toBeUndefined();
    await expect(stage(ex, 'apply').run(ctx)).rejects.toThrow();
  });
});
