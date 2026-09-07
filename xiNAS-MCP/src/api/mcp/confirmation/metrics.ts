import type { MetricsRegistry } from '../../../lib/metrics.js';
import type { ConfirmationStore } from './store.js';

/** S15 §12.2 — the counters the confirmation service reports. Implemented over lib/metrics.ts in Task 13. */
export interface ConfirmationMetrics {
  requested(risk: string, mode: string): void;
  decided(outcome: 'approved' | 'declined' | 'cancelled' | 'expired' | 'consumed'): void;
  capabilityFailure(mode: string): void;
  stateValidationFailure(reason: string): void;
  replayRejected(): void;
  roundLimit(): void;
  confirmationToApply(seconds: number): void;
  approvedExpired(): void;
  /**
   * A3 (S15 §12.1): one record-less audit row (`verification_failed`,
   * `replay_rejected`, `capability_missing`) was dropped because the
   * emitting principal exhausted its internal per-minute budget. The
   * request itself was still refused; only the row is missing.
   */
  auditSuppressed(event: string): void;
}

export const noopMetrics: ConfirmationMetrics = {
  requested() {},
  decided() {},
  capabilityFailure() {},
  stateValidationFailure() {},
  replayRejected() {},
  roundLimit() {},
  confirmationToApply() {},
  approvedExpired() {},
  auditSuppressed() {},
};

/**
 * The ten S15 §12.2 series, registered once on `reg`. Labels are always
 * bounded (mode, risk, outcome, reason class) — never a principal, id or
 * path. The pending gauge is scrape-time (`gaugeCollect`, review P2): the
 * store is the single source of truth for "open confirmations by mode", so
 * there is no separate counter that can drift from it.
 *
 * `decided('consumed')` and `confirmationToApply()` have no call site in
 * `ConfirmationService` — the service never learns of a consumption (the
 * task engine's apply transaction does, after the fact); `TaskEngine.apply`
 * calls them directly on the SAME `ConfirmationMetrics` instance this
 * returns (wired in `tasks/build.ts`).
 */
export function registryConfirmationMetrics(
  reg: MetricsRegistry,
  store: ConfirmationStore,
): ConfirmationMetrics {
  const requested = reg.counter(
    'xinas_mcp_confirmations_requested_total',
    'MCP confirmations requested',
    ['risk', 'mode'],
  );
  const decided = reg.counter(
    'xinas_mcp_confirmations_decided_total',
    'MCP confirmation outcomes',
    ['outcome'],
  );
  const capability = reg.counter(
    'xinas_mcp_confirmations_capability_failures_total',
    'clients lacking the needed elicitation mode',
    ['mode'],
  );
  const stateFail = reg.counter(
    'xinas_mcp_confirmations_state_validation_failures_total',
    'requestState rejections by class',
    ['reason'],
  );
  const replay = reg.counter(
    'xinas_mcp_confirmations_replay_rejected_total',
    'binding/replay rejections',
    [],
  );
  const roundLimit = reg.counter(
    'xinas_mcp_confirmations_round_limit_total',
    'confirmations expired by the round limit',
    [],
  );
  // Scrape-time (review P2): the store is the truth; no event bookkeeping to drift.
  reg.gaugeCollect(
    'xinas_mcp_confirmations_pending',
    'open confirmations (pending + approved) by mode',
    ['mode'],
    () => {
      const n = store.countPendingByMode();
      return [
        { labels: { mode: 'form' }, value: n.form },
        { labels: { mode: 'url' }, value: n.url },
      ];
    },
  );
  const latency = reg.histogram(
    'xinas_mcp_confirmation_to_apply_seconds',
    'requested → consumed',
    [1, 5, 15, 30, 60, 120, 300, 600, 900],
    [],
  );
  const approvedExpired = reg.counter(
    'xinas_mcp_confirmations_approved_expired_total',
    'approved but never consumed',
    [],
  );
  // A3: record-less audit rows dropped by the per-principal budget. A
  // non-zero value here means the audit trail for that event class is
  // incomplete for that minute — the refusals themselves still counted in
  // the series above, so the two together say "N refusals, M rows".
  const auditSuppressed = reg.counter(
    'xinas_mcp_confirmation_audit_suppressed_total',
    'record-less confirmation audit rows dropped by the per-principal budget',
    ['event'],
  );
  return {
    requested: (risk, mode) => requested.inc({ risk, mode }),
    decided: (outcome) => decided.inc({ outcome }),
    capabilityFailure: (mode) => capability.inc({ mode }),
    stateValidationFailure: (reason) => stateFail.inc({ reason }),
    replayRejected: () => replay.inc(),
    roundLimit: () => roundLimit.inc(),
    confirmationToApply: (s) => latency.observe({}, s),
    approvedExpired: () => approvedExpired.inc(),
    auditSuppressed: (event) => auditSuppressed.inc({ event }),
  };
}
