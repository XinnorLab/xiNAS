import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TransitionEngine } from '../../../api/events/engine.js';
import { META_KEYS } from '../../../api/events/meta.js';
import { sessionsProducer } from '../../../api/events/producers/sessions.js';
import { type Harness, OBSERVED_AT, type Row, makeHarness, types } from './_engine-harness.js';

const ID = '10.0.0.1:/srv/data';
const session = (o: { proto?: string; locks?: number } = {}): Row => ({
  kind: 'NfsSession',
  id: ID,
  spec: { client_addr: '10.0.0.1', export_path: '/srv/data', client_hostname: 'client.example' },
  status: {
    proto_version: o.proto ?? 'v4.1',
    locked_files: o.locks ?? 0,
    observed_at: OBSERVED_AT,
  },
});

describe('NFS sessions producer (S17 §8.5, D-20)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ producers: [sessionsProducer] });
    h.snapshot('NfsSession', []); // the kind's baseline
  });
  afterEach(() => h.close());

  it('a new session is connected only after a second complete snapshot still shows it', () => {
    expect(types(h.step('NfsSession', ID, null, session(), { present: [ID] }))).toEqual([]);
    const ev = h.snapshot('NfsSession', [ID]);
    expect(types(ev)).toEqual(['nfs.session.connected']);
    expect(ev[0]).toMatchObject({
      feed: 'nfs/sessions',
      subject: { kind: 'NfsSession', id: ID },
      details: {
        clientAddr: '10.0.0.1',
        exportPath: '/srv/data',
        protoVersion: 'v4.1',
        lockedFiles: 0,
      },
    });
    expect(JSON.stringify(ev[0])).not.toContain('client.example');
  });

  it('a session gone before its confirmation is never reported', () => {
    h.step('NfsSession', ID, null, session(), { present: [ID] });
    expect(types(h.step('NfsSession', ID, session(), null, { present: [] }))).toEqual([]);
    expect(types(h.snapshot('NfsSession', []))).toEqual([]);
  });

  it('a reconcile delete becomes disconnected only when the next snapshot still lacks it', () => {
    h.step('NfsSession', ID, null, session(), { present: [ID] });
    h.snapshot('NfsSession', [ID]);
    expect(types(h.step('NfsSession', ID, session(), null, { present: [] }))).toEqual([]);
    const ev = h.snapshot('NfsSession', []);
    expect(types(ev)).toEqual(['nfs.session.disconnected']);
    expect(ev[0]?.details).toMatchObject({ clientAddr: '10.0.0.1', exportPath: '/srv/data' });
  });

  it('a session that reappears cancels the disconnect candidate', () => {
    h.step('NfsSession', ID, null, session(), { present: [ID] });
    h.snapshot('NfsSession', [ID]);
    h.step('NfsSession', ID, session(), null, { present: [] });
    expect(types(h.step('NfsSession', ID, null, session(), { present: [ID] }))).toEqual([]);
    expect(types(h.snapshot('NfsSession', [ID]))).toEqual([]);
    expect(types(h.snapshot('NfsSession', [ID]))).toEqual([]);
  });

  it('a batch without a session snapshot touches no candidate', () => {
    h.step('NfsSession', ID, null, session(), { present: [ID] });
    expect(types(h.batch(() => {}, { completeSnapshots: ['Filesystem'] }))).toEqual([]);
    expect(types(h.snapshot('NfsSession', [ID]))).toEqual(['nfs.session.connected']);
  });

  it('a protocol change is immediate', () => {
    const ev = h.step('NfsSession', ID, session({ proto: 'v4.1' }), session({ proto: 'v4.2' }));
    expect(types(ev)).toEqual(['nfs.session.protocol_changed']);
    expect(ev[0]?.details).toMatchObject({ protoVersion: 'v4.2', previousProtoVersion: 'v4.1' });
  });

  describe('lock threshold', () => {
    it('is disabled by default', () => {
      expect(
        types(h.step('NfsSession', ID, session({ locks: 0 }), session({ locks: 100000 }))),
      ).toEqual([]);
    });

    it('crosses at enter and clears below clear', () => {
      h.close();
      h = makeHarness({
        producers: [sessionsProducer],
        config: { nfs_lock_threshold: { enter: 100, clear: 50 } },
      });
      let ev = h.step('NfsSession', ID, session({ locks: 99 }), session({ locks: 100 }));
      expect(types(ev)).toEqual(['nfs.session.lock_threshold_crossed']);
      expect(ev[0]?.threshold).toEqual({
        metric: 'locked_files',
        value: 100,
        unit: 'files',
        enter: 100,
        clear: 50,
      });
      expect(
        types(h.step('NfsSession', ID, session({ locks: 100 }), session({ locks: 60 }))),
      ).toEqual([]);
      ev = h.step('NfsSession', ID, session({ locks: 60 }), session({ locks: 49 }));
      expect(types(ev)).toEqual(['nfs.session.lock_threshold_cleared']);
    });
  });

  describe('api restart (I-03)', () => {
    /** A second engine over the SAME journal/db, as a restarted api would build. */
    function restarted(): (present: string[] | null) => number {
      const engine = new TransitionEngine(
        {
          journal: h.journal,
          db: h.db,
          controllerId: h.engine.controllerId,
          config: h.engine.config,
          now: () => h.clock.now,
        },
        [sessionsProducer],
      );
      return (present) =>
        h.db.transaction(() => {
          engine.begin({
            observedAt: OBSERVED_AT,
            completeSnapshots: present === null ? ['Filesystem'] : ['NfsSession'],
            kv: h.kv,
          });
          if (present !== null) engine.onSnapshot('NfsSession', new Set(present));
          return engine.commit().count;
        })();
    }

    it('confirms a persisted connect candidate on the first complete snapshot after a restart', () => {
      for (let i = 0; i < 12; i++) h.batch(() => {}); // the old process ran for a while
      h.step('NfsSession', ID, null, session(), { present: [ID] });
      const snapshot = restarted();
      expect(snapshot(null)).toBe(0); // a batch without a session snapshot touches nothing
      expect(snapshot([ID])).toBe(1);
      expect(types(h.journal.listAfter('nfs/sessions', 0, 10))).toEqual(['nfs.session.connected']);
      expect(snapshot([ID])).toBe(0); // confirmed exactly once
      expect(h.journal.metaGet(META_KEYS.sessionCandidates)).toBeNull();
    });

    it('cancels a persisted disconnect candidate when the first snapshot after a restart still shows the session', () => {
      h.step('NfsSession', ID, null, session(), { present: [ID] });
      h.snapshot('NfsSession', [ID]);
      h.step('NfsSession', ID, session(), null, { present: [] });
      const snapshot = restarted();
      expect(snapshot([ID])).toBe(0);
      expect(h.journal.metaGet(META_KEYS.sessionCandidates)).toBeNull();
      expect(types(h.journal.listAfter('nfs/sessions', 0, 10))).toEqual(['nfs.session.connected']);
    });

    it('confirms a persisted disconnect candidate when the first snapshot after a restart lacks the session', () => {
      h.step('NfsSession', ID, null, session(), { present: [ID] });
      h.snapshot('NfsSession', [ID]);
      h.step('NfsSession', ID, session(), null, { present: [] });
      expect(restarted()([])).toBe(1);
      expect(types(h.journal.listAfter('nfs/sessions', 0, 10))).toEqual([
        'nfs.session.connected',
        'nfs.session.disconnected',
      ]);
    });

    it('a candidate persisted before epochs existed is confirmed by the next complete snapshot', () => {
      h.journal.metaSet(META_KEYS.sessionCandidates, {
        [ID]: {
          kind: 'connect',
          seq: 999,
          view: {
            clientAddr: '10.0.0.1',
            exportPath: '/srv/data',
            protoVersion: 'v4.1',
            lockedFiles: 0,
          },
        },
      });
      expect(types(h.snapshot('NfsSession', [ID]))).toEqual(['nfs.session.connected']);
    });
  });
});
