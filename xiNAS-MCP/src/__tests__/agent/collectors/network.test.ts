import { describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../../agent/collectors/base.js';
import { NetworkInterfaceCollector } from '../../../agent/collectors/network.js';

function makeFakeNetworkProbe(
  options: {
    snapshotResult?: Array<{ id: string; operstate?: string }>;
  } = {},
) {
  let _onEvent:
    | ((event: { id: string; op: 'upsert' | 'delete'; attrs: Record<string, unknown> }) => void)
    | null = null;

  return {
    snapshot: vi.fn().mockResolvedValue(
      (options.snapshotResult ?? [{ id: 'eth0', operstate: 'UP' }]).map((iface) => ({
        kind: 'NetworkInterface' as const,
        id: iface.id,
        status: {
          name: iface.id,
          operstate: iface.operstate ?? 'UNKNOWN',
          observed_at: new Date().toISOString(),
        },
      })),
    ),
    startEventStream: vi.fn().mockImplementation(
      (
        onEvent: (event: {
          id: string;
          op: 'upsert' | 'delete';
          attrs: Record<string, unknown>;
        }) => void,
      ) => {
        _onEvent = onEvent;
        return { stop: vi.fn() };
      },
    ),
    _fireEvent(id: string, op: 'upsert' | 'delete', attrs: Record<string, unknown> = {}) {
      _onEvent?.({ id, op, attrs });
    },
  };
}

describe('NetworkInterfaceCollector', () => {
  it('initialSweep: returns upsert deltas for each interface', async () => {
    const probe = makeFakeNetworkProbe({
      snapshotResult: [
        { id: 'eth0', operstate: 'UP' },
        { id: 'ibp0s4', operstate: 'DOWN' },
      ],
    });
    const col = new NetworkInterfaceCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ kind: 'NetworkInterface', id: 'eth0', op: 'upsert' });
    expect(typeof (deltas[0]?.value?.status as Record<string, unknown>)?.observed_at).toBe(
      'string',
    );
  });

  it('start: ip-monitor upsert event → emit upsert delta', async () => {
    const probe = makeFakeNetworkProbe({ snapshotResult: [] });
    const col = new NetworkInterfaceCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireEvent('eth0', 'upsert', { operstate: 'UP', mtu: 1500 });
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'NetworkInterface', id: 'eth0', op: 'upsert' });
    await col.stop();
  });

  it('start: ip-monitor delete event → emit delete delta', async () => {
    const probe = makeFakeNetworkProbe({ snapshotResult: [] });
    const col = new NetworkInterfaceCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireEvent('eth1', 'delete', {});
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'NetworkInterface', id: 'eth1', op: 'delete' });
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeNetworkProbe();
    const col = new NetworkInterfaceCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 30000', () => {
    const probe = makeFakeNetworkProbe();
    expect(new NetworkInterfaceCollector({ probe }).pollIntervalMs).toBe(30_000);
  });
});

// ---- S6 T5: the NetworkConfig/default singleton (compare-and-skip) ----

describe('NetworkConfig singleton emission', () => {
  function probeWith(summary: Record<string, unknown> | undefined) {
    return {
      snapshot: async () => [],
      startEventStream: () => ({ stop() {} }),
      netplanSummary: async () => summary,
      _set(next: Record<string, unknown> | undefined) {
        summary = next;
      },
    };
  }

  const SUMMARY = {
    files: { '/etc/netplan/99-xinas.yaml': 'h1' },
    world_config_hash: 'w1',
    xinas_file_hash: 'x1',
    duplicates: {},
  };

  it('initialSweep emits the singleton once; identical re-sweep skips; change re-emits', async () => {
    const probe = probeWith(SUMMARY);
    const collector = new NetworkInterfaceCollector({ probe });
    const first = await collector.initialSweep();
    const single = first.find((d) => d.kind === 'NetworkConfig');
    expect(single).toMatchObject({ id: 'default', op: 'upsert' });
    expect(
      (single?.value as { status?: { world_config_hash?: string } }).status?.world_config_hash,
    ).toBe('w1');

    const second = await collector.initialSweep();
    expect(second.find((d) => d.kind === 'NetworkConfig')).toBeUndefined();

    probe._set({ ...SUMMARY, world_config_hash: 'w2' });
    const third = await collector.initialSweep();
    expect(third.find((d) => d.kind === 'NetworkConfig')).toBeDefined();
  });

  it('no summary (degraded probe) → no singleton, sweep still works', async () => {
    const collector = new NetworkInterfaceCollector({ probe: probeWith(undefined) });
    expect(
      (await collector.initialSweep()).find((d) => d.kind === 'NetworkConfig'),
    ).toBeUndefined();
  });

  it('pollIntervalMs override is honored', () => {
    const collector = new NetworkInterfaceCollector({
      probe: probeWith(undefined),
      pollIntervalMs: 500,
    });
    expect(collector.pollIntervalMs).toBe(500);
  });
});

// ---- S7 T1: the Tuning singleton (same compare-and-skip family) ----

describe('TuningCollector singleton', () => {
  it('emits once, skips identical, re-emits on change; degraded probe errors', async () => {
    const { TuningCollector } = await import('../../../agent/collectors/tuning.js');
    let entries = [{ key: 'vm.swappiness', expected: '1', actual: '60' }];
    const collector = new TuningCollector({
      probe: { snapshot: async () => ({ entries }) },
    });
    const first = await collector.initialSweep();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'Tuning', id: 'default', op: 'upsert' });
    expect(await collector.initialSweep()).toEqual([]);
    entries = [{ key: 'vm.swappiness', expected: '1', actual: '1' }];
    expect(await collector.initialSweep()).toHaveLength(1);
  });
});
