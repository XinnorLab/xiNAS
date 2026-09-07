import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../api/app.js';
import { createEventsContext, type EventsContext } from '../../api/events/context.js';
import { encodeCursor } from '../../api/events/cursor.js';
import type { EventInput } from '../../api/events/types.js';
import { ADMIN_TOKEN, VIEWER_TOKEN, type TestSetup, buildTestApp } from './_helpers.js';

const CID = '00000000-0000-0000-0000-0000000000aa';

const input = (over: Partial<EventInput> = {}): EventInput => ({
  schemaVersion: '1',
  feed: 'raid',
  type: 'raid.state.degraded',
  severity: 'error',
  detectedAt: '2026-09-04T12:00:00.000Z',
  timeAccuracy: 'observed',
  source: { kind: 'observed_transition', component: 'XiraidArray' },
  subject: { kind: 'XiraidArray', id: 'data' },
  summary: 'RAID array data: degraded',
  relatedResources: [{ kind: 'Disk', id: 'd1' }],
  ...over,
});

/** S17 §13: GET /events projects the journal in the legacy Event shape plus additive fields. */
describe('GET /events (S17 journal projection)', () => {
  let setup: TestSetup & { cleanup(): Promise<void> };
  let events: EventsContext;

  beforeEach(async () => {
    setup = await buildTestApp();
    events = createEventsContext({ db: setup.state.db, controllerId: CID });
    setup.app = createApp({ ...setup.ctx, events });
    events.journal.insert(input({ summary: 'e1', detectedAt: '2026-09-04T12:00:01.000Z' }));
    events.journal.insert(
      input({
        feed: 'nfs',
        type: 'nfs.service.unavailable',
        summary: 'e2',
        detectedAt: '2026-09-04T12:00:02.000Z',
        subject: { kind: 'SystemdUnit', id: 'nfs-server.service' },
      }),
    );
    events.journal.insert(
      input({
        summary: 'e3',
        type: 'raid.state.recovered',
        severity: 'info',
        detectedAt: '2026-09-04T12:00:03.000Z',
      }),
    );
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  const get = (qs = '', token = ADMIN_TOKEN) =>
    request(setup.app).get(`/api/v1/events${qs}`).set('Authorization', token);

  it('lists journal rows newest first in the legacy shape with the additive fields', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const rows = res.body.result as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.message)).toEqual(['e3', 'e2', 'e1']);
    const e3 = rows[0] as Record<string, unknown>;
    expect(e3).toMatchObject({
      kind: 'raid.state.recovered',
      type: 'raid.state.recovered',
      severity: 'info',
      ts: '2026-09-04T12:00:03.000Z',
      detected_at: '2026-09-04T12:00:03.000Z',
      feed: 'raid',
      sequence: 3,
      subject: { kind: 'XiraidArray', id: 'data' },
      time_accuracy: 'observed',
      source: { kind: 'observed_transition', component: 'XiraidArray' },
      related_resources: [{ kind: 'Disk', id: 'd1' }],
    });
    expect(typeof e3.event_id).toBe('string');
    expect(typeof e3.cursor).toBe('string');
    expect(e3).not.toHaveProperty('metadata');
  });

  it('filters by feed, severity and since', async () => {
    expect(((await get('?feed=raid')).body.result as unknown[]).length).toBe(2);
    expect(
      ((await get('?feed=nfs')).body.result as Array<{ message: string }>).map((r) => r.message),
    ).toEqual(['e2']);
    expect(
      ((await get('?severity=error')).body.result as Array<{ message: string }>).map(
        (r) => r.message,
      ),
    ).toEqual(['e2', 'e1']);
    expect(
      (
        (await get('?since=2026-09-04T12:00:02.000Z')).body.result as Array<{ message: string }>
      ).map((r) => r.message),
    ).toEqual(['e3', 'e2']);
  });

  it('pages forward from a feed cursor, ascending, with the row cursor usable as the next after', async () => {
    const after1 = encodeCursor({ controllerId: CID, feed: 'raid', sequence: 1 });
    const res = await get(`?feed=raid&after=${after1}&limit=1`);
    expect(res.status).toBe(200);
    const rows = res.body.result as Array<{ message: string; cursor: string }>;
    expect(rows.map((r) => r.message)).toEqual(['e3']);
    const next = await get(`?feed=raid&after=${rows[0]?.cursor}`);
    expect(next.body.result).toEqual([]);
  });

  it('rejects after without feed, a bad cursor, a bad feed and an out-of-range limit', async () => {
    for (const qs of [
      '?after=abc',
      '?feed=raid&after=zzz',
      '?feed=tasks',
      '?limit=0',
      '?limit=501',
      '?limit=x',
      '?since=yesterday',
    ]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(res.body.errors?.[0]?.code, qs).toBe('INVALID_ARGUMENT');
    }
  });

  it('a viewer is refused as before (no catalog entry → RBAC admin default)', async () => {
    const res = await get('', VIEWER_TOKEN);
    expect(res.status).toBe(401);
  });

  it('legacy KV rows written before S17 are still served', async () => {
    setup.state.kv.put('/xinas/v1/events/2026-06-03T00:00:00.000Z/evt1', {
      kind: 'agent_state_changed',
      from: 'offline',
      to: 'healthy',
    });
    const res = await get();
    expect(res.status).toBe(200);
    const rows = res.body.result as Array<{ kind: string }>;
    expect(rows.map((r) => r.kind)).toEqual([
      'raid.state.recovered',
      'nfs.service.unavailable',
      'raid.state.degraded',
      'agent_state_changed',
    ]);
  });

  it('serves only legacy rows in a context without a journal', async () => {
    const plain = await buildTestApp();
    plain.state.kv.put('/xinas/v1/events/2026-06-03T00:00:00.000Z/evt1', {
      kind: 'agent_state_changed',
    });
    const res = await request(plain.app).get('/api/v1/events').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect((res.body.result as Array<{ kind: string }>).map((r) => r.kind)).toEqual([
      'agent_state_changed',
    ]);
    await plain.cleanup();
  });
});
