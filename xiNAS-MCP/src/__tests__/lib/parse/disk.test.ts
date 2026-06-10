import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLsblkOutput } from '../../../lib/parse/disk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseLsblkOutput', () => {
  it('emits one Disk per top-level disk; ignores partitions', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/lsblk-clean-controller.json'), 'utf8');
    const disks = parseLsblkOutput(raw);
    expect(disks).toHaveLength(3);
    const nvme0 = disks.find((d) => d.id === 'nvme0n1');
    expect(nvme0).toBeDefined();
    expect(nvme0?.status.model).toBe('INTEL SSDPE2KX020T8');
    expect(nvme0?.status.serial).toBe('BTLJ123456789');
    expect(nvme0?.status.transport).toBe('nvme');
  });

  it('rejects malformed JSON with a clear error', () => {
    expect(() => parseLsblkOutput('not json')).toThrow(/JSON/);
  });

  it('handles missing optional fields gracefully', () => {
    const raw = JSON.stringify({ blockdevices: [{ name: 'sda', type: 'disk' }] });
    const disks = parseLsblkOutput(raw);
    expect(disks).toHaveLength(1);
    expect(disks[0]?.id).toBe('sda');
    expect(disks[0]?.status.model).toBeUndefined();
  });

  // ---- S3 T2 enrichment (ADR-0006 §Disk references) ----

  it('derives device_path, capacity_bytes, system_disk, mounted, safe_for_use', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/lsblk-enriched.json'), 'utf8');
    const disks = parseLsblkOutput(raw);

    const sys = disks.find((d) => d.id === 'nvme0n1');
    expect(sys?.status).toMatchObject({
      device_path: '/dev/nvme0n1',
      system_disk: true,
      mounted: true,
      safe_for_use: false,
    });
    expect(sys?.status.capacity_bytes).toBe(512110190592);

    const free = disks.find((d) => d.id === 'nvme1n1');
    expect(free?.status).toMatchObject({
      device_path: '/dev/nvme1n1',
      system_disk: false,
      mounted: false,
      safe_for_use: true,
    });

    const data = disks.find((d) => d.id === 'nvme2n1');
    expect(data?.status).toMatchObject({
      system_disk: false,
      mounted: true,
      safe_for_use: false,
    });
  });

  it('keeps a human size_text for numeric (--bytes) sizes', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/lsblk-enriched.json'), 'utf8');
    const disks = parseLsblkOutput(raw);
    expect(disks.find((d) => d.id === 'nvme1n1')?.status.size_text).toBe('1.7T');
  });

  it('string sizes (no --bytes) still flow into size_text without capacity_bytes', () => {
    const raw = JSON.stringify({ blockdevices: [{ name: 'sdb', type: 'disk', size: '256G' }] });
    const disk = parseLsblkOutput(raw)[0];
    expect(disk?.status.size_text).toBe('256G');
    expect(disk?.status.capacity_bytes).toBeUndefined();
    expect(disk?.status.safe_for_use).toBe(true);
  });
});
