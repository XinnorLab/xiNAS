import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../api/app.js';
import { createEventsContext, type EventsContext } from '../../api/events/context.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { type TestSetup, buildTestApp } from './_helpers.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-s17';

/**
 * S17 §8.0: the observation handler runs the transition engine INSIDE its
 * transaction — a changed row produces a journal row in the same commit,
 * an unchanged row produces nothing, a complete snapshot marks the kind's
 * baseline, and every accepted batch stamps the per-kind freshness.
 */
describe('POST /internal/v1/observed — S17 event generation', () => {
  let setup: TestSetup & { cleanup(): Promise<void> };
  let events: EventsContext;

  beforeEach(async () => {
    setup = await buildTestApp();
    setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };
    const tracker = new HeartbeatTracker({
      intervalMs: 5_000,
      controllerId: CONTROLLER_ID,
      state: setup.state,
      agentSocketPath: '/tmp/nonexistent.sock',
    });
    events = createEventsContext({ db: setup.state.db, controllerId: CONTROLLER_ID });
    setup.app = createApp({ config: setup.config, state: setup.state, tracker, events });
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  const fs = (mounted: boolean) => ({
    kind: 'Filesystem',
    id: 'srv-data.mount',
    op: 'upsert' as const,
    value: {
      kind: 'Filesystem',
      id: 'srv-data.mount',
      status: {
        mountpoint: '/srv/data',
        backing_device: '/dev/xi_data',
        mounted,
        mount_unit_state: mounted ? 'active' : 'inactive',
        effective_mount_options: ['rw'],
        uuid: 'u',
        size_bytes: 100,
        free_bytes: 50,
        observed_at: new Date().toISOString(),
      },
    },
  });

  const push = (deltas: unknown[], completeSnapshots: string[] = []) =>
    request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({
        observed_at: new Date().toISOString(),
        controller_id: CONTROLLER_ID,
        deltas,
        complete_snapshots: completeSnapshots,
      });

  it('a committed transition lands in the journal with the batch', async () => {
    expect((await push([fs(true)], ['Filesystem'])).status).toBe(200);
    expect(events.journal.count()).toBe(0); // baseline
    expect(events.engine.baselineDone('Filesystem')).toBe(true);
    expect((await push([fs(false)], ['Filesystem'])).status).toBe(200);
    const rows = events.journal.listAfter('storage', 0, 10);
    expect(rows.map((r) => r.type)).toEqual(['filesystem.mount.lost']);
    expect(rows[0]?.subject).toEqual({ kind: 'Filesystem', id: 'srv-data.mount' });
  });

  it('an unchanged row (dedupe skip) produces nothing', async () => {
    await push([fs(true)], ['Filesystem']);
    await push([fs(true)], ['Filesystem']);
    expect(events.journal.count()).toBe(0);
  });

  it('a reconcile delete reaches the engine as a removal', async () => {
    await push([fs(true)], ['Filesystem']);
    const res = await push([], ['Filesystem']);
    expect(res.body.result.deleted_by_reconcile).toBe(1);
    expect(events.journal.listAfter('storage', 0, 10).map((r) => r.type)).toEqual([
      'filesystem.definition.removed',
    ]);
  });

  it('stamps the per-kind last-accepted time on every batch', async () => {
    const before = Date.now();
    await push([fs(true)], ['Filesystem']);
    const stamped = events.journal.metaGet<number>('collector_last_accepted:Filesystem');
    expect(typeof stamped).toBe('number');
    expect(stamped as number).toBeGreaterThanOrEqual(before);
    expect(events.journal.metaGet('collector_last_accepted:Disk')).toBeNull();
  });

  it('is a no-op for a context without events', async () => {
    const plain = await buildTestApp();
    plain.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };
    const tracker = new HeartbeatTracker({
      intervalMs: 5_000,
      controllerId: CONTROLLER_ID,
      state: plain.state,
      agentSocketPath: '/tmp/nonexistent.sock',
    });
    const app = createApp({ config: plain.config, state: plain.state, tracker });
    const res = await request(app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({
        observed_at: new Date().toISOString(),
        controller_id: CONTROLLER_ID,
        deltas: [fs(true)],
        complete_snapshots: ['Filesystem'],
      });
    expect(res.status).toBe(200);
    await plain.cleanup();
  });
});
