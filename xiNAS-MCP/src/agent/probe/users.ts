/**
 * Users probe — privileged layer.
 *
 * getentPasswd() runs `getent passwd` → parsePasswdLine (B8) per line.
 * getentGroup()  runs `getent group`  → parseGroupLine  (B9) per line.
 * snapshot() returns { users, groups } combined.
 *
 * Injectable execFile for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';
import { type ParsedGroupLine, parseGroupLine } from '../../lib/parse/group.js';
import { type ParsedPasswdLine, parsePasswdLine } from '../../lib/parse/passwd.js';

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

interface UsersProbeOptions {
  execFile?: ExecFileFn;
}

export interface UsersSnapshot {
  users: ParsedPasswdLine[];
  groups: ParsedGroupLine[];
}

export interface UsersProbe {
  getentPasswd(): Promise<ParsedPasswdLine[]>;
  getentGroup(): Promise<ParsedGroupLine[]>;
  snapshot(): Promise<UsersSnapshot>;
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

export function createUsersProbe(opts: UsersProbeOptions = {}): UsersProbe {
  const ef = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);

  async function runGetent(database: string): Promise<string> {
    // 16 MiB: `getent passwd`/`getent group` against an LDAP/AD-backed NSS
    // (which xiNAS supports) can far exceed Node's default 1 MiB maxBuffer
    // on a large directory, which would reject with MAXBUFFER and fail the
    // probe on exactly those deployments. lsblk/ip output is hardware-
    // bounded so they keep the default.
    return execFilePromise(ef, 'getent', [database], { maxBuffer: 16 * 1024 * 1024 });
  }

  return {
    async getentPasswd(): Promise<ParsedPasswdLine[]> {
      const output = await runGetent('passwd');
      return output
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => parsePasswdLine(line));
    },

    async getentGroup(): Promise<ParsedGroupLine[]> {
      const output = await runGetent('group');
      return output
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => parseGroupLine(line));
    },

    async snapshot(): Promise<UsersSnapshot> {
      const [users, groups] = await Promise.all([this.getentPasswd(), this.getentGroup()]);
      return { users, groups };
    },
  };
}
