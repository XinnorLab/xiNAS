/**
 * Network probe — privileged layer.
 *
 * snapshot()         → runs `ip -j addr show` via execFile → parseIpJson
 * startEventStream() → spawns `ip -j monitor link addr`; each JSON-array
 *                      line (one batch per event) → parseIpJson; fires
 *                      onDelta per interface in the batch.
 *
 * Injectable dependencies for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { type ExecFileOptions, execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type NetplanStanza, netplanHashes, parseNetplanFiles } from '../../lib/parse/netplan.js';
import { type ObservedNetworkInterface, parseIpJson } from '../../lib/parse/network.js';
import { createRealNetHost } from '../net/host.js';
import { type MonitorHandle, type MonitorOptions, startMonitor } from './subprocess-monitor.js';

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

type SpawnMonitorFn = (opts: MonitorOptions) => MonitorHandle;

/** Enrichment deps (S6 T5): netplan files + driver classification + rdma. */
export interface NetEnrichDeps {
  readNetplanDir(): Promise<Record<string, string>>;
  listSysClassNet(): Promise<Array<{ name: string; driver: string }>>;
  rdmaLinkShow(): Promise<string>;
}

interface NetworkProbeOptions {
  execFile?: ExecFileFn;
  spawnMonitor?: SpawnMonitorFn;
  enrich?: NetEnrichDeps;
}

/** Per-iface enrichment + the NetworkConfig singleton summary (ADR-0008). */
export interface NetplanSummary {
  files: Record<string, string>; // path → sha256
  world_config_hash: string;
  xinas_file_hash: string;
  duplicates: Record<string, string[]>;
}

export interface NetworkSnapshotRow extends ObservedNetworkInterface {
  status: ObservedNetworkInterface['status'] & {
    driver?: string;
    rdma_capable?: boolean;
    rdma_link_state?: 'up' | 'down' | 'unknown';
    current_addresses?: string[];
    owning_netplan_file?: string;
    duplicates_detected_in?: string[];
    netplan?: { addresses: string[]; mtu?: number; pbr_table_id?: number };
  };
}

export interface NetworkProbe {
  snapshot(): Promise<NetworkSnapshotRow[]>;
  startEventStream(onDelta: (iface: ObservedNetworkInterface) => void): MonitorHandle;
  /** The NetworkConfig/default singleton's content (undefined on failure). */
  netplanSummary(): Promise<NetplanSummary | undefined>;
}

/**
 * Pure enrichment shared by the real and fixture probes: overlays
 * driver/rdma/netplan facts onto base ip-json rows. Each input degrades
 * independently (missing sysfs/rdma/netplan data drops fields, never rows).
 */
export function enrichNetworkRows(
  base: ObservedNetworkInterface[],
  sysClassNet: Array<{ name: string; driver: string }>,
  netplanFiles: Record<string, string>,
  rdmaJson: string,
): NetworkSnapshotRow[] {
  const driverByName = new Map(sysClassNet.map((e) => [e.name, e.driver]));
  const parsed = parseNetplanFiles(netplanFiles);

  let rdmaByIfname = new Map<string, { state?: string; physical_state?: string }>();
  let rdmaAvailable = false;
  try {
    const entries = rdmaJson.trim().length > 0 ? (JSON.parse(rdmaJson) as unknown) : null;
    if (Array.isArray(entries)) {
      rdmaAvailable = true;
      rdmaByIfname = new Map(
        entries
          .filter(
            (
              e,
            ): e is { ifname?: string; netdev?: string; state?: string; physical_state?: string } =>
              typeof e === 'object' && e !== null,
          )
          .map((e) => [(e.netdev ?? e.ifname ?? '') as string, e]),
      );
    }
  } catch {
    /* degraded: rdma_link_state stays unknown */
  }

  return base.map((iface) => {
    const driver = driverByName.get(iface.id);
    const rdmaCapable = driver !== undefined ? driver.includes('mlx') : undefined;
    const rdma = rdmaByIfname.get(iface.id);
    const rdmaState: 'up' | 'down' | 'unknown' = !rdmaAvailable
      ? 'unknown'
      : rdma !== undefined &&
          `${rdma.state ?? ''}`.toUpperCase() === 'ACTIVE' &&
          `${rdma.physical_state ?? ''}`.toUpperCase() === 'LINK_UP'
        ? 'up'
        : 'down';
    const stanza: NetplanStanza | undefined = parsed.stanzas[iface.id];
    const duplicates = parsed.duplicates[iface.id];
    return {
      ...iface,
      status: {
        ...iface.status,
        ...(driver !== undefined ? { driver } : {}),
        ...(rdmaCapable !== undefined ? { rdma_capable: rdmaCapable } : {}),
        ...(rdmaCapable === true ? { rdma_link_state: rdmaState } : {}),
        current_addresses: [...iface.status.ip4_addresses, ...iface.status.ip6_addresses],
        ...(stanza !== undefined
          ? {
              owning_netplan_file: stanza.file,
              netplan: {
                addresses: stanza.addresses,
                ...(stanza.mtu !== undefined ? { mtu: stanza.mtu } : {}),
                ...(stanza.pbr_table_id !== undefined ? { pbr_table_id: stanza.pbr_table_id } : {}),
              },
            }
          : {}),
        duplicates_detected_in: duplicates ?? [],
      },
    };
  });
}

/** Hash map + summary for the NetworkConfig singleton. */
export function summarizeNetplan(files: Record<string, string>): NetplanSummary {
  const hashes = netplanHashes(files);
  const fileHashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    fileHashes[path] = createHash('sha256').update(text, 'utf8').digest('hex');
  }
  return {
    files: fileHashes,
    world_config_hash: hashes.world_config_hash,
    xinas_file_hash: hashes.xinas_file_hash,
    duplicates: parseNetplanFiles(files).duplicates,
  };
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

export function createNetworkProbe(opts: NetworkProbeOptions = {}): NetworkProbe {
  const ef = opts.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const spawnMon = opts.spawnMonitor ?? startMonitor;
  const enrich: NetEnrichDeps = opts.enrich ?? createRealNetHost();

  return {
    async snapshot(): Promise<NetworkSnapshotRow[]> {
      const stdout = await execFilePromise(ef, 'ip', ['-j', 'addr', 'show'], {});
      const base = parseIpJson(stdout);
      // Each enrichment source degrades independently (S5-T6 pattern).
      let sysClassNet: Array<{ name: string; driver: string }> = [];
      let netplanFiles: Record<string, string> = {};
      let rdmaJson = '';
      try {
        sysClassNet = await enrich.listSysClassNet();
      } catch {
        /* degraded: no driver/rdma_capable */
      }
      try {
        netplanFiles = await enrich.readNetplanDir();
      } catch {
        /* degraded: no netplan stanza/duplicates */
      }
      try {
        rdmaJson = await enrich.rdmaLinkShow();
      } catch {
        /* degraded: rdma_link_state unknown */
      }
      return enrichNetworkRows(base, sysClassNet, netplanFiles, rdmaJson);
    },

    async netplanSummary(): Promise<NetplanSummary | undefined> {
      try {
        return summarizeNetplan(await enrich.readNetplanDir());
      } catch {
        return undefined;
      }
    },

    startEventStream(onDelta: (iface: ObservedNetworkInterface) => void): MonitorHandle {
      return spawnMon({
        cmd: 'ip',
        args: ['-j', 'monitor', 'link', 'addr'],
        onLine(line) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return;
          try {
            // ip -j monitor emits one JSON array per event batch
            const normalized = trimmed.startsWith('{') ? `[${trimmed}]` : trimmed;
            const ifaces = parseIpJson(normalized);
            for (const iface of ifaces) onDelta(iface);
          } catch {
            // partial / malformed line — skip
          }
        },
        onError(err) {
          process.stderr.write(
            JSON.stringify({
              level: 'warn',
              subsystem: 'network-probe',
              event: 'monitor-error',
              error: err.message,
            }) + '\n',
          );
        },
      });
    },
  };
}
