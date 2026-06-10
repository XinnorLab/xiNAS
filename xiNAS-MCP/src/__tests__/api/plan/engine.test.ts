import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../../api/errors.js';
import { PlanEngine } from '../../../api/plan/engine.js';
import type { PlanContext, PlanProvider } from '../../../api/plan/engine.js';
import { referencePlanProvider } from '../../../api/plan/providers/reference.js';
import { TaskStore } from '../../../api/tasks/store.js';
import type { DesiredMutation, ResourceRef } from '../../../api/tasks/types.js';
import { SqliteKvStore } from '../../../state/backend-sqlite.js';
import { runMigrations } from '../../../state/migrations.js';

// Deterministic clock + id-gen so assertions never depend on wall time.
function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  // SqliteKvStore's constructor turns on foreign_keys + WAL — the same
  // pragmas the production process runs under.
  const kv = new SqliteKvStore(db);

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

  const ctx: PlanContext = { kv };
  const engine = new PlanEngine({ store, ctx });

  return {
    db,
    kv,
    store,
    engine,
    setClock(v: number) {
      clock = v;
    },
    countTasks(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    },
  };
}

function makePlanArgs(specOverride?: Record<string, unknown>) {
  return {
    operation_kind: 'reference.echo',
    spec: specOverride ?? { id: 'r1', message: 'hello', count: 3 },
    principal: 'admin:test',
    client_type: 'rest',
    request_id: '11111111-1111-1111-1111-111111111111',
    correlation_id: 'corr-1',
  };
}

describe('PlanEngine.plan', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    h.engine.register(referencePlanProvider);
  });

  it('reference.echo: writes a plan_only task row with plan_hash, non_disruptive risk, reference resource first', async () => {
    const { task, planResult } = await h.engine.plan(makePlanArgs());

    expect(task.state).toBe('plan_only');
    expect(task.kind).toBe('reference.echo');
    expect(task.risk_level).toBe('non_disruptive');
    expect(typeof task.plan_hash).toBe('string');
    expect((task.plan_hash as string).length).toBe(64); // sha256 hex
    expect(typeof task.input_hash).toBe('string');

    // The reference resource is the primary/observed resource → index 0.
    expect(task.affected_resources[0]).toMatchObject({ kind: 'Reference', id: 'r1' });

    // Persisted: exactly one row, in plan_only state.
    expect(h.countTasks()).toBe(1);
    expect(h.store.get(task.task_id)?.state).toBe('plan_only');

    // PlanResult carries the surfaced fields the route (T4) renders.
    expect(planResult.risk_level).toBe('non_disruptive');
    expect(planResult.blockers).toEqual([]);
    expect(planResult.warnings).toEqual([]);
    expect(planResult.diff).toEqual({ id: 'r1', message: 'hello', count: 3 });
    expect(planResult.affected_resources[0]).toMatchObject({ kind: 'Reference', id: 'r1' });
  });

  it("reference.echo with no spec.id falls back to a 'default' reference resource", async () => {
    const { task } = await h.engine.plan(makePlanArgs({ message: 'no id here' }));
    expect(task.affected_resources[0]).toMatchObject({ kind: 'Reference', id: 'default' });
  });

  it('determinism: identical spec → identical plan_hash', async () => {
    const a = await h.engine.plan(makePlanArgs({ id: 'r1', a: 1, b: 2 }));
    const b = await h.engine.plan(makePlanArgs({ id: 'r1', a: 1, b: 2 }));
    expect(a.task.plan_hash).toBe(b.task.plan_hash);
    expect(a.task.input_hash).toBe(b.task.input_hash);
    // Different task rows (different task_id) but the same plan_hash.
    expect(a.task.task_id).not.toBe(b.task.task_id);
  });

  it('determinism: changed spec → different plan_hash', async () => {
    const a = await h.engine.plan(makePlanArgs({ id: 'r1', a: 1, b: 2 }));
    const b = await h.engine.plan(makePlanArgs({ id: 'r1', a: 1, b: 999 }));
    expect(a.task.plan_hash).not.toBe(b.task.plan_hash);
  });

  it('canonicalization: key-order differences in the spec produce the SAME plan_hash', async () => {
    const a = await h.engine.plan(makePlanArgs({ id: 'r1', a: 1, b: 2, nested: { x: 1, y: 2 } }));
    // Same content, keys emitted in a different order (incl. nested object).
    const b = await h.engine.plan(makePlanArgs({ nested: { y: 2, x: 1 }, b: 2, a: 1, id: 'r1' }));
    expect(a.task.plan_hash).toBe(b.task.plan_hash);
    expect(a.task.input_hash).toBe(b.task.input_hash);
  });

  it('freshness: stamps state/observed revisions + observed_at from real KV reads', async () => {
    // Seed the desired + observed projections of the reference resource.
    h.kv.put('/xinas/v1/desired/Reference/r1', { id: 'r1', message: 'desired' });
    h.kv.put('/xinas/v1/observed/Reference/r1', { id: 'r1', state: 'ok' });

    const { task, planResult } = await h.engine.plan(makePlanArgs({ id: 'r1' }));

    // Desired revision → state_revision_expected (stamped on the row).
    expect(task.state_revision_expected).toBe(1);
    expect(task.affected_resources[0]?.revision).toBe(1);
    // Observed revision + observed_at surfaced on the PlanResult.
    expect(planResult.observed_revision_expected).toBe(1);
    expect(typeof planResult.observed_at).toBe('string');
  });

  it('freshness: a reference resource that does not exist yet → revisions undefined', async () => {
    const { task, planResult } = await h.engine.plan(makePlanArgs({ id: 'ghost' }));
    expect(task.state_revision_expected).toBeUndefined();
    expect(task.affected_resources[0]?.revision).toBeUndefined();
    expect(planResult.observed_revision_expected).toBeUndefined();
  });

  it('unknown operation_kind → ApiException(UNSUPPORTED)', async () => {
    let thrown: unknown;
    try {
      await h.engine.plan({ ...makePlanArgs(), operation_kind: 'nope.unknown' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiException);
    expect((thrown as ApiException).code).toBe('UNSUPPORTED');
    expect((thrown as ApiException).message).toContain('nope.unknown');
    // No task row written for an unknown kind.
    expect(h.countTasks()).toBe(0);
  });

  it('register: a custom provider is keyed by operation_kind', async () => {
    const custom: PlanProvider = {
      operation_kind: 'custom.op',
      async preflight() {
        return {
          affected_resources: [{ kind: 'Custom', id: 'c1' }],
          blockers: [],
          warnings: [{ code: 'W', message: 'heads up' }],
          diff: { changed: true },
          risk_level: 'changing_access',
          rollback_model: 'changing_access',
        };
      },
    };
    h.engine.register(custom);
    const { task, planResult } = await h.engine.plan({
      ...makePlanArgs(),
      operation_kind: 'custom.op',
    });
    expect(task.kind).toBe('custom.op');
    expect(task.risk_level).toBe('changing_access');
    expect(planResult.warnings).toEqual([{ code: 'W', message: 'heads up' }]);
  });

  // ── N0.2: plan-binding persistence + plan_hash fold ────────────────────────

  it('plan_binding: a provider emitting the three N0 fields persists them on the row', async () => {
    const observed_freshness_ref = { kind: 'ExportRule', id: 'mnt/data', revision: 7 };
    const lease_resources: ResourceRef[] = [{ kind: 'NfsIdmap', id: 'snapshot' }];
    const desired_mutations: DesiredMutation[] = [
      { key: '/xinas/v1/desired/Share/s1', value: { id: 's1', path: '/mnt/data' } },
      { key: '/xinas/v1/desired/Share/old', delete: true },
    ];
    const provider: PlanProvider = {
      operation_kind: 'binding.full',
      async preflight() {
        return {
          affected_resources: [{ kind: 'Share', id: 's1' }],
          blockers: [],
          warnings: [],
          diff: { changed: true },
          risk_level: 'non_disruptive',
          rollback_model: 'reversible',
          observed_freshness_ref,
          lease_resources,
          desired_mutations,
        };
      },
    };
    h.engine.register(provider);

    const { task } = await h.engine.plan({ ...makePlanArgs(), operation_kind: 'binding.full' });

    // Re-read from the store: plan_binding holds exactly the three fields.
    expect(h.store.get(task.task_id)?.plan_binding).toEqual({
      observed_freshness_ref,
      lease_resources,
      desired_mutations,
    });
  });

  it('plan_binding: two plans differing only in observed_freshness_ref.revision get different plan_hash', async () => {
    const makeProvider = (revision: number): PlanProvider => ({
      operation_kind: 'binding.freshness',
      async preflight() {
        return {
          affected_resources: [{ kind: 'Share', id: 's1' }],
          blockers: [],
          warnings: [],
          diff: { same: true },
          risk_level: 'non_disruptive',
          rollback_model: 'reversible',
          observed_freshness_ref: { kind: 'ExportRule', id: 'mnt/data', revision },
        };
      },
    });

    h.engine.register(makeProvider(1));
    const a = await h.engine.plan({ ...makePlanArgs(), operation_kind: 'binding.freshness' });
    h.engine.register(makeProvider(2));
    const b = await h.engine.plan({ ...makePlanArgs(), operation_kind: 'binding.freshness' });

    // input_hash pins only operation_kind + spec → unchanged across the two.
    expect(a.task.input_hash).toBe(b.task.input_hash);
    // plan_hash folds observed_freshness_ref → divergent re-plan is detectable.
    expect(a.task.plan_hash).not.toBe(b.task.plan_hash);
  });

  it('plan_binding: a provider emitting NONE of the three leaves plan_binding undefined (reference-like)', async () => {
    const bare: PlanProvider = {
      operation_kind: 'binding.none',
      async preflight() {
        return {
          affected_resources: [{ kind: 'Custom', id: 'c1' }],
          blockers: [],
          warnings: [],
          diff: { x: 1 },
          risk_level: 'non_disruptive',
          rollback_model: 'reversible',
        };
      },
    };
    h.engine.register(bare);

    const { task } = await h.engine.plan({ ...makePlanArgs(), operation_kind: 'binding.none' });
    expect(h.store.get(task.task_id)?.plan_binding).toBeUndefined();
  });

  it('plan_hash: the reference provider (emits none) keeps a stable plan_hash across replans', async () => {
    // Folding the three undefined fields into the canonicalized hash input must
    // NOT change the reference provider's plan_hash — JSON.stringify drops
    // undefined object properties, so reference plans hash identically.
    const a = await h.engine.plan(makePlanArgs({ id: 'r1', a: 1, b: 2 }));
    const b = await h.engine.plan(makePlanArgs({ id: 'r1', a: 1, b: 2 }));
    expect(a.task.plan_hash).toBe(b.task.plan_hash);
    // The reference provider sets no binding fields → plan_binding stays unset.
    expect(a.task.plan_binding).toBeUndefined();
  });
});
