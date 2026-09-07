// @vitest-environment node
/**
 * S15 evidence for AC15 ("all protocol examples validate against the MCP
 * 2026-07-28 schema"): every confirmation-flow wire shape validates against
 * the vendored, released schema (`mcp/2026-07-28/schema.json`, draft
 * 2020-12) — same schema file and Ajv setup as `mcp-wire.test.ts` (S17).
 *
 * The two `InputRequiredResult` cases are NOT hand-built: they come out of a
 * real `ConfirmationService.handle()` call over a temp in-memory db with a
 * seeded plan, using the same harness pattern as
 * `../api/mcp/confirmation-service.test.ts`. The
 * `MissingRequiredClientCapabilityError` case goes through the actual
 * production entry point, `modern.ts`'s `handleModernRequest` (the exact
 * function `transport.ts` calls for every modern-era `/mcp` POST) over a
 * client missing the required capability — the response body is the real
 * `{ httpStatus, ...body } = await handleModernRequest(...)` destructure
 * `transport.ts` itself performs, not a hand-typed shape (S15 §11, fix
 * round 1 F1).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
// Ajv publishes CJS-style `export =` types; bridge with a cast like
// contracts.test.ts / mcp-wire.test.ts.
import Ajv2020Import from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConfirmationConfig } from '../../api/config.js';
import { CATALOG, type CatalogEntry } from '../../api/mcp/catalog.js';
import {
  ConfirmationService,
  type HandleInput,
  type McpClientInfo,
} from '../../api/mcp/confirmation/service.js';
import { ConfirmationStore } from '../../api/mcp/confirmation/store.js';
import type { KeyRing } from '../../api/mcp/confirmation/state.js';
import type { DispatcherOptions, McpIdentity } from '../../api/mcp/dispatch.js';
import { handleModernRequest } from '../../api/mcp/modern.js';
import type { ElicitRequestSpec, InputRequiredToolResult } from '../../api/mcp/results.js';
import {
  PLAN_DOCUMENT_SCHEMA,
  type PlanDocument,
  planDocumentHash,
} from '../../api/plan/document.js';
import { TaskStore } from '../../api/tasks/store.js';
import { runMigrations } from '../../state/migrations.js';

// biome-ignore lint/suspicious/noExplicitAny: CJS/ESM interop for ajv
const Ajv2020 = Ajv2020Import as any;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(resolve(here, 'mcp/2026-07-28/schema.json'), 'utf8'));

const NODE_ID = 'node-test';
const HOSTNAME = 'test-host';
const PRINCIPAL = 'admin:demo';
const IDENTITY: McpIdentity = { principal: PRINCIPAL, role: 'admin' };
const BOTH_CLIENT: McpClientInfo = { era: 'modern', elicitation: new Set(['form', 'url']) };
const FORM_ONLY_CLIENT: McpClientInfo = { era: 'modern', elicitation: new Set(['form']) };

const FS_CREATE = CATALOG.find((e) => e.name === 'filesystems.create') as CatalogEntry;
const SHARES_UPDATE = CATALOG.find((e) => e.name === 'shares.update') as CatalogEntry;

function keyRing(): KeyRing {
  return { active: 'k1', keys: new Map([['k1', Buffer.alloc(32, 7)]]) };
}

/** Same construction as `../api/mcp/confirmation-service.test.ts`'s `harness()`. */
function harness(configOverrides: Partial<ResolvedConfirmationConfig> = {}) {
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
  });
  return { store, tasks, service };
}

/** Same construction as `../api/mcp/confirmation-service.test.ts`'s `seedPlan()`. */
function seedPlan(
  tasks: TaskStore,
  entry: CatalogEntry,
  overrides: Partial<PlanDocument> = {},
): { doc: PlanDocument } {
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
  tasks.createPlanOnly({
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
  return { doc };
}

/** Same construction as `../api/mcp/confirmation-service.test.ts`'s `baseArgs()`. */
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

/** The single `ElicitRequestSpec` an `InputRequiredToolResult` carries. */
function onlyRequest(result: InputRequiredToolResult): ElicitRequestSpec {
  const values = Object.values(result.inputRequests);
  expect(values).toHaveLength(1);
  return values[0] as ElicitRequestSpec;
}

describe('S15 wire shapes validate against the vendored MCP 2026-07-28 schema', () => {
  // biome-ignore lint/suspicious/noExplicitAny: ajv instance
  let ajv: any;
  const validateAs = (def: string, value: unknown): string[] => {
    const validate =
      ajv.getSchema(`mcp#/$defs/${def}`) ?? ajv.compile({ $ref: `mcp#/$defs/${def}` });
    return validate(value)
      ? []
      : (validate.errors ?? []).map(
          (e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message ?? ''}`,
        );
  };

  beforeAll(() => {
    ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(SCHEMA, 'mcp');
  });

  it('InputRequiredResult (form) — built by the service', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, SHARES_UPDATE, {
      resource_ref: { kind: 'Resource', id: 'share-a' },
    });
    const input: HandleInput = {
      entry: SHARES_UPDATE,
      args: baseArgs(doc, SHARES_UPDATE),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-form',
    };
    const outcome = await h.service.handle(input);
    if (outcome.kind !== 'input_required') {
      throw new Error(`expected 'input_required', got '${outcome.kind}'`);
    }
    expect(validateAs('InputRequiredResult', outcome.result)).toEqual([]);
    const spec = onlyRequest(outcome.result);
    expect(validateAs('ElicitRequest', spec)).toEqual([]);
    expect(spec.params.mode).toBe('form');
  });

  it('InputRequiredResult (url)', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    const input: HandleInput = {
      entry: FS_CREATE,
      args: baseArgs(doc, FS_CREATE, { dangerous: true }),
      identity: IDENTITY,
      client: BOTH_CLIENT,
      correlationId: 'corr-url',
    };
    const outcome = await h.service.handle(input);
    if (outcome.kind !== 'input_required') {
      throw new Error(`expected 'input_required', got '${outcome.kind}'`);
    }
    expect(validateAs('InputRequiredResult', outcome.result)).toEqual([]);
    const spec = onlyRequest(outcome.result);
    expect(validateAs('ElicitRequest', spec)).toEqual([]);
    expect(spec.params.mode).toBe('url');
  });

  it('the retry ElicitResult examples', () => {
    const examples: unknown[] = [
      { action: 'accept', content: { decision: 'APPLY' } },
      { action: 'accept' },
      { action: 'decline' },
      { action: 'cancel' },
    ];
    for (const example of examples) {
      expect(validateAs('ElicitResult', example)).toEqual([]);
    }
  });

  it('MissingRequiredClientCapabilityError as the transport emits it', async () => {
    const h = harness();
    const { doc } = seedPlan(h.tasks, FS_CREATE, {
      risk_level: 'destructive',
      rollback_model: 'unsupported',
    });
    // Route through the real production entry point instead of hand-copying
    // its catch block. `handleModernRequest` is exactly what transport.ts
    // calls for every modern-era `/mcp` POST — see transport.ts's own
    // `const { httpStatus, ...body } = await handleModernRequest(...)` /
    // `res.status(httpStatus ?? 200).json(body)`, mirrored below. Booting a
    // real HTTP listener (mcp-wire.test.ts's `startServer()` pattern) isn't
    // needed to exercise that: this file's `harness()` already builds a real
    // `ConfirmationService` + plan against a real sqlite db, and
    // `DispatcherOptions.confirmations` accepts that service directly —
    // `handleModernRequest` calls `dispatch.ts`'s `callTool`, which calls
    // `confirmations.handle()` (the same real gate the two
    // `InputRequiredResult` cases above exercise) and lets its thrown
    // `McpProtocolError` propagate into `handleModernRequest`'s own catch
    // block, unmodified.
    const opts: DispatcherOptions = {
      loopback: async () => {
        throw new Error('unreachable: the capability gate must throw before any loopback call');
      },
      loopbackToken: () => 'unused-token',
      allowApply: () => true,
      identity: () => IDENTITY,
      client: FORM_ONLY_CLIENT,
      confirmations: h.service,
    };
    const message = {
      jsonrpc: '2.0',
      id: 'call-cap',
      method: 'tools/call',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'schema-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
        },
        name: FS_CREATE.name,
        // Only `form` is declared above; a destructive plan requires `url`
        // — this is the same scenario as mcp-confirmation.test.ts's "a
        // destructive (url-mode) plan with only form capability is
        // refused" case.
        arguments: baseArgs(doc, FS_CREATE, { dangerous: true }),
      },
    };
    const response = await handleModernRequest(message, opts, 'corr-cap');
    // The same destructure transport.ts performs before answering the HTTP
    // response — `httpStatus` is transport-only and never part of the wire
    // body.
    const { httpStatus, ...body } = response;
    expect(httpStatus).toBe(400);
    expect(body.error?.code).toBe(-32021);
    expect(body.error?.data).toEqual({ requiredCapabilities: { elicitation: { url: {} } } });
    expect(validateAs('MissingRequiredClientCapabilityError', body)).toEqual([]);
  });

  it('a complete CallToolResult with resultType', () => {
    const result = {
      resultType: 'complete',
      content: [{ type: 'text', text: '{}' }],
      isError: true,
    };
    expect(validateAs('CallToolResult', result)).toEqual([]);
  });

  it('ClientCapabilities shapes the server accepts', () => {
    expect(validateAs('ClientCapabilities', { elicitation: {} })).toEqual([]);
    expect(validateAs('ClientCapabilities', { elicitation: { form: {}, url: {} } })).toEqual([]);
  });
});
