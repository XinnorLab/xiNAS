import type { Collector, ObservationDelta } from './base.js';

interface InventoryResult {
  hostname: string;
  os_kernel: string;
  cpu_model?: string;
  cpu_cores?: number;
  cpu_threads?: number;
  mem_total_kb?: number;
  arch?: string;
}

interface InventoryProbe {
  /**
   * Reads /proc/cpuinfo + /proc/meminfo + os.uname().
   * Parses via B10 helpers.
   */
  read(): Promise<InventoryResult>;
}

interface InventoryCollectorOptions {
  probe: InventoryProbe;
}

/**
 * Inventory collector. Wires D9 probe + B10 parsers.
 *
 * Singleton: always emits to id "snapshot".
 * Path: /xinas/v1/observed/inventory/snapshot
 *
 * No event source. Pure poll at 300 s.
 * Preserves the PR #201 inventory shape (hostname, kernel, cpu, mem).
 */
export class InventoryCollector implements Collector<'inventory'> {
  readonly kind = 'inventory' as const;
  readonly pollIntervalMs = 300_000;

  private readonly probe: InventoryProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };

  constructor({ probe }: InventoryCollectorOptions) {
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

  /** No events for inventory — start() is a no-op. Publisher drives poll via pollIntervalMs. */
  async start(_emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
  }

  async stop(): Promise<void> {
    // Nothing to tear down.
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDelta(): Promise<ObservationDelta> {
    const result = await this.probe.read();
    const observedAt = new Date().toISOString();
    return {
      kind: 'inventory',
      id: 'snapshot',
      op: 'upsert',
      value: {
        kind: 'inventory',
        id: 'snapshot',
        status: {
          hostname: result.hostname,
          os_kernel: result.os_kernel,
          ...(result.cpu_model !== undefined ? { cpu_model: result.cpu_model } : {}),
          ...(result.cpu_cores !== undefined ? { cpu_cores: result.cpu_cores } : {}),
          ...(result.cpu_threads !== undefined ? { cpu_threads: result.cpu_threads } : {}),
          ...(result.mem_total_kb !== undefined ? { mem_total_kb: result.mem_total_kb } : {}),
          ...(result.arch !== undefined ? { arch: result.arch } : {}),
          observed_at: observedAt,
        },
      },
    };
  }
}
