/**
 * xiNAS Task → MCP Task projection (S16 §6). Pure functions over the STORE
 * row (epoch-ms) — the one source for CreateTaskResult and tasks/get.
 * No writes, no state, no percentage, ever.
 */
import {
  IRREVERSIBLE_STAGE_BY_KIND,
  IRREVERSIBLE_STAGE_VERB,
  LONG_STAGE_BY_KIND,
  LONG_STAGE_NOTE,
} from '../../../lib/tasks/irreversible-stages.js';
import { SYNTHETIC_STAGE_NAMES } from '../../../lib/tasks/stage-names.js';
import { renderTask, taskProgress } from '../../tasks/render.js';
import type { Task, TaskState } from '../../tasks/types.js';
import { type CreateTaskToolResult, type ToolResult, text } from '../results.js';

export type McpTaskStatus = 'working' | 'completed' | 'cancelled';
export interface ProjectionOptions {
  now: number;
  retentionMs: number;
}
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const LONG_STAGE_POLL_INTERVAL_MS = 5000;
export const TASK_NOT_FOUND_MESSAGE = 'task not found or expired';
const MESSAGE_ERROR_MAX = 200;

export function mcpStatusFor(state: TaskState): McpTaskStatus | null {
  switch (state) {
    case 'queued':
    case 'running':
      return 'working';
    case 'success':
    case 'failed':
    case 'requires_manual_recovery':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** True once the kind's irreversible stage has a row (started) or the core recorded the refusal. */
function pastPointOfNoReturn(task: Task): boolean {
  if (task.cancel_refused_reason === 'irreversible_stage_started') return true;
  const stageName = IRREVERSIBLE_STAGE_BY_KIND[task.kind];
  if (stageName === undefined) return false;
  return task.stages.some(
    (s) => s.name === stageName && s.status !== 'pending' && s.status !== 'skipped',
  );
}

export function statusMessageFor(task: Task, now: number): string {
  const kind = task.kind;
  const progress = taskProgress(task, now);
  const elapsed = formatElapsed(progress?.elapsed_s ?? 0);
  const errTail =
    task.error_message !== undefined ? `: ${task.error_message.slice(0, MESSAGE_ERROR_MAX)}` : '';
  switch (task.state) {
    case 'queued':
      return `${kind}: queued, waiting for an executor slot; elapsed ${elapsed}`;
    case 'running': {
      const parts: string[] = [];
      switch (progress?.phase) {
        case 'executing': {
          const pos =
            progress.stage_position !== undefined && progress.stage_total !== undefined
              ? ` (${progress.stage_position} of ${progress.stage_total})`
              : '';
          const stageT =
            progress.stage_elapsed_s !== undefined
              ? ` running for ${formatElapsed(progress.stage_elapsed_s)}`
              : '';
          parts.push(
            `${kind}: stage '${progress.stage_name ?? '?'}'${pos}${stageT}; elapsed ${elapsed}`,
          );
          const note = LONG_STAGE_NOTE[kind];
          if (note !== undefined && LONG_STAGE_BY_KIND[kind] === progress.stage_name)
            parts.push(note);
          break;
        }
        case 'rolling_back': {
          const failed = [...task.stages]
            .filter((s) => s.status === 'failed' && !SYNTHETIC_STAGE_NAMES.has(s.name))
            .at(-1);
          parts.push(
            `${kind}: rolling back${failed !== undefined ? ` after stage '${failed.name}'` : ''}; elapsed ${elapsed}`,
          );
          break;
        }
        case 'finalizing':
          parts.push(`${kind}: finalizing (snapshot after change); elapsed ${elapsed}`);
          break;
        default:
          parts.push(`${kind}: preparing (snapshot before change); elapsed ${elapsed}`);
      }
      if (pastPointOfNoReturn(task)) {
        parts.push(
          `cancellation can no longer safely stop ${IRREVERSIBLE_STAGE_VERB[kind] ?? 'the operation'}`,
        );
      } else if (task.cancel_requested_at !== undefined) {
        parts.push('cancellation requested, stopping at the next safe point');
      }
      return parts.join('; ');
    }
    case 'success':
      return `${kind}: succeeded in ${elapsed}`;
    case 'failed':
      return `${kind}: failed (${task.error_code ?? 'FAILED'}) after ${elapsed}${errTail}`;
    case 'requires_manual_recovery':
      return `${kind}: requires manual recovery (${task.error_code ?? 'FAILED_MANUAL_RECOVERY_REQUIRED'}) after ${elapsed}${errTail}`;
    case 'cancelled':
      return `${kind}: cancelled at a safe point after ${elapsed}; partial work rolled back`;
    default:
      return `${kind}: ${task.state}`;
  }
}

export function pollIntervalFor(task: Task, now: number = Date.now()): number | undefined {
  if (mcpStatusFor(task.state) !== 'working') return undefined;
  const progress = taskProgress(task, now);
  const long = LONG_STAGE_BY_KIND[task.kind];
  if (
    task.state === 'running' &&
    long !== undefined &&
    progress?.phase === 'executing' &&
    progress.stage_status === 'running' &&
    progress.stage_name === long
  ) {
    return LONG_STAGE_POLL_INTERVAL_MS;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

export function ttlMsFor(task: Task, retentionMs: number): number | null {
  if (task.terminal_at === undefined) return null;
  return Math.max(0, task.terminal_at - task.created_at) + retentionMs;
}

/** renderTask() minus the S15 plan document and the local spill path (§6.6). */
export function publicTaskForMcp(task: Task): Record<string, unknown> {
  const rendered = renderTask(task);
  delete rendered.plan_document;
  delete rendered.plan_document_hash;
  rendered.stages = (rendered.stages as Array<Record<string, unknown>>).map((s) => {
    const { output_url: _omit, ...rest } = s;
    return rest;
  });
  return rendered;
}

function deviceFromMkfsOutput(output: string | undefined): string | undefined {
  const line = output?.split('\n').find((l) => l.startsWith('mkfs.xfs '));
  const last = line?.trim().split(/\s+/).at(-1);
  return last !== undefined && last.startsWith('/dev/') ? last : undefined;
}

export function residualNoteFor(task: Task): string | undefined {
  if (task.state !== 'failed' && task.state !== 'requires_manual_recovery') return undefined;
  const stageName = IRREVERSIBLE_STAGE_BY_KIND[task.kind];
  if (stageName === undefined) return undefined;
  const row = task.stages.find((s) => s.name === stageName && s.status === 'success');
  if (row === undefined) return undefined;
  const device = deviceFromMkfsOutput(row.output_inline);
  const subject = device !== undefined ? device : 'the target device';
  return (
    `stage '${stageName}' completed before the failure and its effect was not undone: ` +
    `${subject} may carry an unmanaged XFS filesystem. Re-observe first (filesystems.list, ` +
    'disks.list, blkid on the device) and decide from the observation; do not reformat the device blindly.'
  );
}

export function terminalResultFor(task: Task): ToolResult {
  const residual = residualNoteFor(task);
  const result = text({
    result: publicTaskForMcp(task),
    ...(residual !== undefined ? { residual } : {}),
  });
  if (task.state === 'failed' || task.state === 'requires_manual_recovery') result.isError = true;
  return result;
}

export interface McpTaskBase {
  taskId: string;
  status: McpTaskStatus;
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}
export type McpDetailedTask =
  | (McpTaskBase & { status: 'working' })
  | (McpTaskBase & { status: 'completed'; result: ToolResult })
  | (McpTaskBase & { status: 'cancelled' });

function baseFor(task: Task, status: McpTaskStatus, opts: ProjectionOptions): McpTaskBase {
  const poll = pollIntervalFor(task, opts.now);
  return {
    taskId: task.task_id,
    status,
    statusMessage: statusMessageFor(task, opts.now),
    createdAt: new Date(task.created_at).toISOString(),
    lastUpdatedAt: new Date(task.updated_at).toISOString(),
    ttlMs: ttlMsFor(task, opts.retentionMs),
    ...(poll !== undefined ? { pollIntervalMs: poll } : {}),
  };
}

export function projectTask(task: Task, opts: ProjectionOptions): McpDetailedTask | null {
  const status = mcpStatusFor(task.state);
  if (status === null) return null;
  const base = baseFor(task, status, opts);
  if (status === 'completed') return { ...base, status, result: terminalResultFor(task) };
  if (status === 'cancelled') return { ...base, status };
  return { ...base, status };
}

export function createTaskResultFor(
  task: Task,
  opts: ProjectionOptions,
  warnings?: unknown[],
): CreateTaskToolResult | null {
  const status = mcpStatusFor(task.state);
  if (status === null) return null;
  return {
    resultType: 'task',
    ...baseFor(task, status, opts),
    // Review F2: forward REST envelope warnings (e.g. EXECUTOR_DEGRADED) so
    // clients on the task-handle path see them too, instead of only the
    // clients that get the plain `text({ result, warnings })` fallback.
    ...(warnings !== undefined && warnings.length > 0
      ? { _meta: { 'io.xinas/warnings': warnings } }
      : {}),
  };
}
