/**
 * Tuning collector (S7 T1, ADR-0009 §Tuning): emits the internal
 * observed singleton `Tuning/default` from the tuning probe on EVERY
 * sweep. No compare-and-skip: PollDriver flushes poll sweeps with
 * complete-snapshot semantics, so an unchanged sweep that returned []
 * would reconcile-DELETE the row api-side (the S9 bridge-pools e2e
 * regression — the NetworkConfig skip pattern is only safe for
 * event-driven plain flushes). The api-side sweep dedupe keeps
 * identical re-pushes from churning revisions.
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

  constructor({ probe }: { probe: TuningProbe }) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const snap = await this.probe.snapshot();
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
