import type { Database, Statement } from 'better-sqlite3';
import {
  type ResourceRef,
  type StageStatus,
  TERMINAL_STATES,
  type Task,
  type TaskErrorCode,
  type TaskStage,
  type TaskState,
} from './types.js';

/**
 * Prepared-statement CRUD over the durable `tasks` + `task_stages` tables
 * (001-initial.sql + 002-task-dispatch.sql). Modeled on
 * state/leases.ts::LeaseManager — a class holding better-sqlite3 prepared
 * `Statement`s built in the constructor.
 *
 * No engine logic, no apply transaction (T2), no spill-to-disk (later). The
 * store records whatever the caller passes for `output_inline`/`output_path`.
 *
 * The clock (`now`) and id generator (`newId`) are injected so tests are
 * deterministic — the store never calls Date.now()/randomUUID() directly.
 */

export interface TaskStoreDeps {
  db: Database;
  /** Epoch-ms clock. */
  now: () => number;
  /** Generates a fresh task_id (UUIDv7 in production). */
  newId: () => string;
}

/** Fields a caller supplies to create a `plan_only` task. */
export interface CreatePlanOnlyInput {
  kind: string;
  principal: string;
  client_type: string;
  request_id: string;
  correlation_id: string;
  input_hash: string;
  risk_level: string;
  affected_resources: ResourceRef[];
  idempotency_key?: string;
  plan_hash?: string;
  state_revision_expected?: number;
}

/** Fields a caller supplies to create a `queued` apply task. */
export interface CreateApplyInput {
  kind: string;
  principal: string;
  client_type: string;
  request_id: string;
  correlation_id: string;
  input_hash: string;
  risk_level: string;
  affected_resources: ResourceRef[];
  plan_id?: string;
  idempotency_key?: string;
  plan_hash?: string;
  state_revision_expected?: number;
  state_revision_at_apply?: number;
}

/** Mutable task columns a `transition()` may patch. */
export interface TaskPatch {
  state?: TaskState;
  plan_hash?: string;
  result_hash?: string;
  state_revision_at_apply?: number;
  snapshot_before?: string;
  snapshot_after?: string;
  agent_acceptance_id?: string;
  last_event_sequence?: number;
  cancel_requested_at?: number;
  cancel_refused_reason?: string;
  error_code?: TaskErrorCode;
  error_message?: string;
  remediation_hint?: string;
}

export interface StageInput {
  stage_index: number;
  name: string;
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  output_inline?: string;
  output_path?: string;
  output_size_bytes: number;
  error_code?: string;
  error_message?: string;
}

export interface TaskListFilter {
  state?: TaskState;
  kind?: string;
}

/** Raw `tasks` row as better-sqlite3 returns it. */
interface TaskRow {
  task_id: string;
  kind: string;
  state: string;
  plan_id: string | null;
  idempotency_key: string | null;
  principal: string;
  client_type: string;
  request_id: string;
  correlation_id: string;
  input_hash: string;
  plan_hash: string | null;
  result_hash: string | null;
  state_revision_expected: number | null;
  state_revision_at_apply: number | null;
  risk_level: string;
  affected_resources: string;
  snapshot_before: string | null;
  snapshot_after: string | null;
  agent_acceptance_id: string | null;
  last_event_sequence: number;
  cancel_requested_at: number | null;
  cancel_refused_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  remediation_hint: string | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

/** Raw `task_stages` row. */
interface StageRow {
  stage_index: number;
  name: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  output_inline: string | null;
  output_path: string | null;
  output_size_bytes: number;
  error_code: string | null;
  error_message: string | null;
}

const INSERT_TASK_SQL = `INSERT INTO tasks (
  task_id, kind, state, plan_id, idempotency_key, principal, client_type,
  request_id, correlation_id, input_hash, plan_hash, result_hash,
  state_revision_expected, state_revision_at_apply, risk_level,
  affected_resources, snapshot_before, snapshot_after, agent_acceptance_id,
  last_event_sequence, cancel_requested_at, cancel_refused_reason,
  error_code, error_message, remediation_hint, created_at, updated_at, terminal_at
) VALUES (
  @task_id, @kind, @state, @plan_id, @idempotency_key, @principal, @client_type,
  @request_id, @correlation_id, @input_hash, @plan_hash, @result_hash,
  @state_revision_expected, @state_revision_at_apply, @risk_level,
  @affected_resources, @snapshot_before, @snapshot_after, @agent_acceptance_id,
  @last_event_sequence, @cancel_requested_at, @cancel_refused_reason,
  @error_code, @error_message, @remediation_hint, @created_at, @updated_at, @terminal_at
)`;

const UPSERT_STAGE_SQL = `INSERT INTO task_stages (
  task_id, stage_index, name, status, started_at, ended_at,
  output_inline, output_path, output_size_bytes, error_code, error_message
) VALUES (
  @task_id, @stage_index, @name, @status, @started_at, @ended_at,
  @output_inline, @output_path, @output_size_bytes, @error_code, @error_message
)`;

export class TaskStore {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly newId: () => string;

  private readonly insertTaskStmt: Statement;
  private readonly getTaskStmt: Statement;
  private readonly getByIdempotencyStmt: Statement;
  private readonly getStagesStmt: Statement;
  private readonly findStageStmt: Statement;
  private readonly insertStageStmt: Statement;
  private readonly updateStageStmt: Statement;

  constructor(deps: TaskStoreDeps) {
    this.db = deps.db;
    this.now = deps.now;
    this.newId = deps.newId;

    this.insertTaskStmt = this.db.prepare(INSERT_TASK_SQL);
    this.getTaskStmt = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?');
    this.getByIdempotencyStmt = this.db.prepare(
      'SELECT * FROM tasks WHERE idempotency_key = ? AND principal = ?',
    );
    this.getStagesStmt = this.db.prepare(
      `SELECT stage_index, name, status, started_at, ended_at, output_inline, output_path,
              output_size_bytes, error_code, error_message
         FROM task_stages WHERE task_id = ? ORDER BY stage_index ASC`,
    );
    this.findStageStmt = this.db.prepare(
      'SELECT 1 FROM task_stages WHERE task_id = ? AND stage_index = ?',
    );
    this.insertStageStmt = this.db.prepare(UPSERT_STAGE_SQL);
    this.updateStageStmt = this.db.prepare(
      `UPDATE task_stages
          SET name = @name, status = @status, started_at = @started_at, ended_at = @ended_at,
              output_inline = @output_inline, output_path = @output_path,
              output_size_bytes = @output_size_bytes, error_code = @error_code,
              error_message = @error_message
        WHERE task_id = @task_id AND stage_index = @stage_index`,
    );
  }

  createPlanOnly(input: CreatePlanOnlyInput): Task {
    return this.insertTask({
      kind: input.kind,
      state: 'plan_only',
      principal: input.principal,
      client_type: input.client_type,
      request_id: input.request_id,
      correlation_id: input.correlation_id,
      input_hash: input.input_hash,
      risk_level: input.risk_level,
      affected_resources: input.affected_resources,
      plan_id: undefined,
      idempotency_key: input.idempotency_key,
      plan_hash: input.plan_hash,
      state_revision_expected: input.state_revision_expected,
      state_revision_at_apply: undefined,
    });
  }

  createApplyTask(input: CreateApplyInput): Task {
    return this.insertTask({
      kind: input.kind,
      state: 'queued',
      principal: input.principal,
      client_type: input.client_type,
      request_id: input.request_id,
      correlation_id: input.correlation_id,
      input_hash: input.input_hash,
      risk_level: input.risk_level,
      affected_resources: input.affected_resources,
      plan_id: input.plan_id,
      idempotency_key: input.idempotency_key,
      plan_hash: input.plan_hash,
      state_revision_expected: input.state_revision_expected,
      state_revision_at_apply: input.state_revision_at_apply,
    });
  }

  get(taskId: string): Task | null {
    const row = this.getTaskStmt.get(taskId) as TaskRow | undefined;
    if (!row) return null;
    const stages = (this.getStagesStmt.all(taskId) as StageRow[]).map(rowToStage);
    return rowToTask(row, stages);
  }

  /**
   * Look up the task that holds `(idempotency_key, principal)` — the pair the
   * `UNIQUE(idempotency_key, principal)` index guards. Returns null when no
   * task has claimed this key. The apply transaction (engine.ts) uses this to
   * resolve a duplicate apply: same key + same `input_hash` → idempotent
   * replay (return the original); different `input_hash` → CONFLICT.
   */
  getByIdempotency(idempotencyKey: string, principal: string): Task | null {
    const row = this.getByIdempotencyStmt.get(idempotencyKey, principal) as TaskRow | undefined;
    if (!row) return null;
    const stages = (this.getStagesStmt.all(row.task_id) as StageRow[]).map(rowToStage);
    return rowToTask(row, stages);
  }

  list(filter: TaskListFilter): Task[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.state !== undefined) {
      clauses.push('state = ?');
      args.push(filter.state);
    }
    if (filter.kind !== undefined) {
      clauses.push('kind = ?');
      args.push(filter.kind);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM tasks${where} ORDER BY created_at ASC, task_id ASC`)
      .all(...args) as TaskRow[];
    return rows.map((row) => {
      const stages = (this.getStagesStmt.all(row.task_id) as StageRow[]).map(rowToStage);
      return rowToTask(row, stages);
    });
  }

  /**
   * Patch a task. Bumps `updated_at` via the injected clock. Entering a
   * terminal state stamps `terminal_at` (once — a task already terminal keeps
   * its original stamp). Returns the merged row; throws if the task is unknown.
   */
  transition(taskId: string, patch: TaskPatch): Task {
    const current = this.get(taskId);
    if (!current) throw new Error(`task not found: ${taskId}`);

    const now = this.now();
    const merged: Task = { ...current, ...stripUndefined(patch), updated_at: now };

    if (
      patch.state !== undefined &&
      TERMINAL_STATES.has(patch.state) &&
      current.terminal_at === undefined
    ) {
      merged.terminal_at = now;
    }

    this.db
      .prepare(
        `UPDATE tasks SET
            state = @state, plan_hash = @plan_hash, result_hash = @result_hash,
            state_revision_at_apply = @state_revision_at_apply,
            snapshot_before = @snapshot_before, snapshot_after = @snapshot_after,
            agent_acceptance_id = @agent_acceptance_id, last_event_sequence = @last_event_sequence,
            cancel_requested_at = @cancel_requested_at, cancel_refused_reason = @cancel_refused_reason,
            error_code = @error_code, error_message = @error_message,
            remediation_hint = @remediation_hint, updated_at = @updated_at, terminal_at = @terminal_at
          WHERE task_id = @task_id`,
      )
      .run({
        task_id: taskId,
        state: merged.state,
        plan_hash: merged.plan_hash ?? null,
        result_hash: merged.result_hash ?? null,
        state_revision_at_apply: merged.state_revision_at_apply ?? null,
        snapshot_before: merged.snapshot_before ?? null,
        snapshot_after: merged.snapshot_after ?? null,
        agent_acceptance_id: merged.agent_acceptance_id ?? null,
        last_event_sequence: merged.last_event_sequence,
        cancel_requested_at: merged.cancel_requested_at ?? null,
        cancel_refused_reason: merged.cancel_refused_reason ?? null,
        error_code: merged.error_code ?? null,
        error_message: merged.error_message ?? null,
        remediation_hint: merged.remediation_hint ?? null,
        updated_at: merged.updated_at,
        terminal_at: merged.terminal_at ?? null,
      });

    return merged;
  }

  /**
   * Insert or update a stage keyed by `(task_id, stage_index)`. A second call
   * with the same index updates the row in place (no duplicate). Inline-vs-spill
   * is the caller's decision; the store records whatever it is handed.
   *
   * No-duplicate safety has two layers: xinas-api is the single SQLite writer
   * (ADR-0002) and better-sqlite3 is synchronous, so the probe-then-write below
   * never races; and the `UNIQUE(task_id, stage_index)` index (migration 002) is
   * the DB-level backstop that makes a duplicate stage row impossible regardless.
   */
  upsertStage(taskId: string, stage: StageInput): void {
    const params = {
      task_id: taskId,
      stage_index: stage.stage_index,
      name: stage.name,
      status: stage.status,
      started_at: stage.started_at ?? null,
      ended_at: stage.ended_at ?? null,
      output_inline: stage.output_inline ?? null,
      output_path: stage.output_path ?? null,
      output_size_bytes: stage.output_size_bytes,
      error_code: stage.error_code ?? null,
      error_message: stage.error_message ?? null,
    };
    const upsert = this.db.transaction(() => {
      const exists = this.findStageStmt.get(taskId, stage.stage_index);
      if (exists) {
        this.updateStageStmt.run(params);
      } else {
        this.insertStageStmt.run(params);
      }
    });
    upsert();
  }

  private insertTask(fields: {
    kind: string;
    state: TaskState;
    principal: string;
    client_type: string;
    request_id: string;
    correlation_id: string;
    input_hash: string;
    risk_level: string;
    affected_resources: ResourceRef[];
    // `| undefined` (not `?`) so callers may pass an explicitly-undefined
    // optional through without tripping exactOptionalPropertyTypes; the
    // `?? null` below normalizes either form.
    plan_id: string | undefined;
    idempotency_key: string | undefined;
    plan_hash: string | undefined;
    state_revision_expected: number | undefined;
    state_revision_at_apply: number | undefined;
  }): Task {
    const now = this.now();
    const task_id = this.newId();
    this.insertTaskStmt.run({
      task_id,
      kind: fields.kind,
      state: fields.state,
      plan_id: fields.plan_id ?? null,
      idempotency_key: fields.idempotency_key ?? null,
      principal: fields.principal,
      client_type: fields.client_type,
      request_id: fields.request_id,
      correlation_id: fields.correlation_id,
      input_hash: fields.input_hash,
      plan_hash: fields.plan_hash ?? null,
      result_hash: null,
      state_revision_expected: fields.state_revision_expected ?? null,
      state_revision_at_apply: fields.state_revision_at_apply ?? null,
      risk_level: fields.risk_level,
      affected_resources: JSON.stringify(fields.affected_resources),
      snapshot_before: null,
      snapshot_after: null,
      agent_acceptance_id: null,
      last_event_sequence: 0,
      cancel_requested_at: null,
      cancel_refused_reason: null,
      error_code: null,
      error_message: null,
      remediation_hint: null,
      created_at: now,
      updated_at: now,
      terminal_at: null,
    });
    // Re-read so the returned Task is exactly the persisted shape.
    const created = this.get(task_id);
    if (!created) throw new Error(`task insert vanished: ${task_id}`);
    return created;
  }
}

/** Drop keys whose value is `undefined` so a spread preserves prior values. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function rowToStage(row: StageRow): TaskStage {
  return {
    stage_index: row.stage_index,
    name: row.name,
    status: row.status as StageStatus,
    output_size_bytes: row.output_size_bytes,
    ...(row.started_at !== null ? { started_at: row.started_at } : {}),
    ...(row.ended_at !== null ? { ended_at: row.ended_at } : {}),
    ...(row.output_inline !== null ? { output_inline: row.output_inline } : {}),
    ...(row.output_path !== null ? { output_path: row.output_path } : {}),
    ...(row.error_code !== null ? { error_code: row.error_code } : {}),
    ...(row.error_message !== null ? { error_message: row.error_message } : {}),
  };
}

function rowToTask(row: TaskRow, stages: TaskStage[]): Task {
  return {
    task_id: row.task_id,
    kind: row.kind,
    state: row.state as TaskState,
    principal: row.principal,
    client_type: row.client_type,
    request_id: row.request_id,
    correlation_id: row.correlation_id,
    input_hash: row.input_hash,
    risk_level: row.risk_level,
    affected_resources: JSON.parse(row.affected_resources) as ResourceRef[],
    last_event_sequence: row.last_event_sequence,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stages,
    ...(row.plan_id !== null ? { plan_id: row.plan_id } : {}),
    ...(row.idempotency_key !== null ? { idempotency_key: row.idempotency_key } : {}),
    ...(row.plan_hash !== null ? { plan_hash: row.plan_hash } : {}),
    ...(row.result_hash !== null ? { result_hash: row.result_hash } : {}),
    ...(row.state_revision_expected !== null
      ? { state_revision_expected: row.state_revision_expected }
      : {}),
    ...(row.state_revision_at_apply !== null
      ? { state_revision_at_apply: row.state_revision_at_apply }
      : {}),
    ...(row.snapshot_before !== null ? { snapshot_before: row.snapshot_before } : {}),
    ...(row.snapshot_after !== null ? { snapshot_after: row.snapshot_after } : {}),
    ...(row.agent_acceptance_id !== null ? { agent_acceptance_id: row.agent_acceptance_id } : {}),
    ...(row.cancel_requested_at !== null ? { cancel_requested_at: row.cancel_requested_at } : {}),
    ...(row.cancel_refused_reason !== null
      ? { cancel_refused_reason: row.cancel_refused_reason }
      : {}),
    ...(row.error_code !== null ? { error_code: row.error_code as TaskErrorCode } : {}),
    ...(row.error_message !== null ? { error_message: row.error_message } : {}),
    ...(row.remediation_hint !== null ? { remediation_hint: row.remediation_hint } : {}),
    ...(row.terminal_at !== null ? { terminal_at: row.terminal_at } : {}),
  };
}
