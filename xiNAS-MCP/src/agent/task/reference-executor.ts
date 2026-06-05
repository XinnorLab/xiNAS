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
function readSpec(spec: unknown): { fail_at_stage?: string; message?: string } {
  if (typeof spec === 'object' && spec !== null) {
    return spec as { fail_at_stage?: string; message?: string };
  }
  return {};
}

/** Build a no-op stage that records output and honors `spec.fail_at_stage`. */
function makeStage(name: string): ExecutorStage {
  return {
    name,
    async run(ctx: ExecutorContext): Promise<void> {
      const spec = readSpec(ctx.spec);
      ctx.emitOutput(`reference.echo: ${name} starting`);
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
