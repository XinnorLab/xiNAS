/**
 * NfsProfile probe — privileged layer (S3 N7.2, s3 spec §3.4).
 *
 * snapshot() checksums the four ADR-0005 "effective files" the
 * render_nfs_profile helper op owns. Present file → `sha256:<hex>` of its
 * bytes; absent file → key omitted (only present files appear). This feeds
 * the observed NfsProfile collector's status.effective_files, which is how
 * MANUAL edits to the effective files surface as drift (ADR-0005's stated
 * drift-detection intent).
 *
 * `root` is injectable for test isolation (a tmp dir standing in for `/`).
 * Do NOT import from outside src/agent/.
 */

import { createHash } from 'node:crypto';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The four ADR-0005 effective files, in the ADR's table order. */
export const NFS_PROFILE_EFFECTIVE_FILES = [
  '/etc/nfs/nfsd.conf',
  '/etc/default/nfs-kernel-server',
  '/etc/modprobe.d/lockd.conf',
  '/etc/default/nfs-common',
] as const;

export interface NfsProfileSnapshot {
  /** Absolute path → `sha256:<hex>`; absent files have no entry. */
  effective_files: Record<string, string>;
}

export interface NfsProfileProbe {
  snapshot(): Promise<NfsProfileSnapshot>;
}

interface NfsProfileProbeOptions {
  /** Filesystem root the four absolute paths resolve under. Default '/'. */
  root?: string;
}

export function createNfsProfileProbe(opts: NfsProfileProbeOptions = {}): NfsProfileProbe {
  const root = opts.root ?? '/';

  return {
    async snapshot(): Promise<NfsProfileSnapshot> {
      const effective_files: Record<string, string> = {};
      for (const path of NFS_PROFILE_EFFECTIVE_FILES) {
        try {
          const bytes = await nodeReadFile(join(root, path));
          effective_files[path] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // Absent file (or absent parent dir) is a legitimate state —
          // e.g. lockd.conf only exists when v3 locking is configured.
          if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
        }
      }
      return { effective_files };
    },
  };
}
