import { describe, expect, it, vi } from 'vitest';
import type { ObservationDelta } from '../../../agent/collectors/base.js';
import { NfsIdmapCollector } from '../../../agent/collectors/nfs-idmap.js';

function makeFakeIdmapProbe(
  options: {
    result?: {
      conf_present: boolean;
      domain?: string;
      local_realms?: string[];
      method?: string;
      idmapd_active: boolean;
      idmapd_unit_state?: string;
    };
  } = {},
) {
  let _watchCallback: (() => void) | null = null;
  let _dbusCallback: (() => void) | null = null;

  const defaultResult = {
    conf_present: true,
    domain: 'localdomain',
    local_realms: [],
    method: 'nsswitch',
    idmapd_active: true,
    idmapd_unit_state: 'active',
  };

  return {
    read: vi.fn().mockResolvedValue(options.result ?? defaultResult),
    watchIdmapdConf: vi.fn().mockImplementation((cb: () => void) => {
      _watchCallback = cb;
      return { stop: vi.fn() };
    }),
    subscribeIdmapdUnit: vi.fn().mockImplementation((cb: () => void) => {
      _dbusCallback = cb;
      return { stop: vi.fn() };
    }),
    _fireConfChange() {
      _watchCallback?.();
    },
    _fireDbusEvent() {
      _dbusCallback?.();
    },
  };
}

describe('NfsIdmapCollector', () => {
  it('initialSweep: returns singleton upsert at id "snapshot"', async () => {
    const probe = makeFakeIdmapProbe();
    const col = new NfsIdmapCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'NfsIdmap', id: 'snapshot', op: 'upsert' });
    const status = deltas[0]?.value?.status as Record<string, unknown>;
    expect(status?.conf_present).toBe(true);
    expect(status?.domain).toBe('localdomain');
    expect(status?.idmapd_active).toBe(true);
    expect(typeof status?.observed_at).toBe('string');
  });

  it('start: /etc/idmapd.conf change → re-read → emit upsert at "snapshot"', async () => {
    const probe = makeFakeIdmapProbe();
    const col = new NfsIdmapCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireConfChange();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'NfsIdmap', id: 'snapshot', op: 'upsert' });
    await col.stop();
  });

  it('start: dbus nfs-idmapd.service PropertiesChanged → re-read → emit upsert', async () => {
    const probe = makeFakeIdmapProbe({
      result: { conf_present: true, idmapd_active: false, idmapd_unit_state: 'inactive' },
    });
    const col = new NfsIdmapCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireDbusEvent();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect((received[0]?.value?.status as Record<string, unknown>)?.idmapd_active).toBe(false);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeIdmapProbe();
    const col = new NfsIdmapCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 60000', () => {
    const probe = makeFakeIdmapProbe();
    expect(new NfsIdmapCollector({ probe }).pollIntervalMs).toBe(60_000);
  });
});
