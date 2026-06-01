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
  | 'SystemdUnit'
  | 'User'
  | 'Group'
  | 'XiraidArray'
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
 * /api/v1/nfs-idmap route. Both the write path (H3 observed handler) and
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

  /** Returns deltas from every registered collector's initialSweep(). */
  async initialSweep(): Promise<ObservationDelta[]> {
    const results = await Promise.all(this.collectors.map((c) => c.initialSweep()));
    return results.flat();
  }

  /** Starts all collectors, routing their emits through the shared emit callback. */
  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    await Promise.all(this.collectors.map((c) => c.start(emit)));
  }

  /** Stops all collectors. */
  async stop(): Promise<void> {
    await Promise.all(this.collectors.map((c) => c.stop()));
  }

  /**
   * Returns a snapshot of per-collector health for agent.health.
   * Format: { '<Kind>': 'running' | 'stubbed' | 'error: <reason>' }
   */
  healthSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const col of this.collectors) {
      out[col.kind] = healthString(col.health());
    }
    return out;
  }
}
