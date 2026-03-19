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
  password: z.string().optional().describe('User password (optional, account locked if omitted)'),
  password_confirm: z.string().optional().describe('Password confirmation (must match password)'),
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

export const AuthChangePasswordSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username'),
  password: z.string().describe('New password'),
  password_confirm: z.string().describe('Password confirmation (must match password)'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const AuthSetUserLockSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username'),
  locked: z.boolean().describe('true to lock the account, false to unlock'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const AuthChangeShellSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username'),
  shell: z.string().describe('Absolute path to login shell (e.g. /bin/bash, /usr/sbin/nologin)'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const AuthAddToGroupSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username'),
  group: z.string().describe('Group name to add the user to'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const AuthRemoveFromGroupSchema = z.object({
  controller_id: z.string().optional(),
  username: z.string().describe('Linux username'),
  group: z.string().describe('Group name to remove the user from'),
  mode: z.enum(['plan', 'apply']).default('plan'),
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

      if (params.password || params.password_confirm) {
        if (!params.password || !params.password_confirm) {
          blockingResources.push('Both password and password_confirm must be provided');
        } else if (params.password !== params.password_confirm) {
          blockingResources.push('Passwords do not match');
        }
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
      if (params.password) {
        const chpw = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
          const proc = execFile('chpasswd', { timeout: CMD_TIMEOUT_MS }, (err, _stdout, stderr) => {
            if (err && 'killed' in err && err.killed) {
              reject(new McpToolError(ErrorCode.TIMEOUT, 'chpasswd timed out'));
              return;
            }
            const exitCode = err && 'code' in err ? (err.code as number) : 0;
            resolve({ exitCode, stderr: stderr ?? '' });
          });
          proc.stdin?.write(`${params.username}:${params.password}\n`);
          proc.stdin?.end();
        });
        if (chpw.exitCode !== 0) {
          throw new McpToolError(ErrorCode.INTERNAL, `chpasswd failed: ${chpw.stderr.trim()}`);
        }
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
        description: `Delete user '${params.username}' (home directory removed)`,
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
      const result = await exec('userdel', ['-r', params.username]);
      if (result.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `userdel failed: ${result.stderr.trim()}`);
      }
      return { deleted: true, username: params.username, home_removed: true };
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

// --- Group helper ---

function parseGroupLine(line: string): { name: string; gid: number; members: string[] } | null {
  const parts = line.split(':');
  if (parts.length < 4) return null;
  const name = parts[0]!;
  const gid = parseInt(parts[2]!, 10);
  const memberStr = parts[3] ?? '';
  return {
    name,
    gid,
    members: memberStr ? memberStr.split(',').filter(Boolean) : [],
  };
}

// --- Lock status helper ---

async function isUserLocked(username: string): Promise<boolean> {
  const result = await exec('passwd', ['-S', username]);
  if (result.exitCode !== 0) return false;
  const fields = result.stdout.trim().split(/\s+/);
  return fields.length >= 2 && fields[1] === 'L';
}

// --- New user management handlers ---

export async function handleAuthChangePassword(params: z.infer<typeof AuthChangePasswordSchema>) {
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
        blockingResources.push(`Cannot modify system user '${params.username}' (UID ${existing.uid})`);
      }

      if (params.password !== params.password_confirm) {
        blockingResources.push('Passwords do not match');
      }

      return {
        mode: 'plan' as const,
        description: `Change password for '${params.username}'`,
        changes: [{
          action: 'modify',
          resource_type: 'linux_user',
          resource_id: params.username,
          after: { password: '(changed)' },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const chpw = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
        const proc = execFile('chpasswd', { timeout: CMD_TIMEOUT_MS }, (err, _stdout, stderr) => {
          if (err && 'killed' in err && err.killed) {
            reject(new McpToolError(ErrorCode.TIMEOUT, 'chpasswd timed out'));
            return;
          }
          const exitCode = err && 'code' in err ? (err.code as number) : 0;
          resolve({ exitCode, stderr: stderr ?? '' });
        });
        proc.stdin?.write(`${params.username}:${params.password}\n`);
        proc.stdin?.end();
      });
      if (chpw.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `chpasswd failed: ${chpw.stderr.trim()}`);
      }
      return { changed: true, username: params.username };
    },
  });
}

export async function handleAuthSetUserLock(params: z.infer<typeof AuthSetUserLockSchema>) {
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
        blockingResources.push(`Cannot modify system user '${params.username}' (UID ${existing.uid})`);
      }

      const currentlyLocked = await isUserLocked(params.username);
      if (currentlyLocked === params.locked) {
        warnings.push(`User '${params.username}' is already ${params.locked ? 'locked' : 'unlocked'}`);
      }

      const action_desc = params.locked ? 'Lock' : 'Unlock';
      return {
        mode: 'plan' as const,
        description: `${action_desc} user '${params.username}'`,
        changes: [{
          action: 'modify',
          resource_type: 'linux_user',
          resource_id: params.username,
          before: { locked: currentlyLocked },
          after: { locked: params.locked },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const flag = params.locked ? '-L' : '-U';
      const result = await exec('usermod', [flag, params.username]);
      if (result.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `usermod failed: ${result.stderr.trim()}`);
      }
      return { username: params.username, locked: params.locked };
    },
  });
}

export async function handleAuthChangeShell(params: z.infer<typeof AuthChangeShellSchema>) {
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
        blockingResources.push(`Cannot modify system user '${params.username}' (UID ${existing.uid})`);
      }

      if (!fs.existsSync(params.shell)) {
        blockingResources.push(`Shell not found: ${params.shell}`);
      }

      return {
        mode: 'plan' as const,
        description: `Change shell for '${params.username}' to ${params.shell}`,
        changes: [{
          action: 'modify',
          resource_type: 'linux_user',
          resource_id: params.username,
          before: existing ? { shell: existing.shell } : undefined,
          after: { shell: params.shell },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const result = await exec('chsh', ['-s', params.shell, params.username]);
      if (result.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `chsh failed: ${result.stderr.trim()}`);
      }
      return { username: params.username, shell: params.shell };
    },
  });
}

export async function handleAuthAddToGroup(params: z.infer<typeof AuthAddToGroupSchema>) {
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
        blockingResources.push(`Cannot modify system user '${params.username}' (UID ${existing.uid})`);
      }

      const groupResult = await exec('getent', ['group', params.group]);
      if (groupResult.exitCode !== 0) {
        blockingResources.push(`Group '${params.group}' not found`);
      } else {
        const groupInfo = parseGroupLine(groupResult.stdout.trim());
        if (groupInfo && groupInfo.members.includes(params.username)) {
          blockingResources.push(`User '${params.username}' is already a member of group '${params.group}'`);
        }
      }

      return {
        mode: 'plan' as const,
        description: `Add '${params.username}' to group '${params.group}'`,
        changes: [{
          action: 'modify',
          resource_type: 'linux_user',
          resource_id: params.username,
          after: { added_to_group: params.group },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const result = await exec('usermod', ['-aG', params.group, params.username]);
      if (result.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `usermod failed: ${result.stderr.trim()}`);
      }
      return { username: params.username, group: params.group, action: 'added' };
    },
  });
}

export async function handleAuthRemoveFromGroup(params: z.infer<typeof AuthRemoveFromGroupSchema>) {
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
        blockingResources.push(`Cannot modify system user '${params.username}' (UID ${existing.uid})`);
      }

      const groupResult = await exec('getent', ['group', params.group]);
      if (groupResult.exitCode !== 0) {
        blockingResources.push(`Group '${params.group}' not found`);
      } else {
        const groupInfo = parseGroupLine(groupResult.stdout.trim());
        if (groupInfo) {
          if (!groupInfo.members.includes(params.username)) {
            blockingResources.push(`User '${params.username}' is not a member of group '${params.group}'`);
          }
          if (existing && groupInfo.gid === existing.gid) {
            blockingResources.push(`Cannot remove user from primary group '${params.group}'`);
          }
        }
      }

      return {
        mode: 'plan' as const,
        description: `Remove '${params.username}' from group '${params.group}'`,
        changes: [{
          action: 'modify',
          resource_type: 'linux_user',
          resource_id: params.username,
          after: { removed_from_group: params.group },
        }],
        warnings,
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const result = await exec('gpasswd', ['-d', params.username, params.group]);
      if (result.exitCode !== 0) {
        throw new McpToolError(ErrorCode.INTERNAL, `gpasswd failed: ${result.stderr.trim()}`);
      }
      return { username: params.username, group: params.group, action: 'removed' };
    },
  });
}
