/**
 * HealthFacts gatherer (S7 T6): ONE KV pass per GET /health (or
 * /config-history/drift) building the facts the pure checks consume,
 * plus the drift inputs (compiled desired export entries, observed
 * rule rows, desired netplan rows + the observed file hash) and the
 * probe-call carriers (desired NfsProfile spec, first export path).
 */

import type { HealthFacts } from '../../lib/health/engine.js';
import type { ObservedExportRuleRow } from '../../lib/health/drift.js';
import type { DesiredIfaceSpec } from '../../lib/net/render.js';
import {
  type ExportEntry,
  compileShareToExportEntry,
  shareSpecToCompileInput,
} from '../../lib/nfs-exports.js';
import type { ApiContext } from '../context.js';
import { listByPrefix, getOrNull } from './reads.js';

export interface GatheredHealth {
  facts: HealthFacts;
  /** Compiled desired export entries (drift.nfs-exports left side). */
  desiredEntries: ExportEntry[];
  /** Observed ExportRule rows (drift.nfs-exports right side). */
  observedRules: ObservedExportRuleRow[];
  /** Desired netplan rows (drift.netplan left side). */
  desiredNetRows: DesiredIfaceSpec[];
  /** Observed 99-xinas.yaml content hash (drift.netplan right side). */
  xinasFileHash: string | undefined;
  /** Carried into health.probe for the dry-render oracle. */
  desiredProfileSpec: Record<string, unknown> | null;
  /** First desired export path (the loopback probe target). */
  firstExportPath: string | null;
}

export function gatherHealthFacts(ctx: ApiContext): GatheredHealth {
  const arrays = listByPrefix<{ id?: string; status?: { state?: string } }>(
    ctx.state,
    '/xinas/v1/observed/XiraidArray/',
  ).map((r) => ({ id: r.value.id ?? 'unknown', state: r.value.status?.state ?? 'unknown' }));

  const disks = listByPrefix<{
    id?: string;
    status?: { health?: { ok?: boolean; wear_pct?: number; temperature_c?: number } };
  }>(ctx.state, '/xinas/v1/observed/Disk/').map((r) => ({
    id: r.value.id ?? 'unknown',
    ...(r.value.status?.health !== undefined ? { health: r.value.status.health } : {}),
  }));

  const filesystems = listByPrefix<{
    id?: string;
    status?: { mounted?: boolean; mount_unit_enabled?: boolean; mountpoint?: string };
  }>(ctx.state, '/xinas/v1/observed/Filesystem/').map((r) => ({
    id: r.value.id ?? 'unknown',
    ...(r.value.status?.mounted !== undefined ? { mounted: r.value.status.mounted } : {}),
    ...(r.value.status?.mount_unit_enabled !== undefined
      ? { mount_unit_enabled: r.value.status.mount_unit_enabled }
      : {}),
  }));

  const systemdUnits = listByPrefix<{
    id?: string;
    status?: { active_state?: string; sub_state?: string };
  }>(ctx.state, '/xinas/v1/observed/SystemdUnit/').map((r) => ({
    id: r.value.id ?? 'unknown',
    ...(r.value.status?.active_state !== undefined
      ? { active_state: r.value.status.active_state }
      : {}),
    ...(r.value.status?.sub_state !== undefined ? { sub_state: r.value.status.sub_state } : {}),
  }));

  const observedRules: ObservedExportRuleRow[] = listByPrefix<{
    spec?: { export_path?: string };
    status?: { rules?: Array<{ host_pattern?: string; options?: string[] }> };
  }>(ctx.state, '/xinas/v1/observed/ExportRule/')
    .map((r) => ({
      export_path: r.value.spec?.export_path ?? '',
      rules: (r.value.status?.rules ?? []).map((rule) => ({
        host_pattern: rule.host_pattern ?? '',
        options: rule.options ?? [],
      })),
    }))
    .filter((r) => r.export_path !== '');

  interface DesiredShareRow {
    id?: string;
    spec?: {
      path?: string;
      clients?: Array<{ pattern: string; options: string[] }>;
      sync?: 'sync' | 'async';
      security_mode?: string;
    };
  }
  const shareRows = listByPrefix<DesiredShareRow>(ctx.state, '/xinas/v1/desired/Share/');
  const desiredShares = shareRows
    .map((r) => ({ id: r.value.id ?? 'unknown', path: r.value.spec?.path ?? '' }))
    .filter((s) => s.path !== '');
  const desiredEntries: ExportEntry[] = shareRows
    .filter((r) => typeof r.value.spec?.path === 'string')
    .map((r) =>
      compileShareToExportEntry(
        shareSpecToCompileInput({
          path: r.value.spec?.path as string,
          clients: r.value.spec?.clients ?? [],
          ...(r.value.spec?.sync !== undefined ? { sync: r.value.spec.sync } : {}),
          ...(r.value.spec?.security_mode !== undefined
            ? { security_mode: r.value.spec.security_mode }
            : {}),
        }),
      ),
    );

  interface DesiredIfaceRow {
    id?: string;
    spec?: { addresses?: string[]; mtu?: number; enabled?: boolean; pbr_table_id?: number };
  }
  const desiredNetRows: DesiredIfaceSpec[] = listByPrefix<DesiredIfaceRow>(
    ctx.state,
    '/xinas/v1/desired/NetworkInterface/',
  )
    .filter((r) => typeof r.value.id === 'string' && r.value.spec !== undefined)
    .map((r) => ({
      name: r.value.id as string,
      addresses: r.value.spec?.addresses ?? [],
      ...(r.value.spec?.mtu !== undefined ? { mtu: r.value.spec.mtu } : {}),
      enabled: r.value.spec?.enabled !== false,
      pbr_table_id: r.value.spec?.pbr_table_id ?? 0,
    }));

  const networkIfaces = listByPrefix<{
    id?: string;
    status?: {
      rdma_capable?: boolean;
      rdma_link_state?: string;
      current_addresses?: string[];
      duplicates_detected_in?: string[];
    };
  }>(ctx.state, '/xinas/v1/observed/NetworkInterface/').map((r) => ({
    id: r.value.id ?? 'unknown',
    ...(r.value.status?.rdma_capable !== undefined
      ? { rdma_capable: r.value.status.rdma_capable }
      : {}),
    ...(r.value.status?.rdma_link_state !== undefined
      ? { rdma_link_state: r.value.status.rdma_link_state }
      : {}),
    ...(r.value.status?.current_addresses !== undefined
      ? { current_addresses: r.value.status.current_addresses }
      : {}),
  }));

  const networkConfig = getOrNull<{
    status?: { xinas_file_hash?: string; duplicates?: Record<string, string[]> };
  }>(ctx.state, '/xinas/v1/observed/NetworkConfig/default');

  const tuning = getOrNull<{
    status?: { entries?: Array<{ key: string; expected: string; actual: string | null }> };
  }>(ctx.state, '/xinas/v1/observed/Tuning/default');

  const desiredProfile = getOrNull<{ spec?: Record<string, unknown> }>(
    ctx.state,
    '/xinas/v1/desired/NfsProfile/default',
  );

  const observedProfile = getOrNull<{ status?: { effective_files?: Record<string, string> } }>(
    ctx.state,
    '/xinas/v1/observed/NfsProfile/default',
  );

  const desiredProfileSpec = desiredProfile?.value.spec ?? null;

  const facts: HealthFacts = {
    agentState: ctx.tracker?.currentState() ?? 'untracked',
    arrays,
    disks,
    filesystems,
    systemdUnits,
    exportRules: observedRules.map((r) => ({ export_path: r.export_path, options: [] })),
    desiredShares,
    desiredNetIfaces: desiredNetRows,
    networkIfaces,
    ...(networkConfig !== null
      ? {
          networkConfig: {
            ...(networkConfig.value.status?.xinas_file_hash !== undefined
              ? { xinas_file_hash: networkConfig.value.status.xinas_file_hash }
              : {}),
            ...(networkConfig.value.status?.duplicates !== undefined
              ? { duplicates: networkConfig.value.status.duplicates }
              : {}),
          },
        }
      : {}),
    ...(tuning !== null ? { tuning: { entries: tuning.value.status?.entries ?? [] } } : {}),
    desiredNfsProfile: desiredProfileSpec,
    effectiveFiles: observedProfile?.value.status?.effective_files ?? {},
  };

  return {
    facts,
    desiredEntries,
    observedRules,
    desiredNetRows,
    xinasFileHash: networkConfig?.value.status?.xinas_file_hash,
    desiredProfileSpec,
    firstExportPath: desiredShares[0]?.path ?? null,
  };
}
