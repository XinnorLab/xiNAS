/**
 * config.rollback plan provider (S9 T5, ADR-0011).
 *
 * Baseline-only: `xinas_history` implements exactly one rollback —
 * reset-to-baseline (the transactional runner's pre-change snapshot,
 * validation, and auto-rollback are the host-side safety). Targeted
 * snapshot rollback needs new python runner work and is deferred.
 *
 * Freshness (review P0): the engine's `affected_resources` check is
 * desired-only and config snapshots are OBSERVED rows — so the
 * baseline snapshot id is resolved from observed rows at plan time,
 * `observed_freshness_ref` carries the real pin, the affected entry
 * is display-only (no revision), and the internal
 * `ConfigHistory/default` lease serializes writers.
 */

import { ApiException } from '../../errors.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

interface ObservedSnapshotRow {
  id?: string;
  status?: { kind?: string; snapshot_id?: string; created_at?: string };
}

export const configRollbackProvider: PlanProvider = {
  operation_kind: 'config.rollback',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const spec = (rawSpec ?? {}) as { to?: unknown; reason?: unknown };
    if (typeof spec.reason !== 'string' || spec.reason.trim().length === 0) {
      throw new ApiException('INVALID_ARGUMENT', 'config.rollback: spec.reason is required');
    }
    if (typeof spec.to !== 'string' || spec.to.length === 0) {
      throw new ApiException('INVALID_ARGUMENT', "config.rollback: spec.to is required");
    }

    const blockers: PlanResult['blockers'] = [
      // The S4 advisory pattern: always present on a destructive plan;
      // the engine enforces the actual flag at apply and clients filter
      // exactly this code when the user has consented.
      {
        code: 'dangerous_flag_required',
        message:
          'reset-to-baseline is irreversible at the API level (the python runner ' +
          'keeps its own pre-change snapshot); apply requires dangerous: true',
      },
    ];
    if (spec.to !== 'baseline') {
      blockers.push({
        code: 'targeted_rollback_not_implemented',
        message:
          `rollback to '${spec.to}' is not available: xinas_history implements only ` +
          `reset-to-baseline in Phase 0 (ADR-0011); targeted snapshot rollback is a ` +
          `future slice. Use spec.to: 'baseline'.`,
      });
    }

    const rows = ctx.kv.list<ObservedSnapshotRow>({
      prefix: '/xinas/v1/observed/ConfigSnapshot/',
    });
    const baseline = rows.find((r) => r.value.status?.kind === 'baseline');
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
      affected_resources: [
        // Display only — NO revision: snapshots are observed rows and the
        // engine's affected_resources freshness check is desired-only.
        { kind: 'ConfigSnapshot', id: baselineId },
      ],
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
  },
};
