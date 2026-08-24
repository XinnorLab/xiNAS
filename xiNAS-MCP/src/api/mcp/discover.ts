/**
 * The MCP **modern protocol era** discovery surface (S14,
 * `docs/control-path/s14-mcp-modern-era-spec.md`).
 *
 * `server/discover` replaces the legacy `initialize` handshake for clients
 * speaking MCP `2026-07-28` or later: it is stateless, may be called before
 * anything else, opens no session, and mutates nothing.
 *
 * This is hand-rolled rather than delegated to `@modelcontextprotocol/sdk`
 * because no published SDK implements the modern era — 1.30.0 still tops out
 * at `2025-11-25` and has no `server/discover` at all (s14 §2). The SDK keeps
 * serving the legacy era untouched.
 *
 * `capabilities` is derived from CATALOG — the same table `tools/list` and
 * `tools/call` read — so an advertised capability cannot drift away from the
 * handler that backs it.
 */

import { CATALOG } from './catalog.js';

/**
 * Modern protocol versions this server speaks, in order of preference.
 *
 * Legacy versions (≤ `2025-11-25`) are deliberately absent: they are
 * negotiated through `initialize` and mixing the eras in this field is
 * exactly what the requirement forbids.
 */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;

/**
 * The server's self-reported identity — shared with the legacy
 * `initialize` path so one server never reports two names. Self-reported
 * and unverified; clients must not make security decisions from it.
 */
export const SERVER_INFO = { name: 'xinas-api-mcp', version: '1.0.0' } as const;

/** True when the request's declared protocol version is a modern one. */
export function isModernProtocolVersion(version: unknown): boolean {
  return (
    typeof version === 'string' && (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)
  );
}

/**
 * LLM-facing guidance (requirement §2.4): what this server is for, the
 * permitted scope, the duty to respect the caller's permissions, and the
 * rule for state-changing calls. Deliberately does NOT restate individual
 * tool descriptions — tools/list owns those.
 */
export const INSTRUCTIONS = [
  'xiNAS-MCP is the control-path surface of a xiNAS storage node: use it to',
  'inspect and manage RAID arrays, filesystems, NFS shares, networking, tasks',
  'and node health.',
  'Every call executes as the authenticated principal and is authorized by that',
  "principal's role — a tool being listed does not mean the current caller may",
  'run it, and a permission error must be reported, never worked around.',
  'Operations that change the system are two-phase: call them with mode="plan"',
  'to obtain a diff and a plan_id, show that plan to the operator, and only then',
  'call mode="apply" with the plan_id, idempotency_key and expected_revision from',
  'the plan. Applying through MCP is refused unless the node sets',
  'mcp.allow_apply; treat that refusal as final and route the operator to the',
  'REST API or xinasctl instead of retrying.',
  'Destructive operations additionally require dangerous=true and explicit human',
  'confirmation.',
].join(' ');

/**
 * Capabilities, generated from the operational catalog.
 *
 * Only what is actually served is advertised (requirement §2.4). MCP
 * resources and prompts are deferred by ADR-0010, so they are absent rather
 * than empty. `extensions` is likewise omitted while no MCP extension is
 * implemented — note that xiNAS's own asynchronous task envelope is a REST
 * contract, NOT the `io.modelcontextprotocol/tasks` extension, and claiming
 * it here would be false.
 */
export function buildCapabilities(): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  if (CATALOG.some((e) => e.binary !== true)) capabilities.tools = {};
  return capabilities;
}

export interface DiscoverResult {
  resultType: 'complete';
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  instructions: string;
  ttlMs: number;
  cacheScope: 'public' | 'private';
  _meta: Record<string, unknown>;
}

/**
 * Build the `DiscoverResult`.
 *
 * `ttlMs: 0` — nothing here is safely cacheable: the instructions describe the
 * runtime `mcp.allow_apply` gate, which an operator can flip under a running
 * api, and a client acting on a stale gate would retry an apply that the
 * server will keep refusing.
 *
 * `cacheScope: 'private'` — the endpoint authenticates the caller and resolves
 * a role before answering, so the response is produced inside an authorization
 * context. `public` would assert the answer is identical for every principal.
 */
export function buildDiscoverResult(): DiscoverResult {
  return {
    resultType: 'complete',
    supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
    capabilities: buildCapabilities(),
    instructions: INSTRUCTIONS,
    ttlMs: 0,
    cacheScope: 'private',
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}
