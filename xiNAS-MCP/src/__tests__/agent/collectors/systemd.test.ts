import { describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../../agent/collectors/base.js';
import { SystemdUnitCollector } from '../../../agent/collectors/systemd.js';

function makeFakeSystemdProbe(
  options: {
    allowList?: string[];
    unitStates?: Record<
      string,
      { load_state: string; active_state: string; sub_state: string; unit_file_state?: string }
    >;
  } = {},
) {
  const allowList = options.allowList ?? ['nfs-server.service', 'nfs-idmapd.service'];
  const states = options.unitStates ?? {
    'nfs-server.service': {
      load_state: 'loaded',
      active_state: 'active',
      sub_state: 'running',
      unit_file_state: 'enabled',
    },
    'nfs-idmapd.service': {
      load_state: 'loaded',
      active_state: 'inactive',
      sub_state: 'dead',
      unit_file_state: 'enabled',
    },
  };

  let _onPropertiesChanged: ((unitName: string) => void) | null = null;

  return {
    allowList,
    getUnitState: vi.fn().mockImplementation(async (name: string) => {
      return (
        states[name] ?? { load_state: 'not-found', active_state: 'inactive', sub_state: 'dead' }
      );
    }),
    subscribeAllowListed: vi
      .fn()
      .mockImplementation((units: string[], onChanged: (unitName: string) => void) => {
        _onPropertiesChanged = onChanged;
        return { stop: vi.fn() };
      }),
    _firePropertiesChanged(unitName: string) {
      _onPropertiesChanged?.(unitName);
    },
  };
}

describe('SystemdUnitCollector', () => {
  it('initialSweep: returns one upsert per allow-listed unit', async () => {
    const probe = makeFakeSystemdProbe({
      allowList: ['nfs-server.service', 'nfs-idmapd.service'],
    });
    const col = new SystemdUnitCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ kind: 'SystemdUnit', op: 'upsert' });
    const nfsServer = deltas.find((d) => d.id === 'nfs-server.service');
    expect(nfsServer).toBeDefined();
    expect((nfsServer?.value?.status as Record<string, unknown>)?.active_state).toBe('active');
    expect(typeof (nfsServer?.value?.status as Record<string, unknown>)?.observed_at).toBe(
      'string',
    );
  });

  it('start: PropertiesChanged for allow-listed unit → emit upsert', async () => {
    const probe = makeFakeSystemdProbe();
    const col = new SystemdUnitCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._firePropertiesChanged('nfs-server.service');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({
      kind: 'SystemdUnit',
      id: 'nfs-server.service',
      op: 'upsert',
    });
    await col.stop();
  });

  it('start: PropertiesChanged for non-allow-listed unit → no emit', async () => {
    const probe = makeFakeSystemdProbe({
      allowList: ['nfs-server.service'],
    });
    const col = new SystemdUnitCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._firePropertiesChanged('unrelated.service');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeSystemdProbe();
    const col = new SystemdUnitCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 30000', () => {
    const probe = makeFakeSystemdProbe();
    expect(new SystemdUnitCollector({ probe }).pollIntervalMs).toBe(30_000);
  });
});
