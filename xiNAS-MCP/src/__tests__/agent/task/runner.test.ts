import { describe, expect, it, vi } from 'vitest';
import { referenceExecutor } from '../../../agent/task/reference-executor.js';
import { TaskRunner } from '../../../agent/task/runner.js';
import type { Executor, ExecutorContext } from '../../../agent/task/types.js';
import type { TaskProgressEvent } from '../../../agent/task/types.js';
import { XinasHistoryBridge } from '../../../agent/task/xinas-history-bridge.js';

/** A bridge whose snapshotCreate returns deterministic ids in call order. */
function makeBridge(ids: string[]): XinasHistoryBridge {
  let i = 0;
  return new XinasHistoryBridge({
    runSubprocess: async () => {
      const id = ids[i] ?? `snap-${i}`;
      i += 1;
      return { stdout: JSON.stringify({ id }), code: 0 };
    },
  });
}

function makeRunner(bridge: XinasHistoryBridge): TaskRunner {
  let n = 0;
  return new TaskRunner({
    bridge,
    // Deterministic, monotonically increasing timestamps for assertions.
    now: () => new Date(1_700_000_000_000 + n++ * 1000).toISOString(),
  });
}

/** Project events to a compact [event_type, stage_name] tuple list. */
function shape(events: TaskProgressEvent[]): Array<[string, string | undefined]> {
  return events.map((e) => [e.event_type, e.stage_name]);
}

describe('TaskRunner.run — success path', () => {
  it('emits the full taxonomy with monotonic sequences and before/after snapshots', async () => {
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
    });
    const runner = makeRunner(makeBridge(['snap-before', 'snap-after']));

    await runner.run(
      { task_id: 't1', operation_kind: 'reference.echo', spec: { message: 'hi' } },
      referenceExecutor,
      publish,
    );

    expect(shape(events)).toEqual([
      ['accepted', undefined],
      ['stage_succeeded', 'snapshot_before'],
      ['stage_started', 'preflight'],
      ['stage_succeeded', 'preflight'],
      ['stage_started', 'apply'],
      ['stage_succeeded', 'apply'],
      ['stage_started', 'verify'],
      ['stage_succeeded', 'verify'],
      ['stage_succeeded', 'snapshot_after'],
      ['terminal', undefined],
    ]);

    // Sequences are 1..N strictly monotonic.
    expect(events.map((e) => e.sequence)).toEqual(events.map((_e, i) => i + 1));

    // Each distinct stage row gets its own stage_index so the api receiver's
    // (task_id, stage_index) upsert does NOT clobber them: the synthetic
    // snapshot_before/after must not collide with preflight (which is index 0
    // by the receiver's missing-index default). started/succeeded of one real
    // stage share the index assigned at start.
    const idxByName = new Map<string, number>();
    for (const e of events) {
      if (e.stage_name !== undefined && e.stage_index !== undefined) {
        const seen = idxByName.get(e.stage_name);
        if (seen !== undefined) expect(e.stage_index).toBe(seen);
        else idxByName.set(e.stage_name, e.stage_index);
      }
    }
    const indices = [...idxByName.values()];
    expect(new Set(indices).size).toBe(idxByName.size); // all distinct
    expect(idxByName.get('snapshot_before')).not.toBe(idxByName.get('preflight'));

    // snapshot_before/after carry the captured ids.
    const before = events.find((e) => e.stage_name === 'snapshot_before');
    const after = events.find((e) => e.stage_name === 'snapshot_after');
    expect(before?.snapshot_id).toBe('snap-before');
    expect(after?.snapshot_id).toBe('snap-after');

    // terminal reports success + the after snapshot.
    const terminal = events.at(-1);
    expect(terminal?.event_type).toBe('terminal');
    expect(terminal?.status).toBe('success');
    expect(terminal?.snapshot_id).toBe('snap-after');

    // Stage success events carry output + output_size_bytes.
    const preflightOk = events.find(
      (e) => e.event_type === 'stage_succeeded' && e.stage_name === 'preflight',
    );
    expect(preflightOk?.output_inline).toBeTruthy();
    expect(preflightOk?.output_size_bytes).toBe(
      Buffer.byteLength(preflightOk?.output_inline ?? '', 'utf8'),
    );
  });

  it('registers the task in-flight while running and removes it when done', async () => {
    const publish = vi.fn(async () => {});
    const runner = makeRunner(makeBridge(['b', 'a']));
    await runner.run(
      { task_id: 't-inflight', operation_kind: 'reference.echo', spec: {} },
      referenceExecutor,
      publish,
    );
    // After completion the task is no longer in flight.
    expect(runner.getInflight().has('t-inflight')).toBe(false);
  });
});

describe('TaskRunner.run — failure → rollback path', () => {
  it('emits stage_failed → rollback → terminal(FAILED_PARTIAL_ROLLED_BACK) and stops', async () => {
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
    });
    const runner = makeRunner(makeBridge(['snap-before', 'snap-after']));

    await runner.run(
      { task_id: 't2', operation_kind: 'reference.echo', spec: { fail_at_stage: 'apply' } },
      referenceExecutor,
      publish,
    );

    expect(shape(events)).toEqual([
      ['accepted', undefined],
      ['stage_succeeded', 'snapshot_before'],
      ['stage_started', 'preflight'],
      ['stage_succeeded', 'preflight'],
      ['stage_started', 'apply'],
      ['stage_failed', 'apply'],
      ['rollback_started', 'rollback'],
      ['rollback_succeeded', 'rollback'],
      ['terminal', undefined],
    ]);

    // No verify stage ran after the failure.
    expect(events.some((e) => e.stage_name === 'verify')).toBe(false);
    // No snapshot_after on the failure path.
    expect(events.some((e) => e.stage_name === 'snapshot_after')).toBe(false);

    expect(events.map((e) => e.sequence)).toEqual(events.map((_e, i) => i + 1));

    const failed = events.find((e) => e.event_type === 'stage_failed');
    expect(failed?.stage_name).toBe('apply');
    expect(failed?.error_message).toMatch(/apply/);

    const terminal = events.at(-1);
    expect(terminal?.event_type).toBe('terminal');
    expect(terminal?.status).toBe('failed');
    expect(terminal?.error_code).toBe('FAILED_PARTIAL_ROLLED_BACK');
  });

  it('emits rollback_failed → terminal(FAILED_MANUAL_RECOVERY_REQUIRED) when rollback throws', async () => {
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
    });
    const runner = makeRunner(makeBridge(['snap-before']));

    const brokenRollback: Executor = {
      operation_kind: 'reference.echo',
      stages: referenceExecutor.stages,
      async rollback(): Promise<void> {
        throw new Error('rollback exploded');
      },
    };

    await runner.run(
      { task_id: 't3', operation_kind: 'reference.echo', spec: { fail_at_stage: 'apply' } },
      brokenRollback,
      publish,
    );

    const types = events.map((e) => e.event_type);
    expect(types).toContain('rollback_started');
    expect(types).toContain('rollback_failed');
    expect(types).not.toContain('rollback_succeeded');

    const terminal = events.at(-1);
    expect(terminal?.event_type).toBe('terminal');
    expect(terminal?.status).toBe('requires_manual_recovery');
    expect(terminal?.error_code).toBe('FAILED_MANUAL_RECOVERY_REQUIRED');
    expect(events.map((e) => e.sequence)).toEqual(events.map((_e, i) => i + 1));
  });
});

describe('TaskRunner.run — ctx.stash threads a stage into rollback', () => {
  it('makes a value stashed in a stage visible to rollback (same ctx instance)', async () => {
    const publish = vi.fn(async () => {});
    const runner = makeRunner(makeBridge(['snap-before']));

    // A fake executor: its apply stage stashes a value then throws; rollback
    // reads the stashed value back. The runner must pass the SAME ctx (with the
    // same `stash`) to both the stage and rollback for this to work.
    let rollbackSawPrior: unknown;
    const stashingExecutor: Executor = {
      operation_kind: 'reference.echo',
      stages: [
        {
          name: 'apply',
          async run(ctx: ExecutorContext): Promise<void> {
            ctx.stash.priorThing = 'captured-at-stage';
            throw new Error('forced failure after stash');
          },
        },
      ],
      async rollback(ctx: ExecutorContext): Promise<void> {
        rollbackSawPrior = ctx.stash.priorThing;
      },
    };

    await runner.run(
      { task_id: 't-stash', operation_kind: 'reference.echo', spec: {} },
      stashingExecutor,
      publish,
    );

    expect(rollbackSawPrior).toBe('captured-at-stage');
  });
});

// ── S10 T2 (ADR-0012 §2/§3): cancel at boundaries + stage-throw attribution ──

/** A 2-stage executor whose stages call back so tests can flip the flag. */
function makeTwoStage(opts: {
  stage1?: (ctx: ExecutorContext) => void | Promise<void>;
  stage2?: (ctx: ExecutorContext) => void | Promise<void>;
  rollbackThrows?: boolean;
}): { executor: Executor; rollbackRan: () => boolean } {
  let rolledBack = false;
  const executor: Executor = {
    operation_kind: 'reference.echo',
    stages: [
      {
        name: 's1',
        run: async (ctx) => {
          await opts.stage1?.(ctx);
        },
      },
      {
        name: 's2',
        run: async (ctx) => {
          await opts.stage2?.(ctx);
        },
      },
    ],
    async rollback(): Promise<void> {
      rolledBack = true;
      if (opts.rollbackThrows) throw new Error('rollback exploded');
    },
  };
  return { executor, rollbackRan: () => rolledBack };
}

describe('TaskRunner.run — cancel (S10)', () => {
  async function run(executor: Executor, runnerRef: { runner?: TaskRunner } = {}) {
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
    });
    const runner = makeRunner(makeBridge(['snap-before', 'snap-after']));
    runnerRef.runner = runner;
    await runner.run({ task_id: 'tc', operation_kind: 'reference.echo', spec: {} }, executor, publish);
    return events;
  }

  it('cancel during stage 1 → boundary stop before stage 2, rollback, terminal(cancelled)', async () => {
    const ref: { runner?: TaskRunner } = {};
    const { executor, rollbackRan } = makeTwoStage({
      stage1: () => ref.runner?.requestCancel('tc'),
    });
    const events = await run(executor, ref);
    expect(shape(events)).toEqual([
      ['accepted', undefined],
      ['stage_succeeded', 'snapshot_before'],
      ['stage_started', 's1'],
      ['stage_succeeded', 's1'],
      ['rollback_started', 'rollback'],
      ['rollback_succeeded', 'rollback'],
      ['terminal', undefined],
    ]);
    const terminal = events.at(-1);
    expect(terminal?.status).toBe('cancelled');
    expect(terminal?.error_code).toBeUndefined();
    expect(rollbackRan()).toBe(true);
  });

  it('cancel before stage 0 (flag set pre-run) → no stages run, rollback, cancelled', async () => {
    // Set the flag from stage 1 of a PRIOR... simpler: a stage1 callback is
    // never reached because the flag is set via requestCancel between accept
    // and the loop — emulate by flipping inside snapshotCreate via the bridge?
    // The runner registers inflight at run() start, so requestCancel works
    // immediately; fire it on the microtask queue before stage 0 starts.
    const ref: { runner?: TaskRunner } = {};
    let stage1Ran = false;
    const { executor, rollbackRan } = makeTwoStage({
      stage1: () => {
        stage1Ran = true;
      },
    });
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
      // Cancel lands while snapshot_before is being reported — before stage 0.
      if (e.stage_name === 'snapshot_before') ref.runner?.requestCancel('tc');
    });
    const runner = makeRunner(makeBridge(['snap-before']));
    ref.runner = runner;
    await runner.run({ task_id: 'tc', operation_kind: 'reference.echo', spec: {} }, executor, publish);
    expect(stage1Ran).toBe(false);
    expect(shape(events)).toEqual([
      ['accepted', undefined],
      ['stage_succeeded', 'snapshot_before'],
      ['rollback_started', 'rollback'],
      ['rollback_succeeded', 'rollback'],
      ['terminal', undefined],
    ]);
    expect(events.at(-1)?.status).toBe('cancelled');
    expect(rollbackRan()).toBe(true);
  });

  it('stage throws while flag set → stage_failed + rollback + terminal(cancelled)', async () => {
    const ref: { runner?: TaskRunner } = {};
    const { executor } = makeTwoStage({
      stage1: () => {
        ref.runner?.requestCancel('tc');
        throw new Error('cancelled mid-stage');
      },
    });
    const events = await run(executor, ref);
    expect(shape(events)).toEqual([
      ['accepted', undefined],
      ['stage_succeeded', 'snapshot_before'],
      ['stage_started', 's1'],
      ['stage_failed', 's1'],
      ['rollback_started', 'rollback'],
      ['rollback_succeeded', 'rollback'],
      ['terminal', undefined],
    ]);
    const failed = events.find((e) => e.event_type === 'stage_failed');
    expect(failed?.error_message).toBe('cancelled mid-stage');
    const terminal = events.at(-1);
    expect(terminal?.status).toBe('cancelled');
    expect(terminal?.error_code).toBeUndefined();
  });

  it('stage throws while flag set + rollback throws → requires_manual_recovery', async () => {
    const ref: { runner?: TaskRunner } = {};
    const { executor } = makeTwoStage({
      stage1: () => {
        ref.runner?.requestCancel('tc');
        throw new Error('boom');
      },
      rollbackThrows: true,
    });
    const events = await run(executor, ref);
    const terminal = events.at(-1);
    expect(terminal?.status).toBe('requires_manual_recovery');
    expect(terminal?.error_code).toBe('FAILED_MANUAL_RECOVERY_REQUIRED');
  });

  it('cancel after the LAST stage completed is ignored → success', async () => {
    const ref: { runner?: TaskRunner } = {};
    const { executor, rollbackRan } = makeTwoStage({
      stage2: () => ref.runner?.requestCancel('tc'),
    });
    const events = await run(executor, ref);
    expect(events.at(-1)?.status).toBe('success');
    expect(rollbackRan()).toBe(false);
  });

  it('plain stage failure with NO flag stays terminal(failed)/FAILED_PARTIAL_ROLLED_BACK', async () => {
    const { executor } = makeTwoStage({
      stage1: () => {
        throw new Error('real failure');
      },
    });
    const events = await run(executor);
    const terminal = events.at(-1);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.error_code).toBe('FAILED_PARTIAL_ROLLED_BACK');
  });
});

// ── S10 T3: reference executor spec.sleep_ms (cancellable slow task) ─────────

describe('reference executor sleep_ms (S10)', () => {
  it('clampSleepMs: non-finite/negative → 0, cap 60_000', async () => {
    const { clampSleepMs } = await import('../../../agent/task/reference-executor.js');
    expect(clampSleepMs(undefined)).toBe(0);
    expect(clampSleepMs(-5)).toBe(0);
    expect(clampSleepMs('x')).toBe(0);
    expect(clampSleepMs(150)).toBe(150);
    expect(clampSleepMs(999_999)).toBe(60_000);
  });

  it('sleep_ms delays the apply stage and still succeeds', async () => {
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
    });
    const runner = makeRunner(makeBridge(['b', 'a']));
    const t0 = Date.now();
    await runner.run(
      { task_id: 'ts', operation_kind: 'reference.echo', spec: { sleep_ms: 150 } },
      referenceExecutor,
      publish,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(events.at(-1)?.status).toBe('success');
  });

  it('cancel during the sleep → apply throws → attributed → terminal(cancelled)', async () => {
    const events: TaskProgressEvent[] = [];
    const publish = vi.fn(async (e: TaskProgressEvent) => {
      events.push(e);
    });
    const runner = makeRunner(makeBridge(['b']));
    const done = runner.run(
      { task_id: 'tslow', operation_kind: 'reference.echo', spec: { sleep_ms: 10_000 } },
      referenceExecutor,
      publish,
    );
    await new Promise((r) => setTimeout(r, 250));
    runner.requestCancel('tslow');
    await done;
    const failed = events.find((e) => e.event_type === 'stage_failed');
    expect(failed?.stage_name).toBe('apply');
    expect(failed?.error_message).toContain('cancelled during sleep');
    expect(events.at(-1)?.status).toBe('cancelled');
  }, 15_000);
});
