import type { Collector, ObservationDelta } from './base.js';

interface ObservedNfsSession {
  kind: 'NfsSession';
  id: string;
  spec: { client_addr: string; export_path: string; client_hostname?: string };
  status: {
    proto_version: string;
    locked_files: number;
    observed_at: string;
  };
}

interface ObservedExportEntry {
  export_path: string;
  host_pattern: string;
  options: string[];
  squash_mode?: string;
  anon_uid?: number;
  anon_gid?: number;
}

interface NfsProbe {
  listSessions(): Promise<ObservedNfsSession[]>;
  listExports(): Promise<ObservedExportEntry[]>;
}

interface NfsCollectorOptions {
  probe: NfsProbe;
}

/**
 * NFS collector. Wires D5 helper probe + B6 parser.
 *
 * Emits two kinds of deltas (same two-kind pattern E8 uses for User+Group):
 *   1. NfsSession upserts / deletes (client connections).
 *   2. ExportRule upserts keyed by export_path. ExportRule is an internal
 *      observed kind (no public REST endpoint); the api joins it into
 *      Share.status.exports[] at read time (Task I6). The collector does
 *      NOT touch Share rows.
 *
 * No event source from the helper → 30 s poll only.
 */
export class NfsCollector implements Collector<'NfsSession'> {
  readonly kind = 'NfsSession' as const;
  readonly pollIntervalMs = 30_000;

  private readonly probe: NfsProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor({ probe }: NfsCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      return await this._buildDeltas();
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    // NFS helper has no event source; rely on pollIntervalMs backstop from publisher.
    // Expose _poll for testing.
  }

  /** Exposed for test injection; the publisher drives polling via pollIntervalMs. */
  async _poll(emit: (delta: ObservationDelta) => void): Promise<void> {
    try {
      const deltas = await this._buildDeltas();
      for (const delta of deltas) emit(delta);
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDeltas(): Promise<ObservationDelta[]> {
    const observedAt = new Date().toISOString();
    const [sessions, exports_] = await Promise.all([
      this.probe.listSessions(),
      this.probe.listExports(),
    ]);

    const deltas: ObservationDelta[] = [];

    // NfsSession upserts
    for (const session of sessions) {
      deltas.push({
        kind: 'NfsSession',
        id: session.id,
        op: 'upsert',
        value: {
          kind: 'NfsSession',
          id: session.id,
          spec: session.spec,
          status: { ...session.status, observed_at: observedAt },
        },
      });
    }

    // Export-rule fold-in: group exports by export_path, emit one ExportRule upsert per path
    // carrying { rules: ExportEntry[], observed_at } so the api can merge into Share.status.exports[].
    const byPath = new Map<string, ObservedExportEntry[]>();
    for (const entry of exports_) {
      const list = byPath.get(entry.export_path) ?? [];
      list.push(entry);
      byPath.set(entry.export_path, list);
    }
    for (const [exportPath, rules] of byPath) {
      deltas.push({
        kind: 'ExportRule', // internal observed kind (no public REST endpoint).
        id: exportPath, // KV: /xinas/v1/observed/ExportRule/<export_path>
        op: 'upsert',
        value: {
          kind: 'ExportRule',
          id: exportPath,
          spec: { export_path: exportPath },
          status: {
            rules: rules.map((r) => ({
              host_pattern: r.host_pattern,
              options: r.options,
              ...(r.squash_mode !== undefined ? { squash_mode: r.squash_mode } : {}),
              ...(r.anon_uid !== undefined ? { anon_uid: r.anon_uid } : {}),
              ...(r.anon_gid !== undefined ? { anon_gid: r.anon_gid } : {}),
            })),
            observed_at: observedAt,
          },
        },
      });
    }

    return deltas;
  }
}
