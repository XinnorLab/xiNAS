import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

/** S9 T4: config-history reads live from observed rows + diff RPC. */
describe('config-history reads (S9 T4)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
    setup.state.kv.put('/xinas/v1/observed/ConfigSnapshot/base-1', {
      kind: 'ConfigSnapshot',
      id: 'base-1',
      status: {
        snapshot_id: 'base-1',
        kind: 'baseline',
        created_at: '2026-01-01T00:00:00Z',
        principal: 'root',
        rollback_classification: 'destroying_data',
        history_type: 'baseline',
        operation: null,
        source: 'installer',
        diff_summary: null,
        observed_at: '2026-06-12T00:00:00Z',
      },
    });
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('list + show serve projected rows WITHOUT the stub warning', async () => {
    const list = await request(setup.app)
      .get('/api/v1/config-history/snapshots')
      .set('Authorization', ADMIN_TOKEN);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body.warnings)).not.toContain('CONFIG_HISTORY_NOT_INTEGRATED');
    expect(list.body.result).toHaveLength(1);
    expect(list.body.result[0]).toMatchObject({
      snapshot_id: 'base-1',
      kind: 'baseline',
      history_type: 'baseline',
    });
    expect(list.body.result[0]).not.toHaveProperty('observed_at');

    const show = await request(setup.app)
      .get('/api/v1/config-history/snapshots/base-1')
      .set('Authorization', ADMIN_TOKEN);
    expect(show.status).toBe(200);
    expect(show.body.result.snapshot_id).toBe('base-1');

    const missing = await request(setup.app)
      .get('/api/v1/config-history/snapshots/nope')
      .set('Authorization', ADMIN_TOKEN);
    expect(missing.status).toBe(404);
  });

  it('diff without an agent connection degrades with EXECUTOR_UNAVAILABLE', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/diff?from=a&to=b')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.diff).toBeNull();
    expect(JSON.stringify(res.body.warnings)).toContain('EXECUTOR_UNAVAILABLE');

    const bad = await request(setup.app)
      .get('/api/v1/config-history/diff?from=a')
      .set('Authorization', ADMIN_TOKEN);
    expect(bad.status).toBe(400);
  });
});

// ── S9 T12 regression: observed-channel validation must ACCEPT the new
//    kinds' row envelopes (ConfigSnapshot's flat public schema carries a
//    kind ENUM that would otherwise poison whole observation batches). ──

import { loadObservedSchemas } from '../../api/observed-schemas.js';

describe('observed-schema validators for S9 kinds', () => {
  it('ConfigSnapshot + Pool row envelopes pass inbound validation', () => {
    const loaded = loadObservedSchemas();
    expect(loaded).not.toBeNull();
    const schemas = (loaded as NonNullable<typeof loaded>).schemas;
    expect(
      schemas.ConfigSnapshot?.({
        kind: 'ConfigSnapshot',
        id: 'base-1',
        status: { snapshot_id: 'base-1', kind: 'baseline', created_at: 'x' },
      }),
    ).toBe(true);
    expect(
      schemas.Pool?.({
        kind: 'Pool',
        id: 'sp1',
        status: { name: 'sp1', drives: [], active: false },
      }),
    ).toBe(true);
  });
});
