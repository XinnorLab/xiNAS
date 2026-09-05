import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBSCRIPTIONS_DEFAULTS } from '../../../api/config.js';
import { InMemorySubscriptionMetrics } from '../../../api/events/metrics.js';
import {
  type ListenerSink,
  type OpenListener,
  SubscriptionRegistry,
} from '../../../api/events/subscriptions.js';
import type { AuditEntryInput } from '../../../state/types.js';

class FakeSink implements ListenerSink {
  messages: unknown[] = [];
  writeResult = true;
  pending = 0;
  ended = false;
  write(message: unknown): boolean {
    this.messages.push(message);
    return this.writeResult;
  }
  end(): void {
    this.ended = true;
  }
  pendingCount(): number {
    return this.pending;
  }
}

const SUB_ID = 'io.modelcontextprotocol/subscriptionId';

describe('SubscriptionRegistry (S17 §5.2, §5.3, §5.6)', () => {
  let rows: AuditEntryInput[];
  let metrics: InMemorySubscriptionMetrics;
  let registry: SubscriptionRegistry;

  const listener = (over: Partial<OpenListener> = {}): OpenListener & { sink: FakeSink } => {
    const sink = new FakeSink();
    return {
      id: 'listen:1',
      principal: 'admin:test',
      role: 'admin',
      transport: 'http',
      feeds: ['raid'],
      reauthorize: () => true,
      sink,
      correlationId: 'corr-1',
      ...over,
      ...(over.sink !== undefined ? {} : { sink }),
    } as OpenListener & { sink: FakeSink };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    rows = [];
    metrics = new InMemorySubscriptionMetrics();
    registry = new SubscriptionRegistry({
      config: { ...SUBSCRIPTIONS_DEFAULTS, max_listeners_per_process: 6 },
      metrics,
      audit: { queue: (e: AuditEntryInput) => rows.push(e) },
    });
  });
  afterEach(() => vi.useRealTimers());

  it('acknowledges first, with the accepted feeds and the request id in its original type', () => {
    const l = listener({ id: 7, feeds: ['raid', 'nfs/sessions'] });
    const r = registry.open(l);
    expect(r.ok).toBe(true);
    expect(l.sink.messages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: {
          _meta: { [SUB_ID]: 7 },
          notifications: {
            resourceSubscriptions: ['xinas://events/raid', 'xinas://events/nfs/sessions'],
          },
        },
      },
    ]);
    expect(registry.activeCount()).toBe(1);
    expect(rows.map((x) => x.kind)).toEqual(['mcp.subscription.opened']);
    expect(rows[0]?.payload).toMatchObject({
      principal: 'admin:test',
      transport: 'http',
      feeds: ['raid', 'nfs/sessions'],
      outcome: 'accepted',
      subscription_correlation_id: 'corr-1',
    });
    expect(JSON.stringify(rows[0])).not.toContain('tok-');
    expect(metrics.snapshot()['xinas_mcp_subscriptions_active{transport=http}']).toBe(1);
    expect(
      metrics.snapshot()['xinas_mcp_subscriptions_opened_total{transport=http,outcome=accepted}'],
    ).toBe(1);
  });

  it('coalesces repeated wake-ups for one feed into one notification and ignores unrequested feeds', () => {
    const l = listener();
    registry.open(l);
    registry.notify(['raid']);
    registry.notify(['raid', 'nfs']);
    registry.notify(['raid']);
    expect(l.sink.messages).toHaveLength(1); // ack only, until the coalesce window elapses
    vi.advanceTimersByTime(250);
    expect(l.sink.messages).toHaveLength(2);
    expect(l.sink.messages[1]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { _meta: { [SUB_ID]: 'listen:1' }, uri: 'xinas://events/raid' },
    });
    expect(metrics.snapshot()['xinas_mcp_resource_notifications_coalesced_total{feed=raid}']).toBe(
      2,
    );
    expect(
      metrics.snapshot()['xinas_mcp_resource_notifications_total{feed=raid,outcome=sent}'],
    ).toBe(1);
    // A second wake-up after delivery is a new notification.
    registry.notify(['raid']);
    vi.advanceTimersByTime(250);
    expect(l.sink.messages).toHaveLength(3);
  });

  it('re-authorizes before every delivery and closes a revoked listener without a graceful result', () => {
    let allowed = true;
    const l = listener({ reauthorize: () => allowed });
    registry.open(l);
    allowed = false;
    registry.notify(['raid']);
    vi.advanceTimersByTime(250);
    expect(l.sink.messages).toHaveLength(1);
    expect(l.sink.ended).toBe(true);
    expect(registry.activeCount()).toBe(0);
    expect(rows.map((x) => x.kind)).toEqual(['mcp.subscription.opened', 'mcp.subscription.closed']);
    expect(rows[1]?.payload).toMatchObject({ reason: 'unauthorized' });
  });

  it('closes a slow consumer on overflow, keeping journal semantics to the caller', () => {
    const l = listener();
    registry.open(l);
    l.sink.writeResult = false;
    l.sink.pending = 300;
    registry.notify(['raid']);
    vi.advanceTimersByTime(250);
    expect(l.sink.ended).toBe(true);
    expect(l.sink.messages.some((m) => (m as { id?: unknown }).id !== undefined)).toBe(false); // no result
    expect(rows.map((x) => x.kind)).toEqual([
      'mcp.subscription.opened',
      'mcp.subscription.overflow',
      'mcp.subscription.closed',
    ]);
    expect(
      metrics.snapshot()['xinas_mcp_subscriptions_closed_total{transport=http,reason=overflow}'],
    ).toBe(1);
  });

  it('enforces the per-principal and per-process limits before acknowledging', () => {
    for (let i = 0; i < 4; i++) expect(registry.open(listener({ id: `p-${i}` })).ok).toBe(true);
    const fifth = listener({ id: 'p-4' });
    expect(registry.open(fifth)).toEqual({ ok: false, reason: 'principal_limit' });
    expect(fifth.sink.messages).toEqual([]);
    expect(
      registry.open(listener({ id: 'q-0', principal: 'viewer:test', role: 'viewer' })).ok,
    ).toBe(true);
    expect(
      registry.open(listener({ id: 'q-1', principal: 'viewer:test', role: 'viewer' })).ok,
    ).toBe(true);
    expect(
      registry.open(listener({ id: 'q-2', principal: 'viewer:test', role: 'viewer' })),
    ).toEqual({
      ok: false,
      reason: 'process_limit',
    });
    expect(rows.filter((x) => x.kind === 'mcp.subscription.denied')).toHaveLength(2);
    expect(
      metrics.snapshot()['xinas_mcp_subscriptions_opened_total{transport=http,outcome=denied}'],
    ).toBe(2);
  });

  it('an empty accepted set is acknowledged with {} and ended gracefully at once', () => {
    const l = listener({ feeds: [] });
    registry.open(l);
    expect(l.sink.messages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/subscriptions/acknowledged',
        params: { _meta: { [SUB_ID]: 'listen:1' }, notifications: {} },
      },
      {
        jsonrpc: '2.0',
        id: 'listen:1',
        result: { resultType: 'complete', _meta: { [SUB_ID]: 'listen:1' } },
      },
    ]);
    expect(l.sink.ended).toBe(true);
    expect(registry.activeCount()).toBe(0);
    expect(rows[0]?.payload).toMatchObject({ outcome: 'empty_filter' });
    expect(rows[1]?.payload).toMatchObject({ reason: 'empty_filter' });
  });

  it('shutdown sends the graceful result to every open listener, then ends the streams', () => {
    const a = listener({ id: 'a' });
    const b = listener({ id: 'b', transport: 'stdio' });
    registry.open(a);
    registry.open(b);
    registry.notify(['raid']);
    registry.closeAll('shutdown');
    for (const l of [a, b]) {
      expect(l.sink.messages.at(-1)).toEqual({
        jsonrpc: '2.0',
        id: l.id,
        result: { resultType: 'complete', _meta: { [SUB_ID]: l.id } },
      });
      expect(l.sink.ended).toBe(true);
    }
    expect(registry.activeCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(
      a.sink.messages.filter(
        (m) => (m as { method?: string }).method === 'notifications/resources/updated',
      ),
    ).toHaveLength(0);
  });

  it('a client close removes only the listener and records counts', () => {
    const l = listener();
    const r = registry.open(l);
    if (!r.ok) throw new Error('open failed');
    registry.notify(['raid']);
    registry.notify(['raid']);
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(5_000);
    registry.close(r.handle, 'client');
    registry.close(r.handle, 'client'); // idempotent
    expect(l.sink.ended).toBe(false); // the transport closed the socket, not us
    expect(rows.at(-1)?.kind).toBe('mcp.subscription.closed');
    expect(rows.at(-1)?.payload).toMatchObject({
      reason: 'client',
      notifications_sent: 1,
      coalesced: 1,
    });
    expect((rows.at(-1)?.payload as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(
      5_000,
    );
    expect(rows.filter((x) => x.kind === 'mcp.subscription.closed')).toHaveLength(1);
  });
});
