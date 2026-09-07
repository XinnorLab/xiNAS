/**
 * The MCP **modern protocol era** request path (S14,
 * `docs/control-path/s14-mcp-modern-era-spec.md`).
 *
 * Modern clients (`2026-07-28`+) carry a per-request `_meta` envelope and use
 * no session at all: `server/discover` replaces `initialize`, and operational
 * calls may go straight out without discovering first. Nothing here is
 * stateful, so the two protocol eras cannot share negotiation state — there
 * is none on this side to share.
 *
 * Every result on this path carries `resultType` (`2026-07-28` `Result.resultType` is mandatory — S14 §5.1). The legacy SDK path is untouched.
 *
 * Methods served: `server/discover`, `resources/list`, `resources/templates/list`,
 * `resources/read` (S17 §4), `tools/list`, `tools/call`, and the
 * `io.modelcontextprotocol/tasks` extension's `tasks/get`, `tasks/update` and
 * `tasks/cancel` (S16 §5.2–§5.4). Everything else, including the
 * deliberately-unimplemented `tasks/list` and `tasks/result` (SEP-2663),
 * falls through to `-32601 Method not found`.
 *
 * This path runs AHEAD of the SDK transport because no published
 * `@modelcontextprotocol/sdk` implements the era: 1.30.0 has no
 * `server/discover` schema, and its StreamableHTTPServerTransport rejects any
 * non-initialize POST that carries no Mcp-Session-Id (s14 §2). The legacy era
 * still goes to the SDK, untouched.
 */

import { type DispatcherOptions, callTool, listTools } from './dispatch.js';
import { McpProtocolError } from './confirmation/errors.js';
import { parseMrtrParams } from './confirmation/policy.js';
import { buildDiscoverResult, isModernProtocolVersion } from './discover.js';
import { listResources, listTemplates, readResource } from './resources.js';
import { type ToolResult, isCreateTaskResult, isInputRequired } from './results.js';
import { missingTasksCapability } from './tasks/index.js';
import {
  CancelTaskParamsSchema,
  GetTaskParamsSchema,
  UpdateTaskParamsSchema,
  parseParams,
} from './tasks/schema.js';

/** JSON-RPC 2.0 reserved codes used on this path. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { _meta?: Record<string, unknown>; [k: string]: unknown };
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: Record<string, unknown> };
  /** S15: the HTTP status transport.ts answers with; stripped from the JSON body. */
  httpStatus?: number;
}

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';

/**
 * Classify an inbound /mcp message.
 *
 * `server/discover` is modern unconditionally — the method exists in no
 * legacy revision, so there is nothing to be ambiguous about. Anything else
 * is modern only when it declares a modern protocol version in `_meta`.
 *
 * An `Mcp-Session-Id` header is NOT consulted: the stdio adapter replays a
 * cached session id on every POST once a legacy session exists, and a modern
 * discover arriving through that same adapter must still be answered
 * statelessly.
 */
export function isModernRequest(message: unknown): boolean {
  const msg = message as JsonRpcRequest | null;
  if (msg === null || typeof msg !== 'object') return false;
  if (msg.method === 'server/discover') return true;
  return isModernProtocolVersion(msg.params?._meta?.[PROTOCOL_VERSION_META]);
}

/**
 * A JSON-RPC notification carries no `id` and MUST NOT be answered with a
 * response object. The stdio adapter already drops responses to id-less
 * messages, but an HTTP client is entitled to an empty 202 — matching what
 * the SDK transport does for the legacy era.
 */
export function isNotification(message: unknown): boolean {
  const msg = message as JsonRpcRequest | null;
  return msg !== null && typeof msg === 'object' && msg.id === undefined;
}

/** The JSON-RPC envelope `id` (or `null` for a notification / non-object message). */
export function rpcIdOf(message: unknown): string | number | null {
  const raw = (message as JsonRpcRequest | null)?.id;
  return typeof raw === 'string' || typeof raw === 'number' ? raw : null;
}

/**
 * Handle one modern-era request. The caller has already authenticated;
 * `opts.identity()` is the resolved principal.
 *
 * Authentication is deliberately NOT this function's job: an unauthenticated
 * caller must get a 401, never `Method not found`, because `-32601` on
 * `server/discover` is the one signal a client is entitled to read as "this
 * server is legacy-only" and downgrade on (requirement §2.5.7-8).
 *
 * `correlationId` is the server-owned correlation id for THIS HTTP request
 * (fix round 1, F5) — never the JSON-RPC envelope `id`, which is
 * client-chosen and unbounded (S15 §7.3/§12.1 audit rows, and
 * `mcp_confirmations.correlation_id`, must never carry it verbatim).
 */
export async function handleModernRequest(
  message: unknown,
  opts: DispatcherOptions,
  correlationId: string,
): Promise<JsonRpcResponse> {
  const msg = message as JsonRpcRequest;
  const rpcId = rpcIdOf(message);

  try {
    switch (msg.method) {
      case 'server/discover':
        // Stateless, read-only, repeatable: no session is created and no
        // xiNAS state is touched — the result is built from the catalog and
        // the installed resource surface (S17 §3).
        return {
          jsonrpc: '2.0',
          id: rpcId,
          result: buildDiscoverResult(
            opts.resources !== undefined
              ? { resources: { subscribe: opts.resources.subscribe } }
              : {},
          ),
        };

      // S17 §4 — Resources (modern era only; the legacy SDK path is untouched).
      case 'resources/list':
      case 'resources/templates/list':
      case 'resources/read': {
        if (opts.resources === undefined) break; // → -32601 below
        const readCtx = { identity: opts.identity(), correlationId };
        const result =
          msg.method === 'resources/list'
            ? listResources(opts.resources.providers, msg.params, readCtx)
            : msg.method === 'resources/templates/list'
              ? listTemplates(opts.resources.providers, msg.params, readCtx)
              : readResource(opts.resources.providers, msg.params, readCtx);
        return { jsonrpc: '2.0', id: rpcId, result };
      }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: rpcId,
          result: { resultType: 'complete', tools: listTools() },
        };

      case 'tools/call': {
        const params = (msg.params ?? {}) as {
          name?: unknown;
          arguments?: Record<string, unknown>;
        };
        if (typeof params.name !== 'string') {
          return {
            jsonrpc: '2.0',
            id: rpcId,
            error: { code: -32602, message: 'invalid params: tools/call requires a string name' },
          };
        }
        // S15 §4/§7: a confirmable retry echoes requestState/inputResponses
        // in the SAME tools/call params (no separate elicitation method) —
        // parse them here so dispatch.ts stays transport-agnostic.
        const mrtr = parseMrtrParams(msg.params);
        const result = await callTool(params.name, params.arguments ?? {}, opts, {
          ...mrtr,
          correlationId,
        });
        // A CreateTaskResult carries its own `resultType: 'task'` and must
        // NOT be stamped `complete`, same as an input_required result.
        if (isInputRequired(result) || isCreateTaskResult(result)) {
          return { jsonrpc: '2.0', id: rpcId, result };
        }
        return { jsonrpc: '2.0', id: rpcId, result: { ...result, resultType: 'complete' } };
      }

      // S16 §5.2–§5.4 — the io.modelcontextprotocol/tasks methods (modern era only).
      case 'tasks/get':
      case 'tasks/update':
      case 'tasks/cancel':
        return {
          jsonrpc: '2.0',
          id: rpcId,
          result: await handleTaskMethod(msg.method, msg.params, opts, correlationId),
        };

      default:
        break;
    }
    // S16: `tasks/list` and `tasks/result` are deliberately absent
    // (SEP-2663) and land here like any other unimplemented method.
    return {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: METHOD_NOT_FOUND,
        message: `method not found: ${String(msg.method)}`,
      },
    };
  } catch (err) {
    if (err instanceof McpProtocolError) {
      return {
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: err.code,
          message: err.message,
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
        httpStatus: err.httpStatus,
      };
    }
    return {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: INTERNAL_ERROR,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * S16 §5.2–§5.4: the extension's three methods. Capability first (-32021,
 * before anything about the task is learned), then shape (-32602), then
 * the service's ownership + projection rules. `tasks/list` and
 * `tasks/result` are deliberately absent (SEP-2663) and fall to -32601.
 */
async function handleTaskMethod(
  method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
  params: unknown,
  opts: DispatcherOptions,
  correlationId: string,
): Promise<unknown> {
  if (opts.client.tasks !== true) throw missingTasksCapability();
  if (opts.tasks === undefined) {
    throw new McpProtocolError(
      INTERNAL_ERROR,
      'tasks extension unavailable (api has no task engine)',
    );
  }
  const ctx = { identity: opts.identity(), correlationId };
  switch (method) {
    case 'tasks/get':
      return opts.tasks.get(parseParams(GetTaskParamsSchema, params).taskId, ctx);
    case 'tasks/update': {
      const p = parseParams(UpdateTaskParamsSchema, params);
      return opts.tasks.update(
        p.taskId,
        p.inputResponses as Record<string, Record<string, unknown>>,
        ctx,
      );
    }
    case 'tasks/cancel': {
      const p = parseParams(CancelTaskParamsSchema, params);
      return opts.tasks.cancel(p.taskId, ctx, async () => {
        // tasks.cancel is neither confirmable nor task-eligible: always a ToolResult.
        const r = await callTool('tasks.cancel', { id: p.taskId }, opts, { correlationId });
        return r as ToolResult;
      });
    }
  }
}
