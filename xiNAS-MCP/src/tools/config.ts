/**
 * config.* MCP tools — configuration history management.
 *
 * Backend: Python subprocess via configHistory bridge.
 */

import { z } from 'zod';
import { listSnapshots, showSnapshot, diffSnapshots, getStatus } from '../os/configHistory.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { resolveController } from '../server/controllerResolver.js';
import type { PlanResult, Mode } from '../types/common.js';

// --- Schemas ---

export const ConfigListSnapshotsSchema = z.object({
  controller_id: z.string().optional(),
  include_baseline: z.boolean().default(true),
  status_filter: z.enum(['applied', 'failed', 'rolled_back']).optional(),
});

export const ConfigShowSnapshotSchema = z.object({
  controller_id: z.string().optional(),
  id: z.string().describe('Snapshot ID'),
});

export const ConfigDiffSnapshotsSchema = z.object({
  controller_id: z.string().optional(),
  from_id: z.string().describe('Source snapshot ID'),
  to_id: z.string().describe('Target snapshot ID'),
});

export const ConfigCheckDriftSchema = z.object({
  controller_id: z.string().optional(),
});

export const ConfigGetStatusSchema = z.object({
  controller_id: z.string().optional(),
});

export const ConfigRollbackSchema = z.object({
  controller_id: z.string().optional(),
  target_id: z.string().describe('Snapshot ID to roll back to'),
  reason: z.string().describe('Audit reason for rollback'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

// --- Handlers ---

export async function handleConfigListSnapshots(params: z.infer<typeof ConfigListSnapshotsSchema>) {
  resolveController(params.controller_id);
  return listSnapshots({ statusFilter: params.status_filter });
}

export async function handleConfigShowSnapshot(params: z.infer<typeof ConfigShowSnapshotSchema>) {
  resolveController(params.controller_id);
  return showSnapshot(params.id);
}

export async function handleConfigDiffSnapshots(params: z.infer<typeof ConfigDiffSnapshotsSchema>) {
  resolveController(params.controller_id);
  return diffSnapshots(params.from_id, params.to_id);
}

export async function handleConfigCheckDrift(params: z.infer<typeof ConfigCheckDriftSchema>) {
  resolveController(params.controller_id);
  // Drift check uses the status command which includes drift info
  // For a full drift check, we use a dedicated drift command
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('python3', ['-m', 'xinas_history', 'drift', 'check', '--format', 'json'],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err && 'killed' in err && err.killed) {
          reject(new Error('Drift check timed out'));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(stderr || 'Drift check failed'));
        }
      });
  });
}

export async function handleConfigGetStatus(params: z.infer<typeof ConfigGetStatusSchema>) {
  resolveController(params.controller_id);
  return getStatus();
}

export async function handleConfigRollback(params: z.infer<typeof ConfigRollbackSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      // Get target snapshot info for plan output
      const target = await showSnapshot(params.target_id) as Record<string, unknown>;
      const status = await getStatus() as Record<string, unknown>;

      const warnings: string[] = [];
      const blockingResources: string[] = [];

      if (!target) {
        blockingResources.push(`Snapshot '${params.target_id}' not found`);
      }

      const rollbackClass = (target?.rollback_class as string) ?? 'unknown';
      if (rollbackClass === 'destroying_data') {
        warnings.push('WARNING: This rollback may cause data loss');
      } else if (rollbackClass === 'changing_access') {
        warnings.push('WARNING: This rollback may disconnect active clients');
      }

      return {
        mode: 'plan' as const,
        description: `Roll back configuration to snapshot '${params.target_id}'`,
        changes: [{
          action: 'modify' as const,
          resource_type: 'configuration',
          resource_id: params.target_id,
          before: { current_effective: status?.current_effective },
          after: { target: params.target_id, rollback_class: rollbackClass },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const { execFile } = await import('node:child_process');
      return new Promise((resolve, reject) => {
        execFile('python3', [
          '-m', 'xinas_history', 'snapshot', 'rollback', params.target_id,
          '--reason', params.reason,
          '--yes',
          '--format', 'json',
        ], { timeout: 300_000 }, (err, stdout, stderr) => {
          if (err && 'killed' in err && err.killed) {
            reject(new Error('Rollback timed out'));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error(stderr || 'Rollback failed'));
          }
        });
      });
    },
  });
}
