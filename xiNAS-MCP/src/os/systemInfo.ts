/**
 * System info from procfs/sysfs. The only subprocess is `systemctl is-active`
 * in getServiceState — cgroup presence is unreliable for oneshot units
 * (e.g. nfs-server.service), so systemd is the authoritative source for unit state.
 */

import * as fs from 'fs';
import { execFileSync } from 'child_process';

export interface SystemInfo {
  uptime_seconds: number;
  load_avg: [number, number, number];
  memory: {
    total_kb: number;
    available_kb: number;
    cached_kb: number;
    used_pct: number;
  };
  cpu: {
    model: string;
    logical_cores: number;
    numa_nodes: number;
  };
  os: {
    name: string;
    version: string;
    kernel: string;
  };
}

function readFile(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function parseKeyValue(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

function parseOsRelease(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=');
    if (eq !== -1) {
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if (v.startsWith('"')) v = v.slice(1, -1);
      result[k] = v;
    }
  }
  return result;
}

export function getSystemInfo(): SystemInfo {
  // /proc/uptime: "uptime_secs idle_secs"
  const uptimeRaw = readFile('/proc/uptime').trim().split(' ');
  const uptime_seconds = parseFloat(uptimeRaw[0] ?? '0');

  // /proc/loadavg: "1min 5min 15min ..."
  const loadRaw = readFile('/proc/loadavg').trim().split(' ');
  const load_avg: [number, number, number] = [
    parseFloat(loadRaw[0] ?? '0'),
    parseFloat(loadRaw[1] ?? '0'),
    parseFloat(loadRaw[2] ?? '0'),
  ];

  // /proc/meminfo
  const memInfo = parseKeyValue(readFile('/proc/meminfo'));
  const totalKb = parseInt(memInfo['MemTotal'] ?? '0');
  const availKb = parseInt(memInfo['MemAvailable'] ?? '0');
  const cachedKb = parseInt(memInfo['Cached'] ?? '0');
  const usedPct = totalKb > 0 ? Math.round(((totalKb - availKb) / totalKb) * 100) : 0;

  // /proc/cpuinfo — get model and count physical cores
  const cpuinfo = readFile('/proc/cpuinfo');
  const modelMatch = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
  const processorLines = cpuinfo.match(/^processor\s*:/gm);
  const logical_cores = processorLines?.length ?? 1;
  const cpu_model = modelMatch?.[1]?.trim() ?? 'Unknown';

  // NUMA nodes
  let numa_nodes = 1;
  try {
    const numaDir = '/sys/devices/system/node';
    if (fs.existsSync(numaDir)) {
      const entries = fs.readdirSync(numaDir).filter(e => /^node\d+$/.test(e));
      if (entries.length > 0) numa_nodes = entries.length;
    }
  } catch { /* */ }

  // /etc/os-release
  const osRelease = parseOsRelease(readFile('/etc/os-release'));
  const osName = osRelease['PRETTY_NAME'] ?? osRelease['NAME'] ?? 'Linux';
  const osVersion = osRelease['VERSION_ID'] ?? '';

  // /proc/version
  const kernelLine = readFile('/proc/version').trim();
  const kernelMatch = kernelLine.match(/Linux version (\S+)/);
  const kernel = kernelMatch?.[1] ?? kernelLine.slice(0, 60);

  return {
    uptime_seconds,
    load_avg,
    memory: {
      total_kb: totalKb,
      available_kb: availKb,
      cached_kb: cachedKb,
      used_pct: usedPct,
    },
    cpu: {
      model: cpu_model,
      logical_cores,
      numa_nodes,
    },
    os: {
      name: osName,
      version: osVersion,
      kernel,
    },
  };
}

export interface ServiceState {
  name: string;
  active: boolean;
  state: string;
}

export interface NfsReadiness {
  ready: boolean;
  blocking: string[];
}

/**
 * Check that the NFS serving stack is operational:
 * 1. nfs-kernel-server package installed (exportfs binary exists)
 * 2. nfs-server.service active
 * 3. xinas-nfs-helper.service active
 */
export function checkNfsReadiness(): NfsReadiness {
  const blocking: string[] = [];

  if (!fs.existsSync('/usr/sbin/exportfs')) {
    blocking.push(
      'nfs-kernel-server package is not installed (missing /usr/sbin/exportfs)'
    );
  }

  const nfsServer = getServiceState('nfs-server');
  if (!nfsServer.active) {
    blocking.push(
      `nfs-server.service is ${nfsServer.state} — NFS daemon is not running`
    );
  }

  const helper = getServiceState('xinas-nfs-helper');
  if (!helper.active) {
    blocking.push(
      `xinas-nfs-helper.service is ${helper.state} — NFS helper daemon is not running`
    );
  }

  return { ready: blocking.length === 0, blocking };
}

/**
 * Check systemd unit state via `systemctl is-active`.
 *
 * Earlier versions used cgroup-presence as a proxy, but oneshot units with
 * RemainAfterExit=yes (notably nfs-server.service, whose ExecStart=rpc.nfsd
 * just kicks kernel threads and exits) leave no persistent userspace cgroup
 * and were falsely reported as inactive. `systemctl is-active` is the only
 * authoritative read; it does not require root and is fast enough for
 * preflight checks.
 */
export function getServiceState(serviceName: string): ServiceState {
  let state = 'unknown';
  try {
    state = execFileSync('systemctl', ['is-active', `${serviceName}.service`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch (err) {
    // is-active exits non-zero when not active; the state word is still on stdout.
    const stdout = (err as { stdout?: Buffer | string } | undefined)?.stdout;
    if (stdout) {
      state = (typeof stdout === 'string' ? stdout : stdout.toString('utf8')).trim();
    }
  }
  if (!state) state = 'unknown';
  const active = state === 'active' || state === 'reloading';
  return { name: serviceName, active, state };
}
