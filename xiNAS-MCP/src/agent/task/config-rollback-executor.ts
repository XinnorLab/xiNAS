/**
 * config.rollback executor (S9 T5, ADR-0011) — baseline reset.
 *
 * One stage: the bridge's `resetToBaseline(reason)`. The python
 * transactional runner owns the host-side safety (its own pre-change
 * snapshot, validation, auto-rollback) — which is also why this
 * executor's `rollback()` is a no-op: a failed reset has ALREADY been
 * rolled back by the runner, and re-running anything from here could
 * fight it.
 */

import type { XinasHistoryBridge } from './xinas-history-bridge.js';
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';

interface RollbackSpec {
  reason: string;
  baseline_id: string;
}

function narrowSpec(ctx: ExecutorContext): RollbackSpec {
  const s = ctx.spec as Partial<RollbackSpec>;
  if (typeof s.reason !== 'string' || s.reason.length === 0) {
    throw new Error('config.rollback: enriched spec missing reason');
  }
  return { reason: s.reason, baseline_id: s.baseline_id ?? 'baseline' };
}

export function makeConfigRollbackExecutor(opts: { bridge: XinasHistoryBridge }): Executor {
  const stages: ExecutorStage[] = [
    {
      name: 'reset',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx);
        ctx.emitOutput(`reset-to-baseline (${spec.baseline_id}): ${spec.reason}`);
        const result = await opts.bridge.resetToBaseline(spec.reason);
        if (result.success !== true) {
          throw new Error(
            `reset-to-baseline failed (runner auto-rollback applies): ${JSON.stringify(result)}`,
          );
        }
        ctx.emitOutput('baseline reset completed');
      },
    },
  ];

  return {
    operation_kind: 'config.rollback',
    stages,
    async rollback(): Promise<void> {
      /* the python runner already rolled back on failure */
    },
  };
}
