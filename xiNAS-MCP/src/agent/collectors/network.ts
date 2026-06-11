import type { Collector, ObservationDelta } from './base.js';

interface NetworkInterfaceStatus {
  name: string;
  operstate?: string;
  mac?: string;
  mtu?: number;
  observed_at: string;
}

interface ObservedNetworkInterface {
  kind: 'NetworkInterface';
  id: string;
  status: NetworkInterfaceStatus;
}

interface NetworkEvent {
  id: string;
  op: 'upsert' | 'delete';
  attrs: Record<string, unknown>;
}

interface EventStream {
  stop(): void;
}

interface NetworkProbe {
  snapshot(): Promise<ObservedNetworkInterface[]>;
  startEventStream(onEvent: (event: NetworkEvent) => void): EventStream;
  /** NetworkConfig/default singleton content (S6 T5; optional for old fakes). */
  netplanSummary?(): Promise<Record<string, unknown> | undefined>;
}

interface NetworkInterfaceCollectorOptions {
  probe: NetworkProbe;
  /** Override the 30 s sweep (XINAS_AGENT_NETWORK_POLL_MS — e2e). */
  pollIntervalMs?: number;
}

/**
 * NetworkInterface collector. Wires D3 network probe + B2 ip-json parser.
 *
 * Event source: `ip -j monitor link addr` subprocess.
 * Poll fallback: 30 s (ibstat snapshot for IB-specific fields is also on 30 s).
 * Events from the probe are pre-parsed into { id, op, attrs } by the probe layer.
 */
export class NetworkInterfaceCollector implements Collector<'NetworkInterface'> {
  readonly kind = 'NetworkInterface' as const;
  readonly pollIntervalMs: number;

  private readonly probe: NetworkProbe;
  private _state: 'running' | 'stubbed' | 'error' = 'running';
  private _reason: string | undefined = undefined;
  private _stream: EventStream | null = null;
  /** Compare-and-skip key for the NetworkConfig singleton (ADR-0008):
   *  re-emit only when the hash/duplicate content changes — the api-side
   *  sweep dedupe would skip identical re-pushes anyway, this just keeps
   *  them off the wire. */
  private _lastSummaryKey: string | null = null;

  constructor({ probe, pollIntervalMs }: NetworkInterfaceCollectorOptions) {
    this.probe = probe;
    this.pollIntervalMs = pollIntervalMs ?? 30_000;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const ifaces = await this.probe.snapshot();
      const deltas = ifaces.map((iface) => this._ifaceToUpsert(iface));
      const summary = await this.probe.netplanSummary?.();
      if (summary !== undefined) {
        const key = JSON.stringify({
          w: summary.world_config_hash,
          x: summary.xinas_file_hash,
          d: summary.duplicates,
        });
        if (key !== this._lastSummaryKey) {
          this._lastSummaryKey = key;
          deltas.push({
            kind: 'NetworkConfig',
            id: 'default',
            op: 'upsert',
            value: {
              kind: 'NetworkConfig',
              id: 'default',
              status: { ...summary, observed_at: new Date().toISOString() },
            },
          });
        }
      }
      return deltas;
    } catch (err) {
      this._state = 'error';
      this._reason = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._state = 'running';
    this._reason = undefined;
    this._stream = this.probe.startEventStream((event) => {
      try {
        if (event.op === 'delete') {
          emit({ kind: 'NetworkInterface', id: event.id, op: 'delete' });
        } else {
          const observedAt = new Date().toISOString();
          emit({
            kind: 'NetworkInterface',
            id: event.id,
            op: 'upsert',
            value: {
              kind: 'NetworkInterface',
              id: event.id,
              status: {
                name: event.id,
                ...event.attrs,
                observed_at: observedAt,
              },
            },
          });
        }
      } catch (err) {
        this._state = 'error';
        this._reason = err instanceof Error ? err.message : String(err);
      }
    });
  }

  async stop(): Promise<void> {
    this._stream?.stop();
    this._stream = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return {
      state: this._state,
      ...(this._reason !== undefined ? { reason: this._reason } : {}),
    };
  }

  private _ifaceToUpsert(iface: ObservedNetworkInterface): ObservationDelta {
    const observedAt = iface.status.observed_at ?? new Date().toISOString();
    return {
      kind: 'NetworkInterface',
      id: iface.id,
      op: 'upsert',
      value: {
        kind: 'NetworkInterface',
        id: iface.id,
        status: { ...iface.status, observed_at: observedAt },
      },
    };
  }
}
