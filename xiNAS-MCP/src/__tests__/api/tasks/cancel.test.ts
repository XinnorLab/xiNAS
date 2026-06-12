import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRpcClient } from '../../../api/agent-client.js';
import { ApiException } from '../../../api/errors.js';
import { TaskEngine } from '../../../api/tasks/engine.js';
import type { ApplyPlan, ApplyRequest } from '../../../api/tasks/engine.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { SqliteKvStore } from '../../../state/backend-sqlite.js';
import { LeaseManager } from '../../../state/leases.js';
import { runMigrations } from '../../../state/migrations.js';

// ── S10 T4 (ADR-0012 §4/§5, s2 spec §16.2/§16.3): engine.cancel ──────────────

function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  const kv = new SqliteKvStore(db);
  const leases = new LeaseManager(db);

  let clock = 1_000;
  let idCounter = 0;
  const store = new TaskStore({
    db,
    now: () => clock,
    newId: () => {
      idCounter += 1;
      return `task-${String(idCounter).padStart(4, '0')}`;
    },
  });

  const notified: Array<{ taskId: string; event: Record<string, unknown> }> = [];
  const taskWatch = {
    notify(taskId: string, event: unknown): void {
      notified.push({ taskId, event: event as Record<string, unknown> });
    },
  };

  const engine = new TaskEngine({ db, store, leases, kv, taskWatch });
  kv.put('/xinas/v1/desired/Share/s1', { id: 's1', name: 'demo' });

  return {
    db,
    kv,
    leases,
    store,
    engine,
    notified,
    countLeases(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n;
    },
  };
}

function makePlan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
  return {
    plan_id: 'plan-1',
    kind: 'reference.echo',
    risk_level: 'non_disruptive',
    plan_hash: 'phash-1',
    affected_resources: [{ kind: 'Share', id: 's1', revision: 1 }],
    state_revision_expected: 1,
    ...overrides,
  };
}

function makeApplyReq(overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    input_hash: 'ihash-1',
    idempotency_key: 'idem-1',
    principal: 'admin:test',
    client_type: 'rest',
    request_id: '22222222-2222-2222-2222-222222222222',
    correlation_id: 'corr-1',
    ...overrides,
  };
}

const offlineArgs = { agentClient: undefined, trackerOffline: true };

function rpc(result: unknown): AgentRpcClient {
  return { call: vi.fn(async () => result) } as unknown as AgentRpcClient;
}

function rejectingRpc(): AgentRpcClient {
  return {
    call: vi.fn(async () => {
      throw new Error('socket reset');
    }),
  } as unknown as AgentRpcClient;
}

describe('TaskEngine.cancel', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('unknown id → NOT_FOUND', async () => {
    await expect(h.engine.cancel({ taskId: 'task-nope', ...offlineArgs })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('plan_only / terminal states → CONFLICT not_cancellable; cancelled → idempotent 200 row', async () => {
    const plan = h.store.createPlanOnly({
      kind: 'reference.echo',
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '11111111-1111-1111-1111-111111111111',
      correlation_id: 'c',
      input_hash: 'i',
      plan_hash: 'p',
      risk_level: 'non_disruptive',
      affected_resources: [],
      state_revision_expected: 0,
    });
    await expect(h.engine.cancel({ taskId: plan.task_id, ...offlineArgs })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'not_cancellable', state: 'plan_only' },
    });

    const apply = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    h.store.transition(apply.task_id, { state: 'success' });
    await expect(h.engine.cancel({ taskId: apply.task_id, ...offlineArgs })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'not_cancellable', state: 'success' },
    });

    h.store.transition(apply.task_id, { state: 'cancelled' });
    const again = await h.engine.cancel({ taskId: apply.task_id, ...offlineArgs });
    expect(again.state).toBe('cancelled');
  });

  it('queued (unreserved) → engine-local cancel: CAS flip, leases, revert, synthetic terminal', async () => {
    const revertSpy = vi.spyOn(h.engine, 'revertDesired');
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    expect(h.countLeases()).toBe(1);

    const cancelled = await h.engine.cancel({ taskId: task.task_id, ...offlineArgs });

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancel_requested_at).toBeDefined();
    expect(cancelled.last_event_sequence).toBe(1);
    expect(h.store.get(task.task_id)?.state).toBe('cancelled');
    expect(h.countLeases()).toBe(0);
    expect(revertSpy).toHaveBeenCalledOnce();
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]?.event).toMatchObject({
      task_id: task.task_id,
      sequence: 1,
      event_type: 'terminal',
      status: 'cancelled',
    });
  });

  it('queued but reserved (mid-dispatch) → CONFLICT dispatch_in_flight', async () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    (h.engine as unknown as { dispatchReservations: Set<string> }).dispatchReservations.add(
      task.task_id,
    );
    await expect(h.engine.cancel({ taskId: task.task_id, ...offlineArgs })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'dispatch_in_flight' },
    });
  });

  it('running + tracker offline → EXECUTOR_UNAVAILABLE, no durable write', async () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    h.store.transition(task.task_id, { state: 'running' });
    await expect(
      h.engine.cancel({ taskId: task.task_id, agentClient: undefined, trackerOffline: true }),
    ).rejects.toMatchObject({ code: 'INTERNAL', details: { code: 'EXECUTOR_UNAVAILABLE' } });
    expect(h.store.get(task.task_id)?.cancel_requested_at).toBeUndefined();
  });

  it('running + RPC accepts → cancel_requested_at set (guarded), row still running', async () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    h.store.transition(task.task_id, { state: 'running' });
    const client = rpc({ cancel_requested: true });
    const row = await h.engine.cancel({
      taskId: task.task_id,
      agentClient: client,
      trackerOffline: false,
    });
    expect(row.state).toBe('running');
    expect(row.cancel_requested_at).toBeDefined();
    expect(h.store.get(task.task_id)?.cancel_requested_at).toBeDefined();
    expect(h.notified).toHaveLength(0); // the agent owns this task's events
  });

  it('running + RPC not_found → CONFLICT agent_not_found + refusal metadata', async () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    h.store.transition(task.task_id, { state: 'running' });
    const client = rpc({ cancel_requested: false, reason: 'not_found' });
    await expect(
      h.engine.cancel({ taskId: task.task_id, agentClient: client, trackerOffline: false }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'agent_not_found' } });
    expect(h.store.get(task.task_id)?.cancel_refused_reason).toBe('agent_not_found');
    expect(h.store.get(task.task_id)?.state).toBe('running');
  });

  it('running + RPC rejects (post-check failure) → EXECUTOR_UNAVAILABLE, no durable write', async () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    h.store.transition(task.task_id, { state: 'running' });
    await expect(
      h.engine.cancel({ taskId: task.task_id, agentClient: rejectingRpc(), trackerOffline: false }),
    ).rejects.toMatchObject({ code: 'INTERNAL', details: { code: 'EXECUTOR_UNAVAILABLE' } });
    expect(h.store.get(task.task_id)?.cancel_requested_at).toBeUndefined();
  });

  it('failBeforeChange (drainer/inline dispatch failure) now notifies a synthetic terminal', async () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    await expect(
      h.engine.admitAndDispatch({
        task,
        agentClient: rejectingRpc(),
        spec: undefined,
        plan: makePlan(),
      }),
    ).rejects.toBeInstanceOf(ApiException);
    const row = h.store.get(task.task_id);
    expect(row?.state).toBe('failed');
    expect(row?.last_event_sequence).toBe(1);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]?.event).toMatchObject({
      event_type: 'terminal',
      status: 'failed',
      sequence: 1,
    });
  });
});
