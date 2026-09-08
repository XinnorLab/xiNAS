import { describe, expect, it } from 'vitest';
import {
  classifyWarnings,
  inventoryBanner,
  isPooled,
  pooledDevicePaths,
} from '../../mcp-apps/inventory-facts.js';

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

describe('inventory warnings (S18 §5, §10)', () => {
  it('treats DEGRADED_* warnings as blocking and everything else as advisory', () => {
    const { blocking, advisory } = classifyWarnings([
      { code: 'DEGRADED_BACKEND_UNAVAILABLE', message: 'xiRAID daemon down' },
      { code: 'EXECUTOR_DEGRADED', message: 'slow' },
      { message: 'no code' },
    ]);
    expect(blocking).toEqual([
      { code: 'DEGRADED_BACKEND_UNAVAILABLE', message: 'xiRAID daemon down' },
    ]);
    expect(advisory).toHaveLength(2);
    expect(classifyWarnings(undefined)).toEqual({ blocking: [], advisory: [] });
  });

  it('describes why the inventory is not current', () => {
    expect(inventoryBanner('failed', 'pools.list failed')).toBe(
      'Inventory is not current: pools.list failed. Showing the last known inventory; Review plan is disabled until a refresh succeeds.',
    );
    expect(inventoryBanner('degraded', 'DEGRADED_BACKEND_UNAVAILABLE — xiRAID daemon down')).toBe(
      'Inventory is not current: DEGRADED_BACKEND_UNAVAILABLE — xiRAID daemon down. Showing the last known inventory; Review plan is disabled until a refresh succeeds.',
    );
    expect(inventoryBanner('trusted', '')).toBe('');
    expect(inventoryBanner('none', '')).toBe('');
  });
});
