/**
 * Bounded journal retention on a timer (S17 §7.3): runs once on start and
 * every `intervalMs`, deleting oldest-first in short batches so reads and
 * writes interleave; a run that exhausts its budget leaves the rest to the
 * next one. Configuration changes take effect on the next run, never
 * retroactively inside a read (SUBS-CONFIG-002).
 */

import type { RetentionPolicy } from './journal.js';
import type { SubscriptionMetrics } from './metrics.js';

/** The journal surface the sweeper needs (tests inject a stub). */
export interface RetentionJournal {
  retentionSweep(p: RetentionPolicy): { deleted: number; exhausted: boolean };
  count(): number;
  oldestAgeSeconds(): number | null;
}

export const RETENTION_BATCH_ROWS = 500;
export const RETENTION_MAX_BATCHES = 50;

export interface RetentionSweeperOptions {
  journal: RetentionJournal;
  policy: { retentionDays: number; maxRows: number };
  intervalMs: number;
  metrics?: SubscriptionMetrics;
  log?: (level: 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export class RetentionSweeper {
  readonly #opts: RetentionSweeperOptions;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RetentionSweeperOptions) {
    this.#opts = opts;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.run();
    this.#timer = setInterval(() => this.run(), this.#opts.intervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** One bounded pass; errors are logged, never thrown (the timer keeps ticking). */
  run(): { deleted: number; exhausted: boolean } | null {
    const { journal, policy, metrics, log } = this.#opts;
    try {
      const r = journal.retentionSweep({
        retentionDays: policy.retentionDays,
        maxRows: policy.maxRows,
        batchRows: RETENTION_BATCH_ROWS,
        maxBatches: RETENTION_MAX_BATCHES,
      });
      metrics?.journalRows(journal.count());
      const age = journal.oldestAgeSeconds();
      if (age !== null) metrics?.journalOldestAgeSeconds(age);
      return r;
    } catch (err) {
      log?.('error', 'event_retention_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
