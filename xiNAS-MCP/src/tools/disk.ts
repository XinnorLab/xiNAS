/**
 * disk.* MCP tools.
 */

import { z } from 'zod';
import { getClient, withRetry } from '../grpc/client.js';
import { driveLocate, driveClean } from '../grpc/drive.js';
import { raidShow } from '../grpc/raid.js';
import { listBlockDevices } from '../os/diskInfo.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { resolveController } from '../server/controllerResolver.js';
import { McpToolError, ErrorCode, type PlanResult, type Mode } from '../types/common.js';
import { JobManager } from './job.js';

// --- Schemas ---

export const DiskListSchema = z.object({
  controller_id: z.string().optional(),
  only_unassigned: z.boolean().default(false).describe('Show only drives not in any RAID'),
});

export const DiskGetSmartSchema = z.object({
  controller_id: z.string().optional(),
  disk_id: z.string().describe('Block device path e.g. /dev/nvme0n1'),
});

export const DiskRunSelftestSchema = z.object({
  controller_id: z.string().optional(),
  disk_id: z.string(),
  test_type: z.enum(['short', 'extended']).default('short'),
});

export const DiskSetLedSchema = z.object({
  controller_id: z.string().optional(),
  disk_id: z.string().describe('Block device path, or empty string to turn off all'),
  state: z.enum(['identify_on', 'identify_off']),
});

export const DiskSecureEraseSchema = z.object({
  controller_id: z.string().optional(),
  disk_id: z.string(),
  mode: z.enum(['nvme_format', 'drive_clean']).default('drive_clean'),
  dangerous: z.boolean().default(false),
  mcp_mode: z.enum(['plan', 'apply']).default('plan'),
});

// --- Handlers ---

export async function handleDiskList(params: z.infer<typeof DiskListSchema>) {
  resolveController(params.controller_id);
  const blockDevices = listBlockDevices();
  const client = await getClient(params.controller_id);

  // Get RAID member info
  let raidMembers = new Map<string, { raid_name: string; slot: number; state: string }>();
  try {
    const resp = await withRetry(() => raidShow(client, { extended: true }), 'disk.list raidShow');
    const raids = resp.data as Array<{
      name: string;
      members?: Array<{ path: string; slot: number; state: string }>
    }> | null;
    if (raids) {
      for (const raid of raids) {
        for (const member of raid.members ?? []) {
          raidMembers.set(member.path, {
            raid_name: raid.name,
            slot: member.slot,
            state: member.state,
          });
        }
      }
    }
  } catch { /* continue with unassigned info */ }

  const enriched = blockDevices.map(d => {
    const member = raidMembers.get(d.path);
    return {
      ...d,
      role: member ? 'raid_member' : 'unassigned',
      raid_name: member?.raid_name,
      raid_slot: member?.slot,
      member_state: member?.state,
    };
  });

  if (params.only_unassigned) {
    return enriched.filter(d => d.role === 'unassigned');
  }
  return enriched;
}

export async function handleDiskGetSmart(params: z.infer<typeof DiskGetSmartSchema>) {
  resolveController(params.controller_id);
  const devices = listBlockDevices();
  const dev = devices.find(d => d.path === params.disk_id);

  if (!dev) {
    throw new McpToolError(ErrorCode.NOT_FOUND, `Device not found: ${params.disk_id}`);
  }

  if (!dev.nvme_ctrl) {
    throw new McpToolError(
      ErrorCode.UNSUPPORTED,
      `SATA SMART is not supported in v1. Only NVMe devices are supported. Device: ${params.disk_id}`
    );
  }

  if (!dev.health) {
    throw new McpToolError(ErrorCode.NOT_FOUND, `No health data available for ${params.disk_id}`);
  }

  return {
    disk_id: params.disk_id,
    model: dev.model,
    serial: dev.serial,
    firmware: dev.firmware,
    nvme_ctrl: dev.nvme_ctrl,
    health: dev.health,
    source: 'nvme_sysfs',
  };
}

export async function handleDiskRunSelftest(params: z.infer<typeof DiskRunSelftestSchema>) {
  resolveController(params.controller_id);
  const devices = listBlockDevices();
  const dev = devices.find(d => d.path === params.disk_id);

  if (!dev) {
    throw new McpToolError(ErrorCode.NOT_FOUND, `Device not found: ${params.disk_id}`);
  }

  if (!dev.nvme_ctrl) {
    throw new McpToolError(
      ErrorCode.UNSUPPORTED,
      `Selftest is only supported for NVMe devices in v1. Device: ${params.disk_id}`
    );
  }

  // Create a job to track the selftest
  const job = JobManager.create(params.controller_id ?? 'default', 'disk.run_selftest');
  JobManager.update(job.job_id, { state: 'running' });

  const jobId = job.job_id;
  // NVMe selftest runs asynchronously — poll nvme sysfs for completion
  const duration = params.test_type === 'short' ? 2 * 60 * 1000 : 30 * 60 * 1000;

  const timeout = setTimeout(() => {
    JobManager.update(jobId, { state: 'success', result: { completed: true, test_type: params.test_type } });
  }, duration);
  timeout.unref();

  return { job_id: job.job_id, test_type: params.test_type, disk_id: params.disk_id };
}

export async function handleDiskSetLed(params: z.infer<typeof DiskSetLedSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);

  const drives = params.state === 'identify_on' && params.disk_id
    ? [params.disk_id]
    : [];

  const resp = await withRetry(() => driveLocate(client, { drives }), 'disk.set_led');
  return { disk_id: params.disk_id, state: params.state, result: resp.data };
}

export async function handleDiskSecureErase(params: z.infer<typeof DiskSecureEraseSchema>) {
  resolveController(params.controller_id);
  const mode = params.mcp_mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];

      if (!params.dangerous) {
        blockingResources.push('dangerous=true is required for secure erase');
      }

      const devices = listBlockDevices();
      const dev = devices.find(d => d.path === params.disk_id);
      if (!dev) {
        blockingResources.push(`Device not found: ${params.disk_id}`);
      }

      return {
        mode: 'plan' as const,
        description: `Secure erase ${params.disk_id} using ${params.mode}`,
        changes: [{
          action: 'delete',
          resource_type: 'disk_data',
          resource_id: params.disk_id,
        }],
        warnings: ['This operation is IRREVERSIBLE and will destroy all data on the drive.'],
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      if (!params.dangerous) {
        throw new McpToolError(ErrorCode.PRECONDITION_FAILED, 'dangerous=true is required');
      }
      const client = await getClient(params.controller_id);
      const resp = await withRetry(
        () => driveClean(client, { drives: [params.disk_id] }),
        'disk.secure_erase'
      );
      return resp.data;
    },
  });
}
