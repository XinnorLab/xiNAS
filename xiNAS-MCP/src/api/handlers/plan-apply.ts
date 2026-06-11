/**
 * Shared helpers for mutating plan/apply routes (reference, arrays, …).
 * Extracted from routes/reference.ts in S3 T8 so every engine-backed
 * route renders the same Plan/Task envelopes (DRY; the shapes are
 * contract-locked in api-v1.yaml).
 */

import { ApiException } from '../errors.js';
import type { ApplyPlan } from '../tasks/engine.js';
import type { Task } from '../tasks/types.js';

/**
 * Map a stored `plan_only` Task to the apply transaction's ApplyPlan.
 *
 * DELEGATES to routes/apply-helpers.ts — the single plan_binding-aware
 * reconstruction (S6: a binding-blind copy here silently dropped
 * lease_resources/desired_mutations for any plan that carried them).
 */
export { toApplyPlan } from '../routes/apply-helpers.js';

/** The Task envelope shape the 202 returns (subset the route needs to surface). */
export function taskEnvelope(task: Task): Record<string, unknown> {
  return {
    task_id: task.task_id,
    state: task.state,
    kind: task.kind,
    risk_level: task.risk_level,
    affected_resources: task.affected_resources,
    ...(task.plan_id !== undefined ? { plan_id: task.plan_id } : {}),
    ...(task.agent_acceptance_id !== undefined
      ? { agent_acceptance_id: task.agent_acceptance_id }
      : {}),
    ...(task.error_code !== undefined ? { error_code: task.error_code } : {}),
    ...(task.error_message !== undefined ? { error_message: task.error_message } : {}),
  };
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ApiException(
      'INVALID_ARGUMENT',
      `'${name}' is required and must be a non-empty string`,
    );
  }
  return v;
}

export function requireInteger(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ApiException('INVALID_ARGUMENT', `'${name}' is required and must be an integer`);
  }
  return v;
}

/** Plain-language NFS-client impact for the Plan envelope. */
export function clientImpact(riskLevel: string): string {
  return riskLevel === 'non_disruptive'
    ? 'No impact on NFS clients.'
    : 'May affect NFS clients; review the diff.';
}
