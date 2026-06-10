import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, type MockAgentSetup, buildTestAppWithMockAgent } from './_helpers.js';

/**
 * S5 T7 — POST /api/v1/filesystems plan/apply (fs.create) over the S2
 * engine + the mock-agent UDS. PATCH/DELETE stay on the unsupported
 * stubs until T9–T11.
 */
describe('POST /api/v1/filesystems', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    setup.state.kv.put('/xinas/v1/observed/XiraidArray/data', {
      kind: 'XiraidArray',
      id: 'data',
      spec: {
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
        strip_size_kib: 128,
      },
      status: { state: 'optimal', volume_path: '/dev/xi_data', observed_at: '2026-06-10T12:00:00Z' },
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  const SPEC = { backing_device: '/dev/xi_data', mountpoint: '/mnt/data' };

  function count(sql: string, ...args: unknown[]): number {
    return (setup.state.db.prepare(sql).get(...args) as { n: number }).n;
  }

  async function plan(spec: Record<string, unknown>) {
    return request(setup.app)
      .post('/api/v1/filesystems')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec });
  }

  async function apply(body: Record<string, unknown>) {
    return request(setup.app)
      .post('/api/v1/filesystems')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'apply', expected_revision: 0, idempotency_key: 'idem-fs-1', ...body });
  }

  it('plan → 200 (fs + array resources); apply → 202 running with the enriched spec forwarded', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-fs' });
    const planned = await plan(SPEC);
    expect(planned.status).toBe(200);
    expect(planned.body.result.blockers).toEqual([]);
    expect(planned.body.result.affected_resources).toEqual([
      { kind: 'Filesystem', id: 'mnt-data.mount' },
      { kind: 'XiraidArray', id: 'data' },
    ]);

    const res = await apply({ plan_id: planned.body.result.plan_id });
    expect(res.status).toBe(202);
    expect(res.body.result.kind).toBe('fs.create');
    expect(res.body.result.state).toBe('running');
    expect(count('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?', res.body.result.task_id)).toBe(2);

    const begin = setup.mockAgent.lastTaskBeginParams();
    expect((begin?.spec as Record<string, unknown>)?.unit_name).toBe('mnt-data.mount');
    expect(((begin?.spec as Record<string, unknown>)?.resolved as Record<string, unknown>)?.sw).toBe(3);
  });

  it('force:true apply without dangerous → 412 dangerous_flag_required (engine)', async () => {
    const planned = await plan({ ...SPEC, force: true });
    expect(planned.status).toBe(200);
    const res = await apply({ plan_id: planned.body.result.plan_id, idempotency_key: 'idem-force' });
    expect(res.status).toBe(412);
    expect(res.body.errors[0].details?.reason).toBe('dangerous_flag_required');
  });

  it('non-zero expected_revision → 412 create_expects_revision_zero', async () => {
    const planned = await plan(SPEC);
    const res = await apply({
      plan_id: planned.body.result.plan_id,
      expected_revision: 4,
      idempotency_key: 'idem-rev',
    });
    expect(res.status).toBe(412);
    expect(res.body.errors[0].details?.reason).toBe('create_expects_revision_zero');
  });

  it('blocked plan (mountpoint taken) → apply 412 with the blockers', async () => {
    setup.state.kv.put('/xinas/v1/observed/Filesystem/mnt-data.mount', {
      kind: 'Filesystem',
      id: 'mnt-data.mount',
      status: { mountpoint: '/mnt/data', backing_device: '/dev/xi_other', observed_at: 'x' },
    });
    const planned = await plan(SPEC);
    expect(planned.body.result.blockers.map((b: { code: string }) => b.code)).toContain(
      'mountpoint_taken',
    );
    const res = await apply({ plan_id: planned.body.result.plan_id, idempotency_key: 'idem-blk' });
    expect(res.status).toBe(412);
    expect((res.body.errors[0].details?.blockers as Array<{ code: string }>).length).toBeGreaterThan(0);
  });

  it('DELETE /filesystems/:id keeps the unsupported-stub envelope (until T11)', async () => {
    const res = await request(setup.app)
      .delete('/api/v1/filesystems/mnt-data.mount')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan' });
    expect(res.status).toBeGreaterThanOrEqual(422);
    expect(String(res.body.errors[0].details?.code)).toMatch(/^EXECUTOR_/);
  });
});

// ---- T9: PATCH /filesystems/:id (one-intent mount/unmount) ----

describe('PATCH /api/v1/filesystems/:id', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    setup.state.kv.put('/xinas/v1/observed/XiraidArray/data', {
      kind: 'XiraidArray',
      id: 'data',
      spec: { name: 'data', level: 'raid5', member_disk_ids: ['d1', 'd2', 'd3', 'd4'] },
      status: { state: 'optimal', volume_path: '/dev/xi_data', observed_at: 'x' },
    });
    setup.state.kv.put('/xinas/v1/observed/Filesystem/mnt-data.mount', {
      kind: 'Filesystem',
      id: 'mnt-data.mount',
      status: {
        mountpoint: '/mnt/data',
        backing_device: '/dev/xi_data',
        mounted: true,
        observed_at: 'x',
      },
    });
  });
  afterEach(async () => {
    await setup.teardown();
  });

  function fsRevision(): number {
    return setup.state.kv.get('/xinas/v1/observed/Filesystem/mnt-data.mount')?.revision ?? 0;
  }

  async function patchPlan(spec: Record<string, unknown>) {
    return request(setup.app)
      .patch('/api/v1/filesystems/mnt-data.mount')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec });
  }

  it('identity keys → 422 fs_identity_immutable before any plan', async () => {
    const res = await patchPlan({ mountpoint: '/elsewhere' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].details?.reason).toBe('fs_identity_immutable');
    expect(res.body.errors[0].details?.field).toBe('mountpoint');
  });

  it('multi-intent → 400 INVALID_ARGUMENT', async () => {
    const res = await patchPlan({ mounted: false, grow: true });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
  });

  it('unmount plan → 200 disruptive; apply with stale revision → 412; fresh → 202', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-um' });
    const planned = await patchPlan({ mounted: false });
    expect(planned.status).toBe(200);
    expect(planned.body.result.risk_level).toBe('disruptive');
    expect(planned.body.result.observed_revision_expected).toBe(fsRevision());

    const stale = await request(setup.app)
      .patch('/api/v1/filesystems/mnt-data.mount')
      .set('Authorization', ADMIN_TOKEN)
      .send({
        mode: 'apply',
        plan_id: planned.body.result.plan_id,
        expected_revision: fsRevision() + 7,
        idempotency_key: 'idem-um-stale',
      });
    expect(stale.status).toBe(412);
    expect(stale.body.errors[0].details?.reason).toBe('observed_revision_stale');

    const res = await request(setup.app)
      .patch('/api/v1/filesystems/mnt-data.mount')
      .set('Authorization', ADMIN_TOKEN)
      .send({
        mode: 'apply',
        plan_id: planned.body.result.plan_id,
        expected_revision: fsRevision(),
        idempotency_key: 'idem-um',
      });
    expect(res.status).toBe(202);
    expect(res.body.result.kind).toBe('fs.unmount');
    expect(res.body.result.state).toBe('running');
    const begin = setup.mockAgent.lastTaskBeginParams();
    expect((begin?.spec as Record<string, unknown>)?.mountpoint).toBe('/mnt/data');
  });

  it('apply re-check: a session appearing after plan blocks the unmount apply', async () => {
    const planned = await patchPlan({ mounted: false });
    expect(planned.body.result.blockers).toEqual([]);
    setup.state.kv.put('/xinas/v1/observed/NfsSession/s1', {
      kind: 'NfsSession',
      id: 's1',
      spec: { client_addr: '10.0.0.9', export_path: '/mnt/data/x' },
      status: { proto_version: 'v4.2', locked_files: 1 },
    });
    const res = await request(setup.app)
      .patch('/api/v1/filesystems/mnt-data.mount')
      .set('Authorization', ADMIN_TOKEN)
      .send({
        mode: 'apply',
        plan_id: planned.body.result.plan_id,
        expected_revision: fsRevision(),
        idempotency_key: 'idem-recheck',
      });
    expect(res.status).toBe(412);
    expect(
      (res.body.errors[0].details?.blockers as Array<{ code: string }>).map((b) => b.code),
    ).toContain('dependent_share_active');
  });

  it('mount plan on an unknown id → 404', async () => {
    const res = await request(setup.app)
      .patch('/api/v1/filesystems/ghost.mount')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan', spec: { mounted: true } });
    expect(res.status).toBe(404);
  });
});
