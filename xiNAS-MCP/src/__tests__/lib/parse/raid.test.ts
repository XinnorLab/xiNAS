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

  // AG 4.4 "Showing RAID State" publishes the full state vocabulary; every word
  // in it has to land somewhere other than `unknown`, or an array in real
  // trouble is published to every client as unremarkable.
  // https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html
  it('maps the xiRAID 4.4 failure states to failed', () => {
    const states = (state: unknown) =>
      parseRaidShow([{ name: 'a', level: '5', devices: [], state }], DISK_IDS)[0]?.status;

    // "the RAID was unloaded via the unload command or was not restored after
    // reboot" — the volume is not there, exactly like offline.
    expect(states(['none'])?.state).toBe('failed');
    // "RAID can't complete reconstruction because of unrecoverable sections."
    expect(states(['unrecovered'])?.state).toBe('failed');
    // a failure word wins over an in-progress one
    expect(states(['reconstructing', 'unrecovered'])?.state).toBe('failed');
  });

  it('maps the xiRAID 4.4 impaired states to degraded', () => {
    const states = (state: unknown) =>
      parseRaidShow([{ name: 'a', level: '5', devices: [], state }], DISK_IDS)[0]?.status;

    // "an integrity error was detected during an SDC scan"
    expect(states(['online', 'inconsistent'])?.state).toBe('degraded');
    // "the RAID needs initialization" — parity is not valid yet, so there is
    // no redundancy even though the array answers I/O.
    expect(states(['online', 'need_init'])?.state).toBe('degraded');
    // "the license has expired. The RAID is read-only." — available, impaired.
    expect(states(['online', 'read_only'])?.state).toBe('degraded');
  });

  it('leaves the benign 4.4 states on the array-level verdict they came with', () => {
    const states = (state: unknown) =>
      parseRaidShow([{ name: 'a', level: '5', devices: [], state }], DISK_IDS)[0]?.status;

    // An SDC scan, a finished restripe awaiting a resize, and a stopped
    // restripe are all things an online array does; none of them costs
    // redundancy, so none of them may downgrade the verdict.
    expect(states(['online', 'initialized', 'sdc_scanning'])?.state).toBe('optimal');
    expect(states(['online', 'initialized', 'need_resize'])?.state).toBe('optimal');
    expect(states(['online', 'initialized', 'need_restripe'])?.state).toBe('optimal');
    // ...but restriping is progress, and reads as such.
    expect(states(['online', 'restriping'])?.state).toBe('rebuilding');
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

  // ---- size → usable_capacity_bytes (spec §5.1) ----
  // The live daemon renders `size` with the unit it was asked for (units:'g'),
  // so it arrives as a formatted STRING. Reading only JSON numbers is what
  // showed "Capacity | N/A" for every array on a real node.

  describe('usable_capacity_bytes from a unit-formatted size', () => {
    const capacity = (size: unknown): number | undefined =>
      parseRaidShow(
        [{ name: 'data', level: '5', devices: [], state: ['online'], size }],
        DISK_IDS,
      )[0]?.status.usable_capacity_bytes;

    it('reads the daemon string shape ("1.2T")', () => {
      expect(capacity('1.2T')).toBe(Math.round(1.2 * 1024 ** 4));
    });

    it('accepts the binary-unit spellings (T / TiB / TB, spaced or not)', () => {
      const expected = Math.round(1.2 * 1024 ** 4);
      expect(capacity('1.2 TiB')).toBe(expected);
      expect(capacity('1.2TB')).toBe(expected);
      expect(capacity('1.2 t')).toBe(expected);
    });

    it('scales k/m/g/p/e and a bare byte count', () => {
      expect(capacity('12K')).toBe(12 * 1024);
      expect(capacity('500M')).toBe(500 * 1024 ** 2);
      expect(capacity('163.727G')).toBe(Math.round(163.727 * 1024 ** 3));
      expect(capacity('2P')).toBe(2 * 1024 ** 5);
      expect(capacity('1024B')).toBe(1024);
    });

    it('a unit-less string is the unit the adapter asked for (GiB)', () => {
      expect(capacity('163.727')).toBe(Math.round(163.727 * 1024 ** 3));
    });

    it('a JSON number stays a byte count (fake transport / fixture shape)', () => {
      expect(capacity(15360000000000)).toBe(15360000000000);
    });

    it('always an integer — the api-v1 schema types it `integer`', () => {
      expect(Number.isInteger(capacity('1.2T'))).toBe(true);
      expect(Number.isInteger(capacity('163.727'))).toBe(true);
    });

    it('omits the field when the size is absent or unreadable', () => {
      expect(capacity(undefined)).toBeUndefined();
      expect(capacity('')).toBeUndefined();
      expect(capacity('n/a')).toBeUndefined();
      expect(capacity('T')).toBeUndefined();
      expect(capacity(Number.NaN)).toBeUndefined();
      expect(capacity({ bytes: 5 })).toBeUndefined();
    });
  });

  // ---- spec.tuning from the extended payload (spec §5) ----
  // raid_show --extended reports the array's EFFECTIVE tuning. The daemon
  // suffixes units where ADR-0006 spec.tuning does not; the parser renames.
  // An unobserved knob must stay ABSENT — a client that fills in a default
  // tells the operator the array is configured a way it is not.

  describe('spec.tuning', () => {
    const tuning = (extra: Record<string, unknown>) =>
      parseRaidShow(
        [{ name: 'data', level: '5', devices: [], state: ['online'], ...extra }],
        DISK_IDS,
      )[0]?.spec.tuning;

    it('renames the daemon unit-suffixed names to the ADR-0006 tuning names', () => {
      expect(
        tuning({
          memory_limit_mb: 2048,
          memory_prealloc_mb: 512,
          merge_read_max_usecs: 100,
          merge_read_wait_usecs: 10,
          merge_write_max_usecs: 200,
          merge_write_wait_usecs: 20,
        }),
      ).toEqual({
        memory_limit: 2048,
        memory_prealloc: 512,
        merge_read_max: 100,
        merge_read_wait: 10,
        merge_write_max: 200,
        merge_write_wait: 20,
      });
    });

    it('accepts the unsuffixed spelling too (gRPC request / fake write-back)', () => {
      expect(tuning({ memory_limit: 2048, merge_read_max: 100 })).toEqual({
        memory_limit: 2048,
        merge_read_max: 100,
      });
    });

    it('carries the priorities, limits and CPU mask straight through', () => {
      expect(
        tuning({
          init_prio: 100,
          recon_prio: 80,
          restripe_prio: 20,
          sdc_prio: 10,
          request_limit: 0,
          max_sectors_kb: 512,
          cpu_allowed: '0-7',
        }),
      ).toEqual({
        init_prio: 100,
        recon_prio: 80,
        restripe_prio: 20,
        sdc_prio: 10,
        request_limit: 0,
        max_sectors_kb: 512,
        cpu_allowed: '0-7',
      });
    });

    it("coerces xiRAID's 0/1 flags to booleans", () => {
      expect(
        tuning({
          sched_enabled: 1,
          merge_read_enabled: 0,
          merge_write_enabled: '1',
          adaptive_merge: '0',
          single_run: true,
          discard: 1,
        }),
      ).toEqual({
        sched_enabled: true,
        merge_read_enabled: false,
        merge_write_enabled: true,
        adaptive_merge: false,
        single_run: true,
        discard: true,
      });
    });

    // The daemon spells the create flag's `--discard` as `discard_allowed` on
    // the show surface. Reading the create spelling is why the TUI's TRIM /
    // Discard block printed "unknown" on every array of every build.
    it('reads discard from the daemon spelling, discard_allowed', () => {
      expect(tuning({ discard_allowed: 1 })).toEqual({ discard: true });
      expect(tuning({ discard_allowed: 0 })).toEqual({ discard: false });
    });

    // `drive_trim` TRIMs the member disks BEFORE the array exists: an action,
    // not array state, so no raid_show will ever report it. Observing the key
    // would promise a value that can never arrive.
    it('never observes drive_trim, even if the payload carries the name', () => {
      expect(tuning({ drive_trim: 1 })).toBeUndefined();
      expect(tuning({ discard_allowed: 1, drive_trim: 1 })).toEqual({ discard: true });
    });

    it('leaves discard absent when the daemon reports no discard key', () => {
      expect(tuning({ init_prio: 50 })).toEqual({ init_prio: 50 });
    });

    it('coerces numeric strings to numbers', () => {
      expect(tuning({ memory_limit_mb: '2048', init_prio: '100' })).toEqual({
        memory_limit: 2048,
        init_prio: 100,
      });
    });

    it('an empty cpu_allowed is an OBSERVED value ("all"), not an absent one', () => {
      expect(tuning({ cpu_allowed: '' })).toEqual({ cpu_allowed: '' });
    });

    // The real xiRAID 4.3.x daemon reports the affinity as an ARRAY of core
    // ids; only the fake transport writes the string back. Reading it as a
    // string dropped the knob, and every client rendered a pinned array's
    // affinity as "unknown" while the array really was pinned.
    it('renders the daemon array shape of cpu_allowed as a CPU list', () => {
      expect(tuning({ cpu_allowed: [5, 6, 7] })).toEqual({ cpu_allowed: '5-7' });
    });

    it('range-compresses cpu_allowed the way cpulist and xicli write it', () => {
      expect(tuning({ cpu_allowed: [0, 2, 4, 5, 6] })).toEqual({ cpu_allowed: '0,2,4-6' });
      expect(tuning({ cpu_allowed: [3] })).toEqual({ cpu_allowed: '3' });
      expect(tuning({ cpu_allowed: [1, 3, 5] })).toEqual({ cpu_allowed: '1,3,5' });
    });

    it('sorts and de-duplicates the reported core ids', () => {
      expect(tuning({ cpu_allowed: [7, 5, 6, 5] })).toEqual({ cpu_allowed: '5-7' });
    });

    it('renders an empty cpu_allowed array as the observed "all"', () => {
      expect(tuning({ cpu_allowed: [] })).toEqual({ cpu_allowed: '' });
    });

    it('accepts the numeric strings the daemon sometimes emits in the array', () => {
      expect(tuning({ cpu_allowed: ['5', '6', '7'] })).toEqual({ cpu_allowed: '5-7' });
    });

    it('drops a cpu_allowed array that is not a clean set of core ids', () => {
      // Guessing at a malformed affinity misreports which cores an array is
      // pinned to; absent renders as "unknown", which is honest.
      expect(tuning({ cpu_allowed: [5, 'six'], init_prio: 50 })).toEqual({ init_prio: 50 });
      expect(tuning({ cpu_allowed: [-1], init_prio: 50 })).toEqual({ init_prio: 50 });
      expect(tuning({ cpu_allowed: [1.5], init_prio: 50 })).toEqual({ init_prio: 50 });
    });

    it('parses the exact live payload of a pinned array end to end', () => {
      // Verbatim from `xicli raid show -e -n data --format json` on a node
      // whose array is pinned to cores 5-7.
      const parsed = parseRaidShow(
        [
          {
            name: 'data',
            level: '5',
            devices: [[0, '/dev/nvme10n2', ['online']]],
            state: ['online', 'initialized'],
            cpu_allowed: [5, 6, 7],
            init_prio: 50,
            sdc_prio: 50,
            memory_limit_mb: 5000,
            sched_enabled: 1,
          },
        ],
        DISK_IDS,
      )[0];
      expect(parsed?.spec.tuning?.cpu_allowed).toBe('5-7');
    });

    it('omits keys the daemon does not emit, and unreadable values', () => {
      expect(
        tuning({
          memory_limit_mb: 2048,
          init_prio: null,
          recon_prio: 'high',
          sched_enabled: 'yes',
          cpu_allowed: 7,
        }),
      ).toEqual({ memory_limit: 2048 });
    });

    it('omits tuning entirely when nothing was observed (no --extended)', () => {
      // The exact live shape: raid_show WITHOUT extended:true reports no
      // tuning at all. spec.tuning must be absent, so every client renders
      // the knobs as unknown instead of as a plausible default.
      expect(tuning({ strip_size: 64, block_size: 4096 })).toBeUndefined();
    });

    it('status.memory_usage_mb is observed separately from the limit', () => {
      const status = (extra: Record<string, unknown>) =>
        parseRaidShow(
          [{ name: 'data', level: '5', devices: [], state: ['online'], ...extra }],
          DISK_IDS,
        )[0]?.status;

      expect(status({ memory_usage_mb: 0 })?.memory_usage_mb).toBe(0);
      expect(status({ memory_usage_mb: '64' })?.memory_usage_mb).toBe(64);
      expect(status({})).not.toHaveProperty('memory_usage_mb');
    });

    // Configured (`discard_allowed` → spec.tuning.discard) is not the same as
    // in effect (`discard_active`). On a live 4.4.0 node the initializing
    // `data` array reads allowed=1 active=0 while `log` reads 1/1, so a
    // screen showing only the configured value claims TRIM reaches the media
    // when it does not.
    it('status.discard_active is observed separately from tuning.discard', () => {
      const array = (extra: Record<string, unknown>) =>
        parseRaidShow(
          [{ name: 'data', level: '5', devices: [], state: ['online'], ...extra }],
          DISK_IDS,
        )[0];

      const initing = array({ discard_allowed: 1, discard_active: 0 });
      expect(initing?.spec.tuning).toEqual({ discard: true });
      expect(initing?.status.discard_active).toBe(false);

      expect(array({ discard_allowed: 1, discard_active: 1 })?.status.discard_active).toBe(true);
      expect(array({ discard_active: '1' })?.status.discard_active).toBe(true);
      expect(array({})?.status).not.toHaveProperty('discard_active');
    });
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
          sparepool: 'sp_data',
        },
      ],
      DISK_IDS,
      [{ name: 'sp_data', drives: ['/dev/nvme3n1', '/dev/unknown9'] }],
    );
    expect(a?.spec.spare_disk_ids).toEqual(['disk-3', '/dev/unknown9']); // raw-path fallback
  });

  it('maps the sparepool through a dict-keyed pool_show payload (real daemon shape)', () => {
    const [a] = parseRaidShow(
      [
        {
          name: 'data',
          level: '6',
          devices: ['/dev/nvme1n1'],
          state: ['online'],
          sparepool: 'sp_data',
        },
      ],
      DISK_IDS,
      { sp_data: { drives: ['/dev/nvme3n1'], state: 'active' } },
    );
    expect(a?.spec.spare_disk_ids).toEqual(['disk-3']);
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

  // ---- 2026-08-29 design: spec.spare_pool carries the pool NAME (observed) ----

  it('reports the array sparepool name in spec.spare_pool', () => {
    const rows = parseRaidShow(
      { data: { name: 'data', level: '5', devices: [], sparepool: 'sp01' } },
      new Map(),
      [{ name: 'sp01', drives: ['/dev/nvme5n2'], active: true }],
    );
    expect(rows[0]?.spec.spare_pool).toBe('sp01');
    expect(rows[0]?.status.spare_pool).toBe('sp01');
  });

  it('omits spec.spare_pool when the array has no pool', () => {
    const rows = parseRaidShow(
      { data: { name: 'data', level: '5', devices: [], sparepool: '-' } },
      new Map(),
      [],
    );
    expect(rows[0]?.spec.spare_pool).toBeUndefined();
  });

  it('normalizes the real xiRAID daemon shape (object keyed by name, tuple devices)', () => {
    // The live xiRAID 4.3.x daemon returns raid_show as an object keyed by
    // array name ({"data":{...},"log":{...}}) with devices as
    // [index, path, [states]] tuples — NOT the flat array of string-device
    // objects the fake transport emits. Both must parse.
    const arrays = parseRaidShow(
      {
        data: {
          level: '5',
          devices: [
            [0, '/dev/nvme1n1', ['online']],
            [1, '/dev/nvme2n1', ['online']],
          ],
          state: ['online', 'initing'],
          init_progress: 30,
        },
        log: {
          level: '10',
          devices: [[0, '/dev/nvme3n1', ['online']]],
          state: ['online'],
        },
      },
      DISK_IDS,
    );
    expect(arrays).toHaveLength(2);
    const byId = Object.fromEntries(arrays.map((a) => [a.id, a]));
    // the map key becomes the array name; tuple devices resolve to disk ids
    expect(byId.data).toMatchObject({
      id: 'data',
      spec: { name: 'data', level: 'raid5', member_disk_ids: ['disk-1', 'disk-2'] },
      status: { state: 'rebuilding', rebuild_progress_pct: 30 },
    });
    expect(byId.log).toMatchObject({
      id: 'log',
      spec: { name: 'log', level: 'raid10', member_disk_ids: ['disk-3'] },
      status: { state: 'optimal' },
    });
  });

  it('reads members from the per-device OBJECT shape too', () => {
    // The gRPC reference documents devices as objects; the live 4.3.x daemon
    // emits tuples. Asking for the extended payload must not be able to turn
    // a populated array into a member-less one just because the daemon
    // switched shapes — a zero-member array reads as "those drives are free".
    const [a] = parseRaidShow(
      [
        {
          name: 'data',
          level: '6',
          state: ['online'],
          devices: [
            { path: '/dev/nvme1n1', serial: 'S1', state: 'active' },
            { device: '/dev/nvme2n1' },
            { name: '/dev/nvme3n1' },
          ],
        },
      ],
      DISK_IDS,
    );
    expect(a?.spec.member_disk_ids).toEqual(['disk-1', 'disk-2', 'disk-3']);
  });

  describe('status.member_states (per-member observation)', () => {
    it('populates member_states from tuple devices — index, mapped id, states', () => {
      const status = parseRaidShow(
        {
          data: {
            level: '5',
            devices: [
              [0, '/dev/nvme1n1', ['online']],
              [1, '/dev/nvme2n1', ['degraded']],
            ],
            state: ['online', 'degraded'],
          },
        },
        DISK_IDS,
      )[0]?.status;
      expect(status?.member_states).toEqual([
        { index: 0, device: 'disk-1', states: ['online'] },
        { index: 1, device: 'disk-2', states: ['degraded'] },
      ]);
    });

    it('reads member states from the per-device object shape (path/device + state)', () => {
      const status = parseRaidShow(
        [
          {
            name: 'data',
            level: '5',
            devices: [
              { path: '/dev/nvme1n1', state: 'online' },
              { device: '/dev/nvme2n1', state: ['offline'] },
            ],
            state: ['degraded'],
          },
        ],
        DISK_IDS,
      )[0]?.status;
      expect(status?.member_states).toEqual([
        { index: 0, device: 'disk-1', states: ['online'] },
        { index: 1, device: 'disk-2', states: ['offline'] },
      ]);
    });

    it('bare-string devices → member_states entries with empty states (fake transport)', () => {
      const status = parseRaidShow(
        [
          {
            name: 'data',
            level: '5',
            devices: ['/dev/nvme1n1', '/dev/nvme2n1'],
            state: ['online'],
          },
        ],
        DISK_IDS,
      )[0]?.status;
      expect(status?.member_states).toEqual([
        { index: 0, device: 'disk-1', states: [] },
        { index: 1, device: 'disk-2', states: [] },
      ]);
    });

    it('member_states align with member_disk_ids; unknown path falls back to the raw path', () => {
      const array = parseRaidShow(
        [
          {
            name: 'data',
            level: '5',
            devices: [
              [0, '/dev/nvme1n1', ['online']],
              [1, '/dev/unknownX', ['online']],
            ],
            state: ['online'],
          },
        ],
        DISK_IDS,
      )[0];
      expect(array?.spec.member_disk_ids).toEqual(['disk-1', '/dev/unknownX']);
      expect(array?.status.member_states).toEqual([
        { index: 0, device: 'disk-1', states: ['online'] },
        { index: 1, device: '/dev/unknownX', states: ['online'] },
      ]);
    });

    it('drops path-less device entries so member_states stays aligned', () => {
      const array = parseRaidShow(
        [
          {
            name: 'data',
            level: '5',
            devices: [
              [0, '/dev/nvme1n1', ['online']],
              [1, null, ['offline']],
            ],
            state: ['degraded'],
          },
        ],
        DISK_IDS,
      )[0];
      expect(array?.spec.member_disk_ids).toEqual(['disk-1']);
      expect(array?.status.member_states).toEqual([
        { index: 0, device: 'disk-1', states: ['online'] },
      ]);
    });
  });
});

// The daemon spells "this array has no spare pool" as the STRING "-", not as
// an empty string or a missing key. Verified on a live node (xicli 4.4.0,
// driver 4.4.0-43861): both arrays report `"sparepool": "-"` with no pools
// configured at all. Treating it as a name publishes a reference to a pool
// that cannot exist, and — worse — makes the modify executor's foreign-pool
// guard reject every array that has no spare pool.
describe('sparepool sentinel', () => {
  const arr = (sparepool: unknown) =>
    parseRaidShow(
      [{ name: 'a', level: '5', devices: [], state: ['online'], sparepool }],
      DISK_IDS,
    )[0];

  it('"-" means no spare pool, not a pool named "-"', () => {
    const a = arr('-');
    expect(a?.status.spare_pool).toBeUndefined();
    expect(a?.spec.spare_disk_ids).toEqual([]);
  });

  it('an empty string and a missing key mean the same thing', () => {
    expect(arr('')?.status.spare_pool).toBeUndefined();
    expect(arr(undefined)?.status.spare_pool).toBeUndefined();
  });

  it('a real pool name still comes through', () => {
    expect(arr('sp_a')?.status.spare_pool).toBe('sp_a');
  });
});
