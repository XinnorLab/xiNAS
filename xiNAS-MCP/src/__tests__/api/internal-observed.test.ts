import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { type TestSetup, buildTestApp } from './_helpers.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-h3';

async function buildAppWithAgent(): Promise<
  TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker }
> {
  const setup = await buildTestApp();
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: CONTROLLER_ID,
    state: setup.state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });

  // Re-create app with the patched config + tracker wired to the context.
  // In the real app, createApp() accepts the tracker via ApiContext;
  // for tests we can extend ctx with the tracker.
  const { createAppWithTracker } = await import('../../api/app.js');
  const ctx = { config: setup.config, state: setup.state, tracker };
  const app = createAppWithTracker(ctx);

  return {
    ...setup,
    app,
    tracker,
    async cleanup() {
      await setup.cleanup();
    },
  };
}

describe('POST /internal/v1/observed', () => {
  let setup: TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker };

  beforeEach(async () => {
    setup = await buildAppWithAgent();
  });

  afterEach(() => setup.cleanup());

  it('accepts a valid observation batch and upserts deltas', async () => {
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [
        {
          kind: 'Disk',
          id: 'nvme0n1',
          op: 'upsert',
          value: { name: 'nvme0n1', status: { model: 'Test' } },
        },
      ],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ accepted: 1, deleted_by_reconcile: 0 });

    const stored = setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1');
    expect(stored).not.toBeNull();
    expect((stored?.value as { name?: string })?.name).toBe('nvme0n1');
  });

  it('reconciles: deletes keys under prefix not in the batch when complete_snapshots includes the kind', async () => {
    // Pre-seed a stale Disk entry.
    setup.state.kv.put('/xinas/v1/observed/Disk/stale-disk', { name: 'stale' });
    setup.state.kv.put('/xinas/v1/observed/Disk/nvme0n1', { name: 'old' });

    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [{ kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: { name: 'nvme0n1-new' } }],
      complete_snapshots: ['Disk'],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.result.deleted_by_reconcile).toBe(1);

    // stale-disk should be gone
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/stale-disk')).toBeNull();
    // nvme0n1 should be updated
    const stored = setup.state.kv.get<{ name: string }>('/xinas/v1/observed/Disk/nvme0n1');
    expect(stored?.value.name).toBe('nvme0n1-new');
  });

  it('applies delete ops', async () => {
    setup.state.kv.put('/xinas/v1/observed/Disk/nvme0n1', { name: 'existing' });

    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [{ kind: 'Disk', id: 'nvme0n1', op: 'delete' }],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')).toBeNull();
  });

  it('rejects wrong controller_id with 400 INVALID_ARGUMENT', async () => {
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: '11111111-1111-1111-1111-111111111111',
      deltas: [],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.errors[0]?.code).toBe('INVALID_ARGUMENT');
    expect(res.body.errors[0]?.message).toMatch(/controller_id/);
  });

  it('rejects without agent bearer with 401', async () => {
    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', 'Bearer tok-admin')
      .send({
        observed_at: new Date().toISOString(),
        controller_id: CONTROLLER_ID,
        deltas: [],
        complete_snapshots: [],
      });
    expect(res.status).toBe(401);
  });

  it('rejects a delta with a traversal-looking id (../../events/x) with 400 INVALID_ARGUMENT', async () => {
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [{ kind: 'Disk', id: '../../events/x', op: 'upsert', value: {} }],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.errors[0]?.code).toBe('INVALID_ARGUMENT');
    expect(res.body.errors[0]?.message).toMatch(/invalid id/);
  });

  it('accepts a delta with a colon+slash id (NfsSession 10.1.2.3:/srv/share01)', async () => {
    // ctx.observedSchemas is unset in the test context → schema validation is
    // skipped; only the id-shape check applies. The NfsSession kind key is
    // 'nfs_session' via observedSegment, but the id itself is the address.
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [
        {
          kind: 'NfsSession',
          id: '10.1.2.3:/srv/share01',
          op: 'upsert',
          value: { client_addr: '10.1.2.3' },
        },
      ],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.result.accepted).toBe(1);
  });

  it('accepts an absolute-path id (ExportRule /mnt/share/proj); still rejects // and trailing /', async () => {
    // S5 T12: ExportRule ids ARE export paths (NfsCollector key design).
    // The old leading-'/' rejection bounced the WHOLE batch the moment any
    // export existed.
    const send = (id: string) =>
      request(setup.app)
        .post('/internal/v1/observed')
        .set('Authorization', `Bearer ${AGENT_TOKEN}`)
        .send({
          observed_at: new Date().toISOString(),
          controller_id: CONTROLLER_ID,
          deltas: [{ kind: 'ExportRule', id, op: 'upsert', value: { export_path: id } }],
          complete_snapshots: [],
        });

    const ok = await send('/mnt/share/proj');
    expect(ok.status).toBe(200);
    expect(ok.body.result.accepted).toBe(1);

    for (const bad of ['//mnt/share', '/mnt//share', '/mnt/share/', '/mnt/../etc']) {
      const res = await send(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.errors[0]?.message).toMatch(/invalid id/);
    }
  });

  it('calls recordObservationPush on the tracker', async () => {
    let pushRecorded = false;
    const origRecord = setup.tracker.recordObservationPush.bind(setup.tracker);
    setup.tracker.recordObservationPush = (at) => {
      pushRecorded = true;
      origRecord(at);
    };

    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [],
      complete_snapshots: [],
    };
    await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(pushRecorded).toBe(true);
  });
});

// ---- sweep dedupe: identical re-pushes must not bump revisions ----
// PollDriver full-sweeps every collector on its interval and collectors
// stamp a fresh observed_at each sweep; without value-dedupe every sweep
// bumped every observed revision, giving plan→apply a ≤1-sweep window
// (spurious observed_revision_stale 412s on live hosts).

describe('observed sweep dedupe (skip-unchanged)', () => {
  let setup: Awaited<ReturnType<typeof buildAppWithAgent>>;
  beforeEach(async () => {
    setup = await buildAppWithAgent();
  });
  afterEach(() => setup.cleanup());

  const DISK = (observedAt: string, model = 'T') => ({
    kind: 'Disk',
    id: 'nvme0n1',
    op: 'upsert',
    value: { kind: 'Disk', id: 'nvme0n1', status: { model, observed_at: observedAt } },
  });

  function push(deltas: unknown[], completeSnapshots: string[] = []) {
    return request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({
        observed_at: new Date().toISOString(),
        controller_id: CONTROLLER_ID,
        deltas,
        complete_snapshots: completeSnapshots,
      });
  }

  it('re-push identical apart from observed_at → revision unchanged, counted skipped', async () => {
    const first = await push([DISK('2026-06-11T10:00:00Z')]);
    expect(first.status).toBe(200);
    expect(first.body.result.accepted).toBe(1);
    const rev1 = setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')?.revision;

    const second = await push([DISK('2026-06-11T10:00:30Z')]); // only the stamp moved
    expect(second.status).toBe(200);
    expect(second.body.result.skipped_unchanged).toBe(1);
    const rev2 = setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')?.revision;
    expect(rev2).toBe(rev1);
  });

  it('real content change still bumps the revision', async () => {
    await push([DISK('2026-06-11T10:00:00Z', 'OLD')]);
    const rev1 = setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')?.revision;
    const res = await push([DISK('2026-06-11T10:00:30Z', 'NEW')]);
    expect(res.body.result.accepted).toBe(1);
    const rev2 = setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')?.revision;
    expect(rev2).toBe((rev1 ?? 0) + 1);
  });

  it('complete-snapshot reconcile keeps skipped-unchanged rows (not deleted as absent)', async () => {
    await push([DISK('2026-06-11T10:00:00Z')], ['Disk']);
    const res = await push([DISK('2026-06-11T10:00:30Z')], ['Disk']);
    expect(res.status).toBe(200);
    expect(res.body.result.deleted_by_reconcile).toBe(0);
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')).not.toBeNull();
  });

  it('key-order differences do not defeat the dedupe (canonical compare)', async () => {
    await push([
      {
        kind: 'Disk',
        id: 'nvme0n1',
        op: 'upsert',
        value: { id: 'nvme0n1', kind: 'Disk', status: { observed_at: 'x', a: 1, b: 2 } },
      },
    ]);
    const rev1 = setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')?.revision;
    const res = await push([
      {
        kind: 'Disk',
        id: 'nvme0n1',
        op: 'upsert',
        value: { kind: 'Disk', id: 'nvme0n1', status: { b: 2, a: 1, observed_at: 'y' } },
      },
    ]);
    expect(res.body.result.skipped_unchanged).toBe(1);
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')?.revision).toBe(rev1);
  });

  it('top-level observed_at (singleton shapes) is also ignored in the compare', async () => {
    const inv = (stamp: string) => ({
      kind: 'inventory',
      id: 'snapshot',
      op: 'upsert',
      value: { hostname: 'h', observed_at: stamp },
    });
    await push([inv('t1')]);
    const key = '/xinas/v1/observed/inventory/snapshot';
    const rev1 = setup.state.kv.get(key)?.revision;
    const res = await push([inv('t2')]);
    expect(res.body.result.skipped_unchanged).toBe(1);
    expect(setup.state.kv.get(key)?.revision).toBe(rev1);
  });
});
