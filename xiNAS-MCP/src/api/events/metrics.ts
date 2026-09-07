/**
 * S17 §12 metrics behind an interface (decision D-17): the eleven
 * instruments the requirement lists, with bounded labels only — never a
 * principal, id, array, disk, address, path or task. `InMemorySubscriptionMetrics`
 * is what tests assert against and what runs until the S15 registry
 * (`lib/metrics.ts`) lands; a `RegistryMetrics` adapter then registers the
 * same names there (docs/TODO.md).
 */

import type { Feed, Severity } from './types.js';

export type Transport = 'http' | 'stdio';
export type OpenOutcome = 'accepted' | 'empty_filter' | 'denied';
export type CloseReason =
  | 'client'
  | 'empty_filter'
  | 'overflow'
  | 'unauthorized'
  | 'shutdown'
  | 'error';
export type NotifyOutcome = 'sent' | 'skipped' | 'error';
export type ReadOutcome = 'ok' | 'gap' | 'invalid';

export interface SubscriptionMetrics {
  subscriptionsActive(transport: Transport, delta: 1 | -1): void;
  subscriptionOpened(transport: Transport, outcome: OpenOutcome): void;
  subscriptionClosed(transport: Transport, reason: CloseReason): void;
  notification(feed: Feed, outcome: NotifyOutcome): void;
  coalesced(feed: Feed): void;
  eventRead(feed: Feed, outcome: ReadOutcome): void;
  cursorGap(feed: Feed): void;
  eventCreated(feed: Feed, severity: Severity): void;
  journalRows(n: number): void;
  journalOldestAgeSeconds(s: number): void;
  detectionDelaySeconds(source: string, s: number): void;
}

export const METRIC_NAMES = {
  active: 'xinas_mcp_subscriptions_active',
  opened: 'xinas_mcp_subscriptions_opened_total',
  closed: 'xinas_mcp_subscriptions_closed_total',
  notifications: 'xinas_mcp_resource_notifications_total',
  coalesced: 'xinas_mcp_resource_notifications_coalesced_total',
  reads: 'xinas_mcp_event_reads_total',
  gaps: 'xinas_mcp_event_cursor_gaps_total',
  created: 'xinas_operational_events_created_total',
  rows: 'xinas_operational_event_journal_rows',
  oldestAge: 'xinas_operational_event_journal_oldest_age_seconds',
  detectionDelay: 'xinas_operational_event_detection_delay_seconds',
} as const;

export const noopSubscriptionMetrics: SubscriptionMetrics = {
  subscriptionsActive() {},
  subscriptionOpened() {},
  subscriptionClosed() {},
  notification() {},
  coalesced() {},
  eventRead() {},
  cursorGap() {},
  eventCreated() {},
  journalRows() {},
  journalOldestAgeSeconds() {},
  detectionDelaySeconds() {},
};

const key = (name: string, labels: Record<string, string>): string => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
};

/** Counters and gauges in a map keyed `name{label=value,...}`; histograms record count and sum. */
export class InMemorySubscriptionMetrics implements SubscriptionMetrics {
  readonly #values = new Map<string, number>();

  #add(name: string, labels: Record<string, string>, by: number): void {
    const k = key(name, labels);
    this.#values.set(k, (this.#values.get(k) ?? 0) + by);
  }
  #set(name: string, labels: Record<string, string>, v: number): void {
    this.#values.set(key(name, labels), v);
  }

  subscriptionsActive(transport: Transport, delta: 1 | -1): void {
    this.#add(METRIC_NAMES.active, { transport }, delta);
  }
  subscriptionOpened(transport: Transport, outcome: OpenOutcome): void {
    this.#add(METRIC_NAMES.opened, { transport, outcome }, 1);
  }
  subscriptionClosed(transport: Transport, reason: CloseReason): void {
    this.#add(METRIC_NAMES.closed, { transport, reason }, 1);
  }
  notification(feed: Feed, outcome: NotifyOutcome): void {
    this.#add(METRIC_NAMES.notifications, { feed, outcome }, 1);
  }
  coalesced(feed: Feed): void {
    this.#add(METRIC_NAMES.coalesced, { feed }, 1);
  }
  eventRead(feed: Feed, outcome: ReadOutcome): void {
    this.#add(METRIC_NAMES.reads, { feed, outcome }, 1);
  }
  cursorGap(feed: Feed): void {
    this.#add(METRIC_NAMES.gaps, { feed }, 1);
  }
  eventCreated(feed: Feed, severity: Severity): void {
    this.#add(METRIC_NAMES.created, { feed, severity }, 1);
  }
  journalRows(n: number): void {
    this.#set(METRIC_NAMES.rows, {}, n);
  }
  journalOldestAgeSeconds(s: number): void {
    this.#set(METRIC_NAMES.oldestAge, {}, s);
  }
  detectionDelaySeconds(source: string, s: number): void {
    this.#add(`${METRIC_NAMES.detectionDelay}_count`, { source }, 1);
    this.#add(`${METRIC_NAMES.detectionDelay}_sum`, { source }, s);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#values);
  }
}
