import { describe, expect, it } from 'vitest';
import type { XiraidArraySpec } from '../../../lib/xiraid/schema.js';
import {
  SPAREPOOL_DETACH,
  toRaidCreateRequest,
  toRaidModifyRequest,
} from '../../../lib/xiraid/translate.js';

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

  // ---- 2026-08-29 design: spare pools are referenced by name, not derived ----

  it('passes spec.spare_pool through as the create sparepool', () => {
    const req = toRaidCreateRequest(
      {
        name: 'data',
        level: 'raid5',
        member_disk_ids: ['d1', 'd2', 'd3', 'd4'],
        spare_pool: 'sp01',
      },
      DEVICES,
    );
    expect(req.sparepool).toBe('sp01');
  });

  it('omits sparepool when no spare pool is named', () => {
    const req = toRaidCreateRequest(
      { name: 'data', level: 'raid0', member_disk_ids: ['d1', 'd2'] },
      DEVICES,
    );
    expect('sparepool' in req).toBe(false);
  });

  it('spare_disk_ids alone (observed-only field) does not derive a sparepool', () => {
    // spare_disk_ids is observed-only after the 2026-08-29 design change — a
    // caller that sends it without spec.spare_pool must not get a pool
    // conjured from the array name any more (that was the executor-owned
    // xnsp_<name> pool this design retires).
    const req = toRaidCreateRequest(
      { name: 'data', level: 'raid0', member_disk_ids: ['d1', 'd2'], spare_disk_ids: ['d3'] },
      DEVICES,
    );
    expect('sparepool' in req).toBe(false);
  });
});

describe('toRaidModifyRequest', () => {
  it('tuning golden: boolean→0/1, null dropped, never force; create-only knobs dropped', () => {
    const req = toRaidModifyRequest('data', {
      tuning: {
        init_prio: 50,
        // create-time knobs — RaidModify has no field for any of them, so the
        // translator drops them (they are also rejected up front by the route).
        resync_enabled: true,
        discard: true,
        drive_trim: false,
        merge_read_enabled: false,
        cpu_allowed: '0-3',
        memory_limit: null,
        single_run: true,
      },
    });
    expect(req).toEqual({
      name: 'data',
      init_prio: 50,
      merge_read_enabled: 0,
      cpu_allowed: '0-3',
      single_run: true,
    });
    expect('discard' in req).toBe(false);
    expect('drive_trim' in req).toBe(false);
    expect('resync_enabled' in req).toBe(false);
    expect('force' in req).toBe(false);
  });

  it('cpu_allowed reset translates the empty string to xiRAID\'s "all" sentinel', () => {
    // xiRAID documents ONE reset value for the affinity knob: the literal
    // string `all` (CR 4.2/4.3 `raid modify` -ca: "a comma-separated list of
    // CPUs, a range of CPUs indicated by a hyphen, or the value 'all'").
    // An empty string is not a documented value — the daemon reads it as
    // "argument not supplied", so a reset-only modify carried NO modifiable
    // argument and the whole call came back INVALID_ARGUMENT "Required
    // arguments are missing: 'cpu_allowed, init_prio, ...'".
    expect(toRaidModifyRequest('data', { tuning: { cpu_allowed: '' } })).toEqual({
      name: 'data',
      cpu_allowed: 'all',
    });
    // ...and whitespace is the same request typed sloppily.
    expect(toRaidModifyRequest('data', { tuning: { cpu_allowed: '  ' } })).toEqual({
      name: 'data',
      cpu_allowed: 'all',
    });
    // An explicit 'all' from a client passes through unchanged.
    expect(toRaidModifyRequest('data', { tuning: { cpu_allowed: 'all' } })).toEqual({
      name: 'data',
      cpu_allowed: 'all',
    });
    // A real CPU list is untouched.
    expect(toRaidModifyRequest('data', { tuning: { cpu_allowed: '0,2,4-7' } })).toEqual({
      name: 'data',
      cpu_allowed: '0,2,4-7',
    });
    // create carries the same spelling.
    const created = toRaidCreateRequest(
      { name: 'data', level: 'raid0', member_disk_ids: ['d1', 'd2'], tuning: { cpu_allowed: '' } },
      DEVICES,
    );
    expect(created.cpu_allowed).toBe('all');
  });

  it('sparepool attach passes the pool name through', () => {
    expect(toRaidModifyRequest('data', { sparepool: 'xnsp_data' })).toEqual({
      name: 'data',
      sparepool: 'xnsp_data',
    });
  });

  // The daemon counts a present-but-empty string as UNSUPPLIED
  // (gRPC/validation/helper.py::check_number_of_entries_helper), so a detach
  // spelled `sparepool: ''` is rejected with "Required arguments are missing:
  // '…, sparepool, …'" when it is the whole payload, and silently detaches
  // nothing when it rides along with tuning (the handler gates on
  // `if opts.get("sparepool")`). The sentinel is POOL_REMOVE_CMD = "null".
  it("detach renders the 'null' sentinel, never the empty string", () => {
    const req = toRaidModifyRequest('data', { sparepool: '' });
    expect(req).toEqual({ name: 'data', sparepool: SPAREPOOL_DETACH });
    expect(req.sparepool).toBe('null');
    expect(req.sparepool).not.toBe('');
  });

  it('detach carries a real argument even when it is the whole payload', () => {
    // The exact request apply_spares sends when spare_disk_ids empties and no
    // tuning changed. Nothing here may be empty, or the daemon sees a modify
    // with no modifiable argument at all.
    const { name, ...rest } = toRaidModifyRequest('data', { sparepool: '' });
    expect(name).toBe('data');
    expect(Object.values(rest).some((v) => v !== '' && v !== undefined)).toBe(true);
  });

  it('normalizes the detach spelling alongside a tuning batch too', () => {
    expect(toRaidModifyRequest('data', { sparepool: '', tuning: { init_prio: 50 } })).toEqual({
      name: 'data',
      sparepool: SPAREPOOL_DETACH,
      init_prio: 50,
    });
  });

  it('leaves sparepool out entirely when the caller is not changing it', () => {
    expect('sparepool' in toRaidModifyRequest('data', { tuning: { init_prio: 50 } })).toBe(false);
  });
});
