// Task + TaskStage store-level types (ADR-0004, s2-task-envelope-spec).
//
// These mirror the durable `tasks` / `task_stages` columns from
// 001-initial.sql + 002-task-dispatch.sql. Timestamps are epoch-ms numbers
// here (the SQLite representation); the public api-v1.yaml Task/TaskStage
// schemas re-render them as ISO date-time strings and `output_path` as
// `output_url` at the HTTP boundary — that mapping lives in the route layer,
// not the store.

export type TaskState =
  | 'plan_only'
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'requires_manual_recovery'
  | 'imported';

export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export type TaskErrorCode =
  | 'FAILED_BEFORE_CHANGE'
  | 'FAILED_PARTIAL_ROLLED_BACK'
  | 'FAILED_MANUAL_RECOVERY_REQUIRED'
  | 'FAILED_STATE_DESYNC';

export type EventType =
  | 'accepted'
  | 'stage_started'
  | 'stage_succeeded'
  | 'stage_failed'
  | 'rollback_started'
  | 'rollback_succeeded'
  | 'rollback_failed'
  | 'terminal';

/** One {kind,id,revision?} entry of a task's `affected_resources` JSON array. */
export interface ResourceRef {
  kind: string;
  id: string;
  revision?: number;
}

export interface TaskStage {
  stage_index: number;
  name: string;
  status: StageStatus;
  started_at?: number;
  ended_at?: number;
  /** Inline stage output; present (text ≤ 64 KiB) when not spilled. */
  output_inline?: string;
  /** Relative path under /var/log/xinas/tasks/ when spilled (later task). */
  output_path?: string;
  output_size_bytes: number;
  error_code?: string;
  error_message?: string;
}

export interface Task {
  /** Operation kind, e.g. "reference.echo" / "share.create". */
  kind: string;
  task_id: string;
  state: TaskState;
  plan_id?: string;
  idempotency_key?: string;
  principal: string;
  client_type: string;
  request_id: string;
  correlation_id: string;
  input_hash: string;
  plan_hash?: string;
  result_hash?: string;
  state_revision_expected?: number;
  state_revision_at_apply?: number;
  risk_level: string;
  affected_resources: ResourceRef[];
  snapshot_before?: string;
  snapshot_after?: string;
  agent_acceptance_id?: string;
  last_event_sequence: number;
  cancel_requested_at?: number;
  cancel_refused_reason?: string;
  error_code?: TaskErrorCode;
  error_message?: string;
  remediation_hint?: string;
  created_at: number;
  updated_at: number;
  terminal_at?: number;
  stages: TaskStage[];
}

/** Terminal states: entering one stamps `terminal_at`. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'success',
  'failed',
  'cancelled',
  'requires_manual_recovery',
]);
