import { describe, expect, it } from 'vitest';
import { referenceExecutor } from '../../../agent/task/reference-executor.js';
import type { ExecutorContext } from '../../../agent/task/types.js';

function makeCtx(spec: unknown): ExecutorContext & { output: string[] } {
  const output: string[] = [];
  return {
    spec,
    output,
    emitOutput(line: string): void {
      output.push(line);
    },
    isCancelRequested(): boolean {
      return false;
    },
  };
}

describe('referenceExecutor', () => {
  it('declares the reference.echo operation kind and preflight/apply/verify stages', () => {
    expect(referenceExecutor.operation_kind).toBe('reference.echo');
    expect(referenceExecutor.stages.map((s) => s.name)).toEqual(['preflight', 'apply', 'verify']);
  });

  it('runs every stage as a no-op that records output (success path)', async () => {
    const ctx = makeCtx({ message: 'hello' });
    for (const stage of referenceExecutor.stages) {
      await stage.run(ctx);
    }
    // Each stage recorded at least one output line; nothing threw.
    expect(ctx.output.length).toBeGreaterThanOrEqual(3);
    expect(ctx.output.join('\n')).toContain('preflight');
    expect(ctx.output.join('\n')).toContain('apply');
    expect(ctx.output.join('\n')).toContain('verify');
  });

  it('throws at the stage named by spec.fail_at_stage', async () => {
    const ctx = makeCtx({ fail_at_stage: 'apply' });
    const apply = referenceExecutor.stages.find((s) => s.name === 'apply');
    expect(apply).toBeDefined();
    await expect(apply?.run(ctx)).rejects.toThrow(/apply/);
  });

  it('does NOT throw at a non-matching stage when fail_at_stage is set', async () => {
    const ctx = makeCtx({ fail_at_stage: 'apply' });
    const preflight = referenceExecutor.stages.find((s) => s.name === 'preflight');
    await expect(preflight?.run(ctx)).resolves.toBeUndefined();
  });

  it('rollback is callable and records that it ran', async () => {
    const ctx = makeCtx({ fail_at_stage: 'apply' });
    await expect(referenceExecutor.rollback(ctx)).resolves.toBeUndefined();
    expect(ctx.output.join('\n')).toContain('rollback');
  });

  it('tolerates a non-object spec without throwing in a no-fail stage', async () => {
    const ctx = makeCtx('not-an-object');
    const preflight = referenceExecutor.stages.find((s) => s.name === 'preflight');
    await expect(preflight?.run(ctx)).resolves.toBeUndefined();
  });
});
