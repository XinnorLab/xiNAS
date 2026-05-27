/**
 * Public types for the Phase 0 state store. The KV interface
 * (store.ts) and the SQLite backend (backend-sqlite.ts) share these
 * shapes. The contract is intentionally backend-agnostic so a Phase 2
 * etcd swap (per ADR-0003) does not change call sites.
 */

export type ValidationStatus = 'valid' | 'drift' | 'invalid' | 'pending';

export type ClientType = 'rest' | 'mcp' | 'tui' | 'cli' | 'automation' | 'system';

export interface RevisionedValue<T = unknown> {
  key: string;
  value: T;
  revision: number; // monotonic per key; first write is 1
  created_at: number; // epoch ms; never changes after creation
  modified_at: number; // epoch ms; updated on each put/patch
  owner: string; // principal or source identifier
  source: string; // origin tag, e.g. 'ansible:nfs_server'
  validation_status: ValidationStatus;
}

export interface PutOptions {
  owner?: string;
  source?: string;
  validation_status?: ValidationStatus;
  /**
   * CAS guard. Set to `0` to require "does not exist" (create-only).
   * Set to a revision number to require "current revision matches".
   * Omit to skip the CAS check (last-writer-wins).
   */
  expected_revision?: number;
}

export interface ListOptions {
  prefix?: string; // e.g., '/xinas/v1/desired/Share/'
  limit?: number; // default 1000
  start_after?: string; // pagination cursor (key string)
}

export type CasResult<T = unknown> =
  | { ok: true; value: RevisionedValue<T> }
  | {
      ok: false;
      reason: 'stale_revision' | 'not_found' | 'already_exists';
      current: RevisionedValue<T> | null;
    };

export type DeleteResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'stale_revision' | 'not_found'; current: RevisionedValue | null };

export type WatchEvent =
  | { kind: 'put'; key: string; value: RevisionedValue }
  | { kind: 'delete'; key: string; previous_revision: number };

export interface WatchHandle {
  close(): void;
}

/**
 * Audit entry shape — per phase0-requirements.md §14, every audit
 * record carries the principal, timestamp, controller_id (= node_id
 * in Phase 0), operation/tool name, parameters hash, result hash,
 * request_id, operation_id (if present), and task_id (if present).
 *
 * Required fields are non-optional; payload is free-form.
 */
export interface AuditEntry {
  kind: string; // operation/tool name, e.g. 'share.create'
  timestamp: number; // epoch ms; set by AuditAppender at queue time
  node_id: string; // controller_id; injected by AuditAppender
  principal: string;
  client_type: ClientType;
  request_id: string;
  parameters_hash: string; // sha256 of canonicalized request input
  result_hash: string; // sha256 of canonicalized result; '' on failure
  operation_id?: string;
  task_id?: string;
  state_revision?: number;
  payload?: Record<string, unknown>;
}

/**
 * The subset of AuditEntry that callers provide. AuditAppender fills
 * in `timestamp` and `node_id` so callers don't have to thread them.
 */
export type AuditEntryInput = Omit<AuditEntry, 'timestamp' | 'node_id'>;

export interface QueuedAuditEntry {
  audit_seq: number;
  prev_hash: Buffer;
  hash: Buffer;
}
