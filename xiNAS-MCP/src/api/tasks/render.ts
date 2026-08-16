/**
 * The public Task projection, shared by every read surface.
 *
 * REST (`/tasks`, `/tasks/{id}`, the cancel route), the SSE watch snapshot,
 * and the long-poll all render through here, so a field added to the public
 * Task shape reaches all of them at once. Before S2's progress rollup landed
 * the SSE snapshot hand-copied the raw store row instead — which is exactly
 * how a renderer change could miss a surface.
 */

import {
  ROLLBACK_STAGE,
  SNAPSHOT_AFTER_STAGE,
  SYNTHETIC_STAGE_NAMES,
} from '../../lib/tasks/stage-names.js';
import type { Task, TaskStage } from './types.js';

/** Rolled-up, human-facing view of where a running task is (s2 spec §10.1). */
export interface TaskProgressSummary {
  phase: 'preparing' | 'executing' | 'rolling_back' | 'finalizing' | 'done';
  stage_name?: string;
  stage_status?: string;
  /** Raw emission index — correlates the summary with an entry in `stages[]`. */
  stage_index?: number;
  /** 1-based position among EXECUTOR stages; absent for synthetic rows. */
  stage_position?: number;
  stage_total?: number;
  completed_stages: number;
  elapsed_s: number;
  stage_elapsed_s?: number;
}

const isSynthetic = (s: TaskStage): boolean => SYNTHETIC_STAGE_NAMES.has(s.name);

/**
 * Roll a task's stage rows up into "which stage, how far in, how long".
 *
 * Returns undefined for a `plan_only` task (nothing executes). Counting is done
 * over EXECUTOR stages only — the runner's synthetic snapshot_before /
 * snapshot_after / rollback rows carry emission indices too, so deriving a
 * position from `stage_index` arithmetic would read one too high.
 *
 * No output line is reported: the runner buffers `emitOutput()` and drains it
 * only into the stage's terminal event, so a RUNNING stage's row has none
 * (see docs/TODO.md — intra-stage output is a separate change).
 */
export function taskProgress(
  task: Task,
  now: number = Date.now(),
): TaskProgressSummary | undefined {
  if (task.state === 'plan_only') return undefined;

  const real = task.stages.filter((s) => !isSynthetic(s));
  const completed = real.filter((s) => s.status === 'success').length;
  const terminal = task.terminal_at !== undefined;
  const elapsed_s = Math.round(((task.terminal_at ?? now) - task.created_at) / 1000);

  const base: TaskProgressSummary = {
    phase: terminal ? 'done' : 'preparing',
    completed_stages: completed,
    elapsed_s,
    ...(task.stage_total !== undefined ? { stage_total: task.stage_total } : {}),
  };

  // Current stage: the one still running, else the highest-index row.
  const running = task.stages.find((s) => s.status === 'running');
  const latest = [...task.stages].sort((a, b) => a.stage_index - b.stage_index).at(-1);
  const current = running ?? latest;
  if (current === undefined) return base;

  const phase: TaskProgressSummary['phase'] = terminal
    ? 'done'
    : current.name === ROLLBACK_STAGE
      ? 'rolling_back'
      : current.name === SNAPSHOT_AFTER_STAGE
        ? 'finalizing'
        : isSynthetic(current)
          ? 'preparing'
          : 'executing';

  // 1-based position among executor stages; synthetic rows have none.
  const position = isSynthetic(current)
    ? undefined
    : real.findIndex((s) => s.stage_index === current.stage_index) + 1;

  return {
    ...base,
    phase,
    stage_name: current.name,
    stage_status: current.status,
    stage_index: current.stage_index,
    ...(position !== undefined && position > 0 ? { stage_position: position } : {}),
    ...(current.started_at !== undefined
      ? { stage_elapsed_s: Math.round(((current.ended_at ?? now) - current.started_at) / 1000) }
      : {}),
  };
}

/**
 * Project a store `Task` (epoch-ms timestamps, `output_path`) into the public
 * api-v1.yaml shape: ISO date-time strings, `output_url` for spilled stage
 * output, the `progress` rollup, and the synthesized `metadata` object
 * (s2-task-envelope-spec §10 — the S0/S1 `embedMetadata` fold-in). Tasks live
 * in the SQLite `tasks` table, not as RevisionedValue rows, so there is no KV
 * row tracking to read; the metadata is synthesized from Task fields per §10:
 *   revision        ← last_event_sequence (or 1 — a fresh task has no events)
 *   created_at      ← ISO of created_at
 *   modified_at     ← ISO of updated_at
 *   owner           ← principal
 *   source          ← client_type
 *   validation_status ← 'valid'
 */
export function renderTask(task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...task,
    created_at: new Date(task.created_at).toISOString(),
    updated_at: new Date(task.updated_at).toISOString(),
    stages: task.stages.map((s) => {
      const stage: Record<string, unknown> = {
        ...s,
        ...(s.started_at !== undefined ? { started_at: new Date(s.started_at).toISOString() } : {}),
        ...(s.ended_at !== undefined ? { ended_at: new Date(s.ended_at).toISOString() } : {}),
      };
      // api-v1.yaml renders the relative spill path as `output_url`.
      if (s.output_path !== undefined) {
        stage.output_url = s.output_path;
        delete (stage as { output_path?: unknown }).output_path;
      }
      return stage;
    }),
    metadata: {
      revision: task.last_event_sequence > 0 ? task.last_event_sequence : 1,
      created_at: new Date(task.created_at).toISOString(),
      modified_at: new Date(task.updated_at).toISOString(),
      owner: task.principal,
      source: task.client_type,
      validation_status: 'valid',
    },
  };
  if (task.terminal_at !== undefined) {
    out.terminal_at = new Date(task.terminal_at).toISOString();
  }
  if (task.cancel_requested_at !== undefined) {
    out.cancel_requested_at = new Date(task.cancel_requested_at).toISOString();
  }
  const progress = taskProgress(task);
  if (progress !== undefined) out.progress = progress;
  // `spec`, `plan_binding`, and `desired_rollback` are internal-only columns —
  // none is part of the public Task surface in api-v1.yaml.
  //   - `spec` (migration 003): the raw requester-submitted executor INPUT
  //     (s2-task-envelope-spec §3.1).
  //   - `plan_binding` / `desired_rollback` (S3 N0): the plan's observed-freshness
  //     ref and the prior-value undo set (s3-nfs-executor-spec §5.4).
  // Strip all three so a read endpoint never echoes the operation input, the
  // requester's raw desired payload, or every mutated KV key back over the wire.
  delete out.spec;
  delete out.plan_binding;
  delete out.desired_rollback;
  return out;
}
