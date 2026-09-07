/**
 * The S16 task-method service (spec §7, §10, §13): ownership-bound reads,
 * the no-op update acknowledgement, the cancel adapter over the shared
 * core (through the `tasks.cancel` tool closure the caller supplies), and
 * the post-apply handle projection. Stateless; every check runs per call.
 */
import type { AuditAppender } from '../../../state/audit.js';
import type { Task } from '../../tasks/types.js';
import { ROLE_RANK } from '../catalog.js';
import { INVALID_PARAMS, McpProtocolError } from '../confirmation/errors.js';
import type { McpIdentity } from '../dispatch.js';
import type { CreateTaskToolResult, ToolResult } from '../results.js';
import { queueTaskEvent, queueTaskReadDenied } from './audit.js';
import { type TasksMetrics, noopTasksMetrics } from './metrics.js';
import {
  type McpDetailedTask,
  TASK_NOT_FOUND_MESSAGE,
  createTaskResultFor,
  mcpStatusFor,
  projectTask,
} from './projection.js';

export interface McpTasksServiceDeps {
  store: { get(taskId: string): Task | null };
  retentionMs: number;
  audit?: AuditAppender;
  metrics?: TasksMetrics;
  now?: () => number;
}
export interface TaskMethodContext {
  identity: McpIdentity;
  correlationId: string;
}
export interface AckResult {
  resultType: 'complete';
}
export type GetTaskResult = McpDetailedTask & { resultType: 'complete' };
type TaskMethod = 'tasks/get' | 'tasks/update' | 'tasks/cancel';
type DenyReason = 'unknown_or_pruned' | 'not_projectable' | 'not_owner' | 'role';

export function taskNotFound(): McpProtocolError {
  return new McpProtocolError(INVALID_PARAMS, TASK_NOT_FOUND_MESSAGE, {
    reasonClass: 'task_not_found',
  });
}

export type CancelOutcome =
  | { kind: 'accepted' }
  | { kind: 'refused'; reason: string }
  | { kind: 'irreversible'; stage?: string }
  | { kind: 'undelivered'; reason: string }
  | { kind: 'not_found' }
  | { kind: 'permission_denied' };

/** Map the `tasks.cancel` tool result (§10.2) to the protocol outcome. */
export function classifyCancelResult(result: ToolResult): CancelOutcome {
  if (result.isError !== true) return { kind: 'accepted' };
  let parsed: {
    error?: { code?: string; details?: { reason?: string; code?: string; stage?: string } };
  } = {};
  try {
    parsed = JSON.parse(result.content[0]?.text ?? '{}') as typeof parsed;
  } catch {
    /* fall through: treated as undelivered */
  }
  const code = parsed.error?.code;
  const details = parsed.error?.details ?? {};
  if (code === 'NOT_FOUND') return { kind: 'not_found' };
  if (code === 'PERMISSION_DENIED') return { kind: 'permission_denied' };
  if (code === 'CONFLICT' && details.reason === 'irreversible_stage_started') {
    return {
      kind: 'irreversible',
      ...(typeof details.stage === 'string' ? { stage: details.stage } : {}),
    };
  }
  if (code === 'CONFLICT') return { kind: 'refused', reason: details.reason ?? 'conflict' };
  return { kind: 'undelivered', reason: details.code ?? code ?? 'unknown' };
}

export class McpTasksService {
  private readonly store: McpTasksServiceDeps['store'];
  private readonly retentionMs: number;
  private readonly audit: AuditAppender | undefined;
  private readonly metrics: TasksMetrics;
  private readonly now: () => number;

  constructor(deps: McpTasksServiceDeps) {
    this.store = deps.store;
    this.retentionMs = deps.retentionMs;
    this.audit = deps.audit;
    this.metrics = deps.metrics ?? noopTasksMetrics;
    this.now = deps.now ?? (() => Date.now());
  }

  get(taskId: string, ctx: TaskMethodContext): GetTaskResult {
    const task = this.authorize(taskId, ctx, 'tasks/get');
    const projected = projectTask(task, { now: this.now(), retentionMs: this.retentionMs });
    if (projected === null) this.deny(taskId, ctx, 'tasks/get', 'not_projectable');
    this.metrics.methodCall('tasks/get', 'ok');
    if (projected.status !== 'working') this.metrics.terminalProjected(task.state);
    return { resultType: 'complete', ...projected };
  }

  update(
    taskId: string,
    inputResponses: Record<string, Record<string, unknown>>,
    ctx: TaskMethodContext,
  ): AckResult {
    const task = this.authorize(taskId, ctx, 'tasks/update');
    queueTaskEvent(this.audit, 'update_accepted', {
      task,
      principal: ctx.identity.principal,
      correlation_id: ctx.correlationId,
      detail: { response_keys: Object.keys(inputResponses).sort() },
    });
    this.metrics.methodCall('tasks/update', 'ok');
    return { resultType: 'complete' };
  }

  async cancel(
    taskId: string,
    ctx: TaskMethodContext,
    cancelTool: () => Promise<ToolResult>,
  ): Promise<AckResult> {
    const task = this.authorize(taskId, ctx, 'tasks/cancel');
    const outcome = classifyCancelResult(await cancelTool());
    const common = { task, principal: ctx.identity.principal, correlation_id: ctx.correlationId };
    switch (outcome.kind) {
      case 'not_found':
        this.deny(taskId, ctx, 'tasks/cancel', 'unknown_or_pruned');
        break;
      case 'permission_denied':
        this.deny(taskId, ctx, 'tasks/cancel', 'role');
        break;
      case 'irreversible':
        queueTaskEvent(this.audit, 'cancel_refused_irreversible', {
          ...common,
          detail: { ...(outcome.stage !== undefined ? { stage: outcome.stage } : {}) },
        });
        this.metrics.cancelRefusedIrreversible();
        break;
      case 'accepted':
        queueTaskEvent(this.audit, 'cancel_requested', {
          ...common,
          detail: { outcome: 'accepted' },
        });
        this.metrics.cancelRequested('accepted');
        break;
      default:
        queueTaskEvent(this.audit, 'cancel_requested', {
          ...common,
          detail: { outcome: outcome.kind, reason: outcome.reason },
        });
        this.metrics.cancelRequested(outcome.kind);
    }
    this.metrics.methodCall('tasks/cancel', 'ok');
    return { resultType: 'complete' };
  }

  /** Post-apply projection (§4.2 step 6–7): null → the dispatcher falls back. */
  handleFor(
    taskId: string,
    ctx: TaskMethodContext,
    extra: { tool_name: string; warnings?: unknown[] },
  ): CreateTaskToolResult | null {
    const task = this.store.get(taskId);
    if (task === null || task.principal !== ctx.identity.principal) return null;
    const handle = createTaskResultFor(
      task,
      { now: this.now(), retentionMs: this.retentionMs },
      extra.warnings,
    );
    if (handle === null) return null;
    queueTaskEvent(this.audit, 'handle_returned', {
      task,
      principal: ctx.identity.principal,
      correlation_id: ctx.correlationId,
      tool_name: extra.tool_name,
      detail: { state: task.state, status: handle.status },
    });
    this.metrics.handleReturned(task.kind);
    return handle;
  }

  private authorize(taskId: string, ctx: TaskMethodContext, method: TaskMethod): Task {
    const task = this.store.get(taskId);
    if (task === null) this.deny(taskId, ctx, method, 'unknown_or_pruned');
    if (mcpStatusFor(task.state) === null) this.deny(taskId, ctx, method, 'not_projectable');
    if (method === 'tasks/cancel' && ROLE_RANK[ctx.identity.role] < ROLE_RANK.operator) {
      this.deny(taskId, ctx, method, 'role');
    }
    if (task.principal !== ctx.identity.principal) this.deny(taskId, ctx, method, 'not_owner');
    return task;
  }

  private deny(
    taskId: string,
    ctx: TaskMethodContext,
    method: TaskMethod,
    reason: DenyReason,
  ): never {
    queueTaskReadDenied(this.audit, {
      task_id: taskId,
      requested_by: ctx.identity.principal,
      correlation_id: ctx.correlationId,
      reason,
      method,
    });
    this.metrics.methodCall(method, 'protocol_error');
    throw taskNotFound();
  }
}
