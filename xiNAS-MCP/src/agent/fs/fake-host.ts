/**
 * File-backed fake FsHost (S5 T5) — fixture mode + e2e, the fake-xiraid
 * pattern. State at <dir>/fs-host-state.json:
 *   { blkid: { <dev>: {fstype,label,uuid} }, device_sizes: { <dev>: n },
 *     units: { <name>: text }, mounted: [ <unit name> ],
 *     statfs: { <mountpoint>: {size_bytes, free_bytes} }, ops: [ ... ] }
 *
 * Deterministic hooks (no randomness):
 *  - mkfsXfs / growfs / enableNow against a device/unit name ending
 *    '-fail' REJECT;
 *  - stop against a unit name ending '-busy' REJECTS (the umount-EBUSY
 *    simulation for the unmount-rollback path).
 *
 * Behaviors the executors rely on:
 *  - mkfsXfs records the exact argv in `ops` (clamp goldens) and sets the
 *    device's blkid entry (deterministic uuid `uuid-<leaf>`);
 *  - enableNow requires the unit to exist, adds it to `mounted`, parses
 *    Where=/What= out of the unit text for readMounts, and defaults a
 *    statfs entry; stop removes it;
 *  - blockdevSize: seeded size or 1 TiB default;
 *  - growfs bumps the mountpoint's size_bytes by 1 GiB.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BlkidInfo, FsHost, OwnerPolicy } from './host.js';

interface FakeFsState {
  blkid: Record<string, BlkidInfo>;
  device_sizes: Record<string, number>;
  units: Record<string, string>;
  mounted: string[];
  statfs: Record<string, { size_bytes: number; free_bytes: number }>;
  ops: string[];
}

const DEFAULT_DEVICE_SIZE = 1024 ** 4; // 1 TiB
const DEFAULT_STATFS = { size_bytes: 10 * 1024 ** 3, free_bytes: 9 * 1024 ** 3 };

function statePath(dir: string): string {
  return join(dir, 'fs-host-state.json');
}

function load(dir: string): FakeFsState {
  const path = statePath(dir);
  if (!existsSync(path)) {
    return { blkid: {}, device_sizes: {}, units: {}, mounted: [], statfs: {}, ops: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeFsState>;
  return {
    blkid: parsed.blkid ?? {},
    device_sizes: parsed.device_sizes ?? {},
    units: parsed.units ?? {},
    mounted: parsed.mounted ?? [],
    statfs: parsed.statfs ?? {},
    ops: parsed.ops ?? [],
  };
}

function save(dir: string, state: FakeFsState): void {
  mkdirSync(dirname(statePath(dir)), { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

function failHook(name: string, op: string): void {
  // unit names carry a .mount suffix; hook on the stem.
  if (name.replace(/\.mount$/, '').endsWith('-fail')) {
    throw new Error(`fake fs host: forced ${op} failure for '${name}'`);
  }
}

function unitField(text: string, field: 'What' | 'Where'): string | undefined {
  const m = new RegExp(`^${field}=(.*)$`, 'm').exec(text);
  return m?.[1];
}

/** Test-support accessors beyond the FsHost contract. */
export interface FakeFsHostHandle {
  ops(): string[];
  seedBlkid(device: string, info: BlkidInfo): void;
  seedDeviceSize(device: string, bytes: number): void;
  unitText(name: string): string | undefined;
}

export function createFakeFsHost(dir: string): FsHost & FakeFsHostHandle {
  return {
    // ---- test-support handle ----
    ops(): string[] {
      return load(dir).ops;
    },
    seedBlkid(device: string, info: BlkidInfo): void {
      const state = load(dir);
      state.blkid[device] = info;
      save(dir, state);
    },
    seedDeviceSize(device: string, bytes: number): void {
      const state = load(dir);
      state.device_sizes[device] = bytes;
      save(dir, state);
    },
    unitText(name: string): string | undefined {
      return load(dir).units[name];
    },

    // ---- FsHost ----
    async blkid(device: string): Promise<BlkidInfo | null> {
      return load(dir).blkid[device] ?? null;
    },

    async blockdevSize(device: string): Promise<number> {
      const state = load(dir);
      state.ops.push(`blockdevSize:${device}`);
      save(dir, state);
      return state.device_sizes[device] ?? DEFAULT_DEVICE_SIZE;
    },

    async mkfsXfs(args: string[]): Promise<void> {
      const device = args[args.length - 1] ?? '';
      failHook(device, 'mkfs');
      const state = load(dir);
      state.ops.push(`mkfs.xfs ${args.join(' ')}`);
      const labelIdx = args.indexOf('-L');
      const label = labelIdx >= 0 ? args[labelIdx + 1] : undefined;
      const leaf = device.split('/').pop() ?? device;
      state.blkid[device] = {
        fstype: 'xfs',
        ...(label !== undefined ? { label } : {}),
        uuid: `uuid-${leaf}`,
      };
      save(dir, state);
    },

    async growfs(mountpoint: string): Promise<void> {
      failHook(mountpoint, 'growfs');
      const state = load(dir);
      state.ops.push(`xfs_growfs ${mountpoint}`);
      const cur = state.statfs[mountpoint] ?? { ...DEFAULT_STATFS };
      state.statfs[mountpoint] = {
        size_bytes: cur.size_bytes + 1024 ** 3,
        free_bytes: cur.free_bytes + 1024 ** 3,
      };
      save(dir, state);
    },

    async writeUnit(name: string, text: string): Promise<void> {
      const state = load(dir);
      state.ops.push(`writeUnit:${name}`);
      state.units[name] = text;
      save(dir, state);
    },

    async readUnit(name: string): Promise<string | null> {
      return load(dir).units[name] ?? null;
    },

    async removeUnit(name: string): Promise<void> {
      const state = load(dir);
      state.ops.push(`removeUnit:${name}`);
      delete state.units[name];
      save(dir, state);
    },

    async daemonReload(): Promise<void> {
      const state = load(dir);
      state.ops.push('daemon-reload');
      save(dir, state);
    },

    async enableNow(name: string): Promise<void> {
      failHook(name, 'enableNow');
      const state = load(dir);
      state.ops.push(`enableNow:${name}`);
      if (state.units[name] === undefined) {
        throw new Error(`fake fs host: no unit '${name}'`);
      }
      if (!state.mounted.includes(name)) state.mounted.push(name);
      const where = unitField(state.units[name] ?? '', 'Where');
      if (where !== undefined && state.statfs[where] === undefined) {
        state.statfs[where] = { ...DEFAULT_STATFS };
      }
      save(dir, state);
    },

    async stop(name: string): Promise<void> {
      if (name.endsWith('-busy.mount')) {
        throw new Error(`fake fs host: ${name} is busy (EBUSY)`);
      }
      const state = load(dir);
      state.ops.push(`stop:${name}`);
      state.mounted = state.mounted.filter((m) => m !== name);
      save(dir, state);
    },

    async disable(name: string): Promise<void> {
      const state = load(dir);
      state.ops.push(`disable:${name}`);
      save(dir, state);
    },

    async readMounts(): Promise<Array<{ source: string; mountpoint: string }>> {
      const state = load(dir);
      return state.mounted.flatMap((name) => {
        const text = state.units[name];
        if (text === undefined) return [];
        const source = unitField(text, 'What');
        const mountpoint = unitField(text, 'Where');
        return source !== undefined && mountpoint !== undefined ? [{ source, mountpoint }] : [];
      });
    },

    async statfs(mountpoint: string): Promise<{ size_bytes: number; free_bytes: number }> {
      const entry = load(dir).statfs[mountpoint];
      if (!entry) throw new Error(`fake fs host: ${mountpoint} is not mounted`);
      return entry;
    },

    async applyOwnerPolicy(mountpoint: string, policy: OwnerPolicy): Promise<void> {
      const state = load(dir);
      state.ops.push(`ownerPolicy:${mountpoint}:${JSON.stringify(policy)}`);
      save(dir, state);
    },
  };
}

/** Every verb throws — partial test fakes spread this (the S4 pattern). */
export function makeUnimplementedFsHost(): FsHost {
  const unused = (verb: string) => async (): Promise<never> => {
    throw new Error(`unimplemented test fs host verb: ${verb}`);
  };
  return {
    blkid: unused('blkid'),
    blockdevSize: unused('blockdevSize'),
    mkfsXfs: unused('mkfsXfs'),
    growfs: unused('growfs'),
    writeUnit: unused('writeUnit'),
    readUnit: unused('readUnit'),
    removeUnit: unused('removeUnit'),
    daemonReload: unused('daemonReload'),
    enableNow: unused('enableNow'),
    stop: unused('stop'),
    disable: unused('disable'),
    readMounts: unused('readMounts'),
    statfs: unused('statfs'),
    applyOwnerPolicy: unused('applyOwnerPolicy'),
  };
}
