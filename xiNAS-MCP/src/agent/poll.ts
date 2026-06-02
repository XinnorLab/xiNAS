import type { Collector, CollectorRegistry, Kind } from './collectors/base.js';
import { log } from './log.js';
import type { Publisher } from './publisher.js';

/**
 * Default backstop reconcile interval for collectors that declare no
 * pollIntervalMs (event-driven kinds like Disk/Network). Spec Flow C/D
 * mandates a ~5-minute full reconcile so a missed/lost kernel event can't
 * leave observed state permanently stale.
 */
const DEFAULT_BACKSTOP_MS = 300_000;

export interface PollDriverOptions {
  registry: CollectorRegistry;
  publisher: Publisher;
  /** Override the 5-min backstop interval (tests). */
  backstopMs?: number;
}

/**
 * Drives the steady-state observation refresh that event streams alone don't
 * cover (spec Flow C/D). Without it, a quiet node's observed state freezes
 * after the boot sweep and an api-outage drop never recovers — the exact F2/F3
 * gap the independent review found (`pollIntervalMs` had no consumer and
 * `pendingReconcile` was never read).
 *
 * Per registered collector it arms ONE interval:
 *   - collectors WITH pollIntervalMs (NFS, NfsIdmap, Inventory, Users, …) — many
 *     of which have no event source at all — re-sweep on their own interval;
 *   - collectors WITHOUT one (event-driven Disk/Network) get the 5-min backstop.
 *
 * Each tick runs a FULL initialSweep() + flushWithSnapshot([kinds]). Because
 * that is a complete snapshot with reconcile, it also CONSUMES
 * publisher.pendingReconcile (F4): a kind marked after a dropped batch is
 * re-swept and reconciled on its next tick, and flush success clears it from
 * the set. The poll is the "next tick" the retry path was waiting on.
 */
export class PollDriver {
  readonly #timers: Array<ReturnType<typeof setInterval>> = [];
  #started = false;

  constructor(private readonly opts: PollDriverOptions) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const backstop = this.opts.backstopMs ?? DEFAULT_BACKSTOP_MS;
    for (const collector of this.opts.registry.list()) {
      const interval = collector.pollIntervalMs ?? backstop;
      const timer = setInterval(() => void this.#sweep(collector), interval);
      // Never keep the process (or a test runner) alive on the poll timer.
      timer.unref?.();
      this.#timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
    this.#started = false;
  }

  /** Full re-sweep + reconcile for one collector. Absorbs every error so a
   *  single failing collector can't crash the interval callback. */
  async #sweep(collector: Collector): Promise<void> {
    try {
      const deltas = await collector.initialSweep();
      for (const delta of deltas) this.opts.publisher.enqueue(delta);
      const kinds = new Set<Kind>([collector.kind, ...deltas.map((d) => d.kind)]);
      await this.opts.publisher.flushWithSnapshot([...kinds]);
    } catch (err) {
      log('error', 'poll', 'poll_sweep_failed', {
        kind: collector.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
