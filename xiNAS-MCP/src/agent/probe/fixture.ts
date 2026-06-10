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
import type { ParsedPasswdLine } from '../../lib/parse/passwd.js';
import type { IdmapSnapshot } from './idmap.js';
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
  snapshot(): Promise<never[]>;
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

interface FixtureNfsProbe {
  listSessions(): Promise<never[]>;
  listExports(): Promise<never[]>;
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

/** Network: empty snapshot, no-op event stream. */
export function createFixtureNetworkProbe(): FixtureNetworkProbe {
  return {
    snapshot: () => Promise.resolve([]),
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

/** NFS: empty exports + sessions. */
export function createFixtureNfsProbe(): FixtureNfsProbe {
  return {
    listSessions: () => Promise.resolve([]),
    listExports: () => Promise.resolve([]),
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
