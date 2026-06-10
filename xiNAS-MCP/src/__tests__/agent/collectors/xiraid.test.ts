import { describe, expect, it } from 'vitest';
import { XiraidArrayCollector } from '../../../agent/collectors/xiraid.js';
import { XiraidClient, type XiraidTransport } from '../../../agent/xiraid/client.js';

const NOW = '2026-06-10T12:00:00.000Z';

const DISKS = [
  { id: 'disk-1', status: { device_path: '/dev/nvme1n1' } },
  { id: 'disk-2', status: { device_path: '/dev/nvme2n1' } },
];

function transportShowing(arrays: unknown): XiraidTransport {
  return {
    raidShow: async () => arrays,
    raidCreate: async () => {},
    raidDestroy: async () => {},
  };
}

function collector(transport: XiraidTransport): XiraidArrayCollector {
  return new XiraidArrayCollector({
    client: new XiraidClient(transport),
    diskSnapshot: async () => DISKS,
    now: () => NOW,
  });
}

describe('XiraidArrayCollector', () => {
  it('sweep maps raid_show into XiraidArray upserts with disk ids + observed_at', async () => {
    const c = collector(
      transportShowing([
        { name: 'data', level: '6', devices: ['/dev/nvme1n1', '/dev/nvme2n1'], state: ['online'] },
      ]),
    );
    const deltas = await c.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      kind: 'XiraidArray',
      id: 'data',
      op: 'upsert',
      value: {
        spec: { name: 'data', level: 'raid6', member_disk_ids: ['disk-1', 'disk-2'] },
        status: { state: 'optimal', volume_path: '/dev/xi_data', observed_at: NOW },
      },
    });
    expect(c.health()).toEqual({ state: 'running' });
  });

  it('daemon down → health error XIRAID_DAEMON_UNAVAILABLE and the sweep rethrows', async () => {
    const down: XiraidTransport = {
      raidShow: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6066');
      },
      raidCreate: async () => {},
      raidDestroy: async () => {},
    };
    const c = collector(down);
    await expect(c.initialSweep()).rejects.toThrow(/ECONNREFUSED/);
    expect(c.health().state).toBe('error');
    expect(c.health().reason).toMatch(/^XIRAID_DAEMON_UNAVAILABLE/);
  });

  it('recovers: a later successful sweep flips health back to running', async () => {
    let fail = true;
    const flaky: XiraidTransport = {
      raidShow: async () => {
        if (fail) throw new Error('down');
        return [];
      },
      raidCreate: async () => {},
      raidDestroy: async () => {},
    };
    const c = collector(flaky);
    await expect(c.initialSweep()).rejects.toThrow();
    fail = false;
    expect(await c.initialSweep()).toEqual([]);
    expect(c.health()).toEqual({ state: 'running' });
  });
});
