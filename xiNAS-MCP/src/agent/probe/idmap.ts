import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';
/**
 * Idmap probe — privileged layer.
 *
 * snapshot() reads /etc/idmapd.conf → parseIdmapConf (B7), then
 * calls `systemctl is-active nfs-idmapd.service` to determine the
 * daemon's current state. Returns a combined IdmapSnapshot.
 *
 * Injectable dependencies for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { readFile as nodeReadFile } from 'node:fs/promises';
import { parseIdmapConf } from '../../lib/parse/idmap.js';

type ReadFileFn = (path: string, enc: string) => Promise<string>;
type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

interface IdmapProbeOptions {
  confPath?: string;
  readFile?: ReadFileFn;
  execFile?: ExecFileFn;
}

export interface IdmapSnapshot {
  conf_present: boolean;
  domain?: string;
  local_realms?: string[];
  method?: string;
  idmapd_active: boolean;
  idmapd_unit_state: string;
}

export interface IdmapProbe {
  snapshot(): Promise<IdmapSnapshot>;
}

function execFilePromise(
  ef: ExecFileFn,
  file: string,
  args: string[],
  opts: ExecFileOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    ef(file, args, opts, (err, stdout, _stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function createIdmapProbe(opts: IdmapProbeOptions = {}): IdmapProbe {
  const confPath = opts.confPath ?? '/etc/idmapd.conf';
  const rf = opts.readFile ?? ((p, e) => nodeReadFile(p, e as BufferEncoding));
  const ef = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);

  return {
    async snapshot(): Promise<IdmapSnapshot> {
      let confResult: ReturnType<typeof parseIdmapConf> | null = null;
      let confPresent = false;

      try {
        const content = await rf(confPath, 'utf8');
        confResult = parseIdmapConf(content);
        confPresent = true;
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
        // absent conf is a legitimate state — idmapd may be unconfigured
      }

      let unitState = 'unknown';
      try {
        const stdout = await execFilePromise(
          ef,
          'systemctl',
          ['is-active', 'nfs-idmapd.service'],
          {},
        );
        unitState = stdout.trim();
      } catch (err: any) {
        unitState = (err.stdout as string | undefined)?.trim() ?? 'inactive';
      }

      return {
        conf_present: confPresent,
        ...(confResult?.domain !== undefined ? { domain: confResult.domain } : {}),
        ...(confResult?.local_realms !== undefined
          ? { local_realms: confResult.local_realms }
          : {}),
        ...(confResult?.method !== undefined ? { method: confResult.method } : {}),
        idmapd_active: unitState === 'active',
        idmapd_unit_state: unitState,
      };
    },
  };
}
