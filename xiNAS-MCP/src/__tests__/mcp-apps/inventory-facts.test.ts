import { describe, expect, it } from 'vitest';
import { isPooled, pooledDevicePaths } from '../../mcp-apps/inventory-facts.js';

// S18 §5: pool `drives` are device paths (lib/parse/pool.ts); Disk ids are
// stable serial keys. Membership is decided in the path domain only (I-07).
describe('spare-pool membership (S18 §5)', () => {
  const pools = [{ name: 'spares', drives: ['/dev/nvme0n1'] }, { name: 'empty' }];

  it('excludes a disk whose device path is a pool drive even though its id differs', () => {
    const pooled = pooledDevicePaths(pools);
    expect(isPooled({ status: { device_path: '/dev/nvme0n1' } }, pooled)).toBe(true);
  });

  it('never matches a disk by id, and never blocks a disk with another path or no path', () => {
    const pooled = pooledDevicePaths([{ drives: ['serial-disk-1'] }]);
    expect(isPooled({ status: { device_path: '/dev/nvme1n1' } }, pooled)).toBe(false);
    expect(isPooled({ status: { device_path: '/dev/nvme2n1' } }, pooledDevicePaths(pools))).toBe(
      false,
    );
    expect(isPooled({}, pooledDevicePaths(pools))).toBe(false);
  });
});
