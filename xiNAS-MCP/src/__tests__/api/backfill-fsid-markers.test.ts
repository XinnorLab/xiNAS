import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillShareFsidMarkers } from '../../api/backfill-fsid-markers.js';
import { buildTestApp } from './_helpers.js';

const SHARE = '/xinas/v1/desired/Share/';
const MARKER = '/xinas/v1/desired/ShareFsid/';

describe('backfillShareFsidMarkers', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  const putShare = (id: string, fsid: number): void => {
    setup.state.kv.put(`${SHARE}${id}`, {
      kind: 'Share',
      id,
      spec: { path: `/${id}`, clients: [], fsid },
    });
  };

  it('creates a marker for a pre-existing share that has none', () => {
    putShare('mnt/data', 3);
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.get(`${MARKER}3`)?.value).toEqual({ fsid: 3, share_id: 'mnt/data' });
  });

  it('leaves an existing marker untouched — no revision churn on every boot', () => {
    putShare('mnt/data', 3);
    backfillShareFsidMarkers(setup.state);
    const first = setup.state.kv.get(`${MARKER}3`)?.revision;
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.get(`${MARKER}3`)?.revision).toBe(first);
  });

  it('is a no-op with no shares', () => {
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.list({ prefix: MARKER })).toEqual([]);
  });

  it('does not touch unrelated desired rows', () => {
    putShare('mnt/data', 3);
    setup.state.kv.put('/xinas/v1/desired/Filesystem/mnt-data.mount', { kind: 'Filesystem' });
    backfillShareFsidMarkers(setup.state);
    expect(setup.state.kv.get('/xinas/v1/desired/Filesystem/mnt-data.mount')).not.toBeNull();
  });
});
