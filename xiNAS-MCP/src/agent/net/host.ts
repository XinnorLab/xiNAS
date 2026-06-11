/**
 * NetHost — the S6 network executors' host-command adapter (ADR-0008
 * §Host seam): netplan file IO + generate/apply, the surgical/global
 * flush verbs (ip rule/route/addr), kernel reads, and classification
 * inputs — behind ONE injectable seam (the FsHost pattern).
 *
 * The real implementation execFile's the commands and touches
 * /etc/netplan (writable per the T1 unit delta; CAP_NET_ADMIN per the
 * same). Tests inject a recording runCommand; fixture mode + e2e use
 * fake-host.ts.
 */

import { readFile as nodeReadFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type RunCommand, type RunResult, execFileRunCommand } from '../fs/host.js';

export interface NetHost {
  /** All /etc/netplan *.yaml|*.yml files: path → text. */
  readNetplanDir(): Promise<Record<string, string>>;
  /** Atomic write (tmp + rename). */
  writeNetplanFile(path: string, text: string): Promise<void>;
  /** Validate the merged config; throws on rejection. */
  netplanGenerate(): Promise<void>;
  netplanApply(): Promise<void>;
  ipRuleShow(): Promise<string>;
  /** `spec` is everything after `ip rule del `, e.g. 'from 10.10.1.1 lookup 100'. */
  ipRuleDel(spec: string): Promise<void>;
  ipRouteFlushTable(id: number): Promise<void>;
  ipAddrFlush(dev: string): Promise<void>;
  /** `ip -j addr show` JSON text. */
  ipAddrShow(): Promise<string>;
  listSysClassNet(): Promise<Array<{ name: string; driver: string }>>;
  /** `rdma link show -j` JSON text; '' when the tool is unavailable. */
  rdmaLinkShow(): Promise<string>;
}

export interface RealNetHostOptions {
  runCommand?: RunCommand;
  netplanDir?: string;
  sysClassNet?: string;
}

export function createRealNetHost(opts: RealNetHostOptions = {}): NetHost {
  const run = opts.runCommand ?? execFileRunCommand;
  const netplanDir = opts.netplanDir ?? '/etc/netplan';
  const sysClassNet = opts.sysClassNet ?? '/sys/class/net';

  const must = async (program: string, args: string[]): Promise<string> => {
    const res: RunResult = await run(program, args);
    if (res.code !== 0) {
      throw new Error(`${program} ${args.join(' ')} exited ${res.code}: ${res.stdout.trim()}`);
    }
    return res.stdout;
  };

  return {
    async readNetplanDir(): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      let entries: string[];
      try {
        entries = await readdir(netplanDir);
      } catch {
        return out;
      }
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
        const path = join(netplanDir, entry);
        try {
          out[path] = await nodeReadFile(path, 'utf8');
        } catch {
          /* unreadable file: skipped — the parse layer reports drift elsewhere */
        }
      }
      return out;
    },

    async writeNetplanFile(path: string, text: string): Promise<void> {
      const tmp = join(netplanDir, `.${basename(path)}.tmp`);
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, path);
    },

    async netplanGenerate(): Promise<void> {
      await must('netplan', ['generate']);
    },

    async netplanApply(): Promise<void> {
      await must('netplan', ['apply']);
    },

    async ipRuleShow(): Promise<string> {
      return must('ip', ['rule', 'show']);
    },

    async ipRuleDel(spec: string): Promise<void> {
      await must('ip', ['rule', 'del', ...spec.split(/\s+/)]);
    },

    async ipRouteFlushTable(id: number): Promise<void> {
      await must('ip', ['route', 'flush', 'table', String(id)]);
    },

    async ipAddrFlush(dev: string): Promise<void> {
      await must('ip', ['addr', 'flush', 'dev', dev]);
    },

    async ipAddrShow(): Promise<string> {
      return must('ip', ['-j', 'addr', 'show']);
    },

    async listSysClassNet(): Promise<Array<{ name: string; driver: string }>> {
      const out: Array<{ name: string; driver: string }> = [];
      let entries: string[];
      try {
        entries = await readdir(sysClassNet);
      } catch {
        return out;
      }
      for (const name of entries.sort()) {
        try {
          const { realpath } = await import('node:fs/promises');
          const target = await realpath(join(sysClassNet, name, 'device', 'driver'));
          out.push({ name, driver: basename(target) });
        } catch {
          out.push({ name, driver: '' });
        }
      }
      return out;
    },

    async rdmaLinkShow(): Promise<string> {
      const res = await run('rdma', ['link', 'show', '-j']);
      // 127 = the rdma tool is absent (no MOFED) — degraded, not an error.
      if (res.code !== 0) return '';
      return res.stdout;
    },
  };
}
