/**
 * ConfigSnapshot collector (S9 T2, ADR-0011): polls the xinas_history
 * bridge (`snapshot list`) and pushes one observed `ConfigSnapshot`
 * row per manifest, PROJECTED onto the public shape (typed top-level
 * fields — the route serves rows as-is). Vanished snapshot ids (GC)
 * emit deletes. Compare-and-skip per row keeps unchanged sweeps off
 * the wire (the api-side dedupe would drop them anyway).
 */

import {
  type HistoryManifest,
  projectSnapshot,
} from '../task/xinas-history-bridge.js';
import type { Collector, ObservationDelta } from './base.js';

interface SnapshotSource {
  snapshotList(): Promise<HistoryManifest[]>;
}

export class ConfigSnapshotCollector implements Collector<'ConfigSnapshot'> {
  readonly kind = 'ConfigSnapshot' as const;
  readonly pollIntervalMs = 60_000;

  readonly #source: SnapshotSource;
  #health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  /** id → serialized projected row from the previous sweep. */
  #last = new Map<string, string>();

  constructor({ source }: { source: SnapshotSource }) {
    this.#source = source;
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

    const deltas: ObservationDelta[] = [];
    const seen = new Set<string>();
    const observedAt = new Date().toISOString();

    for (const manifest of manifests) {
      const projected = projectSnapshot(manifest);
      seen.add(projected.snapshot_id);
      const key = JSON.stringify(projected);
      if (this.#last.get(projected.snapshot_id) === key) continue;
      this.#last.set(projected.snapshot_id, key);
      deltas.push({
        kind: 'ConfigSnapshot',
        id: projected.snapshot_id,
        op: 'upsert',
        value: {
          kind: 'ConfigSnapshot',
          id: projected.snapshot_id,
          status: { ...projected, observed_at: observedAt },
        },
      });
    }

    for (const id of this.#last.keys()) {
      if (!seen.has(id)) {
        this.#last.delete(id);
        deltas.push({ kind: 'ConfigSnapshot', id, op: 'delete' });
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
