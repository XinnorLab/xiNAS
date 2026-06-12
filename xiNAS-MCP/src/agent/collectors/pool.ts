/**
 * Pool collector (S9 T7, ADR-0011): observes xiRAID spare pools via
 * the shared gRPC client's poolShow. One row per pool (id = name).
 * `referenced_by` is joined api-side at read time (the arrays'
 * spare_pool names).
 *
 * Re-emits EVERY row on EVERY sweep: PollDriver flushes with
 * complete-snapshot semantics, so a suppressed unchanged row would be
 * reconcile-DELETED api-side (vanished pools are handled by that same
 * reconcile; no delete tracking needed here). Unchanged content does
 * not churn revisions — the api-side dedupe strips observed_at before
 * comparing.
 */

import { type ObservedPool, parsePoolShow } from '../../lib/parse/pool.js';
import type { Collector, ObservationDelta } from './base.js';

interface PoolSource {
  poolShow(): Promise<unknown>;
}

export class PoolCollector implements Collector<'Pool'> {
  readonly kind = 'Pool' as const;
  readonly pollIntervalMs: number;

  readonly #source: PoolSource;
  #health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };

  constructor({ source, pollIntervalMs }: { source: PoolSource; pollIntervalMs?: number }) {
    this.#source = source;
    this.pollIntervalMs = pollIntervalMs ?? 30_000;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    let pools: ObservedPool[];
    try {
      pools = parsePoolShow(await this.#source.poolShow());
      this.#health = { state: 'running' };
    } catch (err) {
      this.#health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }

    const observedAt = new Date().toISOString();
    return pools.map((pool) => ({
      kind: 'Pool',
      id: pool.name,
      op: 'upsert',
      value: { kind: 'Pool', id: pool.name, status: { ...pool, observed_at: observedAt } },
    }));
  }

  async start(): Promise<void> {
    this.#health = { state: 'running' };
  }

  async stop(): Promise<void> {
    /* poll-only */
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this.#health;
  }
}
