import { describe, expect, it } from 'vitest';
import type { XiraidArraySpec } from '../../../lib/xiraid/schema.js';
import {
  type CreateFacts,
  type ModifyFacts,
  type ResolvedDisk,
  parseCreateSpec,
  parseModifySpec,
  validateCreateSpec,
  validateModifySpec,
} from '../../../lib/xiraid/validate.js';

function disk(id: string, over: Partial<ResolvedDisk> = {}): ResolvedDisk {
  return {
    id,
    device_path: `/dev/${id}`,
    safe_for_use: true,
    system_disk: false,
    mounted: false,
    ...over,
  };
}

/** d1..d12 — enough members for raid70's documented 12-drive minimum. */
const POOL = Array.from({ length: 12 }, (_, i) => `d${i + 1}`);

function facts(over: Partial<CreateFacts> = {}): CreateFacts {
  return {
    disks: [...POOL.map((id) => disk(id)), disk('claimed')],
    existingArrayNames: ['taken'],
    existingMemberDiskIds: new Set(['claimed']),
    ...over,
  };
}

function modifyFacts(over: Partial<ModifyFacts> = {}): ModifyFacts {
  return {
    arrayName: 'data',
    disks: [disk('d5'), disk('own-spare'), disk('claimed')],
    existingMemberDiskIds: new Set(['claimed']),
    ownSpareDiskIds: new Set(),
    ...over,
  };
}

function spec(over: Partial<XiraidArraySpec> = {}): XiraidArraySpec {
  return {
    name: 'data',
    level: 'raid6',
    member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
    ...over,
  };
}

const codes = (spec_: XiraidArraySpec, facts_: CreateFacts = facts()): string[] =>
  validateCreateSpec(spec_, facts_).map((b) => b.code);

describe('validateCreateSpec', () => {
  it('valid raid6 spec over safe disks → no blockers', () => {
    expect(validateCreateSpec(spec(), facts())).toEqual([]);
  });

  // Minimums are xiRAID's own, published per level in the 4.4.0 Administrator's
  // Guide ("RAIDs explained"). They are NOT textbook RAID minimums: raid5 needs
  // 4, not 3, and raid50 needs 8, not 6. A floor below the engine's lets a spec
  // through the plan and fails it later at raid_create.
  it.each([
    ['raid0', 1],
    ['raid1', 2],
    ['raid5', 4],
    ['raid6', 4],
    ['raid7', 6],
    ['raid10', 4],
    ['raid50', 8],
    ['raid60', 8],
    ['raid70', 12],
    ['n+m', 8],
  ] as const)('level minimum for %s is %i drives', (level, min) => {
    const under = POOL.slice(0, min - 1);
    const at = POOL.slice(0, min);
    // group_size / synd_cnt are supplied so the only blocker in play is min_drives
    const extra =
      level === 'raid50' || level === 'raid60'
        ? { group_size: 4 }
        : level === 'raid70'
          ? { group_size: 6 }
          : level === 'n+m'
            ? { synd_cnt: 4 }
            : {};
    if (min > 1) {
      expect(codes(spec({ level, member_disk_ids: under, ...extra }))).toContain('min_drives');
    }
    expect(codes(spec({ level, member_disk_ids: at, ...extra }))).not.toContain('min_drives');
  });

  // AG / RAIDs explained: "RAID 10 requires at least 2 drives (the number of
  // drives must be even)". Only raid10 carries the rule.
  it('raid10 rejects an odd member count', () => {
    expect(codes(spec({ level: 'raid10', member_disk_ids: POOL.slice(0, 5) }))).toContain(
      'members_not_even',
    );
    expect(codes(spec({ level: 'raid10', member_disk_ids: POOL.slice(0, 6) }))).toEqual([]);
  });

  it('odd member counts are fine for levels without the even rule', () => {
    expect(codes(spec({ level: 'raid5', member_disk_ids: POOL.slice(0, 5) }))).toEqual([]);
  });

  // AG raises raid70's group-size floor to 6; raid50/60 stay at the command
  // reference's 4.
  it('raid70 group_size floor is 6, not the generic 4', () => {
    const twelve = POOL.slice(0, 12);
    expect(codes(spec({ level: 'raid70', member_disk_ids: twelve, group_size: 4 }))).toContain(
      'group_size_range',
    );
    expect(codes(spec({ level: 'raid70', member_disk_ids: twelve, group_size: 6 }))).toEqual([]);
    // the same group_size of 4 is valid for raid50
    expect(
      codes(spec({ level: 'raid50', member_disk_ids: POOL.slice(0, 8), group_size: 4 })),
    ).toEqual([]);
  });

  it('raid50/60/70 group_size rules', () => {
    const eight = POOL.slice(0, 8);
    expect(codes(spec({ level: 'raid50', member_disk_ids: eight }))).toContain(
      'group_size_required',
    );
    // xiRAID's documented range is 4-32 (command reference); 3 used to pass
    expect(codes(spec({ level: 'raid50', member_disk_ids: eight, group_size: 3 }))).toContain(
      'group_size_range',
    );
    expect(codes(spec({ level: 'raid50', member_disk_ids: eight, group_size: 33 }))).toContain(
      'group_size_range',
    );
    // 8 % 4 == 0 and 8/4 = 2 groups → valid
    expect(codes(spec({ level: 'raid50', member_disk_ids: eight, group_size: 4 }))).toEqual([]);
    expect(codes(spec({ level: 'raid50', member_disk_ids: eight, group_size: 6 }))).toContain(
      'members_not_divisible_by_group',
    );
    // group_size == member count → only 1 group → compound level needs >= 2
    expect(codes(spec({ level: 'raid50', member_disk_ids: eight, group_size: 8 }))).toContain(
      'members_not_divisible_by_group',
    );
  });

  it('n+m synd_cnt rules', () => {
    const eight = POOL.slice(0, 8);
    expect(codes(spec({ level: 'n+m', member_disk_ids: eight }))).toContain('synd_cnt_required');
    expect(codes(spec({ level: 'n+m', member_disk_ids: eight, synd_cnt: 3 }))).toContain(
      'synd_cnt_range',
    );
    expect(codes(spec({ level: 'n+m', member_disk_ids: eight, synd_cnt: 4 }))).toEqual([]);
  });

  it('strip/block validation', () => {
    expect(codes(spec({ strip_size_kib: 48 }))).toContain('strip_size_invalid');
    expect(codes(spec({ block_size: 1024 }))).toContain('block_size_invalid');
    expect(codes(spec({ strip_size_kib: 64, block_size: 512 }))).toEqual([]);
  });

  it('tuning ranges', () => {
    expect(codes(spec({ tuning: { init_prio: 0 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { recon_prio: 101 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { memory_limit: 512 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { memory_limit: 0 } }))).toEqual([]); // 0 = disabled
    expect(codes(spec({ tuning: { memory_prealloc: 70000 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { max_sectors_kb: 2 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { merge_read_max: -1 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { init_prio: 50, memory_limit: 2048 } }))).toEqual([]);
  });

  it('name rules', () => {
    expect(codes(spec({ name: 'bad name!' }))).toContain('name_invalid');
    expect(codes(spec({ name: 'taken' }))).toContain('name_taken');
  });

  it('disk rules — one blocker per offending disk', () => {
    const f = facts({
      disks: [
        disk('d1'),
        disk('d2', { safe_for_use: false, mounted: true }),
        disk('d3', { safe_for_use: false, system_disk: true }),
        disk('d4'),
        disk('claimed'),
      ],
    });
    const blockers = validateCreateSpec(
      spec({ member_disk_ids: ['d1', 'd2', 'd3', 'missing', 'claimed'] }),
      f,
    );
    const byCode = blockers.map((b) => b.code);
    expect(byCode).toContain('disk_not_safe'); // d2
    expect(byCode).toContain('disk_is_system'); // d3
    expect(byCode).toContain('disk_not_found'); // missing
    expect(byCode).toContain('disk_in_use'); // claimed
    expect(blockers.filter((b) => b.code.startsWith('disk_')).length).toBe(4);
  });

  // ---- S4 T3: spares un-deferred — validated like members ----

  it('create-with-spares: safe spare disks → no blockers (spare_pool_deferred is gone)', () => {
    const blockers = validateCreateSpec(spec({ spare_disk_ids: ['d5'] }), facts());
    expect(blockers).toEqual([]);
  });

  it('spare disks get the member disk checks', () => {
    const f = facts({
      disks: [
        disk('d1'),
        disk('d2'),
        disk('d3'),
        disk('d4'),
        disk('bad', { safe_for_use: false, mounted: true }),
      ],
    });
    expect(validateCreateSpec(spec({ spare_disk_ids: ['bad'] }), f).map((b) => b.code)).toContain(
      'disk_not_safe',
    );
    expect(codes(spec({ spare_disk_ids: ['ghost'] }))).toContain('disk_not_found');
    expect(codes(spec({ spare_disk_ids: ['claimed'] }))).toContain('disk_in_use');
    // a spare that is ALSO a member of this very spec is double-booked
    expect(codes(spec({ spare_disk_ids: ['d1'] }))).toContain('disk_in_use');
  });

  // xiRAID array naming rules, per the 4.4.0 command reference: max 28 chars,
  // Latin letters / numbers / underscores, and "power"/"uevent" prohibited.
  it('array names follow xiRAID rules', () => {
    expect(codes(spec({ name: 'a'.repeat(28) }))).toEqual([]);
    expect(codes(spec({ name: 'a'.repeat(29) }))).toContain('name_invalid');
    // hyphens are valid in most Linux object names but NOT in a xiRAID array name
    expect(codes(spec({ name: 'my-array' }))).toContain('name_invalid');
    expect(codes(spec({ name: 'my_array' }))).toEqual([]);
    for (const reserved of ['power', 'uevent']) {
      expect(codes(spec({ name: reserved }))).toContain('name_invalid');
    }
    // The prohibited-name match is EXACT, and deliberately so: the array
    // surfaces as /sys/block/xi_<name>/ and the attributes it would collide
    // with are lowercase, so 'POWER' collides with nothing. Rejecting it would
    // refuse a name xiRAID accepts. Mirrored in the TUI rule module — see
    // tests/test_raid_rules.py::TestArrayName.
    for (const notReserved of ['POWER', 'Uevent']) {
      expect(codes(spec({ name: notReserved }))).toEqual([]);
    }
  });

  it('derived pool name xnsp_<name> cannot overflow once names are capped at 28', () => {
    // The longest legal array name is 28 chars, so xnsp_ + name is at most 33 —
    // comfortably inside the 63-char assumption. The guard in validate.ts is
    // therefore unreachable by construction; this test pins that invariant so a
    // future relaxation of NAME_RE has to revisit it.
    const longest = 'a'.repeat(28);
    expect(`xnsp_${longest}`.length).toBeLessThanOrEqual(63);
    expect(codes(spec({ name: longest, spare_disk_ids: ['d5'] }))).toEqual([]);
  });
});

describe('validateModifySpec', () => {
  it('tuning ranges reuse the create rules', () => {
    const out = validateModifySpec({ tuning: { init_prio: 0, memory_limit: 512 } }, modifyFacts());
    expect(out.map((b) => b.code)).toEqual(['param_out_of_range', 'param_out_of_range']);
    expect(validateModifySpec({ tuning: { init_prio: 50 } }, modifyFacts())).toEqual([]);
  });

  it('spare disks checked like members; own current spares exempt from disk_in_use', () => {
    const f = modifyFacts({
      existingMemberDiskIds: new Set(['claimed', 'own-spare']),
      ownSpareDiskIds: new Set(['own-spare']),
    });
    expect(validateModifySpec({ spare_disk_ids: ['claimed'] }, f).map((b) => b.code)).toContain(
      'disk_in_use',
    );
    // keeping (or re-listing) this array's own spare is NOT "in use"
    expect(validateModifySpec({ spare_disk_ids: ['own-spare'] }, f)).toEqual([]);
    expect(validateModifySpec({ spare_disk_ids: ['ghost'] }, f).map((b) => b.code)).toContain(
      'disk_not_found',
    );
  });

  it('pool-name length guard applies via the target array name', () => {
    const out = validateModifySpec(
      { spare_disk_ids: ['d5'] },
      modifyFacts({ arrayName: 'a'.repeat(60) }),
    );
    expect(out.map((b) => b.code)).toContain('name_invalid');
  });
});

describe('parseModifySpec', () => {
  it('narrows spare_disk_ids/tuning and tolerates enrichment keys', () => {
    const parsed = parseModifySpec({
      spare_disk_ids: ['d5'],
      tuning: { init_prio: 10 },
      id: 'data',
      device_by_id: { d5: '/dev/nvme5n1' },
      current_sparepool: '',
      current_spare_disk_ids: [],
    });
    expect(parsed.spare_disk_ids).toEqual(['d5']);
    expect(parsed.tuning?.init_prio).toBe(10);
  });

  it('throws on structural junk', () => {
    expect(() => parseModifySpec(null)).toThrow(/spec/);
    expect(() => parseModifySpec({ spare_disk_ids: 'nope' })).toThrow(/spare_disk_ids/);
    expect(() => parseModifySpec({ tuning: 7 })).toThrow(/tuning/);
  });
});

describe('parseCreateSpec', () => {
  it('narrows a valid unknown payload', () => {
    const parsed = parseCreateSpec({
      name: 'data',
      level: 'raid6',
      member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
      tuning: { init_prio: 10 },
    });
    expect(parsed.level).toBe('raid6');
  });

  it('throws on structural junk', () => {
    expect(() => parseCreateSpec(null)).toThrow(/spec/);
    expect(() => parseCreateSpec({ name: 'x' })).toThrow(/level/);
    expect(() => parseCreateSpec({ name: 'x', level: 'raid99', member_disk_ids: [] })).toThrow(
      /level/,
    );
    expect(() => parseCreateSpec({ name: 'x', level: 'raid6', member_disk_ids: 'nope' })).toThrow(
      /member_disk_ids/,
    );
  });
});
