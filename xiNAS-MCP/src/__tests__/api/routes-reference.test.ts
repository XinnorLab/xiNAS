import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, type MockAgentSetup, buildTestAppWithMockAgent } from './_helpers.js';

/**
 * T4 — POST /api/v1/reference plan/apply route + agent task.begin dispatch.
 * Drives the full path against the real mock-agent UDS (buildTestAppWithMockAgent).
 */
describe('POST /api/v1/reference', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
  });
  afterEach(async () => {
    await setup.teardown();
  });

  /** Count rows in a table for assertions. */
  function count(sql: string, ...args: unknown[]): number {
    return (setup.state.db.prepare(sql).get(...args) as { n: number }).n;
  }

  async function plan(spec: Record<string, unknown>) {
    return request(setup.app)
      .post('/api/v1/reference')
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ mode: 'plan', spec });
  }

  async function apply(plan_id: string, idempotency_key: string) {
    return request(setup.app)
      .post('/api/v1/reference')
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ mode: 'apply', plan_id, idempotency_key });
  }

  it('mode=plan → 200 with plan_id, plan_hash, risk_level, diff', async () => {
    const res = await plan({ id: 'r1', message: 'hello' });
    expect(res.status).toBe(200);
    const p = res.body.result;
    expect(typeof p.plan_id).toBe('string');
    expect(typeof p.plan_hash).toBe('string');
    expect((p.plan_hash as string).length).toBe(64);
    expect(p.risk_level).toBe('non_disruptive');
    expect(p.diff).toEqual({ id: 'r1', message: 'hello' });
    expect(p.affected_resources[0]).toMatchObject({ kind: 'Reference', id: 'r1' });
    expect(p.blockers).toEqual([]);
    expect(p.warnings).toEqual([]);

    // A plan_only task row was persisted with that id.
    expect(
      count(
        'SELECT COUNT(*) AS n FROM tasks WHERE task_id = ? AND state = ?',
        p.plan_id,
        'plan_only',
      ),
    ).toBe(1);
  });

  it('mode=apply with agent accepting → 202, running task, agent_acceptance_id, leases held', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-xyz' });

    const planned = await plan({ id: 'r1', message: 'go' });
    const planId = planned.body.result.plan_id as string;

    const res = await apply(planId, 'idem-apply-1');
    expect(res.status).toBe(202);
    const task = res.body.result;
    expect(task.task_id).toBeDefined();
    expect(task.task_id).not.toBe(planId); // a fresh apply task, not the plan row
    expect(task.state).toBe('running');
    expect(task.agent_acceptance_id).toBe('acc-xyz');

    // Lease held by the apply task.
    expect(count('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?', task.task_id)).toBe(1);
    // Persisted state matches.
    expect(
      count(
        'SELECT COUNT(*) AS n FROM tasks WHERE task_id = ? AND state = ?',
        task.task_id,
        'running',
      ),
    ).toBe(1);

    // T9b: the api forwarded the RAW executor spec (not affected_resources) to
    // the agent's task.begin, end-to-end over the UDS.
    expect(setup.mockAgent.lastTaskBeginParams()?.spec).toEqual({ id: 'r1', message: 'go' });
  });

  it('mode=apply forwards spec.fail_at_stage to the agent task.begin (T9b)', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-fail' });

    const spec = { id: 'r5', message: 'boom', fail_at_stage: 'apply' };
    const planned = await plan(spec);
    const planId = planned.body.result.plan_id as string;

    const res = await apply(planId, 'idem-apply-fail');
    expect(res.status).toBe(202);
    // The whole spec — including fail_at_stage — reaches the executor over HTTP.
    expect(setup.mockAgent.lastTaskBeginParams()?.spec).toEqual(spec);
  });

  it('agent unavailable → task failed (FAILED_BEFORE_CHANGE), leases released, 503', async () => {
    const planned = await plan({ id: 'r2', message: 'go' });
    const planId = planned.body.result.plan_id as string;

    // Take the agent offline so dispatch's task.begin gets ECONNREFUSED.
    await setup.mockAgent.simulateOffline();

    const res = await apply(planId, 'idem-apply-2');
    expect(res.status).toBe(503);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');

    // The apply task exists but is failed with FAILED_BEFORE_CHANGE; no leases linger.
    const row = setup.state.db
      .prepare('SELECT task_id, state, error_code FROM tasks WHERE state = ? LIMIT 1')
      .get('failed') as { task_id: string; state: string; error_code: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.error_code).toBe('FAILED_BEFORE_CHANGE');
    expect(count('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?', row?.task_id)).toBe(0);
    // No queued/running orphan with leases anywhere.
    expect(count('SELECT COUNT(*) AS n FROM leases')).toBe(0);
  });

  it('agent rejects with EXECUTOR_UNSUPPORTED → 422, task failed, leases released', async () => {
    setup.mockAgent.respondToTaskBegin({
      kind: 'error',
      code: -32000,
      message: 'unsupported',
      data: { code: 'EXECUTOR_UNSUPPORTED' },
    });
    const planned = await plan({ id: 'r3', message: 'go' });
    const planId = planned.body.result.plan_id as string;

    const res = await apply(planId, 'idem-apply-3');
    expect(res.status).toBe(422);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNSUPPORTED');
    expect(count('SELECT COUNT(*) AS n FROM leases')).toBe(0);
    expect(
      count(
        'SELECT COUNT(*) AS n FROM tasks WHERE state = ? AND error_code = ?',
        'failed',
        'FAILED_BEFORE_CHANGE',
      ),
    ).toBe(1);
  });

  it('duplicate apply (same key + same input) → 202 same task_id, task.begin called ONCE', async () => {
    setup.mockAgent.respondToTaskBegin({ kind: 'accept', agent_acceptance_id: 'acc-dup' });

    const planned = await plan({ id: 'r4', message: 'go' });
    const planId = planned.body.result.plan_id as string;

    const first = await apply(planId, 'idem-dup');
    expect(first.status).toBe(202);
    const taskId = first.body.result.task_id;

    const before = setup.mockAgent.taskBeginCallCount();
    const second = await apply(planId, 'idem-dup');
    expect(second.status).toBe(202);
    expect(second.body.result.task_id).toBe(taskId);

    // The idempotent replay must NOT re-dispatch task.begin.
    expect(setup.mockAgent.taskBeginCallCount()).toBe(before);
    // Only one apply task row.
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE idempotency_key = ?', 'idem-dup')).toBe(1);
  });

  it('mode=bogus → 400 INVALID_ARGUMENT', async () => {
    const res = await request(setup.app)
      .post('/api/v1/reference')
      .set('Authorization', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ mode: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].code).toBe('INVALID_ARGUMENT');
  });
});
