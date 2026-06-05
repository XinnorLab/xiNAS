/**
 * Executor registry (S2 T6, s2-task-envelope-spec §2).
 *
 * Maps an `operation_kind` to the {@link Executor} that handles it. Seeded with
 * the built-in {@link referenceExecutor}; real OS executors (S3–S6) register
 * themselves here. T7's `rpc/methods/task.ts` looks up the executor by
 * `task.begin.kind` before dispatching to the {@link TaskRunner}.
 */
import { referenceExecutor } from './reference-executor.js';
import type { Executor } from './types.js';

export class ExecutorRegistry {
  readonly #byKind = new Map<string, Executor>();

  constructor() {
    // Seed with the built-in reference executor.
    this.register(referenceExecutor);
  }

  /** Register (or replace) the executor for its `operation_kind`. */
  register(executor: Executor): void {
    this.#byKind.set(executor.operation_kind, executor);
  }

  /** Look up the executor for an operation kind, or undefined if none. */
  get(operationKind: string): Executor | undefined {
    return this.#byKind.get(operationKind);
  }
}
