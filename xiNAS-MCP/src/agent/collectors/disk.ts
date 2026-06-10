import type { Collector, ObservationDelta } from './base.js';

interface DiskStatus {
  name: string;
  device_path?: string;
  model?: string;
  serial?: string;
  transport?: string;
  wwn?: string;
  size_text?: string;
  capacity_bytes?: number;
  system_disk?: boolean;
  mounted?: boolean;
  safe_for_use?: boolean;
  observed_at: string;
}

interface ObservedDisk {
  kind: 'Disk';
  id: string;
  status: DiskStatus;
}

interface UdevEvent {
  action: string;
  devname: string;
}

interface EventStream {
  stop(): void;
}

interface DiskProbe {
  snapshot(): Promise<ObservedDisk[]>;
  startEventStream(onDelta: (event: UdevEvent) => void): EventStream;
}

interface DiskCollectorOptions {
  probe: DiskProbe;
}

/**
 * Disk collector. Wires the disk probe (D2) and lsblk parser (B1).
 *
 * Event source: udevadm monitor (one blank-line-terminated record per event).
 * Poll fallback: 60 s (probe snapshot re-emitted as upserts).
 * On "add" or "change": re-probes via snapshot(), emits upsert for the device.
 * On "remove": emits delete without re-probing.
 */
export class DiskCollector implements Collector<'Disk'> {
  readonly kind = 'Disk' as const;
  readonly pollIntervalMs = 60_000;

  private readonly probe: DiskProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };
  private _stream: EventStream | null = null;

  constructor({ probe }: DiskCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const disks = await this.probe.snapshot();
      return disks.map((disk) => this._diskToUpsert(disk));
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._stream = this.probe.startEventStream(async (event) => {
      try {
        if (event.action === 'remove') {
          emit({ kind: 'Disk', id: event.devname, op: 'delete' });
        } else {
          // add or change — re-snapshot and emit upsert for the affected device
          const disks = await this.probe.snapshot();
          const affected = disks.find((d) => d.id === event.devname);
          if (affected) {
            emit(this._diskToUpsert(affected));
          } else {
            // device not found in snapshot after add — treat as upsert with minimal info
            emit({
              kind: 'Disk',
              id: event.devname,
              op: 'upsert',
              value: {
                status: {
                  name: event.devname,
                  observed_at: new Date().toISOString(),
                },
              },
            });
          }
        }
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._stream?.stop();
    this._stream = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private _diskToUpsert(disk: ObservedDisk): ObservationDelta {
    const observedAt = disk.status.observed_at ?? new Date().toISOString();
    return {
      kind: 'Disk',
      id: disk.id,
      op: 'upsert',
      value: {
        kind: 'Disk',
        id: disk.id,
        status: {
          name: disk.status.name,
          observed_at: observedAt,
          ...(disk.status.device_path !== undefined ? { device_path: disk.status.device_path } : {}),
          ...(disk.status.model !== undefined ? { model: disk.status.model } : {}),
          ...(disk.status.serial !== undefined ? { serial: disk.status.serial } : {}),
          ...(disk.status.transport !== undefined ? { transport: disk.status.transport } : {}),
          ...(disk.status.wwn !== undefined ? { wwn: disk.status.wwn } : {}),
          ...(disk.status.size_text !== undefined ? { size_text: disk.status.size_text } : {}),
          ...(disk.status.capacity_bytes !== undefined
            ? { capacity_bytes: disk.status.capacity_bytes }
            : {}),
          ...(disk.status.system_disk !== undefined ? { system_disk: disk.status.system_disk } : {}),
          ...(disk.status.mounted !== undefined ? { mounted: disk.status.mounted } : {}),
          ...(disk.status.safe_for_use !== undefined
            ? { safe_for_use: disk.status.safe_for_use }
            : {}),
        },
      },
    };
  }
}
