import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRpcClient } from '../../../api/agent-client.js';
import { createApp } from '../../../api/app.js';
import type { ApiContext } from '../../../api/context.js';
import { type ApplyPlan, type ApplyRequest, TaskEngine } from '../../../api/tasks/engine.js';
import { buildTaskEngines } from '../../../api/tasks/build.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { SqliteKvStore } from '../../../state/backend-sqlite.js';
import { LeaseManager } from '../../../state/leases.js';
import { runMigrations } from '../../../state/migrations.js';
import { buildTestApp } from '../_helpers.js';

// S2.1 worker pool — hybrid admission + FIFO drainer
// (s2-task-envelope-spec §5.3). Engine-level tests over the same in-memory
// SQLite harness apply.test.ts / reconcile.test.ts use.

function makeHarness(maxInflight?: number) {
  const db = new Database(':memory:');
  runMigrations(db);
  const kv = new SqliteKvStore(db);
  const leases = new LeaseManager(db);

  let clock = 1_000;
  let idCounter = 0;
  const store = new TaskStore({
    db,
    now: () => {
      // Strictly-increasing clock so created_at orders tasks FIFO.
      clock += 1;
      return clock;
    },
    newId: () => {
      idCounter += 1;
      return `task-${String(idCounter).padStart(4, '0')}`;
    },
  });

  const engine = new TaskEngine({
    db,
    store,
    leases,
    kv,
    ...(maxInflight !== undefined ? { maxInflight } : {}),
  });

  // Seed five desired resources so applies against distinct resources succeed.
  for (const id of ['s1', 's2', 's3', 's4', 's5']) {
    kv.put(`/xinas/v1/desired/Share/${id}`, { id, name: 'demo' });
  }

  let idemCounter = 0;
  /** Run a full apply (txn only, no dispatch) against one seeded resource. */
  function applyOn(resourceId: string, idempotencyKey?: string) {
    const plan: ApplyPlan = {
      plan_id: `plan-${resourceId}`,
      kind: 'reference.echo',
      risk_level: 'non_disruptive',
      affected_resources: [{ kind: 'Share', id: resourceId, revision: 1 }],
      state_revision_expected: 1,
      spec: { message: resourceId },
    };
    idemCounter += 1;
    const applyReq: ApplyRequest = {
      input_hash: `ihash-${resourceId}-${idemCounter}`,
      idempotency_key: idempotencyKey ?? `idem-${idemCounter}`,
      principal: 'admin:test',
      client_type: 'rest',
      request_id: 'req-1',
      correlation_id: 'corr-1',
    };
    return { task: engine.apply({ plan, applyReq }), plan };
  }

  function leaseCount(taskId: string): number {
    return (
      db.prepare('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?').get(taskId) as {
        n: number;
      }
    ).n;
  }

  return { db, kv, leases, store, engine, applyOn, leaseCount };
}

/** Inline fake AgentRpcClient: records task.begin params, customizable reply. */
function fakeAgent(opts: {
  beginParams?: Array<Record<string, unknown>>;
  /** Per-call override; default accepts with a fresh acceptance id. */
  beginImpl?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  inflight?: Array<{ task_id: string; agent_acceptance_id: string | null }>;
}): AgentRpcClient {
  return {
    async call(method: string, params?: unknown): Promise<unknown> {
      if (method === 'task.list_inflight') return { tasks: opts.inflight ?? [] };
      if (method === 'task.begin') {
        const p = (params ?? {}) as Record<string, unknown>;
        opts.beginParams?.push(p);
        if (opts.beginImpl) return opts.beginImpl(p);
        return { accepted: true, agent_acceptance_id: `acc-${String(p.task_id)}` };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe('TaskEngine.admitAndDispatch — hybrid admission (§5.3)', () => {
  it('cap=1: first apply dispatches inline (running), second returns 202-shaped queued', async () => {
    const h = makeHarness(1);
    const beginParams: Array<Record<string, unknown>> = [];
    const agent = fakeAgent({ beginParams });

    const a = h.applyOn('s1');
    const dispatched = await h.engine.admitAndDispatch({
      task: a.task,
      agentClient: agent,
      spec: a.plan.spec,
      plan: a.plan,
    });
    expect(dispatched.state).toBe('running');
    expect(beginParams).toHaveLength(1);

    const b = h.applyOn('s2');
    const admitted = await h.engine.admitAndDispatch({
      task: b.task,
      agentClient: agent,
      spec: b.plan.spec,
      plan: b.plan,
    });
    // Pool full → no dispatch at all; the task is returned still queued.
    expect(admitted.state).toBe('queued');
    expect(beginParams).toHaveLength(1);
    expect(h.store.get(b.task.task_id)?.state).toBe('queued');
    // A pool-queued task still holds its leases…
    expect(h.leaseCount(b.task.task_id)).toBe(1);
  });

  it('a conflicting apply on the SAME resource as a pool-queued task gets CONFLICT lease_held', async () => {
    const h = makeHarness(1);
    const agent = fakeAgent({});

    const a = h.applyOn('s1');
    await h.engine.admitAndDispatch({
      task: a.task,
      agentClient: agent,
      spec: a.plan.spec,
      plan: a.plan,
    });
    const b = h.applyOn('s2'); // queued (pool full), holds the s2 lease
    await h.engine.admitAndDispatch({
      task: b.task,
      agentClient: agent,
      spec: b.plan.spec,
      plan: b.plan,
    });
    expect(h.store.get(b.task.task_id)?.state).toBe('queued');

    expect(() => h.applyOn('s2')).toThrowError(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({
          reason: 'lease_held',
          holder_task_id: b.task.task_id,
        }),
      }),
    );
  });

  it('reservation race: two concurrent applies at cap=1 admit exactly one', async () => {
    const h = makeHarness(1);
    // Deferred task.begin: both admissions race while the first begin hangs.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const beginParams: Array<Record<string, unknown>> = [];
    const agent = fakeAgent({
      beginParams,
      beginImpl: async (p) => {
        await gate;
        return { accepted: true, agent_acceptance_id: `acc-${String(p.task_id)}` };
      },
    });

    const a = h.applyOn('s1');
    const b = h.applyOn('s2');
    const pa = h.engine.admitAndDispatch({
      task: a.task,
      agentClient: agent,
      spec: a.plan.spec,
      plan: a.plan,
    });
    const pb = h.engine.admitAndDispatch({
      task: b.task,
      agentClient: agent,
      spec: b.plan.spec,
      plan: b.plan,
    });
    release();
    const [ra, rb] = await Promise.all([pa, pb]);

    // Exactly ONE begin was sent; exactly one of the two is running.
    expect(beginParams).toHaveLength(1);
    const states = [ra.state, rb.state].sort();
    expect(states).toEqual(['queued', 'running']);
  });
});

describe('TaskEngine.drainQueued — FIFO drainer (§5.3)', () => {
  it('dispatches the OLDEST never-dispatched queued task per freed slot', async () => {
    const h = makeHarness(1);
    const beginParams: Array<Record<string, unknown>> = [];
    const agent = fakeAgent({ beginParams });

    const t1 = h.applyOn('s1').task;
    const t2 = h.applyOn('s2').task;
    const t3 = h.applyOn('s3').task;

    // First drain: one slot → oldest only.
    const first = await h.engine.drainQueued(agent);
    expect(first.dispatched).toBe(1);
    expect(first.left_queued).toBe(2);
    expect(beginParams.map((p) => p.task_id)).toEqual([t1.task_id]);
    expect(h.store.get(t1.task_id)?.state).toBe('running');
    expect(h.store.get(t2.task_id)?.state).toBe('queued');

    // t1 reaches terminal → its slot frees → next drain picks t2 (not t3).
    h.store.transition(t1.task_id, { state: 'success' });
    h.leases.releaseByTask(t1.task_id);
    await h.engine.drainQueued(agent);
    expect(beginParams.map((p) => p.task_id)).toEqual([t1.task_id, t2.task_id]);

    // And t2's terminal frees the slot for t3.
    h.store.transition(t2.task_id, { state: 'success' });
    h.leases.releaseByTask(t2.task_id);
    await h.engine.drainQueued(agent);
    expect(beginParams.map((p) => p.task_id)).toEqual([t1.task_id, t2.task_id, t3.task_id]);
    expect(h.store.get(t3.task_id)?.state).toBe('running');
  });

  it('a dispatch failure fails THAT task and the drain continues to the next', async () => {
    const h = makeHarness(1);
    const t1 = h.applyOn('s1').task;
    const t2 = h.applyOn('s2').task;
    const agent = fakeAgent({
      beginImpl: (p) => {
        if (p.task_id === t1.task_id) throw new Error('connect ECONNREFUSED');
        return { accepted: true, agent_acceptance_id: `acc-${String(p.task_id)}` };
      },
    });

    const outcome = await h.engine.drainQueued(agent);

    // t1 failed before change (leases released), t2 dispatched in the SAME drain.
    const failed = h.store.get(t1.task_id);
    expect(failed?.state).toBe('failed');
    expect(failed?.error_code).toBe('FAILED_BEFORE_CHANGE');
    expect(h.leaseCount(t1.task_id)).toBe(0);
    expect(h.store.get(t2.task_id)?.state).toBe('running');
    expect(outcome.dispatched).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(outcome.left_queued).toBe(0);
  });

  it('without an agent client the drain leaves every queued task queued', async () => {
    const h = makeHarness(1);
    const t1 = h.applyOn('s1').task;
    const outcome = await h.engine.drainQueued(undefined);
    expect(h.store.get(t1.task_id)?.state).toBe('queued');
    expect(outcome.dispatched).toBe(0);
    expect(outcome.failed).toBe(0);
    expect(outcome.left_queued).toBe(1);
  });
});

describe('TaskEngine.reconcile — cap-aware redispatch (§5.3/§9)', () => {
  it('redispatch: 5 queued at cap=2 → 2 dispatched oldest-first, 3 LEFT queued (counted, not failed)', async () => {
    const h = makeHarness(2);
    const beginParams: Array<Record<string, unknown>> = [];
    const agent = fakeAgent({ beginParams, inflight: [] });

    const ids = ['s1', 's2', 's3', 's4', 's5'].map((r) => h.applyOn(r).task.task_id);

    const summary = await h.engine.reconcile({ agentClient: agent });

    expect(summary.redispatched).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.left_queued).toBe(3);
    // Oldest-first: the two created first run; the rest stay queued.
    expect(beginParams.map((p) => p.task_id)).toEqual([ids[0], ids[1]]);
    expect(ids.map((id) => h.store.get(id)?.state)).toEqual([
      'running',
      'running',
      'queued',
      'queued',
      'queued',
    ]);
  });

  it("queuedPolicy:'fail' still fails ALL queued tasks regardless of free slots", async () => {
    const h = makeHarness(2);
    const agent = fakeAgent({ inflight: [] });
    const ids = ['s1', 's2', 's3', 's4', 's5'].map((r) => h.applyOn(r).task.task_id);

    const summary = await h.engine.reconcile({ agentClient: agent, queuedPolicy: 'fail' });

    expect(summary.failed).toBe(5);
    expect(summary.redispatched).toBe(0);
    expect(summary.left_queued).toBe(0);
    for (const id of ids) {
      expect(h.store.get(id)?.state).toBe('failed');
      expect(h.store.get(id)?.error_code).toBe('FAILED_BEFORE_CHANGE');
    }
  });
});

describe('terminal progress event triggers the drain (§5.3 trigger a)', () => {
  const AGENT_TOKEN = 'agent-tok-pool';
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('a queued task dispatches after another task reports terminal', async () => {
    const setup = await buildTestApp();
    cleanup = setup.cleanup;
    setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

    const beginParams: Array<Record<string, unknown>> = [];
    const agent = fakeAgent({ beginParams });
    const tasks = buildTaskEngines({ state: setup.state, agentClient: agent, maxInflight: 1 });
    const ctx: ApiContext = { config: setup.config, state: setup.state, tasks };
    const app = createApp(ctx);

    // Task A occupies the single slot…
    const seed = (n: number) =>
      tasks.store.createApplyTask({
        kind: 'reference.echo',
        principal: 'admin:test',
        client_type: 'rest',
        request_id: `req-${n}`,
        correlation_id: `corr-${n}`,
        input_hash: `hash-${n}`,
        risk_level: 'non_disruptive',
        affected_resources: [{ kind: 'Reference', id: `r${n}` }],
        spec: { message: `m${n}` },
      });
    const a = seed(1);
    tasks.store.transition(a.task_id, { state: 'running', agent_acceptance_id: 'acc-a' });
    // …task B waits in the pool queue.
    const b = seed(2);
    expect(tasks.store.get(b.task_id)?.state).toBe('queued');

    // A's terminal event over the real progress route frees the slot.
    const res = await request(app)
      .post('/internal/v1/task_progress')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({ task_id: a.task_id, sequence: 1, event_type: 'terminal', status: 'success' });
    expect(res.status).toBe(200);

    // The drain is fire-and-forget off the handler — poll until B runs.
    await vi.waitFor(() => {
      expect(tasks.store.get(b.task_id)?.state).toBe('running');
    });
    expect(beginParams.map((p) => p.task_id)).toEqual([b.task_id]);
  });
});
