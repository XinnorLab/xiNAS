import { describe, expect, it } from 'vitest';
import { deriveStripe } from '../../../lib/fs/derive.js';
import {
  FS_IDENTITY_FIELDS,
  type FsCreateFacts,
  parseFsCreateSpec,
  parsePatchIntent,
  validateFsCreate,
  validateFsGrow,
  validateFsMount,
  validateFsUnmanage,
  validateFsUnmount,
} from '../../../lib/fs/validate.js';

describe('deriveStripe', () => {
  const arr = (level: string, members: number, strip?: number, group_size?: number) => ({
    level,
    member_disk_ids: Array.from({ length: members }, (_v, i) => `d${i}`),
    ...(strip !== undefined ? { strip_size_kib: strip } : {}),
    ...(group_size !== undefined ? { group_size } : {}),
  });

  it.each([
    ['raid5', 4, 128, undefined, { su_kb: 128, sw: 3 }],
    ['raid6', 8, 64, undefined, { su_kb: 64, sw: 6 }],
    ['raid10', 4, 128, undefined, { su_kb: 128, sw: 2 }],
    ['raid50', 6, 128, 3, { su_kb: 128, sw: 4 }],
    ['raid0', 4, 256, undefined, { su_kb: 256, sw: 4 }],
    ['raid7', 8, 128, undefined, { su_kb: 128, sw: 5 }],
  ] as const)('%s × %d @ %s → %o', (level, members, strip, group, expected) => {
    expect(deriveStripe(arr(level, members, strip, group))).toEqual(expected);
  });

  it('underivable: missing strip size, missing group_size for raid50, sw < 1', () => {
    expect(deriveStripe(arr('raid5', 4))).toBeUndefined();
    expect(deriveStripe(arr('raid50', 6, 128))).toBeUndefined();
    expect(deriveStripe(arr('raid1', 2, 128))).toEqual({ su_kb: 128, sw: 1 });
  });
});

function facts(over: Partial<FsCreateFacts> = {}): FsCreateFacts {
  return {
    arraysByVolume: new Map([
      [
        '/dev/xi_data',
        {
          name: 'data',
          level: 'raid5',
          member_disk_ids: ['a', 'b', 'c', 'd'],
          strip_size_kib: 128,
        },
      ],
      [
        '/dev/xi_log',
        { name: 'log', level: 'raid10', member_disk_ids: ['e', 'f'], strip_size_kib: 16 },
      ],
    ]),
    filesystems: [{ id: 'srv-old.mount', mountpoint: '/srv/old', backing_device: '/dev/xi_old' }],
    ...over,
  };
}

const GOOD = {
  backing_device: '/dev/xi_data',
  mountpoint: '/mnt/data',
  log_device: '/dev/xi_log',
};

const codes = (blockers: Array<{ code: string }>): string[] => blockers.map((b) => b.code);

describe('validateFsCreate', () => {
  it('valid spec → no blockers', () => {
    expect(validateFsCreate(parseFsCreateSpec(GOOD), facts())).toEqual([]);
  });

  it('blocker table', () => {
    expect(
      codes(validateFsCreate(parseFsCreateSpec({ ...GOOD, mountpoint: 'rel/path' }), facts())),
    ).toContain('mountpoint_invalid');
    expect(
      codes(validateFsCreate(parseFsCreateSpec({ ...GOOD, mountpoint: '/srv/old' }), facts())),
    ).toContain('mountpoint_taken');
    expect(
      codes(validateFsCreate(parseFsCreateSpec({ ...GOOD, backing_device: '/dev/sda' }), facts())),
    ).toContain('backing_array_not_found');
    expect(
      codes(
        validateFsCreate(
          parseFsCreateSpec(GOOD),
          facts({
            filesystems: [{ id: 'x.mount', mountpoint: '/x', backing_device: '/dev/xi_data' }],
          }),
        ),
      ),
    ).toContain('backing_device_in_use');
    expect(
      codes(validateFsCreate(parseFsCreateSpec({ ...GOOD, log_device: '/dev/loop0' }), facts())),
    ).toContain('log_array_not_found');
    // stripe underivable: backing array without strip size, no override
    expect(
      codes(
        validateFsCreate(
          parseFsCreateSpec(GOOD),
          facts({
            arraysByVolume: new Map([
              ['/dev/xi_data', { name: 'data', level: 'raid5', member_disk_ids: ['a', 'b', 'c'] }],
              [
                '/dev/xi_log',
                { name: 'log', level: 'raid10', member_disk_ids: ['e', 'f'], strip_size_kib: 16 },
              ],
            ]),
          }),
        ),
      ),
    ).toContain('stripe_underivable');
    // explicit override silences it
    expect(
      validateFsCreate(
        parseFsCreateSpec({ ...GOOD, su_kb: 64, sw: 2 }),
        facts({
          arraysByVolume: new Map([
            ['/dev/xi_data', { name: 'data', level: 'raid5', member_disk_ids: ['a', 'b', 'c'] }],
            [
              '/dev/xi_log',
              { name: 'log', level: 'raid10', member_disk_ids: ['e', 'f'], strip_size_kib: 16 },
            ],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it('force:true adds the advisory dangerous blocker', () => {
    const blockers = validateFsCreate(parseFsCreateSpec({ ...GOOD, force: true }), facts());
    expect(codes(blockers)).toEqual(['dangerous_flag_required']);
  });
});

describe('per-op validations', () => {
  it('mount: failed backing array blocks', () => {
    expect(codes(validateFsMount({ arrayState: 'failed' }))).toEqual(['backing_array_unhealthy']);
    expect(validateFsMount({ arrayState: 'optimal' })).toEqual([]);
    expect(validateFsMount({ arrayState: 'rebuilding' })).toEqual([]);
    expect(validateFsMount({ arrayState: 'degraded' })).toEqual([]);
  });

  it('unmount: sessions and exports under the mountpoint block', () => {
    expect(
      codes(
        validateFsUnmount({
          sessionsUnder: [{ id: 's1', export_path: '/mnt/data/share' }],
          exportsUnder: ['/mnt/data/share'],
        }),
      ).sort(),
    ).toEqual(['dependent_share_active', 'mountpoint_exported']);
    expect(validateFsUnmount({ sessionsUnder: [], exportsUnder: [] })).toEqual([]);
  });

  it('grow needs mounted; unmanage needs unmounted', () => {
    expect(codes(validateFsGrow({ mounted: false }))).toEqual(['fs_not_mounted']);
    expect(validateFsGrow({ mounted: true })).toEqual([]);
    expect(codes(validateFsUnmanage({ mounted: true }))).toEqual(['fs_mounted']);
    expect(validateFsUnmanage({ mounted: false })).toEqual([]);
  });
});

describe('parsePatchIntent', () => {
  it('maps single intents', () => {
    expect(parsePatchIntent({ mounted: true })).toEqual({ kind: 'mount' });
    expect(parsePatchIntent({ mounted: false })).toEqual({ kind: 'unmount' });
    expect(parsePatchIntent({ grow: true })).toEqual({ kind: 'grow' });
    expect(parsePatchIntent({ quota_mode: 'pquota' })).toEqual({
      kind: 'quota',
      quota_mode: 'pquota',
    });
  });

  it('rejects multi-intent, empty, and junk', () => {
    expect(() => parsePatchIntent({ mounted: true, grow: true })).toThrow(/one/i);
    expect(() => parsePatchIntent({})).toThrow(/one/i);
    expect(() => parsePatchIntent({ quota_mode: 'bogus' })).toThrow(/quota_mode/);
    expect(() => parsePatchIntent({ grow: false })).toThrow(/grow/);
  });

  it('identity fields are exported for the route 422 scan', () => {
    expect(FS_IDENTITY_FIELDS).toContain('mountpoint');
    expect(FS_IDENTITY_FIELDS).toContain('backing_device');
    expect(FS_IDENTITY_FIELDS).toContain('su_kb');
  });
});

describe('parseFsCreateSpec', () => {
  it('tolerates enrichment keys; throws on junk', () => {
    const parsed = parseFsCreateSpec({
      ...GOOD,
      unit_name: 'mnt-data.mount',
      resolved_su_kb: 128,
    });
    expect(parsed.backing_device).toBe('/dev/xi_data');
    expect(() => parseFsCreateSpec(null)).toThrow(/spec/);
    expect(() => parseFsCreateSpec({ mountpoint: '/x' })).toThrow(/backing_device/);
    expect(() => parseFsCreateSpec({ ...GOOD, quota_mode: 'bogus' })).toThrow(/quota_mode/);
  });
});
