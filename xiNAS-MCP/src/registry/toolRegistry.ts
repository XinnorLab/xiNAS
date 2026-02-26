/**
 * Tool registry — maps all MCP tool names to Zod schemas and handlers.
 * Called once at server startup.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { McpToolError } from '../types/common.js';
import { checkPermission, buildContext } from '../middleware/rbac.js';
import { AuditLogger } from '../middleware/audit.js';
import { loadConfig } from '../config/serverConfig.js';

// Tool imports
import {
  GetServerInfoSchema, handleGetServerInfo,
  ListControllersSchema, handleListControllers,
  GetControllerCapabilitiesSchema, handleGetControllerCapabilities,
  GetStatusSchema, handleGetStatus,
  GetInventorySchema, handleGetInventory,
  GetPerformanceSchema, handleGetPerformance,
} from '../tools/system.js';

import { NetworkListSchema, handleNetworkList, NetworkConfigureSchema, handleNetworkConfigure } from '../tools/network.js';

import { HealthRunCheckSchema, handleHealthRunCheck, HealthGetAlertsSchema, handleHealthGetAlerts } from '../tools/health.js';

import {
  DiskListSchema, handleDiskList,
  DiskGetSmartSchema, handleDiskGetSmart,
  DiskRunSelftestSchema, handleDiskRunSelftest,
  DiskSetLedSchema, handleDiskSetLed,
  DiskSecureEraseSchema, handleDiskSecureErase,
} from '../tools/disk.js';

import {
  RaidListSchema, handleRaidList,
  RaidCreateSchema, handleRaidCreate,
  RaidModifyPerformanceSchema, handleRaidModifyPerformance,
  RaidLifecycleControlSchema, handleRaidLifecycleControl,
  RaidUnloadSchema, handleRaidUnload,
  RaidRestoreSchema, handleRaidRestore,
  RaidDeleteSchema, handleRaidDelete,
} from '../tools/raid.js';

import {
  ShareListSchema, handleShareList,
  ShareGetActiveSessionsSchema, handleShareGetActiveSessions,
  ShareCreateSchema, handleShareCreate,
  ShareUpdatePolicySchema, handleShareUpdatePolicy,
  ShareSetQuotaSchema, handleShareSetQuota,
  ShareDeleteSchema, handleShareDelete,
} from '../tools/share.js';

import { AuthGetSupportedModesSchema, handleAuthGetSupportedModes, AuthValidateKerberosSchema, handleAuthValidateKerberos } from '../tools/auth.js';

import { JobGetSchema, handleJobGet, JobListSchema, handleJobList, JobCancelSchema, handleJobCancel } from '../tools/job.js';

// --- Tool definition ---

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (params: any) => Promise<unknown> | unknown;
}

const TOOLS: ToolDef[] = [
  // System
  { name: 'system.get_server_info', description: 'Get MCP server info, version, and supported tool namespaces', schema: GetServerInfoSchema, handler: handleGetServerInfo },
  { name: 'system.list_controllers', description: 'List available xiNAS controllers', schema: ListControllersSchema, handler: handleListControllers },
  { name: 'system.get_controller_capabilities', description: 'Get RAID levels, NFS versions, auth modes, and license info for a controller', schema: GetControllerCapabilitiesSchema, handler: handleGetControllerCapabilities },
  { name: 'system.get_status', description: 'Get controller status: uptime, OS, kernel, service states, load, memory', schema: GetStatusSchema, handler: handleGetStatus },
  { name: 'system.get_inventory', description: 'Get hardware inventory: CPU, RAM, NICs, block devices', schema: GetInventorySchema, handler: handleGetInventory },
  { name: 'system.get_performance', description: 'Get performance metrics (IOPS, throughput, latency) from Prometheus', schema: GetPerformanceSchema, handler: handleGetPerformance },

  // Network
  { name: 'network.list', description: 'List network interfaces with link state, MTU, speeds, RDMA capability', schema: NetworkListSchema, handler: handleNetworkList },
  { name: 'network.configure', description: 'Configure network interface: static IP, VLAN, bonding, RDMA parameters (plan/apply)', schema: NetworkConfigureSchema, handler: handleNetworkConfigure },

  // Health
  { name: 'health.run_check', description: 'Run health checks (quick/standard/deep): RAID integrity, drive health, NFS, network, memory, license', schema: HealthRunCheckSchema, handler: handleHealthRunCheck },
  { name: 'health.get_alerts', description: 'Get active alerts from last health check run', schema: HealthGetAlertsSchema, handler: handleHealthGetAlerts },

  // Disk
  { name: 'disk.list', description: 'List block devices with RAID membership, health summary, and model info', schema: DiskListSchema, handler: handleDiskList },
  { name: 'disk.get_smart', description: 'Get NVMe health log (SMART equivalent) for a drive', schema: DiskGetSmartSchema, handler: handleDiskGetSmart },
  { name: 'disk.run_selftest', description: 'Run NVMe selftest (short or extended). Returns job_id.', schema: DiskRunSelftestSchema, handler: handleDiskRunSelftest },
  { name: 'disk.set_led', description: 'Turn drive LED on (identify) or off', schema: DiskSetLedSchema, handler: handleDiskSetLed },
  { name: 'disk.secure_erase', description: 'Securely erase a drive (DESTRUCTIVE, requires dangerous=true)', schema: DiskSecureEraseSchema, handler: handleDiskSecureErase },

  // RAID
  { name: 'raid.list', description: 'List RAID arrays with state, members, capacity, and rebuild progress', schema: RaidListSchema, handler: handleRaidList },
  { name: 'raid.create', description: 'Create a new RAID array (plan/apply). Supports levels 0,1,5,6,7,10,50,60,70,N+M.', schema: RaidCreateSchema, handler: handleRaidCreate },
  { name: 'raid.modify_performance', description: 'Modify RAID performance parameters (merge write/read, scheduler)', schema: RaidModifyPerformanceSchema, handler: handleRaidModifyPerformance },
  { name: 'raid.lifecycle_control', description: 'Start/stop RAID initialization or reconstruction', schema: RaidLifecycleControlSchema, handler: handleRaidLifecycleControl },
  { name: 'raid.unload', description: 'Unload a RAID array (preserves data, can be restored)', schema: RaidUnloadSchema, handler: handleRaidUnload },
  { name: 'raid.restore', description: 'Restore a RAID array from drive metadata or config backup', schema: RaidRestoreSchema, handler: handleRaidRestore },
  { name: 'raid.delete', description: 'Delete a RAID array permanently (DESTRUCTIVE, plan/apply, requires dangerous=true)', schema: RaidDeleteSchema, handler: handleRaidDelete },

  // Share
  { name: 'share.list', description: 'List NFS exports with paths, clients, and options', schema: ShareListSchema, handler: handleShareList },
  { name: 'share.get_active_sessions', description: 'Get active NFS sessions for an export', schema: ShareGetActiveSessionsSchema, handler: handleShareGetActiveSessions },
  { name: 'share.create', description: 'Create NFS export (plan/apply). Supports sys/krb5/rdma.', schema: ShareCreateSchema, handler: handleShareCreate },
  { name: 'share.update_policy', description: 'Update NFS export policy (clients, security, options)', schema: ShareUpdatePolicySchema, handler: handleShareUpdatePolicy },
  { name: 'share.set_quota', description: 'Set XFS project quota on an export path', schema: ShareSetQuotaSchema, handler: handleShareSetQuota },
  { name: 'share.delete', description: 'Delete NFS export (plan/apply, requires dangerous=true)', schema: ShareDeleteSchema, handler: handleShareDelete },

  // Auth
  { name: 'auth.get_supported_modes', description: 'Get supported NFS authentication modes and Kerberos readiness', schema: AuthGetSupportedModesSchema, handler: handleAuthGetSupportedModes },
  { name: 'auth.validate_kerberos', description: 'Validate Kerberos configuration: keytab, time sync, krb5.conf', schema: AuthValidateKerberosSchema, handler: handleAuthValidateKerberos },

  // Jobs
  { name: 'job.get', description: 'Get status and progress of a long-running job', schema: JobGetSchema, handler: handleJobGet },
  { name: 'job.list', description: 'List all jobs for a controller', schema: JobListSchema, handler: handleJobList },
  { name: 'job.cancel', description: 'Cancel a running job', schema: JobCancelSchema, handler: handleJobCancel },
];

export function registerAllTools(server: Server): void {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: 'jsonSchema7' }),
    })),
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const config = loadConfig();

    const tool = TOOLS.find(t => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    // Build call context (use 'admin' role for local/unconfigured access, token lookup otherwise)
    const authHeader = (request as { params: { arguments?: unknown; _meta?: { authorization?: string } } })
      .params._meta?.authorization;
    const token = authHeader?.replace('Bearer ', '');
    const role = token
      ? (config.tokens[token] ?? 'viewer')
      : 'admin'; // Local stdio = admin
    const ctx = buildContext(token, role);

    const startMs = Date.now();
    let result: unknown;
    let errorStr: string | undefined;

    try {
      // RBAC check
      checkPermission(name, ctx);

      // Validate input
      const parsed = tool.schema.parse(args ?? {});

      // Execute
      result = await tool.handler(parsed);

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof McpToolError) {
        errorStr = err.message;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: err.code,
              message: err.message,
              details: err.details,
            }),
          }],
          isError: true,
        };
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      errorStr = errMsg;
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'INTERNAL', message: errMsg }) }],
        isError: true,
      };
    } finally {
      // Audit log
      await AuditLogger.log({
        request_id: ctx.request_id,
        principal: ctx.principal,
        timestamp: ctx.timestamp,
        controller_id: config.controller_id,
        tool_name: name,
        parameters_hash: AuditLogger.hashParams(args),
        result_hash: AuditLogger.hashResult(errorStr ?? result),
        duration_ms: Date.now() - startMs,
        ...(errorStr ? { error: errorStr } : {}),
      });
    }
  });
}
