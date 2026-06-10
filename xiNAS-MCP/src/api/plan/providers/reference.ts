import type { ResourceRef } from '../../tasks/types.js';
import type { PlanContext, PlanProvider, PlanResult } from '../engine.js';

/**
 * The built-in, inert reference plan provider (s2-task-envelope-spec §8).
 * It proves the plan/apply engine end-to-end without touching any real
 * OS state: `diff` is the echoed spec, `risk_level` is `non_disruptive`,
 * and its rollback class is `non_disruptive` (its executor's rollback is
 * a trivial inverse — T6).
 *
 * Freshness is REAL: the provider reads the desired + observed
 * projections of its single `Reference/<id>` resource from KV and stamps
 * `state_revision_expected` / `observed_revision_expected` / `observed_at`
 * from those reads. A resource that doesn't exist yet reads as absent →
 * the revisions are left undefined (the apply txn treats "nothing pinned"
 * as "nothing to check"; an absent row that reappears reads as 0 and so
 * mismatches any pin ≥ 1).
 */
export const referencePlanProvider: PlanProvider = {
  operation_kind: 'reference.echo',

  async preflight(ctx: PlanContext, spec: unknown): Promise<PlanResult> {
    const id = referenceId(spec);

    // Desired projection → the revision a later apply pins for TOCTOU.
    const desired = ctx.kv.get(`/xinas/v1/desired/Reference/${id}`);
    // Observed projection → the observation-freshness pin. observed_at is
    // the moment that observation was last written (its modified_at).
    const observed = ctx.kv.get(`/xinas/v1/observed/Reference/${id}`);

    // Primary/observed resource FIRST (engine.ts freshness contract).
    const resource: ResourceRef = {
      kind: 'Reference',
      id,
      ...(desired ? { revision: desired.revision } : {}),
    };

    return {
      affected_resources: [resource],
      blockers: [],
      warnings: [],
      diff: spec,
      risk_level: 'non_disruptive',
      // api-v1.yaml Plan.rollback_model enum value; the earlier 'reversible'
      // was off-contract (normalized in S3 T0).
      rollback_model: 'non_disruptive',
      ...(desired ? { state_revision_expected: desired.revision } : {}),
      ...(observed ? { observed_revision_expected: observed.revision } : {}),
      ...(observed ? { observed_at: new Date(observed.modified_at).toISOString() } : {}),
    };
  },
};

/** The reference resource id from the spec, defaulting to 'default'. */
function referenceId(spec: unknown): string {
  if (spec && typeof spec === 'object' && 'id' in spec) {
    const id = (spec as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'default';
}
