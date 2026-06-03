/**
 * Inventory probe — privileged layer.
 *
 * snapshot() reads /proc/cpuinfo + /proc/meminfo via readFile and the
 * os module (hostname, uptime, kernel release), delegates to parseCpuinfo
 * (B10) and parseMeminfo (B10), returns a combined InventorySnapshot.
 *
 * No event source; 300s poll fallback in the Inventory collector (E9).
 * Injectable readFile + os module for test isolation.
 * Do NOT import from outside src/agent/.
 */
import { readFile as nodeReadFile } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { parseCpuinfo, parseMeminfo } from '../../lib/parse/inventory.js';

type ReadFileFn = (path: string, enc: string) => Promise<string>;

interface OsModule {
  hostname(): string;
  uptime(): number;
  release(): string;
  arch(): string;
  type(): string;
}

interface InventoryProbeOptions {
  readFile?: ReadFileFn;
  os?: OsModule;
}

export interface InventorySnapshot {
  hostname: string;
  cpu: {
    model?: string;
    cores?: number;
    threads: number;
    arch: string;
  };
  memory: {
    total_kb: number;
    available_kb: number;
    swap_total_kb: number;
  };
  os: {
    type: string;
    kernel: string;
    uptime_seconds: number;
  };
  observed_at: string;
}

export interface InventoryProbe {
  snapshot(): Promise<InventorySnapshot>;
}

async function readFileSafe(rf: ReadFileFn, path: string): Promise<string | null> {
  try {
    return await rf(path, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return null;
    throw err;
  }
}

export function createInventoryProbe(opts: InventoryProbeOptions = {}): InventoryProbe {
  const rf = opts.readFile ?? ((p, e) => nodeReadFile(p, e as BufferEncoding));
  const os = opts.os ?? nodeOs;

  return {
    async snapshot(): Promise<InventorySnapshot> {
      const [cpuRaw, memRaw] = await Promise.all([
        readFileSafe(rf, '/proc/cpuinfo'),
        readFileSafe(rf, '/proc/meminfo'),
      ]);

      const cpu = cpuRaw
        ? parseCpuinfo(cpuRaw, os.arch())
        : { model: undefined, cores: undefined, threads: 0, arch: os.arch() };
      const mem = memRaw
        ? parseMeminfo(memRaw)
        : { total_kb: 0, available_kb: 0, swap_total_kb: 0 };

      return {
        hostname: os.hostname(),
        cpu: {
          ...(cpu.model !== undefined ? { model: cpu.model } : {}),
          ...(cpu.cores !== undefined ? { cores: cpu.cores } : {}),
          threads: cpu.threads,
          arch: os.arch(),
        },
        memory: {
          total_kb: mem.total_kb,
          available_kb: mem.available_kb,
          swap_total_kb: mem.swap_total_kb,
        },
        os: {
          type: os.type(),
          kernel: os.release(),
          uptime_seconds: Math.floor(os.uptime()),
        },
        observed_at: new Date().toISOString(),
      };
    },
  };
}
