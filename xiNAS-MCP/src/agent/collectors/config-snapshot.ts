/**
 * ConfigSnapshot collector (S9 T2, ADR-0011): polls the xinas_history
 * bridge (`snapshot list`) and pushes one observed `ConfigSnapshot`
 * row per manifest, PROJECTED onto the public shape (typed top-level
 * fields — the route serves rows as-is).
 *
 * Re-emits EVERY row on EVERY sweep: PollDriver flushes with
 * complete-snapshot semantics, so a suppressed unchanged row would be
 * reconcile-DELETED api-side (vanished snapshot ids — GC — are handled
 * by that same reconcile; no delete tracking needed here). Unchanged
 * content does not churn revisions — the api-side dedupe strips
 * observed_at before comparing.
 */

import { type HistoryManifest, projectSnapshot } from '../task/xinas-history-bridge.js';
import type { Collector, ObservationDelta } from './base.js';

interface SnapshotSource {
  snapshotList(): Promise<HistoryManifest[]>;
}

export class ConfigSnapshotCollector implements Collector<'ConfigSnapshot'> {
  readonly kind = 'ConfigSnapshot' as const;
  readonly pollIntervalMs: number;

  readonly #source: SnapshotSource;
  #health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };

  constructor({ source, pollIntervalMs }: { source: SnapshotSource; pollIntervalMs?: number }) {
    this.#source = source;
    this.pollIntervalMs = pollIntervalMs ?? 60_000;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    let manifests: HistoryManifest[];
    try {
      manifests = await this.#source.snapshotList();
      this.#health = { state: 'running' };
    } catch (err) {
      this.#health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }

    const observedAt = new Date().toISOString();
    return manifests.map((manifest) => {
      const projected = projectSnapshot(manifest);
      return {
        kind: 'ConfigSnapshot',
        id: projected.snapshot_id,
        op: 'upsert',
        value: {
          kind: 'ConfigSnapshot',
          id: projected.snapshot_id,
          status: { ...projected, observed_at: observedAt },
        },
      };
    });
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
