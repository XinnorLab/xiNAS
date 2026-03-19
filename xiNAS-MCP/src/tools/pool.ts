/**
 * pool.* MCP tools — spare pool lifecycle management.
 */

import { z } from 'zod';
import { getClient, withRetry } from '../grpc/client.js';
import { poolShow, poolCreate, poolDelete, poolAdd, poolRemove,
         poolActivate, poolDeactivate, poolAcquire } from '../grpc/pool.js';
import { raidShow } from '../grpc/raid.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { resolveController } from '../server/controllerResolver.js';
import type { PlanResult, Mode } from '../types/common.js';
import { McpToolError, ErrorCode } from '../types/common.js';

const POOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// --- Schemas ---

export const PoolListSchema = z.object({
  controller_id: z.string().optional(),
});

export const PoolCreateSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('Spare pool name'),
  drives: z.array(z.string()).min(1).describe('Block device paths to add to pool'),
  mode: z.enum(['plan', 'apply']).default('plan'),
  idempotency_key: z.string().optional(),
});

export const PoolDeleteSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('Spare pool name'),
  mode: z.enum(['plan', 'apply']).default('plan'),
  dangerous: z.boolean().default(false).describe('Must be true to apply deletion'),
});

export const PoolAddDrivesSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('Spare pool name'),
  drives: z.array(z.string()).min(1).describe('Block device paths to add'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const PoolRemoveDrivesSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('Spare pool name'),
  drives: z.array(z.string()).min(1).describe('Block device paths to remove'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const PoolActivateSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('Spare pool name'),
});

export const PoolDeactivateSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('Spare pool name'),
});

export const PoolAcquireSchema = z.object({
  controller_id: z.string().optional(),
  name: z.string().min(1).describe('Spare pool name'),
  size: z.number().int().min(1).describe('Minimum required capacity in bytes'),
  discardable: z.boolean().default(false).describe('Whether RZAT-validated drives are acceptable'),
});

// --- Helpers ---

/** Collect all drive paths that belong to any RAID array. */
async function getRaidDrives(controllerId?: string): Promise<Set<string>> {
  const drives = new Set<string>();
  try {
    const client = await getClient(controllerId);
    const resp = await withRetry(() => raidShow(client, { extended: true, units: 'g' }), 'pool preflight raidShow');
    const arrays = resp.data as Array<{ devices?: Array<{ device?: string }> }> | null;
    if (arrays) {
      for (const arr of arrays) {
        for (const dev of arr.devices ?? []) {
          if (dev.device) drives.add(dev.device);
        }
      }
    }
  } catch { /* best-effort */ }
  return drives;
}

/** Collect all drive paths that belong to any spare pool. Returns map of drivePath → poolName. */
async function getPoolDrives(controllerId?: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const client = await getClient(controllerId);
    const resp = await withRetry(() => poolShow(client, { units: 'g' }), 'pool preflight poolShow');
    const pools = resp.data as Record<string, { devices?: Array<[number, string, string[]]> }> | Array<{ name: string; devices?: Array<[number, string, string[]]> }> | null;
    if (pools) {
      const entries = Array.isArray(pools)
        ? pools.map(p => [p.name, p] as const)
        : Object.entries(pools);
      for (const [poolName, pool] of entries) {
        for (const dev of pool.devices ?? []) {
          const devPath = Array.isArray(dev) && dev.length > 1 ? dev[1] : String(dev);
          map.set(devPath, poolName as string);
        }
      }
    }
  } catch { /* best-effort */ }
  return map;
}

/** Check whether a pool is assigned to any RAID array. */
async function isPoolAssignedToRaid(poolName: string, controllerId?: string): Promise<string | null> {
  try {
    const client = await getClient(controllerId);
    const resp = await withRetry(() => raidShow(client, { extended: true, units: 'g' }), 'pool preflight raidShow');
    const arrays = resp.data as Array<{ name: string; sparepool?: string }> | null;
    if (arrays) {
      for (const arr of arrays) {
        if (arr.sparepool === poolName) return arr.name;
      }
    }
  } catch { /* best-effort */ }
  return null;
}

/** Verify a pool exists, return pool data or throw NOT_FOUND. */
async function requirePool(poolName: string, controllerId?: string): Promise<Record<string, unknown>> {
  const client = await getClient(controllerId);
  const resp = await withRetry(() => poolShow(client, { name: poolName, units: 'g' }), 'pool preflight poolShow');
  const data = resp.data;
  // poolShow returns dict of name→pool or list of pools
  const pool = Array.isArray(data)
    ? data.find((p: Record<string, unknown>) => p.name === poolName)
    : data && typeof data === 'object' ? (data as Record<string, unknown>)[poolName] : null;
  if (!pool) {
    throw new McpToolError(ErrorCode.NOT_FOUND, `Spare pool '${poolName}' not found`);
  }
  return pool as Record<string, unknown>;
}

// --- Handlers ---

export async function handlePoolList(params: z.infer<typeof PoolListSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const resp = await withRetry(() => poolShow(client, { units: 'g' }), 'pool.list');
  return resp.data;
}

export async function handlePoolCreate(params: z.infer<typeof PoolCreateSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      if (!POOL_NAME_RE.test(params.name)) {
        blockingResources.push(`Invalid pool name '${params.name}': must match ${POOL_NAME_RE.source}`);
      }

      // Check drives are not in RAID
      const raidDrives = await getRaidDrives(params.controller_id);
      for (const d of params.drives) {
        if (raidDrives.has(d)) {
          blockingResources.push(`Drive ${d} is a member of a RAID array`);
        }
      }

      // Check drives are not in other pools
      const poolDrives = await getPoolDrives(params.controller_id);
      for (const d of params.drives) {
        const existing = poolDrives.get(d);
        if (existing) {
          blockingResources.push(`Drive ${d} is already in pool '${existing}'`);
        }
      }

      return {
        mode: 'plan' as const,
        description: `Create spare pool '${params.name}' with ${params.drives.length} drive(s)`,
        changes: [{
          action: 'create' as const,
          resource_type: 'spare_pool',
          resource_id: params.name,
          after: { drives: params.drives },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const client = await getClient(params.controller_id);
      const resp = await withRetry(
        () => poolCreate(client, { name: params.name, drives: params.drives }),
        'pool.create'
      );
      return resp.data;
    },
  });
}

export async function handlePoolDelete(params: z.infer<typeof PoolDeleteSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      // Check pool exists
      try {
        await requirePool(params.name, params.controller_id);
      } catch (e) {
        if (e instanceof McpToolError) blockingResources.push(e.message);
        else throw e;
      }

      // Check not assigned to RAID
      const assignedArray = await isPoolAssignedToRaid(params.name, params.controller_id);
      if (assignedArray) {
        blockingResources.push(`Pool '${params.name}' is assigned to RAID array '${assignedArray}'`);
      }

      if (!params.dangerous) {
        blockingResources.push('dangerous=true is required to delete a spare pool');
      }

      return {
        mode: 'plan' as const,
        description: `Delete spare pool '${params.name}'`,
        changes: [{
          action: 'delete' as const,
          resource_type: 'spare_pool',
          resource_id: params.name,
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      if (!params.dangerous) {
        throw new McpToolError(ErrorCode.PRECONDITION_FAILED, 'dangerous=true is required for pool.delete');
      }
      const client = await getClient(params.controller_id);
      const resp = await withRetry(
        () => poolDelete(client, { name: params.name }),
        'pool.delete'
      );
      return resp.data;
    },
  });
}

export async function handlePoolAddDrives(params: z.infer<typeof PoolAddDrivesSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      // Check pool exists
      try {
        await requirePool(params.name, params.controller_id);
      } catch (e) {
        if (e instanceof McpToolError) blockingResources.push(e.message);
        else throw e;
      }

      // Check drives are not in RAID
      const raidDrives = await getRaidDrives(params.controller_id);
      for (const d of params.drives) {
        if (raidDrives.has(d)) {
          blockingResources.push(`Drive ${d} is a member of a RAID array`);
        }
      }

      // Check drives are not in other pools
      const poolDrives = await getPoolDrives(params.controller_id);
      for (const d of params.drives) {
        const existing = poolDrives.get(d);
        if (existing && existing !== params.name) {
          blockingResources.push(`Drive ${d} is already in pool '${existing}'`);
        }
      }

      return {
        mode: 'plan' as const,
        description: `Add ${params.drives.length} drive(s) to spare pool '${params.name}'`,
        changes: [{
          action: 'modify' as const,
          resource_type: 'spare_pool',
          resource_id: params.name,
          after: { add_drives: params.drives },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const client = await getClient(params.controller_id);
      const resp = await withRetry(
        () => poolAdd(client, { name: params.name, drives: params.drives }),
        'pool.add_drives'
      );
      return resp.data;
    },
  });
}

export async function handlePoolRemoveDrives(params: z.infer<typeof PoolRemoveDrivesSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      // Check pool exists and drives are members
      try {
        const pool = await requirePool(params.name, params.controller_id);
        const devices = (pool.devices ?? []) as Array<[number, string, string[]]>;
        const poolDevPaths = new Set(devices.map(d => Array.isArray(d) && d.length > 1 ? d[1] : String(d)));

        for (const d of params.drives) {
          if (!poolDevPaths.has(d)) {
            blockingResources.push(`Drive ${d} is not a member of pool '${params.name}'`);
          }
        }
      } catch (e) {
        if (e instanceof McpToolError) blockingResources.push(e.message);
        else throw e;
      }

      return {
        mode: 'plan' as const,
        description: `Remove ${params.drives.length} drive(s) from spare pool '${params.name}'`,
        changes: [{
          action: 'modify' as const,
          resource_type: 'spare_pool',
          resource_id: params.name,
          after: { remove_drives: params.drives },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const client = await getClient(params.controller_id);
      const resp = await withRetry(
        () => poolRemove(client, { name: params.name, drives: params.drives }),
        'pool.remove_drives'
      );
      return resp.data;
    },
  });
}

export async function handlePoolActivate(params: z.infer<typeof PoolActivateSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const resp = await withRetry(
    () => poolActivate(client, { name: params.name }),
    'pool.activate'
  );
  return resp.data;
}

export async function handlePoolDeactivate(params: z.infer<typeof PoolDeactivateSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const resp = await withRetry(
    () => poolDeactivate(client, { name: params.name }),
    'pool.deactivate'
  );
  return resp.data;
}

export async function handlePoolAcquire(params: z.infer<typeof PoolAcquireSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const resp = await withRetry(
    () => poolAcquire(client, {
      name: params.name,
      size: params.size,
      discardable: params.discardable,
    }),
    'pool.acquire'
  );
  return resp.data;
}
