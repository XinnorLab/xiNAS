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
 * The integer `fsid` a stored value denotes, or `undefined` when it is not one.
 * Integer-valued strings are accepted, matching the provider's own validator.
 */
export function parseFsid(raw: unknown): number | undefined {
  let n = Number.NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim().length > 0) n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * Every integer `fsid` on the given desired Share rows, mapped to the id of the
 * share holding it (so a collision can name its owner).
 */
export function collectUsedFsids(rows: readonly ShareDocRow[]): Map<number, string> {
  const used = new Map<number, string>();
  for (const row of rows) {
    const n = parseFsid(row.value?.spec?.fsid);
    if (n === undefined) continue;
    const id = typeof row.value?.id === 'string' ? row.value.id : '<unknown>';
    if (!used.has(n)) used.set(n, id);
  }
  return used;
}

/** A `ShareFsid/{n}` marker row as `KvStore.list` returns it. */
export interface FsidMarkerRow {
  value: { fsid?: unknown; share_id?: unknown };
  revision: number;
}

/**
 * The desired mutations + revision pins that bring the marker rows in line
 * with `wanted` (fsid → holding share id): a marker is put when it is absent
 * or names a different share, and deleted when no wanted share holds its
 * number. Rows already correct are left alone, so a healthy store sees no
 * revision churn. Every touched marker is pinned at its CURRENT revision (0
 * when absent), which still closes the plan→apply race — a concurrent create
 * that writes the marker bumps it past the pin.
 *
 * Used by config.rollback adopt, which rewrites the Share set wholesale and
 * must not leave orphan markers behind (an orphan pinned absent by a later
 * create fails PRECONDITION_FAILED on every apply).
 */
export function reconcileFsidMarkers(
  current: readonly FsidMarkerRow[],
  wanted: ReadonlyMap<number, string>,
): {
  mutations: ({ key: string; value: unknown } | { key: string; delete: true })[];
  pins: { kind: string; id: string; revision: number }[];
} {
  const currentByFsid = new Map<number, { share_id: unknown; revision: number }>();
  for (const row of current) {
    const n = parseFsid(row.value?.fsid);
    if (n === undefined) continue;
    currentByFsid.set(n, { share_id: row.value.share_id, revision: row.revision });
  }
  const mutations: ({ key: string; value: unknown } | { key: string; delete: true })[] = [];
  const pins: { kind: string; id: string; revision: number }[] = [];
  for (const [fsid, shareId] of wanted) {
    const cur = currentByFsid.get(fsid);
    if (cur !== undefined && cur.share_id === shareId) continue;
    mutations.push({ key: shareFsidKey(fsid), value: { fsid, share_id: shareId } });
    pins.push({ kind: SHARE_FSID_KIND, id: String(fsid), revision: cur?.revision ?? 0 });
  }
  for (const [fsid, cur] of currentByFsid) {
    if (wanted.has(fsid)) continue;
    mutations.push({ key: shareFsidKey(fsid), delete: true });
    pins.push({ kind: SHARE_FSID_KIND, id: String(fsid), revision: cur.revision });
  }
  return { mutations, pins };
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
