/**
 * network.* MCP tools.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { listInterfaces } from '../os/networkInfo.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { resolveController } from '../server/controllerResolver.js';
import type { PlanResult, Mode } from '../types/common.js';

const NETPLAN_DIR = '/etc/netplan';
const XINAS_NETPLAN = path.join(NETPLAN_DIR, '99-xinas-mcp.yaml');

// --- Schemas ---

export const NetworkListSchema = z.object({
  controller_id: z.string().optional(),
});

const StaticIpSchema = z.object({
  address: z.string().describe('IP address with prefix length e.g. 192.168.1.10/24'),
  gateway: z.string().optional(),
  nameservers: z.array(z.string()).optional(),
});

const BondingSchema = z.object({
  mode: z.enum(['active-backup', 'balance-rr', 'balance-xor', '802.3ad', 'balance-tlb', 'balance-alb']),
  members: z.array(z.string()),
});

const RdmaSchema = z.object({
  port: z.number().int().optional().describe('RDMA port number'),
  transport: z.enum(['rc', 'uc', 'ud']).optional().describe('RDMA transport mode'),
});

export const NetworkConfigureSchema = z.object({
  controller_id: z.string().optional(),
  interface_id: z.string().describe('Interface name e.g. eth0, bond0'),
  static_ip: StaticIpSchema.optional(),
  mtu: z.number().int().min(576).max(9216).optional(),
  vlan_id: z.number().int().min(1).max(4094).optional(),
  bonding: BondingSchema.optional(),
  rdma: RdmaSchema.optional(),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

// --- Helpers ---

function buildNetplanYaml(params: z.infer<typeof NetworkConfigureSchema>): string {
  const iface = params.interface_id;
  const lines: string[] = [
    'network:',
    '  version: 2',
    '  renderer: networkd',
  ];

  if (params.bonding) {
    lines.push('  bonds:');
    lines.push(`    ${iface}:`);
    lines.push('      interfaces:');
    for (const m of params.bonding.members) {
      lines.push(`        - ${m}`);
    }
    lines.push('      parameters:');
    lines.push(`        mode: ${params.bonding.mode}`);
    if (params.static_ip) {
      lines.push('      addresses:');
      lines.push(`        - ${params.static_ip.address}`);
      if (params.static_ip.gateway) {
        lines.push('      routes:');
        lines.push('        - to: 0.0.0.0/0');
        lines.push(`          via: ${params.static_ip.gateway}`);
      }
    }
    if (params.mtu) {
      lines.push(`      mtu: ${params.mtu}`);
    }
  } else {
    lines.push('  ethernets:');
    lines.push(`    ${iface}:`);
    if (params.static_ip) {
      lines.push('      addresses:');
      lines.push(`        - ${params.static_ip.address}`);
      if (params.static_ip.gateway) {
        lines.push('      routes:');
        lines.push('        - to: 0.0.0.0/0');
        lines.push(`          via: ${params.static_ip.gateway}`);
      }
    }
    if (params.mtu) {
      lines.push(`      mtu: ${params.mtu}`);
    }
  }

  if (params.static_ip?.nameservers) {
    lines.push('      nameservers:');
    lines.push('        addresses:');
    for (const ns of params.static_ip.nameservers) {
      lines.push(`          - ${ns}`);
    }
  }

  return lines.join('\n') + '\n';
}

// --- Handlers ---

export async function handleNetworkList(params: z.infer<typeof NetworkListSchema>) {
  resolveController(params.controller_id);
  return listInterfaces();
}

export async function handleNetworkConfigure(params: z.infer<typeof NetworkConfigureSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;
  const yaml = buildNetplanYaml(params);

  return applyWithPlan(mode, {
    preflight: async () => {
      const ifaces = listInterfaces();
      const iface = ifaces.find(i => i.name === params.interface_id);
      const warnings: string[] = [];

      if (!iface && !params.bonding) {
        warnings.push(`Interface '${params.interface_id}' not found in current system`);
      }

      if (params.rdma && iface && !iface.is_rdma) {
        warnings.push(`Interface '${params.interface_id}' may not have RDMA capability`);
      }

      let existingYaml: string | undefined;
      if (fs.existsSync(XINAS_NETPLAN)) {
        existingYaml = fs.readFileSync(XINAS_NETPLAN, 'utf8');
      }

      return {
        mode: 'plan' as const,
        description: `Configure interface '${params.interface_id}'`,
        changes: [{
          action: existingYaml ? 'modify' : 'create',
          resource_type: 'network_config',
          resource_id: params.interface_id,
          before: existingYaml,
          after: yaml,
        }],
        warnings,
        preflight_passed: true,
      } satisfies PlanResult;
    },

    execute: async () => {
      if (!fs.existsSync(NETPLAN_DIR)) {
        fs.mkdirSync(NETPLAN_DIR, { recursive: true });
      }
      fs.writeFileSync(XINAS_NETPLAN, yaml, { mode: 0o640 });
      return {
        written: XINAS_NETPLAN,
        note: 'Run "netplan apply" to activate the new configuration',
        yaml,
      };
    },
  });
}
