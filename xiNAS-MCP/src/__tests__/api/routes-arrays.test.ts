import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, type MockAgentSetup, buildTestAppWithMockAgent } from './_helpers.js';

/**
 * S3 T8 — POST /api/v1/arrays plan/apply (xiraid.array.create) over the S2
 * engine + the mock-agent UDS. PATCH/DELETE stay on the unsupported stubs.
 */
describe('POST /api/v1/arrays', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
    for (const d of ['nvme1n1', 'nvme2n1', 'nvme3n1', 'nvme4n1']) {
      setup.state.kv.put(`/xinas/v1/observed/Disk/${d}`, {
        kind: 'Disk',
        id: d,
        status: {
          name: d,
          device_path: `/dev/${d}`,
          safe_for_use: true,
          system_disk: false,
          mounted: false,
          observed_at: '2026-06-10T12:00:00Z',
        },
      });
    }
  });
  afterEach(async () => {
    await setup.teardown();
  });

  const GOOD_SPEC = {
    name: 'data',
    level: 'raid6',
    member_disk_ids: ['nvme1n1', 'nvme2n1', 'nvme3n1', 'nvme4n1'],
  };

  function count(sql: string, ...args: unknown[]): number {
    return (setup.state.db.prepare(sql).get(...args) as { n: number }).n;
  }

  async function plan(spec: Record<string, unknown>) {
    return request(setup.app)
      .post('/api/v1/arrays')
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ mode: 'plan', spec });
  }

  async function apply(body: Record<string, unknown>) {
    return request(setup.app)
      .post('/api/v1/arrays')
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ mode: 'apply', expected_revision: 0, idempotency_key: 'idem-1', ...body });
  }

  it('mode=plan → 200 with plan_id, no blockers, array-first resources, rendered diff', async () => {
    const res = await plan(GOOD_SPEC);
    expect(res.status).toBe(200);
    const p = res.body.result;
    expect(typeof p.plan_id).toBe('string');
    expect(p.risk_level).toBe('non_disruptive');
    expect(p.rollback_model).toBe('non_disruptive');
    expect(p.blockers).toEqual([]);
    expect(p.affected_resources[0]).toEqual({ kind: 'XiraidArray', id: 'data' });
    expect(p.diff.raid_create_request).toMatchObject({ name: 'data', level: '6' });
  });

  it('mode=plan with blockers → 200 listing them; apply of that plan → 412', async () => {
    const spec = { ...GOOD_SPEC, member_disk_ids: ['ghost1', 'ghost2', 'ghost3', 'ghost4'] };
    const planned = await plan(spec);
    expect(planned.status).toBe(200);
    expect(planned.body.result.blockers.map((b: { code: string }) => b.code)).toContain(
      'disk_not_found',
    );

    const res = await apply({ plan_id: planned.body.result.plan_id });
    expect(res.status).toBe(412);
    expect(res.body.errors[0].details?.blockers?.length).toBeGreaterThan(0);
  });

  it('apply happy path → 202 running task, leases on array + member disks, enriched spec forwarded', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-arr' });
    const planned = await plan(GOOD_SPEC);
    const res = await apply({ plan_id: planned.body.result.plan_id });

    expect(res.status).toBe(202);
    const task = res.body.result;
    expect(task.state).toBe('running');
    expect(task.kind).toBe('xiraid.array.create');
    expect(task.agent_acceptance_id).toBe('acc-arr');

    // Leases: 1 array + 4 member disks.
    expect(count('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?', task.task_id)).toBe(5);

    // The forwarded task.begin spec carries device_by_id (T7 enrichment).
    const begin = setup.mockAgent.lastTaskBeginParams();
    expect((begin?.spec as Record<string, unknown>)?.device_by_id).toEqual({
      nvme1n1: '/dev/nvme1n1',
      nvme2n1: '/dev/nvme2n1',
      nvme3n1: '/dev/nvme3n1',
      nvme4n1: '/dev/nvme4n1',
    });
  });

  it('expected_revision must be 0 for create; missing → 400', async () => {
    const planned = await plan(GOOD_SPEC);
    const planId = planned.body.result.plan_id;

    const wrong = await apply({ plan_id: planId, expected_revision: 3 });
    expect(wrong.status).toBe(412);
    expect(wrong.body.errors[0].details?.reason).toBe('create_expects_revision_zero');

    const missing = await request(setup.app)
      .post('/api/v1/arrays')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'apply', plan_id: planId, idempotency_key: 'k' });
    expect(missing.status).toBe(400);
  });

  it('duplicate idempotency_key + same plan → 202 same task, no second task.begin', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-1' });
    const planned = await plan(GOOD_SPEC);
    const planId = planned.body.result.plan_id;

    const first = await apply({ plan_id: planId, idempotency_key: 'idem-dup' });
    expect(first.status).toBe(202);

    const second = await apply({ plan_id: planId, idempotency_key: 'idem-dup' });
    expect(second.status).toBe(202);
    expect(second.body.result.task_id).toBe(first.body.result.task_id);
    // Replay returns the SAME task (no second row); one apply task exists.
    expect(
      count('SELECT COUNT(*) AS n FROM tasks WHERE state != ?', 'plan_only'),
    ).toBe(1);
  });

  it('agent unavailable → 503, task failed FAILED_BEFORE_CHANGE, leases released', async () => {
    const planned = await plan(GOOD_SPEC);
    await setup.mockAgent.simulateOffline();

    const res = await apply({ plan_id: planned.body.result.plan_id });
    expect(res.status).toBe(503);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(count('SELECT COUNT(*) AS n FROM leases')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE state = ? AND error_code = ?', 'failed', 'FAILED_BEFORE_CHANGE')).toBe(1);
  });

  it('import-shaped spec → 422 EXECUTOR_UNSUPPORTED (deferred)', async () => {
    const res = await plan({ uuid: 'abcd-1234' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNSUPPORTED');
  });

  it('DELETE /arrays/:id keeps the unsupported-stub envelope (until S4 T9)', async () => {
    const res = await request(setup.app)
      .delete('/api/v1/arrays/data')
      .set('Authorization', ADMIN_TOKEN)
      .send({ mode: 'plan' });
    // handlers/unsupported.ts semantics (422 online / 503 offline / 500 while
    // the tracker is still 'unknown' in this harness) — the point is that the
    // deferred verb did NOT fall through to the real arrays route.
    expect(res.status).toBeGreaterThanOrEqual(422);
    expect(String(res.body.errors[0].details?.code)).toMatch(/^EXECUTOR_/);
  });

  // ---- S4 T5: PATCH /arrays/:id (xiraid.array.modify) ----

  describe('PATCH /arrays/:id', () => {
    function seedObservedArray(spares: string[] = []): void {
      setup.state.kv.put('/xinas/v1/observed/XiraidArray/data', {
        kind: 'XiraidArray',
        id: 'data',
        spec: {
          name: 'data',
          level: 'raid6',
          member_disk_ids: ['nvme1n1', 'nvme2n1', 'nvme3n1', 'nvme4n1'],
          spare_disk_ids: spares,
        },
        status: {
          state: 'optimal',
          volume_path: '/dev/xi_data',
          observed_at: '2026-06-10T12:00:00Z',
        },
      });
    }

    function currentRevision(): number {
      const row = setup.state.kv.get('/xinas/v1/observed/XiraidArray/data');
      return (row as { revision: number }).revision;
    }

    async function patchPlan(spec: Record<string, unknown>) {
      return request(setup.app)
        .patch('/api/v1/arrays/data')
        .set('Authorization', ADMIN_TOKEN)
        .send({ mode: 'plan', spec });
    }

    it('topology key in the raw body → 422 per-field UNSUPPORTED, no plan row', async () => {
      seedObservedArray();
      const res = await patchPlan({ level: 'raid5' });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].details?.field).toBe('spec.level');
      expect(res.body.errors[0].details?.reason).toBe('topology_immutable');
      expect(count('SELECT COUNT(*) AS n FROM tasks')).toBe(0);
    });

    it('plan + apply happy path: 202 running, array + spare leased', async () => {
      seedObservedArray();
      setup.state.kv.put('/xinas/v1/observed/Disk/nvme5n1', {
        kind: 'Disk',
        id: 'nvme5n1',
        status: {
          name: 'nvme5n1',
          device_path: '/dev/nvme5n1',
          safe_for_use: true,
          system_disk: false,
          mounted: false,
          observed_at: '2026-06-10T12:00:00Z',
        },
      });
      setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-mod' });

      const planned = await patchPlan({ spare_disk_ids: ['nvme5n1'], tuning: { init_prio: 20 } });
      expect(planned.status).toBe(200);
      expect(planned.body.result.blockers).toEqual([]);

      // seed the spare disk the plan referenced
      const res = await request(setup.app)
        .patch('/api/v1/arrays/data')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          mode: 'apply',
          plan_id: planned.body.result.plan_id,
          expected_revision: currentRevision(),
          idempotency_key: 'idem-mod-1',
        });
      expect(res.status).toBe(202);
      expect(res.body.result.state).toBe('running');
      expect(res.body.result.kind).toBe('xiraid.array.modify');
      // leases: the array + the touched spare disk
      expect(
        count('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?', res.body.result.task_id),
      ).toBe(2);
      // the forwarded spec carries id + device_by_id
      const begin = setup.mockAgent.lastTaskBeginParams();
      expect((begin?.spec as Record<string, unknown>)?.id).toBe('data');
    });

    it('stale expected_revision → 412 observed_revision_stale', async () => {
      seedObservedArray();
      const planned = await patchPlan({ tuning: { init_prio: 5 } });
      const res = await request(setup.app)
        .patch('/api/v1/arrays/data')
        .set('Authorization', ADMIN_TOKEN)
        .send({
          mode: 'apply',
          plan_id: planned.body.result.plan_id,
          expected_revision: currentRevision() + 7,
          idempotency_key: 'idem-mod-2',
        });
      expect(res.status).toBe(412);
      expect(res.body.errors[0].details?.reason).toBe('observed_revision_stale');
    });

    it('unknown array → 404 on plan', async () => {
      const res = await request(setup.app)
        .patch('/api/v1/arrays/ghost')
        .set('Authorization', ADMIN_TOKEN)
        .send({ mode: 'plan', spec: { tuning: { init_prio: 5 } } });
      expect(res.status).toBe(404);
    });
  });
});
