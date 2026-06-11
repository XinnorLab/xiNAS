import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../../agent/fs/host.js';
import { createFakeNetHost } from '../../../agent/net/fake-host.js';
import { createRealNetHost } from '../../../agent/net/host.js';
import { XINAS_NETPLAN } from '../../../lib/parse/netplan.js';

function recorder(results: Record<string, RunResult> = {}) {
  const calls: string[] = [];
  const run = async (program: string, args: string[]): Promise<RunResult> => {
    calls.push(`${program} ${args.join(' ')}`);
    return results[program] ?? { stdout: '', code: 0 };
  };
  return { calls, run };
}

describe('createRealNetHost command goldens', () => {
  it('exact argv for the netplan + ip verb set', async () => {
    const { calls, run } = recorder({ ip: { stdout: '[]', code: 0 } });
    const host = createRealNetHost({ runCommand: run });
    await host.netplanGenerate();
    await host.netplanApply();
    await host.ipRuleShow();
    await host.ipRuleDel('from 10.10.1.1 lookup 100');
    await host.ipRouteFlushTable(100);
    await host.ipAddrFlush('ibp65s0');
    await host.ipAddrShow();
    expect(calls).toEqual([
      'netplan generate',
      'netplan apply',
      'ip rule show',
      'ip rule del from 10.10.1.1 lookup 100',
      'ip route flush table 100',
      'ip addr flush dev ibp65s0',
      'ip -j addr show',
    ]);
  });

  it('rdmaLinkShow degrades to "" when the tool is missing (exit 127)', async () => {
    const host = createRealNetHost({ runCommand: async () => ({ stdout: 'boom', code: 127 }) });
    expect(await host.rdmaLinkShow()).toBe('');
  });

  it('netplan generate failure throws with output', async () => {
    const host = createRealNetHost({
      runCommand: async () => ({ stdout: 'Invalid YAML', code: 1 }),
    });
    await expect(host.netplanGenerate()).rejects.toThrow(/Invalid YAML/);
  });

  it('writeNetplanFile is atomic into the injected dir; readNetplanDir lists yaml only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-netplan-'));
    try {
      const host = createRealNetHost({ runCommand: recorder().run, netplanDir: dir });
      await host.writeNetplanFile(join(dir, '99-xinas.yaml'), 'network: {version: 2}\n');
      expect(readFileSync(join(dir, '99-xinas.yaml'), 'utf8')).toContain('version: 2');
      const files = await host.readNetplanDir();
      expect(Object.keys(files)).toEqual([join(dir, '99-xinas.yaml')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createFakeNetHost', () => {
  let dir: string;
  let host: ReturnType<typeof createFakeNetHost>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-fake-net-'));
    host = createFakeNetHost(dir);
    await host.writeNetplanFile(
      XINAS_NETPLAN,
      [
        'network:',
        '  version: 2',
        '  ethernets:',
        '    ibp65s0:',
        '      addresses: [10.10.1.1/24]',
        '      routing-policy:',
        '        - from: 10.10.1.1',
        '          table: 100',
        '          priority: 100',
      ].join('\n'),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('netplanApply programs kernel state ADD-ONLY; flush verbs remove', async () => {
    await host.netplanApply();
    expect(host.kernel().addrs.ibp65s0).toEqual(['10.10.1.1/24']);
    expect(host.kernel().rules).toEqual([{ from: '10.10.1.1', table: 100, priority: 100 }]);

    // change the file to a new IP; apply ADDS, never removes
    await host.writeNetplanFile(
      XINAS_NETPLAN,
      'network:\n  version: 2\n  ethernets:\n    ibp65s0:\n      addresses: [10.10.5.1/24]\n',
    );
    await host.netplanApply();
    expect(host.kernel().addrs.ibp65s0).toEqual(['10.10.1.1/24', '10.10.5.1/24']);

    await host.ipAddrFlush('ibp65s0');
    expect(host.kernel().addrs.ibp65s0).toEqual([]);
    await host.ipRuleDel('from 10.10.1.1 lookup 100');
    expect(host.kernel().rules).toEqual([]);
    await host.ipRouteFlushTable(100);
    expect(host.kernel().tables['100']).toBeUndefined();
  });

  it('ipRuleShow renders the flushable format; ipAddrShow is ip -j shaped', async () => {
    await host.netplanApply();
    expect(await host.ipRuleShow()).toContain('from 10.10.1.1 lookup 100');
    const state = JSON.parse(
      readFileSync(join(dir, 'net-host-state.json'), 'utf8'),
    ) as Record<string, unknown>;
    (state.sys_class_net as unknown[]) = [{ name: 'ibp65s0', driver: 'mlx5_core' }];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'net-host-state.json'), JSON.stringify(state));
    const parsed = JSON.parse(await host.ipAddrShow()) as Array<{
      ifname: string;
      addr_info: Array<{ local: string }>;
    }>;
    expect(parsed[0]?.ifname).toBe('ibp65s0');
    expect(parsed[0]?.addr_info[0]?.local).toBe('10.10.1.1');
  });

  it('deterministic hooks: INVALID-NETPLAN rejects generate; APPLY-FAIL rejects apply; -fail dev rejects flush', async () => {
    await host.writeNetplanFile('/etc/netplan/50-bad.yaml', '# INVALID-NETPLAN\n');
    await expect(host.netplanGenerate()).rejects.toThrow(/INVALID-NETPLAN/);
    await host.writeNetplanFile('/etc/netplan/50-bad.yaml', '# APPLY-FAIL\n');
    await host.netplanGenerate(); // generate ok now
    await expect(host.netplanApply()).rejects.toThrow(/forced failure/);
    await expect(host.ipAddrFlush('ibpX-fail')).rejects.toThrow(/forced addr-flush/);
  });
});
