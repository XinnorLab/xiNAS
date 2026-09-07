import type { ConfirmationService } from './service.js';

/**
 * S15 §6.3–6.5 — a confirmation's TTL used to be enforced only lazily, on
 * the client's own retry (`ConfirmationService.retry`'s
 * `record.expires_at <= this.now()` check). That leaves a record that is
 * never retried (declined by inaction) pending/approved forever from the
 * store's point of view — never audited as expired, and counted in the
 * `xinas_mcp_confirmations_pending` gauge until something looks at it.
 * This timer runs `ConfirmationService.sweepExpired('ttl')` on an
 * interval, matching the lease sweeper's cadence (`lease-sweeper.ts`,
 * ADR-0004 "periodic sweep") and the same shape: `unref()`ed so it never
 * keeps the process (or a test runner) alive, and each tick swallows its
 * own error — a sweep failure must not tear the api down; the next tick
 * retries.
 */
export const CONFIRMATION_SWEEP_INTERVAL_MS = 30_000;

export interface ConfirmationSweeperHandle {
  /** Stop the timer. Idempotent. */
  stop(): void;
}

export interface StartConfirmationSweeperOptions {
  service: ConfirmationService;
  /** Sweep cadence in ms. Defaults to {@link CONFIRMATION_SWEEP_INTERVAL_MS}. */
  intervalMs?: number;
}

/**
 * Start the periodic confirmation-expiry sweep. Returns a handle whose
 * `stop()` clears the timer.
 */
export function startConfirmationSweeper(
  opts: StartConfirmationSweeperOptions,
): ConfirmationSweeperHandle {
  const intervalMs = opts.intervalMs ?? CONFIRMATION_SWEEP_INTERVAL_MS;
  const timer = setInterval(() => {
    try {
      opts.service.sweepExpired('ttl');
    } catch {
      /* best-effort: a sweep failure is non-fatal; the next tick retries */
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
