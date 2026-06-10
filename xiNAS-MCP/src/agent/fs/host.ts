/**
 * FsHost — the S5 filesystem executors' host-command adapter (ADR-0007
 * §Host-command execution): mkfs.xfs / xfs_growfs / blkid / blockdev /
 * systemctl / .mount unit file I/O / statfs / owner policy, behind ONE
 * injectable seam (the subprocess analog of the xiRAID transport).
 *
 * The real implementation execFile's the commands and touches
 * /etc/systemd/system (writable per the T4 unit delta). Tests inject a
 * recording runCommand; fixture mode + e2e use fake-host.ts.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { chmod, chown, readFile, rm, statfs as nodeStatfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type MountEntry, parseMountinfo } from '../../lib/parse/mountinfo.js';

export interface BlkidInfo {
  fstype?: string;
  label?: string;
  uuid?: string;
}

export interface OwnerPolicy {
  uid?: number;
  gid?: number;
  mode?: string;
}

export interface FsHost {
  /** blkid -o export; exit 2 (no filesystem) → null, other failures throw. */
  blkid(device: string): Promise<BlkidInfo | null>;
  /** blockdev --getsize64 (bytes). */
  blockdevSize(device: string): Promise<number>;
  mkfsXfs(args: string[]): Promise<void>;
  growfs(mountpoint: string): Promise<void>;
  writeUnit(name: string, text: string): Promise<void>;
  readUnit(name: string): Promise<string | null>;
  removeUnit(name: string): Promise<void>;
  daemonReload(): Promise<void>;
  enableNow(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  readMounts(): Promise<Array<{ source: string; mountpoint: string }>>;
  statfs(mountpoint: string): Promise<{ size_bytes: number; free_bytes: number }>;
  applyOwnerPolicy(mountpoint: string, policy: OwnerPolicy): Promise<void>;
}

/** Result of one command run: stdout + exit code (non-zero resolves). */
export interface RunResult {
  stdout: string;
  code: number;
}

export type RunCommand = (program: string, args: string[]) => Promise<RunResult>;

/** execFile-backed RunCommand (non-zero exit resolves with the code). */
export function execFileRunCommand(program: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    nodeExecFile(
      program,
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err: (Error & { code?: number | string | null }) | null, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`;
        if (err === null) {
          resolve({ stdout: out, code: 0 });
          return;
        }
        resolve({ stdout: out, code: typeof err.code === 'number' ? err.code : 127 });
      },
    );
  });
}

export interface RealFsHostOptions {
  runCommand?: RunCommand;
  unitDir?: string;
  mountinfoPath?: string;
}

export function createRealFsHost(opts: RealFsHostOptions = {}): FsHost {
  const run = opts.runCommand ?? execFileRunCommand;
  const unitDir = opts.unitDir ?? '/etc/systemd/system';
  const mountinfoPath = opts.mountinfoPath ?? '/proc/self/mountinfo';

  const must = async (program: string, args: string[]): Promise<string> => {
    const res = await run(program, args);
    if (res.code !== 0) {
      throw new Error(`${program} ${args.join(' ')} exited ${res.code}: ${res.stdout.trim()}`);
    }
    return res.stdout;
  };

  return {
    async blkid(device: string): Promise<BlkidInfo | null> {
      const res = await run('blkid', ['-o', 'export', device]);
      // blkid(8): exit 2 = the specified device has no recognizable content.
      if (res.code === 2) return null;
      if (res.code !== 0) {
        throw new Error(`blkid ${device} exited ${res.code}: ${res.stdout.trim()}`);
      }
      const info: BlkidInfo = {};
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

    async blockdevSize(device: string): Promise<number> {
      const out = await must('blockdev', ['--getsize64', device]);
      const n = Number(out.trim());
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`blockdev --getsize64 ${device}: unparsable size '${out.trim()}'`);
      }
      return n;
    },

    async mkfsXfs(args: string[]): Promise<void> {
      await must('mkfs.xfs', args);
    },

    async growfs(mountpoint: string): Promise<void> {
      await must('xfs_growfs', [mountpoint]);
    },

    async writeUnit(name: string, text: string): Promise<void> {
      await writeFile(join(unitDir, name), text, { mode: 0o644 });
    },

    async readUnit(name: string): Promise<string | null> {
      try {
        return await readFile(join(unitDir, name), 'utf8');
      } catch {
        return null;
      }
    },

    async removeUnit(name: string): Promise<void> {
      await rm(join(unitDir, name), { force: true });
    },

    async daemonReload(): Promise<void> {
      await must('systemctl', ['daemon-reload']);
    },

    async enableNow(name: string): Promise<void> {
      await must('systemctl', ['enable', '--now', name]);
    },

    async stop(name: string): Promise<void> {
      await must('systemctl', ['stop', name]);
    },

    async disable(name: string): Promise<void> {
      await must('systemctl', ['disable', name]);
    },

    async readMounts(): Promise<Array<{ source: string; mountpoint: string }>> {
      const raw = await readFile(mountinfoPath, 'utf8');
      return parseMountinfo(raw).map((m: MountEntry) => ({
        source: m.source,
        mountpoint: m.mountpoint,
      }));
    },

    async statfs(mountpoint: string): Promise<{ size_bytes: number; free_bytes: number }> {
      const s = await nodeStatfs(mountpoint);
      return { size_bytes: s.blocks * s.bsize, free_bytes: s.bfree * s.bsize };
    },

    async applyOwnerPolicy(mountpoint: string, policy: OwnerPolicy): Promise<void> {
      if (policy.uid !== undefined || policy.gid !== undefined) {
        await chown(mountpoint, policy.uid ?? 0, policy.gid ?? 0);
      }
      if (policy.mode !== undefined) {
        await chmod(mountpoint, Number.parseInt(policy.mode, 8));
      }
    },
  };
}
