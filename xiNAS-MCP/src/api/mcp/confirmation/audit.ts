import { createHash } from 'node:crypto';
import { canonicalize } from '../../../lib/canonical-json.js';
import type { AuditAppender } from '../../../state/audit.js';
import type { ConfirmationRecord } from './types.js';

/** S15 §12.1 — the security events; kinds are `mcp.confirmation.<event>`. */
export type ConfirmationEvent =
  | 'requested'
  | 'reissued'
  | 'viewed'
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'break_glass_used' // a uds_break_glass decision — only with allow_uds_approval: true
  | 'verification_failed'
  | 'replay_rejected'
  | 'capability_missing'
  | 'consumed'
  | 'apply_task_created';

export interface ConfirmationEventExtra {
  /** Who acted when it is not the record's principal (approver, viewer). */
  actor?: string;
  actor_client_type?: 'rest' | 'mcp';
  task_id?: string;
  reason?: string;
  /** Free-form, never secrets: round numbers, channels, the OTHER principal on a replay. */
  detail?: Record<string, unknown>;
}

/**
 * Queue one lifecycle row. Safe inside a db.transaction (AuditAppender is
 * built for it) and outside (its own implicit transaction). Never includes
 * a requestState, a MAC, a token or plan content — only ids, hashes,
 * principals and reason codes.
 */
export function queueConfirmationEvent(
  audit: AuditAppender | undefined,
  event: ConfirmationEvent,
  record: ConfirmationRecord,
  extra: ConfirmationEventExtra = {},
): void {
  if (audit === undefined) return;
  const payload: Record<string, unknown> = {
    confirmation_id: record.confirmation_id,
    plan_id: record.plan_id,
    plan_hash: record.plan_hash,
    plan_document_hash: record.plan_document_hash,
    arguments_hash: record.arguments_hash,
    principal: record.principal,
    operation_kind: record.operation_kind,
    tool_name: record.tool_name,
    risk_level: record.risk_level,
    mode: record.mode,
    status: record.status,
    round: record.round,
    correlation_id: record.correlation_id,
    ...(extra.actor !== undefined ? { approver: extra.actor } : {}),
    ...(extra.task_id !== undefined ? { task_id: extra.task_id } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
  };
  audit.queue({
    kind: `mcp.confirmation.${event}`,
    principal: extra.actor ?? record.principal,
    client_type: extra.actor_client_type ?? 'mcp',
    request_id: record.request_id,
    parameters_hash: `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`,
    result_hash: `sha256:${createHash('sha256').update(event).digest('hex')}`,
    operation_id: record.confirmation_id,
    ...(extra.task_id !== undefined ? { task_id: extra.task_id } : {}),
    payload,
  });
}
