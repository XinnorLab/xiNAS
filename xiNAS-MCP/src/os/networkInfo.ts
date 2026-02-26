/**
 * Network interface info from sysfs/procfs — no subprocesses.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface InterfaceInfo {
  name: string;
  mac: string;
  mtu: number;
  operstate: string;
  speed_mbps: number | null;
  duplex: string | null;
  ipv4_addresses: string[];
  ipv6_addresses: string[];
  rx_bytes: number;
  tx_bytes: number;
  rx_errors: number;
  tx_errors: number;
  rx_dropped: number;
  tx_dropped: number;
  is_rdma: boolean;
  bond_mode?: string;
  bond_members?: string[];
}

function readFile(p: string): string {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

function listDir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}

/** Parse /proc/net/dev — returns map of iface -> {rx_bytes, tx_bytes, ...} */
function parseNetDev(): Map<string, {
  rx_bytes: number; rx_errors: number; rx_dropped: number;
  tx_bytes: number; tx_errors: number; tx_dropped: number;
}> {
  const result = new Map<string, ReturnType<typeof parseNetDev> extends Map<string, infer V> ? V : never>();
  const content = readFile('/proc/net/dev');
  for (const line of content.split('\n').slice(2)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 17) continue;
    const iface = parts[0]?.replace(':', '');
    if (!iface) continue;
    result.set(iface, {
      rx_bytes: parseInt(parts[1] ?? '0'),
      rx_errors: parseInt(parts[3] ?? '0'),
      rx_dropped: parseInt(parts[4] ?? '0'),
      tx_bytes: parseInt(parts[9] ?? '0'),
      tx_errors: parseInt(parts[11] ?? '0'),
      tx_dropped: parseInt(parts[12] ?? '0'),
    });
  }
  return result;
}

/** Parse /proc/net/fib_trie for IPv4 addresses (simplified) */
function parseIPv4Addresses(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  // Use /proc/net/if_inet6 equivalent for IPv4: read from /proc/net/fib_trie
  // Simpler: read ip addresses from /proc/net/tcp if available, but
  // the most reliable source is /proc/net/fib_trie. For simplicity,
  // we parse sysfs interface address files if they exist.
  // Modern kernels: /sys/class/net/<iface>/address exists, but not IP.
  // Best approach: parse ip addr output—but we can't run subprocesses.
  // Fallback: attempt to read from /proc/net/fib_trie (complex)
  // For v1, return empty — IPv4 will be enriched if available
  return result;
}

/** Check if an interface has RDMA capability */
function hasRdma(ifaceName: string): boolean {
  // Check /sys/class/infiniband/ for an entry that corresponds to this iface
  const ibDir = '/sys/class/infiniband';
  const entries = listDir(ibDir);
  for (const entry of entries) {
    // The net device can be found under /sys/class/infiniband/<dev>/device/net/
    const netPath = `/sys/class/infiniband/${entry}/device/net`;
    const nets = listDir(netPath);
    if (nets.includes(ifaceName)) return true;
  }
  return false;
}

/** Parse bond info from /proc/net/bonding/<iface> */
function parseBondInfo(ifaceName: string): { mode: string; members: string[] } | null {
  const bondFile = `/proc/net/bonding/${ifaceName}`;
  const content = readFile(bondFile);
  if (!content) return null;

  const modeMatch = content.match(/Bonding Mode:\s*(.+)/);
  const members: string[] = [];
  for (const m of content.matchAll(/Slave Interface:\s*(\S+)/g)) {
    members.push(m[1] ?? '');
  }

  return {
    mode: modeMatch?.[1]?.trim() ?? 'unknown',
    members,
  };
}

export function listInterfaces(): InterfaceInfo[] {
  const netDir = '/sys/class/net';
  const interfaces = listDir(netDir);
  const netDevStats = parseNetDev();
  const result: InterfaceInfo[] = [];

  for (const iface of interfaces) {
    if (iface === 'lo') continue; // skip loopback

    const base = path.join(netDir, iface);
    const mac = readFile(path.join(base, 'address'));
    const mtu = parseInt(readFile(path.join(base, 'mtu')) || '1500');
    const operstate = readFile(path.join(base, 'operstate')) || 'unknown';
    const speedRaw = readFile(path.join(base, 'speed'));
    const speed_mbps = speedRaw && speedRaw !== '-1' ? parseInt(speedRaw) : null;
    const duplexRaw = readFile(path.join(base, 'duplex'));
    const duplex = duplexRaw || null;

    const stats = netDevStats.get(iface) ?? {
      rx_bytes: 0, rx_errors: 0, rx_dropped: 0,
      tx_bytes: 0, tx_errors: 0, tx_dropped: 0,
    };

    const bondInfo = parseBondInfo(iface);

    result.push({
      name: iface,
      mac,
      mtu,
      operstate,
      speed_mbps,
      duplex,
      ipv4_addresses: [], // enriched via other means
      ipv6_addresses: [],
      rx_bytes: stats.rx_bytes,
      tx_bytes: stats.tx_bytes,
      rx_errors: stats.rx_errors,
      tx_errors: stats.tx_errors,
      rx_dropped: stats.rx_dropped,
      tx_dropped: stats.tx_dropped,
      is_rdma: hasRdma(iface),
      ...(bondInfo ? { bond_mode: bondInfo.mode, bond_members: bondInfo.members } : {}),
    });
  }

  return result;
}
