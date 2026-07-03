import { existsSync, readFileSync } from 'node:fs';
import { encExportId } from '../lib/nfs-export-id.js';
import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig } from './config.js';

/**
 * Install-time NFS share adoption (design:
 * docs/superpowers/specs/2026-07-03-nfs-share-seed-adoption-design.md).
 *
 * The Ansible `exports` role renders a JSON manifest from the same preset
 * `exports` var that drives /etc/exports. On the FIRST api boot after install,
 * this seeds one desired Share per manifest entry so the install-time export is
 * a first-class managed Share (visible/editable/removable in the TUI). It runs
 * in the bootstrap window (before any listener binds, alongside
 * seedInfrastructure), so plain put() with no CAS is safe — the api is the sole
 * writer. No executor runs and /etc/exports is NOT written: the export already
 * exists on disk from the role's own `exports.j2` render.
 *
 * A one-time marker makes seeding permanent-once: an operator who deletes a
 * seeded share is NOT re-seeded on the next restart (which would leave a ghost
 * desired row with no matching export). A fresh state DB (re-install) has no
 * marker and re-seeds.
 */

const DESIRED_SHARE_PREFIX = '/xinas/v1/desired/Share/';
/** One-time seed marker. Outside desired/·observed/ (like /xinas/v1/cluster) so
 *  it never leaks into a list route. */
const SEEDED_MARKER_KEY = '/xinas/v1/meta/shares_seeded';
const DEFAULT_MANIFEST_PATH = '/var/lib/xinas/seed/shares.json';
/** Origin tag on every seed write (mirrors bootstrap.ts). */
const PUT_SOURCE = { source: 'api:bootstrap' } as const;

interface ManifestEntry {
  path?: unknown;
  clients?: unknown;
  options?: unknown;
}

/** Split `fsid=N` out of the raw option tokens. Returns the parsed fsid (or
 *  undefined) and the remaining non-fsid tokens (order preserved). */
function extractFsid(options: string[]): { fsid: number | undefined; options: string[] } {
  let fsid: number | undefined;
  const rest: string[] = [];
  for (const o of options) {
    const m = /^fsid=(\d+)$/.exec(o);
    if (m) fsid = Number(m[1]);
    else rest.push(o);
  }
  return { fsid, options: rest };
}

export function seedShares(state: OpenedStateStore, config: ApiConfig): void {
  // One-time: once marked, never touch shares again (deletes stay permanent).
  if (state.kv.get(SEEDED_MARKER_KEY) !== null) return;

  const manifestPath = config.seed?.shares_manifest_path ?? DEFAULT_MANIFEST_PATH;
  if (!existsSync(manifestPath)) return; // no manifest yet → leave marker unset

  let entries: ManifestEntry[];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(parsed)) return; // malformed → do not seed, do not mark
    entries = parsed as ManifestEntry[];
  } catch {
    return; // malformed JSON → retry on a later boot
  }
  if (entries.length === 0) return; // nothing to seed → leave marker unset

  // Existing desired paths + used fsids (skip duplicates; assign fsid on gaps).
  // Unpaginated: a node's Share count is realistically well under the KvStore
  // list default cap, and a fresh seed runs against an empty/near-empty prefix.
  const rows = state.kv.list<{ spec?: { path?: unknown; fsid?: unknown } }>({
    prefix: DESIRED_SHARE_PREFIX,
  });
  const existingPaths = new Set<string>();
  const usedFsids = new Set<number>();
  for (const r of rows) {
    const p = r.value.spec?.path;
    if (typeof p === 'string') existingPaths.add(p);
    const f = r.value.spec?.fsid;
    if (typeof f === 'number' && Number.isInteger(f)) usedFsids.add(f);
  }

  for (const entry of entries) {
    const path = entry.path;
    if (typeof path !== 'string' || path.length === 0) continue;
    if (existingPaths.has(path)) continue;

    let id: string;
    try {
      id = encExportId(path); // '/mnt/data' → 'mnt/data'; throws on '/' or '..'
    } catch {
      continue; // unencodable path → skip, boot continues
    }

    const rawOpts = Array.isArray(entry.options)
      ? entry.options.filter((o): o is string => typeof o === 'string')
      : [];
    const { fsid: parsedFsid, options } = extractFsid(rawOpts);
    let fsid = parsedFsid;
    if (fsid === undefined || usedFsids.has(fsid)) {
      fsid = Math.max(0, ...usedFsids) + 1; // 0 reserved; next free integer
    }
    usedFsids.add(fsid);
    existingPaths.add(path);

    const pattern =
      typeof entry.clients === 'string' && entry.clients.length > 0 ? entry.clients : '*';
    const spec = { path, clients: [{ pattern, options }], fsid };
    // Same doc shape as providers/nfs.ts toDesiredShareDoc + the GET routes.
    state.kv.put(`${DESIRED_SHARE_PREFIX}${id}`, { kind: 'Share', id, spec }, PUT_SOURCE);
  }

  state.kv.put(
    SEEDED_MARKER_KEY,
    { seeded_at: new Date().toISOString(), source: 'api:bootstrap' },
    PUT_SOURCE,
  );
}
