import type { LeaseManager } from '../state/leases.js';

/**
 * ADR-0004 "periodic sweep" / s2-task-envelope-spec §9.
 *
 * The lease TTL (60 s) only self-heals if something drives the clock.
 * `reconcile()` sweeps on api startup and on the agent offline→healthy edge,
 * but nothing else — so a lease that outlives its task (a release that didn't
 * run for a task that already reached a terminal state) would stay held until
 * the next api restart or agent reconnect, surfacing as a spurious
 * `CONFLICT: resource is locked by another task` on the next mutation of that
 * resource. This timer runs `LeaseManager.reapExpiredTerminalLeases()` on an
 * interval to bound how long such a leaked lease can persist.
 *
 * It deliberately reaps ONLY leases of already-terminal tasks — never a
 * `queued`/`running` task's lease. A frequent timer cannot tell "the agent
 * died" from "this stage is slow and hasn't emitted a heartbeat within the
 * TTL," so blindly recovering non-terminal tasks here would false-reap a
 * healthy in-flight operation. That recovery stays with the startup/reconnect
 * `reconcile()` (ADR-0004). Re-dispatch also stays timer-free (§5.3).
 */

/** Default sweep cadence: TTL/2 (lease TTL is 60 s), so a leaked lease is
 *  reclaimed within ~1.5× TTL of expiry at worst. */
export const LEASE_SWEEP_INTERVAL_MS = 30_000;

export interface LeaseSweeperHandle {
  /** Stop the timer. Idempotent. */
  stop(): void;
}

export interface StartLeaseSweeperOptions {
  leases: LeaseManager;
  /** Sweep cadence in ms. Defaults to {@link LEASE_SWEEP_INTERVAL_MS}. */
  intervalMs?: number;
}

/**
 * Start the periodic lease sweep. Returns a handle whose `stop()` clears the
 * timer. The timer is `unref()`ed so it never keeps the process (or a test
 * runner) alive, and each tick swallows its own error — a sweep failure must
 * not tear the api down; the next tick retries.
 */
export function startLeaseSweeper(opts: StartLeaseSweeperOptions): LeaseSweeperHandle {
  const intervalMs = opts.intervalMs ?? LEASE_SWEEP_INTERVAL_MS;
  const timer = setInterval(() => {
    try {
      opts.leases.reapExpiredTerminalLeases();
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
