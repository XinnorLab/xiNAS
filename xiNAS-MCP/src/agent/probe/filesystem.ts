import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';
/**
 * Filesystem probe — privileged layer.
 *
 * snapshot() lists /etc/systemd/system/*.mount, reads each file,
 * delegates to parseSystemdUnit (B3) + mountUnitToFilesystem (B4),
 * then calls `systemctl is-enabled <unit>` per unit to populate
 * status.mount_unit_state.
 *
 * Injectable dependencies for test isolation. Do NOT import from outside
 * src/agent/.
 */
import {
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  statfs as nodeStatfs,
} from 'node:fs/promises';
import { join } from 'node:path';
import { type ObservedFilesystem, mountUnitToFilesystem } from '../../lib/parse/filesystem.js';
import { type MountEntry, parseMountinfo } from '../../lib/parse/mountinfo.js';
import { parseSystemdUnit } from '../../lib/parse/systemd-unit.js';

// Narrow injectable shapes (not Node's overloaded signatures) so test
// fakes match without `as any`. The probe only ever lists filenames and
// reads UTF-8 text.
type ReaddirFn = (path: string) => Promise<string[]>;
type ReadFileFn = (path: string, enc: string) => Promise<string>;
type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

/** Enrichment deps (S5 T6): blkid + statfs + the mountinfo cross-ref. */
export interface FsEnrichDeps {
  /** blkid -o export; null = no recognizable filesystem on the device. */
  blkid(device: string): Promise<{ fstype?: string; label?: string; uuid?: string } | null>;
  statfs(mountpoint: string): Promise<{ size_bytes: number; free_bytes: number }>;
  /** Raw /proc/self/mountinfo text. */
  readMountinfo(): Promise<string>;
}

interface FilesystemProbeOptions {
  systemdDir?: string;
  readdir?: ReaddirFn;
  readFile?: ReadFileFn;
  execFile?: ExecFileFn;
  enrich?: FsEnrichDeps;
}

export interface FilesystemSnapshot extends ObservedFilesystem {
  status: ObservedFilesystem['status'] & {
    mount_unit_state: string;
    uuid?: string;
    label?: string;
    size_bytes?: number;
    free_bytes?: number;
    effective_mount_options?: string[];
  };
}

export interface FilesystemProbe {
  snapshot(): Promise<FilesystemSnapshot[]>;
}

/** Wrap an execFile-style callback fn into a Promise returning { stdout, stderr }. */
function execFilePromise(
  ef: ExecFileFn,
  file: string,
  args: string[],
  opts: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    ef(file, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export function createFilesystemProbe(opts: FilesystemProbeOptions = {}): FilesystemProbe {
  const sysDir = opts.systemdDir ?? '/etc/systemd/system';
  const rd: ReaddirFn = opts.readdir ?? ((p) => nodeReaddir(p));
  const rf = opts.readFile ?? ((p, e) => nodeReadFile(p, e as BufferEncoding));
  const ef: ExecFileFn = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const enrich: FsEnrichDeps = opts.enrich ?? {
    async blkid(device) {
      const res = await new Promise<{ stdout: string; code: number }>((resolve) => {
        ef('blkid', ['-o', 'export', device], {}, (err, stdout) => {
          const code =
            err === null
              ? 0
              : typeof (err as Error & { code?: unknown }).code === 'number'
                ? ((err as Error & { code: number }).code as number)
                : 127;
          resolve({ stdout: stdout ?? '', code });
        });
      });
      if (res.code === 2) return null; // no recognizable filesystem
      if (res.code !== 0) throw new Error(`blkid ${device} exited ${res.code}`);
      const info: { fstype?: string; label?: string; uuid?: string } = {};
      for (const line of res.stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === 'TYPE') info.fstype = value;
        if (key === 'LABEL') info.label = value;
        if (key === 'UUID') info.uuid = value;
      }
      return info;
    },
    async statfs(mountpoint) {
      const s = await nodeStatfs(mountpoint);
      return { size_bytes: s.blocks * s.bsize, free_bytes: s.bfree * s.bsize };
    },
    readMountinfo: () => nodeReadFile('/proc/self/mountinfo', 'utf8'),
  };

  return {
    async snapshot(): Promise<FilesystemSnapshot[]> {
      const entries = await rd(sysDir);
      const mountUnits = entries.filter((e) => typeof e === 'string' && e.endsWith('.mount'));
      const results: FilesystemSnapshot[] = [];

      // One mountinfo read per sweep; an unreadable mountinfo degrades the
      // mounted/effective-options fields, never the rows.
      let mounts: MountEntry[] = [];
      try {
        mounts = parseMountinfo(await enrich.readMountinfo());
      } catch {
        /* degraded: no mounted flag this sweep */
      }

      for (const unitName of mountUnits) {
        const unitPath = join(sysDir, unitName);
        const content = await rf(unitPath, 'utf8');
        const parsed = parseSystemdUnit(content);
        let enabledState = 'unknown';
        try {
          const { stdout } = await execFilePromise(ef, 'systemctl', ['is-enabled', unitName], {});
          enabledState = stdout.trim();
        } catch (err: unknown) {
          // systemctl exits non-zero for disabled/not-found; capture stdout if present
          const anyErr = err as Record<string, unknown>;
          enabledState = (anyErr['stdout'] as string | undefined)?.trim() ?? 'not-found';
        }
        const fs = mountUnitToFilesystem(parsed, unitName, enabledState === 'enabled');

        // --- S5 T6 enrichment (each field degrades independently) ---
        const mountEntry = mounts.find(
          (m) => m.mountpoint === fs.status.mountpoint || m.source === fs.status.backing_device,
        );
        const mounted = mountEntry !== undefined;
        let blkidInfo: { fstype?: string; label?: string; uuid?: string } | null = null;
        try {
          blkidInfo = await enrich.blkid(fs.status.backing_device);
        } catch {
          /* degraded: no uuid/label */
        }
        let sizes: { size_bytes: number; free_bytes: number } | undefined;
        if (mounted) {
          try {
            sizes = await enrich.statfs(fs.status.mountpoint);
          } catch {
            /* degraded: no sizes */
          }
        }

        results.push({
          ...fs,
          status: {
            ...fs.status,
            mounted,
            ...(mountEntry !== undefined ? { effective_mount_options: mountEntry.options } : {}),
            ...(blkidInfo?.uuid !== undefined ? { uuid: blkidInfo.uuid } : {}),
            ...(blkidInfo?.label !== undefined ? { label: blkidInfo.label } : {}),
            ...(sizes !== undefined ? { size_bytes: sizes.size_bytes } : {}),
            ...(sizes !== undefined ? { free_bytes: sizes.free_bytes } : {}),
            mount_unit_state: enabledState,
          },
        });
      }

      return results;
    },
  };
}
