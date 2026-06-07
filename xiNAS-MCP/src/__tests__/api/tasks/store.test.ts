import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../../../api/tasks/store.js';
import type { CreateApplyInput, CreatePlanOnlyInput } from '../../../api/tasks/store.js';
import { runMigrations } from '../../../state/migrations.js';

// Deterministic clock + id-gen so assertions never depend on wall time.
function makeHarness() {
  const db = new Database(':memory:');
  runMigrations(db);
  let clock = 1_000;
  let idCounter = 0;
  const ids: string[] = [];
  const store = new TaskStore({
    db,
    now: () => clock,
    newId: () => {
      idCounter += 1;
      const id = `task-${String(idCounter).padStart(4, '0')}`;
      ids.push(id);
      return id;
    },
  });
  return {
    db,
    store,
    ids,
    advance(ms: number) {
      clock += ms;
    },
    setClock(v: number) {
      clock = v;
    },
  };
}

const PLAN_INPUT: CreatePlanOnlyInput = {
  kind: 'reference.echo',
  principal: 'admin:test',
  client_type: 'rest',
  request_id: '11111111-1111-1111-1111-111111111111',
  correlation_id: 'corr-1',
  input_hash: 'ihash-plan',
  plan_hash: 'phash-1',
  risk_level: 'non_disruptive',
  affected_resources: [{ kind: 'Share', id: 's1', revision: 7 }],
  state_revision_expected: 7,
};

const APPLY_INPUT: CreateApplyInput = {
  kind: 'reference.echo',
  plan_id: 'task-0001',
  principal: 'admin:test',
  client_type: 'rest',
  request_id: '22222222-2222-2222-2222-222222222222',
  correlation_id: 'corr-2',
  input_hash: 'ihash-plan',
  plan_hash: 'phash-1',
  risk_level: 'non_disruptive',
  affected_resources: [{ kind: 'Share', id: 's1', revision: 7 }],
  state_revision_expected: 7,
  state_revision_at_apply: 7,
};

// Apply input with no plan_id (apply tasks need not always reference a plan in
// these store-level tests). Built by omission so exactOptionalPropertyTypes is
// satisfied (spreading `plan_id: undefined` is rejected under that flag).
const { plan_id: _omit, ...APPLY_INPUT_NO_PLAN } = APPLY_INPUT;

describe('TaskStore', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('createPlanOnly writes a plan_only row with last_event_sequence 0 and no stages', () => {
    const task = h.store.createPlanOnly(PLAN_INPUT);
    expect(task.state).toBe('plan_only');
    expect(task.task_id).toBe('task-0001');
    expect(task.last_event_sequence).toBe(0);
    expect(task.created_at).toBe(1_000);
    expect(task.updated_at).toBe(1_000);
    expect(task.terminal_at).toBeUndefined();
    expect(task.stages).toEqual([]);

    const got = h.store.get('task-0001');
    expect(got).not.toBeNull();
    expect(got?.state).toBe('plan_only');
    expect(got?.plan_hash).toBe('phash-1');
    expect(got?.stages).toEqual([]);
  });

  it('createApplyTask writes a queued row referencing the plan', () => {
    h.store.createPlanOnly(PLAN_INPUT);
    const apply = h.store.createApplyTask(APPLY_INPUT);
    expect(apply.state).toBe('queued');
    expect(apply.plan_id).toBe('task-0001');
    expect(apply.state_revision_at_apply).toBe(7);
    expect(apply.last_event_sequence).toBe(0);
    const got = h.store.get(apply.task_id);
    expect(got?.state).toBe('queued');
  });

  it('affected_resources round-trips through JSON', () => {
    const task = h.store.createPlanOnly(PLAN_INPUT);
    const got = h.store.get(task.task_id);
    expect(got?.affected_resources).toEqual([{ kind: 'Share', id: 's1', revision: 7 }]);
  });

  it('spec round-trips through JSON on plan_only and apply tasks (migration 003)', () => {
    const spec = { message: 'hi', fail_at_stage: 'apply' };
    const plan = h.store.createPlanOnly({ ...PLAN_INPUT, spec });
    expect(h.store.get(plan.task_id)?.spec).toEqual(spec);

    const apply = h.store.createApplyTask({ ...APPLY_INPUT_NO_PLAN, spec });
    expect(h.store.get(apply.task_id)?.spec).toEqual(spec);
  });

  it('a task created WITHOUT a spec has spec === undefined (NULL → omitted)', () => {
    const plan = h.store.createPlanOnly(PLAN_INPUT); // no spec
    expect(h.store.get(plan.task_id)?.spec).toBeUndefined();

    const apply = h.store.createApplyTask(APPLY_INPUT_NO_PLAN); // no spec
    expect(h.store.get(apply.task_id)?.spec).toBeUndefined();
  });

  it('plan_binding + desired_rollback round-trip through JSON on apply tasks (migration 004)', () => {
    const plan_binding = {
      observed_freshness_ref: { kind: 'ExportRule', id: 'mnt/data', revision: 3 },
    };
    const desired_rollback = [{ key: '/xinas/v1/desired/Share/s1', prior_value: null }];
    const apply = h.store.createApplyTask({
      ...APPLY_INPUT_NO_PLAN,
      plan_binding,
      desired_rollback,
    });
    const got = h.store.get(apply.task_id);
    expect(got?.plan_binding).toEqual(plan_binding);
    expect(got?.desired_rollback).toEqual(desired_rollback);
  });

  it('a task created WITHOUT plan_binding/desired_rollback has both === undefined', () => {
    const apply = h.store.createApplyTask(APPLY_INPUT_NO_PLAN);
    const got = h.store.get(apply.task_id);
    expect(got?.plan_binding).toBeUndefined();
    expect(got?.desired_rollback).toBeUndefined();
  });

  it('transition patches desired_rollback (JSON) without disturbing plan_binding', () => {
    const plan_binding = {
      observed_freshness_ref: { kind: 'ExportRule', id: 'mnt/data', revision: 3 },
    };
    const apply = h.store.createApplyTask({ ...APPLY_INPUT_NO_PLAN, plan_binding });
    const desired_rollback = [{ key: '/x', prior_value: { a: 1 } }];
    h.store.transition(apply.task_id, { desired_rollback });
    const got = h.store.get(apply.task_id);
    expect(got?.desired_rollback).toEqual(desired_rollback);
    // plan_binding set at create time is left untouched by the patch.
    expect(got?.plan_binding).toEqual(plan_binding);
  });

  it('get returns null for an unknown id', () => {
    expect(h.store.get('nope')).toBeNull();
  });

  it('transition updates fields and bumps updated_at', () => {
    const task = h.store.createPlanOnly(PLAN_INPUT);
    h.setClock(5_000);
    const updated = h.store.transition(task.task_id, {
      state: 'running',
      agent_acceptance_id: 'a1',
    });
    expect(updated.state).toBe('running');
    expect(updated.agent_acceptance_id).toBe('a1');
    expect(updated.updated_at).toBe(5_000);
    expect(updated.terminal_at).toBeUndefined();
  });

  it('transition into a terminal state stamps terminal_at once', () => {
    const task = h.store.createApplyTask(APPLY_INPUT_NO_PLAN);
    h.setClock(9_000);
    const done = h.store.transition(task.task_id, { state: 'success', result_hash: 'rh' });
    expect(done.state).toBe('success');
    expect(done.terminal_at).toBe(9_000);
    expect(done.result_hash).toBe('rh');

    // A later transition does not overwrite the original terminal_at.
    h.setClock(12_000);
    const again = h.store.transition(task.task_id, { error_message: 'noop' });
    expect(again.terminal_at).toBe(9_000);
    expect(again.updated_at).toBe(12_000);
  });

  it('upsertStage inserts then updates the same (task_id, stage_index)', () => {
    const task = h.store.createApplyTask(APPLY_INPUT_NO_PLAN);
    h.store.upsertStage(task.task_id, {
      stage_index: 0,
      name: 'apply',
      status: 'running',
      output_size_bytes: 0,
    });
    let got = h.store.get(task.task_id);
    expect(got?.stages).toHaveLength(1);
    expect(got?.stages[0]).toMatchObject({ stage_index: 0, name: 'apply', status: 'running' });

    // Second call with same index UPDATEs in place (no duplicate row).
    h.store.upsertStage(task.task_id, {
      stage_index: 0,
      name: 'apply',
      status: 'success',
      output_inline: 'done',
      output_size_bytes: 4,
      ended_at: 6_000,
    });
    got = h.store.get(task.task_id);
    expect(got?.stages).toHaveLength(1);
    expect(got?.stages[0]).toMatchObject({
      stage_index: 0,
      status: 'success',
      output_inline: 'done',
      output_size_bytes: 4,
      ended_at: 6_000,
    });
  });

  it('get returns stages ordered by stage_index', () => {
    const task = h.store.createApplyTask(APPLY_INPUT_NO_PLAN);
    h.store.upsertStage(task.task_id, {
      stage_index: 2,
      name: 'validate',
      status: 'pending',
      output_size_bytes: 0,
    });
    h.store.upsertStage(task.task_id, {
      stage_index: 0,
      name: 'preflight',
      status: 'success',
      output_size_bytes: 0,
    });
    h.store.upsertStage(task.task_id, {
      stage_index: 1,
      name: 'apply',
      status: 'running',
      output_size_bytes: 0,
    });
    const got = h.store.get(task.task_id);
    expect(got?.stages.map((s) => s.stage_index)).toEqual([0, 1, 2]);
    expect(got?.stages.map((s) => s.name)).toEqual(['preflight', 'apply', 'validate']);
  });

  it('list filters by state and by kind', () => {
    h.store.createPlanOnly(PLAN_INPUT); // plan_only, reference.echo
    const apply = h.store.createApplyTask(APPLY_INPUT); // queued, reference.echo
    h.store.createPlanOnly({ ...PLAN_INPUT, kind: 'share.create' }); // plan_only, share.create

    const planOnly = h.store.list({ state: 'plan_only' });
    expect(planOnly.map((t) => t.state)).toEqual(['plan_only', 'plan_only']);

    const queued = h.store.list({ state: 'queued' });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.task_id).toBe(apply.task_id);

    const echo = h.store.list({ kind: 'reference.echo' });
    expect(echo).toHaveLength(2);
    expect(echo.every((t) => t.kind === 'reference.echo')).toBe(true);

    const both = h.store.list({ state: 'plan_only', kind: 'share.create' });
    expect(both).toHaveLength(1);
    expect(both[0]?.kind).toBe('share.create');

    expect(h.store.list({}).length).toBe(3);
  });
});
