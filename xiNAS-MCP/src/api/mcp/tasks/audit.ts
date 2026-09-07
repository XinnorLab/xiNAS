import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '../../../lib/canonical-json.js';
import type { AuditAppender } from '../../../state/audit.js';
import { MCP_TASK_PRUNED_KIND } from '../../../state/gc.js';
import type { Task } from '../../tasks/types.js';

export { MCP_TASK_PRUNED_KIND };

/** S16 §13.1 — kinds are `mcp.task.<event>`; `pruned` is written by the GC. */
export type TaskEvent =
  | 'handle_returned'
  | 'update_accepted'
  | 'cancel_requested'
  | 'cancel_refused_irreversible';

const hash = (v: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalize(v)).digest('hex')}`;

/** A lifecycle row for a task the caller OWNS (task metadata may be recorded). */
export function queueTaskEvent(
  audit: AuditAppender | undefined,
  event: TaskEvent,
  input: {
    task: Task;
    principal: string;
    correlation_id: string;
    tool_name?: string;
    detail?: Record<string, unknown>;
  },
): void {
  if (audit === undefined) return;
  const payload: Record<string, unknown> = {
    task_id: input.task.task_id,
    kind: input.task.kind,
    principal: input.principal,
    correlation_id: input.correlation_id,
    ...(input.tool_name !== undefined ? { tool_name: input.tool_name } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
  audit.queue({
    kind: `mcp.task.${event}`,
    principal: input.principal,
    client_type: 'mcp',
    request_id: randomUUID(),
    parameters_hash: hash(payload),
    result_hash: `sha256:${createHash('sha256').update(event).digest('hex')}`,
    operation_id: input.task.task_id,
    task_id: input.task.task_id,
    payload,
  });
}

/** A refusal row: only the caller-supplied id and the caller — never the task's owner, kind or state. */
export function queueTaskReadDenied(
  audit: AuditAppender | undefined,
  input: {
    task_id: string;
    requested_by: string;
    correlation_id: string;
    reason: string;
    method: string;
  },
): void {
  if (audit === undefined) return;
  const payload = { ...input };
  audit.queue({
    kind: 'mcp.task.read_denied',
    principal: input.requested_by,
    client_type: 'mcp',
    request_id: randomUUID(),
    parameters_hash: hash(payload),
    result_hash: `sha256:${createHash('sha256').update('read_denied').digest('hex')}`,
    operation_id: input.task_id,
    task_id: input.task_id,
    payload,
  });
}
