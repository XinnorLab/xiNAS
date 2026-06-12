/**
 * Agent task runner (S2 T6, s2-task-envelope-spec §6/§7/§8).
 *
 * Drives an {@link Executor}'s stages for one task, wraps them with real
 * xinas_history `snapshot_before`/`snapshot_after` captures, runs the
 * executor's own `rollback()` on stage failure, and pushes the progress-event
 * taxonomy back to the api via an injected `publish`.
 *
 * The agent reports facts only — the api is the sole writer of `task_stages`
 * and `tasks` rows. The runner therefore only emits {@link TaskProgressEvent}s
 * with a per-task monotonic `sequence`; it never writes durable state itself.
 *
 * Emitted ordering (success):
 *   accepted → snapshot_before → (stage_started → stage_succeeded)* →
 *   snapshot_after → terminal(success)
 * Emitted ordering (stage failure):
 *   accepted → snapshot_before → … → stage_started → stage_failed →
 *   rollback_started → rollback_succeeded|rollback_failed → terminal(failed|
 *   requires_manual_recovery). No stages run after the failed one.
 */
import type {
  Executor,
  ExecutorContext,
  PublishProgress,
  TaskBegin,
  TaskProgressEvent,
  TaskProgressEventType,
} from './types.js';
import type { XinasHistoryBridge } from './xinas-history-bridge.js';

export interface TaskRunnerOptions {
  bridge: XinasHistoryBridge;
  /** Clock for `observed_at`. Default: `() => new Date().toISOString()`. */
  now?: () => string;
}

/** Bookkeeping for a task the runner is currently executing. */
export interface InflightTask {
  readonly task_id: string;
  readonly operation_kind: string;
  /** Set when a cancel has been requested for this task. */
  cancelRequested: boolean;
  /** High-water sequence emitted so far (for diagnostics). */
  sequence: number;
}

/** Stage name used for the synthetic rollback stage event. */
const ROLLBACK_STAGE = 'rollback';

export class TaskRunner {
  readonly #bridge: XinasHistoryBridge;
  readonly #now: () => string;
  readonly #inflight = new Map<string, InflightTask>();

  constructor(opts: TaskRunnerOptions) {
    this.#bridge = opts.bridge;
    this.#now = opts.now ?? (() => new Date().toISOString());
  }

  /** The in-flight registry (read by T7's `task.list_inflight`). */
  getInflight(): ReadonlyMap<string, InflightTask> {
    return this.#inflight;
  }

  /** Request cancellation of an in-flight task (cooperative; honored at stage boundaries). */
  requestCancel(taskId: string): void {
    const task = this.#inflight.get(taskId);
    if (task) task.cancelRequested = true;
  }

  /**
   * Execute one task end-to-end, emitting the progress taxonomy via `publish`.
   * Never throws for a stage failure — the failure is reported as events and a
   * terminal state. (A `publish` rejection or a bridge `snapshotCreate` failure
   * propagates; the api's reconciler is the durable backstop.)
   */
  async run(begin: TaskBegin, executor: Executor, publish: PublishProgress): Promise<void> {
    const inflight: InflightTask = {
      task_id: begin.task_id,
      operation_kind: begin.operation_kind,
      cancelRequested: false,
      sequence: 0,
    };
    this.#inflight.set(begin.task_id, inflight);

    const outputs: string[] = [];
    // Fresh per-run scratch; the SAME object flows to every stage and to
    // rollback() (ctx is a single instance), so a preflight stage can stash
    // prior state for the executor's rollback to read.
    const stash: Record<string, unknown> = {};
    const ctx: ExecutorContext = {
      spec: begin.spec,
      emitOutput(line: string): void {
        outputs.push(line);
      },
      isCancelRequested(): boolean {
        return inflight.cancelRequested;
      },
      stash,
    };

    // Drain the output accumulated since the last drain into an inline string.
    const drainOutput = (): { output_inline?: string; output_size_bytes?: number } => {
      if (outputs.length === 0) return {};
      const output_inline = outputs.splice(0).join('\n');
      return { output_inline, output_size_bytes: Buffer.byteLength(output_inline, 'utf8') };
    };

    const emit = (
      event_type: TaskProgressEventType,
      extra: Partial<TaskProgressEvent> = {},
    ): Promise<void> => {
      inflight.sequence += 1;
      const event: TaskProgressEvent = {
        task_id: begin.task_id,
        sequence: inflight.sequence,
        event_type,
        observed_at: this.#now(),
        ...extra,
      };
      return publish(event);
    };

    // Each distinct stage row — the synthetic snapshot_before/after + rollback,
    // and every real executor stage — gets its own emission-order stage_index so
    // the api receiver's (task_id, stage_index) upsert keeps them as DISTINCT
    // task_stages rows (a missing index defaults to 0 there, which would clobber
    // snapshot_before/after/rollback into the first real stage's row). The
    // started/succeeded pair for one real stage share the index assigned at start.
    let stageOrdinal = 0;
    const nextStageIndex = (): number => stageOrdinal++;

    try {
      // 1. accepted (seq 1).
      await emit('accepted');

      // 2. snapshot_before — real xinas_history capture.
      const before = await this.#bridge.snapshotCreate(begin.operation_kind, 'api');
      await emit('stage_succeeded', {
        stage_index: nextStageIndex(),
        stage_name: 'snapshot_before',
        status: 'succeeded',
        snapshot_id: before.snapshot_id,
      });

      // 3. Run each stage in order; stop at the first failure — or at a
      //    requested cancel. Safe points are BEFORE each executor stage
      //    (S10, ADR-0012 §2); deliberately no checkpoint after the loop, so
      //    a cancel landing after the last stage is ignored (→ success).
      for (let i = 0; i < executor.stages.length; i++) {
        const stage = executor.stages[i];
        if (!stage) continue;
        if (inflight.cancelRequested) {
          await this.#runRollback(executor, ctx, emit, drainOutput, nextStageIndex(), 'cancelled');
          return;
        }
        const stageIndex = nextStageIndex();
        await emit('stage_started', {
          stage_index: stageIndex,
          stage_name: stage.name,
          status: 'running',
        });
        try {
          await stage.run(ctx);
        } catch (err) {
          // Stage failed → report, run executor rollback, terminate. A throw
          // while cancel is requested is ATTRIBUTED to the cancel (ADR-0012
          // §3): same rollback, but the terminal is `cancelled`, not `failed`
          // — this is what makes the executors' own isCancelRequested()
          // throws (fs/xiraid checkCancelled) report the right state.
          await emit('stage_failed', {
            stage_index: stageIndex,
            stage_name: stage.name,
            status: 'failed',
            error_message: err instanceof Error ? err.message : String(err),
            ...drainOutput(),
          });
          await this.#runRollback(
            executor,
            ctx,
            emit,
            drainOutput,
            nextStageIndex(),
            inflight.cancelRequested ? 'cancelled' : 'failed',
          );
          return;
        }
        await emit('stage_succeeded', {
          stage_index: stageIndex,
          stage_name: stage.name,
          status: 'succeeded',
          ...drainOutput(),
        });
      }

      // 4. All stages ok → snapshot_after + terminal(success).
      const after = await this.#bridge.snapshotCreate(begin.operation_kind, 'api');
      await emit('stage_succeeded', {
        stage_index: nextStageIndex(),
        stage_name: 'snapshot_after',
        status: 'succeeded',
        snapshot_id: after.snapshot_id,
      });
      await emit('terminal', { status: 'success', snapshot_id: after.snapshot_id });
    } finally {
      this.#inflight.delete(begin.task_id);
    }
  }

  /**
   * Run the executor's rollback after a stage failure OR an honored cancel
   * and emit the rollback + terminal events. Rollback success →
   * `terminal(terminalStatus)` — `failed` carries
   * `FAILED_PARTIAL_ROLLED_BACK`; `cancelled` carries NO error_code (S10,
   * ADR-0012 §7). Rollback throwing →
   * `terminal(requires_manual_recovery, FAILED_MANUAL_RECOVERY_REQUIRED)`.
   */
  async #runRollback(
    executor: Executor,
    ctx: ExecutorContext,
    emit: (event_type: TaskProgressEventType, extra?: Partial<TaskProgressEvent>) => Promise<void>,
    drainOutput: () => { output_inline?: string; output_size_bytes?: number },
    rollbackIndex: number,
    terminalStatus: 'failed' | 'cancelled' = 'failed',
  ): Promise<void> {
    await emit('rollback_started', {
      stage_index: rollbackIndex,
      stage_name: ROLLBACK_STAGE,
      status: 'running',
    });
    try {
      await executor.rollback(ctx);
    } catch (err) {
      await emit('rollback_failed', {
        stage_index: rollbackIndex,
        stage_name: ROLLBACK_STAGE,
        status: 'failed',
        error_message: err instanceof Error ? err.message : String(err),
        ...drainOutput(),
      });
      await emit('terminal', {
        status: 'requires_manual_recovery',
        error_code: 'FAILED_MANUAL_RECOVERY_REQUIRED',
      });
      return;
    }
    await emit('rollback_succeeded', {
      stage_index: rollbackIndex,
      stage_name: ROLLBACK_STAGE,
      status: 'succeeded',
      ...drainOutput(),
    });
    await emit('terminal', {
      status: terminalStatus,
      ...(terminalStatus === 'failed' ? { error_code: 'FAILED_PARTIAL_ROLLED_BACK' } : {}),
    });
  }
}
