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
});
