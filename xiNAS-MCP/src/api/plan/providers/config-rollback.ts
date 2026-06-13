/**
 * config.rollback plan provider (S9 T5, ADR-0011; targeted in S11, ADR-0013).
 *
 * Two modes on `spec.to`:
 *  - `'baseline'` → reset-to-baseline (the original S9 path; the
 *    transactional runner's pre-change snapshot + validation + auto-rollback
 *    are the host-side safety).
 *  - `<snapshot-id>` → targeted file-level restore of that snapshot's
 *    captured NFS/network config bytes — observed recovery (S11).
 *
 * Freshness (review P0): the engine's `affected_resources` check is
 * desired-only and config snapshots are OBSERVED rows — so the target
 * snapshot id is resolved from observed rows at plan time,
 * `observed_freshness_ref` carries the real pin, the affected entry is
 * display-only (no revision), and the internal `ConfigHistory/default`
 * lease serializes writers. The domain blast radius rides `diff`/`warnings`
 * (review P0: there is no aggregate id for Share/NetworkInterface).
 */

import { ApiException } from '../../errors.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

interface ObservedSnapshotRow {
  id?: string;
  status?: {
    kind?: string;
    snapshot_id?: string;
    created_at?: string;
    restorable?: boolean;
    files_changed?: string[];
  };
}

/** The always-on S4 advisory blocker (clients filter it on consent; the
 *  engine enforces the real dangerous flag at apply). */
const DANGEROUS_BLOCKER = {
  code: 'dangerous_flag_required',
  message:
    'config rollback is destructive (the python runner keeps its own pre-change ' +
    'snapshot); apply requires dangerous: true',
} as const;

function baselinePlan(spec: { reason: string }, ctx: PlanContext): PlanResult {
  const rows = ctx.kv.list<ObservedSnapshotRow>({
    prefix: '/xinas/v1/observed/ConfigSnapshot/',
  });
  const baseline = rows.find((r) => r.value.status?.kind === 'baseline');
  const blockers: PlanResult['blockers'] = [DANGEROUS_BLOCKER];
  if (baseline === undefined) {
    blockers.push({
      code: 'baseline_snapshot_absent',
      message:
        'no baseline snapshot observed — the config-history store has no baseline ' +
        'to reset to (or the agent has not swept yet)',
    });
  }
  const baselineId = baseline?.value.id ?? 'baseline';
  return {
    affected_resources: [{ kind: 'ConfigSnapshot', id: baselineId }],
    blockers,
    warnings: [],
    diff: {
      action: 'reset-to-baseline',
      baseline_id: baselineId,
      history_rollback_class: 'destroying_data',
      warning:
        'Resets ALL managed configuration to the initial baseline: RAID arrays, ' +
        'NFS exports, network settings, and managed services are reverted.',
    },
    risk_level: 'destructive',
    rollback_model: 'executor_managed',
    ...(baseline !== undefined
      ? {
          observed_freshness_ref: {
            kind: 'ConfigSnapshot',
            id: baselineId,
            revision: baseline.revision,
          },
        }
      : {}),
    lease_resources: [{ kind: 'ConfigHistory', id: 'default' }],
    enriched_spec: { to: 'baseline', reason: spec.reason, baseline_id: baselineId },
  };
}

/** S11 (ADR-0013): targeted file-level restore of a specific snapshot. */
function targetedPlan(spec: { to: string; reason: string }, ctx: PlanContext): PlanResult {
  const rows = ctx.kv.list<ObservedSnapshotRow>({
    prefix: '/xinas/v1/observed/ConfigSnapshot/',
  });
  const row = rows.find((r) => r.value.id === spec.to);

  const blockers: PlanResult['blockers'] = [DANGEROUS_BLOCKER];
  if (row === undefined) {
    blockers.push({
      code: 'snapshot_not_found',
      message: `no observed snapshot '${spec.to}' — check the id (or the agent has not swept yet)`,
    });
  } else if (row.value.status?.restorable !== true) {
    blockers.push({
      code: 'no_restorable_payload',
      message:
        `snapshot '${spec.to}' carries no restorable system_files payload ` +
        '(it predates S11, or is an ephemeral pre-change snapshot) — nothing to restore',
    });
  }
  // No storage_only/no_effect plan blocker: the provider is KV-only and cannot
  // re-checksum live files; an empty restore set is the runner's no-op at apply.

  const filesChanged = row?.value.status?.files_changed ?? [];
  const domains = new Set(filesChanged.map((f) => (f === 'netplan' ? 'network' : 'nfs')));
  const warnings: PlanResult['warnings'] =
    domains.size > 0
      ? [
          {
            code: 'observed_recovery',
            message:
              `restore touches ${[...domains].join(' + ')} config and is an OBSERVED ` +
              'recovery — desired state is unchanged; re-apply (or adopt) afterward or ' +
              'the next apply will overwrite it',
          },
        ]
      : [];

  return {
    affected_resources: [{ kind: 'ConfigSnapshot', id: spec.to }],
    blockers,
    warnings,
    diff: {
      action: 'restore-snapshot',
      target_id: spec.to,
      files_changed: filesChanged,
      domains: [...domains],
      note: 'observed recovery — restores captured NFS/network config bytes; desired state unchanged',
    },
    risk_level: 'destructive',
    rollback_model: 'executor_managed',
    ...(row !== undefined
      ? {
          observed_freshness_ref: {
            kind: 'ConfigSnapshot',
            id: spec.to,
            revision: row.revision,
          },
        }
      : {}),
    lease_resources: [{ kind: 'ConfigHistory', id: 'default' }],
    enriched_spec: { to: spec.to, reason: spec.reason, target_id: spec.to },
  };
}

export const configRollbackProvider: PlanProvider = {
  operation_kind: 'config.rollback',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const spec = (rawSpec ?? {}) as { to?: unknown; reason?: unknown };
    if (typeof spec.reason !== 'string' || spec.reason.trim().length === 0) {
      throw new ApiException('INVALID_ARGUMENT', 'config.rollback: spec.reason is required');
    }
    if (typeof spec.to !== 'string' || spec.to.length === 0) {
      throw new ApiException('INVALID_ARGUMENT', 'config.rollback: spec.to is required');
    }
    return spec.to === 'baseline'
      ? baselinePlan({ reason: spec.reason }, ctx)
      : targetedPlan({ to: spec.to, reason: spec.reason }, ctx);
  },
};
