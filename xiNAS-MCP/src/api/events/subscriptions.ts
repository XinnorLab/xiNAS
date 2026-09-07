/**
 * The subscription registry (S17 §5.2, §5.3, §5.6): every live
 * `subscriptions/listen` stream, its accepted feeds, the coalescing timers,
 * the limits and the close reasons. Transport-agnostic: an HTTP SSE
 * response and the stdio adapter both hand it a `ListenerSink`.
 *
 * A notification is a wake-up only. `notify(feeds)` is synchronous
 * bookkeeping — it never awaits a socket — so a slow consumer can never
 * back-pressure the observation-ingest transaction that called it; the
 * consumer is closed instead (overflow) and catches up by cursor.
 */

import type { ResolvedSubscriptionsConfig } from '../config.js';
import { type AuditSink, queueSubscriptionEvent } from './audit.js';
import type { CloseReason, SubscriptionMetrics, Transport } from './metrics.js';
import { type Feed, feedUri } from './types.js';

export type { CloseReason } from './metrics.js';

export const SUBSCRIPTION_ID_META = 'io.modelcontextprotocol/subscriptionId';

export interface ListenerSink {
  /** Write one JSON-RPC message; `false` means the transport is back-pressured. */
  write(message: unknown): boolean;
  /** End the stream (graceful or abrupt is decided by what was written before). */
  end(): void;
  /** Messages (or an equivalent) still buffered in the transport. */
  pendingCount(): number;
}

export interface OpenListener {
  /** The listen request's JSON-RPC id, in its original type. */
  id: string | number;
  principal: string;
  role: string;
  transport: Transport;
  /** The accepted feeds, deduplicated, in first-requested order. */
  feeds: Feed[];
  /** Re-resolves the retained credential before every delivery (spec §9.3). */
  reauthorize: () => boolean;
  sink: ListenerSink;
  /** Server-minted correlation id (never the JSON-RPC id). */
  correlationId: string;
}

export interface ListenerHandle {
  readonly id: string | number;
  readonly key: string;
}

interface Listener extends OpenListener {
  key: string;
  openedAt: number;
  feedSet: Set<Feed>;
  pending: Set<Feed>;
  timers: Map<Feed, ReturnType<typeof setTimeout>>;
  sent: number;
  coalesced: number;
  backpressuredSince: number | null;
  closed: boolean;
}

export interface RegistryDeps {
  config: ResolvedSubscriptionsConfig;
  metrics: SubscriptionMetrics;
  audit?: AuditSink;
  now?: () => number;
}

const ack = (l: Listener): unknown => ({
  jsonrpc: '2.0',
  method: 'notifications/subscriptions/acknowledged',
  params: {
    _meta: { [SUBSCRIPTION_ID_META]: l.id },
    notifications:
      l.feeds.length > 0 ? { resourceSubscriptions: l.feeds.map((f) => feedUri(f)) } : {},
  },
});

const updated = (l: Listener, feed: Feed): unknown => ({
  jsonrpc: '2.0',
  method: 'notifications/resources/updated',
  params: { _meta: { [SUBSCRIPTION_ID_META]: l.id }, uri: feedUri(feed) },
});

/** The graceful completion (spec §5.3 item 3, D-13). */
const gracefulResult = (l: Listener): unknown => ({
  jsonrpc: '2.0',
  id: l.id,
  result: { resultType: 'complete', _meta: { [SUBSCRIPTION_ID_META]: l.id } },
});

export class SubscriptionRegistry {
  readonly #deps: RegistryDeps;
  readonly #now: () => number;
  readonly #listeners = new Map<string, Listener>();
  #seq = 0;

  constructor(deps: RegistryDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  activeCount(): number {
    return this.#listeners.size;
  }

  /**
   * Register a listener: limits first (a refusal leaves no partial listener),
   * then the acknowledgment, then — for an empty accepted set — the graceful
   * close at once (SUBS-LISTEN-007).
   */
  open(
    l: OpenListener,
  ):
    | { ok: true; handle: ListenerHandle }
    | { ok: false; reason: 'principal_limit' | 'process_limit' } {
    const { config, metrics, audit } = this.#deps;
    let byPrincipal = 0;
    for (const x of this.#listeners.values()) if (x.principal === l.principal) byPrincipal++;
    const denied =
      this.#listeners.size >= config.max_listeners_per_process
        ? 'process_limit'
        : byPrincipal >= config.max_listeners_per_principal
          ? 'principal_limit'
          : null;
    if (denied !== null) {
      metrics.subscriptionOpened(l.transport, 'denied');
      queueSubscriptionEvent(audit, 'denied', {
        principal: l.principal,
        correlationId: l.correlationId,
        payload: {
          transport: l.transport,
          reason: denied,
          limit: denied === 'principal_limit' ? 'principal' : 'process',
        },
      });
      return { ok: false, reason: denied };
    }

    const key = `${++this.#seq}`;
    const listener: Listener = {
      ...l,
      key,
      openedAt: this.#now(),
      feedSet: new Set(l.feeds),
      pending: new Set(),
      timers: new Map(),
      sent: 0,
      coalesced: 0,
      backpressuredSince: null,
      closed: false,
    };
    this.#listeners.set(key, listener);
    metrics.subscriptionsActive(l.transport, 1);
    const outcome = l.feeds.length === 0 ? 'empty_filter' : 'accepted';
    metrics.subscriptionOpened(l.transport, outcome);
    queueSubscriptionEvent(audit, 'opened', {
      principal: l.principal,
      correlationId: l.correlationId,
      payload: { transport: l.transport, feeds: [...l.feeds], principal: l.principal, outcome },
    });
    this.#write(listener, ack(listener));
    const handle: ListenerHandle = { id: l.id, key };
    if (l.feeds.length === 0) this.close(handle, 'empty_filter');
    return { ok: true, handle };
  }

  /** Mark the feeds pending on every interested listener; deliveries are coalesced. */
  notify(feeds: Iterable<Feed>): void {
    const touched = [...feeds];
    for (const l of this.#listeners.values()) {
      for (const feed of touched) {
        if (!l.feedSet.has(feed)) continue;
        if (l.pending.has(feed)) {
          l.coalesced++;
          this.#deps.metrics.coalesced(feed);
          continue;
        }
        l.pending.add(feed);
        const timer = setTimeout(() => this.#deliver(l, feed), this.#deps.config.coalesce_ms);
        if (typeof timer.unref === 'function') timer.unref();
        l.timers.set(feed, timer);
      }
    }
  }

  close(handle: ListenerHandle, reason: CloseReason): void {
    const l = this.#listeners.get(handle.key);
    if (l === undefined || l.closed) return;
    l.closed = true;
    for (const t of l.timers.values()) clearTimeout(t);
    l.timers.clear();
    l.pending.clear();
    this.#listeners.delete(handle.key);
    // A graceful end carries the listen result; an abrupt one carries nothing
    // (spec §5.3 item 3); a client close needs neither — the socket is gone.
    if (reason === 'shutdown' || reason === 'empty_filter') {
      this.#write(l, gracefulResult(l));
      l.sink.end();
    } else if (reason !== 'client') {
      l.sink.end();
    }
    this.#deps.metrics.subscriptionsActive(l.transport, -1);
    this.#deps.metrics.subscriptionClosed(l.transport, reason);
    queueSubscriptionEvent(this.#deps.audit, 'closed', {
      principal: l.principal,
      correlationId: l.correlationId,
      payload: {
        transport: l.transport,
        feeds: [...l.feeds],
        reason,
        notifications_sent: l.sent,
        coalesced: l.coalesced,
        duration_ms: Math.max(0, this.#now() - l.openedAt),
      },
    });
  }

  /** Graceful teardown of every listener (server shutdown). */
  closeAll(reason: 'shutdown'): void {
    for (const l of [...this.#listeners.values()]) this.close({ id: l.id, key: l.key }, reason);
  }

  #deliver(l: Listener, feed: Feed): void {
    l.timers.delete(feed);
    if (l.closed) return;
    l.pending.delete(feed);
    if (!l.reauthorize()) {
      this.#deps.metrics.notification(feed, 'skipped');
      this.close({ id: l.id, key: l.key }, 'unauthorized');
      return;
    }
    const ok = this.#write(l, updated(l, feed));
    if (l.closed) return; // an overflow inside #write closed it
    if (ok) {
      l.sent++;
      this.#deps.metrics.notification(feed, 'sent');
    } else {
      this.#deps.metrics.notification(feed, 'error');
    }
  }

  /** Write with the slow-consumer rule (spec §5.6): returns false when the write failed or the listener was closed. */
  #write(l: Listener, message: unknown): boolean {
    let flushed: boolean;
    try {
      flushed = l.sink.write(message);
    } catch {
      this.close({ id: l.id, key: l.key }, 'error');
      return false;
    }
    const now = this.#now();
    if (flushed) {
      l.backpressuredSince = null;
    } else if (l.backpressuredSince === null) {
      l.backpressuredSince = now;
    }
    const { max_pending_per_stream, keepalive_ms } = this.#deps.config;
    const stuckFor = l.backpressuredSince === null ? 0 : now - l.backpressuredSince;
    let pendingCount = 0;
    try {
      pendingCount = l.sink.pendingCount();
    } catch {
      pendingCount = 0;
    }
    if (pendingCount > max_pending_per_stream || stuckFor > 2 * keepalive_ms) {
      queueSubscriptionEvent(this.#deps.audit, 'overflow', {
        principal: l.principal,
        correlationId: l.correlationId,
        payload: {
          transport: l.transport,
          feeds: [...l.feeds],
          pending: pendingCount,
          stuck_ms: stuckFor,
        },
      });
      this.close({ id: l.id, key: l.key }, 'overflow');
      return false;
    }
    return flushed;
  }
}
