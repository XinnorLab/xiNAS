/**
 * raid.* MCP tools.
 */

import { z } from 'zod';
import * as fs from 'fs';
import { getClient, withRetry } from '../grpc/client.js';
import { raidShow, raidCreate, raidDestroy, raidModify, raidUnload,
         raidRestore, raidInitStart, raidInitStop, raidReconStart, raidReconStop } from '../grpc/raid.js';
import { arrayLocks } from '../middleware/locking.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { resolveController } from '../server/controllerResolver.js';
import { listExports } from '../os/nfsClient.js';
import type { PlanResult, Mode, JobRecord } from '../types/common.js';
import { McpToolError, ErrorCode } from '../types/common.js';
import { JobManager } from './job.js';

// --- Schemas ---

export const RaidListSchema = z.object({
  controller_id: z.string().optional(),
  extended: z.boolean().default(true),
});

export const RaidCreateSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('RAID array name'),
  level: z.enum(['0', '1', '5', '6', '7', '10', '50', '60', '70', 'N+M']),
  drives: z.array(z.string()).min(1).describe('Block device paths'),
  group_size: z.number().int().min(2).max(32).optional().describe('Required for levels 50/60/70'),
  synd_cnt: z.number().int().min(4).max(32).optional().describe('Syndrome count for N+M levels'),
  strip_size: z.number().int().optional().describe('Strip size in KiB'),
  block_size: z.enum(['512', '4096']).optional(),
  memory_limit: z.number().int().min(1024).optional().describe('Memory limit in MiB (min 1024)'),
  sparepool: z.string().optional(),
  mode: z.enum(['plan', 'apply']).default('plan'),
  idempotency_key: z.string().optional(),
});

export const RaidModifyPerformanceSchema = z.object({
  controller_id: z.string().optional(),
  array_id: z.string().describe('RAID array name'),
  merge_write_enabled: z.number().int().min(0).max(1).optional(),
  merge_read_enabled: z.number().int().min(0).max(1).optional(),
  sched_enabled: z.number().int().min(0).max(1).optional(),
  memory_limit: z.number().int().optional(),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const RaidLifecycleControlSchema = z.object({
  controller_id: z.string().optional(),
  array_id: z.string(),
  action: z.enum(['start', 'stop']),
  process: z.enum(['init', 'recon']),
});

export const RaidUnloadSchema = z.object({
  controller_id: z.string().optional(),
  array_id: z.string(),
});

export const RaidRestoreSchema = z.object({
  controller_id: z.string().optional(),
  source: z.enum(['drives', 'backup']),
  array_id: z.string().optional(),
});

export const RaidDeleteSchema = z.object({
  controller_id: z.string().optional(),
  array_id: z.string(),
  mode: z.enum(['plan', 'apply']).default('plan'),
  dangerous: z.boolean().default(false).describe('Must be true to apply deletion'),
});

// --- Min drive counts per RAID level ---
const MIN_DRIVES: Record<string, number> = {
  '0': 2, '1': 2, '5': 3, '6': 4, '7': 4, '10': 4, '50': 6, '60': 8, '70': 8, 'N+M': 4,
};

function requiresGroupSize(level: string): boolean {
  return ['50', '60', '70'].includes(level);
}

// --- Helpers ---

async function getMountedArrayPaths(): Promise<Map<string, string>> {
  // Returns map of arrayName -> mountpoint from /proc/mounts
  const result = new Map<string, string>();
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    for (const line of mounts.split('\n')) {
      const parts = line.split(' ');
      const device = parts[0] ?? '';
      const mountpoint = parts[1] ?? '';
      // xiRAID devices are /dev/xi_<name>
      const match = device.match(/^\/dev\/xi_(.+)$/);
      if (match) result.set(match[1] ?? '', mountpoint);
    }
  } catch { /* */ }
  return result;
}

// --- Handlers ---

export async function handleRaidList(params: z.infer<typeof RaidListSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const resp = await withRetry(() => raidShow(client, { extended: params.extended, units: 'g' }), 'raid.list');
  return resp.data;
}

export async function handleRaidCreate(params: z.infer<typeof RaidCreateSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const warnings: string[] = [];
      const changes = [{
        action: 'create' as const,
        resource_type: 'raid_array',
        resource_id: params.name,
        after: { level: params.level, drives: params.drives },
      }];

      // Memory check
      const memLimit = params.memory_limit ?? 1024;
      if (memLimit < 1024) {
        return {
          mode: 'plan' as const,
          description: `Create RAID ${params.level} array '${params.name}'`,
          changes,
          warnings,
          preflight_passed: false,
          blocking_resources: [`memory_limit must be >= 1024 MiB (got ${memLimit})`],
        } satisfies PlanResult;
      }

      // Drive count check
      const minDrives = MIN_DRIVES[params.level] ?? 2;
      if (params.drives.length < minDrives) {
        return {
          mode: 'plan' as const,
          description: `Create RAID ${params.level} array '${params.name}'`,
          changes,
          warnings,
          preflight_passed: false,
          blocking_resources: [`RAID ${params.level} requires at least ${minDrives} drives (got ${params.drives.length})`],
        } satisfies PlanResult;
      }

      // group_size required for levels 50/60/70
      if (requiresGroupSize(params.level) && !params.group_size) {
        return {
          mode: 'plan' as const,
          description: `Create RAID ${params.level} array '${params.name}'`,
          changes,
          warnings,
          preflight_passed: false,
          blocking_resources: [`group_size is required for RAID level ${params.level}`],
        } satisfies PlanResult;
      }

      // group_size divisibility
      if (params.group_size) {
        if (params.drives.length % params.group_size !== 0) {
          warnings.push(`group_size ${params.group_size} does not evenly divide drive count ${params.drives.length}`);
        }
      }

      if (params.drives.length > 20 && params.level === '7') {
        warnings.push('Level 7 arrays with > 20 drives: consider Level 7.3 (N+M) for better performance');
      }

      return {
        mode: 'plan' as const,
        description: `Create RAID ${params.level} array '${params.name}' with ${params.drives.length} drives`,
        changes,
        warnings,
        preflight_passed: true,
      } satisfies PlanResult;
    },

    execute: async () => {
      const client = await getClient(params.controller_id);
      return arrayLocks.withLock(params.name, 'raid.create', async () => {
        const resp = await withRetry(() => raidCreate(client, {
          name: params.name,
          level: params.level,
          drives: params.drives,
          ...(params.group_size !== undefined ? { group_size: params.group_size } : {}),
          ...(params.synd_cnt !== undefined ? { synd_cnt: params.synd_cnt } : {}),
          ...(params.strip_size !== undefined ? { strip_size: params.strip_size } : {}),
          ...(params.block_size !== undefined ? { block_size: parseInt(params.block_size) } : {}),
          ...(params.memory_limit !== undefined ? { memory_limit: params.memory_limit } : {}),
          ...(params.sparepool !== undefined ? { sparepool: params.sparepool } : {}),
        }), 'raid.create');
        return resp.data;
      });
    },
  });
}

export async function handleRaidModifyPerformance(params: z.infer<typeof RaidModifyPerformanceSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const client = await getClient(params.controller_id);
      const showResp = await withRetry(
        () => raidShow(client, { name: params.array_id, extended: false, units: 'g' }),
        'raid.modify_performance preflight'
      );
      const raids = showResp.data as Array<{ name: string; state: string }> | null;
      const raid = raids?.find(r => r.name === params.array_id);
      if (!raid) {
        return {
          mode: 'plan' as const,
          description: `Modify performance of array '${params.array_id}'`,
          changes: [],
          warnings: [],
          preflight_passed: false,
          blocking_resources: [`Array '${params.array_id}' not found`],
        } satisfies PlanResult;
      }

      return {
        mode: 'plan' as const,
        description: `Modify performance parameters of array '${params.array_id}'`,
        changes: [{
          action: 'modify',
          resource_type: 'raid_array',
          resource_id: params.array_id,
          before: { state: raid.state },
          after: {
            merge_write_enabled: params.merge_write_enabled,
            merge_read_enabled: params.merge_read_enabled,
            sched_enabled: params.sched_enabled,
            memory_limit: params.memory_limit,
          },
        }],
        warnings: [],
        preflight_passed: true,
      } satisfies PlanResult;
    },

    execute: async () => {
      const client = await getClient(params.controller_id);
      return arrayLocks.withLock(params.array_id, 'raid.modify_performance', async () => {
        const resp = await withRetry(() => raidModify(client, {
          name: params.array_id,
          ...(params.merge_write_enabled !== undefined ? { merge_write_enabled: params.merge_write_enabled } : {}),
          ...(params.merge_read_enabled !== undefined ? { merge_read_enabled: params.merge_read_enabled } : {}),
          ...(params.sched_enabled !== undefined ? { sched_enabled: params.sched_enabled } : {}),
          ...(params.memory_limit !== undefined ? { memory_limit: params.memory_limit } : {}),
        }), 'raid.modify_performance');
        return resp.data;
      });
    },
  });
}

export async function handleRaidLifecycleControl(
  params: z.infer<typeof RaidLifecycleControlSchema>
): Promise<unknown> {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);

  return arrayLocks.withLock(params.array_id, 'raid.lifecycle_control', async () => {
    let resp;
    if (params.process === 'init') {
      resp = params.action === 'start'
        ? await withRetry(() => raidInitStart(client, { name: params.array_id }), 'raid_init_start')
        : await withRetry(() => raidInitStop(client, { name: params.array_id }), 'raid_init_stop');
    } else {
      resp = params.action === 'start'
        ? await withRetry(() => raidReconStart(client, { name: params.array_id }), 'raid_recon_start')
        : await withRetry(() => raidReconStop(client, { name: params.array_id }), 'raid_recon_stop');
    }

    // Create a polling job for 'start' actions
    let job: JobRecord | undefined;
    if (params.action === 'start') {
      job = JobManager.create(params.controller_id ?? 'default', 'raid.lifecycle_control');
      JobManager.update(job.job_id, { state: 'running' });

      const jobId = job.job_id;
      const arrayId = params.array_id;
      const ctrlId = params.controller_id;

      // Poll progress every 30s
      const interval = setInterval(async () => {
        try {
          const c = await getClient(ctrlId);
          const r = await raidShow(c, { name: arrayId, extended: true, units: 'g' });
          const raids = r.data as Array<{ name: string; init_progress?: number; recon_progress?: number; state?: string }> | null;
          const info = raids?.find(x => x.name === arrayId);
          if (info) {
            const pct = params.process === 'init' ? info.init_progress : info.recon_progress;
            if (pct !== undefined) JobManager.update(jobId, { progress_pct: pct });
            // Check if done
            if (info.state === 'active' || pct === 100) {
              JobManager.update(jobId, { state: 'success', progress_pct: 100 });
              clearInterval(interval);
            }
          }
        } catch {
          JobManager.update(jobId, { state: 'failed', error: 'polling error' });
          clearInterval(interval);
        }
      }, 30000);
      interval.unref();
    }

    return { result: resp.data, job_id: job?.job_id };
  });
}

export async function handleRaidUnload(params: z.infer<typeof RaidUnloadSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);

  return arrayLocks.withLock(params.array_id, 'raid.unload', async () => {
    const resp = await withRetry(
      () => raidUnload(client, { name: params.array_id }),
      'raid.unload'
    );
    return resp.data;
  });
}

export async function handleRaidRestore(params: z.infer<typeof RaidRestoreSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);

  const resp = await withRetry(() => raidRestore(client, {
    all: params.source === 'drives',
    ...(params.array_id ? { name: params.array_id } : {}),
  }), 'raid.restore');
  return resp.data;
}

export async function handleRaidDelete(params: z.infer<typeof RaidDeleteSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      // Check for mounted filesystems
      const mountedArrays = await getMountedArrayPaths();
      if (mountedArrays.has(params.array_id)) {
        const mountpoint = mountedArrays.get(params.array_id);
        blockingResources.push(`Filesystem mounted at ${mountpoint ?? '?'} — unmount first`);
      }

      // Check for active NFS exports
      try {
        const exports = await listExports();
        const mountpoint = mountedArrays.get(params.array_id);
        if (mountpoint) {
          const activeExports = exports.filter(e => e.path.startsWith(mountpoint));
          for (const exp of activeExports) {
            blockingResources.push(`Active NFS export: ${exp.path}`);
          }
        }
      } catch {
        warnings.push('Could not check NFS exports (nfs-helper not available)');
      }

      if (!params.dangerous) {
        blockingResources.push('dangerous=true is required to delete a RAID array');
      }

      return {
        mode: 'plan' as const,
        description: `Delete RAID array '${params.array_id}'`,
        changes: [{
          action: 'delete',
          resource_type: 'raid_array',
          resource_id: params.array_id,
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      if (!params.dangerous) {
        throw new McpToolError(ErrorCode.PRECONDITION_FAILED, 'dangerous=true is required for raid.delete');
      }
      const client = await getClient(params.controller_id);
      return arrayLocks.withLock(params.array_id, 'raid.delete', async () => {
        const resp = await withRetry(
          () => raidDestroy(client, { name: params.array_id, force: false }),
          'raid.delete'
        );
        return resp.data;
      });
    },
  });
}
