import type { Collector, ObservationDelta } from './base.js';

interface IdmapResult {
  conf_present: boolean;
  domain?: string;
  local_realms?: string[];
  method?: string;
  idmapd_active: boolean;
  idmapd_unit_state?: string;
}

interface WatchHandle {
  stop(): void;
}

interface IdmapProbe {
  /** Reads /etc/idmapd.conf (via B7 parser) + systemctl is-active nfs-idmapd. */
  read(): Promise<IdmapResult>;
  /** inotify on /etc/idmapd.conf. */
  watchIdmapdConf(cb: () => void): WatchHandle;
  /** dbus subscription for nfs-idmapd.service PropertiesChanged. */
  subscribeIdmapdUnit(cb: () => void): WatchHandle;
}

interface NfsIdmapCollectorOptions {
  probe: IdmapProbe;
}

/**
 * NfsIdmap collector. Wires D6 idmap probe + B7 idmapd.conf parser.
 *
 * Singleton: always emits to id "snapshot".
 * Path: /xinas/v1/observed/nfs_idmap/snapshot
 *
 * Event sources: inotify on /etc/idmapd.conf + dbus on nfs-idmapd.service.
 * Poll fallback: 60 s.
 */
export class NfsIdmapCollector implements Collector<'NfsIdmap'> {
  readonly kind = 'NfsIdmap' as const;
  readonly pollIntervalMs = 60_000;

  private readonly probe: IdmapProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };
  private _confWatch: WatchHandle | null = null;
  private _dbusWatch: WatchHandle | null = null;

  constructor({ probe }: NfsIdmapCollectorOptions) {
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

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    const onChange = async () => {
      try {
        emit(await this._buildDelta());
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    };
    this._confWatch = this.probe.watchIdmapdConf(onChange);
    this._dbusWatch = this.probe.subscribeIdmapdUnit(onChange);
  }

  async stop(): Promise<void> {
    this._confWatch?.stop();
    this._dbusWatch?.stop();
    this._confWatch = null;
    this._dbusWatch = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDelta(): Promise<ObservationDelta> {
    const result = await this.probe.read();
    const observedAt = new Date().toISOString();
    return {
      kind: 'NfsIdmap',
      id: 'snapshot',
      op: 'upsert',
      value: {
        kind: 'NfsIdmap',
        status: {
          conf_present: result.conf_present,
          ...(result.domain !== undefined ? { domain: result.domain } : {}),
          ...(result.local_realms !== undefined ? { local_realms: result.local_realms } : {}),
          ...(result.method !== undefined ? { method: result.method } : {}),
          idmapd_active: result.idmapd_active,
          ...(result.idmapd_unit_state !== undefined
            ? { idmapd_unit_state: result.idmapd_unit_state }
            : {}),
          observed_at: observedAt,
        },
      },
    };
  }
}
