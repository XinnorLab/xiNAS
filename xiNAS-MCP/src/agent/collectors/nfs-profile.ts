import type { Collector, ObservationDelta } from './base.js';

interface NfsProfileRunning {
  thread_count: number;
  rdma_listening: boolean;
  rdma_port?: number;
  active_versions: string[];
}

interface NfsProfileResult {
  effective_files: Record<string, string>;
  /** Live nfsd runtime; absent when nfsd is down (probe omits it). */
  running?: NfsProfileRunning;
}

interface NfsProfileProbe {
  /** Checksums the four ADR-0005 effective files + reads the nfsd runtime
   *  from /proc/fs/nfsd (D-layer nfs-profile probe). */
  read(): Promise<NfsProfileResult>;
}

interface NfsProfileCollectorOptions {
  probe: NfsProfileProbe;
}

/**
 * Observed NfsProfile collector (S3 N7.2, s3 spec §3.4).
 *
 * Singleton: always emits to id "default" — the SAME id as the desired
 * NfsProfile resource (`/nfs-profiles/default`, ADR-0005's Phase-0
 * singleton), so the api's read-time status fold is a keyed mirror lookup.
 * Path: /xinas/v1/observed/NfsProfile/default
 *
 * Scope: status.effective_files (sha256 checksums of the four ADR-0005
 * files) + status.running (live nfsd runtime from /proc/fs/nfsd — thread
 * count, rdma listening/port, active versions; omitted when nfsd is down)
 * + observed_at.
 *
 * POLL-ONLY for v1: no inotify watchers on the four files — start() registers
 * no event sources and the 60 s pollIntervalMs backstop (PollDriver) re-sweeps,
 * so a manual edit surfaces within one interval.
 */
export class NfsProfileCollector implements Collector<'NfsProfile'> {
  readonly kind = 'NfsProfile' as const;
  readonly pollIntervalMs = 60_000;

  private readonly probe: NfsProfileProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };

  constructor({ probe }: NfsProfileCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      return [await this._buildDelta()];
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /** No event sources (poll-only); just mark the collector healthy. */
  async start(_emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
  }

  async stop(): Promise<void> {}

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDelta(): Promise<ObservationDelta> {
    const result = await this.probe.read();
    return {
      kind: 'NfsProfile',
      id: 'default',
      op: 'upsert',
      value: {
        kind: 'NfsProfile',
        id: 'default',
        status: {
          effective_files: result.effective_files,
          ...(result.running !== undefined ? { running: result.running } : {}),
          observed_at: new Date().toISOString(),
        },
      },
    };
  }
}
