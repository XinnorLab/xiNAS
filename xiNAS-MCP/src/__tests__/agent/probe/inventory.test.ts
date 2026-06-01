import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type InventorySnapshot, createInventoryProbe } from '../../../agent/probe/inventory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');
const cpuinfoFixture = readFileSync(join(fixtureDir, 'proc-cpuinfo.txt'), 'utf8');
const meminfoFixture = readFileSync(join(fixtureDir, 'proc-meminfo.txt'), 'utf8');

function fakeReadFile(files: Record<string, string>) {
  return async (path: string, _enc: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

function fakeOsModule() {
  return {
    hostname: () => 'xinas-demo-01',
    uptime: () => 86400,
    release: () => '5.15.0-97-generic',
    arch: () => 'x64',
    type: () => 'Linux',
  };
}

describe('InventoryProbe', () => {
  it('snapshot() returns combined inventory from injected /proc files + os module', async () => {
    const probe = createInventoryProbe({
      readFile: fakeReadFile({
        '/proc/cpuinfo': cpuinfoFixture,
        '/proc/meminfo': meminfoFixture,
      }) as any,
      os: fakeOsModule() as any,
    });
    const inv: InventorySnapshot = await probe.snapshot();
    expect(inv.hostname).toBe('xinas-demo-01');
    expect(inv.cpu.model).toContain('Xeon');
    expect(inv.cpu.threads).toBe(2); // 2 processor entries in the fixture
    expect(inv.memory.total_kb).toBe(131072000);
    expect(inv.os.kernel).toBe('5.15.0-97-generic');
  });

  it('snapshot() sets cpu.threads to 0 when /proc/cpuinfo is absent', async () => {
    const probe = createInventoryProbe({
      readFile: fakeReadFile({ '/proc/meminfo': meminfoFixture }) as any,
      os: fakeOsModule() as any,
    });
    const inv = await probe.snapshot();
    expect(inv.cpu.threads).toBe(0);
  });

  it('snapshot() includes uptime_seconds from os.uptime()', async () => {
    const probe = createInventoryProbe({
      readFile: fakeReadFile({
        '/proc/cpuinfo': cpuinfoFixture,
        '/proc/meminfo': meminfoFixture,
      }) as any,
      os: fakeOsModule() as any,
    });
    const inv = await probe.snapshot();
    expect(inv.os.uptime_seconds).toBe(86400);
  });
});
