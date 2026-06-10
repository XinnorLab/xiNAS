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

  it('PATCH/DELETE /filesystems/:id keep the unsupported-stub envelope (until T9-T11)', async () => {
    for (const method of ['patch', 'delete'] as const) {
      const res = await request(setup.app)
        [method]('/api/v1/filesystems/mnt-data.mount')
        .set('Authorization', ADMIN_TOKEN)
        .send({ mode: 'plan' });
      expect(res.status).toBeGreaterThanOrEqual(422);
      expect(String(res.body.errors[0].details?.code)).toMatch(/^EXECUTOR_/);
    }
  });
});
