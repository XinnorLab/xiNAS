/**
 * Collector<K> interface and CollectorRegistry.
 *
 * Collectors orchestrate probe calls + parse helpers to emit typed
 * ObservationDelta values. This module is pure orchestration — no system
 * calls allowed here. Those live in src/agent/probe/.
 */

export type Kind =
  | 'Disk'
  | 'NetworkInterface'
  | 'Filesystem'
  | 'NfsSession'
  | 'ExportRule' // internal observed kind; no public REST endpoint.
  // Joined into Share.status.exports[] at read time (see I6).
  | 'NfsIdmap'
  | 'NfsProfile' // observed singleton (id 'default'); folded into GET /nfs-profiles at read time (N7.2).
  | 'SystemdUnit'
  | 'User'
  | 'Group'
  | 'XiraidArray'
  | 'NetworkConfig' // internal observed singleton (id 'default'); netplan file-set summary (ADR-0008).
  | 'Tuning' // internal observed singleton (id 'default'); sysctl expected-vs-actual (ADR-0009).
  | 'ConfigSnapshot' // xinas_history snapshot manifests, projected (ADR-0011).
  | 'Pool' // xiRAID spare pools (ADR-0011).
  | 'managed_files'
  | 'inventory';

export interface ObservationDelta {
  kind: Kind;
  id: string;
  op: 'upsert' | 'delete';
  value?: Record<string, unknown>;
}

/**
 * The observed-state KV path segment for a kind.
 *
 * The object's `kind` field is the api-v1.yaml PascalCase const, but a few
 * singletons store under a different segment: kinds whose const is already
 * lowercase (`inventory`, `managed_files`) store as-is, and `NfsIdmap`
 * stores under `nfs_idmap` to match ADR-0003's locked path + the public
 * /api/v1/nfs-idmap route. Kinds WITH a desired counterpart (e.g.
 * `NfsProfile`) take the default: ADR-0003 says /observed/<kind>/<id>
 * MIRRORS /desired/<kind>/<id>, and desired keys use the PascalCase kind
 * const — so observed NfsProfile lives at /xinas/v1/observed/NfsProfile/default,
 * no mapping entry. Both the write path (H3 observed handler) and
 * every read path (I3, I6, etc.) MUST derive the segment through this
 * function so writer and reader never disagree.
 */
const PATH_SEGMENT: Partial<Record<Kind, string>> = { NfsIdmap: 'nfs_idmap' };
export function observedSegment(kind: Kind): string {
  return PATH_SEGMENT[kind] ?? kind;
}

export interface Collector<K extends Kind = Kind> {
  kind: K;
  /** Full current state. Emitted on boot with complete_snapshots: [kind]. */
  initialSweep(): Promise<ObservationDelta[]>;
  /** Start event subscriptions. Call emit() each time state changes. */
  start(emit: (delta: ObservationDelta) => void): Promise<void>;
  /** Tear down all subscriptions and timers. */
  stop(): Promise<void>;
  /** If set, the publisher runs this collector on a poll interval as a fallback. */
  pollIntervalMs?: number;
  /** Current collector health for surfacing in agent.health. */
  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string };
  /**
   * The observed kinds whose health this collector represents in
   * agent.health. Defaults to [kind]. A collector that emits more than one
   * kind (e.g. Users emits User + Group) returns all of them so each gets
   * its own row in healthSnapshot(), matching the spec's collectors map.
   * Internal-only kinds (e.g. ExportRule) are intentionally omitted.
   */
  healthKinds?(): Kind[];
}

/** Serialises a health() result to the string format returned by agent.health. */
function healthString(h: { state: 'running' | 'stubbed' | 'error'; reason?: string }): string {
  if (h.state === 'error') {
    return `error: ${h.reason ?? 'unknown'}`;
  }
  return h.state;
}

/**
 * CollectorRegistry holds all registered collectors and coordinates
 * lifecycle (start / stop / initialSweep) and health reporting.
 */
export class CollectorRegistry {
  private readonly collectors: Collector[] = [];

  register(collector: Collector): void {
    this.collectors.push(collector);
  }

  /** Read-only view of registered collectors, for the boot sequence's per-collector sweep. */
  list(): readonly Collector[] {
    return this.collectors;
  }

  /**
   * Returns deltas from every registered collector's initialSweep().
   * Uses allSettled so one failing collector (e.g. nfs-helper down) cannot
   * blind the whole fleet: a rejected collector has already set its own
   * health=error before rethrowing, so healthSnapshot() still surfaces it,
   * while every healthy collector's deltas are returned. Per spec, one
   * collector in error degrades the node — it does not lose all data.
   */
  async initialSweep(): Promise<ObservationDelta[]> {
    const results = await Promise.allSettled(this.collectors.map((c) => c.initialSweep()));
    const deltas: ObservationDelta[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') deltas.push(...r.value);
    }
    return deltas;
  }

  /**
   * Starts all collectors, routing their emits through the shared emit
   * callback. allSettled so a failing start() doesn't abort the fleet and
   * leave later collectors unsubscribed.
   */
  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    await Promise.allSettled(this.collectors.map((c) => c.start(emit)));
  }

  /**
   * Stops all collectors. allSettled is critical here: a failed stop() on
   * one collector must not prevent stopping the rest, or their event
   * subprocesses (udevadm/ip monitor) would survive shutdown.
   */
  async stop(): Promise<void> {
    await Promise.allSettled(this.collectors.map((c) => c.stop()));
  }

  /**
   * Returns a snapshot of per-collector health for agent.health.
   * Format: { '<Kind>': 'running' | 'stubbed' | 'error: <reason>' }
   */
  healthSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const col of this.collectors) {
      const h = healthString(col.health());
      const kinds = col.healthKinds ? col.healthKinds() : [col.kind];
      for (const k of kinds) {
        out[k] = h;
      }
    }
    return out;
  }
}
