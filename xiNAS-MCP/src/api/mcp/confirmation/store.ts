import { randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import type {
  ApprovalChannel,
  ApprovalInterface,
  ConfirmationMode,
  ConfirmationRecord,
  ConfirmationStatus,
  ExpiredReason,
} from './types.js';
import { TERMINAL_CONFIRMATION_STATUSES } from './types.js';

export interface ConfirmationStoreDeps {
  db: Database;
  now: () => number;
  /** 16 random bytes, base64url (22 chars) — the URL path segment. */
  newId?: () => string;
}

export interface CreateConfirmationInput {
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
  ttl_ms: number;
  correlation_id: string;
  request_id: string;
  node_id: string;
}

export interface BindingKey {
  principal: string;
  tool_name: string;
  arguments_hash: string;
  plan_id: string;
  idempotency_key: string;
  expected_revision: number;
}

export interface ConfirmationListFilter {
  status?: ConfirmationStatus;
  principal?: string;
  limit?: number;
}

const COLUMNS = `confirmation_id, status, mode, principal, role, tool_name, operation_kind,
  arguments_hash, plan_id, plan_hash, plan_document_hash, idempotency_key, expected_revision,
  risk_level, rollback_model, request_state_nonce_hash, round, created_at, expires_at,
  approved_at, approved_by, approval_channel, approval_interface, declined_at, declined_by, decision_reason,
  consumed_at, consumed_task_id, expired_reason, correlation_id, request_id, node_id`;

type Row = Record<string, unknown>;

/**
 * Prepared-statement CRUD over mcp_confirmations (S15 §6). Same pattern as
 * TaskStore: injected clock and id generator; every status change is a
 * guarded UPDATE so a terminal row can never move again and a race between
 * two writers is decided by `changes()`.
 */
export class ConfirmationStore {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly insertStmt: Statement;
  private readonly getStmt: Statement;
  private readonly findOpenStmt: Statement;
  private readonly countOpenStmt: Statement;
  private readonly countOpenByPrincipalStmt: Statement;
  private readonly countPendingByModeStmt: Statement;
  private readonly reissueStmt: Statement;
  private readonly approveStmt: Statement;
  private readonly declineStmt: Statement;
  private readonly cancelStmt: Statement;
  private readonly expireStmt: Statement;
  private readonly consumeStmt: Statement;
  private readonly expiredCandidatesStmt: Statement;
  private readonly pruneStmt: Statement;

  constructor(deps: ConfirmationStoreDeps) {
    this.db = deps.db;
    this.now = deps.now;
    this.newId = deps.newId ?? (() => randomBytes(16).toString('base64url'));
    const db = deps.db;
    this.insertStmt = db.prepare(
      `INSERT INTO mcp_confirmations (${COLUMNS}) VALUES (
        @confirmation_id, 'pending', @mode, @principal, @role, @tool_name, @operation_kind,
        @arguments_hash, @plan_id, @plan_hash, @plan_document_hash, @idempotency_key, @expected_revision,
        @risk_level, @rollback_model, @request_state_nonce_hash, 1, @created_at, @expires_at,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, @correlation_id, @request_id, @node_id)`,
    );
    this.countPendingByModeStmt = db.prepare(
      `SELECT mode, COUNT(*) AS n FROM mcp_confirmations
        WHERE status IN ('pending','approved') AND expires_at > @now GROUP BY mode`,
    );
    this.getStmt = db.prepare(`SELECT ${COLUMNS} FROM mcp_confirmations WHERE confirmation_id = ?`);
    this.findOpenStmt = db.prepare(
      `SELECT ${COLUMNS} FROM mcp_confirmations
        WHERE status IN ('pending','approved') AND principal = @principal AND tool_name = @tool_name
          AND arguments_hash = @arguments_hash AND plan_id = @plan_id
          AND idempotency_key = @idempotency_key AND expected_revision = @expected_revision
          AND expires_at > @now
        ORDER BY created_at DESC, confirmation_id DESC LIMIT 1`,
    );
    this.countOpenStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM mcp_confirmations WHERE status IN ('pending','approved') AND expires_at > @now`,
    );
    this.countOpenByPrincipalStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM mcp_confirmations
        WHERE status IN ('pending','approved') AND principal = @principal AND expires_at > @now`,
    );
    this.reissueStmt = db.prepare(
      `UPDATE mcp_confirmations SET round = round + 1, request_state_nonce_hash = @nonce
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.approveStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'approved', approved_at = @now, approved_by = @by,
          approval_channel = @channel, approval_interface = @iface, decision_reason = @reason
        WHERE confirmation_id = @id AND status = 'pending'`,
    );
    this.declineStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'declined', declined_at = @now, declined_by = @by,
          approval_channel = COALESCE(approval_channel, @channel),
          approval_interface = COALESCE(approval_interface, @iface), decision_reason = @reason
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.cancelStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'cancelled', declined_at = @now, declined_by = @by
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.expireStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'expired', expired_reason = @reason
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.consumeStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'consumed', consumed_at = @now, consumed_task_id = @task_id,
          approved_at = COALESCE(approved_at, @now), approved_by = COALESCE(approved_by, @principal),
          approval_channel = COALESCE(approval_channel, 'mcp_form')
        WHERE confirmation_id = @id AND status = @from AND expires_at > @now
          AND mode = CASE @from WHEN 'pending' THEN 'form' ELSE 'url' END`,
    );
    this.expiredCandidatesStmt = db.prepare(
      `SELECT ${COLUMNS} FROM mcp_confirmations
        WHERE status IN ('pending','approved') AND expires_at <= ? ORDER BY expires_at ASC`,
    );
    const terminalStatusList = Array.from(TERMINAL_CONFIRMATION_STATUSES)
      .map((status) => `'${status}'`)
      .join(', ');
    this.pruneStmt = db.prepare(
      `DELETE FROM mcp_confirmations
        WHERE status IN (${terminalStatusList}) AND created_at < ?`,
    );
  }

  create(input: CreateConfirmationInput): ConfirmationRecord {
    const created_at = this.now();
    const confirmation_id = this.newId();
    this.insertStmt.run({
      ...input,
      confirmation_id,
      created_at,
      expires_at: created_at + input.ttl_ms,
    });
    return this.get(confirmation_id) as ConfirmationRecord;
  }

  get(id: string): ConfirmationRecord | null {
    const row = this.getStmt.get(id) as Row | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  list(filter: ConfirmationListFilter): ConfirmationRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit ?? 100 };
    if (filter.status !== undefined) {
      clauses.push('status = @status');
      params.status = filter.status;
    }
    if (filter.principal !== undefined) {
      clauses.push('principal = @principal');
      params.principal = filter.principal;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM mcp_confirmations ${where} ORDER BY created_at DESC, confirmation_id DESC LIMIT @limit`,
      )
      .all(params) as Row[];
    return rows.map(rowToRecord);
  }

  /** Expiry is checked inline (`expires_at > now`) so a request racing the 30s sweep sees the same answer (S15 §6.3). */
  findOpenByBindings(key: BindingKey): ConfirmationRecord | null {
    const row = this.findOpenStmt.get({ ...key, now: this.now() }) as Row | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  /** Expiry is checked inline (`expires_at > now`), same rationale as findOpenByBindings. */
  countOpen(principal?: string): number {
    const now = this.now();
    const row = (
      principal === undefined
        ? this.countOpenStmt.get({ now })
        : this.countOpenByPrincipalStmt.get({ principal, now })
    ) as { n: number };
    return row.n;
  }

  reissue(id: string, nonce: string): ConfirmationRecord | null {
    return this.reissueStmt.run({ id, nonce }).changes === 1 ? this.get(id) : null;
  }

  approve(
    id: string,
    by: string,
    channel: ApprovalChannel,
    iface?: ApprovalInterface,
    reason?: string,
  ): ConfirmationRecord | null {
    const info = this.approveStmt.run({
      id,
      by,
      channel,
      iface: iface ?? null,
      reason: reason ?? null,
      now: this.now(),
    });
    return info.changes === 1 ? this.get(id) : null;
  }

  decline(
    id: string,
    by: string,
    channel: ApprovalChannel,
    iface?: ApprovalInterface,
    reason?: string,
  ): ConfirmationRecord | null {
    const info = this.declineStmt.run({
      id,
      by,
      channel,
      iface: iface ?? null,
      reason: reason ?? null,
      now: this.now(),
    });
    return info.changes === 1 ? this.get(id) : null;
  }

  /**
   * Scrape-time source for the pending gauge (S15 §12.2): open rows per mode.
   * Expiry is checked inline so the gauge and the sweeper always agree.
   */
  countPendingByMode(): { form: number; url: number } {
    const out = { form: 0, url: 0 };
    for (const row of this.countPendingByModeStmt.all({ now: this.now() }) as Array<{
      mode: 'form' | 'url';
      n: number;
    }>) {
      out[row.mode] = row.n;
    }
    return out;
  }

  cancel(id: string, by: string): ConfirmationRecord | null {
    return this.cancelStmt.run({ id, by, now: this.now() }).changes === 1 ? this.get(id) : null;
  }

  expire(id: string, reason: ExpiredReason): ConfirmationRecord | null {
    return this.expireStmt.run({ id, reason }).changes === 1 ? this.get(id) : null;
  }

  /** The single guarded consume (S15 §8.3 step 8). Runs inside the caller's transaction. */
  consume(args: {
    confirmation_id: string;
    task_id: string;
    from: 'pending' | 'approved';
    principal: string;
    now: number;
  }): boolean {
    return (
      this.consumeStmt.run({
        id: args.confirmation_id,
        task_id: args.task_id,
        from: args.from,
        principal: args.principal,
        now: args.now,
      }).changes === 1
    );
  }

  /**
   * One transaction for the whole sweep (better-sqlite3 nests as a
   * savepoint when the caller is already inside a transaction): a throw
   * mid-sweep leaves no partial sweep, and the returned array is exactly
   * the set expired.
   */
  sweepExpired(now: number, reason: 'ttl' | 'restart_sweep'): ConfirmationRecord[] {
    const sweep = this.db.transaction((): ConfirmationRecord[] => {
      const rows = (this.expiredCandidatesStmt.all(now) as Row[]).map(rowToRecord);
      const out: ConfirmationRecord[] = [];
      for (const r of rows) {
        const expired = this.expire(r.confirmation_id, reason);
        if (expired !== null) out.push(expired);
      }
      return out;
    });
    return sweep();
  }

  pruneTerminal(cutoffMs: number): number {
    return this.pruneStmt.run(cutoffMs).changes;
  }
}

function rowToRecord(row: Row): ConfirmationRecord {
  const opt = <T>(k: string): { [key: string]: T } | Record<string, never> =>
    row[k] === null || row[k] === undefined ? {} : { [k]: row[k] as T };
  return {
    confirmation_id: row.confirmation_id as string,
    status: row.status as ConfirmationStatus,
    mode: row.mode as ConfirmationMode,
    principal: row.principal as string,
    role: row.role as string,
    tool_name: row.tool_name as string,
    operation_kind: row.operation_kind as string,
    arguments_hash: row.arguments_hash as string,
    plan_id: row.plan_id as string,
    plan_hash: row.plan_hash as string,
    plan_document_hash: row.plan_document_hash as string,
    idempotency_key: row.idempotency_key as string,
    expected_revision: row.expected_revision as number,
    risk_level: row.risk_level as string,
    rollback_model: row.rollback_model as string,
    request_state_nonce_hash: row.request_state_nonce_hash as string,
    round: row.round as number,
    created_at: row.created_at as number,
    expires_at: row.expires_at as number,
    correlation_id: row.correlation_id as string,
    request_id: row.request_id as string,
    node_id: row.node_id as string,
    ...opt<number>('approved_at'),
    ...opt<string>('approved_by'),
    ...opt<ApprovalChannel>('approval_channel'),
    ...opt<ApprovalInterface>('approval_interface'),
    ...opt<number>('declined_at'),
    ...opt<string>('declined_by'),
    ...opt<string>('decision_reason'),
    ...opt<number>('consumed_at'),
    ...opt<string>('consumed_task_id'),
    ...opt<ExpiredReason>('expired_reason'),
  } as ConfirmationRecord;
}
