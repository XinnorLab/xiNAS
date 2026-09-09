/**
 * MCP dispatcher + apply gate (S8 T6, ADR-0010).
 *
 * Builds an SDK Server whose tools/list and tools/call derive from the
 * declarative catalog. A tool call is GATED (catalog metadata — never
 * body inference), then translated into a loopback HTTP request
 * against the api's own routes carrying the caller's REAL identity
 * via the forwarded headers under the ephemeral loopback bearer —
 * one auth/RBAC/audit spine, exactly one audit row per call.
 *
 * Gate verdicts (ADR-0010 §gate; S8 §4):
 *   read                          → allow
 *   read + escalation (G-04)      → escalating value: mcp.allow_apply || MCP_APPLY_DISABLED
 *   plan_apply  mode=plan         → allow
 *   plan_apply  mode=apply        → mcp.allow_apply || MCP_APPLY_DISABLED
 *   direct                        → requires_mcp_apply ? gate : allow
 *
 * Legacy tool names return a structured NOT_IMPLEMENTED naming the
 * replacement so old clients get an actionable error, not a 404.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { randomUUID } from 'node:crypto';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CATALOG, type CatalogEntry, isEscalated, mcpVisible } from './catalog.js';
import {
  MCP_UI_EXTENSION,
  RAID_CREATE_APP_URI,
  listAppResources,
  mcpUiExtensionCapability,
  readAppResource,
} from './apps.js';
import type { McpClientInfo, ConfirmationService } from './confirmation/service.js';
import { isConfirmable, type MrtrParams } from './confirmation/policy.js';
import { McpProtocolError } from './confirmation/errors.js';
import { SERVER_INFO } from './discover.js';
import { type PromptsOptions, getPrompt, listPrompts } from './prompts.js';
import type { ResourcesOptions } from './resources.js';
import type { McpTasksService } from './tasks/service.js';
import {
  type CreateTaskToolResult,
  type InputRequiredToolResult,
  type ToolResult,
  errorResult,
  isCreateTaskResult,
  isInputRequired,
  text,
} from './results.js';

export type { ToolResult } from './results.js';

export interface LoopbackRequest {
  method: string;
  path: string; // includes /api/v1 prefix and query string
  headers: Record<string, string>;
  body?: unknown;
}

export interface LoopbackResponse {
  status: number;
  body: unknown;
}

export type LoopbackFn = (req: LoopbackRequest) => Promise<LoopbackResponse>;

export interface McpIdentity {
  principal: string;
  role: 'viewer' | 'operator' | 'admin';
}

export interface DispatcherOptions {
  loopback: LoopbackFn;
  loopbackToken: () => string | undefined;
  allowApply: () => boolean;
  identity: () => McpIdentity;
  /** S15: the calling client's protocol era + declared elicitation capabilities. */
  client: McpClientInfo;
  /** S15: absent when the api has no task engine (read-only contexts). */
  confirmations?: ConfirmationService;
  /**
   * S17: the modern-era resource providers (the event feeds, plus any other
   * slice's resources). Absent when no journal is installed or
   * `mcp.subscriptions.enabled` is false — the methods then answer -32601
   * and discovery advertises no `resources`.
   */
  resources?: ResourcesOptions;
  /** S16: the task-method service; absent in read-only contexts (no ctx.tasks). */
  tasks?: McpTasksService;
  /**
   * S19b §5.1: the prompt providers (the `xinas_health_check` prompt).
   * Absent when `mcp.health_prompt.enabled` is false — both eras then
   * answer -32601 and neither advertises `prompts`.
   */
  prompts?: PromptsOptions;
}

/** Legacy tool name → replacement pointer (ADR-0010: actionable errors). */
export const LEGACY_TOOL_MAP: Record<string, string> = {
  'raid.list': 'arrays.list',
  'raid.create': 'arrays.create',
  'raid.modify_performance': 'arrays.modify',
  'raid.delete': 'arrays.delete',
  'raid.restore': 'arrays.import',
  'share.list': 'shares.list',
  'share.create': 'shares.create',
  'share.update_policy': 'shares.update',
  'share.delete': 'shares.delete',
  'share.get_active_sessions': 'nfs_sessions.list',
  'health.run_check': 'health.check',
  'disk.list': 'disks.list',
  'disk.get_smart': 'disks.get',
  'system.get_status': 'system.get',
  'system.get_logs': 'system.logs',
  'system.get_performance': 'system.performance',
  'auth.list_users': 'users.list',
  'auth.list_quotas': 'quotas.list',
  'auth.get_supported_modes': 'auth.modes',
  'mail.list_recipients': 'mail.recipients',
  'mail.get_settings': 'mail.settings',
  'pool.list': 'pools.list',
  'job.get': 'tasks.get',
  'job.list': 'tasks.list',
  'job.cancel': 'tasks.cancel',
  'config.check_drift': 'drift.report',
  'config.list_snapshots': 'config_history.snapshots',
};

/** Legacy mutators with NO Phase-0 replacement (returns in a later phase). */
export const RETIRED_TOOL_PREFIXES = ['auth.', 'mail.', 'pool.', 'disk.', 'network.configure'];

/** An MCP tool descriptor as tools/list returns it. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  _meta?: { ui: { resourceUri: string; visibility?: Array<'model' | 'app'> } };
}

/** Apply-gate verdict for one call (exported for unit tests). */
export function gateVerdict(
  entry: CatalogEntry,
  args: Record<string, unknown>,
  allowApply: boolean,
): { allowed: boolean; reason?: string } {
  // G-04 (S8 §3): an escalated call is apply-class whatever the entry's
  // mutability — checked first so a read entry cannot pass on its class.
  const esc = entry.escalation;
  if (esc !== undefined && esc.requires_mcp_apply && isEscalated(entry, args) && !allowApply) {
    return {
      allowed: false,
      reason:
        `${entry.name} ${esc.arg}=${esc.value} ${esc.reason} and requires mcp.allow_apply: true ` +
        `in the api config; run it via REST/xinasctl with an ${esc.min_role} token, or choose another ${esc.arg}`,
    };
  }
  if (entry.mutability === 'read') return { allowed: true };
  if (entry.mutability === 'direct') {
    if (!entry.requires_mcp_apply || allowApply) return { allowed: true };
    return { allowed: false, reason: `${entry.name} requires mcp.allow_apply: true` };
  }
  // plan_apply
  if (args.mode !== 'apply') return { allowed: true };
  if (allowApply) return { allowed: true };
  return {
    allowed: false,
    reason: `mode=apply via MCP requires mcp.allow_apply: true in the api config; run mode=plan here, or apply via REST/xinasctl`,
  };
}

/** Substitute {params} from args; remaining args become query (GET) or body. */
export function buildRequest(
  entry: CatalogEntry,
  args: Record<string, unknown>,
): { path: string; body?: unknown } {
  const used = new Set<string>();
  const path = entry.path.replaceAll(/\{([^}]+)\}/g, (_m, name: string) => {
    used.add(name);
    const v = args[name];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`missing required path parameter '${name}'`);
    }
    return encodeURIComponent(v);
  });
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
  if (entry.method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const q = qs.toString();
    return { path: `/api/v1${path}${q.length > 0 ? `?${q}` : ''}` };
  }
  return { path: `/api/v1${path}`, body: rest };
}

/** Task states from which more progress is still expected. */
const LIVE_TASK_STATES: ReadonlySet<string> = new Set(['queued', 'running']);

/**
 * The "what do I call next" pointer for a call that started a task.
 *
 * The /mcp transport runs in JSON response mode — there is no server-push
 * stream, so a client cannot be *told* about progress; it has to ask.
 * Attaching the exact follow-up call to the result is what turns a bare
 * task_id into something a client will actually follow. Gated on the catalog's
 * `returns_async_task` flag, NOT on `mutability`: support.bundle is a direct
 * tool that returns a Task envelope (exported for unit tests).
 */
export function nextHint(
  entry: CatalogEntry,
  result: unknown,
): Record<string, unknown> | undefined {
  if (entry.returns_async_task !== true) return undefined;
  const task = result as { task_id?: unknown; state?: unknown } | null;
  if (typeof task?.task_id !== 'string') return undefined;
  if (typeof task.state !== 'string' || !LIVE_TASK_STATES.has(task.state)) return undefined;
  return {
    tool: 'tasks.wait',
    args: { id: task.task_id, timeout_s: 25 },
    note: 'long-running operation — call this repeatedly until state is terminal (success, failed, cancelled, requires_manual_recovery)',
  };
}

/** S16 §4.2 steps 1–4: may this call answer with a CreateTaskResult? */
export function isTaskEligible(
  entry: CatalogEntry,
  args: Record<string, unknown>,
  opts: Pick<DispatcherOptions, 'client'>,
): boolean {
  if (entry.creates_task !== true) return false;
  if (entry.mutability === 'plan_apply' && args.mode !== 'apply') return false;
  return opts.client.era === 'modern' && opts.client.tasks === true;
}

/**
 * `tools/list`, independent of any transport or protocol era.
 *
 * Extracted from the SDK request handler so the stateless modern-era path
 * (modern.ts) and the legacy SDK session path call the SAME code: one tool
 * list, one dispatcher, one gate. A second implementation is how the two
 * eras would start disagreeing about what the server can do.
 */
export function listTools(): McpTool[] {
  return CATALOG.filter(mcpVisible).map((e) => {
    // Generated from the catalog flag rather than written into twenty
    // description strings — the fact a call is asynchronous is what tells a
    // client to expect a task_id instead of a finished result.
    const asyncClause =
      e.returns_async_task === true
        ? ' Returns a task_id and executes asynchronously — follow it with tasks.wait.'
        : '';
    // G-04: the escalation clause is generated from the same field the gate
    // and the REST RBAC rank read, so the description cannot drift from them.
    const esc = e.escalation;
    const escalationClause =
      esc !== undefined
        ? ` ${esc.arg}=${esc.value} ${esc.reason}; it requires the ${esc.min_role} role` +
          `${esc.requires_mcp_apply ? ' and mcp.allow_apply: true' : ''}.`
        : '';
    return {
      name: e.name,
      description:
        (e.status === 'degraded' ? `${e.description} [DEGRADED backend]` : e.description) +
        asyncClause +
        escalationClause,
      inputSchema: e.input_schema as { type: 'object'; [k: string]: unknown },
      ...(e.ui !== undefined ? { _meta: { ui: { ...e.ui } } } : {}),
    };
  });
}

/** `tools/call`, independent of any transport or protocol era (see listTools). */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: DispatcherOptions,
  mrtr: MrtrParams & { correlationId?: string } = {},
): Promise<ToolResult | InputRequiredToolResult | CreateTaskToolResult> {
  const entry = CATALOG.find((e) => e.name === name && mcpVisible(e));
  if (entry === undefined) {
    const replacement = LEGACY_TOOL_MAP[name];
    if (replacement !== undefined) {
      return errorResult(
        'NOT_IMPLEMENTED',
        `'${name}' was retired with the legacy MCP server (ADR-0010); use '${replacement}'`,
        { replacement },
      );
    }
    if (RETIRED_TOOL_PREFIXES.some((p) => name.startsWith(p))) {
      return errorResult(
        'NOT_IMPLEMENTED',
        `'${name}' has no Phase 0 control-path backing; it returns in a later phase (ADR-0010)`,
      );
    }
    return errorResult('NOT_FOUND', `unknown tool '${name}'`);
  }

  const verdict = gateVerdict(entry, args, opts.allowApply());
  if (!verdict.allowed) {
    return errorResult('MCP_APPLY_DISABLED', verdict.reason ?? 'apply via MCP is disabled', {
      config_key: 'mcp.allow_apply',
    });
  }

  // S15 §3.1/§3.3 — confirmable calls go through the confirmation service.
  let confirmationId: string | undefined;
  if (isConfirmable(entry, args)) {
    if (opts.client.era !== 'modern') {
      return errorResult(
        'MCP_CONFIRMATION_UNSUPPORTED',
        'mode=apply over MCP requires MCP 2026-07-28 with elicitation support; apply via REST, xinasctl or the TUI instead',
        { required: 'MCP 2026-07-28 with elicitation', alternatives: ['REST', 'xinasctl', 'TUI'] },
      );
    }
    if (opts.confirmations === undefined) {
      return errorResult('INTERNAL', 'confirmation service unavailable (api not fully started)');
    }
    const identity = opts.identity();
    const outcome = await opts.confirmations.handle({
      entry,
      args,
      identity,
      client: opts.client,
      ...(mrtr.inputResponses !== undefined || mrtr.requestState !== undefined
        ? {
            mrtr: {
              ...(mrtr.inputResponses !== undefined ? { inputResponses: mrtr.inputResponses } : {}),
              ...(mrtr.requestState !== undefined ? { requestState: mrtr.requestState } : {}),
            },
          }
        : {}),
      correlationId: mrtr.correlationId ?? 'mcp',
    });
    if (outcome.kind !== 'proceed') return outcome.result;
    confirmationId = outcome.confirmation_id;
  }

  let req: { path: string; body?: unknown };
  try {
    req = buildRequest(entry, args);
  } catch (err) {
    return errorResult('INVALID_ARGUMENT', err instanceof Error ? err.message : String(err));
  }

  const token = opts.loopbackToken();
  if (token === undefined) {
    return errorResult('INTERNAL', 'loopback token unavailable (api not fully started)');
  }
  const identity = opts.identity();
  const response = await opts.loopback({
    method: entry.method,
    path: req.path,
    headers: {
      authorization: `Bearer ${token}`,
      'x-xinas-forwarded-principal': identity.principal,
      'x-xinas-forwarded-role': identity.role,
      'x-xinas-client-type': 'mcp',
      ...(confirmationId !== undefined ? { 'x-xinas-confirmation': confirmationId } : {}),
      ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(req.body !== undefined ? { body: req.body } : {}),
  });

  const envelope = response.body as {
    result?: unknown;
    warnings?: unknown[];
    errors?: Array<{ code?: string; message?: string; details?: unknown }>;
  };
  if (response.status >= 400) {
    const first = envelope.errors?.[0];
    return errorResult(
      first?.code ?? 'INTERNAL',
      first?.message ?? `HTTP ${response.status}`,
      first?.details,
    );
  }
  // S16 §4.2 steps 5–7: the handle is projected from the COMMITTED row the
  // REST apply just returned; anything short of that falls back below.
  if (isTaskEligible(entry, args, opts) && opts.tasks !== undefined) {
    const taskId = (envelope.result as { task_id?: unknown } | null)?.task_id;
    if (typeof taskId === 'string') {
      const handle = opts.tasks.handleFor(
        taskId,
        { identity, correlationId: mrtr.correlationId ?? 'mcp' },
        {
          tool_name: entry.name,
          // Review F2: the handle path returns before the fallback below
          // builds `text({ result, warnings })` — forward the same
          // envelope warnings (e.g. EXECUTOR_DEGRADED) so they are not
          // silently dropped for clients that declared the tasks extension.
          ...(envelope.warnings !== undefined && envelope.warnings.length > 0
            ? { warnings: envelope.warnings }
            : {}),
        },
      );
      if (handle !== null) return handle;
    }
  }

  const next = nextHint(entry, envelope.result);
  return text({
    result: envelope.result,
    ...(envelope.warnings !== undefined && envelope.warnings.length > 0
      ? { warnings: envelope.warnings }
      : {}),
    ...(next !== undefined ? { next } : {}),
  });
}

/**
 * S19b §5.6: a prompt-path protocol error re-thrown as the SDK's McpError so
 * the legacy wire carries `-32602` with the same `data: { argument, reason }`.
 */
function legacyPrompt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof McpProtocolError) throw new McpError(err.code, err.message, err.data);
    throw err;
  }
}

/** The legacy-era SDK server: a thin wiring of listTools/callTool. */
export function buildMcpServer(opts: DispatcherOptions): Server {
  const server = new Server(
    { ...SERVER_INFO },
    {
      capabilities: {
        tools: {},
        resources: {},
        // S19b §4.2: present iff the provider is installed, like the modern era.
        ...(opts.prompts !== undefined ? { prompts: { listChanged: false } } : {}),
        extensions: { [MCP_UI_EXTENSION]: mcpUiExtensionCapability() },
      },
    },
  );

  // S19b §5.6: the legacy shapes (no resultType / ttlMs / cacheScope) built
  // from the same provider output the modern era serves. The legacy path has
  // no server-owned per-request correlation id (transport.ts mints one only
  // on the modern path), so the audit row's request_id is minted here.
  if (opts.prompts !== undefined) {
    const prompts = opts.prompts;
    const promptCtx = () => ({ identity: opts.identity(), correlationId: randomUUID() });
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      const r = legacyPrompt(() => listPrompts(prompts, request.params, promptCtx()));
      return { prompts: r.prompts };
    });
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const r = legacyPrompt(() => getPrompt(prompts, request.params, promptCtx()));
      return { description: r.description, messages: r.messages };
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listAppResources(),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== RAID_CREATE_APP_URI) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `unknown MCP App resource: ${request.params.uri}`,
      );
    }
    return readAppResource(request.params.uri);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const r = await callTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      opts,
    );
    // Legacy clients are denied confirmable calls before the service ever
    // runs (era !== 'modern' above) — an input_required result reaching
    // here would mean that gate was bypassed. Likewise a CreateTaskResult:
    // isTaskEligible requires era === 'modern' && client.tasks === true, and
    // legacy clients never declare the extension (client.tasks is false on
    // this path) — either result reaching here means a gate was bypassed.
    if (isInputRequired(r) || isCreateTaskResult(r)) {
      throw new Error('unreachable: legacy path received a modern-only result');
    }
    return r;
  });

  return server;
}
