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
import {
  type CapturedRow,
  type SnapshotDesiredPayload,
  snapshotDesiredKey,
} from '../../tasks/snapshot-desired.js';
import type { DesiredMutation, ResourceRef } from '../../tasks/types.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

/**
 * S12 (ADR-0015): the desired-state domains an adopt may re-assert. A domain
 * is adopted ONLY when the captured payload carries ≥1 row of its PRIMARY kind
 * (the NFS render always emits a Share; the network render always emits a
 * NetworkInterface). When a domain's primary set is empty in the payload, that
 * domain is left untouched — no puts, no deletes — so a snapshot that only ever
 * touched NFS never wipes desired network rows.
 */
const ADOPT_DOMAINS: { primary: string; kinds: string[] }[] = [
  { primary: 'Share', kinds: ['Share', 'ExportGroup', 'NfsProfile'] },
  { primary: 'NetworkInterface', kinds: ['NetworkInterface'] },
];

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

/**
 * S12 (ADR-0015 / spec §4.2): compute the desired-state overlay for
 * `adopt: true` from the captured payload at `snapshot-desired/{to}` ALONE.
 *
 * Per adopted domain it builds `desired_mutations` + matching revision pins:
 *  - PUT each captured row → pinned at the row's CURRENT desired revision
 *    (or 0 when it does not exist yet — a create, which the apply guard checks
 *    as create-only against the engine's `affected_resources` freshness check);
 *  - DELETE each CURRENT desired row of the domain's kinds whose id is NOT in
 *    the captured set (an orphan) → pinned at its current revision.
 *
 * When the payload is WHOLLY ABSENT the snapshot is not adoptable: return a
 * blocker and NO mutations (the caller adds the blocker and emits nothing).
 */
function adoptOverlay(
  to: string,
  ctx: PlanContext,
): {
  mutations: DesiredMutation[];
  pinned: ResourceRef[];
  blocker?: { code: string; message: string };
} {
  const payloadRow = ctx.kv.get<SnapshotDesiredPayload>(snapshotDesiredKey(to));
  if (payloadRow === null) {
    return {
      mutations: [],
      pinned: [],
      blocker: {
        code: 'not_adoptable',
        message:
          `snapshot '${to}' has no captured desired-state payload ` +
          '(it predates S12, or was produced by a non-mutating / rollback op) — cannot adopt',
      },
    };
  }
  const captured: Partial<Record<string, CapturedRow[]>> = payloadRow.value.kinds ?? {};
  const mutations: DesiredMutation[] = [];
  const pinned: ResourceRef[] = [];

  for (const { primary, kinds } of ADOPT_DOMAINS) {
    // Per-domain gate: skip the whole domain unless its PRIMARY kind has ≥1 row.
    if ((captured[primary] ?? []).length === 0) {
      continue;
    }
    for (const kind of kinds) {
      const capturedRows = captured[kind] ?? [];
      const capturedIds = new Set(capturedRows.map((r) => r.id));
      // CURRENT desired rows of this kind: ids → current revision.
      const current = ctx.kv.list<{ id?: string }>({ prefix: `/xinas/v1/desired/${kind}/` });
      const currentById = new Map(current.map((r) => [r.value.id ?? '', r.revision]));

      // PUT each captured row; pin at current rev (existing) or 0 (create).
      for (const row of capturedRows) {
        mutations.push({
          key: `/xinas/v1/desired/${kind}/${row.id}`,
          value: { kind, id: row.id, spec: row.spec },
        });
        pinned.push({ kind, id: row.id, revision: currentById.get(row.id) ?? 0 });
      }
      // DELETE each current row whose id is not captured (orphan); pin at current rev.
      for (const [id, revision] of currentById) {
        if (!capturedIds.has(id)) {
          mutations.push({ key: `/xinas/v1/desired/${kind}/${id}`, delete: true });
          pinned.push({ kind, id, revision });
        }
      }
    }
  }
  return { mutations, pinned };
}

/** S11 (ADR-0013): targeted file-level restore of a specific snapshot.
 *  S12 (ADR-0015): when `adopt` is true, overlay the captured desired rows as
 *  `desired_mutations` so the restore survives the next apply. */
function targetedPlan(
  spec: { to: string; reason: string; adopt?: boolean },
  ctx: PlanContext,
): PlanResult {
  const adopt = spec.adopt === true;
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

  // S11 base diff. When adopt re-asserts desired rows, the puts/deletes are
  // appended below so the blast radius is visible in the plan.
  const diff: {
    action: string;
    target_id: string;
    files_changed: string[];
    domains: string[];
    note: string;
    adopt?: boolean;
    desired_puts?: string[];
    desired_deletes?: string[];
  } = {
    action: 'restore-snapshot',
    target_id: spec.to,
    files_changed: filesChanged,
    domains: [...domains],
    note: 'observed recovery — restores captured NFS/network config bytes; desired state unchanged',
  };

  const result: PlanResult = {
    affected_resources: [{ kind: 'ConfigSnapshot', id: spec.to }],
    blockers,
    warnings,
    diff,
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
    enriched_spec: { to: spec.to, reason: spec.reason, target_id: spec.to, adopt },
  };

  // S12 (ADR-0015 §4.2): adopt overlay. adopt:false leaves the plan
  // byte-for-byte the S11 targeted plan (only enriched_spec.adopt is added,
  // which clients ignore for false). The dangerous blocker,
  // observed_freshness_ref, risk_level and the ConfigHistory/default lease are
  // all unchanged either way.
  if (adopt) {
    const overlay = adoptOverlay(spec.to, ctx);
    if (overlay.blocker !== undefined) {
      // Payload wholly absent → not adoptable; add the blocker, no mutations.
      result.blockers.push(overlay.blocker);
      diff.adopt = true;
      diff.note =
        'adopt requested but snapshot carries no captured desired-state payload — not adoptable';
    } else {
      result.desired_mutations = overlay.mutations;
      result.affected_resources.push(...overlay.pinned);
      diff.adopt = true;
      diff.note =
        'durable adoption — re-asserts the captured desired rows per adopted domain ' +
        '(puts the captured rows, deletes the orphans); the file bytes are restored too';
      diff.desired_puts = overlay.mutations
        .filter((m): m is { key: string; value: unknown } => 'value' in m)
        .map((m) => m.key);
      diff.desired_deletes = overlay.mutations
        .filter((m): m is { key: string; delete: true } => 'delete' in m)
        .map((m) => m.key);
    }
  }

  return result;
}

export const configRollbackProvider: PlanProvider = {
  operation_kind: 'config.rollback',

  async preflight(ctx: PlanContext, rawSpec: unknown): Promise<PlanResult> {
    const spec = (rawSpec ?? {}) as { to?: unknown; reason?: unknown; adopt?: unknown };
    if (typeof spec.reason !== 'string' || spec.reason.trim().length === 0) {
      throw new ApiException('INVALID_ARGUMENT', 'config.rollback: spec.reason is required');
    }
    if (typeof spec.to !== 'string' || spec.to.length === 0) {
      throw new ApiException('INVALID_ARGUMENT', 'config.rollback: spec.to is required');
    }
    // S12 (ADR-0015 §4.2): adopt is a desired-state re-assertion derived from a
    // TARGETED snapshot's captured payload. baseline reset has no captured
    // payload to adopt and resets desired wholesale — adopt is meaningless and
    // rejected; for any non-baseline target adopt is honoured (false otherwise).
    const adopt = spec.adopt === true;
    if (spec.to === 'baseline') {
      if (adopt) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          'config.rollback: adopt is not valid for a baseline reset (no captured desired payload)',
        );
      }
      return baselinePlan({ reason: spec.reason }, ctx);
    }
    return targetedPlan({ to: spec.to, reason: spec.reason, adopt }, ctx);
  },
};
