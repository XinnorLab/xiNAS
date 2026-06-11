import { describe, expect, it } from 'vitest';

// ---- S5 T6: nfs fixture passthrough (the e2e blocker seeds) ----

describe('createFixtureNfsProbe(dir)', () => {
  it('reads nfs-sessions.json + nfs-exports.json; defaults empty', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'xinas-fixture-nfs-'));
    try {
      const { createFixtureNfsProbe } = await import('../../../agent/probe/fixture.js');
      const empty = createFixtureNfsProbe(dir);
      expect(await empty.listSessions()).toEqual([]);
      expect(await empty.listExports()).toEqual([]);

      writeFileSync(
        join(dir, 'nfs-sessions.json'),
        JSON.stringify([
          {
            kind: 'NfsSession',
            id: '10.0.0.1:/mnt/data/share',
            spec: { client_addr: '10.0.0.1', export_path: '/mnt/data/share' },
            status: { proto_version: 'v4.2', locked_files: 0 },
          },
        ]),
      );
      writeFileSync(
        join(dir, 'nfs-exports.json'),
        JSON.stringify([{ export_path: '/mnt/data/share', host_pattern: '*', options: ['rw'] }]),
      );
      const seeded = createFixtureNfsProbe(dir);
      expect((await seeded.listSessions())[0]?.spec.export_path).toBe('/mnt/data/share');
      expect((await seeded.listExports())[0]?.export_path).toBe('/mnt/data/share');
      // no-dir form stays empty (non-fixture callers unaffected)
      const bare = createFixtureNfsProbe();
      expect(await bare.listSessions()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- S6 T5: fixture network probe over the fake NetHost state ----

describe('createFixtureNetworkProbe(dir) over net-host-state.json', () => {
  it('builds enriched rows + the summary from the fake host state', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'xinas-fixture-net-'));
    try {
      writeFileSync(
        join(dir, 'net-host-state.json'),
        JSON.stringify({
          netplan_files: {
            '/etc/netplan/99-xinas.yaml':
              'network:\n  version: 2\n  ethernets:\n    ibp65s0:\n      addresses: [10.10.1.1/24]\n      routing-policy:\n        - {from: 10.10.1.1, table: 100, priority: 100}\n',
          },
          kernel: { addrs: { ibp65s0: ['10.10.1.1/24'] }, rules: [], tables: {} },
          sys_class_net: [{ name: 'ibp65s0', driver: 'mlx5_core' }],
          rdma_links: [
            { ifname: 'mlx5_0', netdev: 'ibp65s0', state: 'ACTIVE', physical_state: 'LINK_UP' },
          ],
          ops: [],
        }),
      );
      const { createFixtureNetworkProbe } = await import('../../../agent/probe/fixture.js');
      const probe = createFixtureNetworkProbe(dir);
      const rows = await probe.snapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe('ibp65s0');
      expect(rows[0]?.status.rdma_capable).toBe(true);
      expect(rows[0]?.status.netplan?.pbr_table_id).toBe(100);
      const summary = await probe.netplanSummary();
      expect(summary?.world_config_hash).toMatch(/^[0-9a-f]{64}$/);

      // no dir → empty (non-fixture callers unaffected)
      const bare = createFixtureNetworkProbe();
      expect(await bare.snapshot()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
