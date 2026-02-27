/**
 * system.* MCP tools.
 */

import { z } from 'zod';
import { loadConfig, getHostname } from '../config/serverConfig.js';
import { resolveController } from '../server/controllerResolver.js';
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

// --- Handlers ---

export function handleGetServerInfo(_params: z.infer<typeof GetServerInfoSchema>) {
  const config = loadConfig();
  return {
    name: 'xinas-mcp',
    version: '0.1.0',
    controller_id: config.controller_id,
    supported_namespaces: ['system', 'network', 'health', 'disk', 'raid', 'share', 'auth', 'job'],
    transport: 'stdio',
    sse_enabled: config.sse_enabled,
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
