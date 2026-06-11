import type { ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNetworkProbe, enrichNetworkRows, summarizeNetplan } from '../../../agent/probe/network.js';

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');

function makeExecFile(stdout: string) {
  return (
    _f: string,
    _a: string[],
    _o: ExecFileOptions,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, stdout, '');
  };
}

describe('NetworkProbe', () => {
  it('snapshot() returns parsed interfaces via injected execFile', async () => {
    // Fixture has 3 interfaces: lo, enp3s0, ibp0s4
    const fixture = readFileSync(join(fixtureDir, 'ip-addr-show.json'), 'utf8');
    const probe = createNetworkProbe({ execFile: makeExecFile(fixture) as any });
    const ifaces = await probe.snapshot();
    expect(ifaces.length).toBe(3);
    const enp3s0 = ifaces.find((i) => i.id === 'enp3s0');
    expect(enp3s0).toBeDefined();
    expect(enp3s0?.status.mac).toBe('d8:5e:d3:0a:1b:2c');
    expect(enp3s0?.status.operstate).toBe('UP');
  });

  it('startEventStream() emits delta on injected ip-monitor line', async () => {
    const fixture = readFileSync(join(fixtureDir, 'ip-addr-show.json'), 'utf8');
    const monitorLine = JSON.stringify([
      {
        ifindex: 3,
        ifname: 'ibp0s4',
        flags: ['BROADCAST', 'MULTICAST', 'UP'],
        mtu: 4092,
        operstate: 'UP',
        link_type: 'infiniband',
        address: '11:22:33:44:55:66',
        addr_info: [],
      },
    ]);
    const deltas: any[] = [];
    const probe = createNetworkProbe({
      execFile: makeExecFile(fixture) as any,
      spawnMonitor: (opts) => {
        opts.onLine(monitorLine);
        return { stop: async () => {} };
      },
    });
    probe.startEventStream((d) => deltas.push(d));
    await new Promise((r) => setTimeout(r, 50));
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0]?.id).toBe('ibp0s4');
  });

  it('snapshot() throws on ip exec failure', async () => {
    const probe = createNetworkProbe({
      execFile: (_f: any, _a: any, _o: any, cb: any) => {
        cb(new Error('ip: command not found'), '', '');
      },
    });
    await expect(probe.snapshot()).rejects.toThrow(/ip/);
  });
});

// ---- S6 T5: enrichment + the NetworkConfig summary ----

describe('network probe enrichment (S6)', () => {
  const BASE = [
    {
      kind: 'NetworkInterface' as const,
      id: 'ibp65s0',
      status: {
        name: 'ibp65s0',
        operstate: 'UP',
        ip4_addresses: ['10.10.1.1/24'],
        ip6_addresses: [],
      },
    },
    {
      kind: 'NetworkInterface' as const,
      id: 'eno1',
      status: { name: 'eno1', operstate: 'UP', ip4_addresses: ['192.168.1.5/24'], ip6_addresses: [] },
    },
  ];
  const SYS = [
    { name: 'ibp65s0', driver: 'mlx5_core' },
    { name: 'eno1', driver: 'igb' },
  ];
  const FILES = {
    '/etc/netplan/99-xinas.yaml': [
      'network:',
      '  version: 2',
      '  ethernets:',
      '    ibp65s0:',
      '      addresses: [10.10.1.1/24]',
      '      mtu: 4092',
      '      routing-policy:',
      '        - {from: 10.10.1.1, table: 100, priority: 100}',
    ].join('\n'),
    '/etc/netplan/50-cloud-init.yaml':
      'network:\n  version: 2\n  ethernets:\n    ibp65s0:\n      addresses: [192.168.99.5/24]\n',
  };
  const RDMA = JSON.stringify([
    { ifname: 'mlx5_0', netdev: 'ibp65s0', state: 'ACTIVE', physical_state: 'LINK_UP' },
  ]);

  it('overlays driver/rdma/netplan facts; mgmt ethernet stays unmanaged-shaped', () => {
    const rows = enrichNetworkRows(BASE, SYS, FILES, RDMA);
    const ib = rows.find((r) => r.id === 'ibp65s0');
    expect(ib?.status.driver).toBe('mlx5_core');
    expect(ib?.status.rdma_capable).toBe(true);
    expect(ib?.status.rdma_link_state).toBe('up');
    expect(ib?.status.current_addresses).toEqual(['10.10.1.1/24']);
    expect(ib?.status.owning_netplan_file).toBe('/etc/netplan/99-xinas.yaml');
    expect(ib?.status.netplan).toEqual({
      addresses: ['10.10.1.1/24'],
      mtu: 4092,
      pbr_table_id: 100,
    });
    expect(ib?.status.duplicates_detected_in).toEqual(['/etc/netplan/50-cloud-init.yaml']);

    const eth = rows.find((r) => r.id === 'eno1');
    expect(eth?.status.rdma_capable).toBe(false);
    expect(eth?.status.rdma_link_state).toBeUndefined(); // only rdma-capable ifaces carry it
    expect(eth?.status.netplan).toBeUndefined();
  });

  it('degrades independently: empty sysfs/rdma/netplan never drop rows', () => {
    const rows = enrichNetworkRows(BASE, [], {}, '');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status.driver).toBeUndefined();
    expect(rows[0]?.status.duplicates_detected_in).toEqual([]);
  });

  it('summarizeNetplan: per-file hashes + the two-hash split + duplicates', () => {
    const summary = summarizeNetplan(FILES);
    expect(Object.keys(summary.files).sort()).toEqual(Object.keys(FILES).sort());
    expect(summary.world_config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.xinas_file_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.duplicates).toEqual({ ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] });
  });
});
