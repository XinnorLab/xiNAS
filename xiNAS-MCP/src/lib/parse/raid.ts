/**
 * Pure mapper: parsed xiRAID `raid_show` payload → observed XiraidArray
 * objects (api-v1.yaml schema, S3 T6).
 *
 * The daemon returns a JSON array of per-array objects (analyst doc §2:
 * "Returns JSON array of RAID info"). Field names vary slightly across
 * xiRAID releases, so the mapper is deliberately tolerant: it reads the
 * shape the fake transport + xicli emit (name/level/devices/state/
 * strip_size/...) with fallbacks, skips entries without a usable name,
 * and maps anything unrecognized to state 'unknown' rather than guessing.
 *
 * observed_at is NOT stamped here — the collector adds it (parser stays
 * clock-free, like parse/disk.ts).
 *
 * `parseRaidShowEntries` is the shape-normalizing half, exported so the task
 * executors read raid_show through the same tolerant reader.
 */

import { parsePoolShow } from './pool.js';

/** ADR-0006 `spec.tuning`, as OBSERVED — only keys the daemon emitted. */
export type ObservedTuning = Partial<Record<string, number | boolean | string>>;

export interface ObservedXiraidArray {
  kind: 'XiraidArray';
  id: string;
  spec: {
    name: string;
    level: string;
    member_disk_ids: string[];
    spare_disk_ids: string[];
    /** Design 2026-08-29: the pool's name, so a GET -> PATCH round-trip is closed. */
    spare_pool?: string;
    strip_size_kib?: number;
    block_size?: number;
    group_size?: number;
    tuning?: ObservedTuning;
  };
  status: {
    state: 'optimal' | 'degraded' | 'rebuilding' | 'failed' | 'importing' | 'unknown';
    volume_path: string;
    /** S9 (ADR-0011): the raw sparepool NAME — drives Pool.referenced_by. */
    spare_pool?: string;
    rebuild_progress_pct: number | null;
    check_progress_pct: number | null;
    usable_capacity_bytes?: number;
    memory_usage_mb?: number;
    /**
     * `discard_active`: the array is processing discard requests right now.
     * Observation with no write surface, which is why it lives here and not
     * under `spec.tuning` next to `discard` (`discard_allowed`, what the array
     * is CONFIGURED to accept). The two diverge in practice.
     */
    discard_active?: boolean;
    member_states: Array<Record<string, unknown>>;
  };
}

/**
 * The daemon's state words → the control-path `status.state` enum.
 *
 * The vocabulary is the vendor's, published in full on AG 4.4 "Showing RAID
 * State" (https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html).
 * The sets below cover EVERY word on that page plus the older/alternate
 * spellings earlier daemons emitted; a word that reaches none of them becomes
 * `unknown`, which for a real state is a reporting failure, not caution — an
 * array that cannot finish reconstruction must not be published to the TUI,
 * MCP and CLI as an unremarkable "unknown".
 *
 * `state` is a LIST of words, and the buckets are checked worst-first, so one
 * bad word outranks any number of good ones.
 */
const FAILED_STATES = new Set([
  'offline', // "the RAID is unavailable […] or the number of available drives […] is insufficient"
  'none', // "RAID was unloaded via the unload command or was not restored after reboot"
  'unrecovered', // "RAID can't complete reconstruction because of unrecoverable sections"
  // Spellings not on the 4.4 page, kept for older/alternate daemon builds.
  'broken',
  'unusable',
  'faulty',
  'failed',
]);
const REBUILDING_STATES = new Set([
  'initing', // "the RAID is initializing"
  'reconstructing', // "the RAID is reconstructing"
  'restriping', // "RAID is restriping"
  // Alternate spellings.
  'initializing',
  'init',
  'recon',
  'resyncing',
]);
const DEGRADED_STATES = new Set([
  'degraded', // "available and ready for work but some drives are missing or failed"
  'need_recon', // "the RAID needs reconstruction"
  'need_init', // "the RAID needs initialization" — parity is not valid, so no redundancy
  'inconsistent', // "an intengrity error was detected during an SDC scan" [sic]
  'read_only', // "the license has expired. The RAID is read-only" — available, impaired
  // Alternate spelling.
  'need_resync',
]);
/**
 * Words that are deliberately in NO bucket, so they never downgrade a verdict:
 * `initialized` ("initialization is finished"), `online`, `sdc_scanning` (a
 * scan an online array runs), `need_resize` ("restriping was finished, the
 * RAID size increase is available") and `need_restripe` ("restriping was
 * stopped and not finished"). All three of the latter describe an array that
 * still has its redundancy; an operator learns about them from the raw state
 * list the TUI prints, not from a colour that says the array is in trouble.
 */

/**
 * The array's spare-pool NAME, or `''` when it has none.
 *
 * The daemon spells "no spare pool" as the STRING `"-"`, not as an empty
 * string and not by omitting the key. Verified on a live node (`xicli 4.4.0`,
 * driver `4.4.0-43861`): both arrays report `"sparepool": "-"` with no pools
 * configured at all.
 *
 * Every consumer must read the field through here. Treating `"-"` as a name
 * is not cosmetic — the array executors compare the live sparepool NAME
 * against the target pool name to decide whether an attach/detach is a
 * no-op, and a literal `"-"` would never equal `''` or an operator's pool
 * name, so every array on a fresh install would look permanently "changed".
 */
export function readSparepoolName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name === '' || name === '-' ? '' : name;
}

/** Tolerant read of the pool_show payload: name + member drives. */
function readPools(pools: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pool of parsePoolShow(pools)) out.set(pool.name, pool.drives);
  return out;
}

/** One member of an array, read out of a raid_show `devices` entry. */
export interface RaidShowMember {
  /** Member index the daemon reports (tuple `[0]` / object `index`), else position. */
  index: number;
  /** Member /dev path — always present (path-less entries are dropped). */
  device: string;
  /** Lower-cased per-member state words; `[]` when the daemon reported none. */
  states: string[];
}

/** `readMember`'s pre-filter result: `device` may be null (dropped downstream). */
interface RawMember {
  index: number;
  device: string | null;
  states: string[];
}

/** One array as raid_show describes it, with both payload shapes flattened. */
export interface RaidShowEntry {
  name: string;
  /** Member device paths, tuple/object entries unwrapped. */
  devices: string[];
  /** Per-member records (index/device/states), aligned with `devices`. */
  members: RaidShowMember[];
  /** Lower-cased state words. */
  states: string[];
  /** The remaining daemon fields (level, strip_size, sparepool, …). */
  raw: Record<string, unknown>;
}

/**
 * Normalize a raid_show payload to a flat entry list.
 *
 * xiRAID's raid_show returns EITHER a JSON array of per-array objects OR an
 * object keyed by array name ({"data":{...},"log":{...}}) — the latter on the
 * real xiRAID 4.3.x daemon (the fake transport emits an array). The map key is
 * injected as `name` when a keyed value lacks one; otherwise real arrays are
 * silently dropped and every caller reads a live array as absent.
 *
 * Every consumer of raid_show — the collector AND the task executors — must go
 * through here. A second, array-only reader is how #243 shipped a fix that left
 * the executors blind to real arrays.
 */
export function parseRaidShowEntries(payload: unknown): RaidShowEntry[] {
  let entries: unknown[];
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload !== null && typeof payload === 'object') {
    entries = Object.entries(payload as Record<string, unknown>).map(([name, info]) =>
      info !== null && typeof info === 'object' && !Array.isArray(info)
        ? { name, ...(info as Record<string, unknown>) }
        : info,
    );
  } else {
    return [];
  }

  const out: RaidShowEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.name !== 'string' || o.name.length === 0) continue;

    // devices is ["/dev/..."] (fake transport), [[index, "/dev/...",
    // [states]], ...] tuples (the real xiRAID 4.3.x daemon), or
    // [{path|device|name: "/dev/..."}, ...] (the per-device object shape the
    // gRPC reference documents). `readMember` reads the path (via
    // `devicePath`) plus the per-member index/state from all three; entries
    // with no readable path are dropped, so `devices` and `members` stay
    // aligned with member_disk_ids. A zero-member array reads as "these
    // drives are free" to the create wizard's claimed-disk check.
    const members: RaidShowMember[] = (
      Array.isArray(o.devices) ? o.devices.map(readMember) : []
    ).filter((m): m is RaidShowMember => m.device !== null);
    const devices = members.map((m) => m.device);

    out.push({ name: o.name, devices, members, states: normalizeStates(o.state), raw: o });
  }
  return out;
}

export function parseRaidShow(
  payload: unknown,
  diskIdByPath: ReadonlyMap<string, string>,
  pools?: unknown,
): ObservedXiraidArray[] {
  const poolDrives = readPools(pools);
  const out: ObservedXiraidArray[] = [];
  for (const { name, devices, members, states, raw: o } of parseRaidShowEntries(payload)) {
    const reconProgress = numberOrNull(o.recon_progress) ?? numberOrNull(o.init_progress);
    // S4 T5: the array's sparepool NAME (raid_show) joins to its member
    // DRIVES (pool_show) → control-path disk ids. Absent/unknown → [].
    const sparepool = readSparepoolName(o.sparepool);
    const spareDrives = sparepool !== '' ? (poolDrives.get(sparepool) ?? []) : [];
    const capacityBytes = sizeToBytes(o.size);
    const tuning = readTuning(o);
    const memoryUsage = coerceNumber(o.memory_usage_mb ?? o.memory_usage);
    const discardActive = coerceBoolean(o.discard_active);

    out.push({
      kind: 'XiraidArray',
      id: name,
      spec: {
        name,
        level: normalizeLevel(o.level),
        member_disk_ids: devices.map((d) => diskIdByPath.get(d) ?? d),
        spare_disk_ids: spareDrives.map((d) => diskIdByPath.get(d) ?? d),
        ...(sparepool !== '' ? { spare_pool: sparepool } : {}),
        ...(numberOrNull(o.strip_size) !== null ? { strip_size_kib: o.strip_size as number } : {}),
        ...(numberOrNull(o.block_size) !== null ? { block_size: o.block_size as number } : {}),
        ...(numberOrNull(o.group_size) !== null ? { group_size: o.group_size as number } : {}),
        ...(tuning !== null ? { tuning } : {}),
      },
      status: {
        state: deriveState(states),
        volume_path: `/dev/xi_${name}`,
        ...(sparepool !== '' ? { spare_pool: sparepool } : {}),
        rebuild_progress_pct: reconProgress,
        check_progress_pct: null,
        ...(capacityBytes !== null ? { usable_capacity_bytes: capacityBytes } : {}),
        ...(memoryUsage !== null ? { memory_usage_mb: memoryUsage } : {}),
        ...(discardActive !== null ? { discard_active: discardActive } : {}),
        // Per-member observation: `device` in the same control-path Disk
        // identity as member_disk_ids, so a client correlates the two by id.
        member_states: members.map((m) => ({
          index: m.index,
          device: diskIdByPath.get(m.device) ?? m.device,
          states: m.states,
        })),
      },
    });
  }
  return out;
}

/** One raid_show `devices` entry → its /dev path, across all three shapes. */
function devicePath(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return typeof entry[1] === 'string' ? entry[1] : null;
  if (entry === null || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  for (const key of ['path', 'device', 'device_path', 'name']) {
    const value = o[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function normalizeStates(state: unknown): string[] {
  if (typeof state === 'string') return [state.toLowerCase()];
  if (Array.isArray(state)) {
    return state.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase());
  }
  return [];
}

/**
 * One raid_show `devices` entry → its member record, across the three shapes
 * the daemon and adapters emit:
 *   - `"/dev/nvme1n1"` — bare path (fake transport / xicli), no per-member state.
 *   - `[index, "/dev/nvme1n1", ["online"]]` — the real xiRAID 4.3.x tuple.
 *   - `{ path|device|device_path|name, state|states, index? }` — the gRPC
 *     reference's per-device object.
 * The path comes from the shared `devicePath` (so path extraction has one
 * home); this adds the per-member index and states. `device` is null when the
 * entry carries no readable path — the caller drops those so the member list
 * stays aligned with `member_disk_ids`.
 */
function readMember(entry: unknown, position: number): RawMember {
  const device = devicePath(entry);
  if (Array.isArray(entry)) {
    return { index: numberOrNull(entry[0]) ?? position, device, states: normalizeStates(entry[2]) };
  }
  if (entry !== null && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    return {
      index: numberOrNull(o.index) ?? position,
      device,
      states: normalizeStates(o.state ?? o.states),
    };
  }
  // Bare string (path via devicePath, no per-member state) or unreadable
  // (device === null); the caller drops the latter.
  return { index: position, device, states: [] };
}

function deriveState(states: string[]): ObservedXiraidArray['status']['state'] {
  if (states.some((s) => FAILED_STATES.has(s))) return 'failed';
  if (states.some((s) => REBUILDING_STATES.has(s))) return 'rebuilding';
  if (states.some((s) => DEGRADED_STATES.has(s))) return 'degraded';
  if (states.includes('online')) return 'optimal';
  return 'unknown';
}

function normalizeLevel(level: unknown): string {
  const text = String(level ?? '').toLowerCase();
  if (text === 'n+m') return 'n+m';
  return `raid${text}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * ADR-0006 `spec.tuning` field names → the spelling the daemon emits under
 * `raid_show --extended`, where the two differ.
 *
 * The daemon suffixes the unit (`memory_limit_mb`, `merge_read_max_usecs`);
 * the control-path schema — and the gRPC *request* side, and the fake
 * transport's `raidModify` write-back — do not. The daemon spelling is
 * checked first (it is the authoritative one on a live node); the plain name
 * is accepted as an alias.
 */
const TUNING_DAEMON_ALIAS: Record<string, string> = {
  memory_limit: 'memory_limit_mb',
  memory_prealloc: 'memory_prealloc_mb',
  merge_read_max: 'merge_read_max_usecs',
  merge_read_wait: 'merge_read_wait_usecs',
  merge_write_max: 'merge_write_max_usecs',
  merge_write_wait: 'merge_write_wait_usecs',
  // `--discard` on the CREATE surface, `discard_allowed` on the SHOW surface
  // (verified on xicli 4.4.0 / driver 4.4.0-43861, whose only discard keys are
  // discard_allowed, discard_active, discard_ignore, discard_verify). Reading
  // the create spelling is why every client rendered discard as "unknown".
  discard: 'discard_allowed',
};

const TUNING_NUMBERS = [
  'init_prio',
  'recon_prio',
  'restripe_prio',
  'sdc_prio',
  'merge_read_max',
  'merge_read_wait',
  'merge_write_max',
  'merge_write_wait',
  'memory_limit',
  'memory_prealloc',
  'request_limit',
  'max_sectors_kb',
];

/**
 * `drive_trim` is deliberately absent: it TRIMs the member disks *before* the
 * array is created, so it is a create-time ACTION, not array state, and no
 * `raid_show` reports it. A knob read from it could only ever be missing.
 * `discard_ignore` / `discard_verify` are absent for a different reason — see
 * docs/TODO.md.
 */
const TUNING_BOOLEANS = [
  'resync_enabled',
  'sched_enabled',
  'merge_read_enabled',
  'merge_write_enabled',
  'adaptive_merge',
  'single_run',
  'discard',
];

const TUNING_STRINGS = ['cpu_allowed'];

/** JSON number, or the numeric string the daemon sometimes emits. */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return numberOrNull(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** xiRAID reports flags as `0`/`1` (sometimes stringified), not as booleans. */
function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const n = coerceNumber(value);
  return n === null ? null : n !== 0;
}

/**
 * A CPU set as the daemon reports it → the control-path `cpu_allowed` string.
 *
 * `raid_show --extended` reports the affinity as a JSON ARRAY of core ids
 * (`[5, 6, 7]` on the real xiRAID 4.3.x daemon), while api-v1.yaml types
 * `cpu_allowed` as a string and the TUI validates it against
 * `^\d+(-\d+)?(,\d+(-\d+)?)*$`. Reading the array as a string therefore
 * dropped the knob and every client rendered a pinned array's affinity as
 * "unknown" — the same fake-transport-shape assumption that hid array
 * capacity until the `size` string was handled.
 *
 * Rendered range-compressed, the way `/sys/devices/system/node/nodeN/cpulist`
 * and xicli write a CPU list, so the value read back is the value an operator
 * would retype into the modify dialog: `[5,6,7]` → `"5-7"`, `[0,2,4,5,6]` →
 * `"0,2,4-6"`. An empty array renders `""` — the observed "all", matching the
 * empty-string rule below.
 *
 * A BARE number stays unreadable on purpose: `7` is ambiguous between core 7
 * and a bitmask, and guessing wrong misreports which cores an array is pinned
 * to. Only the array shape is unambiguous.
 */
function cpuListToString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const cpus: number[] = [];
  for (const entry of value) {
    const n = coerceNumber(entry);
    if (n === null || !Number.isInteger(n) || n < 0) return null;
    cpus.push(n);
  }

  const ranges: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  const flush = (): void => {
    if (start === null || prev === null) return;
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  };
  for (const cpu of [...new Set(cpus)].sort((a, b) => a - b)) {
    if (prev !== null && cpu === prev + 1) {
      prev = cpu;
      continue;
    }
    flush();
    start = cpu;
    prev = cpu;
  }
  flush();
  return ranges.join(',');
}

/**
 * The array's OBSERVED tuning, in ADR-0006 `spec.tuning` names (spec §5).
 *
 * Observation, not desired state: the daemon reports the *effective* values,
 * including its own defaults, and this records what it read. Only keys the
 * daemon actually emitted are set — an absent or unreadable knob stays
 * absent, so a client can tell "not reported" from a real value. Returns
 * null when nothing was observed at all (the shape `raid_show` returns
 * without `extended: true`), so `spec.tuning` is omitted entirely rather
 * than published as an empty object.
 */
function readTuning(o: Record<string, unknown>): ObservedTuning | null {
  const out: ObservedTuning = {};

  const read = (key: string): unknown => o[TUNING_DAEMON_ALIAS[key] ?? key] ?? o[key];

  for (const key of TUNING_NUMBERS) {
    const value = coerceNumber(read(key));
    if (value !== null) out[key] = value;
  }
  for (const key of TUNING_BOOLEANS) {
    const value = coerceBoolean(read(key));
    if (value !== null) out[key] = value;
  }
  for (const key of TUNING_STRINGS) {
    // An empty cpu_allowed is an observed value ("all"), not an absent one.
    const value = read(key);
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    // ...and the real daemon reports it as an array of core ids, not a string.
    const cpuList = key === 'cpu_allowed' ? cpuListToString(value) : null;
    if (cpuList !== null) out[key] = cpuList;
  }

  return Object.keys(out).length > 0 ? out : null;
}

const SIZE_MULTIPLIER: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
  e: 1024 ** 6,
};

/** `<number>` with an optional binary unit: `1.2T`, `1.2 TiB`, `500M`, `1024B`. */
const SIZE_TEXT = /^\s*(\d+(?:\.\d+)?)\s*(?:([bkmgtpe])(?:i?b)?)?\s*$/i;

/**
 * An array's `size` as raid_show reports it → whole bytes (spec §5.1).
 *
 * The daemon renders the size with the unit it was ASKED for, and the adapter
 * always requests `units:'g'` (a missing unit makes the daemon's formatter
 * throw), so a live array reports a formatted STRING — `"1.2T"`, `"163.727G"`,
 * possibly bare `"163.727"` — while the fake transport and the contract
 * fixtures use a plain byte count. Hence: number → bytes verbatim; string →
 * scaled by its unit, or by GiB when it carries none. Unparseable → null, so
 * the optional field is omitted rather than guessed at.
 */
function sizeToBytes(value: unknown): number | null {
  if (typeof value === 'number') return numberOrNull(value);
  if (typeof value !== 'string') return null;
  const match = SIZE_TEXT.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2]?.toLowerCase() ?? 'g';
  return Math.round(amount * (SIZE_MULTIPLIER[unit] as number));
}
