/**
 * system.* MCP tools.
 */

import { z } from 'zod';
import { execFile } from 'node:child_process';
import { loadConfig, getHostname } from '../config/serverConfig.js';
import { resolveController } from '../server/controllerResolver.js';
import { McpToolError, ErrorCode } from '../types/common.js';
import { getClient, withRetry } from '../grpc/client.js';
import { settingsAuthShow, settingsScannerShow, settingsClusterShow } from '../grpc/settings.js';
import { licenseShow } from '../grpc/license.js';
import { getSystemInfo, getServiceState } from '../os/systemInfo.js';
import { listBlockDevices } from '../os/diskInfo.js';
import { listInterfaces } from '../os/networkInfo.js';
import { getPerformanceSummary, getAllMetrics } from '../os/prometheusClient.js';

// --- Schemas ---

export const GetServerInfoSchema = z.object({});

export const ListControllersSchema = z.object({});

export const GetControllerCapabilitiesSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID (defaults to local)'),
});

export const GetStatusSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID'),
});

export const GetInventorySchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID'),
});

export const GetPerformanceSchema = z.object({
  controller_id: z.string().optional(),
  target: z.string().default('*').describe('RAID name, disk path, or * for global'),
  metrics: z.array(z.string()).default([]).describe('Metric names to filter (empty = all)'),
});

export const GetLogsSchema = z.object({
  controller_id: z.string().optional(),
  service: z.string().optional().describe('Systemd unit name (e.g. nfs-kernel-server, xiraid-server)'),
  lines: z.number().int().min(1).max(500).default(50).describe('Number of journal lines to retrieve'),
  since: z.string().optional().describe('Time filter: ISO 8601 timestamp or relative (e.g. "-1h", "-30m")'),
  priority: z.number().int().min(0).max(7).optional().describe('Max syslog priority (0=emerg..7=debug)'),
});

// --- Handlers ---

export function handleGetServerInfo(_params: z.infer<typeof GetServerInfoSchema>) {
  const config = loadConfig();
  const port = config.http_port ?? config.sse_port ?? 8080;
  return {
    name: 'xinas-mcp',
    version: '0.1.0',
    controller_id: config.controller_id,
    supported_namespaces: ['system', 'network', 'health', 'disk', 'raid', 'share', 'auth', 'job'],
    transports: {
      stdio: true,
      sse: config.sse_enabled,
      streamable_http: config.http_enabled,
      ...(config.sse_enabled || config.http_enabled ? { port } : {}),
      tls: !!config.tls,
      mtls: !!(config.tls?.ca),
    },
  };
}

export function handleListControllers(_params: z.infer<typeof ListControllersSchema>) {
  const config = loadConfig();
  const ctrlInfo = resolveController();
  return [{
    controller_id: config.controller_id,
    hostname: getHostname(),
    grpc_endpoint: ctrlInfo.grpc_endpoint,
    nfs_socket: ctrlInfo.nfs_socket,
  }];
}

export async function handleGetControllerCapabilities(
  params: z.infer<typeof GetControllerCapabilitiesSchema>
) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);

  const [authResp, licResp] = await Promise.allSettled([
    withRetry(() => settingsAuthShow(client), 'settings_auth_show'),
    withRetry(() => licenseShow(client), 'license_show'),
  ]);

  return {
    grpc_auth_settings: authResp.status === 'fulfilled' ? authResp.value.data : null,
    license: licResp.status === 'fulfilled' ? licResp.value.data : null,
    supported_raid_levels: ['0', '1', '5', '6', '7', '10', '50', '60', '70', 'N+M'],
    supported_nfs_versions: ['3', '4', '4.1', '4.2'],
    rdma_capable: true,
    kerberos_capable: true,
    snapshot_capable: false,
  };
}

export async function handleGetStatus(params: z.infer<typeof GetStatusSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);

  const sysInfo = getSystemInfo();

  const [scannerResp, clusterResp, licResp] = await Promise.allSettled([
    withRetry(() => settingsScannerShow(client), 'settings_scanner_show'),
    withRetry(() => settingsClusterShow(client), 'settings_cluster_show'),
    withRetry(() => licenseShow(client), 'license_show'),
  ]);

  const services = ['xiraid-server', 'nfs-server', 'nfs-kernel-server', 'xinas-nfs-helper']
    .map(s => getServiceState(s));

  return {
    controller_id: loadConfig().controller_id,
    hostname: getHostname(),
    uptime_seconds: sysInfo.uptime_seconds,
    os: sysInfo.os,
    load_avg: sysInfo.load_avg,
    memory: sysInfo.memory,
    services,
    scanner_settings: scannerResp.status === 'fulfilled' ? scannerResp.value.data : null,
    cluster_settings: clusterResp.status === 'fulfilled' ? clusterResp.value.data : null,
    license: licResp.status === 'fulfilled' ? licResp.value.data : null,
    timestamp: new Date().toISOString(),
  };
}

export async function handleGetInventory(params: z.infer<typeof GetInventorySchema>) {
  resolveController(params.controller_id);
  const sysInfo = getSystemInfo();
  const blockDevices = listBlockDevices();
  const networkIfaces = listInterfaces();

  return {
    controller_id: loadConfig().controller_id,
    hostname: getHostname(),
    cpu: sysInfo.cpu,
    memory: sysInfo.memory,
    block_devices: blockDevices.map(d => ({
      path: d.path,
      model: d.model,
      serial: d.serial,
      size_bytes: d.size_bytes,
      rotational: d.rotational,
      nvme: !!d.nvme_ctrl,
    })),
    network_interfaces: networkIfaces.map(i => ({
      name: i.name,
      mac: i.mac,
      operstate: i.operstate,
      mtu: i.mtu,
      speed_mbps: i.speed_mbps,
      is_rdma: i.is_rdma,
    })),
  };
}

export async function handleGetPerformance(params: z.infer<typeof GetPerformanceSchema>) {
  resolveController(params.controller_id);

  if (params.metrics.length === 0) {
    const all = await getAllMetrics();
    return {
      target: params.target,
      samples: all.slice(0, 500), // cap response size
      fetched_at: new Date().toISOString(),
    };
  }

  return getPerformanceSummary(params.target, params.metrics);
}

const JOURNAL_TIMEOUT_MS = 15_000;

export async function handleGetLogs(params: z.infer<typeof GetLogsSchema>) {
  resolveController(params.controller_id);

  const args = ['--no-pager', '--output=json', '-n', params.lines.toString()];
  if (params.service) args.push('-u', params.service);
  if (params.since) args.push('--since', params.since);
  if (params.priority !== undefined) args.push('-p', params.priority.toString());

  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    execFile('journalctl', args, { timeout: JOURNAL_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && 'killed' in err && err.killed) {
        reject(new McpToolError(ErrorCode.TIMEOUT, 'journalctl timed out'));
        return;
      }
      const exitCode = err && 'code' in err ? (err.code as number) : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
    });
  });

  if (result.exitCode !== 0) {
    throw new McpToolError(ErrorCode.INTERNAL, `journalctl failed: ${result.stderr.trim()}`);
  }

  // Parse JSON-formatted journal entries
  const entries = result.stdout
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        const entry = JSON.parse(line) as Record<string, string | undefined>;
        return {
          timestamp: entry['__REALTIME_TIMESTAMP']
            ? new Date(parseInt(entry['__REALTIME_TIMESTAMP'], 10) / 1000).toISOString()
            : undefined,
          unit: entry['_SYSTEMD_UNIT'] ?? entry['SYSLOG_IDENTIFIER'],
          priority: entry['PRIORITY'],
          message: entry['MESSAGE'],
        };
      } catch {
        return { message: line };
      }
    });

  return {
    service: params.service ?? 'all',
    count: entries.length,
    entries,
    fetched_at: new Date().toISOString(),
  };
}
