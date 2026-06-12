/**
 * Pool collector (S9 T7, ADR-0011): observes xiRAID spare pools via
 * the shared gRPC client's poolShow. One row per pool (id = name),
 * compare-and-skip, deletes for vanished pools. `referenced_by` is
 * joined api-side at read time (the arrays' spare_pool names).
 */

import { type ObservedPool, parsePoolShow } from '../../lib/parse/pool.js';
import type { Collector, ObservationDelta } from './base.js';

interface PoolSource {
  poolShow(): Promise<unknown>;
}

export class PoolCollector implements Collector<'Pool'> {
  readonly kind = 'Pool' as const;
  readonly pollIntervalMs = 30_000;

  readonly #source: PoolSource;
  #health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  #last = new Map<string, string>();

  constructor({ source }: { source: PoolSource }) {
    this.#source = source;
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

    const deltas: ObservationDelta[] = [];
    const seen = new Set<string>();
    const observedAt = new Date().toISOString();
    for (const pool of pools) {
      seen.add(pool.name);
      const key = JSON.stringify(pool);
      if (this.#last.get(pool.name) === key) continue;
      this.#last.set(pool.name, key);
      deltas.push({
        kind: 'Pool',
        id: pool.name,
        op: 'upsert',
        value: { kind: 'Pool', id: pool.name, status: { ...pool, observed_at: observedAt } },
      });
    }
    for (const name of this.#last.keys()) {
      if (!seen.has(name)) {
        this.#last.delete(name);
        deltas.push({ kind: 'Pool', id: name, op: 'delete' });
      }
    }
    return deltas;
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
