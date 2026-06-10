import type { Collector, ObservationDelta } from './base.js';

interface FilesystemStatus {
  mountpoint?: string;
  fs_type?: string;
  backing_device?: string;
  /** Canonical runtime mount flag (ADR-0007 §Observation normalization,
   *  S5 T1; the former `currently_mounted` was removed from the contract). */
  mounted?: boolean;
  mount_options?: string[];
  /** Enrichment fields (S5 T6 — blkid/statfs). */
  uuid?: string;
  label?: string;
  size_bytes?: number;
  free_bytes?: number;
  effective_mount_options?: string[];
  mount_unit_name?: string;
  mount_unit_enabled?: boolean;
  mount_unit_state?: string;
  observed_at: string;
}

interface ObservedFilesystem {
  kind: 'Filesystem';
  id: string;
  status: FilesystemStatus;
}

interface WatchHandle {
  stop(): void;
}

interface FilesystemProbe {
  /**
   * Snapshot: reads /etc/systemd/system/*.mount + cross-references
   * /proc/self/mountinfo to fill `mounted` + mount_options (S5 T6).
   */
  snapshot(): Promise<ObservedFilesystem[]>;
  /**
   * Starts inotify on /etc/systemd/system/ (filter *.mount) + dbus on
   * .mount units. Fires callback on any change with (eventType, filename).
   */
  watchMountUnits(cb: (eventType: string, filename: string) => void): WatchHandle;
}

interface FilesystemCollectorOptions {
  probe: FilesystemProbe;
}

/**
 * Filesystem collector. Wires D4 probe + B4 mount-unit parser + B5
 * mountinfo cross-reference.
 *
 * Event source: inotify on /etc/systemd/system/ (*.mount files) + dbus
 * on .mount units for active-state changes.
 * Poll fallback: 60 s (5-minute backstop reconcile per spec F1).
 *
 * Delta logic:
 *   - A .mount file appears or changes → re-snapshot → upsert.
 *   - A .mount file is no longer in snapshot but was previously known → delete.
 *   - Non-.mount files are ignored.
 */
export class FilesystemCollector implements Collector<'Filesystem'> {
  readonly kind = 'Filesystem' as const;
  readonly pollIntervalMs = 60_000;

  /** Tracks known .mount unit ids so we can emit deletes when they vanish. */
  readonly _knownIds: Set<string> = new Set();

  private readonly probe: FilesystemProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = {
    state: 'running',
  };
  private _watch: WatchHandle | null = null;

  constructor({ probe }: FilesystemCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const filesystems = await this.probe.snapshot();
      this._knownIds.clear();
      return filesystems.map((fs) => {
        this._knownIds.add(fs.id);
        return this._fsToUpsert(fs);
      });
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._watch = this.probe.watchMountUnits(async (eventType, filename) => {
      // Filter: only react to .mount files
      if (!filename.endsWith('.mount')) return;
      try {
        const filesystems = await this.probe.snapshot();
        const newIds = new Set(filesystems.map((fs) => fs.id));

        // Emit upserts for all current filesystems
        for (const fs of filesystems) {
          this._knownIds.add(fs.id);
          emit(this._fsToUpsert(fs));
        }

        // Emit deletes for ids that were known but are no longer in snapshot
        for (const knownId of this._knownIds) {
          if (!newIds.has(knownId)) {
            this._knownIds.delete(knownId);
            emit({ kind: 'Filesystem', id: knownId, op: 'delete' });
          }
        }
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._watch?.stop();
    this._watch = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private _fsToUpsert(fs: ObservedFilesystem): ObservationDelta {
    const observedAt = fs.status.observed_at ?? new Date().toISOString();
    return {
      kind: 'Filesystem',
      id: fs.id,
      op: 'upsert',
      value: {
        kind: 'Filesystem',
        id: fs.id,
        status: {
          observed_at: observedAt,
          ...(fs.status.mountpoint !== undefined ? { mountpoint: fs.status.mountpoint } : {}),
          ...(fs.status.fs_type !== undefined ? { fs_type: fs.status.fs_type } : {}),
          ...(fs.status.backing_device !== undefined
            ? { backing_device: fs.status.backing_device }
            : {}),
          // `mounted` is the canonical flag (ADR-0007 §Observation
          // normalization); `currently_mounted` left the contract in S5 T0.
          ...(fs.status.mounted !== undefined ? { mounted: fs.status.mounted } : {}),
          ...(fs.status.mount_options !== undefined
            ? { mount_options: fs.status.mount_options }
            : {}),
          ...(fs.status.uuid !== undefined ? { uuid: fs.status.uuid } : {}),
          ...(fs.status.label !== undefined ? { label: fs.status.label } : {}),
          ...(fs.status.size_bytes !== undefined ? { size_bytes: fs.status.size_bytes } : {}),
          ...(fs.status.free_bytes !== undefined ? { free_bytes: fs.status.free_bytes } : {}),
          ...(fs.status.effective_mount_options !== undefined
            ? { effective_mount_options: fs.status.effective_mount_options }
            : {}),
          ...(fs.status.mount_unit_name !== undefined
            ? { mount_unit_name: fs.status.mount_unit_name }
            : {}),
          ...(fs.status.mount_unit_enabled !== undefined
            ? { mount_unit_enabled: fs.status.mount_unit_enabled }
            : {}),
          ...(fs.status.mount_unit_state !== undefined
            ? { mount_unit_state: fs.status.mount_unit_state }
            : {}),
        },
      },
    };
  }
}
