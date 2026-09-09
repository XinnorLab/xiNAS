/**
 * MCP Prompts — the provider seam (S19 spec §5.1, D-01).
 *
 * Mirrors the S17 resource-provider seam: every slice that serves prompts
 * registers a `PromptProvider`; the modern handler composes them
 * (`prompts/list` concatenates in registration order, `prompts/get`
 * dispatches to the provider that owns the name) and the legacy SDK server
 * wraps the same two functions. An unknown name, an unknown argument or a
 * malformed value is `-32602` with `data: { argument, reason }` (MCP-03).
 *
 * `prompts/get` reads no live state and mints nothing (ARCH-01): the
 * provider validates by shape only. The one side effect is the audit row
 * of spec §5.7 — the prompt name and the normalized arguments minus the
 * free-text `symptom` (length and sha256 only), queued through the same
 * `AuditSink` the S17 feeds use. `prompts/list` is a static read and
 * writes no row, like `tools/list`.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '../../lib/canonical-json.js';
import type { AuditSink } from '../events/audit.js';
import { INVALID_PARAMS, McpProtocolError } from './confirmation/errors.js';
import type { McpIdentity } from './dispatch.js';

export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPrompt {
  name: string;
  title: string;
  description: string;
  arguments: McpPromptArgument[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

/** What `prompts/get` audits (spec §5.7); never serialized to the client. */
export interface PromptAuditFacts {
  parameters: Record<string, unknown>;
  result_hash_input: string;
  payload: Record<string, unknown>;
}

export interface GetPromptBody {
  description: string;
  messages: PromptMessage[];
  audit?: PromptAuditFacts;
}

export interface PromptCtx {
  identity: McpIdentity;
  correlationId: string;
}

export interface PromptProvider {
  /** Static and cheap: the catalog entries this provider serves. */
  list(ctx: PromptCtx): McpPrompt[];
  /** Whether this provider is the one to ask about `name`. */
  owns(name: string): boolean;
  /** Shape-only validation, then the messages; throws `PromptArgumentError`. */
  get(name: string, args: Record<string, string>, ctx: PromptCtx): GetPromptBody;
}

/** What the modern handler receives: the providers plus the audit sink. */
export interface PromptsOptions {
  providers: PromptProvider[];
  audit?: AuditSink;
}

/** `-32602` with `data: { argument, reason }` (spec §5.3, MCP-03). */
export class PromptArgumentError extends McpProtocolError {
  constructor(argument: string, reason: string) {
    super(INVALID_PARAMS, `invalid params: ${argument}: ${reason}`, {
      data: { argument, reason },
    });
  }
}

export interface ListPromptsResult {
  resultType: 'complete';
  prompts: McpPrompt[];
  ttlMs: 0;
  cacheScope: 'private';
}

export interface GetPromptResult {
  resultType: 'complete';
  description: string;
  messages: PromptMessage[];
}

const sha = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;

/**
 * `prompts/list`: the server never issues a cursor, so one that is present
 * must be empty (spec §5.1; V-17 for resources).
 */
export function listPrompts(
  opts: PromptsOptions,
  params: unknown,
  ctx: PromptCtx,
): ListPromptsResult {
  if (typeof params === 'object' && params !== null && 'cursor' in params) {
    const cursor = (params as { cursor: unknown }).cursor;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      throw new McpProtocolError(INVALID_PARAMS, 'invalid params: unknown pagination cursor');
    }
  }
  return {
    resultType: 'complete',
    prompts: opts.providers.flatMap((p) => p.list(ctx)),
    ttlMs: 0,
    cacheScope: 'private',
  };
}

/**
 * `prompts/get`: `params.name` must name an installed prompt and
 * `params.arguments`, when present, must be an object of string values
 * (the protocol's `{ [key]: string }`); then the owning provider answers.
 */
export function getPrompt(opts: PromptsOptions, params: unknown, ctx: PromptCtx): GetPromptResult {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >;
  if (typeof p.name !== 'string' || p.name.length === 0) {
    throw new PromptArgumentError('name', 'must be a non-empty string');
  }
  const owner = opts.providers.find((prov) => prov.owns(p.name as string));
  if (owner === undefined) throw new PromptArgumentError('name', 'unknown prompt');
  const args: Record<string, string> = {};
  if (p.arguments !== undefined && p.arguments !== null) {
    if (typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
      throw new PromptArgumentError('arguments', 'must be an object of string values');
    }
    for (const [k, v] of Object.entries(p.arguments as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new PromptArgumentError(k, 'must be a string');
      args[k] = v;
    }
  }
  const body = owner.get(p.name, args, ctx);
  if (opts.audit !== undefined && body.audit !== undefined) {
    opts.audit.queue({
      kind: 'mcp.prompts.get',
      principal: ctx.identity.principal,
      client_type: 'mcp',
      request_id: ctx.correlationId,
      parameters_hash: sha(canonicalize(body.audit.parameters)),
      result_hash: sha(body.audit.result_hash_input),
      operation_id: ctx.correlationId,
      payload: body.audit.payload,
    });
  }
  return { resultType: 'complete', description: body.description, messages: body.messages };
}
