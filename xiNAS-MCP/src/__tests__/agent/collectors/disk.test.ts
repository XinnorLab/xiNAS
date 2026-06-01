import { describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../../agent/collectors/base.js';
import { DiskCollector } from '../../../agent/collectors/disk.js';

/** Minimal fake for the disk probe interface injected into the collector. */
function makeFakeDiskProbe(
  options: {
    snapshotResult?: Array<{ id: string; model?: string }>;
    eventLines?: string[];
  } = {},
) {
  let _onDelta: ((event: { action: string; devname: string }) => void) | null = null;

  return {
    snapshot: vi.fn().mockResolvedValue(
      (options.snapshotResult ?? [{ id: 'nvme0n1', model: 'INTEL SSD' }]).map((d) => ({
        kind: 'Disk' as const,
        id: d.id,
        status: {
          name: d.id,
          ...(d.model ? { model: d.model } : {}),
          observed_at: new Date().toISOString(),
        },
      })),
    ),
    startEventStream: vi
      .fn()
      .mockImplementation((onDelta: (event: { action: string; devname: string }) => void) => {
        _onDelta = onDelta;
        return { stop: vi.fn() };
      }),
    _fireEvent(action: string, devname: string) {
      _onDelta?.({ action, devname });
    },
  };
}

describe('DiskCollector', () => {
  it('initialSweep: returns ObservationDelta[] from probe snapshot', async () => {
    const probe = makeFakeDiskProbe({
      snapshotResult: [{ id: 'nvme0n1', model: 'INTEL SSD' }, { id: 'nvme1n1' }],
    });
    const collector = new DiskCollector({ probe });
    const deltas = await collector.initialSweep();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ kind: 'Disk', id: 'nvme0n1', op: 'upsert' });
    expect(deltas[0]?.value?.status).toMatchObject({ model: 'INTEL SSD' });
    // status.observed_at must be present
    expect(typeof (deltas[0]?.value?.status as Record<string, unknown>)?.observed_at).toBe(
      'string',
    );
  });

  it('start: subscribes to udevadm events and emits upsert delta on add', async () => {
    const probe = makeFakeDiskProbe({ snapshotResult: [{ id: 'nvme0n1' }] });
    const collector = new DiskCollector({ probe });
    const received: ObservationDelta[] = [];
    await collector.start((d) => received.push(d));
    // Simulate a udevadm "add" event for a new device
    probe._fireEvent('add', 'nvme2n1');
    // The collector should re-probe and emit an upsert for nvme2n1
    // (snapshot is called again on event)
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    const upsert = received.find((d) => d.id === 'nvme2n1');
    expect(upsert?.op).toBe('upsert');
    await collector.stop();
  });

  it('start: emits delete delta on remove event', async () => {
    const probe = makeFakeDiskProbe({ snapshotResult: [] });
    const collector = new DiskCollector({ probe });
    const received: ObservationDelta[] = [];
    await collector.start((d) => received.push(d));
    probe._fireEvent('remove', 'nvme0n1');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'Disk', id: 'nvme0n1', op: 'delete' });
    await collector.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeDiskProbe();
    const collector = new DiskCollector({ probe });
    await collector.start(() => {});
    expect(collector.health().state).toBe('running');
    await collector.stop();
  });

  it('health: reports error when snapshot throws', async () => {
    const probe = makeFakeDiskProbe();
    probe.snapshot.mockRejectedValueOnce(new Error('lsblk failed'));
    const collector = new DiskCollector({ probe });
    await collector.initialSweep().catch(() => {});
    expect(collector.health().state).toBe('error');
  });

  it('pollIntervalMs: is 60000', () => {
    const probe = makeFakeDiskProbe();
    const collector = new DiskCollector({ probe });
    expect(collector.pollIntervalMs).toBe(60_000);
  });
});
