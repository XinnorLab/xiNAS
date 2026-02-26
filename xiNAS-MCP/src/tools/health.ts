/**
 * health.* MCP tools.
 */

import { z } from 'zod';
import * as crypto from 'crypto';
import { getClient, withRetry } from '../grpc/client.js';
import { raidShow } from '../grpc/raid.js';
import { poolShow } from '../grpc/pool.js';
import { driveFaultyCountShow } from '../grpc/drive.js';
import { licenseShow } from '../grpc/license.js';
import { getSystemInfo, getServiceState } from '../os/systemInfo.js';
import { listInterfaces } from '../os/networkInfo.js';
import { listBlockDevices } from '../os/diskInfo.js';
import { resolveController } from '../server/controllerResolver.js';
import { loadConfig } from '../config/serverConfig.js';

export type CheckStatus = 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN';
export type CheckProfile = 'quick' | 'standard' | 'deep';

export interface HealthCheckResult {
  check_id: string;
  section: string;
  name: string;
  status: CheckStatus;
  actual?: string | undefined;
  expected?: string | undefined;
  impact?: string | undefined;
  evidence?: string | undefined;
  recommended_action?: string | undefined;
  fix_hint?: string | undefined;
}

export interface Alert {
  alert_id: string;
  check_id: string;
  severity: 'warn' | 'crit';
  message: string;
  first_seen: string;
  last_seen: string;
  acknowledged: boolean;
}

// In-memory alert ring buffer (last 100 alerts)
const alertBuffer: Alert[] = [];
const MAX_ALERTS = 100;

function makeAlertId(checkId: string, firstSeen: string): string {
  return crypto.createHash('sha256').update(`${checkId}:${firstSeen}`).digest('hex').slice(0, 16);
}

function addOrUpdateAlert(result: HealthCheckResult): void {
  if (result.status === 'OK' || result.status === 'UNKNOWN') return;
  const existing = alertBuffer.find(a => a.check_id === result.check_id && !a.acknowledged);
  if (existing) {
    existing.last_seen = new Date().toISOString();
    existing.severity = result.status === 'CRIT' ? 'crit' : 'warn';
    existing.message = result.name;
    return;
  }
  const firstSeen = new Date().toISOString();
  const alert: Alert = {
    alert_id: makeAlertId(result.check_id, firstSeen),
    check_id: result.check_id,
    severity: result.status === 'CRIT' ? 'crit' : 'warn',
    message: `${result.section}: ${result.name} — ${result.actual ?? ''}`,
    first_seen: firstSeen,
    last_seen: firstSeen,
    acknowledged: false,
  };
  alertBuffer.push(alert);
  if (alertBuffer.length > MAX_ALERTS) alertBuffer.shift();
}

// --- Schemas ---

export const HealthRunCheckSchema = z.object({
  controller_id: z.string().optional(),
  profile: z.enum(['quick', 'standard', 'deep']).default('standard'),
});

export const HealthGetAlertsSchema = z.object({
  controller_id: z.string().optional(),
  since: z.string().optional().describe('ISO 8601 timestamp filter'),
  severity_min: z.enum(['warn', 'crit']).default('warn'),
});

// --- Check implementations ---

async function checkRaidIntegrity(client: unknown): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  try {
    const resp = await withRetry(
      () => raidShow(client as never, { extended: true }),
      'health.raid_integrity'
    );
    const raids = resp.data as Array<{
      name: string;
      state: string;
      degraded?: boolean;
      init_progress?: number;
      recon_progress?: number;
    }> | null;

    if (!raids || raids.length === 0) {
      results.push({
        check_id: 'raid_no_arrays',
        section: 'RAID',
        name: 'No RAID arrays found',
        status: 'WARN',
        impact: 'No data storage configured',
        recommended_action: 'Create a RAID array',
      });
      return results;
    }

    for (const raid of raids) {
      let status: CheckStatus = 'OK';
      const issues: string[] = [];

      if (raid.degraded) {
        status = 'WARN';
        issues.push('degraded');
      }

      const badStates = ['failed', 'offline', 'error'];
      if (badStates.some(s => raid.state?.toLowerCase().includes(s))) {
        status = 'CRIT';
        issues.push(`state=${raid.state}`);
      }

      results.push({
        check_id: `raid_integrity_${raid.name}`,
        section: 'RAID',
        name: `Array '${raid.name}' integrity`,
        status,
        actual: raid.state,
        expected: 'active',
        evidence: issues.join('; ') || undefined,
        impact: status !== 'OK' ? 'Data redundancy reduced or unavailable' : undefined,
        recommended_action: status !== 'OK' ? 'Check drive health and rebuild status' : undefined,
        fix_hint: status !== 'OK' ? `raid.lifecycle_control array_id=${raid.name} action=start process=recon` : undefined,
      });
    }
  } catch (err) {
    results.push({
      check_id: 'raid_integrity_error',
      section: 'RAID',
      name: 'RAID status check failed',
      status: 'UNKNOWN',
      evidence: String(err),
    });
  }
  return results;
}

async function checkNfsDaemons(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  const services = ['nfs-kernel-server', 'nfsd'];
  for (const svc of services) {
    const state = getServiceState(svc);
    results.push({
      check_id: `nfs_daemon_${svc}`,
      section: 'NFS',
      name: `Service ${svc}`,
      status: state.active ? 'OK' : 'CRIT',
      actual: state.state,
      expected: 'active',
      impact: state.active ? undefined : 'NFS exports unavailable',
      recommended_action: state.active ? undefined : `systemctl start ${svc}`,
    });
  }
  return results;
}

function checkNetworkLinks(): HealthCheckResult[] {
  const results: HealthCheckResult[] = [];
  const ifaces = listInterfaces();
  for (const iface of ifaces) {
    if (iface.name.startsWith('lo')) continue;
    const isUp = iface.operstate === 'up';
    const hasErrors = (iface.rx_errors + iface.tx_errors) > 0;
    let status: CheckStatus = isUp ? 'OK' : 'CRIT';
    if (isUp && hasErrors) status = 'WARN';

    results.push({
      check_id: `network_link_${iface.name}`,
      section: 'Network',
      name: `Interface ${iface.name} link`,
      status,
      actual: `${iface.operstate}, errors: rx=${iface.rx_errors} tx=${iface.tx_errors}`,
      expected: 'up, no errors',
      impact: status !== 'OK' ? 'Network connectivity impaired' : undefined,
      recommended_action: status !== 'OK' ? `Check cable and switch port for ${iface.name}` : undefined,
    });
  }
  return results;
}

function checkMemoryPressure(): HealthCheckResult {
  const sysInfo = getSystemInfo();
  const { used_pct, available_kb, total_kb } = sysInfo.memory;
  const status: CheckStatus = used_pct > 95 ? 'CRIT' : used_pct > 85 ? 'WARN' : 'OK';
  return {
    check_id: 'memory_pressure',
    section: 'System',
    name: 'Memory pressure',
    status,
    actual: `${used_pct}% used (${Math.round(available_kb / 1024)}MB available of ${Math.round(total_kb / 1024)}MB)`,
    expected: '< 85% used',
    impact: status !== 'OK' ? 'RAID performance degraded; potential OOM' : undefined,
    recommended_action: status !== 'OK' ? 'Check RAID memory_limit settings; add RAM' : undefined,
  };
}

async function checkLicense(client: unknown): Promise<HealthCheckResult> {
  try {
    const resp = await withRetry(() => licenseShow(client as never), 'health.license');
    const lic = resp.data as { valid?: boolean; expiry?: string } | null;
    const valid = lic?.valid !== false;
    return {
      check_id: 'license_validity',
      section: 'System',
      name: 'License validity',
      status: valid ? 'OK' : 'CRIT',
      actual: valid ? 'valid' : 'invalid',
      expected: 'valid',
      impact: valid ? undefined : 'RAID operations may be restricted',
      recommended_action: valid ? undefined : 'Apply a valid xiRAID license via system settings',
    };
  } catch {
    return {
      check_id: 'license_validity',
      section: 'System',
      name: 'License check failed',
      status: 'UNKNOWN',
    };
  }
}

async function checkSpares(client: unknown): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  try {
    const resp = await withRetry(() => poolShow(client as never, {}), 'health.spares');
    const pools = resp.data as Array<{ name: string; active: boolean; drives: string[] }> | null;
    if (pools) {
      for (const pool of pools) {
        results.push({
          check_id: `spare_pool_${pool.name}`,
          section: 'Spare Pools',
          name: `Spare pool '${pool.name}'`,
          status: pool.active ? 'OK' : 'WARN',
          actual: pool.active ? 'active' : 'inactive',
          expected: 'active',
          evidence: `${pool.drives.length} drives`,
          recommended_action: pool.active ? undefined : `pool.activate ${pool.name}`,
        });
      }
    }
  } catch { /* optional check */ }
  return results;
}

async function checkFaultyCounts(client: unknown): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  try {
    const resp = await withRetry(
      () => driveFaultyCountShow(client as never, {}),
      'health.faulty_counts'
    );
    const counts = resp.data as Array<{ drive: string; count: number; threshold: number }> | null;
    if (counts) {
      for (const entry of counts) {
        const pct = entry.threshold > 0 ? (entry.count / entry.threshold) * 100 : 0;
        const status: CheckStatus = pct >= 100 ? 'CRIT' : pct >= 80 ? 'WARN' : 'OK';
        if (status !== 'OK') {
          results.push({
            check_id: `drive_faulty_${entry.drive.replace(/\//g, '_')}`,
            section: 'Drives',
            name: `Drive fault count ${entry.drive}`,
            status,
            actual: `${entry.count}/${entry.threshold}`,
            expected: `< ${entry.threshold}`,
            impact: 'Drive approaching fault threshold; may be excluded from RAID',
            recommended_action: 'Consider drive replacement',
          });
        }
      }
    }
  } catch { /* optional */ }
  return results;
}

function checkDriveHealth(): HealthCheckResult[] {
  const results: HealthCheckResult[] = [];
  const devices = listBlockDevices();
  for (const dev of devices) {
    if (!dev.health) continue;
    const { critical_warning, available_spare_pct, media_errors } = dev.health;
    let status: CheckStatus = 'OK';
    const issues: string[] = [];

    if (critical_warning && critical_warning > 0) { status = 'CRIT'; issues.push(`critical_warning=${critical_warning}`); }
    if (available_spare_pct !== null && available_spare_pct < 10) { status = 'CRIT'; issues.push(`spare=${available_spare_pct}%`); }
    else if (available_spare_pct !== null && available_spare_pct < 20) { if (status !== 'CRIT') status = 'WARN'; issues.push(`spare=${available_spare_pct}%`); }
    if (media_errors !== null && media_errors > 0) { if (status !== 'CRIT') status = 'WARN'; issues.push(`media_errors=${media_errors}`); }

    if (status !== 'OK') {
      results.push({
        check_id: `drive_health_${dev.name}`,
        section: 'Drives',
        name: `NVMe health ${dev.path}`,
        status,
        actual: issues.join(', '),
        expected: 'no issues',
        impact: 'Drive may fail; data at risk',
        recommended_action: `Check ${dev.path} and consider replacement`,
        fix_hint: `disk.get_smart disk_id=${dev.path}`,
      });
    }
  }
  return results;
}

// --- Main handlers ---

export async function handleHealthRunCheck(params: z.infer<typeof HealthRunCheckSchema>): Promise<HealthCheckResult[]> {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const profile = params.profile;
  const results: HealthCheckResult[] = [];

  // Quick checks (all profiles)
  results.push(...await checkRaidIntegrity(client));
  results.push(...await checkNfsDaemons());
  results.push(...checkNetworkLinks());
  results.push(checkMemoryPressure());
  results.push(await checkLicense(client));

  if (profile === 'standard' || profile === 'deep') {
    results.push(...await checkSpares(client));
    results.push(...await checkFaultyCounts(client));
    results.push(...checkDriveHealth());
  }

  // Update alert buffer
  for (const r of results) {
    addOrUpdateAlert(r);
  }

  return results;
}

export function handleHealthGetAlerts(params: z.infer<typeof HealthGetAlertsSchema>): Alert[] {
  resolveController(params.controller_id);

  let alerts = [...alertBuffer];

  if (params.since) {
    const since = new Date(params.since).getTime();
    alerts = alerts.filter(a => new Date(a.last_seen).getTime() >= since);
  }

  if (params.severity_min === 'crit') {
    alerts = alerts.filter(a => a.severity === 'crit');
  }

  return alerts.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}
