/**
 * Agent task-execution types (S2 T6).
 *
 * The agent-side execution surface for the task engine: an {@link Executor}
 * declares its `operation_kind`, an ordered list of {@link ExecutorStage}s,
 * and a `rollback()` that undoes its own change. The {@link TaskRunner}
 * (runner.ts) drives the stages, wraps them with xinas_history snapshots, and
 * pushes the progress-event taxonomy back to the api.
 *
 * Per s2-task-envelope-spec §6/§8: the agent reports facts only; the api is
 * the sole writer of `task_stages`/`tasks` rows. These types describe the
 * execution contract, NOT the persisted schema.
 */

/**
 * Per-task execution context handed to each stage and to `rollback()`.
 *
 * `spec` is the opaque operation input (the same `spec` the api dispatched in
 * `task.begin`); an executor narrows it to its own shape. `emitOutput` records
 * a line of human-readable stage output (the runner accumulates it and reports
 * it on the corresponding stage event). `isCancelRequested` lets a cooperative
 * stage bail at a safe point.
 */
export interface ExecutorContext {
  /** Opaque operation input dispatched by the api (`task.begin` spec). */
  readonly spec: unknown;
  /** Append a line of stage output (reported on the stage's progress event). */
  emitOutput(line: string): void;
  /** True once a cancel has been requested for this task (cooperative check). */
  isCancelRequested(): boolean;
}

/** A single named stage of an {@link Executor} (e.g. preflight/apply/verify). */
export interface ExecutorStage {
  readonly name: string;
  /** Perform the stage. Throwing signals stage failure → rollback. */
  run(ctx: ExecutorContext): Promise<void>;
}

/**
 * A pluggable operation executor. Built-in `reference.echo` is the only one in
 * S2; real OS executors (xiRAID/fs/nfs/network) register their own in S3–S6.
 */
export interface Executor {
  /** The operation kind this executor handles (matches `task.begin.kind`). */
  readonly operation_kind: string;
  /** Ordered stages run by the {@link TaskRunner}. */
  readonly stages: ExecutorStage[];
  /** Undo this executor's own change after a stage failure. */
  rollback(ctx: ExecutorContext): Promise<void>;
}

/** The `event_type` taxonomy of a {@link TaskProgressEvent} (api-v1.yaml §6). */
export type TaskProgressEventType =
  | 'accepted'
  | 'stage_started'
  | 'stage_succeeded'
  | 'stage_failed'
  | 'rollback_started'
  | 'rollback_succeeded'
  | 'rollback_failed'
  | 'terminal';

/**
 * A single agent→api progress fact pushed via `POST /internal/v1/task_progress`
 * (api-v1.yaml `TaskProgressEvent`). `sequence` is per-task monotonic; the api
 * treats `sequence ≤` its high-water mark as an idempotent 200 no-op.
 */
export interface TaskProgressEvent {
  readonly task_id: string;
  readonly sequence: number;
  readonly event_type: TaskProgressEventType;
  readonly stage_index?: number;
  readonly stage_name?: string;
  readonly status?: string;
  readonly output_inline?: string;
  readonly output_size_bytes?: number;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly snapshot_id?: string;
  readonly observed_at: string;
}

/** Injected publisher: POST a single progress event to the api. */
export type PublishProgress = (event: TaskProgressEvent) => Promise<void>;

/** The `task.begin` payload the api dispatches; drives a {@link TaskRunner.run}. */
export interface TaskBegin {
  readonly task_id: string;
  readonly operation_kind: string;
  readonly spec: unknown;
  readonly plan?: unknown;
}

/** Terminal task states the runner reports (subset of the ADR-0004 lifecycle). */
export type TaskTerminalState = 'success' | 'failed' | 'requires_manual_recovery';

/**
 * Task-internal failure codes (ADR-0004 / s2-task-envelope-spec §4). Persisted
 * on the task by the api when it applies the `terminal` event.
 */
export type TaskFailureCode = 'FAILED_PARTIAL_ROLLED_BACK' | 'FAILED_MANUAL_RECOVERY_REQUIRED';
