import { describe, expect, it, vi } from 'vitest';
import { referenceExecutor } from '../../../agent/task/reference-executor.js';
import { TaskRunner } from '../../../agent/task/runner.js';
import type { Executor } from '../../../agent/task/types.js';
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
