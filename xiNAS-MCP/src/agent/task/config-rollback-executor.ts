/**
 * config.rollback executor (S9 T5, ADR-0011; targeted in S11, ADR-0013).
 *
 * One stage dispatched on `to`: `'baseline'` → the bridge's
 * `resetToBaseline(reason)` (S9); a snapshot id → `restoreSnapshot(id,
 * reason)` (S11 file-level targeted restore). The python transactional
 * runner owns the host-side safety (its own pre-change snapshot,
 * validation, auto-rollback) — which is also why this executor's
 * `rollback()` is a no-op: a failed reset/restore has ALREADY been rolled
 * back by the runner, and re-running anything from here could fight it.
 *
 * Targeted restore is an OBSERVED recovery — on success the stage emits the
 * drift caveat so the operator knows to re-apply/adopt to make it durable.
 */

import type { XinasHistoryBridge } from './xinas-history-bridge.js';
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';

interface RollbackSpec {
  reason: string;
  to: string;
  target_id?: string;
  baseline_id: string;
}

function narrowSpec(ctx: ExecutorContext): RollbackSpec {
  const s = ctx.spec as Partial<RollbackSpec>;
  if (typeof s.reason !== 'string' || s.reason.length === 0) {
    throw new Error('config.rollback: enriched spec missing reason');
  }
  return {
    reason: s.reason,
    to: typeof s.to === 'string' && s.to.length > 0 ? s.to : 'baseline',
    ...(typeof s.target_id === 'string' ? { target_id: s.target_id } : {}),
    baseline_id: s.baseline_id ?? 'baseline',
  };
}

export function makeConfigRollbackExecutor(opts: { bridge: XinasHistoryBridge }): Executor {
  const stages: ExecutorStage[] = [
    {
      name: 'restore',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx);

        if (spec.to === 'baseline') {
          ctx.emitOutput(`reset-to-baseline (${spec.baseline_id}): ${spec.reason}`);
          const result = await opts.bridge.resetToBaseline(spec.reason);
          if (result.success !== true) {
            throw new Error(
              `reset-to-baseline failed (runner auto-rollback applies): ${JSON.stringify(result)}`,
            );
          }
          ctx.emitOutput('baseline reset completed');
          return;
        }

        const targetId = spec.target_id ?? spec.to;
        ctx.emitOutput(`restore-snapshot (${targetId}): ${spec.reason}`);
        const result = await opts.bridge.restoreSnapshot(targetId, spec.reason);
        if (result.success !== true) {
          throw new Error(
            `restore-snapshot failed (runner auto-rollback applies): ${JSON.stringify(result)}`,
          );
        }
        ctx.emitOutput(
          'recovery applied — desired state unchanged; re-apply or adopt to make it ' +
            'durable, or the next apply will overwrite it',
        );
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
