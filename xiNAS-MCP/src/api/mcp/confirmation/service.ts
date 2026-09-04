import { randomUUID } from 'node:crypto';
import type { AuditAppender } from '../../../state/audit.js';
import type { ResolvedConfirmationConfig } from '../../config.js';
import { planDocumentHash } from '../../plan/document.js';
import type { PlanDocument } from '../../plan/document.js';
import type { TaskStore } from '../../tasks/store.js';
import { type CatalogEntry, ROLE_RANK } from '../catalog.js';
import type { McpIdentity } from '../dispatch.js';
import { type InputRequiredToolResult, type ToolResult, errorResult } from '../results.js';
import { queueConfirmationEvent, queueConfirmationEventRaw } from './audit.js';
import {
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  McpProtocolError,
  invalidRequestState,
} from './errors.js';
import { renderConfirmationMessage } from './message.js';
import { type ConfirmationMetrics, noopMetrics } from './metrics.js';
import {
  type ElicitationMode,
  type MrtrParams,
  argumentsHash,
  confirmationModeFor,
} from './policy.js';
import {
  type KeyRing,
  type RequestStatePayload,
  mintRequestState,
  newNonce,
  nonceHash,
  verifyRequestState,
} from './state.js';
import type { BindingKey, ConfirmationStore } from './store.js';
import {
  type ConfirmationMode,
  type ConfirmationRecord,
  MAX_ROUNDS,
  REQUEST_KEY,
} from './types.js';

export interface McpClientInfo {
  era: 'legacy' | 'modern';
  elicitation: Set<ElicitationMode>;
}

export interface ConfirmationServiceDeps {
  store: ConfirmationStore;
  tasks: TaskStore;
  keyRing: KeyRing;
  config: ResolvedConfirmationConfig;
  now: () => number;
  nodeId: string;
  hostname: string;
  audit?: AuditAppender;
  metrics?: ConfirmationMetrics;
  sleep?: (ms: number) => Promise<void>;
}

export interface HandleInput {
  entry: CatalogEntry;
  args: Record<string, unknown>;
  identity: McpIdentity;
  client: McpClientInfo;
  mrtr?: MrtrParams;
  correlationId: string;
}

export type HandleOutcome =
  | { kind: 'proceed'; confirmation_id: string }
  | { kind: 'input_required'; result: InputRequiredToolResult }
  | { kind: 'error'; result: ToolResult };

const MAX_WAITERS_PER_CONFIRMATION = 4;
const MAX_WAITERS_TOTAL = 32;
const WAIT_POLL_MS = 250;
const URL_MESSAGE =
  'This destructive xiNAS operation requires independent approval by a xiNAS operator. Open the approval page, review the plan, and approve or decline there.';

/**
 * The MRTR orchestration (S15 §3.3 gates 4–9, §4, §6.4, §7.3, §7.5). One
 * instance per api process; every method is safe to call concurrently
 * because all state lives in the store (SQLite) and the client-held
 * requestState.
 */
export class ConfirmationService {
  readonly store: ConfirmationStore;
  private readonly tasks: TaskStore;
  private readonly keyRing: KeyRing;
  private readonly config: ResolvedConfirmationConfig;
  private readonly now: () => number;
  private readonly nodeId: string;
  private readonly hostname: string;
  private readonly audit: AuditAppender | undefined;
  private readonly metrics: ConfirmationMetrics;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly waiters = new Map<string, number>();
  private totalWaiters = 0;

  constructor(deps: ConfirmationServiceDeps) {
    this.store = deps.store;
    this.tasks = deps.tasks;
    this.keyRing = deps.keyRing;
    this.config = deps.config;
    this.now = deps.now;
    this.nodeId = deps.nodeId;
    this.hostname = deps.hostname;
    this.audit = deps.audit;
    this.metrics = deps.metrics ?? noopMetrics;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async handle(input: HandleInput): Promise<HandleOutcome> {
    const { entry, args, identity } = input;

    // Gate 4 — apply request shape.
    const planId = args.plan_id;
    const expectedRevision = args.expected_revision;
    const idempotencyKey = args.idempotency_key;
    if (typeof planId !== 'string' || planId.length === 0)
      return err('INVALID_ARGUMENT', "'plan_id' is required");
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
      return err('INVALID_ARGUMENT', "'expected_revision' is required and must be an integer");
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)
      return err('INVALID_ARGUMENT', "'idempotency_key' is required");
    if (args.dangerous !== undefined && typeof args.dangerous !== 'boolean')
      return err('INVALID_ARGUMENT', "'dangerous' must be a boolean");

    // Gate — RBAC pre-check (S15 §3.3 gate 2), ahead of the plan lookup: a
    // role that cannot reach this operation at all never creates a
    // confirmation record and never touches a plan it may not be entitled
    // to see (F3 — this used to be folded into Gate 6 below).
    if (ROLE_RANK[identity.role] < ROLE_RANK[entry.min_role]) {
      return err(
        'PERMISSION_DENIED',
        `role '${identity.role}' may not call ${entry.name} (requires ${entry.min_role})`,
        { required_role: entry.min_role, operation: entry.name },
      );
    }

    const bindings: BindingKey = {
      principal: identity.principal,
      tool_name: entry.name,
      arguments_hash: argumentsHash(entry.name, args),
      plan_id: planId,
      idempotency_key: idempotencyKey,
      expected_revision: expectedRevision,
    };

    // A retry carries a requestState: verify it and cross-check it against
    // the stored record BEFORE the plan-document gates below (F2, S15
    // §7.3) — the bindings this needs (principal, tool name, arguments
    // hash, plan_id, idempotency_key, expected_revision) come from the
    // identity and the arguments, not from the document, so a forged or
    // stolen requestState is caught — and audited (verification_failed /
    // replay_rejected) — before it can ever reach a doc-based
    // PRECONDITION_FAILED/plan_binding.
    let retryState: { payload: RequestStatePayload; record: ConfirmationRecord } | undefined;
    if (input.mrtr?.requestState !== undefined) {
      retryState = this.verifyRetryState(input, bindings);
    }

    // Gate 5 — resolve the plan and its document.
    const planTask = this.tasks.get(planId);
    if (planTask === null || planTask.state !== 'plan_only') {
      return err('NOT_FOUND', `no plan_only task with plan_id ${planId}`, {
        remediation: 'Re-run mode=plan.',
      });
    }
    const doc = planTask.plan_document;
    if (doc === undefined || planTask.plan_document_hash === undefined) {
      return err('PRECONDITION_FAILED', 'this plan predates MCP confirmation support; re-plan', {
        reason: 'plan_predates_confirmation',
      });
    }

    // Gate 6 — integrity and binding (S15 §5.3).
    const pathParam = /\{([^}]+)\}/.exec(entry.path)?.[1];
    if (
      planDocumentHash(doc) !== planTask.plan_document_hash ||
      doc.plan_id !== planTask.task_id ||
      doc.plan_hash !== planTask.plan_hash ||
      !(entry.operation_kinds ?? []).includes(doc.operation_kind) ||
      doc.operation_kind !== planTask.kind ||
      (pathParam !== undefined && doc.resource_ref.id !== args[pathParam]) ||
      // S15 §5.3 item 7 (review P1): one principal never applies another's plan.
      doc.created_by.principal !== identity.principal
    ) {
      return err(
        'PRECONDITION_FAILED',
        'the plan does not belong to this principal, tool and resource',
        { reason: 'plan_binding' },
      );
    }
    // Ruling R-3.1: compare against what the plan RESPONSE said (the document),
    // never the row column — the route-computed kinds leave the row unpinned.
    if (doc.state_revision_expected !== expectedRevision) {
      return err(
        'PRECONDITION_FAILED',
        `expected_revision ${expectedRevision} does not match the plan's ${doc.state_revision_expected}`,
        { expected_revision: expectedRevision, plan_revision: doc.state_revision_expected },
      );
    }

    // Gate 7 — blockers. Excludes the engine-owned `dangerous_flag_required`
    // advisory (F1, ruling R-10.1): every REST apply route filters it the
    // same way because TaskEngine.apply enforces the real `dangerous` flag
    // itself at apply time (S15 §3.4) — leaving it in would refuse every
    // destructive plan here and make url mode unreachable.
    const blocking = doc.blockers.filter((b) => b.code !== 'dangerous_flag_required');
    if (blocking.length > 0) {
      return err('PRECONDITION_FAILED', 'the plan has unresolved blockers', {
        reason: 'plan_blocked',
        blockers: blocking,
      });
    }

    // Gate 8 — mode.
    const mode = confirmationModeFor(doc.risk_level, doc.rollback_model);

    if (retryState !== undefined) {
      return this.retry(
        input,
        doc,
        planTask.plan_hash ?? '',
        mode,
        bindings,
        retryState.payload,
        retryState.record,
      );
    }
    return this.initial(
      input,
      doc,
      planTask.plan_hash ?? '',
      planTask.plan_document_hash,
      mode,
      bindings,
    );
  }

  // ── initial call (S15 §4.2, §4.5, §6.4) ───────────────────────────────────

  private initial(
    input: HandleInput,
    doc: PlanDocument,
    planHash: string,
    docHash: string,
    mode: ConfirmationMode,
    bindings: BindingKey,
  ): HandleOutcome {
    const cap = this.requireCapability(input.client, mode, bindings);
    if (cap !== undefined) throw cap;

    const open = this.store.findOpenByBindings(bindings);
    if (open !== null) return this.reissue(open, doc);

    if (mode === 'url' && this.config.approval_url_base === undefined) {
      return err(
        'CONFIRMATION_URL_UNAVAILABLE',
        'destructive MCP applies need an approval page; mcp.confirmation.approval_url_base is not configured',
        { config_key: 'mcp.confirmation.approval_url_base' },
      );
    }
    if (this.store.countOpen(bindings.principal) >= this.config.max_pending_per_principal) {
      return err('CONFIRMATION_LIMIT_EXCEEDED', 'too many open confirmations for this principal', {
        limit: this.config.max_pending_per_principal,
        config_key: 'mcp.confirmation.max_pending_per_principal',
      });
    }
    if (this.store.countOpen() >= this.config.max_pending_total) {
      return err('CONFIRMATION_LIMIT_EXCEEDED', 'too many open confirmations on this node', {
        limit: this.config.max_pending_total,
        config_key: 'mcp.confirmation.max_pending_total',
      });
    }
    if (!this.takeToken(bindings.principal)) {
      return err('CONFIRMATION_RATE_LIMITED', 'confirmation requests are rate limited', {
        limit_per_minute: this.config.create_rate_per_minute,
        config_key: 'mcp.confirmation.create_rate_per_minute',
      });
    }

    const nonce = newNonce();
    const record = this.store.create({
      mode,
      principal: bindings.principal,
      role: input.identity.role,
      tool_name: bindings.tool_name,
      operation_kind: doc.operation_kind,
      arguments_hash: bindings.arguments_hash,
      plan_id: bindings.plan_id,
      plan_hash: planHash,
      plan_document_hash: docHash,
      idempotency_key: bindings.idempotency_key,
      expected_revision: bindings.expected_revision,
      risk_level: doc.risk_level,
      rollback_model: doc.rollback_model,
      request_state_nonce_hash: nonceHash(nonce),
      ttl_ms: this.config.ttl_seconds * 1000,
      correlation_id: input.correlationId,
      request_id: randomUUID(),
      node_id: this.nodeId,
    });
    queueConfirmationEvent(this.audit, 'requested', record, {
      detail: { round: 1, expires_at: record.expires_at },
    });
    this.metrics.requested(record.risk_level, record.mode);
    return { kind: 'input_required', result: this.elicitation(record, doc, nonce) };
  }

  private reissue(record: ConfirmationRecord, doc: PlanDocument): HandleOutcome {
    // Ruling (planning): a re-issued url elicitation with no configured
    // approval page must not be minted — answer the same
    // CONFIRMATION_URL_UNAVAILABLE the initial call would.
    if (record.mode === 'url' && this.config.approval_url_base === undefined) {
      return err(
        'CONFIRMATION_URL_UNAVAILABLE',
        'destructive MCP applies need an approval page; mcp.confirmation.approval_url_base is not configured',
        { config_key: 'mcp.confirmation.approval_url_base' },
      );
    }
    if (record.round >= MAX_ROUNDS) {
      const expired = this.store.expire(record.confirmation_id, 'round_limit') ?? record;
      queueConfirmationEvent(this.audit, 'expired', expired, { reason: 'round_limit' });
      this.metrics.roundLimit();
      this.metrics.decided('expired');
      return err('CONFIRMATION_ROUND_LIMIT', 'too many confirmation rounds; start a fresh apply', {
        confirmation_id: record.confirmation_id,
        rounds: MAX_ROUNDS,
        task_created: false,
      });
    }
    const nonce = newNonce();
    const bumped = this.store.reissue(record.confirmation_id, nonceHash(nonce));
    if (bumped === null)
      return this.terminalError(this.store.get(record.confirmation_id) ?? record);
    queueConfirmationEvent(this.audit, 'reissued', bumped, { detail: { round: bumped.round } });
    return { kind: 'input_required', result: this.elicitation(bumped, doc, nonce) };
  }

  // ── retry precheck (F2, S15 §7.3) ─────────────────────────────────────────
  //
  // Runs in `handle()` BEFORE the plan-document gates (5–7): verifies the
  // requestState and cross-checks it against the stored record using only
  // the bindings derivable from the identity and the arguments (no plan
  // document needed yet). A forged state fails verification; a stolen
  // state (presented by a different principal, or against a different
  // tool/plan/idempotency-key/revision than it was minted for) fails the
  // binding cross-check — both are audited here so the trail exists even
  // though the caller never reaches a doc-based gate.

  private verifyRetryState(
    input: HandleInput,
    bindings: BindingKey,
  ): { payload: RequestStatePayload; record: ConfirmationRecord } {
    let payload: RequestStatePayload;
    try {
      payload = verifyRequestState(this.keyRing, input.mrtr?.requestState);
    } catch (e) {
      const reason = e instanceof McpProtocolError ? (e.reasonClass ?? 'unknown') : 'unknown';
      this.metrics.stateValidationFailure(reason);
      queueConfirmationEventRaw(this.audit, 'verification_failed', {
        principal: input.identity.principal,
        tool_name: bindings.tool_name,
        correlation_id: input.correlationId,
        reason,
      });
      throw e;
    }
    const record = this.store.get(payload.cid);
    const mismatch =
      record === null ||
      payload.sub !== bindings.principal ||
      payload.tool !== bindings.tool_name ||
      payload.ah !== bindings.arguments_hash ||
      payload.pid !== bindings.plan_id ||
      payload.rev !== bindings.expected_revision ||
      payload.ik !== bindings.idempotency_key ||
      record.principal !== bindings.principal ||
      record.arguments_hash !== bindings.arguments_hash ||
      record.plan_id !== bindings.plan_id ||
      record.idempotency_key !== bindings.idempotency_key ||
      record.expected_revision !== bindings.expected_revision ||
      record.tool_name !== bindings.tool_name;
    if (mismatch) {
      queueConfirmationEventRaw(this.audit, 'replay_rejected', {
        presented_by: bindings.principal,
        record_principal: record?.principal ?? null,
        confirmation_id: payload.cid,
        reason: 'binding_mismatch',
      });
      this.metrics.replayRejected();
      throw invalidRequestState('binding');
    }
    return { payload, record };
  }

  // ── retry (S15 §4.3, §4.4, §7.3, §7.5) ────────────────────────────────────

  private async retry(
    input: HandleInput,
    doc: PlanDocument,
    planHash: string,
    mode: ConfirmationMode,
    bindings: BindingKey,
    payload: RequestStatePayload,
    record: ConfirmationRecord,
  ): Promise<HandleOutcome> {
    const cap = this.requireCapability(input.client, mode, bindings);
    if (cap !== undefined) throw cap;

    // The remaining bindings need the plan document / mode (only knowable
    // once the caller has passed gates 5–8): role, plan hash, risk level,
    // mode, and the nonce/round/expiry the record itself carries.
    const mismatch =
      payload.role !== input.identity.role ||
      payload.ph !== planHash ||
      payload.risk !== doc.risk_level ||
      payload.mode !== mode ||
      nonceHash(payload.nonce) !== record.request_state_nonce_hash ||
      payload.round !== record.round ||
      payload.exp !== record.expires_at;
    if (mismatch) {
      queueConfirmationEvent(this.audit, 'replay_rejected', record, {
        detail: { presented_by: bindings.principal, presented_round: payload.round },
      });
      this.metrics.replayRejected();
      throw invalidRequestState('binding');
    }

    if (record.status === 'pending' || record.status === 'approved') {
      if (record.expires_at <= this.now()) {
        const expired = this.store.expire(record.confirmation_id, 'ttl') ?? record;
        queueConfirmationEvent(this.audit, 'expired', expired, { reason: 'ttl' });
        this.metrics.decided('expired');
        if (record.status === 'approved') this.metrics.approvedExpired();
        return this.terminalError(expired);
      }
      const response = input.mrtr?.inputResponses?.[REQUEST_KEY];
      if (response === undefined) return this.reissue(record, doc); // missing → re-issue (V-16)
      if (response.action === 'decline') return this.declineByClient(record, 'declined');
      if (response.action === 'cancel') return this.declineByClient(record, 'cancelled');
      if (mode === 'form') {
        if (response.content?.decision !== 'APPLY') return this.declineByClient(record, 'declined');
        return { kind: 'proceed', confirmation_id: record.confirmation_id };
      }
      // url: accept means "the browser flow happened"; the record decides.
      const settled = await this.awaitOperator(record);
      if (settled.status === 'approved')
        return { kind: 'proceed', confirmation_id: settled.confirmation_id };
      if (settled.status === 'pending') return this.reissue(settled, doc);
      return this.terminalError(settled);
    }
    if (record.status === 'consumed') {
      // The engine decides whether this is the identical idempotent replay (§8.5).
      return { kind: 'proceed', confirmation_id: record.confirmation_id };
    }
    return this.terminalError(record);
  }

  private async awaitOperator(record: ConfirmationRecord): Promise<ConfirmationRecord> {
    const id = record.confirmation_id;
    const mine = this.waiters.get(id) ?? 0;
    if (mine >= MAX_WAITERS_PER_CONFIRMATION || this.totalWaiters >= MAX_WAITERS_TOTAL) {
      return this.store.get(id) ?? record;
    }
    this.waiters.set(id, mine + 1);
    this.totalWaiters += 1;
    try {
      const deadline = this.now() + this.config.url_wait_seconds * 1000;
      let current = this.store.get(id) ?? record;
      while (current.status === 'pending' && this.now() < deadline) {
        await this.sleep(WAIT_POLL_MS);
        current = this.store.get(id) ?? current;
      }
      return current;
    } finally {
      // F4: delete the key once the count reaches 0 rather than leaving a
      // stale 0 entry — this map otherwise leaks one entry per distinct
      // confirmation id that ever gets a url waiter.
      const next = (this.waiters.get(id) ?? 1) - 1;
      if (next <= 0) this.waiters.delete(id);
      else this.waiters.set(id, next);
      this.totalWaiters -= 1;
    }
  }

  private declineByClient(
    record: ConfirmationRecord,
    outcome: 'declined' | 'cancelled',
  ): HandleOutcome {
    const moved =
      outcome === 'declined'
        ? this.store.decline(record.confirmation_id, record.principal, 'mcp_form')
        : this.store.cancel(record.confirmation_id, record.principal);
    const final = moved ?? this.store.get(record.confirmation_id) ?? record;
    queueConfirmationEvent(this.audit, outcome, final);
    this.metrics.decided(outcome);
    return this.terminalError(final);
  }

  /** Map a terminal record to the tool error the client sees (S15 §11). */
  private terminalError(record: ConfirmationRecord): HandleOutcome {
    const details = { confirmation_id: record.confirmation_id, task_created: false };
    switch (record.status) {
      case 'declined':
        return err(
          'CONFIRMATION_DECLINED',
          'the confirmation was declined; no apply task was created',
          details,
        );
      case 'cancelled':
        return err(
          'CONFIRMATION_CANCELLED',
          'the confirmation was cancelled; no apply task was created',
          details,
        );
      case 'expired':
        return err('CONFIRMATION_EXPIRED', 'the confirmation expired; start a fresh apply', {
          ...details,
          expired_reason: record.expired_reason,
        });
      case 'consumed':
        return err(
          'CONFIRMATION_ALREADY_CONSUMED',
          'the confirmation was already used for another request',
          details,
        );
      default:
        return err(
          'CONFIRMATION_DECLINED',
          'the confirmation is not approved; no apply task was created',
          details,
        );
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private requireCapability(
    client: McpClientInfo,
    mode: ConfirmationMode,
    bindings: BindingKey,
  ): McpProtocolError | undefined {
    if (client.elicitation.has(mode)) return undefined;
    this.metrics.capabilityFailure(mode);
    // No record exists yet on the initial call; on a retry the record is
    // untouched. Audit without a record: use the bindings (F2 — shares the
    // same record-less shape as verification_failed / replay_rejected).
    queueConfirmationEventRaw(this.audit, 'capability_missing', {
      principal: bindings.principal,
      tool_name: bindings.tool_name,
      plan_id: bindings.plan_id,
      required_mode: mode,
    });
    return new McpProtocolError(
      MISSING_REQUIRED_CLIENT_CAPABILITY,
      'Server requires the elicitation capability for this request',
      { httpStatus: 400, data: { requiredCapabilities: { elicitation: { [mode]: {} } } } },
    );
  }

  private elicitation(
    record: ConfirmationRecord,
    doc: PlanDocument,
    nonce: string,
  ): InputRequiredToolResult {
    const payload: RequestStatePayload = {
      v: 1,
      cid: record.confirmation_id,
      sub: record.principal,
      role: record.role,
      tool: record.tool_name,
      ah: record.arguments_hash,
      pid: record.plan_id,
      ph: record.plan_hash,
      rev: record.expected_revision,
      ik: record.idempotency_key,
      risk: record.risk_level,
      mode: record.mode,
      iat: this.now(),
      exp: record.expires_at,
      nonce,
      round: record.round,
    };
    const requestState = mintRequestState(this.keyRing, payload);
    if (record.mode === 'url') {
      return {
        resultType: 'input_required',
        inputRequests: {
          [REQUEST_KEY]: {
            method: 'elicitation/create',
            params: {
              mode: 'url',
              message: URL_MESSAGE,
              url: `${this.config.approval_url_base}/mcp/approvals/${record.confirmation_id}`,
            },
          },
        },
        requestState,
      };
    }
    return {
      resultType: 'input_required',
      inputRequests: {
        [REQUEST_KEY]: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: renderConfirmationMessage({
              record,
              document: doc,
              hostname: this.hostname,
              now: this.now(),
            }),
            requestedSchema: {
              type: 'object',
              properties: {
                decision: { type: 'string', enum: ['APPLY'], title: 'Confirm operation' },
              },
              required: ['decision'],
            },
          },
        },
      },
      requestState,
    };
  }

  private takeToken(principal: string): boolean {
    const rate = this.config.create_rate_per_minute;
    const now = this.now();
    const b = this.buckets.get(principal) ?? { tokens: rate, updated: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.updated) / 60_000) * rate);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(principal, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(principal, b);
    return true;
  }

  /** Test-only: whether the per-confirmation waiter count is still tracked at all (F4 — the map must not leak a stale 0 entry). */
  hasWaiterEntry(confirmationId: string): boolean {
    return this.waiters.has(confirmationId);
  }

  /** Expire open records past their TTL (startup + timer, S15 §6.3). */
  sweepExpired(reason: 'ttl' | 'restart_sweep'): ConfirmationRecord[] {
    const swept = this.store.sweepExpired(this.now(), reason);
    for (const r of swept) {
      queueConfirmationEvent(this.audit, 'expired', r, { reason });
      this.metrics.decided('expired');
      if (r.approved_at !== undefined) this.metrics.approvedExpired();
    }
    return swept; // the pending gauge is computed from the store at scrape time (Task 13)
  }
}

function err(code: string, message: string, details?: unknown): HandleOutcome {
  return { kind: 'error', result: errorResult(code, message, details) };
}
