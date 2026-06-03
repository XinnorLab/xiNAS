import type { Collector, ObservationDelta } from './base.js';

/**
 * Stub base: common no-op lifecycle + health for deferred collectors.
 *
 * initialSweep emits a single meta-delta at id "_stub" so the kind's
 * path in the state store is populated with a status row indicating the
 * deferral. This lets the api's GET endpoints return a well-formed
 * (though empty) result instead of a 404, and gives operators a clear
 * signal that the capability is deferred.
 *
 * No event source, no poll — pollIntervalMs is undefined.
 * health() always reports 'stubbed' with the reason code.
 */
abstract class StubCollector<K extends 'XiraidArray' | 'managed_files'> implements Collector<K> {
  abstract readonly kind: K;
  abstract readonly _reasonCode: string;

  // Stubs never poll. Declared (optional, always undefined) so the
  // Collector contract's optional field is visible on the concrete type.
  readonly pollIntervalMs?: number;

  async initialSweep(): Promise<ObservationDelta[]> {
    const observedAt = new Date().toISOString();
    return [
      {
        kind: this.kind,
        id: '_stub',
        op: 'upsert',
        value: {
          kind: this.kind,
          id: '_stub',
          status: {
            deferred: true,
            reason: this._reasonCode,
            observed_at: observedAt,
          },
        },
      },
    ];
  }

  /** No-op: stubs have no event source. */
  async start(_emit: (delta: ObservationDelta) => void): Promise<void> {}

  async stop(): Promise<void> {}

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return { state: 'stubbed', reason: this._reasonCode };
  }
}

/**
 * XiraidArray stub collector.
 *
 * Deferred: xiRAID gRPC client moves from api → agent in S3/WS5.
 * Until then, the state store carries a _stub entry so the api's
 * /api/v1/arrays endpoint can report the deferral rather than 404.
 *
 * Reason code: XIRAID_ADAPTER_DEFERRED
 */
export class XiraidArrayStubCollector extends StubCollector<'XiraidArray'> {
  readonly kind = 'XiraidArray' as const;
  readonly _reasonCode = 'XIRAID_ADAPTER_DEFERRED';
}

/**
 * ManagedFiles stub collector.
 *
 * Deferred: drift framework lands in WS9.
 * Path conforms to ADR-0003 line 101's locked layout (snake_case
 * singular noun, used by xinas_history.drift).
 *
 * Reason code: DRIFT_FRAMEWORK_DEFERRED
 */
export class ManagedFilesStubCollector extends StubCollector<'managed_files'> {
  readonly kind = 'managed_files' as const;
  readonly _reasonCode = 'DRIFT_FRAMEWORK_DEFERRED';
}
