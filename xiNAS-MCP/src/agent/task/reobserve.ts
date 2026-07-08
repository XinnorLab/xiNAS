/**
 * Post-apply observed settle (s2-task-envelope-spec §7.1).
 *
 * Observed rows (`/xinas/v1/observed/<kind>/<id>`) are refreshed only by the
 * collectors — event streams plus a poll backstop (Filesystem is poll-only,
 * 60 s). A client that chains two plan/apply calls back-to-back (the
 * Delete-Array / Delete-Filesystem teardown issues `fs.unmount` then
 * `fs.unmanage`) would have the second call's preflight read the PRE-apply
 * observed snapshot — e.g. `fs.unmanage` sees the just-unmounted filesystem
 * still `mounted: true` and returns the `fs_mounted` blocker. This module
 * re-runs the affected collectors and flushes them BEFORE the runner emits
 * `terminal` (the event `plan_apply_wait` blocks on), so the next plan reads
 * post-apply state. It reuses the exact `initialSweep → enqueue →
 * flushWithSnapshot` the poll driver uses, so reconcile semantics are
 * identical.
 */
import type { Collector, Kind, ObservationDelta } from '../collectors/base.js';
import { log } from '../log.js';

/** The minimal publisher surface the settle needs (Publisher implements it). */
export interface ReobservePublisher {
  enqueue(delta: ObservationDelta): void;
  flushWithSnapshot(kinds: Kind[]): Promise<void>;
}

/** The minimal registry surface the settle needs (CollectorRegistry implements it). */
export interface ReobserveRegistry {
  list(): readonly Collector[];
}

/**
 * `operation_kind` → observed kinds to settle after a successful apply (§7.1).
 * Operation kinds absent here skip the settle (the poll backstop still
 * reconciles within one interval).
 *
 * INVARIANT: every kind in an entry is (co-)emitted by a collector whose `kind`
 * is ALSO in that entry — so sweeping the entry's collector-kind collectors
 * yields a complete snapshot of every listed kind. The NFS collector's `kind`
 * is `NfsSession` but its one sweep also emits `ExportRule`, so `share.*`
 * lists both: settling `ExportRule` is what lets a chained `fs.unmount` see a
 * just-removed export gone (`validateFsUnmount`'s `mountpoint_exported`) — even
 * when the LAST export is removed and the sweep carries zero `ExportRule` rows
 * (the complete-snapshot flush then reconciles the stale row away).
 */
export const REOBSERVE_KINDS: Record<string, Kind[]> = {
  'fs.create': ['Filesystem'],
  'fs.mount': ['Filesystem'],
  'fs.unmount': ['Filesystem'],
  'fs.grow': ['Filesystem'],
  'fs.set_quota_mode': ['Filesystem'],
  'fs.unmanage': ['Filesystem'],
  'xiraid.array.create': ['XiraidArray'],
  'xiraid.array.modify': ['XiraidArray'],
  'xiraid.array.import': ['XiraidArray'],
  'xiraid.array.delete': ['XiraidArray'],
  'pool.create': ['Pool'],
  'pool.modify': ['Pool'],
  'pool.delete': ['Pool'],
  'share.create': ['NfsSession', 'ExportRule'],
  'share.update': ['NfsSession', 'ExportRule'],
  'share.delete': ['NfsSession', 'ExportRule'],
};

/**
 * The settle callback injected into the {@link TaskRunner}. Resolves ALWAYS
 * (best-effort); it never rejects and never blocks the task's terminal event.
 */
export type Reobserve = (operationKind: string) => Promise<void>;

/**
 * Build the post-apply observed settle (§7.1). Best-effort: every collector
 * sweep or flush error is logged and swallowed, and the promise always
 * resolves so the runner can proceed to `terminal` — the poll backstop
 * remains the durable reconcile.
 */
export function makeReobserve(
  registry: ReobserveRegistry,
  publisher: ReobservePublisher,
): Reobserve {
  return async (operationKind: string): Promise<void> => {
    const kinds = REOBSERVE_KINDS[operationKind];
    if (kinds === undefined || kinds.length === 0) return;
    const wanted = new Set<Kind>(kinds);
    // The entry's kinds that a registered collector produces directly (its
    // `kind`); the remaining kinds (e.g. ExportRule) are co-emitted by one of
    // these collectors' sweeps. Only when EVERY collector-kind swept cleanly do
    // we run the complete-snapshot flush — otherwise a failed sweep could
    // reconcile a kind's rows away against an empty batch.
    const registeredKinds = new Set<Kind>(registry.list().map((c) => c.kind));
    const collectorKinds = kinds.filter((k) => registeredKinds.has(k));
    const sweptOk = new Set<Kind>();
    for (const collector of registry.list()) {
      if (!wanted.has(collector.kind)) continue;
      try {
        const deltas = await collector.initialSweep();
        for (const delta of deltas) publisher.enqueue(delta);
        sweptOk.add(collector.kind);
      } catch (err) {
        log('error', 'reobserve', 'reobserve_sweep_failed', {
          kind: collector.kind,
          operation_kind: operationKind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (collectorKinds.length === 0 || !collectorKinds.every((k) => sweptOk.has(k))) return;
    // Complete-snapshot flush of the FULL settle set — including a kind whose
    // sweep produced zero rows (the last export removed), so its stale observed
    // row reconciles away. Safe because every collector-kind swept cleanly and
    // each such sweep carries a complete snapshot of every kind it owns.
    try {
      await publisher.flushWithSnapshot(kinds);
    } catch (err) {
      log('error', 'reobserve', 'reobserve_flush_failed', {
        operation_kind: operationKind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
