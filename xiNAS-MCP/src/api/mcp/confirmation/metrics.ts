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
};
