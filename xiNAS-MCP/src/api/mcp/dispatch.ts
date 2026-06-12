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
 * Gate verdicts (ADR-0010 §gate):
 *   read                          → allow
 *   plan_apply  mode=plan         → allow
 *   plan_apply  mode=apply        → mcp.allow_apply || MCP_APPLY_DISABLED
 *   direct                        → requires_mcp_apply ? gate : allow
 *
 * Legacy tool names return a structured NOT_IMPLEMENTED naming the
 * replacement so old clients get an actionable error, not a 404.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CATALOG, type CatalogEntry } from './catalog.js';

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

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const text = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const errorResult = (code: string, message: string, details?: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
  isError: true,
});

/** Apply-gate verdict for one call (exported for unit tests). */
export function gateVerdict(
  entry: CatalogEntry,
  args: Record<string, unknown>,
  allowApply: boolean,
): { allowed: boolean; reason?: string } {
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

export function buildMcpServer(opts: DispatcherOptions): Server {
  const server = new Server(
    { name: 'xinas-api-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CATALOG.filter((e) => e.binary !== true).map((e) => ({
      name: e.name,
      description:
        e.status === 'degraded' ? `${e.description} [DEGRADED backend]` : e.description,
      inputSchema: e.input_schema as { type: 'object'; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const entry = CATALOG.find((e) => e.name === name && e.binary !== true);
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
    return text({
      result: envelope.result,
      ...(envelope.warnings !== undefined && envelope.warnings.length > 0
        ? { warnings: envelope.warnings }
        : {}),
    });
  });

  return server;
}
