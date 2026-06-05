import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../../api/errors.js';
import { TaskEngine } from '../../../api/tasks/engine.js';
import type { ApplyPlan, ApplyRequest } from '../../../api/tasks/engine.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { SqliteKvStore } from '../../../state/backend-sqlite.js';
import { LeaseManager } from '../../../state/leases.js';
import { runMigrations } from '../../../state/migrations.js';

// Deterministic clock + id-gen so assertions never depend on wall time.
function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  // SqliteKvStore's constructor turns on foreign_keys + WAL — the same
  // pragmas the production process runs under. The leases FK references
  // tasks(task_id), so the apply txn relies on foreign_keys = ON.
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

  // Seed a desired resource so freshness reads find a current revision.
  // put() with no expected_revision creates it at revision 1.
  kv.put('/xinas/v1/desired/Share/s1', { id: 's1', name: 'demo' });

  return {
    db,
    kv,
    leases,
    store,
    engine,
    setClock(v: number) {
      clock = v;
    },
    /** Bump the seeded resource's revision (simulates a concurrent write). */
    bumpResource() {
      kv.put('/xinas/v1/desired/Share/s1', { id: 's1', name: 'changed' });
    },
    countTasks(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
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

// The resource is at revision 1 after the seed put(); the plan expects it.
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

describe('TaskEngine.apply', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('happy path: returns a queued task with leases held and the row present', () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });

    expect(task.state).toBe('queued');
    expect(task.kind).toBe('reference.echo');
    expect(task.plan_id).toBe('plan-1');
    expect(task.idempotency_key).toBe('idem-1');
    expect(task.input_hash).toBe('ihash-1');
    expect(task.state_revision_expected).toBe(1);
    expect(task.state_revision_at_apply).toBe(1);

    // Persisted.
    expect(h.store.get(task.task_id)?.state).toBe('queued');
    expect(h.countTasks()).toBe(1);

    // Lease held, referencing the new task.
    expect(h.countLeases()).toBe(1);
    expect(h.leaseHolder('Share', 's1')).toBe(task.task_id);
  });

  it('idempotency: same key + same input_hash returns the ORIGINAL task, one row', () => {
    const first = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    const second = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });

    expect(second.task_id).toBe(first.task_id);
    expect(h.countTasks()).toBe(1);
    // No duplicate lease either.
    expect(h.countLeases()).toBe(1);
  });

  it('idempotency conflict: same key + different input_hash throws CONFLICT and leaves the original', () => {
    const first = h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });

    expect(() =>
      h.engine.apply({
        plan: makePlan(),
        applyReq: makeApplyReq({ input_hash: 'ihash-DIFFERENT' }),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'idempotency_key_reused' }),
      }),
    );

    // Original untouched, no second row.
    expect(h.countTasks()).toBe(1);
    expect(h.store.get(first.task_id)?.input_hash).toBe('ihash-1');
  });

  it('stale revision: throws PRECONDITION_FAILED and writes NO task row, NO lease (rollback)', () => {
    h.bumpResource(); // resource now at revision 2; plan expects 1

    let thrown: unknown;
    try {
      h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('PRECONDITION_FAILED');
    expect((thrown as ApiException).details?.stale).toEqual([
      { kind: 'Share', id: 's1', expected: 1, current: 2 },
    ]);

    // Full rollback: nothing persisted.
    expect(h.countTasks()).toBe(0);
    expect(h.countLeases()).toBe(0);
  });

  it('lease held by another task: throws CONFLICT {lease_held} with the holder and rolls back', () => {
    // Pre-acquire the resource lease for an unrelated task. The lease FK
    // references tasks(task_id), so first create a holder task row.
    const holder = h.store.createApplyTask({
      kind: 'reference.echo',
      principal: 'admin:other',
      client_type: 'rest',
      request_id: '33333333-3333-3333-3333-333333333333',
      correlation_id: 'corr-other',
      input_hash: 'ihash-other',
      risk_level: 'non_disruptive',
      affected_resources: [{ kind: 'Share', id: 's1', revision: 1 }],
    });
    const pre = h.leases.acquire({
      resource_kind: 'Share',
      resource_id: 's1',
      task_id: holder.task_id,
      ttl_seconds: 60,
    });
    expect(pre.ok).toBe(true);

    let thrown: unknown;
    try {
      h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('CONFLICT');
    expect((thrown as ApiException).details).toMatchObject({
      reason: 'lease_held',
      holder_task_id: holder.task_id,
    });

    // The apply task row rolled back; only the holder task + its lease remain.
    expect(h.countTasks()).toBe(1);
    expect(h.countLeases()).toBe(1);
    expect(h.leaseHolder('Share', 's1')).toBe(holder.task_id);
  });

  it('plan_stale: observed drift beyond the plan rule throws CONFLICT {plan_stale}', () => {
    // Seed an observed resource the plan pinned at observed revision 1.
    h.kv.put('/xinas/v1/observed/Share/s1', { id: 's1', state: 'ok' });
    // Drift it forward.
    h.kv.put('/xinas/v1/observed/Share/s1', { id: 's1', state: 'degraded' });

    expect(() =>
      h.engine.apply({
        plan: makePlan({ observed_revision_expected: 1 }),
        applyReq: makeApplyReq(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CONFLICT',
        details: expect.objectContaining({ reason: 'plan_stale' }),
      }),
    );

    expect(h.countTasks()).toBe(0);
    expect(h.countLeases()).toBe(0);
  });

  it('multi-resource: all leases acquired atomically; partial lease conflict rolls all back', () => {
    h.kv.put('/xinas/v1/desired/Share/s2', { id: 's2', name: 'second' });

    // Pre-hold the SECOND resource for an unrelated task.
    const holder = h.store.createApplyTask({
      kind: 'reference.echo',
      principal: 'admin:other',
      client_type: 'rest',
      request_id: '44444444-4444-4444-4444-444444444444',
      correlation_id: 'corr-other2',
      input_hash: 'ihash-other2',
      risk_level: 'non_disruptive',
      affected_resources: [{ kind: 'Share', id: 's2', revision: 1 }],
    });
    h.leases.acquire({
      resource_kind: 'Share',
      resource_id: 's2',
      task_id: holder.task_id,
      ttl_seconds: 60,
    });

    expect(() =>
      h.engine.apply({
        plan: makePlan({
          affected_resources: [
            { kind: 'Share', id: 's1', revision: 1 },
            { kind: 'Share', id: 's2', revision: 1 },
          ],
        }),
        applyReq: makeApplyReq(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

    // s1's lease must NOT linger — the whole txn rolled back.
    expect(h.countLeases()).toBe(1); // only the holder's s2 lease
    expect(h.leaseHolder('Share', 's1')).toBeUndefined();
    expect(h.countTasks()).toBe(1); // only the holder task
  });
});
