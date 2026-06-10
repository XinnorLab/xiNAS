/**
 * NfsProfile probe — privileged layer (S3 N7.2 + status.running, s3 spec §3.4).
 *
 * snapshot() checksums the four ADR-0005 "effective files" the
 * render_nfs_profile helper op owns. Present file → `sha256:<hex>` of its
 * bytes; absent file → key omitted (only present files appear). This feeds
 * the observed NfsProfile collector's status.effective_files, which is how
 * MANUAL edits to the effective files surface as drift (ADR-0005's stated
 * drift-detection intent).
 *
 * snapshot() also reads the live nfsd runtime from /proc/fs/nfsd
 * (threads, versions, portlist) into `running`:
 *   - `threads` is the anchor: unreadable (ENOENT/ENOTDIR — nfsd down or
 *     module not loaded) or non-integer → `running` omitted entirely.
 *   - With a valid thread count, an individually unreadable `versions` /
 *     `portlist` DEGRADES that field (empty active_versions / rdma off)
 *     rather than dropping `running` — a partially readable proc dir is
 *     transient kernel state, and thread_count is still trustworthy.
 *   - `rdma_port` is present only when an rdma listener exists
 *     (exactOptionalPropertyTypes — conditional spread).
 *
 * `root` is injectable for test isolation (a tmp dir standing in for `/`).
 * Do NOT import from outside src/agent/.
 */

import { createHash } from 'node:crypto';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseNfsdPortlist, parseNfsdThreads, parseNfsdVersions } from '../../lib/parse/nfsd.js';

/** The four ADR-0005 effective files, in the ADR's table order. */
export const NFS_PROFILE_EFFECTIVE_FILES = [
  '/etc/nfs/nfsd.conf',
  '/etc/default/nfs-kernel-server',
  '/etc/modprobe.d/lockd.conf',
  '/etc/default/nfs-common',
] as const;

/** Live nfsd runtime (api-v1.yaml NfsProfile status.running). */
export interface NfsProfileRunning {
  thread_count: number;
  rdma_listening: boolean;
  /** Present only when an rdma listener exists. */
  rdma_port?: number;
  active_versions: string[];
}

export interface NfsProfileSnapshot {
  /** Absolute path → `sha256:<hex>`; absent files have no entry. */
  effective_files: Record<string, string>;
  /** Omitted when nfsd is down (/proc/fs/nfsd/threads unreadable). */
  running?: NfsProfileRunning;
}

export interface NfsProfileProbe {
  snapshot(): Promise<NfsProfileSnapshot>;
}

interface NfsProfileProbeOptions {
  /** Filesystem root the four absolute paths resolve under. Default '/'. */
  root?: string;
}

/** Read a root-prefixed file, treating absent file/dir as null. */
async function readOrNull(root: string, path: string): Promise<Buffer | null> {
  try {
    return await nodeReadFile(join(root, path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    return null;
  }
}

async function readRunning(root: string): Promise<NfsProfileRunning | null> {
  // threads is the anchor: nfsd down / module not loaded → no /proc/fs/nfsd
  // entries → running omitted. A present-but-junk threads file is treated
  // the same way (no trustworthy thread_count to report).
  const threadsRaw = await readOrNull(root, '/proc/fs/nfsd/threads');
  if (threadsRaw === null) return null;
  const thread_count = parseNfsdThreads(threadsRaw.toString('utf8'));
  if (thread_count === null) return null;

  // versions/portlist degrade individually (see module doc).
  const versionsRaw = await readOrNull(root, '/proc/fs/nfsd/versions');
  const portlistRaw = await readOrNull(root, '/proc/fs/nfsd/portlist');
  const active_versions =
    versionsRaw !== null ? parseNfsdVersions(versionsRaw.toString('utf8')) : [];
  const { rdma_listening, rdma_port } =
    portlistRaw !== null
      ? parseNfsdPortlist(portlistRaw.toString('utf8'))
      : { rdma_listening: false, rdma_port: null };

  return {
    thread_count,
    rdma_listening,
    ...(rdma_port !== null ? { rdma_port } : {}),
    active_versions,
  };
}

export function createNfsProfileProbe(opts: NfsProfileProbeOptions = {}): NfsProfileProbe {
  const root = opts.root ?? '/';

  return {
    async snapshot(): Promise<NfsProfileSnapshot> {
      const effective_files: Record<string, string> = {};
      for (const path of NFS_PROFILE_EFFECTIVE_FILES) {
        const bytes = await readOrNull(root, path);
        // Absent file (or absent parent dir) is a legitimate state —
        // e.g. lockd.conf only exists when v3 locking is configured.
        if (bytes !== null) {
          effective_files[path] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        }
      }
      const running = await readRunning(root);
      return { effective_files, ...(running !== null ? { running } : {}) };
    },
  };
}
