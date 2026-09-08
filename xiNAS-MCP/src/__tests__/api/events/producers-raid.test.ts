import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { poolProducer, raidProducer } from '../../../api/events/producers/raid.js';
import { type Harness, OBSERVED_AT, type Row, makeHarness, types } from './_engine-harness.js';

interface ArrayOpts {
  members?: Array<[string, string[]]>;
  spare?: string[];
  pool?: string;
  init?: number | null;
  recon?: number | null;
  level?: string;
}

/** An observed XiraidArray row as the S17-corrected parser publishes it. */
function arrayRow(raw: string[], o: ArrayOpts = {}): Row {
  const members = o.members ?? [
    ['d1', ['online']],
    ['d2', ['online']],
    ['d3', ['online']],
  ];
  return {
    kind: 'XiraidArray',
    id: 'a',
    spec: {
      name: 'a',
      level: o.level ?? 'raid5',
      member_disk_ids: members.map(([d]) => d),
      spare_disk_ids: o.spare ?? [],
      ...(o.pool !== undefined ? { spare_pool: o.pool } : {}),
    },
    status: {
      state: 'unknown',
      volume_path: '/dev/xi_a',
      raw_states: raw,
      init_progress_pct: o.init ?? null,
      recon_progress_pct: o.recon ?? null,
      restripe_progress_pct: null,
      sdc_progress_pct: null,
      member_states: members.map(([device, states], index) => ({ index, device, states })),
      observed_at: OBSERVED_AT,
    },
  };
}

const poolRow = (name: string, drives: string[]): Row => ({
  kind: 'Pool',
  id: name,
  status: { name, drives, active: true, observed_at: OBSERVED_AT },
});

describe('RAID producer (S17 §8.2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ producers: [raidProducer, poolProducer] });
  });
  afterEach(() => h.close());

  const step = (prev: string[] | null, cur: string[] | null, po?: ArrayOpts, co?: ArrayOpts) =>
    h.step(
      'XiraidArray',
      'a',
      prev === null ? null : arrayRow(prev, po),
      cur === null ? null : arrayRow(cur, co),
    );

  describe('operation lifecycle', () => {
    it('first observation of an active initialization is observed_running, not started', () => {
      const ev = step(null, ['online', 'initing']);
      expect(types(ev)).toEqual(['raid.operation.observed_running']);
      expect(ev[0]?.operation).toEqual({ kind: 'initialization', generation: 1 });
      expect(ev[0]?.severity).toBe('info');
    });

    it('entering initing from a healthy array is started', () => {
      const ev = step(['online'], ['online', 'initing']);
      expect(types(ev)).toEqual(['raid.operation.started']);
      expect(ev[0]?.operation).toEqual({ kind: 'initialization', generation: 1 });
      expect(ev[0]?.summary).toBe('RAID array a: initialization started');
    });

    it('leaving initing into a validated healthy state completes', () => {
      step(['online'], ['online', 'initing']);
      const ev = step(['online', 'initing'], ['online', 'initialized']);
      expect(types(ev)).toEqual(['raid.operation.completed']);
    });

    it('leaving initing into need_init fails with warning', () => {
      step(['online'], ['online', 'initing']);
      const ev = step(['online', 'initing'], ['need_init']);
      expect(types(ev)).toEqual(['raid.operation.failed']);
      expect(ev[0]?.severity).toBe('warning');
      expect(ev[0]?.details).toMatchObject({ finalStates: ['need_init'] });
    });

    it('leaving initing into offline fails with error and also reports the offline state', () => {
      step(['online'], ['online', 'initing']);
      const ev = step(['online', 'initing'], ['offline']);
      expect(types(ev)).toEqual(['raid.operation.failed', 'raid.state.offline']);
      expect(ev[0]?.severity).toBe('error');
      expect(ev[1]?.severity).toBe('critical');
    });

    it('reconstruction: degraded → reconstructing starts, → online completes and recovers', () => {
      expect(types(step(['online'], ['degraded']))).toEqual(['raid.state.degraded']);
      expect(types(step(['degraded'], ['degraded', 'reconstructing']))).toEqual([
        'raid.operation.started',
      ]);
      const ev = step(['degraded', 'reconstructing'], ['online']);
      expect(types(ev)).toEqual(['raid.operation.completed', 'raid.state.recovered']);
      expect(ev[0]?.operation).toEqual({ kind: 'reconstruction', generation: 1 });
      expect(ev[1]?.previous).toMatchObject({ severity: 'error' });
    });

    it('reconstruction ending in need_recon is a failure', () => {
      step(['degraded'], ['degraded', 'reconstructing']);
      const ev = step(['degraded', 'reconstructing'], ['need_recon']);
      expect(types(ev)).toEqual(['raid.operation.failed']);
    });

    it('array word online with a member still reconstructing is not a completion', () => {
      step(['online'], ['online', 'initing']);
      const ev = step(['online', 'initing'], ['online'], undefined, {
        members: [
          ['d1', ['online']],
          ['d2', ['reconstructing']],
          ['d3', ['online']],
        ],
      });
      expect(types(ev)).toEqual(['raid.operation.failed']);
    });

    it('a second start increments the generation', () => {
      step(['online'], ['online', 'initing']);
      step(['online', 'initing'], ['online']);
      const ev = step(['online'], ['online', 'initing']);
      expect(ev[0]?.operation).toEqual({ kind: 'initialization', generation: 2 });
    });
  });

  describe('undecidable states never end an operation (I-01)', () => {
    it('an unknown array word at the end of an initialization is warned, kept active, and settled by the first proven state', () => {
      step(['online'], ['online', 'initing']);
      let ev = step(['online', 'initing'], ['future_state']);
      expect(types(ev)).toEqual(['raid.source.unknown_state']);
      expect(h.journal.metaGet('raid_op:a:initialization')).toEqual({
        generation: 1,
        active: true,
      });
      ev = step(['future_state'], ['online']);
      expect(types(ev)).toEqual(['raid.operation.completed']);
      expect(ev[0]?.operation).toEqual({ kind: 'initialization', generation: 1 });
      expect(h.journal.metaGet('raid_op:a:initialization')).toEqual({
        generation: 1,
        active: false,
      });
      expect(types(step(['online'], ['online']))).toEqual([]);
    });

    it('online beside an unknown word is still undecided; a later proven fault is the failure', () => {
      step(['online'], ['online', 'initing']);
      expect(types(step(['online', 'initing'], ['online', 'future_state']))).toEqual([
        'raid.source.unknown_state',
      ]);
      const ev = step(['online', 'future_state'], ['offline']);
      expect(types(ev)).toEqual(['raid.operation.failed', 'raid.state.offline']);
      expect(ev[0]?.details).toMatchObject({ finalStates: ['offline'], generation: 1 });
    });

    it('a proven fault beside an unknown word is still a failure', () => {
      step(['online'], ['online', 'initing']);
      const ev = step(['online', 'initing'], ['need_init', 'future_state']);
      expect(types(ev)).toEqual(['raid.source.unknown_state', 'raid.operation.failed']);
    });

    it('an unknown member word blocks completion (warned once); members proven online complete it once', () => {
      step(['online'], ['online', 'initing']);
      const weird: ArrayOpts = {
        members: [
          ['d1', ['online']],
          ['d2', ['future_member_state']],
          ['d3', ['online']],
        ],
      };
      let ev = step(['online', 'initing'], ['online'], undefined, weird);
      expect(types(ev)).toEqual(['raid.source.unknown_state']);
      expect(ev[0]?.details).toMatchObject({ word: 'future_member_state' });
      expect(types(step(['online'], ['online'], weird, weird))).toEqual([]);
      ev = step(['online'], ['online'], weird, undefined);
      expect(types(ev)).toEqual(['raid.operation.completed']);
      expect(types(step(['online'], ['online']))).toEqual([]);
    });

    it('a member reading an array-only word is unknown, not healthy (member vocabulary is narrower)', () => {
      step(['online'], ['online', 'initing']);
      const arrayWordOnMember: ArrayOpts = {
        members: [
          ['d1', ['online']],
          ['d2', ['initialized']],
          ['d3', ['online']],
        ],
      };
      const ev = step(['online', 'initing'], ['online'], undefined, arrayWordOnMember);
      expect(types(ev)).toEqual(['raid.source.unknown_state']);
      expect(ev[0]?.details).toMatchObject({ word: 'initialized' });
      expect(h.journal.metaGet('raid_op:a:initialization')).toEqual({
        generation: 1,
        active: true,
      });
    });

    it('a member with no state is undecided, not healthy', () => {
      step(['online'], ['online', 'initing']);
      const blank: ArrayOpts = {
        members: [
          ['d1', ['online']],
          ['d2', []],
          ['d3', ['online']],
        ],
      };
      expect(types(step(['online', 'initing'], ['online'], undefined, blank))).toEqual([]);
      expect(h.journal.metaGet('raid_op:a:initialization')).toEqual({
        generation: 1,
        active: true,
      });
    });

    it('the active word reappearing while the end is undecided is not a new start', () => {
      step(['online'], ['online', 'initing']);
      step(['online', 'initing'], ['future_state']);
      expect(types(step(['future_state'], ['online', 'initing']))).toEqual([]);
      const ev = step(['online', 'initing'], ['online']);
      expect(types(ev)).toEqual(['raid.operation.completed']);
      expect(ev[0]?.operation).toEqual({ kind: 'initialization', generation: 1 });
    });

    it('an unknown word does not recover a condition; the proven healthy row does', () => {
      expect(types(step(['online'], ['degraded']))).toEqual(['raid.state.degraded']);
      expect(types(step(['degraded'], ['future_state']))).toEqual(['raid.source.unknown_state']);
      expect(types(step(['future_state'], ['online']))).toEqual(['raid.state.recovered']);
    });
  });

  describe('array state conditions', () => {
    it.each([
      [['online', 'read_only'], 'raid.state.read_only', 'error'],
      [['unrecovered'], 'raid.state.unrecovered', 'critical'],
      [['offline'], 'raid.state.offline', 'critical'],
      [['need_recon'], 'raid.state.degraded', 'error'],
    ])('online → %j emits %s (%s)', (cur, type, severity) => {
      const ev = step(['online'], cur);
      expect(types(ev)).toEqual([type]);
      expect(ev[0]?.severity).toBe(severity);
      expect(ev[0]?.current).toMatchObject({ raw_states: cur });
    });

    it('none maps to offline with reason state_none', () => {
      const ev = step(['online'], ['none']);
      expect(types(ev)).toEqual(['raid.state.offline']);
      expect(ev[0]?.reasonCode).toBe('state_none');
    });

    it.each([
      ['sdc_scanning'],
      ['need_restripe'],
      ['need_resize'],
      ['restriping'],
      ['inconsistent'],
      ['need_init'],
      ['initialized'],
    ])('online → online+%s emits no state event (Phase 2 word)', (word) => {
      expect(types(step(['online'], ['online', word]))).toEqual([]);
    });

    it('first observation in offline is reported with reason baseline; degraded is not', () => {
      const ev = step(null, ['offline']);
      expect(types(ev)).toEqual(['raid.state.offline']);
      expect(ev[0]?.reasonCode).toBe('baseline');
      h.close();
      h = makeHarness({ producers: [raidProducer, poolProducer] });
      expect(types(step(null, ['degraded']))).toEqual([]);
    });

    it('a condition that was never reported is not "recovered" from', () => {
      step(null, ['degraded']);
      expect(types(step(['degraded'], ['online']))).toEqual([]);
    });

    it('fault, recovery and a repeated fault are three distinct events', () => {
      step(['online'], ['degraded']);
      step(['degraded'], ['online']);
      const ev = step(['online'], ['degraded']);
      expect(types(ev)).toEqual(['raid.state.degraded']);
      expect(h.journal.count()).toBe(3);
    });

    it('steady identical observations produce nothing', () => {
      expect(types(step(['degraded'], ['degraded']))).toEqual([]);
    });

    it('a previous row without raw_states (pre-S17) still yields a correct entry event', () => {
      const prev = arrayRow(['online']);
      (prev.status as Record<string, unknown>).raw_states = undefined;
      const ev = h.step('XiraidArray', 'a', prev, arrayRow(['degraded']));
      expect(types(ev)).toEqual(['raid.state.degraded']);
    });
  });

  describe('unknown state words', () => {
    it('warns once per (array, word) and never crashes the batch', () => {
      expect(types(step(['online'], ['online', 'weird']))).toEqual(['raid.source.unknown_state']);
      expect(types(step(['online', 'weird'], ['online', 'weird', 'odd']))).toEqual([
        'raid.source.unknown_state',
      ]);
      expect(types(step(['online', 'weird', 'odd'], ['online', 'weird']))).toEqual([]);
    });

    it('tolerates malformed status payloads', () => {
      const bad: Row = {
        kind: 'XiraidArray',
        id: 'a',
        status: { state: 'unknown', raw_states: 'online', member_states: 'x' },
      };
      expect(() => h.step('XiraidArray', 'a', arrayRow(['online']), bad)).not.toThrow();
      expect(() => h.step('XiraidArray', 'a', bad, { kind: 'XiraidArray', id: 'a' })).not.toThrow();
      expect(() =>
        h.step(
          'XiraidArray',
          'a',
          { kind: 'XiraidArray', id: 'a', status: null },
          arrayRow(['online']),
        ),
      ).not.toThrow();
    });
  });

  describe('members', () => {
    it('member online → offline is reported against the Disk', () => {
      const ev = step(['online'], ['degraded'], undefined, {
        members: [
          ['d1', ['online']],
          ['d2', ['offline']],
          ['d3', ['online']],
        ],
      });
      expect(types(ev)).toEqual(['raid.state.degraded', 'raid.member.offline']);
      expect(ev[1]?.subject).toEqual({ kind: 'Disk', id: 'd2' });
      expect(ev[1]?.relatedResources).toEqual([{ kind: 'XiraidArray', id: 'a' }]);
      expect(ev[1]?.details).toMatchObject({ array: 'a', device: 'd2', states: ['offline'] });
    });

    it('member offline → online is returned', () => {
      const off: ArrayOpts = {
        members: [
          ['d1', ['online']],
          ['d2', ['offline']],
          ['d3', ['online']],
        ],
      };
      step(['online'], ['degraded'], undefined, off);
      const ev = step(['degraded'], ['degraded'], off, undefined);
      expect(types(ev)).toEqual(['raid.member.returned']);
    });

    it('a member replaced by a drive from the array spare pool is a completed replacement', () => {
      const prev: ArrayOpts = { pool: 'p', spare: ['s1'] };
      const cur: ArrayOpts = {
        pool: 'p',
        spare: [],
        members: [
          ['d1', ['online']],
          ['s1', ['reconstructing']],
          ['d3', ['online']],
        ],
      };
      const ev = step(['online'], ['degraded', 'reconstructing'], prev, cur);
      expect(types(ev)).toEqual([
        'raid.state.degraded',
        'raid.operation.started',
        'raid.spare.replacement.completed',
      ]);
      expect(ev[2]?.details).toMatchObject({
        array: 'a',
        replaced: 'd2',
        replacement: 's1',
        pool: 'p',
      });
    });
  });

  describe('array lifecycle', () => {
    it('a row that appears after the kind baseline is created; before it, nothing', () => {
      expect(types(step(null, ['online']))).toEqual([]);
      h.snapshot('XiraidArray', ['a']);
      const ev = h.step('XiraidArray', 'b', null, { ...arrayRow(['online']), id: 'b' });
      expect(types(ev)).toEqual(['raid.array.created']);
      expect(ev[0]?.details).toMatchObject({ level: 'raid5', memberCount: 3 });
    });

    it('a reconcile delete is removed, with the in-flight operation noted and no completion', () => {
      step(['online'], ['online', 'initing']);
      const ev = step(['online', 'initing'], null);
      expect(types(ev)).toEqual(['raid.array.removed']);
      expect(ev[0]?.details).toMatchObject({ operationInProgress: 'initialization' });
    });

    it('carries the creating task as the cause when the lookup finds one', () => {
      h.close();
      h = makeHarness({
        producers: [raidProducer, poolProducer],
        taskLookup: (kinds) =>
          kinds.includes('xiraid.array.create')
            ? { taskId: 't-c', operationId: 'op-c', occurredAtMs: Date.parse(OBSERVED_AT) - 2000 }
            : null,
      });
      h.snapshot('XiraidArray', []);
      const ev = h.step('XiraidArray', 'a', null, arrayRow(['online']));
      expect(ev[0]?.cause).toEqual({ taskId: 't-c', operationId: 'op-c' });
      expect(ev[0]?.timeAccuracy).toBe('task');
      expect(ev[0]?.occurredAt).toBe('2026-09-04T11:59:58.000Z');
    });

    it('a still-running creating task is named but leaves the event observed (no invented time)', () => {
      h.close();
      h = makeHarness({
        producers: [raidProducer, poolProducer],
        taskLookup: (kinds) => (kinds.includes('xiraid.array.create') ? { taskId: 't-r' } : null),
      });
      h.snapshot('XiraidArray', []);
      const ev = h.step('XiraidArray', 'a', null, arrayRow(['online']));
      expect(ev[0]?.cause).toEqual({ taskId: 't-r' });
      expect(ev[0]?.timeAccuracy).toBe('observed');
      expect(ev[0]?.occurredAt).toBeUndefined();
    });
  });

  describe('spare pools', () => {
    it('drives leaving and returning, exhaustion and replenishment', () => {
      h.kv.put('XiraidArray', 'a', arrayRow(['online'], { pool: 'p', spare: ['s1', 's2'] }));
      let ev = h.step('Pool', 'p', poolRow('p', ['s1', 's2']), poolRow('p', ['s1']));
      expect(types(ev)).toEqual(['raid.spare.disconnected']);
      expect(ev[0]?.details).toMatchObject({ pool: 'p', device: 's2' });
      ev = h.step('Pool', 'p', poolRow('p', ['s1']), poolRow('p', []));
      expect(types(ev)).toEqual(['raid.spare.disconnected', 'raid.spare_pool.exhausted']);
      ev = h.step('Pool', 'p', poolRow('p', []), poolRow('p', ['s3']));
      expect(types(ev)).toEqual(['raid.spare.returned', 'raid.spare_pool.replenished']);
    });

    it('an unreferenced pool running dry is not exhaustion', () => {
      expect(types(h.step('Pool', 'q', poolRow('q', ['s1']), poolRow('q', [])))).toEqual([
        'raid.spare.disconnected',
      ]);
    });

    it('a drive consumed by an automatic replacement is not reported as disconnected', () => {
      step(
        ['online'],
        ['degraded', 'reconstructing'],
        { pool: 'p', spare: ['s1'] },
        {
          pool: 'p',
          spare: [],
          members: [
            ['d1', ['online']],
            ['s1', ['reconstructing']],
            ['d3', ['online']],
          ],
        },
      );
      // The replacement consumed the last spare: the pool IS exhausted, but the
      // drive itself was not "disconnected".
      const ev = h.step('Pool', 'p', poolRow('p', ['s1']), poolRow('p', []));
      expect(types(ev)).toEqual(['raid.spare_pool.exhausted']);
    });
  });

  describe('restore after reboot', () => {
    it('reports one outcome per previously known array on the first complete snapshot', () => {
      h.journal.metaSet('restore_pending', { bootId: 'b2', knownArrays: ['a', 'b', 'c', 'd'] });
      h.kv.put('XiraidArray', 'a', arrayRow(['online']));
      h.kv.put('XiraidArray', 'b', { ...arrayRow(['read_only', 'online']), id: 'b' });
      h.kv.put('XiraidArray', 'c', { ...arrayRow(['offline']), id: 'c' });
      const ev = h.batch(
        (e) => {
          e.onChange({
            kind: 'XiraidArray',
            id: 'd',
            previous: { ...arrayRow(['online']), id: 'd' },
            current: null,
            previousRevision: 1,
          });
          e.onSnapshot('XiraidArray', new Set(['a', 'b', 'c']));
        },
        { completeSnapshots: ['XiraidArray'] },
      );
      expect(types(ev)).toEqual([
        'raid.restore.completed',
        'raid.restore.completed',
        'raid.restore.completed',
        'raid.restore.failed',
      ]);
      expect(ev.map((e) => [e.subject.id, e.severity, e.details?.result])).toEqual([
        ['a', 'info', 'healthy'],
        ['b', 'warning', 'read_only'],
        ['c', 'error', 'offline'],
        ['d', 'error', 'not_restored'],
      ]);
      expect(h.journal.metaGet('restore_pending')).toBeNull();
    });

    it('an array observed as none after a reboot is not restored', () => {
      h.journal.metaSet('restore_pending', { bootId: 'b2', knownArrays: ['a'] });
      h.kv.put('XiraidArray', 'a', arrayRow(['none']));
      const ev = h.snapshot('XiraidArray', ['a']);
      expect(types(ev)).toEqual(['raid.restore.failed']);
    });

    it('a snapshot of another kind does not evaluate the pending restore', () => {
      h.journal.metaSet('restore_pending', { bootId: 'b2', knownArrays: ['a'] });
      expect(types(h.snapshot('Pool', []))).toEqual([]);
      expect(h.journal.metaGet('restore_pending')).not.toBeNull();
    });

    it('names degraded, running, unknown, unrecovered and member-faulted arrays instead of calling them healthy (I-01)', () => {
      h.journal.metaSet('restore_pending', {
        bootId: 'b2',
        knownArrays: ['a', 'b', 'c', 'd', 'e'],
      });
      h.kv.put('XiraidArray', 'a', arrayRow(['degraded', 'reconstructing']));
      h.kv.put('XiraidArray', 'b', { ...arrayRow(['online', 'initing']), id: 'b' });
      h.kv.put('XiraidArray', 'c', { ...arrayRow(['online', 'future_state']), id: 'c' });
      h.kv.put('XiraidArray', 'd', { ...arrayRow(['unrecovered']), id: 'd' });
      h.kv.put('XiraidArray', 'e', {
        ...arrayRow(['online'], {
          members: [
            ['d1', ['online']],
            ['d2', ['offline']],
            ['d3', ['online']],
          ],
        }),
        id: 'e',
      });
      const ev = h.snapshot('XiraidArray', ['a', 'b', 'c', 'd', 'e']);
      expect(ev.map((e) => [e.subject.id, e.type, e.severity, e.details?.result])).toEqual([
        ['a', 'raid.restore.completed', 'error', 'degraded'],
        ['b', 'raid.restore.completed', 'info', 'running'],
        ['c', 'raid.restore.completed', 'warning', 'unknown'],
        ['d', 'raid.restore.completed', 'critical', 'unrecovered'],
        ['e', 'raid.restore.completed', 'error', 'unhealthy'],
      ]);
      expect(h.journal.metaGet('restore_pending')).toBeNull();
    });
  });
});

describe('RAID progress producer (S17 §8.3)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ producers: [raidProducer, poolProducer] });
  });
  afterEach(() => h.close());

  const init = (prev: number | null, cur: number | null, advanceS = 40) => {
    h.clock.now += advanceS * 1000;
    return h.step(
      'XiraidArray',
      'a',
      arrayRow(['online', 'initing'], { init: prev }),
      arrayRow(['online', 'initing'], { init: cur }),
    );
  };

  it('emits on a new 10-point bucket, honoring the minimum interval', () => {
    h.step('XiraidArray', 'a', arrayRow(['online']), arrayRow(['online', 'initing'], { init: 0 }));
    let ev = init(0, 12);
    expect(types(ev)).toEqual(['raid.operation.progress']);
    expect(ev[0]?.feed).toBe('raid/progress');
    expect(ev[0]?.operation).toEqual({
      kind: 'initialization',
      generation: 1,
      progressPct: 12,
      bucket: 10,
    });
    expect(types(init(12, 19))).toEqual([]);
    ev = init(19, 23);
    expect(ev[0]?.operation).toMatchObject({ progressPct: 23, bucket: 20 });
    expect(types(init(23, 34, 5))).toEqual([]); // 5 s < min_interval_s
  });

  it('a jump across several buckets is one event with the latest values', () => {
    h.step('XiraidArray', 'a', arrayRow(['online']), arrayRow(['online', 'initing'], { init: 0 }));
    init(0, 12);
    const ev = init(12, 67);
    expect(types(ev)).toEqual(['raid.operation.progress']);
    expect(ev[0]?.operation).toMatchObject({ progressPct: 67, bucket: 60 });
  });

  it('a regression starts a new generation instead of being rewritten', () => {
    h.step('XiraidArray', 'a', arrayRow(['online']), arrayRow(['online', 'initing'], { init: 0 }));
    init(0, 67);
    const ev = init(67, 30);
    expect(types(ev)).toEqual(['raid.operation.progress']);
    expect(ev[0]?.operation).toMatchObject({ generation: 2, progressPct: 30, bucket: 30 });
    expect(ev[0]?.reasonCode).toBe('regression');
  });

  it('changing progress within a bucket is reported after the maximum silence', () => {
    h.step('XiraidArray', 'a', arrayRow(['online']), arrayRow(['online', 'initing'], { init: 0 }));
    init(0, 40);
    expect(types(init(40, 41, 100))).toEqual([]);
    expect(types(init(41, 41, 700))).toEqual([]); // unchanged: nothing
    expect(types(init(41, 42, 1))).toEqual(['raid.operation.progress']); // > max_silence since last emit
  });

  it('a null progress value produces nothing', () => {
    h.step(
      'XiraidArray',
      'a',
      arrayRow(['online']),
      arrayRow(['online', 'initing'], { init: null }),
    );
    expect(types(init(null, null))).toEqual([]);
  });

  it('completion clears the progress state so a later operation starts at generation 2, bucket 0', () => {
    h.step('XiraidArray', 'a', arrayRow(['online']), arrayRow(['online', 'initing'], { init: 0 }));
    init(0, 55);
    h.step('XiraidArray', 'a', arrayRow(['online', 'initing'], { init: 55 }), arrayRow(['online']));
    h.clock.now += 40_000;
    h.step('XiraidArray', 'a', arrayRow(['online']), arrayRow(['online', 'initing'], { init: 0 }));
    const ev = init(0, 11);
    expect(ev[0]?.operation).toMatchObject({ generation: 2, progressPct: 11, bucket: 10 });
  });
});
