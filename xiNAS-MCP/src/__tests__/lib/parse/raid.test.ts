import { describe, expect, it } from 'vitest';
import { parseRaidShow } from '../../../lib/parse/raid.js';

const DISK_IDS = new Map([
  ['/dev/nvme1n1', 'disk-1'],
  ['/dev/nvme2n1', 'disk-2'],
  ['/dev/nvme3n1', 'disk-3'],
  ['/dev/nvme4n1', 'disk-4'],
]);

describe('parseRaidShow', () => {
  it('maps an online array (fake-transport / xicli shape)', () => {
    const arrays = parseRaidShow(
      [
        {
          name: 'data',
          level: '6',
          devices: ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'],
          state: ['online'],
          strip_size: 64,
          block_size: 4096,
          size: 15360000000000,
        },
      ],
      DISK_IDS,
    );
    expect(arrays).toHaveLength(1);
    expect(arrays[0]).toMatchObject({
      kind: 'XiraidArray',
      id: 'data',
      spec: {
        name: 'data',
        level: 'raid6',
        member_disk_ids: ['disk-1', 'disk-2', 'disk-3', 'disk-4'],
        strip_size_kib: 64,
        block_size: 4096,
      },
      status: {
        state: 'optimal',
        volume_path: '/dev/xi_data',
        usable_capacity_bytes: 15360000000000,
      },
    });
  });

  it('unknown device paths fall back to the raw path as the disk id', () => {
    const [a] = parseRaidShow(
      [{ name: 'x', level: '0', devices: ['/dev/unknown1'], state: ['online'] }],
      DISK_IDS,
    );
    expect(a?.spec.member_disk_ids).toEqual(['/dev/unknown1']);
  });

  it('state precedence: failed > rebuilding > degraded > optimal > unknown', () => {
    const states = (state: unknown, extra: Record<string, unknown> = {}) =>
      parseRaidShow([{ name: 'a', level: '5', devices: [], state, ...extra }], DISK_IDS)[0]?.status;

    expect(states(['offline'])?.state).toBe('failed');
    expect(states(['degraded', 'reconstructing'])?.state).toBe('rebuilding');
    expect(states(['online', 'initializing'])?.state).toBe('rebuilding');
    expect(states(['degraded'])?.state).toBe('degraded');
    expect(states(['online', 'initialized'])?.state).toBe('optimal');
    expect(states(['weird-thing'])?.state).toBe('unknown');
    expect(states('online')?.state).toBe('optimal'); // bare-string tolerance
  });

  it('progress fields surface as rebuild_progress_pct', () => {
    const [a] = parseRaidShow(
      [
        {
          name: 'a',
          level: '5',
          devices: [],
          state: ['degraded', 'reconstructing'],
          recon_progress: 42,
        },
      ],
      DISK_IDS,
    );
    expect(a?.status.rebuild_progress_pct).toBe(42);
  });

  it('levels normalize (numeric, N+M); junk entries are skipped', () => {
    const arrays = parseRaidShow(
      [
        { name: 'n1', level: 6, devices: [], state: ['online'] },
        { name: 'n2', level: 'N+M', devices: [], state: ['online'] },
        { notAnArray: true },
        'junk',
      ],
      DISK_IDS,
    );
    expect(arrays.map((a) => a.spec.level)).toEqual(['raid6', 'n+m']);
  });

  it('non-array payload → empty result', () => {
    expect(parseRaidShow(null, DISK_IDS)).toEqual([]);
    expect(parseRaidShow({ message: 'no raids' }, DISK_IDS)).toEqual([]);
  });

  // ---- S4 T5: sparepool membership observed via pool_show ----

  it('maps the array sparepool through the pools payload to spare disk ids', () => {
    const [a] = parseRaidShow(
      [
        {
          name: 'data',
          level: '6',
          devices: ['/dev/nvme1n1', '/dev/nvme2n1'],
          state: ['online'],
          sparepool: 'xnsp_data',
        },
      ],
      DISK_IDS,
      [{ name: 'xnsp_data', drives: ['/dev/nvme3n1', '/dev/unknown9'] }],
    );
    expect(a?.spec.spare_disk_ids).toEqual(['disk-3', '/dev/unknown9']); // raw-path fallback
  });

  it('no sparepool, unknown pool, or absent pools payload → spare_disk_ids []', () => {
    const noPool = parseRaidShow(
      [{ name: 'a', level: '0', devices: [], state: ['online'] }],
      DISK_IDS,
      [{ name: 'x', drives: ['/dev/y'] }],
    );
    expect(noPool[0]?.spec.spare_disk_ids).toEqual([]);
    const ghostPool = parseRaidShow(
      [{ name: 'a', level: '0', devices: [], state: ['online'], sparepool: 'ghost' }],
      DISK_IDS,
      [],
    );
    expect(ghostPool[0]?.spec.spare_disk_ids).toEqual([]);
    const noPayload = parseRaidShow(
      [{ name: 'a', level: '0', devices: [], state: ['online'], sparepool: 'p' }],
      DISK_IDS,
    );
    expect(noPayload[0]?.spec.spare_disk_ids).toEqual([]);
  });
});
