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
 * This path runs AHEAD of the SDK transport because no published
 * `@modelcontextprotocol/sdk` implements the era: 1.30.0 has no
 * `server/discover` schema, and its StreamableHTTPServerTransport rejects any
 * non-initialize POST that carries no Mcp-Session-Id (s14 §2). The legacy era
 * still goes to the SDK, untouched.
 */

import { type DispatcherOptions, callTool, listTools } from './dispatch.js';
import { buildDiscoverResult, isModernProtocolVersion } from './discover.js';

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
  error?: { code: number; message: string };
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

const id = (message: unknown): string | number | null => {
  const raw = (message as JsonRpcRequest | null)?.id;
  return typeof raw === 'string' || typeof raw === 'number' ? raw : null;
};

/**
 * Handle one modern-era request. The caller has already authenticated;
 * `opts.identity()` is the resolved principal.
 *
 * Authentication is deliberately NOT this function's job: an unauthenticated
 * caller must get a 401, never `Method not found`, because `-32601` on
 * `server/discover` is the one signal a client is entitled to read as "this
 * server is legacy-only" and downgrade on (requirement §2.5.7-8).
 */
export async function handleModernRequest(
  message: unknown,
  opts: DispatcherOptions,
): Promise<JsonRpcResponse> {
  const msg = message as JsonRpcRequest;
  const rpcId = id(message);

  try {
    switch (msg.method) {
      case 'server/discover':
        // Stateless, read-only, repeatable: no session is created and no
        // xiNAS state is touched — the result is built from the catalog.
        return { jsonrpc: '2.0', id: rpcId, result: buildDiscoverResult() };

      case 'tools/list':
        return { jsonrpc: '2.0', id: rpcId, result: { tools: listTools() } };

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
        const result = await callTool(params.name, params.arguments ?? {}, opts);
        return { jsonrpc: '2.0', id: rpcId, result };
      }

      default:
        return {
          jsonrpc: '2.0',
          id: rpcId,
          error: {
            code: METHOD_NOT_FOUND,
            message: `method not found: ${String(msg.method)}`,
          },
        };
    }
  } catch (err) {
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
