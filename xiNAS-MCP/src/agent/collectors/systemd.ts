import type { Collector, ObservationDelta } from './base.js';

interface UnitState {
  load_state: string;
  active_state: string;
  sub_state: string;
  unit_file_state?: string;
}

interface WatchHandle {
  stop(): void;
}

interface SystemdProbe {
  /** The allow-listed unit names to observe. */
  allowList: string[];
  /** Reads current state of a unit via systemctl show or dbus. */
  getUnitState(name: string): Promise<UnitState>;
  /** Subscribes to dbus PropertiesChanged for the given unit names. */
  subscribeAllowListed(units: string[], onChanged: (unitName: string) => void): WatchHandle;
}

interface SystemdUnitCollectorOptions {
  probe: SystemdProbe;
}

/**
 * SystemdUnit collector. Wires D7 dbus probe.
 *
 * Only emits for allow-listed units (e.g. nfs-server.service, nfs-idmapd.service,
 * nfs-mountd.service, plus any *.mount units discovered by D4).
 * Units outside the allow-list are silently ignored even if dbus fires for them.
 *
 * Event source: dbus PropertiesChanged (no poll alternative from dbus).
 * Poll fallback: 30 s (catches stuck-state units that didn't fire PropertiesChanged).
 */
export class SystemdUnitCollector implements Collector<'SystemdUnit'> {
  readonly kind = 'SystemdUnit' as const;
  readonly pollIntervalMs = 30_000;

  private readonly probe: SystemdProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };
  private _subscription: WatchHandle | null = null;
  private readonly _allowSet: Set<string>;

  constructor({ probe }: SystemdUnitCollectorOptions) {
    this.probe = probe;
    this._allowSet = new Set(probe.allowList);
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const deltas = await Promise.all(this.probe.allowList.map((unit) => this._buildDelta(unit)));
      return deltas;
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._subscription = this.probe.subscribeAllowListed(this.probe.allowList, async (unitName) => {
      if (!this._allowSet.has(unitName)) return;
      try {
        emit(await this._buildDelta(unitName));
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._subscription?.stop();
    this._subscription = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDelta(unitName: string): Promise<ObservationDelta> {
    const state = await this.probe.getUnitState(unitName);
    const observedAt = new Date().toISOString();
    return {
      kind: 'SystemdUnit',
      id: unitName,
      op: 'upsert',
      value: {
        kind: 'SystemdUnit',
        id: unitName,
        status: {
          load_state: state.load_state,
          active_state: state.active_state,
          sub_state: state.sub_state,
          ...(state.unit_file_state !== undefined
            ? { unit_file_state: state.unit_file_state }
            : {}),
          observed_at: observedAt,
        },
      },
    };
  }
}
