export type ConfirmationStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'consumed';
export type ConfirmationMode = 'form' | 'url';
/** VERIFIED authentication channel of the deciding request — from the auth verdict, never a header. */
export type ApprovalChannel = 'mcp_form' | 'bearer' | 'uds_break_glass';
/** UNTRUSTED UI label self-reported via X-Xinas-Approval-Interface; consulted by nothing. */
export type ApprovalInterface = 'web' | 'rest';
export type ExpiredReason =
  | 'ttl'
  | 'round_limit'
  | 'plan_stale'
  | 'revision_changed'
  | 'restart_sweep';

export const MAX_ROUNDS = 3;
export const REQUEST_KEY = 'confirm_apply';
export const ACK_DATA_LOSS = 'DATA MAY BE PERMANENTLY LOST';
export const ACK_NO_ROLLBACK = 'ROLLBACK IS NOT SUPPORTED';
export const TERMINAL_CONFIRMATION_STATUSES: ReadonlySet<ConfirmationStatus> = new Set([
  'declined',
  'cancelled',
  'expired',
  'consumed',
]);

/** One row of mcp_confirmations (S15 §6.1). Epoch-ms timestamps; NULL columns are absent. */
export interface ConfirmationRecord {
  confirmation_id: string;
  status: ConfirmationStatus;
  mode: ConfirmationMode;
  principal: string;
  role: string;
  tool_name: string;
  operation_kind: string;
  arguments_hash: string;
  plan_id: string;
  plan_hash: string;
  plan_document_hash: string;
  idempotency_key: string;
  expected_revision: number;
  risk_level: string;
  rollback_model: string;
  request_state_nonce_hash: string;
  round: number;
  created_at: number;
  expires_at: number;
  approved_at?: number;
  approved_by?: string;
  approval_channel?: ApprovalChannel;
  approval_interface?: ApprovalInterface;
  declined_at?: number;
  declined_by?: string;
  decision_reason?: string;
  consumed_at?: number;
  consumed_task_id?: string;
  expired_reason?: ExpiredReason;
  correlation_id: string;
  request_id: string;
  node_id: string;
}
