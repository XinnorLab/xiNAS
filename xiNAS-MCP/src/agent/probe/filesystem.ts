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
import { readFile as nodeReadFile, readdir as nodeReaddir } from 'node:fs/promises';
import { join } from 'node:path';
import { type ObservedFilesystem, mountUnitToFilesystem } from '../../lib/parse/filesystem.js';
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

interface FilesystemProbeOptions {
  systemdDir?: string;
  readdir?: ReaddirFn;
  readFile?: ReadFileFn;
  execFile?: ExecFileFn;
}

export interface FilesystemSnapshot extends ObservedFilesystem {
  status: ObservedFilesystem['status'] & {
    mount_unit_state: string;
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

  return {
    async snapshot(): Promise<FilesystemSnapshot[]> {
      const entries = await rd(sysDir);
      const mountUnits = entries.filter((e) => typeof e === 'string' && e.endsWith('.mount'));
      const results: FilesystemSnapshot[] = [];

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
        results.push({
          ...fs,
          status: {
            ...fs.status,
            mount_unit_state: enabledState,
          },
        });
      }

      return results;
    },
  };
}
