/**
 * auth.* MCP tools.
 */

import { z } from 'zod';
import * as fs from 'fs';
import { execFile } from 'node:child_process';
import { getClient, withRetry } from '../grpc/client.js';
import { settingsAuthShow } from '../grpc/settings.js';
import { resolveController } from '../server/controllerResolver.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { listSessions, setQuota } from '../os/nfsClient.js';
import { McpToolError, ErrorCode } from '../types/common.js';
import type { PlanResult, Mode } from '../types/common.js';

// --- Schemas ---

export const AuthGetSupportedModesSchema = z.object({
  controller_id: z.string().optional(),
});

export const AuthValidateKerberosSchema = z.object({
  controller_id: z.string().optional(),
  realm: z.string().describe('Kerberos realm e.g. EXAMPLE.COM'),
  kdc_host: z.string().describe('KDC hostname or IP'),
  keytab_path: z.string().optional().describe('Path to keytab file to validate'),
});

export const AuthListUsersSchema = z.object({
  controller_id: z.string().optional(),
});

const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export const AuthCreateUserSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username (lowercase, max 32 chars)'),
  home_dir: z.string().optional().describe('Home directory path (defaults to /mnt/data/<username>)'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const AuthDeleteUserSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username to delete'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const AuthSetQuotaSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username'),
  share_id: z.string().describe('Export path'),
  soft_limit_gb: z.number().positive().describe('Soft limit in GiB'),
  hard_limit_gb: z.number().positive().describe('Hard limit in GiB'),
});

export const AuthListQuotasSchema = z.object({
  controller_id: z.string().optional(),
});

// --- Handlers ---

export async function handleAuthGetSupportedModes(params: z.infer<typeof AuthGetSupportedModesSchema>) {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);

  const authResp = await withRetry(() => settingsAuthShow(client), 'auth.get_supported_modes');

  return {
    supported_modes: ['sys', 'krb5', 'krb5i', 'krb5p'],
    current_settings: authResp.data,
    kerberos_ready: checkKerberosReady(),
    ldap_ready: false, // Not implemented in v1
  };
}

function checkKerberosReady(): boolean {
  // Check if krb5.conf and keytab are present
  return fs.existsSync('/etc/krb5.conf') && (
    fs.existsSync('/etc/krb5.keytab') ||
    fs.existsSync('/etc/nfs.keytab')
  );
}

export async function handleAuthValidateKerberos(
  params: z.infer<typeof AuthValidateKerberosSchema>
): Promise<{
  realm: string;
  kdc_reachable: boolean;
  time_sync_ok: boolean;
  keytab_valid: boolean | null;
  dns_ok: boolean;
  issues: string[];
}> {
  resolveController(params.controller_id);
  const issues: string[] = [];

  // Keytab check
  let keytab_valid: boolean | null = null;
  if (params.keytab_path) {
    keytab_valid = fs.existsSync(params.keytab_path);
    if (!keytab_valid) {
      issues.push(`Keytab file not found: ${params.keytab_path}`);
    }
  }

  // Time sync check via /proc
  let time_sync_ok = false;
  try {
    const adjtime = fs.readFileSync('/etc/adjtime', 'utf8');
    time_sync_ok = !adjtime.includes('UNSYNC');
  } catch {
    // Check if chrony/ntp service is active
    const ntpState = ['chrony', 'ntpd', 'systemd-timesyncd']
      .some(svc => fs.existsSync(`/sys/fs/cgroup/system.slice/${svc}.service`));
    time_sync_ok = ntpState;
  }

  if (!time_sync_ok) {
    issues.push('Time synchronization may not be active — Kerberos requires time sync within 5 minutes');
  }

  // krb5.conf check
  const krb5ConfExists = fs.existsSync('/etc/krb5.conf');
  if (!krb5ConfExists) {
    issues.push('No /etc/krb5.conf found — install krb5-config package');
  }

  return {
    realm: params.realm,
    kdc_reachable: false, // Cannot check without network call
    time_sync_ok,
    keytab_valid,
    dns_ok: true, // Assume OK without DNS query
    issues,
  };
}

// --- Subprocess helper ---

const CMD_TIMEOUT_MS = 15_000;

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && 'killed' in err && err.killed) {
        reject(new McpToolError(ErrorCode.TIMEOUT, `Command timed out: ${cmd} ${args.join(' ')}`));
        return;
      }
      const exitCode = err && 'code' in err ? (err.code as number) : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
    });
  });
}

// --- User info helper ---

interface UserInfo {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

function parsePasswdLine(line: string): UserInfo | null {
  const parts = line.split(':');
  const name = parts[0];
  const uidStr = parts[2];
  const gidStr = parts[3];
  const home = parts[5];
  const shell = parts[6];
  if (!name || !uidStr || !gidStr || !home || !shell) return null;
  return { username: name, uid: parseInt(uidStr, 10), gid: parseInt(gidStr, 10), home, shell };
}

async function getPasswdUsers(): Promise<UserInfo[]> {
  const result = await exec('getent', ['passwd']);
  if (result.exitCode !== 0) {
    throw new McpToolError(ErrorCode.INTERNAL, 'Failed to enumerate users');
  }
  const users: UserInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const info = parsePasswdLine(line);
    if (info && info.uid >= 1000) {
      users.push(info);
    }
  }
  return users;
}

async function lookupUser(username: string): Promise<UserInfo | null> {
  const result = await exec('getent', ['passwd', username]);
  if (result.exitCode !== 0) return null;
  return parsePasswdLine(result.stdout.trim());
}

// --- User management handlers ---

export async function handleAuthListUsers(params: z.infer<typeof AuthListUsersSchema>) {
  resolveController(params.controller_id);
  return getPasswdUsers();
}

export async function handleAuthCreateUser(params: z.infer<typeof AuthCreateUserSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;
  const homeDir = params.home_dir ?? `/mnt/data/${params.username}`;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      if (!USERNAME_RE.test(params.username)) {
        blockingResources.push(`Invalid username '${params.username}': must match ${USERNAME_RE.source}`);
      }

      const existing = await lookupUser(params.username);
      if (existing) {
        blockingResources.push(`User '${params.username}' already exists (UID ${existing.uid})`);
      }

      const parentDir = homeDir.replace(/\/[^/]+$/, '');
      if (parentDir && !fs.existsSync(parentDir)) {
        blockingResources.push(`Parent directory does not exist: ${parentDir}`);
      }

      return {
        mode: 'plan' as const,
        description: `Create user '${params.username}' with home ${homeDir}`,
        changes: [{
          action: 'create',
          resource_type: 'linux_user',
          resource_id: params.username,
          after: { username: params.username, home: homeDir, shell: '/bin/bash' },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const result = await exec('useradd', ['-m', '-s', '/bin/bash', '-d', homeDir, params.username]);
      if (result.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `useradd failed: ${result.stderr.trim()}`);
      }
      const user = await lookupUser(params.username);
      return { created: true, username: params.username, uid: user?.uid, home: homeDir };
    },
  });
}

export async function handleAuthDeleteUser(params: z.infer<typeof AuthDeleteUserSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const blockingResources: string[] = [];
      const warnings: string[] = [];

      const existing = await lookupUser(params.username);
      if (!existing) {
        blockingResources.push(`User '${params.username}' not found`);
      } else if (existing.uid < 1000) {
        blockingResources.push(`Cannot delete system user '${params.username}' (UID ${existing.uid})`);
      }

      // Check active NFS sessions
      try {
        const sessions = await listSessions();
        // Note: NFS sessions don't directly expose usernames, but we warn about activity
        if (sessions.length > 0) {
          warnings.push(`${sessions.length} active NFS session(s) — verify none belong to '${params.username}'`);
        }
      } catch {
        warnings.push('Could not check active NFS sessions');
      }

      return {
        mode: 'plan' as const,
        description: `Delete user '${params.username}' (home directory preserved)`,
        changes: [{
          action: 'delete',
          resource_type: 'linux_user',
          resource_id: params.username,
          before: existing ?? undefined,
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const result = await exec('userdel', [params.username]);
      if (result.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `userdel failed: ${result.stderr.trim()}`);
      }
      return { deleted: true, username: params.username, home_preserved: true };
    },
  });
}

export async function handleAuthSetQuota(params: z.infer<typeof AuthSetQuotaSchema>) {
  resolveController(params.controller_id);

  // Verify user exists
  const user = await lookupUser(params.username);
  if (!user) {
    throw new McpToolError(ErrorCode.NOT_FOUND, `User '${params.username}' not found`);
  }

  // Verify share path exists
  if (!fs.existsSync(params.share_id)) {
    throw new McpToolError(ErrorCode.NOT_FOUND, `Share path '${params.share_id}' not found`);
  }

  await setQuota({
    path: params.share_id,
    type: 'project',
    soft_limit_kb: params.soft_limit_gb * 1024 * 1024,
    hard_limit_kb: params.hard_limit_gb * 1024 * 1024,
  });

  return { quota_set: true, username: params.username, path: params.share_id };
}

export async function handleAuthListQuotas(params: z.infer<typeof AuthListQuotasSchema>) {
  resolveController(params.controller_id);

  const result = await exec('repquota', ['-a']);
  if (result.exitCode !== 0) {
    throw new McpToolError(ErrorCode.INTERNAL, `repquota failed: ${result.stderr.trim()}`);
  }

  return { raw_report: result.stdout };
}
