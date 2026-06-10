import { describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../../agent/collectors/base.js';
import { FilesystemCollector } from '../../../agent/collectors/filesystem.js';

function makeFakeFsProbe(
  options: {
    snapshotResult?: Array<{ id: string; mountpoint: string; mounted?: boolean }>;
  } = {},
) {
  let _watchCallback: ((eventType: string, filename: string) => void) | null = null;

  return {
    snapshot: vi.fn().mockResolvedValue(
      (
        options.snapshotResult ?? [
          { id: 'srv-share01.mount', mountpoint: '/srv/share01', mounted: true },
        ]
      ).map((fs) => ({
        kind: 'Filesystem' as const,
        id: fs.id,
        status: {
          mountpoint: fs.mountpoint,
          mounted: fs.mounted ?? false,
          observed_at: new Date().toISOString(),
        },
      })),
    ),
    watchMountUnits: vi
      .fn()
      .mockImplementation((cb: (eventType: string, filename: string) => void) => {
        _watchCallback = cb;
        return { stop: vi.fn() };
      }),
    _fireWatchEvent(eventType: string, filename: string) {
      _watchCallback?.(eventType, filename);
    },
  };
}

describe('FilesystemCollector', () => {
  it('initialSweep: snapshot → upsert deltas with mounted and observed_at', async () => {
    const probe = makeFakeFsProbe({
      snapshotResult: [
        { id: 'srv-share01.mount', mountpoint: '/srv/share01', mounted: true },
        { id: 'srv-share02.mount', mountpoint: '/srv/share02', mounted: false },
      ],
    });
    const col = new FilesystemCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(2);
    const delta0 = deltas[0];
    expect(delta0).toMatchObject({ kind: 'Filesystem', id: 'srv-share01.mount', op: 'upsert' });
    expect((delta0?.value?.status as Record<string, unknown>)?.mounted).toBe(true);
    expect(typeof (delta0?.value?.status as Record<string, unknown>)?.observed_at).toBe('string');
  });

  it('start: new .mount file → re-snapshot → emit upsert', async () => {
    const probe = makeFakeFsProbe({
      snapshotResult: [{ id: 'srv-new.mount', mountpoint: '/srv/new', mounted: false }],
    });
    const col = new FilesystemCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatchEvent('rename', 'srv-new.mount');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'Filesystem', id: 'srv-new.mount', op: 'upsert' });
    await col.stop();
  });

  it('start: non-mount file change → no emit', async () => {
    const probe = makeFakeFsProbe({ snapshotResult: [] });
    const col = new FilesystemCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatchEvent('change', 'some-other.service');
    // give time to not emit
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('start: .mount file removed from snapshot → emit delete', async () => {
    const probe = makeFakeFsProbe({ snapshotResult: [] }); // empty after removal
    const col = new FilesystemCollector({ probe });
    // Seed a known prior state
    col['_knownIds'].add('srv-gone.mount');
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatchEvent('rename', 'srv-gone.mount');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'Filesystem', id: 'srv-gone.mount', op: 'delete' });
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeFsProbe();
    const col = new FilesystemCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 60000', () => {
    const probe = makeFakeFsProbe();
    expect(new FilesystemCollector({ probe }).pollIntervalMs).toBe(60_000);
  });
});
