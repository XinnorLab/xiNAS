import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encExportId } from '../../lib/nfs-export-id.js';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('Share read-join: status.exports[] populated from observed ExportRule', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  const SHARE_ID = 'share01';
  const EXPORT_PATH = '/srv/nfs/share01';
  // The agent keys the observed ExportRule by encExportId(export_path) (N0b.2 —
  // the raw absolute path fails isValidObservedId), so the read-time join looks
  // it up by that same encoding. Seed at the encoded key, NOT the share id.
  const EXPORT_RULE_KEY = `/xinas/v1/observed/ExportRule/${encExportId(EXPORT_PATH)}`;

  beforeEach(async () => {
    setup = await buildTestApp();
    // Real Share shape: only spec.path (the exported directory). It has NO
    // export_path — the join keys share.spec.path against the observed
    // ExportRule's spec.export_path, which the agent stamps with that same dir.
    setup.state.kv.put(`/xinas/v1/desired/Share/${SHARE_ID}`, {
      kind: 'Share',
      id: SHARE_ID,
      spec: {
        path: EXPORT_PATH,
        clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
        fsid: 42,
      },
      status: { exports: [] },
    });
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /shares list: status.exports is [] when no ExportRule observed', async () => {
    const res = await request(setup.app).get('/api/v1/shares').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].status.exports).toEqual([]);
  });

  it('GET /shares list: status.exports populated when a matching ExportRule exists', async () => {
    setup.state.kv.put(EXPORT_RULE_KEY, {
      kind: 'ExportRule',
      id: encExportId(EXPORT_PATH),
      spec: { export_path: EXPORT_PATH },
      status: {
        rules: [
          { client: '10.0.0.0/8', options: ['rw', 'sync', 'no_root_squash'] },
          { client: '192.168.1.0/24', options: ['ro'] },
        ],
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app).get('/api/v1/shares').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result[0].status.exports).toHaveLength(2);
    expect(res.body.result[0].status.exports[0].client).toBe('10.0.0.0/8');
  });

  it('GET /shares/{id}: status.exports populated for a matching ExportRule', async () => {
    setup.state.kv.put(EXPORT_RULE_KEY, {
      kind: 'ExportRule',
      id: encExportId(EXPORT_PATH),
      spec: { export_path: EXPORT_PATH },
      status: {
        rules: [{ client: '10.0.0.0/8', options: ['rw', 'sync'] }],
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toHaveLength(1);
    expect(res.body.result.status.exports[0].client).toBe('10.0.0.0/8');
  });

  it('GET /shares/{id}: status.exports is [] when the only ExportRule is for a different path', async () => {
    const otherPath = '/srv/nfs/other';
    setup.state.kv.put(`/xinas/v1/observed/ExportRule/${encExportId(otherPath)}`, {
      kind: 'ExportRule',
      id: encExportId(otherPath),
      spec: { export_path: otherPath },
      status: { rules: [{ client: '*', options: ['ro'] }], observed_at: new Date().toISOString() },
    });
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toEqual([]);
  });
});
