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
    poolsByName: new Map(),
    ...over,
  };
}

function modifyFacts(over: Partial<ModifyFacts> = {}): ModifyFacts {
  return {
    poolsByName: new Map(),
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

  // CR 4.4: every merge knob is "integers from 1 to 100000" on BOTH create and
  // modify. Accepting anything >= 0 let 0 and 200000 through preflight and put
  // the rejection at raid_create, which is the failure this table exists to
  // prevent. https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html
  it('merge timings are bounded to the documented 1-100000 us', () => {
    for (const field of [
      'merge_read_max',
      'merge_read_wait',
      'merge_write_max',
      'merge_write_wait',
    ] as const) {
      expect(codes(spec({ tuning: { [field]: 0 } }))).toContain('param_out_of_range');
      expect(codes(spec({ tuning: { [field]: 100001 } }))).toContain('param_out_of_range');
      expect(codes(spec({ tuning: { [field]: 1 } }))).toEqual([]);
      expect(codes(spec({ tuning: { [field]: 100000 } }))).toEqual([]);
    }
  });

  // CR 4.4 request_limit: "integers from 0 to 4294967295".
  it('request_limit is bounded above as well as below', () => {
    expect(codes(spec({ tuning: { request_limit: 4294967296 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { request_limit: 4294967295 } }))).toEqual([]);
    expect(codes(spec({ tuning: { request_limit: 0 } }))).toEqual([]);
  });

  // CR 4.4 create: init_prio and restripe_prio are "from 1 to 100"; modify
  // widens both to "from 0 to 100" (see the modify suite below).
  it('create keeps the priorities at the create floor of 1', () => {
    expect(codes(spec({ tuning: { init_prio: 0 } }))).toContain('param_out_of_range');
    expect(codes(spec({ tuning: { restripe_prio: 0 } }))).toContain('param_out_of_range');
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
});

describe('validateModifySpec', () => {
  it('tuning ranges reuse the create rules', () => {
    const out = validateModifySpec({ tuning: { recon_prio: 0, memory_limit: 512 } }, modifyFacts());
    expect(out.map((b) => b.code)).toEqual(['param_out_of_range', 'param_out_of_range']);
    expect(validateModifySpec({ tuning: { init_prio: 50 } }, modifyFacts())).toEqual([]);
  });

  /*
   * CR 4.4 states different priority floors per surface: `raid create` gives
   * init_prio and restripe_prio as "from 1 to 100", `raid modify` gives both as
   * "from 0 to 100". recon_prio and sdc_prio stay "from 1 to 100" on both.
   * Applying the create floor to a modify blocks a value xicli accepts, which
   * is a preflight that lies in the opposite direction from a missing bound.
   */
  it('modify allows the priority floor of 0 that create rejects', () => {
    expect(validateModifySpec({ tuning: { init_prio: 0 } }, modifyFacts())).toEqual([]);
    expect(validateModifySpec({ tuning: { restripe_prio: 0 } }, modifyFacts())).toEqual([]);
    // ...but only for the two the reference widens.
    expect(
      validateModifySpec({ tuning: { recon_prio: 0 } }, modifyFacts()).map((b) => b.code),
    ).toEqual(['param_out_of_range']);
    expect(
      validateModifySpec({ tuning: { sdc_prio: 0 } }, modifyFacts()).map((b) => b.code),
    ).toEqual(['param_out_of_range']);
    // and 101 is still out of range on either surface
    expect(
      validateModifySpec({ tuning: { init_prio: 101 } }, modifyFacts()).map((b) => b.code),
    ).toEqual(['param_out_of_range']);
  });
});

describe('parseModifySpec', () => {
  it('narrows spare_pool/tuning and tolerates enrichment keys', () => {
    const parsed = parseModifySpec({
      spare_pool: 'sp01',
      tuning: { init_prio: 10 },
      id: 'data',
      device_by_id: { d5: '/dev/nvme5n1' },
      current_sparepool: '',
      current_spare_disk_ids: [],
    });
    expect(parsed.spare_pool).toBe('sp01');
    expect(parsed.tuning?.init_prio).toBe(10);
  });

  // The api's own persisted enriched spec still carries this observed-only
  // key at apply time (it is re-parsed, not re-validated). Rejecting it
  // against the raw PATCH body is the ROUTE's job (Task 5); this parser must
  // stay tolerant so a re-parse of its own output never throws.
  it('ignores a stray spare_disk_ids key regardless of its shape', () => {
    expect(parseModifySpec({ spare_disk_ids: ['d5'] })).not.toHaveProperty('spare_disk_ids');
    expect(() => parseModifySpec({ spare_disk_ids: 'nope' })).not.toThrow();
  });

  it('throws on structural junk', () => {
    expect(() => parseModifySpec(null)).toThrow(/spec/);
    expect(() => parseModifySpec({ spare_pool: 7 })).toThrow(/spare_pool/);
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

describe('spare pool references', () => {
  const facts = (pools: Record<string, { drives: string[]; active: boolean }>) => ({
    poolsByName: new Map(Object.entries(pools)),
  });

  it('rejects spare_disk_ids on create as observed-only', () => {
    expect(() =>
      parseCreateSpec({
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1'],
        spare_disk_ids: ['d5'],
      }),
    ).toThrow(/observed-only/);
  });

  it('blocks a create naming a pool that does not exist', () => {
    const blockers = validateCreateSpec(
      {
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
        spare_pool: 'sp01',
      },
      { disks: [], existingArrayNames: [], existingMemberDiskIds: new Set(), ...facts({}) },
    );
    expect(blockers.map((b) => b.code)).toContain('spare_pool_not_found');
  });

  it('blocks a create naming an empty pool', () => {
    const blockers = validateCreateSpec(
      {
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
        spare_pool: 'sp01',
      },
      {
        disks: [],
        existingArrayNames: [],
        existingMemberDiskIds: new Set(),
        ...facts({ sp01: { drives: [], active: true } }),
      },
    );
    expect(blockers.map((b) => b.code)).toContain('spare_pool_empty');
  });

  it('accepts a modify naming a populated pool', () => {
    const blockers = validateModifySpec(
      { spare_pool: 'sp01' },
      facts({ sp01: { drives: ['/dev/nvme5n2'], active: false } }),
    );
    expect(blockers).toEqual([]);
  });

  it('accepts a detach with no pool blockers', () => {
    expect(validateModifySpec({ spare_pool: null }, facts({}))).toEqual([]);
  });

  it('distinguishes an absent spare_pool from an explicit null', () => {
    expect(parseModifySpec({ tuning: {} }).spare_pool).toBeUndefined();
    expect(parseModifySpec({ spare_pool: null }).spare_pool).toBeNull();
  });
});
