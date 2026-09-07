import Database from 'better-sqlite3';
import type { Database as DatabaseInstance } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ResolvedConfirmationConfig } from '../../../api/config.js';
import { ApiException } from '../../../api/errors.js';
import { CATALOG, type CatalogEntry } from '../../../api/mcp/catalog.js';
import type { McpIdentity } from '../../../api/mcp/dispatch.js';
import {
  ConfirmationService,
  type HandleInput,
  type HandleOutcome,
  type McpClientInfo,
} from '../../../api/mcp/confirmation/service.js';
import {
  type ConfirmationMetrics,
  registryConfirmationMetrics,
} from '../../../api/mcp/confirmation/metrics.js';
import { ConfirmationStore } from '../../../api/mcp/confirmation/store.js';
import { MetricsRegistry } from '../../../lib/metrics.js';
import type { KeyRing } from '../../../api/mcp/confirmation/state.js';
import type { InputRequiredToolResult, ToolResult } from '../../../api/mcp/results.js';
import { argumentsHash } from '../../../api/mcp/confirmation/policy.js';
import {
  INVALID_PARAMS,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  McpProtocolError,
} from '../../../api/mcp/confirmation/errors.js';
import {
  PLAN_DOCUMENT_SCHEMA,
  type PlanDocument,
  planDocumentHash,
} from '../../../api/plan/document.js';
import { TaskStore } from '../../../api/tasks/store.js';
import { AuditAppender } from '../../../state/audit.js';
import { runMigrations } from '../../../state/migrations.js';

/**
 * Unit coverage for `ConfirmationService.handle()` branches that are hard
 * (or impossible) to reach over the wire in mcp-confirmation.test.ts: a
 * hand-built blocked plan document, a pre-migration-006 (null-document)
 * plan, the pending-count/rate limits, the CONFIRMATION_URL_UNAVAILABLE
 * gate (both the initial-call path and the reissue ruling), and the
 * per-confirmation url-waiter cap. Built directly over an in-memory db with
 * a real TaskStore/ConfirmationStore and a fake, non-resolving `sleep` so
 * concurrency tests never actually wait out `url_wait_seconds`.
 */

const NODE_ID = 'node-test';
const HOSTNAME = 'test-host';
const PRINCIPAL = 'admin:demo';
const PRINCIPAL_B = 'admin:other-principal';
const IDENTITY: McpIdentity = { principal: PRINCIPAL, role: 'admin' };
const IDENTITY_B: McpIdentity = { principal: PRINCIPAL_B, role: 'admin' };
const OPERATOR_IDENTITY: McpIdentity = { principal: PRINCIPAL, role: 'operator' };
const BOTH_CLIENT: McpClientInfo = {
  era: 'modern',
  elicitation: new Set(['form', 'url']),
  tasks: false,
};

const FS_CREATE = CATALOG.find((e) => e.name === 'filesystems.create') as CatalogEntry;
const SHARES_UPDATE = CATALOG.find((e) => e.name === 'shares.update') as CatalogEntry;

function keyRing(): KeyRing {
  return { active: 'k1', keys: new Map([['k1', Buffer.alloc(32, 7)]]) };
}

interface Harness {
  db: DatabaseInstance;
  store: ConfirmationStore;
  tasks: TaskStore;
  service: ConfirmationService;
  /** Present only when the harness was built with `{ metrics: true }`. */
  registry: MetricsRegistry | undefined;
  setClock(v: number): void;
}

function harness(
  configOverrides: Partial<ResolvedConfirmationConfig> = {},
  serviceOverrides: { sleep?: (ms: number) => Promise<void>; audit?: boolean; metrics?: true } = {},
): Harness {
  const db = new Database(':memory:');
  runMigrations(db);
  let clock = 1_000_000;
  let n = 0;
  const store = new ConfirmationStore({ db, now: () => clock, newId: () => `c-${(n += 1)}` });
  let t = 0;
  const tasks = new TaskStore({ db, now: () => clock, newId: () => `t-${(t += 1)}` });
  const config: ResolvedConfirmationConfig = {
    ttl_seconds: 300,
    url_wait_seconds: 1,
    max_pending_per_principal: 5,
    max_pending_total: 100,
    create_rate_per_minute: 10,
    approval_url_base: 'https://approvals.example.test',
    approver_policy: 'distinct_principal',
    allow_uds_approval: false,
    ...configOverrides,
  };
  const audit = serviceOverrides.audit === true ? new AuditAppender(db, NODE_ID) : undefined;
  const registry = serviceOverrides.metrics === true ? new MetricsRegistry() : undefined;
  const metrics: ConfirmationMetrics | undefined =
    registry === undefined ? undefined : registryConfirmationMetrics(registry, store);
  const service = new ConfirmationService({
    store,
    tasks,
    keyRing: keyRing(),
    config,
    now: () => clock,
    nodeId: NODE_ID,
    hostname: HOSTNAME,
    ...(audit !== undefined ? { audit } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(serviceOverrides.sleep !== undefined ? { sleep: serviceOverrides.sleep } : {}),
  });
  return {
    db,
    store,
    tasks,
    service,
    registry,
    setClock(v: number) {
      clock = v;
    },
  };
}

/** Rows queued via AuditAppender in this in-memory db (harness({}, { audit: true })). */
function auditRows(h: Harness): Array<{ kind: string; payload: Record<string, unknown> }> {
  const rows = h.db
    .prepare('SELECT entry_json FROM audit_outbox ORDER BY audit_seq')
    .all() as Array<{ entry_json: Buffer }>;
  return rows.map(
    (r) =>
      JSON.parse(r.entry_json.toString('utf8')) as {
        kind: string;
        payload: Record<string, unknown>;
      },
  );
}

/** Build a matching (plan_only task, PlanDocument) pair for `entry`, hashed consistently. */
function seedPlan(
  tasks: TaskStore,
  entry: CatalogEntry,
  overrides: Partial<PlanDocument> = {},
): { doc: PlanDocument; taskId: string } {
  const planId =
    (overrides.plan_id as string | undefined) ??
    `p-${entry.name}-${Math.random().toString(36).slice(2)}`;
  const resourceId = overrides.resource_ref?.id ?? 'res-a';
  const doc: PlanDocument = {
    schema: PLAN_DOCUMENT_SCHEMA,
    plan_id: planId,
    operation_kind: entry.operation_kinds?.[0] ?? entry.name,
    resource_ref: { kind: 'Resource', id: resourceId },
    plan_hash: `ph-${planId}`,
    state_revision_expected: 0,
    observed_revision_expected: null,
    observed_at: null,
    affected_resources: [{ kind: 'Resource', id: resourceId ?? 'res-a' }],
    risk_level: 'changing_access',
    client_impact: 'May affect NFS clients; review the diff.',
    blockers: [],
    warnings: [],
    diff: {},
    rollback_model: 'changing_access',
    created_at: new Date(1_000_000).toISOString(),
    created_by: { principal: PRINCIPAL, client_type: 'mcp' },
    ...overrides,
  };
  const task = tasks.createPlanOnly({
    task_id: doc.plan_id,
    kind: doc.operation_kind,
    principal: doc.created_by.principal,
    client_type: doc.created_by.client_type,
    request_id: `req-${planId}`,
    correlation_id: `corr-${planId}`,
    input_hash: `ih-${planId}`,
    risk_level: doc.risk_level,
    affected_resources: doc.affected_resources,
    plan_hash: doc.plan_hash,
    state_revision_expected: doc.state_revision_expected,
    plan_document: doc,
    plan_document_hash: planDocumentHash(doc),
  });
  return { doc, taskId: task.task_id };
}

function baseArgs(
  doc: PlanDocument,
  entry: CatalogEntry,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const pathParam = /\{([^}]+)\}/.exec(entry.path)?.[1];
  return {
    mode: 'apply',
    plan_id: doc.plan_id,
    expected_revision: doc.state_revision_expected,
    idempotency_key: `ik-${doc.plan_id}`,
    ...(pathParam !== undefined ? { [pathParam]: doc.resource_ref.id } : {}),
    ...extra,
  };
}

function errorOf(outcome: HandleOutcome): { code: string; message: string; details?: unknown } {
  if (outcome.kind !== 'error') throw new Error(`expected 'error', got '${outcome.kind}'`);
  const result = outcome.result as ToolResult;
  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
    error: { code: string; message: string; details?: unknown };
  };
  return parsed.error;
}

function requireInputRequired(outcome: HandleOutcome): InputRequiredToolResult {
  if (outcome.kind !== 'input_required')
    throw new Error(`expected 'input_required', got '${outcome.kind}'`);
  return outcome.result;
}

describe('ConfirmationService.handle (S15 §3.3, §4, §6.4)', () => {
  it('blockers: a non-empty plan_document.blockers refuses with PRECONDITION_FAILED/plan_blocked (Gate 7)', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      blockers: [{ code: 'X', message: 'm' }],
    });
    const input: HandleInput = {
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-1',
    };
    const outcome = await h.service.handle(input);
    const error = errorOf(outcome);
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect((error.details as { reason?: string } | undefined)?.reason).toBe('plan_blocked');
    expect((error.details as { blockers?: unknown } | undefined)?.blockers).toEqual([
      { code: 'X', message: 'm' },
    ]);
    // No confirmation record was created.
    expect(h.store.countOpen()).toBe(0);
  });

  it('plan_predates_confirmation: a plan_only task with no plan_document (pre-006) refuses PRECONDITION_FAILED', async () => {
    const h = harness();
    const task = h.tasks.createPlanOnly({
      task_id: 'p-legacy',
      kind: FS_CREATE.operation_kinds?.[0] as string,
      principal: PRINCIPAL,
      client_type: 'mcp',
      request_id: 'req-legacy',
      correlation_id: 'corr-legacy',
      input_hash: 'ih-legacy',
      risk_level: 'non_disruptive',
      affected_resources: [{ kind: 'Resource', id: 'res-a' }],
    });
    const input: HandleInput = {
      entry: FS_CREATE,
      args: {
        mode: 'apply',
        plan_id: task.task_id,
        expected_revision: 0,
        idempotency_key: 'ik-legacy',
      },
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-2',
    };
    const outcome = await h.service.handle(input);
    const error = errorOf(outcome);
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect((error.details as { reason?: string } | undefined)?.reason).toBe(
      'plan_predates_confirmation',
    );
  });

  it('max_pending_per_principal: a second DISTINCT open confirmation over the cap is refused CONFIRMATION_LIMIT_EXCEEDED', async () => {
    const h = harness({ max_pending_per_principal: 1 });
    const { doc: docA } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-a' },
    });
    const { doc: docB } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-b' },
    });

    const first = await h.service.handle({
      entry: SHARES_UPDATE,
      args: baseArgs(docA, SHARES_UPDATE),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-a',
    });
    expect(first.kind).toBe('input_required');

    const second = await h.service.handle({
      entry: SHARES_UPDATE,
      args: baseArgs(docB, SHARES_UPDATE),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-b',
    });
    const error = errorOf(second);
    expect(error.code).toBe('CONFIRMATION_LIMIT_EXCEEDED');
    expect((error.details as { limit?: number } | undefined)?.limit).toBe(1);
  });

  it('rate limit: a second DISTINCT create in the same tick is refused CONFIRMATION_RATE_LIMITED', async () => {
    const h = harness({ create_rate_per_minute: 1, max_pending_per_principal: 10 });
    const { doc: docA } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-a' },
    });
    const { doc: docB } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-b' },
    });

    const first = await h.service.handle({
      entry: SHARES_UPDATE,
      args: baseArgs(docA, SHARES_UPDATE),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-a',
    });
    expect(first.kind).toBe('input_required');

    const second = await h.service.handle({
      entry: SHARES_UPDATE,
      args: baseArgs(docB, SHARES_UPDATE),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-b',
    });
    const error = errorOf(second);
    expect(error.code).toBe('CONFIRMATION_RATE_LIMITED');
  });

  it('CONFIRMATION_URL_UNAVAILABLE: an initial url-mode call with no approval_url_base is refused, no record created', async () => {
    const h = harness({ approval_url_base: undefined });
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE, { dangerous: true }),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-url',
    });
    const error = errorOf(outcome);
    expect(error.code).toBe('CONFIRMATION_URL_UNAVAILABLE');
    expect(h.store.countOpen()).toBe(0);
  });

  it('reissue ruling: a repeat call against an OPEN url record answers CONFIRMATION_URL_UNAVAILABLE once approval_url_base is unset', async () => {
    // Create the open url record directly via the store (S15 ruling scenario:
    // the record predates a config change, or was minted while the base was
    // still configured) — bindings must match exactly what handle() derives
    // from `args` so findOpenByBindings finds it and routes into reissue().
    const h = harness({ approval_url_base: undefined });
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const args = baseArgs(doc, FS_CREATE, { dangerous: true });
    h.store.create({
      mode: 'url',
      principal: PRINCIPAL,
      role: IDENTITY.role,
      tool_name: FS_CREATE.name,
      operation_kind: doc.operation_kind,
      arguments_hash: argumentsHash(FS_CREATE.name, args),
      plan_id: doc.plan_id,
      plan_hash: doc.plan_hash,
      plan_document_hash: planDocumentHash(doc),
      idempotency_key: args.idempotency_key as string,
      expected_revision: args.expected_revision as number,
      risk_level: doc.risk_level,
      rollback_model: doc.rollback_model,
      request_state_nonce_hash: 'nh-precreated',
      ttl_ms: 300_000,
      correlation_id: 'corr-precreated',
      request_id: 'req-precreated',
      node_id: NODE_ID,
    });

    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args,
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-repeat',
    });
    expect(errorOf(outcome).code).toBe('CONFIRMATION_URL_UNAVAILABLE');
  });

  it('waiter cap: a 5th concurrent url waiter on the SAME confirmation returns a re-issue instead of hanging out url_wait_seconds', async () => {
    const h = harness({ url_wait_seconds: 1 }, { sleep: () => new Promise<void>(() => {}) }); // never resolves
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const args = baseArgs(doc, FS_CREATE, { dangerous: true });
    const initialInput: HandleInput = {
      entry: FS_CREATE,
      args,
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-initial',
    };
    const initial = requireInputRequired(await h.service.handle(initialInput));
    const requestState = initial.requestState;

    const retryInput = (): HandleInput => ({
      entry: FS_CREATE,
      args,
      identity: IDENTITY,
      client: BOTH_CLIENT,
      mrtr: { requestState, inputResponses: { confirm_apply: { action: 'accept' } } },
      correlationId: 'corr-retry',
    });

    // Occupy the 4 per-confirmation waiter slots; none of these ever settle
    // (the fake sleep never resolves) — deliberately not awaited.
    for (let i = 0; i < 4; i += 1) {
      void h.service.handle(retryInput());
    }
    // The 5th sees the cap and must come back promptly with a re-issued
    // elicitation rather than joining the (never-resolving) wait.
    const fifth = await h.service.handle(retryInput());
    expect(fifth.kind).toBe('input_required');
  });

  // ── F1 (fix round 1, R-10.1) ─────────────────────────────────────────────

  it('F1: a document whose only blocker is the engine-owned dangerous_flag_required advisory passes Gate 7 (reaches the mode gate)', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
      blockers: [
        { code: 'dangerous_flag_required', message: 'force:true requires dangerous: true' },
      ],
    });
    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE, { dangerous: true }),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-f1a',
    });
    expect(outcome.kind).toBe('input_required');
  });

  it('F1: dangerous_flag_required plus one other blocker still refuses PRECONDITION_FAILED/plan_blocked with ONLY the other blocker listed', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
      blockers: [
        { code: 'dangerous_flag_required', message: 'force:true requires dangerous: true' },
        { code: 'X', message: 'an unrelated blocker' },
      ],
    });
    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE, { dangerous: true }),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-f1b',
    });
    const error = errorOf(outcome);
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect((error.details as { reason?: string } | undefined)?.reason).toBe('plan_blocked');
    expect((error.details as { blockers?: unknown } | undefined)?.blockers).toEqual([
      { code: 'X', message: 'an unrelated blocker' },
    ]);
  });

  // ── F2 (fix round 1, spec §7.3) ────────────────────────────────────────

  it('F2: a tampered requestState on retry is refused as a protocol error and audits verification_failed with reason "mac" — no state bytes leaked', async () => {
    const h = harness({}, { audit: true });
    const { doc } = seedPlan(h.tasks, SHARES_UPDATE);
    const args = baseArgs(doc, SHARES_UPDATE);
    const first = requireInputRequired(
      await h.service.handle({
        entry: SHARES_UPDATE,
        args,
        identity: IDENTITY,
        client: BOTH_CLIENT,
        correlationId: 'corr-tamper-1',
      }),
    );
    const requestState = first.requestState as string;
    const tampered = `${requestState.slice(0, -1)}${requestState.endsWith('a') ? 'b' : 'a'}`;

    await expect(
      h.service.handle({
        entry: SHARES_UPDATE,
        args,
        identity: IDENTITY,
        client: BOTH_CLIENT,
        mrtr: {
          requestState: tampered,
          inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
        },
        correlationId: 'corr-tamper-2',
      }),
    ).rejects.toMatchObject({ code: -32602 });

    const rows = auditRows(h);
    const failure = rows.find((r) => r.kind === 'mcp.confirmation.verification_failed');
    expect(failure).toBeDefined();
    expect(failure?.payload.reason).toBe('mac');
    const serialized = JSON.stringify(failure?.payload);
    expect(serialized).not.toContain(requestState);
    expect(serialized).not.toContain(tampered);
  });

  it('F2: a valid requestState minted for principal A presented by principal B is refused -32602 (not plan_binding) and audits replay_rejected with both principals', async () => {
    const h = harness({}, { audit: true });
    const { doc } = seedPlan(h.tasks, SHARES_UPDATE);
    const args = baseArgs(doc, SHARES_UPDATE);
    const first = requireInputRequired(
      await h.service.handle({
        entry: SHARES_UPDATE,
        args,
        identity: IDENTITY,
        client: BOTH_CLIENT,
        correlationId: 'corr-cross-1',
      }),
    );
    const requestState = first.requestState as string;

    await expect(
      h.service.handle({
        entry: SHARES_UPDATE,
        args,
        identity: IDENTITY_B,
        client: BOTH_CLIENT,
        mrtr: {
          requestState,
          inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } },
        },
        correlationId: 'corr-cross-2',
      }),
    ).rejects.toMatchObject({ code: -32602 });

    const rows = auditRows(h);
    const rejection = rows.find((r) => r.kind === 'mcp.confirmation.replay_rejected');
    expect(rejection).toBeDefined();
    expect(rejection?.payload.presented_by).toBe(PRINCIPAL_B);
    expect(rejection?.payload.record_principal).toBe(PRINCIPAL);

    const record = h.store.findOpenByBindings({
      principal: PRINCIPAL,
      tool_name: SHARES_UPDATE.name,
      arguments_hash: argumentsHash(SHARES_UPDATE.name, args),
      plan_id: doc.plan_id,
      idempotency_key: args.idempotency_key as string,
      expected_revision: args.expected_revision as number,
    });
    expect(record?.status).toBe('pending'); // untouched by the stolen-state attempt
  });

  // ── F3 (fix round 1, spec §3.3 gate 2) ────────────────────────────────

  it('F3: an operator identity on an admin-only entry is refused PERMISSION_DENIED ahead of the plan lookup, zero records created', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE);
    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE),
      identity: OPERATOR_IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-rbac',
    });
    const error = errorOf(outcome);
    expect(error.code).toBe('PERMISSION_DENIED');
    expect((error.details as { required_role?: string } | undefined)?.required_role).toBe('admin');
    expect((error.details as { operation?: string } | undefined)?.operation).toBe(
      'filesystems.create',
    );
    expect(h.store.countOpen()).toBe(0);
  });

  // ── F4 (fix round 1) ───────────────────────────────────────────────────

  it('F4: after an awaited url wait settles, the waiters map holds no stale entry for that confirmation', async () => {
    const h = harness({ url_wait_seconds: 1 });
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const args = baseArgs(doc, FS_CREATE, { dangerous: true });
    const first = requireInputRequired(
      await h.service.handle({
        entry: FS_CREATE,
        args,
        identity: IDENTITY,
        client: BOTH_CLIENT,
        correlationId: 'corr-f4-1',
      }),
    );
    const record = h.store.findOpenByBindings({
      principal: PRINCIPAL,
      tool_name: FS_CREATE.name,
      arguments_hash: argumentsHash(FS_CREATE.name, args),
      plan_id: doc.plan_id,
      idempotency_key: args.idempotency_key as string,
      expected_revision: args.expected_revision as number,
    });
    expect(record).not.toBeNull();
    // Approve out of band so awaitOperator's wait loop settles on its very
    // first check (status !== 'pending') — no real waiting involved.
    h.db
      .prepare(
        `UPDATE mcp_confirmations SET status='approved', approved_by='admin:other', approved_at=? WHERE confirmation_id=?`,
      )
      .run(Date.now(), record?.confirmation_id as string);

    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args,
      identity: IDENTITY,
      client: BOTH_CLIENT,
      mrtr: {
        requestState: first.requestState,
        inputResponses: { confirm_apply: { action: 'accept' } },
      },
      correlationId: 'corr-f4-2',
    });
    expect(outcome.kind).toBe('proceed');
    expect(h.service.hasWaiterEntry(record?.confirmation_id as string)).toBe(false);
  });

  // ── A2 (final review I2): early dangerous refusal ──────────────────────
  //
  // The engine's own gate is `plan.risk_level === 'destructive' &&
  // applyReq.dangerous !== true` (engine.ts, §3.4). The service refuses on
  // the SAME condition and no wider one, so no operator approval is ever
  // spent on a call the engine will refuse.

  it('A2: a destructive plan applied without dangerous: true is refused before any record exists', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE), // no dangerous
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-a2-1',
    });
    const error = errorOf(outcome);
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.message).toBe('destructive operation requires dangerous: true');
    expect((error.details as { reason?: string } | undefined)?.reason).toBe(
      'dangerous_flag_required',
    );
    // No record, and therefore no elicitation and no operator to bother.
    expect(h.store.countOpen()).toBe(0);
    expect(h.store.list({ limit: 100 })).toEqual([]);
  });

  it('A2: dangerous: false is refused too (only a literal true satisfies the flag)', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const outcome = await h.service.handle({
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE, { dangerous: false }),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-a2-2',
    });
    expect(errorOf(outcome).details).toMatchObject({ reason: 'dangerous_flag_required' });
    expect(h.store.list({ limit: 100 })).toEqual([]);
  });

  it('A2: the same plan WITH dangerous: true still elicits url mode', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const result = requireInputRequired(
      await h.service.handle({
        entry: FS_CREATE,
        args: baseArgs(doc, FS_CREATE, { dangerous: true }),
        identity: IDENTITY,
        client: BOTH_CLIENT,
        correlationId: 'corr-a2-3',
      }),
    );
    expect(result.inputRequests.confirm_apply?.params.mode).toBe('url');
    expect(h.store.countOpen()).toBe(1);
  });

  it('A2: a url mode caused ONLY by rollback_model: unsupported needs no dangerous flag', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'changing_access',
      rollback_model: 'unsupported',
    });
    const result = requireInputRequired(
      await h.service.handle({
        entry: FS_CREATE,
        args: baseArgs(doc, FS_CREATE), // no dangerous
        identity: IDENTITY,
        client: BOTH_CLIENT,
        correlationId: 'corr-a2-4',
      }),
    );
    expect(result.inputRequests.confirm_apply?.params.mode).toBe('url');
    expect(h.store.countOpen()).toBe(1);
  });

  it("A2: risk_level 'unsupported_rollback' needs no dangerous flag either (the engine does not require one)", async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'unsupported_rollback',
      rollback_model: 'changing_access',
    });
    const result = requireInputRequired(
      await h.service.handle({
        entry: FS_CREATE,
        args: baseArgs(doc, FS_CREATE), // no dangerous
        identity: IDENTITY,
        client: BOTH_CLIENT,
        correlationId: 'corr-a2-5',
      }),
    );
    expect(result.inputRequests.confirm_apply?.params.mode).toBe('url');
    expect(h.store.countOpen()).toBe(1);
  });

  // ── A10 (promotion): a GC-pruned plan is explained, not hidden ─────────

  it('A10: view() on a confirmation whose plan row was pruned explains plan_pruned instead of reading as unknown', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    await h.service.handle({
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE, { dangerous: true }),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-a10',
    });
    const record = h.store.list({ limit: 1 })[0];
    expect(record).toBeDefined();
    const id = record?.confirmation_id as string;
    // GC prunes the plan_only row out from under the confirmation.
    h.db.prepare('DELETE FROM tasks WHERE task_id = ?').run(doc.plan_id);
    let thrown: unknown;
    try {
      h.service.view(id, { principal: PRINCIPAL, client_type: 'rest' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiException);
    const err = thrown as ApiException;
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toEqual({ reason: 'plan_pruned', confirmation_id: id });
    expect(err.remediation).toContain('pruned by GC');
    // The record itself is still listed and still declinable.
    expect(h.store.get(id)?.status).toBe('pending');
  });

  it('A10: an unknown confirmation id still reads as a plain null (no plan_pruned claim)', () => {
    const h = harness();
    expect(h.service.view('no-such-id', { principal: PRINCIPAL, client_type: 'rest' })).toBeNull();
  });

  // ── A3 (final review I1): record-less audit rows are bounded ───────────

  it('A3: 31 tampered requestStates in a minute write 30 audit rows; the 31st is still refused -32602 and is counted as suppressed', async () => {
    const h = harness({}, { audit: true, metrics: true });
    const { doc } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-a' },
    });
    const args = baseArgs(doc, SHARES_UPDATE);
    const input: HandleInput = {
      entry: SHARES_UPDATE,
      args,
      identity: IDENTITY,
      client: BOTH_CLIENT,
      mrtr: { requestState: 'not-a-valid-state' },
      correlationId: 'corr-a3',
    };
    const codes: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      try {
        await h.service.handle(input);
        throw new Error('expected the forged state to be refused');
      } catch (e) {
        expect(e).toBeInstanceOf(McpProtocolError);
        codes.push((e as McpProtocolError).code);
      }
    }
    // Every one of the 31 is refused identically — throttling the audit
    // must never soften the refusal.
    expect(codes).toEqual(new Array(31).fill(INVALID_PARAMS));

    const failures = auditRows(h).filter((r) => r.kind === 'mcp.confirmation.verification_failed');
    expect(failures).toHaveLength(30);

    const rendered = (h.registry as MetricsRegistry).render();
    expect(rendered).toContain(
      'xinas_mcp_confirmation_audit_suppressed_total{event="verification_failed"} 1',
    );
    // The refusal counter kept counting all 31.
    expect(rendered).toMatch(
      /xinas_mcp_confirmations_state_validation_failures_total\{reason="[a-z]+"\} 31/,
    );
  });

  it('A3: the record-less audit bucket is per-principal — a second principal is unaffected', async () => {
    const h = harness({}, { audit: true, metrics: true });
    const { doc } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-a' },
    });
    const forge = async (identity: McpIdentity): Promise<void> => {
      try {
        await h.service.handle({
          entry: SHARES_UPDATE,
          args: baseArgs(doc, SHARES_UPDATE),
          identity,
          client: BOTH_CLIENT,
          mrtr: { requestState: 'garbage' },
          correlationId: 'corr-a3b',
        });
      } catch {
        /* expected */
      }
    };
    for (let i = 0; i < 31; i += 1) await forge(IDENTITY);
    await forge(IDENTITY_B);
    const failures = auditRows(h).filter((r) => r.kind === 'mcp.confirmation.verification_failed');
    // 30 for the first principal + 1 for the second: the second principal
    // starts with a full bucket.
    expect(failures).toHaveLength(31);
    expect(failures.filter((r) => r.payload.principal === PRINCIPAL_B)).toHaveLength(1);
  });

  it('A3: the bucket refills over time — 30 rows, then 30s later another 15 are audited', async () => {
    const h = harness({}, { audit: true, metrics: true });
    const { doc } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-a' },
    });
    const input: HandleInput = {
      entry: SHARES_UPDATE,
      args: baseArgs(doc, SHARES_UPDATE),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      mrtr: { requestState: 'garbage' },
      correlationId: 'corr-a3c',
    };
    const forge = async (): Promise<void> => {
      try {
        await h.service.handle(input);
      } catch {
        /* expected */
      }
    };
    for (let i = 0; i < 40; i += 1) await forge();
    expect(
      auditRows(h).filter((r) => r.kind === 'mcp.confirmation.verification_failed'),
    ).toHaveLength(30);
    h.setClock(1_000_000 + 30_000); // half a minute → half the bucket back
    for (let i = 0; i < 20; i += 1) await forge();
    expect(
      auditRows(h).filter((r) => r.kind === 'mcp.confirmation.verification_failed'),
    ).toHaveLength(45);
  });

  it('A3: capability_missing shares the same bucket and the same suppressed counter', async () => {
    const h = harness({}, { audit: true, metrics: true });
    const noCaps: McpClientInfo = { era: 'modern', elicitation: new Set(), tasks: false };
    for (let i = 0; i < 31; i += 1) {
      const { doc } = seedPlan(h.tasks, SHARES_UPDATE, {
        resource_ref: { kind: 'Resource', id: `share-${i}` },
      });
      try {
        await h.service.handle({
          entry: SHARES_UPDATE,
          args: baseArgs(doc, SHARES_UPDATE),
          identity: IDENTITY,
          client: noCaps,
          correlationId: `corr-a3d-${i}`,
        });
        throw new Error('expected MISSING_REQUIRED_CLIENT_CAPABILITY');
      } catch (e) {
        expect((e as McpProtocolError).code).toBe(MISSING_REQUIRED_CLIENT_CAPABILITY);
      }
    }
    expect(
      auditRows(h).filter((r) => r.kind === 'mcp.confirmation.capability_missing'),
    ).toHaveLength(30);
    expect((h.registry as MetricsRegistry).render()).toContain(
      'xinas_mcp_confirmation_audit_suppressed_total{event="capability_missing"} 1',
    );
  });
});
