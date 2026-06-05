import { describe, expect, it } from 'vitest';
import { referenceExecutor } from '../../../agent/task/reference-executor.js';
import { ExecutorRegistry } from '../../../agent/task/registry.js';
import type { Executor } from '../../../agent/task/types.js';

describe('ExecutorRegistry', () => {
  it('is seeded with the reference executor', () => {
    const reg = new ExecutorRegistry();
    expect(reg.get('reference.echo')).toBe(referenceExecutor);
  });

  it('returns undefined for an unknown operation kind', () => {
    const reg = new ExecutorRegistry();
    expect(reg.get('nope.unknown')).toBeUndefined();
  });

  it('register adds an executor that get() can retrieve', () => {
    const reg = new ExecutorRegistry();
    const fake: Executor = {
      operation_kind: 'fake.op',
      stages: [],
      async rollback(): Promise<void> {},
    };
    reg.register(fake);
    expect(reg.get('fake.op')).toBe(fake);
  });

  it('register overwrites a previously registered executor for the same kind', () => {
    const reg = new ExecutorRegistry();
    const a: Executor = { operation_kind: 'dup', stages: [], async rollback(): Promise<void> {} };
    const b: Executor = { operation_kind: 'dup', stages: [], async rollback(): Promise<void> {} };
    reg.register(a);
    reg.register(b);
    expect(reg.get('dup')).toBe(b);
  });
});
