/**
 * NFS share `fsid` allocation (design:
 * docs/superpowers/specs/2026-08-14-server-side-fsid-allocation-design.md).
 *
 * `Share.spec.fsid` is required by the API and nothing used to assign it, so
 * every client allocated its own and two concurrent creates could pick the same
 * number — an fsid collision breaks NFSv4 client mounts. Allocation now happens
 * server-side, and these pure helpers are the single definition of "which
 * number is next" shared by the create plan provider and the seed path, so the
 * two cannot drift.
 */

/** Desired-space prefix for the per-number allocation marker rows. */
export const SHARE_FSID_PREFIX = '/xinas/v1/desired/ShareFsid/';

/**
 * Resource kind for the marker's absence pin in `affected_resources`. The task
 * engine resolves a pin to `/xinas/v1/{space}/{kind}/{id}`, so this must match
 * the prefix's final segment.
 */
export const SHARE_FSID_KIND = 'ShareFsid';

/** KV key of the marker row for `fsid`. */
export function shareFsidKey(fsid: number): string {
  return `${SHARE_FSID_PREFIX}${fsid}`;
}

/** A desired `Share` row as `KvStore.list` returns it. */
export interface ShareDocRow {
  value: { id?: unknown; spec?: { fsid?: unknown } };
}

/**
 * Every integer `fsid` on the given desired Share rows, mapped to the id of the
 * share holding it (so a collision can name its owner). Integer-valued strings
 * are accepted, matching the provider's own `fsid` validator.
 */
export function collectUsedFsids(rows: readonly ShareDocRow[]): Map<number, string> {
  const used = new Map<number, string>();
  for (const row of rows) {
    const raw = row.value?.spec?.fsid;
    let n = Number.NaN;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && raw.trim().length > 0) n = Number(raw);
    if (!Number.isInteger(n)) continue;
    const id = typeof row.value?.id === 'string' ? row.value.id : '<unknown>';
    if (!used.has(n)) used.set(n, id);
  }
  return used;
}

/**
 * The next `fsid`: one above the highest in use.
 *
 * NOT the lowest free integer — a gap left by a deleted share is deliberately
 * not reused (design §12). Iterating rather than spreading into `Math.max`
 * keeps this safe for any share count.
 */
export function allocateFsid(used: Iterable<number>): number {
  let max = 0;
  for (const fsid of used) if (fsid > max) max = fsid;
  return max + 1;
}
