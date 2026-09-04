import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { ResolvedConfirmationConfig } from '../../../api/config.js';
import { CATALOG, type CatalogEntry } from '../../../api/mcp/catalog.js';
import type { McpIdentity } from '../../../api/mcp/dispatch.js';
import {
  ConfirmationService,
  type HandleInput,
  type HandleOutcome,
  type McpClientInfo,
} from '../../../api/mcp/confirmation/service.js';
import { ConfirmationStore } from '../../../api/mcp/confirmation/store.js';
import type { KeyRing } from '../../../api/mcp/confirmation/state.js';
import type { InputRequiredToolResult, ToolResult } from '../../../api/mcp/results.js';
import { argumentsHash } from '../../../api/mcp/confirmation/policy.js';
import {
  PLAN_DOCUMENT_SCHEMA,
  type PlanDocument,
  planDocumentHash,
} from '../../../api/plan/document.js';
import { TaskStore } from '../../../api/tasks/store.js';
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
const IDENTITY: McpIdentity = { principal: PRINCIPAL, role: 'admin' };
const BOTH_CLIENT: McpClientInfo = { era: 'modern', elicitation: new Set(['form', 'url']) };

const FS_CREATE = CATALOG.find((e) => e.name === 'filesystems.create') as CatalogEntry;
const SHARES_UPDATE = CATALOG.find((e) => e.name === 'shares.update') as CatalogEntry;

function keyRing(): KeyRing {
  return { active: 'k1', keys: new Map([['k1', Buffer.alloc(32, 7)]]) };
}

interface Harness {
  store: ConfirmationStore;
  tasks: TaskStore;
  service: ConfirmationService;
  setClock(v: number): void;
}

function harness(
  configOverrides: Partial<ResolvedConfirmationConfig> = {},
  serviceOverrides: { sleep?: (ms: number) => Promise<void> } = {},
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
  const service = new ConfirmationService({
    store,
    tasks,
    keyRing: keyRing(),
    config,
    now: () => clock,
    nodeId: NODE_ID,
    hostname: HOSTNAME,
    ...(serviceOverrides.sleep !== undefined ? { sleep: serviceOverrides.sleep } : {}),
  });
  return {
    store,
    tasks,
    service,
    setClock(v: number) {
      clock = v;
    },
  };
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
});
