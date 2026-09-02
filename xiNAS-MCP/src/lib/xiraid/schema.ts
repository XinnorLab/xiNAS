/**
 * Canonical XiraidArray writable-spec types + constraint tables
 * (ADR-0006 §Schema / §Phase 0 writability matrix).
 *
 * Single home for array logic shared by the api plan provider and the
 * agent executor (the ADR-0005 no-duplication rule). Pure data — no I/O.
 *
 * Constraint sources: xiraid-analysis/api_behavior_doc.md §3.4 (param
 * ranges, group_size 2-32 required for 50/60/70, synd_cnt 4-32 for n+m,
 * >= 2 groups for compound levels) + the engine-enforced per-level drive
 * minimums in docs/Storage/raid-management-spec.md §4.
 */

export const LEVELS = [
  'raid0',
  'raid1',
  'raid5',
  'raid6',
  'raid7',
  'raid10',
  'raid50',
  'raid60',
  'raid70',
  'n+m',
] as const;
export type Level = (typeof LEVELS)[number];

/** Approved Phase-0 tuning surface (ADR-0006; `force` deliberately absent). */
export interface Tuning {
  init_prio?: number | null;
  recon_prio?: number | null;
  restripe_prio?: number | null;
  resync_enabled?: boolean | null;
  sched_enabled?: boolean | null;
  merge_read_enabled?: boolean | null;
  merge_write_enabled?: boolean | null;
  merge_read_max?: number | null;
  merge_read_wait?: number | null;
  merge_write_max?: number | null;
  merge_write_wait?: number | null;
  memory_limit?: number | null;
  request_limit?: number | null;
  memory_prealloc?: number | null;
  adaptive_merge?: boolean | null;
  cpu_allowed?: string | null;
  max_sectors_kb?: number | null;
  sdc_prio?: number | null;
  single_run?: boolean | null;
  discard?: boolean | null;
  drive_trim?: boolean | null;
}

export interface XiraidArraySpec {
  name: string;
  level: Level;
  member_disk_ids: string[];
  /** OBSERVED ONLY — the spare pool's drives as Disk ids. Rejected on write. */
  spare_disk_ids?: string[];
  /** Name of an EXISTING spare pool; null on modify detaches. */
  spare_pool?: string | null;
  group_size?: number | null;
  synd_cnt?: number | null;
  strip_size_kib?: number | null;
  block_size?: number | null;
  force_metadata?: boolean;
  tuning?: Tuning;
}

export interface LevelConstraints {
  minDrives: number;
  needsGroupSize: boolean;
  needsSyndCnt: boolean;
  /** AG: raid10's "the number of drives must be even". Only raid10 carries it. */
  evenMembers?: boolean;
  /** Per-level group_size floor; defaults to GROUP_SIZE_MIN when absent. */
  groupSizeMin?: number;
}

/**
 * Minimum drive counts are xiRAID's, published per level in the
 * Administrator's Guide "RAIDs explained" page (xiRAID Classic 4.4.0):
 * https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/xiraid_raids_explained.html
 *
 * They are NOT textbook RAID minimums. An earlier pass sourced them from the
 * engine's rejection messages and got raid7, raid70 and n+m too LOW (4, 8, 4
 * against the published 6, 12, 8), so a spec under the engine's floor produced
 * no `min_drives` blocker and failed later at `raid_create` instead. Keep them
 * >= the AG numbers; a stricter xiNAS floor is fine, a looser one is a bug.
 *
 * raid10 is one such deliberate stricter floor: AG allows 2 (even), xiNAS
 * requires 4. AG's other per-level rules ride this table too — `evenMembers`
 * for raid10, `groupSizeMin` for raid70.
 *
 * docs/Storage/raid-management-spec.md §4 owns the table; the TUI Create Array
 * wizard (`_RAID_MIN_DRIVES` in xinas_menu/screens/raid.py) and the installer
 * (`nvme_raid_min_devices` in collection/roles/nvme_namespace/defaults/main.yml)
 * carry the same values for the levels they offer. Changing one without the
 * others is review finding #4.
 */
export const LEVEL_CONSTRAINTS: Record<Level, LevelConstraints> = {
  raid0: { minDrives: 1, needsGroupSize: false, needsSyndCnt: false },
  raid1: { minDrives: 2, needsGroupSize: false, needsSyndCnt: false },
  raid5: { minDrives: 4, needsGroupSize: false, needsSyndCnt: false },
  raid6: { minDrives: 4, needsGroupSize: false, needsSyndCnt: false },
  raid7: { minDrives: 6, needsGroupSize: false, needsSyndCnt: false },
  raid10: { minDrives: 4, needsGroupSize: false, needsSyndCnt: false, evenMembers: true },
  raid50: { minDrives: 8, needsGroupSize: true, needsSyndCnt: false },
  raid60: { minDrives: 8, needsGroupSize: true, needsSyndCnt: false },
  raid70: { minDrives: 12, needsGroupSize: true, needsSyndCnt: false, groupSizeMin: 6 },
  'n+m': { minDrives: 8, needsGroupSize: false, needsSyndCnt: true },
};

export const STRIP_SIZES_KIB = [16, 32, 64, 128, 256] as const;
export const BLOCK_SIZES = [512, 4096] as const;
/**
 * xiRAID Classic 4.4 rule for `xicli raid create -n/--name`, per the command
 * reference (https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html): at most 28
 * characters of Latin letters, digits and underscore. Hyphens are NOT accepted.
 * Was `^[A-Za-z0-9_-]{1,63}$` — hyphens are not valid and the cap was more than
 * twice the documented limit. See docs/Storage/raid-management-spec.md §4.
 */
export const NAME_RE = /^[A-Za-z0-9_]{1,28}$/;

/**
 * Names xiRAID prohibits outright (same reference) — they collide with the
 * sysfs attributes under /sys/block/xi_<name>/, which are lowercase, so the
 * match is exact.
 */
export const RESERVED_NAMES: readonly string[] = ['power', 'uevent'];

/**
 * The device-path prefix of a xiRAID array volume. `xicli raid create -n
 * <name>` surfaces the array at `/dev/xi_<name>` with its sysfs attributes
 * under `/sys/block/xi_<name>/` (CR / `xicli raid`, xiRAID Classic 4.4.0 —
 * https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html), which is the same
 * naming contract {@link NAME_RE} enforces from the other end. Already the
 * identity rule in `parse/raid.ts` (volume_path), `lib/fs/unit.ts` (.device
 * unit) and the NFS executor's xiRAID-backing gate.
 */
export const XIRAID_VOLUME_PREFIX = '/dev/xi_';

/**
 * True when `devicePath` names a xiRAID array volume rather than a drive.
 *
 * `lsblk` reports these with `TYPE=disk`, so they become `Disk` rows, and an
 * array used as an XFS EXTERNAL JOURNAL (`-o logdev=/dev/xi_log`) carries no
 * mountpoint of its own — it therefore reads `system_disk:false`,
 * `mounted:false`, `safe_for_use:true`, and it is a member of no array
 * because it IS one. Every surface that consumes drives must reject it on
 * this test alone: the test is structural, so it still holds when the owning
 * array is missing from observed state — precisely when a volume-path lookup
 * fails open. See docs/control-path/s3-xiraid-array-spec.md §4.1.
 *
 * Deliberately NOT folded into `safe_for_use`: that field is contract-typed
 * in api-v1.yaml as `!system_disk && !mounted`, and `GET /disks` stays an
 * honest inventory of what the host reports.
 */
export function isXiraidVolumePath(devicePath: string): boolean {
  return devicePath.startsWith(XIRAID_VOLUME_PREFIX);
}

/** `/dev/xi_log` -> `log`; `''` when the path is not an array volume. */
export function xiraidVolumeArrayName(devicePath: string): string {
  return isXiraidVolumePath(devicePath) ? devicePath.slice(XIRAID_VOLUME_PREFIX.length) : '';
}

/**
 * group_size range per the 4.4.0 command reference: 4-32. Was 2-32, taken from
 * the internal source-tree analysis. The Administrator's Guide is stricter
 * still per level (>= 4 for raid50/60, >= 6 for raid70); only the generic
 * range is enforced here.
 */
export const GROUP_SIZE_MIN = 4;
export const GROUP_SIZE_MAX = 32;
export const SYND_CNT_MIN = 4;
export const SYND_CNT_MAX = 32;
/**
 * Priority floors differ per surface in the 4.4 command reference, and the
 * difference is not cosmetic: `xicli raid create` gives `--init_prio` and
 * `--restripe_prio` as "from 1 to 100", while `xicli raid modify` gives both as
 * "from 0 to 100". `--recon_prio` and `--sdc_prio` are "from 1 to 100" on both.
 * Enforcing the create floor on a modify rejects a value xicli accepts.
 */
export const PRIO_MIN = 1;
export const PRIO_MIN_MODIFY = 0;
export const PRIO_MAX = 100;
/** CR 4.4, every merge knob: "integers from 1 to 100000" (microseconds). */
export const MERGE_USEC_MIN = 1;
export const MERGE_USEC_MAX = 100_000;
/** CR 4.4 `--request_limit`: "integers from 0 to 4294967295"; 0 = unlimited. */
export const REQUEST_LIMIT_MIN = 0;
export const REQUEST_LIMIT_MAX = 4_294_967_295;
export const MEMORY_LIMIT_MIN = 1024;
export const MEMORY_LIMIT_MAX = 1048576;
export const MEMORY_PREALLOC_MIN = 1024;
export const MEMORY_PREALLOC_MAX = 65536;
export const MAX_SECTORS_KB_MIN = 4;
export const MAX_SECTORS_KB_MAX = 4096;
