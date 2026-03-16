/**
 * Plan/Apply execution pattern.
 * mode='plan': run preflight only, return PlanResult
 * mode='apply': run preflight, throw if failed, run execute, record snapshot, return result
 */

import { McpToolError, ErrorCode, type Mode, type PlanResult } from '../types/common.js';
import { recordSnapshot } from '../os/configHistory.js';

export interface PlanContext<T> {
  /** Describe what would happen without making changes */
  preflight: () => Promise<PlanResult>;
  /** Execute the operation */
  execute: () => Promise<T>;
}

/** Map resource_type + action to OperationType enum values from xinas_history */
function inferOperation(plan: PlanResult): string | null {
  const change = plan.changes[0];
  if (!change) return null;

  const type = change.resource_type;
  const action = change.action;

  switch (type) {
    case 'raid_array':
      if (action === 'create') return 'raid_create';
      if (action === 'delete') return 'raid_delete';
      return 'raid_modify';
    case 'nfs_export':
      if (action === 'create') return 'share_create';
      if (action === 'delete') return 'share_delete';
      return 'share_modify';
    case 'network_config':
      return 'network_modify';
    case 'configuration':
      return 'rollback';
    default:
      return null;
  }
}

export async function applyWithPlan<T>(
  mode: Mode,
  ctx: PlanContext<T>
): Promise<PlanResult | T> {
  const plan = await ctx.preflight();

  if (mode === 'plan') {
    return plan;
  }

  // mode === 'apply'
  if (!plan.preflight_passed) {
    throw new McpToolError(
      ErrorCode.PRECONDITION_FAILED,
      `Preflight checks failed. Blocking resources: ${plan.blocking_resources?.join(', ') ?? 'unknown'}`,
      { plan }
    );
  }

  const result = await ctx.execute();

  // Best-effort snapshot recording after successful apply
  const operation = inferOperation(plan);
  if (operation) {
    await recordSnapshot(operation, plan.description);
  }

  return result;
}
