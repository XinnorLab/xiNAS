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
    startEventStream: vi
      .fn()
      .mockImplementation(
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
