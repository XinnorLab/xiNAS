/**
 * Health check engine (S7 T2, ADR-0009 §Architecture).
 *
 * Pure: checks are functions over injected {@link HealthFacts}; the
 * route gathers facts once per GET and folds `overall` from the
 * results. Statuses use the api enum; `skipped` never affects
 * `overall` (a fresh install with nothing configured is healthy).
 */

export type HealthStatus = 'ok' | 'warning' | 'degraded' | 'critical' | 'skipped';

export type HealthCategory =
  | 'api'
  | 'agent'
  | 'state_store'
  | 'xiraid'
  | 'filesystem'
  | 'nfs'
  | 'network'
  | 'drift'
  | 'systemd'
  | 'tuning';

export interface HealthCheckResult {
  id: string;
  category: HealthCategory;
  status: HealthStatus;
  symptom: string;
  impact: string;
  evidence: Record<string, unknown>;
  recommended_action: string;
}

/** The KV-derived facts every quick check consumes (gathered once per GET). */
export interface HealthFacts {
  /** HeartbeatTracker state ('healthy' | 'degraded' | 'offline'). */
  agentState: string;
  arrays: Array<{ id: string; state?: string }>;
  disks: Array<{
    id: string;
    health?: { ok?: boolean; wear_pct?: number; temperature_c?: number };
  }>;
  filesystems: Array<{ id: string; mounted?: boolean; mount_unit_enabled?: boolean }>;
  systemdUnits: Array<{ id: string; active_state?: string; sub_state?: string }>;
  exportRules: Array<{ export_path: string; options: string[] }>;
  desiredShares: Array<{ id: string; path: string; clients?: unknown[] }>;
  /** S6 anchors for drift (T3). */
  desiredNetIfaces: Array<{
    name: string;
    addresses: string[];
    mtu?: number;
    enabled: boolean;
    pbr_table_id: number;
  }>;
  networkConfig?: {
    xinas_file_hash?: string;
    duplicates?: Record<string, string[]>;
  };
  /** S6 per-iface enrichment rows (the existing network checks). */
  networkIfaces: Array<{
    id: string;
    rdma_capable?: boolean;
    rdma_link_state?: string;
    current_addresses?: string[];
    duplicates_detected_in?: string[];
  }>;
  tuning?: { entries: Array<{ key: string; expected: string; actual: string | null }> };
  /** Desired NfsProfile spec (the drift.nfs-conf carrier; null = none). */
  desiredNfsProfile: Record<string, unknown> | null;
  /** Observed NfsProfile effective_files (path → sha256:…). */
  effectiveFiles: Record<string, string>;
}

export type QuickCheck = (facts: HealthFacts) => HealthCheckResult;

const SEVERITY: Record<Exclude<HealthStatus, 'skipped'>, number> = {
  ok: 0,
  warning: 1,
  degraded: 2,
  critical: 3,
};

/** Worst non-skipped status; an all-skipped/empty report is 'ok'. */
export function overallOf(
  checks: HealthCheckResult[],
): 'ok' | 'warning' | 'degraded' | 'critical' {
  let worst: Exclude<HealthStatus, 'skipped'> = 'ok';
  for (const check of checks) {
    if (check.status === 'skipped') continue;
    if (SEVERITY[check.status] > SEVERITY[worst]) worst = check.status;
  }
  return worst;
}
