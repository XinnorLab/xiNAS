/**
 * share.* MCP tools — delegated to nfs-helper daemon.
 */

import { z } from 'zod';
import * as fs from 'fs';
import { listExports, addExport, removeExport, updateExport,
         listSessions, getSessions, setQuota, reloadExports } from '../os/nfsClient.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { resolveController } from '../server/controllerResolver.js';
import type { ExportEntry, ClientSpec } from '../types/nfs.js';
import type { PlanResult, Mode } from '../types/common.js';
import { McpToolError, ErrorCode } from '../types/common.js';

// --- Schemas ---

const ClientSpecSchema = z.object({
  host: z.string().describe('Client hostname or IP/CIDR'),
  options: z.array(z.string()).describe('NFS export options e.g. ["rw","no_root_squash"]'),
});

export const ShareListSchema = z.object({
  controller_id: z.string().optional(),
});

export const ShareGetActiveSessionsSchema = z.object({
  controller_id: z.string().optional(),
  share_id: z.string().describe('Export path'),
});

export const ShareCreateSchema = z.object({
  controller_id: z.string().optional(),
  path: z.string().describe('Filesystem path to export'),
  clients: z.array(ClientSpecSchema).min(1),
  security: z.enum(['sys', 'krb5', 'krb5i', 'krb5p']).default('sys'),
  nfs_versions: z.array(z.string()).default(['4.2', '4.1', '4', '3']),
  async_commit: z.boolean().default(false),
  rdma: z.boolean().default(false).describe('Enable RDMA transport'),
  mode: z.enum(['plan', 'apply']).default('plan'),
  idempotency_key: z.string().optional(),
});

export const ShareUpdatePolicySchema = z.object({
  controller_id: z.string().optional(),
  share_id: z.string().describe('Export path'),
  clients: z.array(ClientSpecSchema).optional(),
  security: z.enum(['sys', 'krb5', 'krb5i', 'krb5p']).optional(),
  async_commit: z.boolean().optional(),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const ShareSetQuotaSchema = z.object({
  controller_id: z.string().optional(),
  share_id: z.string().describe('Export path'),
  type: z.enum(['user', 'group', 'project']).default('project'),
  soft_limit_gb: z.number().positive().describe('Soft limit in GiB'),
  hard_limit_gb: z.number().positive().describe('Hard limit in GiB'),
  project_id: z.number().int().positive().optional(),
});

export const ShareDeleteSchema = z.object({
  controller_id: z.string().optional(),
  share_id: z.string(),
  mode: z.enum(['plan', 'apply']).default('plan'),
  dangerous: z.boolean().default(false),
  delete_data: z.boolean().default(false).describe('Also delete underlying filesystem data (DESTRUCTIVE)'),
});

// --- Helpers ---

function buildNfsOptions(params: {
  clients: ClientSpec[];
  security: string;
  nfs_versions: string[];
  async_commit: boolean;
  rdma: boolean;
}): string[] {
  const opts: string[] = [...(params.clients[0]?.options ?? [])];
  if (params.security !== 'sys') {
    opts.push(`sec=${params.security}`);
  }
  if (params.async_commit) {
    opts.push('async');
  } else {
    opts.push('sync');
  }
  if (params.rdma) {
    opts.push('rdma');
  }
  return opts;
}

// --- Handlers ---

export async function handleShareList(params: z.infer<typeof ShareListSchema>) {
  resolveController(params.controller_id);
  return listExports();
}

export async function handleShareGetActiveSessions(params: z.infer<typeof ShareGetActiveSessionsSchema>) {
  resolveController(params.controller_id);
  return getSessions(params.share_id);
}

export async function handleShareCreate(params: z.infer<typeof ShareCreateSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      // Check path exists
      if (!fs.existsSync(params.path)) {
        blockingResources.push(`Path does not exist: ${params.path}`);
      }

      // Check for duplicate
      try {
        const existing = await listExports();
        if (existing.find(e => e.path === params.path)) {
          warnings.push(`Export '${params.path}' already exists — will be overwritten`);
        }
      } catch {
        warnings.push('Could not check existing exports');
      }

      const entry: ExportEntry = {
        path: params.path,
        clients: params.clients.map(c => ({
          host: c.host,
          options: buildNfsOptions({
            clients: [c],
            security: params.security,
            nfs_versions: params.nfs_versions,
            async_commit: params.async_commit,
            rdma: params.rdma,
          }),
        })),
      };

      return {
        mode: 'plan' as const,
        description: `Create NFS export '${params.path}'`,
        changes: [{
          action: 'create',
          resource_type: 'nfs_export',
          resource_id: params.path,
          after: entry,
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const entry: ExportEntry = {
        path: params.path,
        clients: params.clients.map(c => ({
          host: c.host,
          options: buildNfsOptions({
            clients: [c],
            security: params.security,
            nfs_versions: params.nfs_versions,
            async_commit: params.async_commit,
            rdma: params.rdma,
          }),
        })),
      };
      await addExport(entry);
      await reloadExports();
      return { created: true, path: params.path };
    },
  });
}

export async function handleShareUpdatePolicy(params: z.infer<typeof ShareUpdatePolicySchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const existing = await listExports();
      const exp = existing.find(e => e.path === params.share_id);
      if (!exp) {
        return {
          mode: 'plan' as const,
          description: `Update policy for '${params.share_id}'`,
          changes: [],
          warnings: [],
          preflight_passed: false,
          blocking_resources: [`Export '${params.share_id}' not found`],
        } satisfies PlanResult;
      }

      return {
        mode: 'plan' as const,
        description: `Update NFS export policy for '${params.share_id}'`,
        changes: [{
          action: 'modify',
          resource_type: 'nfs_export',
          resource_id: params.share_id,
          before: exp,
          after: { ...exp, ...params },
        }],
        warnings: [],
        preflight_passed: true,
      } satisfies PlanResult;
    },

    execute: async () => {
      const patch: Partial<ExportEntry> = {};
      if (params.clients) patch.clients = params.clients as ClientSpec[];
      await updateExport(params.share_id, patch);
      await reloadExports();
      return { updated: true, path: params.share_id };
    },
  });
}

export async function handleShareSetQuota(params: z.infer<typeof ShareSetQuotaSchema>) {
  resolveController(params.controller_id);
  await setQuota({
    path: params.share_id,
    type: params.type,
    soft_limit_kb: params.soft_limit_gb * 1024 * 1024,
    hard_limit_kb: params.hard_limit_gb * 1024 * 1024,
    ...(params.project_id !== undefined ? { project_id: params.project_id } : {}),
  });
  return { quota_set: true, path: params.share_id };
}

export async function handleShareDelete(params: z.infer<typeof ShareDeleteSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      if (!params.dangerous) {
        blockingResources.push('dangerous=true is required to delete an NFS export');
      }

      // Check for active sessions
      try {
        const sessions = await getSessions(params.share_id);
        if (sessions.length > 0) {
          if (!params.dangerous) {
            blockingResources.push(`${sessions.length} active session(s) on this export`);
          } else {
            warnings.push(`${sessions.length} active session(s) will be disconnected`);
          }
        }
      } catch {
        warnings.push('Could not check active sessions');
      }

      return {
        mode: 'plan' as const,
        description: `Delete NFS export '${params.share_id}'`,
        changes: [{
          action: 'delete',
          resource_type: 'nfs_export',
          resource_id: params.share_id,
          ...(params.delete_data ? {} : {}),
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      if (!params.dangerous) {
        throw new McpToolError(ErrorCode.PRECONDITION_FAILED, 'dangerous=true is required');
      }
      await removeExport(params.share_id);
      await reloadExports();
      return { deleted: true, path: params.share_id, data_deleted: params.delete_data };
    },
  });
}
