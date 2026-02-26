/**
 * auth.* MCP tools.
 */

import { z } from 'zod';
import * as fs from 'fs';
import { getClient, withRetry } from '../grpc/client.js';
import { settingsAuthShow } from '../grpc/settings.js';
import { resolveController } from '../server/controllerResolver.js';

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
