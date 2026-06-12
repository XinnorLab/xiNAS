/**
 * Reference executor (S2 T6, s2-task-envelope-spec §8).
 *
 * Built-in, safe, inert (`operation_kind: 'reference.echo'`). Its three stages
 * — preflight → apply → verify — are no-ops that record output; `rollback()` is
 * a trivial inverse that records it ran. It exists to prove the task engine
 * end-to-end before any real OS executor exists.
 *
 * `spec.fail_at_stage` (a stage name) forces that stage to throw, so the
 * runner's failure→rollback path is genuinely exercised. Anything else about
 * `spec` is echoed but otherwise ignored.
 */
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';

/** Narrow the opaque ctx.spec to the reference executor's optional fields. */
function readSpec(spec: unknown): { fail_at_stage?: string; message?: string; sleep_ms?: number } {
  if (typeof spec === 'object' && spec !== null) {
    return spec as { fail_at_stage?: string; message?: string; sleep_ms?: number };
  }
  return {};
}

/** Clamp spec.sleep_ms to [0, 60_000] (S10, ADR-0012 §7). */
export function clampSleepMs(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(v, 60_000);
}

const SLEEP_CHUNK_MS = 100;

/** Build a no-op stage that records output and honors `spec.fail_at_stage`. */
function makeStage(name: string): ExecutorStage {
  return {
    name,
    async run(ctx: ExecutorContext): Promise<void> {
      const spec = readSpec(ctx.spec);
      ctx.emitOutput(`reference.echo: ${name} starting`);
      // S10: a cancellable slow task for tests/e2e — sleep in chunks in the
      // `apply` stage only, polling the cancel flag; the throw is attributed
      // to the cancel by the runner (ADR-0012 §3) → terminal(cancelled).
      const sleepMs = name === 'apply' ? clampSleepMs(spec.sleep_ms) : 0;
      if (sleepMs > 0) {
        ctx.emitOutput(`reference.echo: apply sleeping ${sleepMs}ms`);
        const until = Date.now() + sleepMs;
        while (Date.now() < until) {
          if (ctx.isCancelRequested()) {
            throw new Error('reference.echo: cancelled during sleep');
          }
          await new Promise((r) => setTimeout(r, Math.min(SLEEP_CHUNK_MS, until - Date.now())));
        }
      }
      if (spec.fail_at_stage === name) {
        ctx.emitOutput(`reference.echo: ${name} forced failure (fail_at_stage)`);
        throw new Error(`reference.echo: forced failure at stage '${name}'`);
      }
      if (spec.message !== undefined) {
        ctx.emitOutput(`reference.echo: ${name} echo='${spec.message}'`);
      }
      ctx.emitOutput(`reference.echo: ${name} ok`);
    },
  };
}

export const referenceExecutor: Executor = {
  operation_kind: 'reference.echo',
  stages: [makeStage('preflight'), makeStage('apply'), makeStage('verify')],
  async rollback(ctx: ExecutorContext): Promise<void> {
    // Inert inverse: there is nothing to undo, but record that rollback ran so
    // the failure path is observable end-to-end.
    ctx.emitOutput('reference.echo: rollback (inert inverse) ran');
  },
};
