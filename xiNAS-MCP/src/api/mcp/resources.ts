/**
 * MCP Resources on the modern path — the provider seam (S17 §3, D-26).
 *
 * Every slice that serves resources registers a `ResourceProvider`; the
 * modern handler composes them: `resources/list` concatenates in
 * registration order (the S17 feeds first), `resources/read` dispatches to
 * the provider that owns the URI, and `subscriptions/listen` honors only
 * URIs a provider declares subscribable. An unknown URI is `-32602`
 * (`2026-07-28` retired `-32002`) and is never resolved against a path, a
 * URL fetcher or a command.
 *
 * `parseFeedUri` is the allow-list grammar of S17 §4.3 for the
 * `xinas://events/<feed>{?after,limit}` family.
 */

import { FEEDS, FEED_URI_PREFIX, type Feed, feedOfBaseUri } from '../events/types.js';
import { INVALID_PARAMS, McpProtocolError } from './confirmation/errors.js';
import type { McpIdentity } from './dispatch.js';

/** Re-exported so the listen path resolves feeds through the same module as reads. */
export { feedOfBaseUri };

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ReadCtx {
  identity: McpIdentity;
  correlationId: string;
}

export interface ReadResourceResult {
  resultType: 'complete';
  contents: Array<{ uri: string; mimeType: string; text: string; _meta?: Record<string, unknown> }>;
  ttlMs: 0;
  cacheScope: 'private';
}

export interface ResourceProvider {
  list(ctx: ReadCtx): McpResource[];
  templates(ctx: ReadCtx): McpResourceTemplate[];
  /** Whether this provider is the one to ask about `uri` (scheme/prefix ownership). */
  owns(uri: string): boolean;
  read(uri: string, ctx: ReadCtx): ReadResourceResult;
  /** Whether a `subscriptions/listen` filter may name `uri` (base feed URIs only). */
  subscribable(uri: string, ctx: ReadCtx): boolean;
}

/** What the modern handler receives: the providers plus the capability flag. */
export interface ResourcesOptions {
  providers: ResourceProvider[];
  /** True iff the S17 feeds are installed (`resources.subscribe`). */
  subscribe: boolean;
}

export const invalidResourceUri = (): McpProtocolError =>
  new McpProtocolError(INVALID_PARAMS, 'invalid resource uri');

export interface ListResourcesResult {
  resultType: 'complete';
  resources: McpResource[];
  ttlMs: 0;
  cacheScope: 'private';
}

export interface ListTemplatesResult {
  resultType: 'complete';
  resourceTemplates: McpResourceTemplate[];
  ttlMs: 0;
  cacheScope: 'private';
}

/** A `cursor` param on a list request: the server never issued one (V-17). */
function rejectListCursor(params: unknown): void {
  if (typeof params === 'object' && params !== null && 'cursor' in params) {
    throw new McpProtocolError(INVALID_PARAMS, 'invalid params: unknown pagination cursor');
  }
}

export function listResources(
  providers: ResourceProvider[],
  params: unknown,
  ctx: ReadCtx,
): ListResourcesResult {
  rejectListCursor(params);
  return {
    resultType: 'complete',
    resources: providers.flatMap((p) => p.list(ctx)),
    ttlMs: 0,
    cacheScope: 'private',
  };
}

export function listTemplates(
  providers: ResourceProvider[],
  params: unknown,
  ctx: ReadCtx,
): ListTemplatesResult {
  rejectListCursor(params);
  return {
    resultType: 'complete',
    resourceTemplates: providers.flatMap((p) => p.templates(ctx)),
    ttlMs: 0,
    cacheScope: 'private',
  };
}

/**
 * `resources/read`: `params.uri` must be a string; a read never elicits, so
 * `inputResponses` / `requestState` are refused (D-15); then the owning
 * provider answers or the URI is invalid.
 */
export function readResource(
  providers: ResourceProvider[],
  params: unknown,
  ctx: ReadCtx,
): ReadResourceResult {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<
    string,
    unknown
  >;
  if (typeof p.uri !== 'string' || p.uri.length === 0) {
    throw new McpProtocolError(
      INVALID_PARAMS,
      'invalid params: resources/read requires a string uri',
    );
  }
  if (p.inputResponses !== undefined || p.requestState !== undefined) {
    throw new McpProtocolError(
      INVALID_PARAMS,
      'invalid params: resource reads do not accept MRTR fields',
    );
  }
  const owner = providers.find((prov) => prov.owns(p.uri as string));
  if (owner === undefined) throw invalidResourceUri();
  return owner.read(p.uri, ctx);
}

/** True when some provider accepts `uri` in a listen filter. */
export function isSubscribable(providers: ResourceProvider[], uri: string, ctx: ReadCtx): boolean {
  return providers.some((p) => p.owns(uri) && p.subscribable(uri, ctx));
}

// ── the xinas://events/ grammar (S17 §4.3) ──────────────────────────────

export interface FeedUriParts {
  feed: Feed;
  after?: string;
  limit?: number;
}

const CURSOR_RE = /^[A-Za-z0-9_-]{1,256}$/;
const LIMIT_RE = /^[1-9][0-9]{0,2}$/;

/**
 * Parse `xinas://events/<feed>[?after=<cursor>][&limit=<1..500>]`. Every
 * deviation — case, trailing slash, traversal, fragment, unknown or repeated
 * keys, empty pairs, an out-of-range limit — is `-32602` with the fixed
 * message. Percent-encoding is accepted for `after` only.
 */
export function parseFeedUri(uri: string): FeedUriParts {
  if (!uri.startsWith(FEED_URI_PREFIX)) throw invalidResourceUri();
  if (uri.includes('#')) throw invalidResourceUri();
  const rest = uri.slice(FEED_URI_PREFIX.length);
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  const feed = (FEEDS as readonly string[]).includes(path) ? (path as Feed) : null;
  if (feed === null) throw invalidResourceUri();
  const out: FeedUriParts = { feed };
  if (q === -1) return out;
  const query = rest.slice(q + 1);
  if (query.length === 0) throw invalidResourceUri();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) throw invalidResourceUri();
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (key === 'after') {
      if (out.after !== undefined) throw invalidResourceUri();
      let value: string;
      try {
        value = decodeURIComponent(raw);
      } catch {
        throw invalidResourceUri();
      }
      if (!CURSOR_RE.test(value)) throw invalidResourceUri();
      out.after = value;
    } else if (key === 'limit') {
      if (out.limit !== undefined) throw invalidResourceUri();
      if (!LIMIT_RE.test(raw)) throw invalidResourceUri();
      const n = Number(raw);
      if (n < 1 || n > 500) throw invalidResourceUri();
      out.limit = n;
    } else {
      throw invalidResourceUri();
    }
  }
  return out;
}
