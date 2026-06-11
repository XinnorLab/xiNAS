/**
 * Tuning collector (S7 T1, ADR-0009 §Tuning): emits the internal
 * observed singleton `Tuning/default` from the tuning probe on sweeps,
 * compare-and-skip on content (the NetworkConfig pattern — the api-side
 * sweep dedupe would skip identical re-pushes anyway; this keeps them
 * off the wire). No event source; the poll backstop is the refresh.
 */

import type { TuningSnapshot } from '../probe/tuning.js';
import type { Collector, ObservationDelta } from './base.js';

interface TuningProbe {
  snapshot(): Promise<TuningSnapshot>;
}

export class TuningCollector implements Collector<'Tuning'> {
  readonly kind = 'Tuning' as const;
  readonly pollIntervalMs = 60_000;

  private readonly probe: TuningProbe;
  private _state: 'running' | 'stubbed' | 'error' = 'running';
  private _reason: string | undefined = undefined;
  private _lastKey: string | null = null;

  constructor({ probe }: { probe: TuningProbe }) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const snap = await this.probe.snapshot();
      const key = JSON.stringify(snap.entries);
      if (key === this._lastKey) return [];
      this._lastKey = key;
      return [
        {
          kind: 'Tuning',
          id: 'default',
          op: 'upsert',
          value: {
            kind: 'Tuning',
            id: 'default',
            status: { entries: snap.entries, observed_at: new Date().toISOString() },
          },
        },
      ];
    } catch (err) {
      this._state = 'error';
      this._reason = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async start(): Promise<void> {
    this._state = 'running';
    this._reason = undefined;
  }

  async stop(): Promise<void> {
    /* no event source */
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return { state: this._state, ...(this._reason !== undefined ? { reason: this._reason } : {}) };
  }
}
