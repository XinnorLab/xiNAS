import type { CollectorRegistry, Kind, ObservationDelta } from './collectors/base.js';
import type { Publisher } from './publisher.js';

export interface BootSequenceOptions {
  publisher: Publisher;
  registry: CollectorRegistry;
  controllerId: string;
}

/**
 * runBootSequence implements the spec's Flow C startup:
 *   1. For each collector, call initialSweep() (best-effort; a throw is
 *      logged and treated as an empty sweep so one bad collector doesn't
 *      abort boot).
 *   2. Enqueue its deltas and flushWithSnapshot(kinds) where kinds is the
 *      union of the collector's primary kind plus every kind present in
 *      its deltas — so a dual-kind collector (Users -> User+Group, NFS ->
 *      NfsSession+ExportRule) marks ALL its kinds complete, and an empty
 *      collector still reconciles its primary kind to empty.
 *   3. After all sweeps, POST /internal/v1/agent_started once so the api
 *      clears its heartbeat startup grace timer.
 * The caller starts steady-state event updates separately via
 * registry.start(emit).
 */
export async function runBootSequence(opts: BootSequenceOptions): Promise<void> {
  const { publisher, registry, controllerId } = opts;

  // Boot mode: suppress enqueue's ceiling/debounce auto-flush so each kind is
  // sent as exactly ONE flushWithSnapshot([kind]) reconcile batch below. Without
  // this, a kind exceeding 256/1MB would early-flush a partial (no reconcile),
  // then the trailing flushWithSnapshot would reconcile-delete it. Restored in
  // the finally so steady-state debounce/ceiling resume after boot.
  publisher.setBootMode(true);
  try {
    for (const collector of registry.list()) {
      let deltas: ObservationDelta[] = [];
      try {
        deltas = await collector.initialSweep();
      } catch (err) {
        process.stderr.write(
          `${JSON.stringify({
            time: new Date().toISOString(),
            level: 'error',
            subsystem: 'boot',
            event: 'initial_sweep_failed',
            kind: collector.kind,
            error: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
        deltas = [];
      }
      for (const delta of deltas) {
        publisher.enqueue(delta);
      }
      const kinds = new Set<Kind>([collector.kind, ...deltas.map((d) => d.kind)]);
      await publisher.flushWithSnapshot([...kinds]);
    }
  } finally {
    publisher.setBootMode(false);
  }

  await publisher.postOnce('/internal/v1/agent_started', { controller_id: controllerId });
}
