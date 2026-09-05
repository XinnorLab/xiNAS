import { afterEach, describe, expect, it } from 'vitest';
import type { Producer } from '../../../api/events/engine.js';
import { CID, type Harness, makeHarness, types } from './_engine-harness.js';

/** A producer that emits whatever the test asks for. */
function scripted(
  script: (ctx: Parameters<NonNullable<Producer['onChange']>>[0]) => void,
): Producer {
  return { kinds: ['XiraidArray'], onChange: script };
}

describe('TransitionEngine (S17 §8.0)', () => {
  let h: Harness | undefined;
  afterEach(() => h?.close());

  it('inserts collected events inside the batch and reports the touched feeds', () => {
    h = makeHarness({
      producers: [
        scripted((ctx) => {
          ctx.emit({
            feed: 'raid',
            type: 'raid.state.degraded',
            subject: { kind: 'XiraidArray', id: ctx.id },
            args: { array: ctx.id },
          });
          ctx.emit({
            feed: 'system',
            type: 'system.reboot.detected',
            subject: { kind: 'Node', id: CID },
            args: {},
          });
        }),
      ],
    });
    let feeds: Set<string> = new Set();
    const events = h.batch((e) => {
      e.onChange({
        kind: 'XiraidArray',
        id: 'a',
        previous: { kind: 'XiraidArray', id: 'a', status: {} },
        current: { kind: 'XiraidArray', id: 'a', status: {} },
        previousRevision: 1,
      });
      feeds = e.commit().feeds;
    });
    expect(types(events)).toEqual(['raid.state.degraded', 'system.reboot.detected']);
    expect([...feeds].sort()).toEqual(['raid', 'system']);
    expect(events[0]?.controllerId).toBe(CID);
    expect(events[0]?.source).toEqual({ kind: 'observed_transition', component: 'XiraidArray' });
    expect(events[0]?.detectedAt).toBe('2026-09-04T12:00:00.000Z');
  });

  it('rolls the events back together with a throwing batch', () => {
    h = makeHarness({
      producers: [
        scripted((ctx) => {
          ctx.emit({
            feed: 'raid',
            type: 'raid.state.degraded',
            subject: { kind: 'XiraidArray', id: ctx.id },
            args: { array: ctx.id },
          });
        }),
      ],
    });
    const harness = h;
    expect(() =>
      harness.batch((e) => {
        e.onChange({
          kind: 'XiraidArray',
          id: 'a',
          previous: { status: {} },
          current: { status: {} },
          previousRevision: 1,
        });
        e.commit();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(harness.journal.count()).toBe(0);
  });

  it('drops a non-baseline event emitted for a first observation and logs it', () => {
    const logged: string[] = [];
    h = makeHarness({
      producers: [
        scripted((ctx) => {
          ctx.emit({
            feed: 'raid',
            type: 'raid.state.degraded',
            subject: { kind: 'XiraidArray', id: ctx.id },
            args: { array: ctx.id },
          });
          ctx.emit({
            feed: 'raid',
            type: 'raid.state.offline',
            subject: { kind: 'XiraidArray', id: ctx.id },
            args: { array: ctx.id },
            reasonCode: 'baseline',
          });
        }),
      ],
      log: (_level, msg) => logged.push(msg),
    });
    const events = h.step('XiraidArray', 'a', null, { status: {} });
    expect(types(events)).toEqual(['raid.state.offline']);
    expect(logged.some((m) => m.includes('baseline'))).toBe(true);
  });

  it('emitDirect writes outside a batch and returns the feed', () => {
    h = makeHarness({ producers: [] });
    const { feeds } = h.engine.emitDirect({
      feed: 'system',
      type: 'system.agent.offline',
      subject: { kind: 'Agent', id: 'xinas-agent' },
      source: { kind: 'heartbeat', component: 'heartbeat' },
      args: {},
      reasonCode: 'connect_refused',
    });
    expect([...feeds]).toEqual(['system']);
    expect(h.journal.listAfter('system', 0, 10)[0]).toMatchObject({
      type: 'system.agent.offline',
      severity: 'error',
      source: { kind: 'heartbeat', component: 'heartbeat' },
    });
  });

  it('marks a kind baseline-done after its first complete snapshot, not before', () => {
    h = makeHarness({ producers: [] });
    expect(h.engine.baselineDone('XiraidArray')).toBe(false);
    h.batch((e) => {
      e.onSnapshot('XiraidArray', new Set(['a']));
      // Inside the batch the flag still reflects the start of the batch.
      expect(e.baselineDone('XiraidArray')).toBe(false);
    });
    expect(h.engine.baselineDone('XiraidArray')).toBe(true);
  });

  it('correlates a task only through the injected lookup', () => {
    const calls: unknown[] = [];
    h = makeHarness({
      producers: [
        scripted((ctx) => {
          const cause = ctx.correlate(['xiraid.array.create']);
          ctx.emit({
            feed: 'raid',
            type: 'raid.array.created',
            subject: { kind: 'XiraidArray', id: ctx.id },
            args: { array: ctx.id },
            ...(cause !== undefined ? { cause, timeAccuracy: 'task' } : {}),
          });
        }),
      ],
      taskLookup: (kinds, subject) => {
        calls.push([kinds, subject]);
        return { taskId: 't-1', operationId: 'c-1' };
      },
    });
    h.batch((e) => e.onSnapshot('XiraidArray', new Set()));
    const events = h.step('XiraidArray', 'a', null, { status: {} });
    expect(calls).toEqual([[['xiraid.array.create'], { kind: 'XiraidArray', id: 'a' }]]);
    expect(events[0]?.cause).toEqual({ taskId: 't-1', operationId: 'c-1' });
    expect(events[0]?.timeAccuracy).toBe('task');
  });
});
