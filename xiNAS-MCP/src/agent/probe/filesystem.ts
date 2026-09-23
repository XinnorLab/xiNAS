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
import { HOST_MOUNTINFO_PATH } from '../fs/mountinfo-source.js';
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

/**
 * Valid systemd ActiveState values for a .mount unit — the exact enum the
 * control-path `Filesystem.status.mount_unit_state` schema accepts. `systemctl
 * is-active` can also print 'unknown' (masked/not-found); that is NOT a member,
 * so the probe omits the field rather than emit a value ingest would 400 on.
 */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'active',
  'inactive',
  'failed',
  'activating',
  'deactivating',
]);

export interface FilesystemSnapshot extends ObservedFilesystem {
  status: ObservedFilesystem['status'] & {
    /** systemd ActiveState; absent when is-active reports a non-enum value. */
    mount_unit_state?: string;
    uuid?: string;
    label?: string;
    size_bytes?: number;
    free_bytes?: number;
    effective_mount_options?: string[];
    /**
     * S20 (API-09): the mount's super options — the last mountinfo field,
     * where XFS names its external devices (`logdev=`, `rtdev=`). Present
     * only when the unit's mountpoint is in the mount table.
     */
    super_options?: string[];
    /**
     * S20 (API-06): the mount table's `source` for the matched entry — the
     * device identity as mounted, not the unit's `What=`. Present with
     * `mounted: true` only.
     */
    mount_source?: string;
    /**
     * S20 (API-06): set when the unit's mountpoint IS in the mount table but
     * served by a different device than `What=`; `mounted` is then false and
     * a placement consumer reports MOUNT_SOURCE_MISMATCH instead of guessing.
     */
    mount_source_mismatch?: string;
    /**
     * S20 (SRC-14): false when /proc/self/mountinfo could not be read this
     * sweep. In that case `mounted` is ABSENT (unknown), not false.
     */
    mountinfo_readable: boolean;
  };
}

/**
 * S20 §4.1: the lean row the placement cycle reads every 5 s — unit files
 * + one mountinfo read, no systemctl, no blkid, no statfs. Enablement and
 * ActiveState are deliberately absent (they cost two subprocesses per unit
 * and the 60 s Filesystem row carries them).
 */
export interface PlacementFilesystemRow {
  id: string;
  mountpoint: string;
  backing_device: string;
  fs_type?: string;
  mount_options: string[];
  mounted?: boolean;
  mountinfo_readable: boolean;
  mount_source?: string;
  super_options?: string[];
  effective_mount_options?: string[];
  mount_source_mismatch?: string;
}

/** One mount-table line as the lean sweep summarizes it (T-05 needs the whole table). */
export interface PlacementMountSummary {
  mountpoint: string;
  source: string;
  fstype: string;
}

/** The lean sweep's result: managed rows plus the node's mount table. */
export interface PlacementFilesystemSweep {
  filesystems: PlacementFilesystemRow[];
  mounts: PlacementMountSummary[];
  mountinfo_readable: boolean;
}

export interface FilesystemProbe {
  snapshot(): Promise<FilesystemSnapshot[]>;
  /** S20: the subprocess-free sweep for the placement collector. */
  snapshotForPlacement(): Promise<PlacementFilesystemSweep>;
}

/**
 * S20 (API-06): the exact mountinfo cross-reference — the entry at THIS
 * mountpoint must be served by THIS device. A mountpoint served by another
 * device, or the device mounted elsewhere, is not "mounted" for the unit;
 * the mismatch is reported so a consumer can name it. With mountinfo
 * unreadable, `mounted` is left undefined (unknown), never false (SRC-14).
 */
export function crossReferenceMount(
  mountpoint: string,
  backingDevice: string,
  mounts: readonly MountEntry[],
  mountinfoReadable: boolean,
): {
  mounted?: boolean;
  mountinfo_readable: boolean;
  effective_mount_options?: string[];
  super_options?: string[];
  mount_source?: string;
  mount_source_mismatch?: string;
} {
  const atMountpoint = mounts.find((m) => m.mountpoint === mountpoint);
  const entry =
    atMountpoint !== undefined && atMountpoint.source === backingDevice ? atMountpoint : undefined;
  const mounted = mountinfoReadable ? entry !== undefined : undefined;
  return {
    ...(mounted !== undefined ? { mounted } : {}),
    mountinfo_readable: mountinfoReadable,
    ...(entry !== undefined
      ? {
          effective_mount_options: entry.options,
          super_options: entry.super_options,
          mount_source: entry.source,
        }
      : {}),
    ...(atMountpoint !== undefined && entry === undefined
      ? { mount_source_mismatch: atMountpoint.source }
      : {}),
  };
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
    readMountinfo: () => nodeReadFile(HOST_MOUNTINFO_PATH, 'utf8'),
  };

  return {
    async snapshot(): Promise<FilesystemSnapshot[]> {
      const entries = await rd(sysDir);
      const mountUnits = entries.filter((e) => typeof e === 'string' && e.endsWith('.mount'));
      const results: FilesystemSnapshot[] = [];

      // One mountinfo read per sweep; an unreadable mountinfo degrades the
      // mounted/effective-options fields, never the rows. S20: the failure is
      // recorded (`mountinfo_readable: false`) and `mounted` is left ABSENT so
      // "could not tell" is distinguishable from "not mounted" (SRC-14).
      let mounts: MountEntry[] = [];
      let mountinfoReadable = true;
      try {
        mounts = parseMountinfo(await enrich.readMountinfo());
      } catch {
        mountinfoReadable = false;
      }

      for (const unitName of mountUnits) {
        const unitPath = join(sysDir, unitName);
        const content = await rf(unitPath, 'utf8');
        const parsed = parseSystemdUnit(content);
        // Enablement (is-enabled): the boolean mount_unit_enabled. Values are
        // 'enabled' / 'disabled' / 'static' / 'not-found' — NOT ActiveState.
        let enabledState = 'unknown';
        try {
          const { stdout } = await execFilePromise(ef, 'systemctl', ['is-enabled', unitName], {});
          enabledState = stdout.trim();
        } catch (err: unknown) {
          // systemctl exits non-zero for disabled/not-found; capture stdout if present
          const anyErr = err as Record<string, unknown>;
          enabledState = (anyErr['stdout'] as string | undefined)?.trim() ?? 'not-found';
        }

        // ActiveState (is-active): the mount_unit_state enum. A DISTINCT concept
        // from enablement — is-enabled values ('enabled', 'static', …) are NOT
        // valid ActiveState and would 400 the whole batch at ingest. systemctl
        // exits non-zero for inactive/failed but still prints the state on
        // stdout, so capture it from the error the same way.
        let activeStateRaw: string | undefined;
        try {
          const { stdout } = await execFilePromise(ef, 'systemctl', ['is-active', unitName], {});
          activeStateRaw = stdout.trim();
        } catch (err: unknown) {
          const anyErr = err as Record<string, unknown>;
          activeStateRaw = (anyErr['stdout'] as string | undefined)?.trim();
        }
        const mountUnitState =
          activeStateRaw !== undefined && ACTIVE_STATES.has(activeStateRaw)
            ? activeStateRaw
            : undefined;

        const fs = mountUnitToFilesystem(parsed, unitName, enabledState === 'enabled');

        // --- S5 T6 enrichment (each field degrades independently) ---
        // S20 (API-06): exact mountpoint + source cross-reference.
        const xref = crossReferenceMount(
          fs.status.mountpoint,
          fs.status.backing_device,
          mounts,
          mountinfoReadable,
        );
        const mounted = xref.mounted;
        let blkidInfo: { fstype?: string; label?: string; uuid?: string } | null = null;
        try {
          blkidInfo = await enrich.blkid(fs.status.backing_device);
        } catch {
          /* degraded: no uuid/label */
        }
        let sizes: { size_bytes: number; free_bytes: number } | undefined;
        if (mounted === true) {
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
            ...xref,
            ...(blkidInfo?.uuid !== undefined ? { uuid: blkidInfo.uuid } : {}),
            ...(blkidInfo?.label !== undefined ? { label: blkidInfo.label } : {}),
            ...(sizes !== undefined ? { size_bytes: sizes.size_bytes } : {}),
            ...(sizes !== undefined ? { free_bytes: sizes.free_bytes } : {}),
            ...(mountUnitState !== undefined ? { mount_unit_state: mountUnitState } : {}),
          },
        });
      }

      return results;
    },

    async snapshotForPlacement(): Promise<PlacementFilesystemSweep> {
      const entries = await rd(sysDir);
      const mountUnits = entries.filter((e) => typeof e === 'string' && e.endsWith('.mount'));
      let mounts: MountEntry[] = [];
      let mountinfoReadable = true;
      try {
        mounts = parseMountinfo(await enrich.readMountinfo());
      } catch {
        mountinfoReadable = false;
      }
      const rows: PlacementFilesystemRow[] = [];
      for (const unitName of mountUnits) {
        const content = await rf(join(sysDir, unitName), 'utf8');
        const fs = mountUnitToFilesystem(parseSystemdUnit(content), unitName, false);
        rows.push({
          id: fs.id,
          mountpoint: fs.status.mountpoint,
          backing_device: fs.status.backing_device,
          ...(fs.status.fs_type !== undefined ? { fs_type: fs.status.fs_type } : {}),
          mount_options: fs.status.mount_options ?? [],
          ...crossReferenceMount(
            fs.status.mountpoint,
            fs.status.backing_device,
            mounts,
            mountinfoReadable,
          ),
        });
      }
      return {
        filesystems: rows,
        mounts: mounts.map((m) => ({
          mountpoint: m.mountpoint,
          source: m.source,
          fstype: m.fstype,
        })),
        mountinfo_readable: mountinfoReadable,
      };
    },
  };
}
