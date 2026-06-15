/**
 * S13 T7: tombstone desired-delete apply + revert + stale guard.
 *
 * Proves that a tombstone-shaped plan — one whose single `desired_mutations`
 * entry is `{ key, delete: true }` — flows correctly through the EXISTING
 * TaskEngine.apply / dispatch paths.  The engine treats all `{key,delete:true}`
 * mutations identically; this file is the regression guard that confirms the
 * delete shape is never accidentally broken.
 *
 * Three properties asserted (mirrors S12 T5 adopt-apply.test.ts exactly):
 *
 *   P1. Delete lands: a successful apply removes Share/expA from KV, records the
 *       prior value in `desired_rollback`, and holds the correct lease.
 *
 *   P2. Stale guard: if Share/expA's revision is bumped between plan and apply,
 *       apply rejects with PRECONDITION_FAILED { stale } and KV is unchanged.
 *
 *   P3. Revert on failure: when dispatch has no agentClient (begin-failure,
 *       Model R), Share/expA is RE-CREATED from `desired_rollback`.
 *
 * Harness mirrors adopt-apply.test.ts exactly (in-memory SQLite, same
 * TaskEngine constructor, deterministic clock + id counter).
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../api/errors.js';
import { TaskEngine } from '../../api/tasks/engine.js';
import type { ApplyPlan, ApplyRequest } from '../../api/tasks/engine.js';
import { TaskStore } from '../../api/tasks/store.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';
import { LeaseManager } from '../../state/leases.js';
import { runMigrations } from '../../state/migrations.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

  // Seed Share/expA — the tombstone plan will delete this row.
  // After one put() the revision is 1.
  kv.put('/xinas/v1/desired/Share/expA', { kind: 'Share', id: 'expA', spec: { path: '/a' } });

  return {
    db,
    kv,
    leases,
    store,
    engine,
    setClock(v: number) {
      clock = v;
    },
    /** Bump expA's revision to simulate a concurrent write since planning. */
    bumpExpA() {
      kv.put('/xinas/v1/desired/Share/expA', {
        kind: 'Share',
        id: 'expA',
        spec: { path: '/a-changed' },
      });
    },
    countTasks(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    },
    countLeases(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n;
    },
  };
}

/**
 * A tombstone-shaped plan: single desired_mutation is {key, delete:true}.
 *
 * affected_resources:
 *   [0] Share/expA  revision:1 — pinned at current desired rev (DELETE target)
 *
 * desired_mutations:
 *   - delete /xinas/v1/desired/Share/expA
 *
 * lease_resources: Share/expA — the resource being tombstoned.
 */
function makeTombstonePlan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
  return {
    plan_id: 'plan-tombstone-1',
    kind: 'share.delete',
    risk_level: 'destructive',
    plan_hash: 'phash-tombstone-1',
    affected_resources: [{ kind: 'Share', id: 'expA', revision: 1 }],
    desired_mutations: [{ key: '/xinas/v1/desired/Share/expA', delete: true }],
    lease_resources: [{ kind: 'Share', id: 'expA' }],
    ...overrides,
  };
}

function makeApplyReq(overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    input_hash: 'ihash-tombstone-1',
    idempotency_key: 'idem-tombstone-1',
    principal: 'admin:test',
    client_type: 'rest',
    request_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    correlation_id: 'corr-tombstone-1',
    dangerous: true, // tombstone plan is destructive → requires dangerous:true
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// P1: Delete lands
// ---------------------------------------------------------------------------

describe('tombstone apply — P1: delete lands', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('apply removes Share/expA from KV', () => {
    // Precondition: row exists before apply.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')).not.toBeNull();

    const task = h.engine.apply({ plan: makeTombstonePlan(), applyReq: makeApplyReq() });

    expect(task.state).toBe('queued');
    expect(task.kind).toBe('share.delete');

    // P1a: the delete mutation landed — expA is gone.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')).toBeNull();
  });

  it('apply records correct desired_rollback with prior value of deleted key', () => {
    const task = h.engine.apply({ plan: makeTombstonePlan(), applyReq: makeApplyReq() });

    const rollback = h.store.get(task.task_id)?.desired_rollback;
    expect(rollback).toBeDefined();
    // Prior value of expA (delete) was the seeded value.
    expect(rollback).toContainEqual({
      key: '/xinas/v1/desired/Share/expA',
      prior_value: { kind: 'Share', id: 'expA', spec: { path: '/a' } },
    });
  });

  it('task row is persisted in queued state; lease is held on Share/expA', () => {
    const task = h.engine.apply({ plan: makeTombstonePlan(), applyReq: makeApplyReq() });

    expect(h.store.get(task.task_id)?.state).toBe('queued');
    expect(h.countTasks()).toBe(1);
    expect(h.countLeases()).toBe(1);
    const leaseRow = h.db
      .prepare('SELECT task_id FROM leases WHERE resource_kind = ? AND resource_id = ?')
      .get('Share', 'expA') as { task_id: string } | undefined;
    expect(leaseRow?.task_id).toBe(task.task_id);
  });
});

// ---------------------------------------------------------------------------
// P2: Stale guard
// ---------------------------------------------------------------------------

describe('tombstone apply — P2: stale guard fires on bumped desired revision', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('bumping expA after planning rejects with PRECONDITION_FAILED {stale} and leaves KV unchanged', () => {
    // Bump expA: revision advances from 1 → 2.  Plan still expects 1.
    h.bumpExpA();

    let thrown: unknown;
    try {
      h.engine.apply({ plan: makeTombstonePlan(), applyReq: makeApplyReq() });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('PRECONDITION_FAILED');
    // The stale array identifies the mismatched resource.
    expect((thrown as ApiException).details?.stale).toContainEqual(
      expect.objectContaining({ kind: 'Share', id: 'expA', expected: 1 }),
    );

    // Full rollback: no task row, no lease written.
    expect(h.countTasks()).toBe(0);
    expect(h.countLeases()).toBe(0);

    // KV is unchanged: expA still present with its bumped value.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')?.value).toMatchObject({
      spec: { path: '/a-changed' },
    });
  });

  it('stale guard also fires when expA was deleted externally since planning', () => {
    // Delete expA externally: absent row reads as revision 0, plan expects 1.
    h.kv.delete('/xinas/v1/desired/Share/expA');

    let thrown: unknown;
    try {
      h.engine.apply({ plan: makeTombstonePlan(), applyReq: makeApplyReq() });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('PRECONDITION_FAILED');
    expect((thrown as ApiException).details?.stale).toContainEqual(
      expect.objectContaining({ kind: 'Share', id: 'expA', expected: 1, current: 0 }),
    );

    expect(h.countTasks()).toBe(0);
    expect(h.countLeases()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P3: Revert on failure (begin-failure path = no agentClient)
// ---------------------------------------------------------------------------

describe('tombstone apply — P3: revert on failure via begin-failure (Model R)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('begin-failure reverts delete mutation: Share/expA is RE-CREATED from desired_rollback', async () => {
    const task = h.engine.apply({ plan: makeTombstonePlan(), applyReq: makeApplyReq() });

    // Precondition: delete mutation landed — expA is gone.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')).toBeNull();

    // No agent → dispatch hits failBeforeChange → revertDesired.
    let thrown: unknown;
    try {
      await h.engine.dispatch({ task, agentClient: undefined, spec: {}, plan: {} });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).httpStatusOverride).toBe(503);
    expect(h.store.get(task.task_id)?.state).toBe('failed');

    // P3: expA RE-CREATED from prior_value in desired_rollback.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')?.value).toEqual({
      kind: 'Share',
      id: 'expA',
      spec: { path: '/a' },
    });
  });

  it('begin-failure on a tombstone whose prior was already absent: revert is a no-op delete', async () => {
    // Seed a row that was absent at plan time (revision 0 pin).
    // This simulates planning to delete a row that was concurrently re-created
    // after the stale-guard snapshot.  We use revision:0 pin here to bypass
    // the stale guard and test the revert path when prior_value is null.
    const planAbsentPrior = makeTombstonePlan({
      plan_id: 'plan-tombstone-absent',
      plan_hash: 'phash-tombstone-absent',
      affected_resources: [{ kind: 'Share', id: 'expA', revision: 1 }],
      desired_mutations: [{ key: '/xinas/v1/desired/Share/expNew', delete: true }],
      lease_resources: [{ kind: 'Share', id: 'expNew' }],
    });
    const req = makeApplyReq({
      idempotency_key: 'idem-tombstone-absent',
      input_hash: 'ihash-tombstone-absent',
    });

    // expNew does NOT exist in KV → prior_value will be null.
    const task = h.engine.apply({ plan: planAbsentPrior, applyReq: req });

    // delete on an absent key is a no-op in KV — row stays absent.
    expect(h.kv.get('/xinas/v1/desired/Share/expNew')).toBeNull();

    let thrown: unknown;
    try {
      await h.engine.dispatch({ task, agentClient: undefined, spec: {}, plan: {} });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect(h.store.get(task.task_id)?.state).toBe('failed');

    // Prior was null → revert calls kv.delete again (safe no-op) — still absent.
    expect(h.kv.get('/xinas/v1/desired/Share/expNew')).toBeNull();
  });
});
