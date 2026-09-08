/**
 * Pure inventory rules for the S18 RAID Create View (spec §5, §10).
 *
 * DOM-free like plan-facts.ts so the unit suite can exercise them;
 * raid-create.ts owns the rendering.
 */

/** Pool `drives` are device paths (`lib/parse/pool.ts`), never Disk ids. */
export function pooledDevicePaths(pools: Array<{ drives?: string[] }>): Set<string> {
  return new Set(pools.flatMap((pool) => pool.drives ?? []));
}

/**
 * A disk is held by a spare pool when its device path is a pool drive. The
 * stable Disk id is a serial key and is never compared against pool drives —
 * doing so offered pooled disks as free (report I-07).
 */
export function isPooled(
  disk: { status?: { device_path?: string } },
  pooled: Set<string>,
): boolean {
  const path = disk.status?.device_path;
  return path !== undefined && pooled.has(path);
}

export interface InventoryWarning {
  code?: string;
  message?: string;
}

/** `DEGRADED_*` means a backend was absent and the rows are empty or stale — the form must not plan on them (§10). */
export const BLOCKING_WARNING_PREFIX = 'DEGRADED_';

export function classifyWarnings(warnings: InventoryWarning[] | undefined): {
  blocking: InventoryWarning[];
  advisory: InventoryWarning[];
} {
  const blocking: InventoryWarning[] = [];
  const advisory: InventoryWarning[] = [];
  for (const w of warnings ?? []) {
    if (typeof w.code === 'string' && w.code.startsWith(BLOCKING_WARNING_PREFIX)) blocking.push(w);
    else advisory.push(w);
  }
  return { blocking, advisory };
}

/**
 * `'none'` before the first refresh; `'trusted'` after a clean refresh;
 * `'degraded'` after a refresh that succeeded but carried a blocking
 * warning; `'failed'` after a refresh where any of the three tool calls
 * threw (S18 §5, §10).
 */
export type InventoryTrust = 'none' | 'trusted' | 'degraded' | 'failed';

export function inventoryBanner(trust: InventoryTrust, detail: string): string {
  if (trust !== 'failed' && trust !== 'degraded') return '';
  return `Inventory is not current: ${detail}. Showing the last known inventory; Review plan is disabled until a refresh succeeds.`;
}

export function warningText(w: InventoryWarning): string {
  return [w.code, w.message].filter((part) => part !== undefined && part.length > 0).join(' — ');
}
