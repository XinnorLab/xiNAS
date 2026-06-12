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
 */

export interface ObservedXiraidArray {
  kind: 'XiraidArray';
  id: string;
  spec: {
    name: string;
    level: string;
    member_disk_ids: string[];
    spare_disk_ids: string[];
    strip_size_kib?: number;
    block_size?: number;
    group_size?: number;
  };
  status: {
    state: 'optimal' | 'degraded' | 'rebuilding' | 'failed' | 'importing' | 'unknown';
    volume_path: string;
    /** S9 (ADR-0011): the raw sparepool NAME — drives Pool.referenced_by. */
    spare_pool?: string;
    rebuild_progress_pct: number | null;
    check_progress_pct: number | null;
    usable_capacity_bytes?: number;
    member_states: Array<Record<string, unknown>>;
  };
}

const FAILED_STATES = new Set(['offline', 'broken', 'unusable', 'faulty', 'failed']);
const REBUILDING_STATES = new Set([
  'initializing',
  'initing',
  'init',
  'reconstructing',
  'recon',
  'restriping',
  'resyncing',
]);
const DEGRADED_STATES = new Set(['degraded', 'need_recon', 'need_resync']);

/** Tolerant read of the pool_show payload: name + member drives. */
function readPools(pools: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(pools)) return out;
  for (const entry of pools) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.name !== 'string') continue;
    const drives = Array.isArray(o.drives)
      ? o.drives.filter((d): d is string => typeof d === 'string')
      : [];
    out.set(o.name, drives);
  }
  return out;
}

export function parseRaidShow(
  payload: unknown,
  diskIdByPath: ReadonlyMap<string, string>,
  pools?: unknown,
): ObservedXiraidArray[] {
  if (!Array.isArray(payload)) return [];
  const poolDrives = readPools(pools);
  const out: ObservedXiraidArray[] = [];
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.name !== 'string' || o.name.length === 0) continue;

    const devices = Array.isArray(o.devices)
      ? o.devices.filter((d): d is string => typeof d === 'string')
      : [];
    const states = normalizeStates(o.state);
    const reconProgress = numberOrNull(o.recon_progress) ?? numberOrNull(o.init_progress);
    // S4 T5: the array's sparepool NAME (raid_show) joins to its member
    // DRIVES (pool_show) → control-path disk ids. Absent/unknown → [].
    const spareDrives =
      typeof o.sparepool === 'string' && o.sparepool.length > 0
        ? (poolDrives.get(o.sparepool) ?? [])
        : [];

    out.push({
      kind: 'XiraidArray',
      id: o.name,
      spec: {
        name: o.name,
        level: normalizeLevel(o.level),
        member_disk_ids: devices.map((d) => diskIdByPath.get(d) ?? d),
        spare_disk_ids: spareDrives.map((d) => diskIdByPath.get(d) ?? d),
        ...(numberOrNull(o.strip_size) !== null ? { strip_size_kib: o.strip_size as number } : {}),
        ...(numberOrNull(o.block_size) !== null ? { block_size: o.block_size as number } : {}),
        ...(numberOrNull(o.group_size) !== null ? { group_size: o.group_size as number } : {}),
      },
      status: {
        state: deriveState(states),
        volume_path: `/dev/xi_${o.name}`,
        ...(typeof o.sparepool === 'string' && o.sparepool.length > 0
          ? { spare_pool: o.sparepool }
          : {}),
        rebuild_progress_pct: reconProgress,
        check_progress_pct: null,
        ...(numberOrNull(o.size) !== null ? { usable_capacity_bytes: o.size as number } : {}),
        member_states: [],
      },
    });
  }
  return out;
}

function normalizeStates(state: unknown): string[] {
  if (typeof state === 'string') return [state.toLowerCase()];
  if (Array.isArray(state)) {
    return state.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase());
  }
  return [];
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
