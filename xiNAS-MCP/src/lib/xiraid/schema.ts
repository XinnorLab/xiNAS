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
  spare_disk_ids?: string[];
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
}

/**
 * `minDrives` is what the **engine** enforces, not textbook RAID math: xiRAID
 * Classic rejects RAID 5 under 4 drives (`Error: To create RAID level '5', a
 * minimum of '4' disks are required.`) and RAID 50/60 under 8. The numbers were
 * read off those rejection messages on xiRAID Classic 4.4 — `xicli raid create
 * --help` does not document them — so they are version-specific and must be
 * re-confirmed when the engine version moves.
 *
 * docs/Storage/raid-management-spec.md §4 owns the table; the TUI Create Array
 * wizard (`_RAID_MIN_DRIVES` in xinas_menu/screens/raid.py) and the installer
 * (`nvme_raid_min_devices` in collection/roles/nvme_namespace/defaults/main.yml)
 * carry the same values. Changing one without the others is review finding #4.
 */
export const LEVEL_CONSTRAINTS: Record<Level, LevelConstraints> = {
  raid0: { minDrives: 2, needsGroupSize: false, needsSyndCnt: false },
  raid1: { minDrives: 2, needsGroupSize: false, needsSyndCnt: false },
  raid5: { minDrives: 4, needsGroupSize: false, needsSyndCnt: false },
  raid6: { minDrives: 4, needsGroupSize: false, needsSyndCnt: false },
  raid7: { minDrives: 4, needsGroupSize: false, needsSyndCnt: false },
  raid10: { minDrives: 4, needsGroupSize: false, needsSyndCnt: false },
  raid50: { minDrives: 8, needsGroupSize: true, needsSyndCnt: false },
  raid60: { minDrives: 8, needsGroupSize: true, needsSyndCnt: false },
  raid70: { minDrives: 8, needsGroupSize: true, needsSyndCnt: false },
  'n+m': { minDrives: 4, needsGroupSize: false, needsSyndCnt: true },
};

export const STRIP_SIZES_KIB = [16, 32, 64, 128, 256] as const;
export const BLOCK_SIZES = [512, 4096] as const;
export const NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;

export const GROUP_SIZE_MIN = 2;
export const GROUP_SIZE_MAX = 32;
export const SYND_CNT_MIN = 4;
export const SYND_CNT_MAX = 32;
export const PRIO_MIN = 1;
export const PRIO_MAX = 100;
export const MEMORY_LIMIT_MIN = 1024;
export const MEMORY_LIMIT_MAX = 1048576;
export const MEMORY_PREALLOC_MIN = 1024;
export const MEMORY_PREALLOC_MAX = 65536;
export const MAX_SECTORS_KB_MIN = 4;
export const MAX_SECTORS_KB_MAX = 4096;
