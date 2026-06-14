import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';
import { snapshotDesiredKey } from '../../api/tasks/snapshot-desired.js';
import type { SnapshotDesiredPayload } from '../../api/tasks/snapshot-desired.js';

/**
 * S12 T3 (ADR-0015): ConfigSnapshot.adoptable read-enrichment.
 *
 * `adoptable` is computed API-side from the presence of a
 * `/xinas/v1/snapshot-desired/{id}` KV payload. It is INDEPENDENT of
 * the agent-observed `restorable` field.
 */
describe('config-history adoptable enrichment (S12 T3)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  const ADOPTED_ID = 'snap-adopted';
  const BARE_ID = 'snap-bare';

  /** A minimal SnapshotDesiredPayload for the adopted snapshot. */
  const DESIRED_PAYLOAD: SnapshotDesiredPayload = {
    snapshot_id: ADOPTED_ID,
    kinds: {
      Share: [],
      ExportGroup: [],
      NfsProfile: [],
      NetworkInterface: [],
    },
  };

  beforeEach(async () => {
    setup = await buildTestApp();

    // snap-adopted: has a snapshot-desired payload AND is marked restorable=true
    // (proves adoptable is independent of restorable).
    setup.state.kv.put(`/xinas/v1/observed/ConfigSnapshot/${ADOPTED_ID}`, {
      kind: 'ConfigSnapshot',
      id: ADOPTED_ID,
      status: {
        snapshot_id: ADOPTED_ID,
        kind: 'after',
        created_at: '2026-06-14T10:00:00Z',
        principal: 'admin',
        rollback_classification: 'non_disruptive',
        history_type: 'rollback_eligible',
        operation: 'nfs.update',
        source: 'api',
        diff_summary: null,
        restorable: true,
        observed_at: '2026-06-14T10:00:01Z',
      },
    });

    // snap-bare: no snapshot-desired payload AND restorable=false
    setup.state.kv.put(`/xinas/v1/observed/ConfigSnapshot/${BARE_ID}`, {
      kind: 'ConfigSnapshot',
      id: BARE_ID,
      status: {
        snapshot_id: BARE_ID,
        kind: 'baseline',
        created_at: '2026-01-01T00:00:00Z',
        principal: 'root',
        rollback_classification: 'destroying_data',
        history_type: 'baseline',
        operation: null,
        source: 'installer',
        diff_summary: null,
        restorable: false,
        observed_at: '2026-01-01T00:00:01Z',
      },
    });

    // Seed the desired payload only for ADOPTED_ID.
    setup.state.kv.put(snapshotDesiredKey(ADOPTED_ID), DESIRED_PAYLOAD);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('list: adoptable=true only for the snapshot that has a desired payload', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/snapshots')
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    const result = res.body.result as Array<{
      snapshot_id: string;
      adoptable: boolean;
      restorable: boolean;
    }>;

    const adopted = result.find((s) => s.snapshot_id === ADOPTED_ID);
    const bare = result.find((s) => s.snapshot_id === BARE_ID);

    expect(adopted).toBeDefined();
    expect(bare).toBeDefined();

    expect(adopted!.adoptable).toBe(true);
    expect(bare!.adoptable).toBe(false);
  });

  it('show: adoptable=true for the adopted snapshot', async () => {
    const res = await request(setup.app)
      .get(`/api/v1/config-history/snapshots/${ADOPTED_ID}`)
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.result.adoptable).toBe(true);
  });

  it('show: adoptable=false for the bare snapshot', async () => {
    const res = await request(setup.app)
      .get(`/api/v1/config-history/snapshots/${BARE_ID}`)
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.result.adoptable).toBe(false);
  });

  it('adoptable is independent of restorable (adopted=restorable, bare=!restorable)', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/snapshots')
      .set('Authorization', ADMIN_TOKEN);

    expect(res.status).toBe(200);
    const result = res.body.result as Array<{
      snapshot_id: string;
      adoptable: boolean;
      restorable: boolean;
    }>;

    const adopted = result.find((s) => s.snapshot_id === ADOPTED_ID)!;
    const bare = result.find((s) => s.snapshot_id === BARE_ID)!;

    // Confirm independence: adopted is restorable=true AND adoptable=true
    expect(adopted.restorable).toBe(true);
    expect(adopted.adoptable).toBe(true);

    // bare is restorable=false AND adoptable=false — demonstrates they vary
    // independently (a pre-S12 snapshot could be restorable=true but adoptable=false)
    expect(bare.restorable).toBe(false);
    expect(bare.adoptable).toBe(false);
  });

  it('removing the desired payload makes adoptable go false (dynamic check)', async () => {
    // Verify initially adoptable
    const before = await request(setup.app)
      .get(`/api/v1/config-history/snapshots/${ADOPTED_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(before.body.result.adoptable).toBe(true);

    // Remove the payload
    setup.state.kv.delete(snapshotDesiredKey(ADOPTED_ID));

    const after = await request(setup.app)
      .get(`/api/v1/config-history/snapshots/${ADOPTED_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(after.body.result.adoptable).toBe(false);
    // restorable is unchanged (agent-side field, still in the KV status)
    expect(after.body.result.restorable).toBe(true);
  });
});
