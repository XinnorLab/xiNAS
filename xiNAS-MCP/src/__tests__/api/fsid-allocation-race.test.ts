import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../api/errors.js';
import { PlanEngine } from '../../api/plan/engine.js';
import type { PlanContext } from '../../api/plan/engine.js';
import { buildNfsPlanProviders } from '../../api/plan/providers/nfs.js';
import { toApplyPlan } from '../../api/routes/apply-helpers.js';
import { TaskEngine } from '../../api/tasks/engine.js';
import type { ApplyRequest } from '../../api/tasks/engine.js';
import { TaskStore } from '../../api/tasks/store.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';
import { LeaseManager } from '../../state/leases.js';
import { runMigrations } from '../../state/migrations.js';

/**
 * The race the whole design exists for: two share.create plans computed against
 * the same state allocate the SAME fsid, and both applies used to succeed —
 * their only pin was the Share id, which differs. The marker's absence pin is
 * what makes the second one fail.
 *
 * Drives the real PlanEngine, the real toApplyPlan bridge, and the real
 * TaskEngine.apply transaction. A stub would prove nothing.
 */

function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  const kv = new SqliteKvStore(db);
  const leases = new LeaseManager(db);

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
  const planEngine = new PlanEngine({ store, ctx });
  for (const p of buildNfsPlanProviders()) planEngine.register(p);
  const taskEngine = new TaskEngine({ db, store, leases, kv });

  return { db, kv, store, planEngine, taskEngine };
}

function shareSpec(id: string, path: string): Record<string, unknown> {
  return { id, path, clients: [{ pattern: '*', options: ['rw'] }], sync: 'sync' };
}

function planArgs(spec: unknown) {
  return {
    operation_kind: 'share.create',
    spec,
    principal: 'admin:test',
    client_type: 'rest' as const,
    request_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: 'corr-1',
  };
}

describe('concurrent share.create — fsid collision', () => {
  let h: ReturnType<typeof makeHarness>;
  let applyCounter = 0;

  beforeEach(() => {
    h = makeHarness();
    applyCounter = 0;
  });

  function applyReq(): ApplyRequest {
    applyCounter += 1;
    return {
      input_hash: `ihash-${applyCounter}`,
      idempotency_key: `idem-${applyCounter}`,
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '22222222-2222-2222-2222-222222222222',
      correlation_id: `corr-${applyCounter}`,
    };
  }

  /** The stored plan task, or a hard failure — no non-null assertions. */
  function planTask(taskId: string) {
    const t = h.store.get(taskId);
    if (!t) throw new Error(`no stored plan task ${taskId}`);
    return t;
  }

  /** The fsid a plan resolved, read off its persisted desired mutation. */
  function plannedFsid(taskId: string): number | undefined {
    const binding = planTask(taskId).plan_binding as {
      desired_mutations?: Array<{ key: string; value?: { spec?: { fsid?: number } } }>;
    };
    const shareMut = binding.desired_mutations?.find((m) =>
      m.key.startsWith('/xinas/v1/desired/Share/'),
    );
    return shareMut?.value?.spec?.fsid;
  }

  it('lets the first apply win and fails the second with PRECONDITION_FAILED', async () => {
    const { task: planA } = await h.planEngine.plan(planArgs(shareSpec('mnt/alpha', '/mnt/alpha')));
    const { task: planB } = await h.planEngine.plan(planArgs(shareSpec('mnt/beta', '/mnt/beta')));

    // Both planned against the same empty state, so both resolved the SAME
    // number. Without this the test could pass for an unrelated reason.
    expect(plannedFsid(planA.task_id)).toBe(1);
    expect(plannedFsid(planB.task_id)).toBe(1);

    const first = h.taskEngine.apply({
      plan: toApplyPlan(planTask(planA.task_id)),
      applyReq: applyReq(),
    });
    expect(first.state).toBe('queued');
    expect(h.kv.get('/xinas/v1/desired/ShareFsid/1')).not.toBeNull();

    // The marker's absence pin now mismatches. The desired-revision check runs
    // BEFORE lease acquisition inside apply(), so this is PRECONDITION_FAILED
    // and not a lease CONFLICT, even though the first apply still holds its
    // leases in this test (no task runner drains them).
    let thrown: unknown;
    try {
      h.taskEngine.apply({
        plan: toApplyPlan(planTask(planB.task_id)),
        applyReq: applyReq(),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('PRECONDITION_FAILED');
    expect(JSON.stringify((thrown as ApiException).details)).toContain('ShareFsid');
  });

  it('re-planning after the winner lands allocates the next number', async () => {
    const { task: planA } = await h.planEngine.plan(planArgs(shareSpec('mnt/alpha', '/mnt/alpha')));
    h.taskEngine.apply({ plan: toApplyPlan(planTask(planA.task_id)), applyReq: applyReq() });

    const { task: planB } = await h.planEngine.plan(planArgs(shareSpec('mnt/beta', '/mnt/beta')));
    expect(plannedFsid(planB.task_id)).toBe(2);

    const second = h.taskEngine.apply({
      plan: toApplyPlan(planTask(planB.task_id)),
      applyReq: applyReq(),
    });
    expect(second.state).toBe('queued');
  });
});
