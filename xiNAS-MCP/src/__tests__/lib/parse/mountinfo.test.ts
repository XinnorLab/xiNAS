import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMountinfo } from '../../../lib/parse/mountinfo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseMountinfo', () => {
  it('parses a typical /proc/self/mountinfo into structured mount entries', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/mountinfo.txt'), 'utf8');
    const mounts = parseMountinfo(raw);
    expect(mounts).toHaveLength(6);

    const root = mounts.find((m) => m.mountpoint === '/');
    expect(root).toBeDefined();
    expect(root?.mount_id).toBe(22);
    expect(root?.parent_id).toBe(1);
    expect(root?.fstype).toBe('ext4');
    expect(root?.source).toBe('/dev/sda1');
    expect(root?.options).toContain('rw');

    const share01 = mounts.find((m) => m.mountpoint === '/srv/share01');
    expect(share01).toBeDefined();
    expect(share01?.mount_id).toBe(100);
    expect(share01?.fstype).toBe('xfs');
    expect(share01?.source).toBe('/dev/md/xinas-data');
  });

  it('skips blank lines and lines with fewer than 10 fields', () => {
    const raw = '\n\n22 1 8:1 / / rw shared:1 - ext4 /dev/sda1 rw\n\ngarbage\n';
    const mounts = parseMountinfo(raw);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.mountpoint).toBe('/');
  });

  it('returns an empty array for empty input', () => {
    expect(parseMountinfo('')).toEqual([]);
    expect(parseMountinfo('\n\n')).toEqual([]);
  });

  it('decodes \\040 octal escape in mountpoint to a space', () => {
    // /proc/self/mountinfo encodes space as \040 in path fields
    const raw = '123 22 253:1 / /srv/share\\040with\\040spaces rw shared:2 - xfs /dev/md/data rw';
    const mounts = parseMountinfo(raw);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.mountpoint).toBe('/srv/share with spaces');
  });

  it('decodes \\040 octal escape in mount source path', () => {
    const raw = '124 22 253:2 / /mnt/data rw shared:3 - xfs /dev/disk/by-label/my\\040disk rw';
    const mounts = parseMountinfo(raw);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.source).toBe('/dev/disk/by-label/my disk');
  });
});
