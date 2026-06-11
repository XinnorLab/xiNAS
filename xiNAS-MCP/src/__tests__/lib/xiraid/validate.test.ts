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

function facts(over: Partial<CreateFacts> = {}): CreateFacts {
  return {
    disks: [
      disk('d1'),
      disk('d2'),
      disk('d3'),
      disk('d4'),
      disk('d5'),
      disk('d6'),
      disk('claimed'),
    ],
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

  it('level minimums', () => {
    expect(codes(spec({ member_disk_ids: ['d1', 'd2', 'd3'] }))).toContain('min_drives');
    expect(codes(spec({ level: 'raid5', member_disk_ids: ['d1', 'd2', 'd3'] }))).toEqual([]);
  });

  it('raid50/60/70 group_size rules', () => {
    const six = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    expect(codes(spec({ level: 'raid50', member_disk_ids: six }))).toContain('group_size_required');
    expect(codes(spec({ level: 'raid50', member_disk_ids: six, group_size: 1 }))).toContain(
      'group_size_range',
    );
    expect(codes(spec({ level: 'raid50', member_disk_ids: six, group_size: 4 }))).toContain(
      'members_not_divisible_by_group',
    );
    // 6 % 3 == 0 and 6/3 = 2 groups → valid
    expect(codes(spec({ level: 'raid50', member_disk_ids: six, group_size: 3 }))).toEqual([]);
    // group_size == member count → only 1 group → compound level needs >= 2
    expect(codes(spec({ level: 'raid50', member_disk_ids: six, group_size: 6 }))).toContain(
      'members_not_divisible_by_group',
    );
  });

  it('n+m synd_cnt rules', () => {
    const six = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    expect(codes(spec({ level: 'n+m', member_disk_ids: six }))).toContain('synd_cnt_required');
    expect(codes(spec({ level: 'n+m', member_disk_ids: six, synd_cnt: 3 }))).toContain(
      'synd_cnt_range',
    );
    expect(codes(spec({ level: 'n+m', member_disk_ids: six, synd_cnt: 4 }))).toEqual([]);
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

  it('derived pool name xnsp_<name> must fit the 63-char namespace', () => {
    const longName = 'a'.repeat(60); // valid alone, xnsp_+60 = 65 > 63
    expect(codes(spec({ name: longName, spare_disk_ids: ['d5'] }))).toContain('name_invalid');
    // without spares the same name is fine (no pool derived)
    expect(codes(spec({ name: longName }))).toEqual([]);
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
