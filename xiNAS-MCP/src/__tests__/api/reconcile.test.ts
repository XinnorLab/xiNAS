import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRpcClient } from '../../api/agent-client.js';
import { TaskEngine } from '../../api/tasks/engine.js';
import { TaskStore } from '../../api/tasks/store.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';
import { LeaseManager } from '../../state/leases.js';
import { runMigrations } from '../../state/migrations.js';

// Deterministic clock + id-gen so assertions never depend on wall time.
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

  const engine = new TaskEngine({ db, store, leases, kv });

  return {
    db,
    kv,
    leases,
    store,
    engine,
    setClock(v: number) {
      clock = v;
    },
    /** Create a `queued` apply task and return its id. */
    seedQueued(): string {
      return store.createApplyTask({
        kind: 'reference.echo',
        principal: 'admin:test',
        client_type: 'rest',
        request_id: 'r',
        correlation_id: 'c',
        input_hash: 'h',
        risk_level: 'non_disruptive',
        affected_resources: [{ kind: 'Reference', id: 'r1' }],
      }).task_id;
    },
    /** Create a `running` task (optionally with an acceptance id) and return its id. */
    seedRunning(acceptanceId?: string): string {
      const id = store.createApplyTask({
        kind: 'reference.echo',
        principal: 'admin:test',
        client_type: 'rest',
        request_id: 'r',
        correlation_id: 'c',
        input_hash: 'h',
        risk_level: 'non_disruptive',
        affected_resources: [{ kind: 'Reference', id: 'r1' }],
      }).task_id;
      store.transition(id, {
        state: 'running',
        ...(acceptanceId !== undefined ? { agent_acceptance_id: acceptanceId } : {}),
      });
      return id;
    },
    /** Acquire a live lease for a task on its single affected resource. */
    acquireLease(taskId: string): void {
      const res = leases.acquire({
        resource_kind: 'Reference',
        resource_id: 'r1',
        task_id: taskId,
        ttl_seconds: 60,
      });
      if (!res.ok) throw new Error('lease acquire failed in test setup');
    },
    /** Force the task's lease(s) expired (sweepExpired uses real Date.now()). */
    expireLease(taskId: string): void {
      db.prepare('UPDATE leases SET heartbeat_at = 0, ttl_seconds = 1 WHERE task_id = ?').run(
        taskId,
      );
    },
    countLeases(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n;
    },
    leaseHolder(kind: string, id: string): string | undefined {
      const row = db
        .prepare('SELECT task_id FROM leases WHERE resource_kind = ? AND resource_id = ?')
        .get(kind, id) as { task_id: string } | undefined;
      return row?.task_id;
    },
  };
}

/** Inline fake AgentRpcClient covering the reconcile RPC surface. */
function fakeAgent(opts: {
  inflight?: Array<{ task_id: string; agent_acceptance_id: string | null }>;
  beginAcceptanceId?: string;
  unreachable?: boolean;
  /** Captures the params of every `task.begin` the engine dispatches. */
  beginParams?: Array<Record<string, unknown>>;
}): AgentRpcClient {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      if (opts.unreachable) throw new Error('connect ECONNREFUSED');
      if (method === 'task.list_inflight') return { tasks: opts.inflight ?? [] };
      if (method === 'task.begin') {
        opts.beginParams?.push((params ?? {}) as Record<string, unknown>);
        return { accepted: true, agent_acceptance_id: opts.beginAcceptanceId ?? 'acc-redispatch' };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe('TaskEngine.reconcile', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('expired-lease running task → requires_manual_recovery (sweep)', async () => {
    const id = h.seedRunning();
    h.acquireLease(id);
    h.expireLease(id);

    const summary = await h.engine.reconcile({ agentClient: fakeAgent({ inflight: [] }) });

    const task = h.store.get(id);
    expect(task?.state).toBe('requires_manual_recovery');
    expect(task?.error_code).toBe('FAILED_STATE_DESYNC');
    expect(summary.tasks_recovered).toBeGreaterThanOrEqual(1);
  });

  it('queued + not inflight + default redispatch → running with stored acceptance', async () => {
    const id = h.seedQueued();
    h.acquireLease(id);

    const summary = await h.engine.reconcile({
      agentClient: fakeAgent({ inflight: [], beginAcceptanceId: 'acc-rd' }),
    });

    const task = h.store.get(id);
    expect(task?.state).toBe('running');
    expect(task?.agent_acceptance_id).toBe('acc-rd');
    expect(summary.redispatched).toBe(1);
  });

  it("redispatch forwards the task's persisted spec (NOT affected_resources) as task.begin spec", async () => {
    const id = h.seedQueued();
    h.acquireLease(id);
    // Persist a raw executor spec on the queued task (what plan/apply stored).
    const spec = { fail_at_stage: 'apply', message: 'redispatch me' };
    h.db.prepare('UPDATE tasks SET spec = ? WHERE task_id = ?').run(JSON.stringify(spec), id);

    const beginParams: Array<Record<string, unknown>> = [];
    const summary = await h.engine.reconcile({
      agentClient: fakeAgent({ inflight: [], beginAcceptanceId: 'acc-rd', beginParams }),
    });

    expect(summary.redispatched).toBe(1);
    expect(beginParams).toHaveLength(1);
    // §9: reconcile forwards the persisted task.spec verbatim.
    expect(beginParams[0]?.spec).toEqual(spec);
    // And it is NOT the affected_resources lock set (the old stopgap).
    expect(beginParams[0]?.spec).not.toEqual(h.store.get(id)?.affected_resources);
  });

  it("queued + queuedPolicy:'fail' → failed FAILED_BEFORE_CHANGE + leases released", async () => {
    const id = h.seedQueued();
    h.acquireLease(id);

    const summary = await h.engine.reconcile({
      agentClient: fakeAgent({ inflight: [] }),
      queuedPolicy: 'fail',
    });

    const task = h.store.get(id);
    expect(task?.state).toBe('failed');
    expect(task?.error_code).toBe('FAILED_BEFORE_CHANGE');
    expect(h.leaseHolder('Reference', 'r1')).toBeUndefined();
    expect(summary.failed).toBe(1);
  });

  it('running + acceptance=null + inflight → acceptance adopted, stays running', async () => {
    const id = h.seedRunning();

    const summary = await h.engine.reconcile({
      agentClient: fakeAgent({ inflight: [{ task_id: id, agent_acceptance_id: 'acc-live' }] }),
    });

    const task = h.store.get(id);
    expect(task?.state).toBe('running');
    expect(task?.agent_acceptance_id).toBe('acc-live');
    expect(summary.acceptances_adopted).toBe(1);
  });

  it('running + acceptance=null + NOT inflight + lease live → no-op', async () => {
    const id = h.seedRunning();
    h.acquireLease(id); // live lease → sweep won't touch it

    const summary = await h.engine.reconcile({ agentClient: fakeAgent({ inflight: [] }) });

    const task = h.store.get(id);
    expect(task?.state).toBe('running');
    expect(task?.agent_acceptance_id).toBeUndefined();
    expect(summary.acceptances_adopted).toBe(0);
    expect(summary.redispatched).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('agent unreachable → sweep only, queued stays queued', async () => {
    const id = h.seedQueued();

    const summary = await h.engine.reconcile({ agentClient: fakeAgent({ unreachable: true }) });

    expect(h.store.get(id)?.state).toBe('queued');
    expect(summary.agent_reachable).toBe(false);
    expect(summary.redispatched).toBe(0);

    // No agentClient behaves the same (sweep only, queued untouched).
    const summary2 = await h.engine.reconcile({ agentClient: undefined });
    expect(h.store.get(id)?.state).toBe('queued');
    expect(summary2.agent_reachable).toBe(false);
    expect(summary2.redispatched).toBe(0);
  });

  it('re-entrancy guard: a concurrent reconcile is skipped', async () => {
    h.seedQueued();

    const p1 = h.engine.reconcile({
      agentClient: fakeAgent({ inflight: [], beginAcceptanceId: 'acc-rd' }),
    });
    const p2 = h.engine.reconcile({
      agentClient: fakeAgent({ inflight: [], beginAcceptanceId: 'acc-rd' }),
    });

    const [s1, s2] = await Promise.all([p1, p2]);
    const skipped = [s1, s2].filter((s) => s.skipped);
    expect(skipped).toHaveLength(1);
  });
});
