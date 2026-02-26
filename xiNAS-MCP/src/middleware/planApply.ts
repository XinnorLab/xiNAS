/**
 * Plan/Apply execution pattern.
 * mode='plan': run preflight only, return PlanResult
 * mode='apply': run preflight, throw if failed, run execute, return result
 */

import { McpToolError, ErrorCode, type Mode, type PlanResult } from '../types/common.js';

export interface PlanContext<T> {
  /** Describe what would happen without making changes */
  preflight: () => Promise<PlanResult>;
  /** Execute the operation */
  execute: () => Promise<T>;
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

  return ctx.execute();
}
