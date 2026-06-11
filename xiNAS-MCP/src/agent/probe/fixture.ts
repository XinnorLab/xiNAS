/**
 * Fixture probe mode (J3).
 *
 * When `XINAS_AGENT_PROBE_MODE=fixture:<dir>` is set, the convergence wiring
 * (convergence.ts) builds these fixture-backed probes INSTEAD of the real
 * privileged probes. Each fixture probe exposes the SAME methods the
 * convergence adapter calls on its real counterpart, so the existing E-phase
 * collector adapters consume it unchanged — the deltas flow through the same
 * collectors → publisher path and land at the api exactly as a real
 * observation would (now that inbound validation is type-only, the partial
 * fixture shapes are accepted).
 *
 * Data is parsed from `<dir>/<file>.json`:
 *   - disk  → disks.json     (lsblk --json shape) via parseLsblkOutput
 *   - users → users.json     (array of passwd-ish records) → ParsedPasswdLine[]
 *   - idmap → nfs-idmap.json  (IdmapSnapshot shape) returned directly
 *   - nfs-profile → nfs-profile.json (NfsProfileSnapshot shape) returned directly
 *
 * All OTHER probes (network, filesystem, nfs, inventory) return empty/minimal
 * snapshots in fixture mode; the e2e suite only asserts users, disks, and
 * nfs-idmap. Every fixture probe's event-stream / watch handle is a no-op (no
 * subprocesses are spawned in fixture mode).
 *
 * The return types are the NARROW shapes the convergence adapters consume
 * (e.g. the NFS adapter only calls listSessions/listExports), not the full
 * real-probe interfaces — fixture mode does not need the unused methods.
 *
 * Privileged-layer sibling: lives under src/agent/probe/ but performs only a
 * synchronous readFileSync of a test-controlled directory — no system calls.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ObservedDisk, parseLsblkOutput } from '../../lib/parse/disk.js';
import { parseIpJson } from '../../lib/parse/network.js';
import type { ParsedPasswdLine } from '../../lib/parse/passwd.js';
import { createFakeNetHost } from '../net/fake-host.js';
import type { IdmapSnapshot } from './idmap.js';
import {
  type NetplanSummary,
  type NetworkSnapshotRow,
  enrichNetworkRows,
  summarizeNetplan,
} from './network.js';
import type { NfsProfileSnapshot } from './nfs-profile.js';
import type { MonitorHandle } from './subprocess-monitor.js';

/** A no-op MonitorHandle for fixture mode (no subprocess to stop). */
const NOOP_MONITOR: MonitorHandle = { stop: () => Promise.resolve() };

/** Returns the fixture directory when XINAS_AGENT_PROBE_MODE=fixture:<dir>, else null. */
export function fixtureDir(): string | null {
  const mode = process.env['XINAS_AGENT_PROBE_MODE'];
  if (typeof mode === 'string' && mode.startsWith('fixture:')) {
    return mode.slice('fixture:'.length);
  }
  return null;
}

function readFixture<T>(dir: string, file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
  } catch {
    // Missing/malformed fixture is non-fatal: the probe degrades to the
    // fallback (usually empty) so the agent still boots in fixture mode.
    return fallback;
  }
}

// --- Narrow probe shapes (exactly what the convergence adapters call). ---

interface FixtureDiskProbe {
  snapshot(): Promise<ObservedDisk[]>;
  startEventStream(onDelta: (delta: { action: string; devname: string }) => void): MonitorHandle;
}

interface FixtureUsersProbe {
  getentPasswd(): Promise<ParsedPasswdLine[]>;
  getentGroup(): Promise<{ gid: number; name: string; members: string[] }[]>;
}

interface FixtureIdmapProbe {
  snapshot(): Promise<IdmapSnapshot>;
}

interface FixtureNfsProfileProbe {
  snapshot(): Promise<NfsProfileSnapshot>;
}

interface FixtureNetworkProbe {
  snapshot(): Promise<NetworkSnapshotRow[]>;
  netplanSummary(): Promise<NetplanSummary | undefined>;
  startEventStream(onDelta: (iface: never) => void): MonitorHandle;
}

/** An entry in <dir>/filesystems.json — the collector's observed shape. */
export interface FixtureFilesystem {
  kind: 'Filesystem';
  id: string;
  status: Record<string, unknown>;
}

interface FixtureFilesystemProbe {
  snapshot(): Promise<FixtureFilesystem[]>;
}

/** Entries for <dir>/nfs-sessions.json (parse/nfs ObservedNfsSession shape). */
export interface FixtureNfsSession {
  kind: 'NfsSession';
  id: string;
  spec: { client_addr: string; export_path: string; client_hostname?: string };
  status: { proto_version: string; locked_files: number };
}

/** Entries for <dir>/nfs-exports.json (parse/nfs ObservedExportRule shape). */
export interface FixtureExportRule {
  export_path: string;
  host_pattern: string;
  options: string[];
}

interface FixtureNfsProbe {
  listSessions(): Promise<FixtureNfsSession[]>;
  listExports(): Promise<FixtureExportRule[]>;
}

interface FixtureInventoryProbe {
  snapshot(): Promise<{
    hostname: string;
    cpu: { model?: string; cores?: number; threads: number; arch: string };
    memory: { total_kb: number; available_kb: number; swap_total_kb: number };
    os: { type: string; kernel: string; uptime_seconds: number };
    observed_at: string;
  }>;
}

/** Tuning: reads <dir>/tuning.json ({entries: [{key, expected, actual}]}); absent → empty. */
export function createFixtureTuningProbe(dir: string): {
  snapshot(): Promise<{ entries: Array<{ key: string; expected: string; actual: string | null }> }>;
} {
  return {
    snapshot: () =>
      Promise.resolve(
        readFixture<{ entries: Array<{ key: string; expected: string; actual: string | null }> }>(
          dir,
          'tuning.json',
          { entries: [] },
        ),
      ),
  };
}

/** Disk: parse disks.json (lsblk shape) through the same parser the real probe uses. */
export function createFixtureDiskProbe(dir: string): FixtureDiskProbe {
  return {
    snapshot(): Promise<ObservedDisk[]> {
      const raw = readFixture<unknown>(dir, 'disks.json', { blockdevices: [] });
      // disks.json is stored as an object; re-stringify so parseLsblkOutput
      // (which takes the raw lsblk JSON string) can parse it uniformly.
      return Promise.resolve(parseLsblkOutput(JSON.stringify(raw)));
    },
    startEventStream(): MonitorHandle {
      return NOOP_MONITOR;
    },
  };
}

/** A passwd-ish fixture record (subset of /etc/passwd fields). */
interface FixturePasswdRecord {
  name: string;
  uid: number;
  gid: number;
  gecos?: string;
  home?: string;
  shell?: string;
}

/** Users: parse users.json into ParsedPasswdLine[]; groups empty (e2e asserts users only). */
export function createFixtureUsersProbe(dir: string): FixtureUsersProbe {
  return {
    getentPasswd(): Promise<ParsedPasswdLine[]> {
      const rows = readFixture<FixturePasswdRecord[]>(dir, 'users.json', []);
      return Promise.resolve(
        rows.map((u) => ({
          name: u.name,
          uid: u.uid,
          gid: u.gid,
          gecos: u.gecos ?? '',
          home: u.home ?? '',
          shell: u.shell ?? '',
        })),
      );
    },
    getentGroup(): Promise<{ gid: number; name: string; members: string[] }[]> {
      return Promise.resolve([]);
    },
  };
}

/** Idmap: return nfs-idmap.json directly (IdmapSnapshot shape). */
export function createFixtureIdmapProbe(dir: string): FixtureIdmapProbe {
  return {
    snapshot(): Promise<IdmapSnapshot> {
      return Promise.resolve(
        readFixture<IdmapSnapshot>(dir, 'nfs-idmap.json', {
          conf_present: false,
          idmapd_active: false,
          idmapd_unit_state: 'unknown',
        }),
      );
    },
  };
}

/** NfsProfile: return nfs-profile.json directly (NfsProfileSnapshot shape,
 *  including the optional `running` section when the fixture carries one);
 *  absent fixture → empty effective_files, no running (the boot sweep must
 *  not crash). */
export function createFixtureNfsProfileProbe(dir: string): FixtureNfsProfileProbe {
  return {
    snapshot(): Promise<NfsProfileSnapshot> {
      return Promise.resolve(
        readFixture<NfsProfileSnapshot>(dir, 'nfs-profile.json', { effective_files: {} }),
      );
    },
  };
}

/**
 * Network: reads the FAKE NetHost state (<dir>/net-host-state.json) so
 * observe and the S6 executors share ONE source of truth — executor
 * effects (flushes, applies) become visible to the collector in e2e.
 * Runs the SAME parse/enrich code as the real probe. No dir → empty.
 */
export function createFixtureNetworkProbe(dir?: string): FixtureNetworkProbe {
  if (dir === undefined) {
    return {
      snapshot: () => Promise.resolve([]),
      netplanSummary: () => Promise.resolve(undefined),
      startEventStream: () => NOOP_MONITOR,
    };
  }
  const host = createFakeNetHost(dir);
  return {
    snapshot: async () => {
      const base = parseIpJson(await host.ipAddrShow());
      return enrichNetworkRows(
        base,
        await host.listSysClassNet(),
        await host.readNetplanDir(),
        await host.rdmaLinkShow(),
      );
    },
    netplanSummary: async () => {
      try {
        return summarizeNetplan(await host.readNetplanDir());
      } catch {
        return undefined;
      }
    },
    startEventStream: () => NOOP_MONITOR,
  };
}

/**
 * Filesystem: reads <dir>/filesystems.json (entries in the collector's
 * observed shape: { kind:'Filesystem', id, status: { backing_device,
 * mountpoint, mounted, ... } }), defaulting to empty — S4 T11
 * so the e2e can seed a dependent filesystem that the collector's
 * complete-snapshot sweep will NOT wipe.
 */
export function createFixtureFilesystemProbe(dir?: string): FixtureFilesystemProbe {
  return {
    snapshot: () =>
      Promise.resolve(
        dir !== undefined ? readFixture<FixtureFilesystem[]>(dir, 'filesystems.json', []) : [],
      ),
  };
}

/**
 * NFS: reads <dir>/nfs-sessions.json + <dir>/nfs-exports.json (the
 * collectors' real shapes), defaulting to empty — S5 T6 so the e2e can
 * PROVE the unmount blockers (`dependent_share_active` +
 * `mountpoint_exported`) against seeded state; an always-empty fixture
 * would let the milestone blockers pass untested.
 */
export function createFixtureNfsProbe(dir?: string): FixtureNfsProbe {
  return {
    listSessions: () =>
      Promise.resolve(
        dir !== undefined ? readFixture<FixtureNfsSession[]>(dir, 'nfs-sessions.json', []) : [],
      ),
    listExports: () =>
      Promise.resolve(
        dir !== undefined ? readFixture<FixtureExportRule[]>(dir, 'nfs-exports.json', []) : [],
      ),
  };
}

/** Inventory: a minimal but well-typed snapshot (no /proc reads in fixture mode). */
export function createFixtureInventoryProbe(): FixtureInventoryProbe {
  return {
    snapshot: () =>
      Promise.resolve({
        hostname: 'fixture-host',
        cpu: { threads: 0, arch: 'x86_64' },
        memory: { total_kb: 0, available_kb: 0, swap_total_kb: 0 },
        os: { type: 'linux', kernel: '0.0.0-fixture', uptime_seconds: 0 },
        observed_at: new Date().toISOString(),
      }),
  };
}
