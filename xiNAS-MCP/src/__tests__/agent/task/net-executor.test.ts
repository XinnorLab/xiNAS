import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeNetHost } from '../../../agent/net/fake-host.js';
import {
  makeNetIfaceUpdateExecutor,
  makeNetPoolApplyExecutor,
} from '../../../agent/task/net-executor.js';
import type { ExecutorContext } from '../../../agent/task/types.js';
import { renderNetplan } from '../../../lib/net/render.js';
import { XINAS_NETPLAN, netplanHashes } from '../../../lib/parse/netplan.js';

function makeCtx(spec: unknown): ExecutorContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    spec,
    lines,
    stash: {},
    emitOutput(line: string): void {
      lines.push(line);
    },
    isCancelRequested: () => false,
  };
}

const PRIOR_XINAS = renderNetplan([
  { name: 'ibp65s0', addresses: ['10.10.1.1/24'], mtu: 4092, enabled: true, pbr_table_id: 100 },
  { name: 'ibp9s0f0', addresses: ['10.10.2.1/24'], enabled: true, pbr_table_id: 101 },
]);
const CLOUD_INIT =
  'network:\n  version: 2\n  ethernets:\n    eno1:\n      dhcp4: true\n    ibp65s0:\n      addresses: [192.168.99.5/24]\n';

const NEW_RENDER = renderNetplan([
  { name: 'ibp65s0', addresses: ['10.10.5.1/24'], mtu: 4092, enabled: true, pbr_table_id: 100 },
  { name: 'ibp9s0f0', addresses: ['10.10.2.1/24'], enabled: true, pbr_table_id: 101 },
]);

describe('net.iface.update executor', () => {
  let dir: string;
  let host: ReturnType<typeof createFakeNetHost>;
  let worldHash: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-net-exec-'));
    writeFileSync(
      join(dir, 'net-host-state.json'),
      JSON.stringify({
        netplan_files: {
          [XINAS_NETPLAN]: PRIOR_XINAS,
          '/etc/netplan/50-cloud-init.yaml': CLOUD_INIT,
        },
        kernel: { addrs: {}, rules: [], tables: {} },
        sys_class_net: [
          { name: 'ibp65s0', driver: 'mlx5_core' },
          { name: 'ibp9s0f0', driver: 'mlx5_core' },
          { name: 'eno1', driver: 'igb' },
        ],
        rdma_links: [],
        ops: [],
      }),
    );
    host = createFakeNetHost(dir);
    await host.netplanApply(); // bring kernel state in line with the prior files
    worldHash = netplanHashes(await host.readNetplanDir()).world_config_hash;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function spec(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'ibp65s0',
      render: NEW_RENDER,
      world_config_hash: worldHash,
      cleanup: true,
      cleanup_files: { ibp65s0: ['/etc/netplan/50-cloud-init.yaml'] },
      surgical: { dev: 'ibp65s0', pbr_table_id: 100 },
      desired: { addresses: ['10.10.5.1/24'], enabled: true },
      ...over,
    };
  }

  async function runAll(
    executor: ReturnType<typeof makeNetIfaceUpdateExecutor>,
    ctx: ExecutorContext,
  ) {
    for (const stage of executor.stages) await stage.run(ctx);
  }

  it('happy path: write+cleanup+generate, SURGICAL flush, apply, verify', async () => {
    const executor = makeNetIfaceUpdateExecutor({ host });
    const ctx = makeCtx(spec());
    await runAll(executor, ctx);

    // file rewritten + foreign cleanup (eno1 kept, ibp65s0 removed)
    const files = host.files();
    expect(files[XINAS_NETPLAN]).toBe(NEW_RENDER);
    expect(files['/etc/netplan/50-cloud-init.yaml']).toContain('eno1');
    expect(files['/etc/netplan/50-cloud-init.yaml']).not.toContain('ibp65s0');
    expect(ctx.lines.some((l) => l.includes('removed stanza ibp65s0'))).toBe(true);

    // generate ordered BEFORE any flush
    const ops = host.ops();
    expect(ops.indexOf('netplan-generate')).toBeLessThan(ops.indexOf('ip-addr-flush:ibp65s0'));

    // surgical only: ibp9s0f0 untouched by the flush
    expect(ops.filter((o) => o === 'ip-addr-flush:ibp9s0f0')).toEqual([]);
    expect(ops).toContain('ip-route-flush-table:100');
    expect(ops.filter((o) => o === 'ip-route-flush-table:101')).toEqual([]);

    // kernel end state: new address live, old gone, other iface intact
    expect(host.kernel().addrs.ibp65s0).toEqual(['10.10.5.1/24']);
    expect(host.kernel().addrs.ibp9s0f0).toContain('10.10.2.1/24');
  });

  it('preflight live hash gate: out-of-band netplan edit aborts before any write', async () => {
    await host.writeNetplanFile('/etc/netplan/77-rogue.yaml', 'network: {version: 2}\n');
    const opsBefore = host.ops().length;
    const executor = makeNetIfaceUpdateExecutor({ host });
    await expect(executor.stages[0]?.run(makeCtx(spec()))).rejects.toThrow(/changed since plan/);
    // no writes beyond the rogue file itself
    expect(
      host
        .ops()
        .slice(opsBefore)
        .filter((o) => o.startsWith('writeNetplanFile')),
    ).toEqual([]);
  });

  it('preflight duplicate re-scan (no cleanup) aborts', async () => {
    const executor = makeNetIfaceUpdateExecutor({ host });
    await expect(
      executor.stages[0]?.run(makeCtx(spec({ cleanup: false, cleanup_files: {} }))),
    ).rejects.toThrow(/also defined in/);
  });

  it('generate failure aborts pre-flush; rollback restores files byte-identical', async () => {
    // make the MERGED config invalid post-write by planting a marker the
    // fake's generate rejects — in a foreign file the cleanup does not touch
    await host.writeNetplanFile('/etc/netplan/60-extra.yaml', '# fine for now\n');
    const hash = netplanHashes(await host.readNetplanDir()).world_config_hash;
    const executor = makeNetIfaceUpdateExecutor({ host });
    const ctx = makeCtx(
      spec({ world_config_hash: hash, render: `${NEW_RENDER}# INVALID-NETPLAN\n` }),
    );

    await executor.stages[0]?.run(ctx); // preflight stashes
    await expect(executor.stages[1]?.run(ctx)).rejects.toThrow(/INVALID-NETPLAN/);
    // no kernel flush happened
    expect(host.ops().filter((o) => o.startsWith('ip-addr-flush'))).toEqual([]);

    await executor.rollback(ctx);
    const files = host.files();
    expect(files[XINAS_NETPLAN]).toBe(PRIOR_XINAS);
    expect(files['/etc/netplan/50-cloud-init.yaml']).toBe(CLOUD_INIT);
  });

  it('apply failure → rollback restores files and re-applies the prior state', async () => {
    // APPLY-FAIL marker in a foreign file the cleanup does not touch
    await host.writeNetplanFile('/etc/netplan/60-extra.yaml', '# APPLY-FAIL\n');
    const hash = netplanHashes(await host.readNetplanDir()).world_config_hash;
    const executor = makeNetIfaceUpdateExecutor({ host });
    const ctx = makeCtx(spec({ world_config_hash: hash }));

    await executor.stages[0]?.run(ctx);
    await executor.stages[1]?.run(ctx);
    await executor.stages[2]?.run(ctx);
    await expect(executor.stages[3]?.run(ctx)).rejects.toThrow(/forced failure/);

    // rollback restores EVERYTHING stashed (incl. the APPLY-FAIL file) —
    // its own re-apply then fails the same way, which must NOT mask the
    // file restore; tolerate the rethrow.
    await executor.rollback(ctx).catch(() => {});
    expect(host.files()[XINAS_NETPLAN]).toBe(PRIOR_XINAS);
  });
});

describe('net.pool.apply executor', () => {
  let dir: string;
  let host: ReturnType<typeof createFakeNetHost>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-net-pool-'));
    writeFileSync(
      join(dir, 'net-host-state.json'),
      JSON.stringify({
        netplan_files: { [XINAS_NETPLAN]: PRIOR_XINAS },
        kernel: { addrs: {}, rules: [], tables: {} },
        sys_class_net: [
          { name: 'ibp65s0', driver: 'mlx5_core' },
          { name: 'ibp9s0f0', driver: 'mlx5_core' },
          { name: 'eno1', driver: 'igb' },
        ],
        rdma_links: [],
        ops: [],
      }),
    );
    host = createFakeNetHost(dir);
    await host.netplanApply();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('GLOBAL flush (all PBR tables + every mlx dev, ethernet untouched) then apply + verify', async () => {
    const render = renderNetplan([
      { name: 'ibp65s0', addresses: ['10.20.1.1/24'], enabled: true, pbr_table_id: 100 },
      { name: 'ibp9s0f0', addresses: ['10.20.2.1/24'], enabled: true, pbr_table_id: 101 },
    ]);
    const executor = makeNetPoolApplyExecutor({ host });
    const ctx = makeCtx({
      render,
      world_config_hash: netplanHashes(await host.readNetplanDir()).world_config_hash,
      cleanup_files: {},
      targets: [
        { dev: 'ibp65s0', addresses: ['10.20.1.1/24'], pbr_table_id: 100 },
        { dev: 'ibp9s0f0', addresses: ['10.20.2.1/24'], pbr_table_id: 101 },
      ],
    });
    for (const stage of executor.stages) await stage.run(ctx);

    const ops = host.ops();
    expect(ops).toContain('ip-addr-flush:ibp65s0');
    expect(ops).toContain('ip-addr-flush:ibp9s0f0');
    expect(ops.filter((o) => o === 'ip-addr-flush:eno1')).toEqual([]);
    expect(ops).toContain('ip-route-flush-table:100');
    expect(ops).toContain('ip-route-flush-table:101');
    expect(host.kernel().addrs.ibp65s0).toEqual(['10.20.1.1/24']);
    expect(host.kernel().addrs.ibp9s0f0).toEqual(['10.20.2.1/24']);
  });
});
