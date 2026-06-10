import { describe, expect, it } from 'vitest';
import type { XiraidArraySpec } from '../../../lib/xiraid/schema.js';
import { toRaidCreateRequest } from '../../../lib/xiraid/translate.js';

const DEVICES = new Map([
  ['d1', '/dev/nvme1n1'],
  ['d2', '/dev/nvme2n1'],
  ['d3', '/dev/nvme3n1'],
  ['d4', '/dev/nvme4n1'],
]);

describe('toRaidCreateRequest', () => {
  it('maps a full-tuning spec (golden)', () => {
    const spec: XiraidArraySpec = {
      name: 'data',
      level: 'raid6',
      member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
      strip_size_kib: 64,
      block_size: 4096,
      force_metadata: true,
      tuning: {
        init_prio: 50,
        recon_prio: 60,
        restripe_prio: 70,
        resync_enabled: true,
        sched_enabled: true,
        merge_read_enabled: false,
        merge_write_enabled: true,
        merge_read_max: 100,
        merge_read_wait: 200,
        merge_write_max: 300,
        merge_write_wait: 400,
        memory_limit: 2048,
        request_limit: 500,
        memory_prealloc: 4096,
        adaptive_merge: false,
        cpu_allowed: '0-7',
        max_sectors_kb: 512,
        sdc_prio: 10,
        single_run: true,
        discard: true,
        drive_trim: false,
      },
    };
    expect(toRaidCreateRequest(spec, DEVICES)).toEqual({
      name: 'data',
      level: '6',
      drives: ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'],
      strip_size: 64,
      block_size: 4096,
      force_metadata: true,
      init_prio: 50,
      recon_prio: 60,
      restripe_prio: 70,
      resync_enabled: 1,
      sched_enabled: 1,
      merge_read_enabled: 0,
      merge_write_enabled: 1,
      merge_read_max: 100,
      merge_read_wait: 200,
      merge_write_max: 300,
      merge_write_wait: 400,
      memory_limit: 2048,
      request_limit: 500,
      memory_prealloc: 4096,
      adaptive_merge: 0,
      cpu_allowed: '0-7',
      max_sectors_kb: 512,
      sdc_prio: 10,
      single_run: true,
      discard: 1,
      drive_trim: 0,
    });
  });

  it('minimal spec: null/absent tuning omitted; n+m carries synd_cnt; group_size for raid50', () => {
    const minimal = toRaidCreateRequest(
      {
        name: 'log',
        level: 'n+m',
        member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
        synd_cnt: 4,
        strip_size_kib: null,
        tuning: { init_prio: null, cpu_allowed: null },
      },
      DEVICES,
    );
    expect(minimal).toEqual({
      name: 'log',
      level: 'n+m',
      drives: ['/dev/nvme1n1', '/dev/nvme2n1', '/dev/nvme3n1', '/dev/nvme4n1'],
      synd_cnt: 4,
    });
    const compound = toRaidCreateRequest(
      { name: 'big', level: 'raid50', member_disk_ids: ['d1', 'd2', 'd3', 'd4'], group_size: 2 },
      DEVICES,
    );
    expect(compound.level).toBe('50');
    expect(compound.group_size).toBe(2);
  });

  it('never sets force; throws on an unresolved member disk id', () => {
    const req = toRaidCreateRequest(
      { name: 'x', level: 'raid0', member_disk_ids: ['d1', 'd2'] },
      DEVICES,
    );
    expect('force' in req).toBe(false);
    expect(() =>
      toRaidCreateRequest({ name: 'x', level: 'raid0', member_disk_ids: ['nope'] }, DEVICES),
    ).toThrow(/nope/);
  });
});
