/**
 * S12 T5: adopt desired_mutations apply + revert + stale guard.
 *
 * Proves that an adopt-shaped plan — one whose `affected_resources` carry
 * revision-pinned desired entries (put /xinas/v1/desired/Share/expA, delete
 * /xinas/v1/desired/Share/expB) — flows correctly through the EXISTING
 * TaskEngine.apply / dispatch paths.
 *
 * Three properties asserted (all three robustly supported by the harness):
 *
 *   P1. Puts/deletes land: a successful apply writes Share/expA and removes
 *       Share/expB, with correct desired_rollback recorded for revert.
 *
 *   P2. Stale guard: if Share/expA's revision is bumped between plan and apply,
 *       apply rejects with PRECONDITION_FAILED { stale } and KV is unchanged.
 *
 *   P3. Revert on failure: when dispatch has no agentClient (begin-failure),
 *       the desired writes are reverted (prior values restored / keys deleted).
 *
 * Harness mirrors apply.test.ts exactly (in-memory SQLite, same TaskEngine
 * constructor, deterministic clock + id counter).
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

  // Seed the two desired share rows the adopt plan will act on:
  //   Share/expA  → will be PUT (re-asserted to the captured spec)
  //   Share/expB  → will be DELETED (orphan not in the captured set)
  // Each gets revision 1 after its first put().
  kv.put('/xinas/v1/desired/Share/expA', { kind: 'Share', id: 'expA', spec: { path: '/a' } });
  kv.put('/xinas/v1/desired/Share/expB', { kind: 'Share', id: 'expB', spec: { path: '/b' } });

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
 * An adopt-shaped plan as the configRollbackProvider would produce it.
 *
 * affected_resources:
 *   [0] ConfigSnapshot/snap-1  — no revision (observed, not desired; guard skips it)
 *   [1] Share/expA  revision:1 — pinned at current desired rev (PUT target)
 *   [2] Share/expB  revision:1 — pinned at current desired rev (DELETE target)
 *
 * desired_mutations:
 *   - put  /xinas/v1/desired/Share/expA  (re-assert captured spec)
 *   - delete /xinas/v1/desired/Share/expB (orphan removal)
 *
 * lease_resources: ConfigHistory/default — adopt uses the config-history lease
 * (not the per-share leases), matching the real provider's output.
 */
function makeAdoptPlan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
  return {
    plan_id: 'plan-adopt-1',
    kind: 'config.rollback',
    risk_level: 'destructive',
    plan_hash: 'phash-adopt-1',
    // ConfigSnapshot entry has no revision (observed row, not desired).
    // Per-share entries are pinned at revision 1 (both seeded once above).
    affected_resources: [
      { kind: 'ConfigSnapshot', id: 'snap-1' },
      { kind: 'Share', id: 'expA', revision: 1 },
      { kind: 'Share', id: 'expB', revision: 1 },
    ],
    desired_mutations: [
      {
        key: '/xinas/v1/desired/Share/expA',
        value: { kind: 'Share', id: 'expA', spec: { path: '/a' } },
      },
      { key: '/xinas/v1/desired/Share/expB', delete: true },
    ],
    lease_resources: [{ kind: 'ConfigHistory', id: 'default' }],
    ...overrides,
  };
}

function makeApplyReq(overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    input_hash: 'ihash-adopt-1',
    idempotency_key: 'idem-adopt-1',
    principal: 'admin:test',
    client_type: 'rest',
    request_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    correlation_id: 'corr-adopt-1',
    dangerous: true, // adopt plan is destructive → requires dangerous:true
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// P1: Puts/deletes land
// ---------------------------------------------------------------------------

describe('adopt apply — P1: puts/deletes land', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('apply writes expA (put) and removes expB (delete) atomically', () => {
    const task = h.engine.apply({ plan: makeAdoptPlan(), applyReq: makeApplyReq() });

    expect(task.state).toBe('queued');
    expect(task.kind).toBe('config.rollback');

    // P1a: the put mutation landed — expA has the captured spec value.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')?.value).toEqual({
      kind: 'Share',
      id: 'expA',
      spec: { path: '/a' },
    });

    // P1b: the delete mutation landed — expB is gone.
    expect(h.kv.get('/xinas/v1/desired/Share/expB')).toBeNull();
  });

  it('apply records correct desired_rollback for both mutations', () => {
    const task = h.engine.apply({ plan: makeAdoptPlan(), applyReq: makeApplyReq() });

    const rollback = h.store.get(task.task_id)?.desired_rollback;
    expect(rollback).toBeDefined();
    // Prior value of expA (put) was the original seeded value.
    expect(rollback).toContainEqual({
      key: '/xinas/v1/desired/Share/expA',
      prior_value: { kind: 'Share', id: 'expA', spec: { path: '/a' } },
    });
    // Prior value of expB (delete) was its seeded value.
    expect(rollback).toContainEqual({
      key: '/xinas/v1/desired/Share/expB',
      prior_value: { kind: 'Share', id: 'expB', spec: { path: '/b' } },
    });
  });

  it('task row is persisted in queued state; lease is held on ConfigHistory/default', () => {
    const task = h.engine.apply({ plan: makeAdoptPlan(), applyReq: makeApplyReq() });

    expect(h.store.get(task.task_id)?.state).toBe('queued');
    expect(h.countTasks()).toBe(1);
    // adopt uses ConfigHistory/default as the lease target.
    expect(h.countLeases()).toBe(1);
    const leaseRow = h.db
      .prepare('SELECT task_id FROM leases WHERE resource_kind = ? AND resource_id = ?')
      .get('ConfigHistory', 'default') as { task_id: string } | undefined;
    expect(leaseRow?.task_id).toBe(task.task_id);
  });
});

// ---------------------------------------------------------------------------
// P2: Stale guard
// ---------------------------------------------------------------------------

describe('adopt apply — P2: stale guard fires on bumped desired revision', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('bumping expA after planning rejects with PRECONDITION_FAILED {stale} and leaves KV unchanged', () => {
    // Bump expA: its revision advances from 1 → 2.  Plan still expects 1.
    h.bumpExpA();

    let thrown: unknown;
    try {
      h.engine.apply({ plan: makeAdoptPlan(), applyReq: makeApplyReq() });
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

    // KV is unchanged: expA is at its bumped value, expB still present.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')?.value).toMatchObject({
      spec: { path: '/a-changed' },
    });
    expect(h.kv.get('/xinas/v1/desired/Share/expB')).not.toBeNull();
  });

  it('bumping expB after planning also fires the stale guard', () => {
    // Bump expB: revision 1 → 2.
    h.kv.put('/xinas/v1/desired/Share/expB', {
      kind: 'Share',
      id: 'expB',
      spec: { path: '/b-changed' },
    });

    let thrown: unknown;
    try {
      h.engine.apply({ plan: makeAdoptPlan(), applyReq: makeApplyReq() });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('PRECONDITION_FAILED');
    expect((thrown as ApiException).details?.stale).toContainEqual(
      expect.objectContaining({ kind: 'Share', id: 'expB', expected: 1 }),
    );

    expect(h.countTasks()).toBe(0);
    expect(h.countLeases()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P3: Revert on failure (begin-failure path = no agentClient)
// ---------------------------------------------------------------------------

describe('adopt apply — P3: revert on failure via begin-failure (Model R)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('begin-failure reverts put mutation: expA returns to its pre-apply value', async () => {
    const task = h.engine.apply({ plan: makeAdoptPlan(), applyReq: makeApplyReq() });

    // Precondition: mutations landed.
    expect(h.kv.get('/xinas/v1/desired/Share/expA')?.value).toMatchObject({ spec: { path: '/a' } });
    expect(h.kv.get('/xinas/v1/desired/Share/expB')).toBeNull();

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

    // P3a: expA restored to the pre-apply value (prior_value was the original seed).
    expect(h.kv.get('/xinas/v1/desired/Share/expA')?.value).toEqual({
      kind: 'Share',
      id: 'expA',
      spec: { path: '/a' },
    });

    // P3b: expB restored (prior_value was its seeded value — not null, so PUT back).
    expect(h.kv.get('/xinas/v1/desired/Share/expB')?.value).toEqual({
      kind: 'Share',
      id: 'expB',
      spec: { path: '/b' },
    });
  });

  it('begin-failure reverts a put whose prior was absent (creates are un-created)', async () => {
    // A new share not in the original seed — prior_value will be null.
    const planWithCreate = makeAdoptPlan({
      desired_mutations: [
        {
          key: '/xinas/v1/desired/Share/expNew',
          value: { kind: 'Share', id: 'expNew', spec: { path: '/new' } },
        },
      ],
      // expNew does not exist yet → revision: 0 (create pin).
      affected_resources: [
        { kind: 'ConfigSnapshot', id: 'snap-1' },
        { kind: 'Share', id: 'expNew', revision: 0 },
      ],
    });

    const task = h.engine.apply({ plan: planWithCreate, applyReq: makeApplyReq() });
    expect(h.kv.get('/xinas/v1/desired/Share/expNew')?.value).toMatchObject({ id: 'expNew' });

    let thrown: unknown;
    try {
      await h.engine.dispatch({ task, agentClient: undefined, spec: {}, plan: {} });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect(h.store.get(task.task_id)?.state).toBe('failed');
    // Prior was absent → revert deletes the key.
    expect(h.kv.get('/xinas/v1/desired/Share/expNew')).toBeNull();
  });
});
