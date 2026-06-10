import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeFsHost } from '../../../agent/fs/fake-host.js';
import { type RunResult, createRealFsHost } from '../../../agent/fs/host.js';

/** Recording runCommand returning canned results by program name. */
function recorder(results: Record<string, RunResult> = {}) {
  const calls: string[] = [];
  const run = async (program: string, args: string[]): Promise<RunResult> => {
    calls.push(`${program} ${args.join(' ')}`);
    return results[program] ?? { stdout: '', code: 0 };
  };
  return { calls, run };
}

describe('createRealFsHost command goldens', () => {
  it('mkfs.xfs argv passes through verbatim (the day-1 shape)', async () => {
    const { calls, run } = recorder();
    const host = createRealFsHost({ runCommand: run });
    await host.mkfsXfs([
      '-f',
      '-L',
      'data',
      '-d',
      'su=128k,sw=3',
      '-l',
      'logdev=/dev/xi_log,size=1073741824',
      '-s',
      'size=4096',
      '/dev/xi_data',
    ]);
    expect(calls).toEqual([
      'mkfs.xfs -f -L data -d su=128k,sw=3 -l logdev=/dev/xi_log,size=1073741824 -s size=4096 /dev/xi_data',
    ]);
  });

  it('blkid parses -o export output; exit 2 → null; other exits throw', async () => {
    const { run } = recorder({
      blkid: { stdout: 'DEVNAME=/dev/xi_data\nUUID=abc-123\nLABEL=data\nTYPE=xfs\n', code: 0 },
    });
    const host = createRealFsHost({ runCommand: run });
    expect(await host.blkid('/dev/xi_data')).toEqual({
      uuid: 'abc-123',
      label: 'data',
      fstype: 'xfs',
    });

    const empty = createRealFsHost({
      runCommand: async () => ({ stdout: '', code: 2 }),
    });
    expect(await empty.blkid('/dev/clean')).toBeNull();

    const broken = createRealFsHost({ runCommand: async () => ({ stdout: 'boom', code: 1 }) });
    await expect(broken.blkid('/dev/x')).rejects.toThrow(/exited 1/);
  });

  it('blockdevSize parses --getsize64; systemctl verbs use exact argv', async () => {
    const { calls, run } = recorder({
      blockdev: { stdout: '536870912\n', code: 0 },
    });
    const host = createRealFsHost({ runCommand: run });
    expect(await host.blockdevSize('/dev/xi_log')).toBe(536870912);
    await host.daemonReload();
    await host.enableNow('mnt-data.mount');
    await host.stop('mnt-data.mount');
    await host.disable('mnt-data.mount');
    await host.growfs('/mnt/data');
    expect(calls).toEqual([
      'blockdev --getsize64 /dev/xi_log',
      'systemctl daemon-reload',
      'systemctl enable --now mnt-data.mount',
      'systemctl stop mnt-data.mount',
      'systemctl disable mnt-data.mount',
      'xfs_growfs /mnt/data',
    ]);
  });

  it('unit file IO round-trips against an injected dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-units-'));
    try {
      const host = createRealFsHost({ runCommand: recorder().run, unitDir: dir });
      expect(await host.readUnit('x.mount')).toBeNull();
      await host.writeUnit('x.mount', '[Mount]\nWhat=/dev/a\nWhere=/x\n');
      expect(await host.readUnit('x.mount')).toContain('Where=/x');
      await host.removeUnit('x.mount');
      expect(await host.readUnit('x.mount')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createFakeFsHost', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-fake-fs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mkfs records argv + sets blkid; blockdevSize seeded or 1TiB default', async () => {
    const host = createFakeFsHost(dir);
    expect(await host.blkid('/dev/xi_data')).toBeNull();
    host.seedDeviceSize('/dev/xi_log', 536870912);
    expect(await host.blockdevSize('/dev/xi_log')).toBe(536870912);
    expect(await host.blockdevSize('/dev/xi_data')).toBe(1024 ** 4);

    await host.mkfsXfs(['-f', '-L', 'data', '/dev/xi_data']);
    expect(await host.blkid('/dev/xi_data')).toEqual({
      fstype: 'xfs',
      label: 'data',
      uuid: 'uuid-xi_data',
    });
    expect(host.ops()).toContain('mkfs.xfs -f -L data /dev/xi_data');
  });

  it('unit + mount lifecycle: write → enableNow → readMounts/statfs → stop', async () => {
    const host = createFakeFsHost(dir);
    await expect(host.enableNow('mnt-data.mount')).rejects.toThrow(/no unit/);
    await host.writeUnit('mnt-data.mount', '[Mount]\nWhat=/dev/xi_data\nWhere=/mnt/data\n');
    await host.enableNow('mnt-data.mount');
    expect(await host.readMounts()).toEqual([
      { source: '/dev/xi_data', mountpoint: '/mnt/data' },
    ]);
    const before = await host.statfs('/mnt/data');
    await host.growfs('/mnt/data');
    const after = await host.statfs('/mnt/data');
    expect(after.size_bytes).toBe(before.size_bytes + 1024 ** 3);
    await host.stop('mnt-data.mount');
    expect(await host.readMounts()).toEqual([]);
    await expect(host.statfs('/mnt/data')).resolves.toBeDefined(); // statfs entry persists
  });

  it('deterministic hooks: -fail device/unit rejects; -busy unit rejects stop (EBUSY)', async () => {
    const host = createFakeFsHost(dir);
    await expect(host.mkfsXfs(['-f', '/dev/xi-fail'])).rejects.toThrow(/forced mkfs/);
    await host.writeUnit('mnt-x-fail.mount', '[Mount]\nWhat=/dev/a\nWhere=/mnt/x-fail\n');
    await expect(host.enableNow('mnt-x-fail.mount')).rejects.toThrow(/forced enableNow/);
    await host.writeUnit('mnt-b-busy.mount', '[Mount]\nWhat=/dev/b\nWhere=/mnt/b\n');
    await host.enableNow('mnt-b-busy.mount');
    await expect(host.stop('mnt-b-busy.mount')).rejects.toThrow(/EBUSY/);
  });
});
