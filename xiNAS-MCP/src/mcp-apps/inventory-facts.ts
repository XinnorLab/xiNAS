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
