/**
 * `subscriptions/listen` on the modern path (S17 §5.1–§5.4): request
 * validation, filter acceptance, and the Streamable HTTP SSE stream that
 * carries the subscription — acknowledgment first, then
 * `notifications/resources/updated` wake-ups, SSE-comment keep-alives while
 * idle, and the graceful `subscriptions/listen` result on shutdown.
 *
 * The registry (`events/subscriptions.ts`) owns the lifecycle; this module
 * is the HTTP binding of a `ListenerSink`. Every pre-acknowledgment failure
 * is an ordinary JSON response, so a rejected listen never leaves a partial
 * stream (SUBS-LIMIT-001).
 */

import type { Request, Response } from 'express';
import type { ResolvedSubscriptionsConfig } from '../config.js';
import type { SubscriptionRegistry } from '../events/subscriptions.js';
import { type Feed, feedOfBaseUri as feedOf } from '../events/types.js';
import { INVALID_PARAMS, McpProtocolError } from './confirmation/errors.js';
import type { McpIdentity } from './dispatch.js';
import { type ReadCtx, type ResourceProvider, isSubscribable } from './resources.js';

/** The released `SubscriptionFilter` (schema.ts `2026-07-28`). */
export interface ListenFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

const PARAM_KEYS = new Set(['_meta', 'notifications']);
const FILTER_KEYS = new Set([
  'toolsListChanged',
  'promptsListChanged',
  'resourcesListChanged',
  'resourceSubscriptions',
]);
const BOOL_KEYS = ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'] as const;

const invalid = (message: string): McpProtocolError =>
  new McpProtocolError(INVALID_PARAMS, `invalid params: ${message}`);

/**
 * SUBS-LISTEN-001: exactly the released schema, nothing xiNAS-specific.
 * `resourceSubscriptions` is de-duplicated (first occurrence wins) and
 * capped at `maxUris` AFTER de-duplication.
 */
export function validateListenParams(params: unknown, maxUris: number): ListenFilter {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalid('subscriptions/listen requires a params object');
  }
  for (const key of Object.keys(params)) {
    if (!PARAM_KEYS.has(key)) throw invalid(`unknown key ${key}`);
  }
  const n = (params as { notifications?: unknown }).notifications;
  if (typeof n !== 'object' || n === null || Array.isArray(n)) {
    throw invalid('notifications must be an object');
  }
  const filter = n as Record<string, unknown>;
  for (const key of Object.keys(filter)) {
    if (!FILTER_KEYS.has(key)) throw invalid(`unknown notification type ${key}`);
  }
  const out: ListenFilter = {};
  for (const key of BOOL_KEYS) {
    const v = filter[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw invalid(`${key} must be a boolean`);
    out[key] = v;
  }
  if (filter.resourceSubscriptions !== undefined) {
    const rs = filter.resourceSubscriptions;
    if (!Array.isArray(rs)) throw invalid('resourceSubscriptions must be an array of URIs');
    const seen: string[] = [];
    for (const entry of rs) {
      if (typeof entry !== 'string') throw invalid('resourceSubscriptions entries must be strings');
      if (!seen.includes(entry)) seen.push(entry);
    }
    if (seen.length > maxUris) throw invalid('too many resource subscriptions');
    out.resourceSubscriptions = seen;
  }
  return out;
}

/**
 * SUBS-LISTEN-002: the accepted subset — base feed URIs a provider declares
 * subscribable and the principal may read. Unknown and unauthorized entries
 * are dropped alike (no enumeration oracle).
 */
export function acceptFeeds(
  filter: ListenFilter,
  providers: ResourceProvider[],
  ctx: ReadCtx,
): Feed[] {
  const out: Feed[] = [];
  for (const uri of filter.resourceSubscriptions ?? []) {
    const feed = feedOf(uri);
    if (feed === null || out.includes(feed)) continue;
    if (!isSubscribable(providers, uri, ctx)) continue;
    out.push(feed);
  }
  return out;
}

export interface OpenHttpListenOptions {
  req: Request;
  res: Response;
  id: string | number;
  feeds: Feed[];
  identity: McpIdentity;
  reauthorize: () => boolean;
  registry: SubscriptionRegistry;
  config: ResolvedSubscriptionsConfig;
  correlationId: string;
}

/** Wire-format one SSE frame: one JSON-RPC message per `data:` line. */
export const sseFrame = (message: unknown): string =>
  `event: message\ndata: ${JSON.stringify(message)}\n\n`;

/**
 * Open the SSE stream for an already-validated listen. The response headers
 * are written lazily, on the first message, so a limit refusal inside
 * `registry.open()` can still be answered as JSON by the caller.
 */
export function openHttpListen(
  opts: OpenHttpListenOptions,
): { ok: true } | { ok: false; reason: 'principal_limit' | 'process_limit' } {
  const { res, registry, config } = opts;
  let headersSent = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const ensureHeaders = (): void => {
    if (headersSent) return;
    headersSent = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // The stream owns this connection: `close` tells a keep-alive client not
    // to reuse the socket after the stream ends, so a graceful end never
    // races the client's next request into a half-closed socket.
    res.setHeader('Connection', 'close');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Correlation-ID', opts.correlationId);
    res.flushHeaders();
    keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, config.keepalive_ms);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();
  };
  const stopKeepAlive = (): void => {
    if (keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  };

  const sink = {
    write(message: unknown): boolean {
      ensureHeaders();
      if (res.writableEnded || res.destroyed) return false;
      return res.write(sseFrame(message));
    },
    end(): void {
      stopKeepAlive();
      if (!res.writableEnded) {
        ensureHeaders();
        res.end();
      }
    },
    pendingCount(): number {
      return Math.ceil(res.writableLength / 128);
    },
  };

  const opened = registry.open({
    id: opts.id,
    principal: opts.identity.principal,
    role: opts.identity.role,
    transport: 'http',
    feeds: opts.feeds,
    reauthorize: opts.reauthorize,
    sink,
    correlationId: opts.correlationId,
  });
  if (!opened.ok) return opened;
  const handle = opened.handle;
  res.on('close', () => {
    stopKeepAlive();
    registry.close(handle, 'client');
  });
  return { ok: true };
}
