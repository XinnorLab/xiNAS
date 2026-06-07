import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, seedShare, seedNfsProfile } from './_helpers.js';
import { encExportId } from '../../lib/nfs-export-id.js';
import type { OpenedStateStore } from '../../state/index.js';

/** Seed a Share with an explicit spec.path (seedShare hardcodes /srv/nfs/<id>). */
function seedShareWithPath(state: OpenedStateStore, id: string, path: string): void {
  state.kv.put(`/xinas/v1/desired/Share/${id}`, {
    kind: 'Share',
    id,
    spec: {
      path,
      clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
      fsid: 42,
    },
  });
}

/**
 * Seed an observed ExportRule at the ENCODED key (encExportId(exportPath)) — the
 * key the N0b.2 collector now writes. Before that wiring the row's id was the raw
 * absolute path, which isValidObservedId rejects, so this row never landed and the
 * Share→ExportRule join was always empty.
 */
function seedExportRule(
  state: OpenedStateStore,
  exportPath: string,
  rules: Array<{ host_pattern: string; options: string[] }>,
): void {
  const encoded = encExportId(exportPath);
  state.kv.put(`/xinas/v1/observed/ExportRule/${encoded}`, {
    kind: 'ExportRule',
    id: encoded,
    spec: { export_path: exportPath },
    status: { rules, observed_at: new Date().toISOString() },
  });
}

describe('NFS routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /shares lists shares', async () => {
    seedShare(setup.state, 's1');
    seedShare(setup.state, 's2');
    const res = await request(setup.app).get('/api/v1/shares').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
  });

  it('GET /shares/{id} returns the share', async () => {
    seedShare(setup.state, 's1');
    const res = await request(setup.app).get('/api/v1/shares/s1').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe('s1');
  });

  it('GET /shares/{id} 404s when missing', async () => {
    const res = await request(setup.app)
      .get('/api/v1/shares/missing')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('GET /shares/{id} joins the encoded-id ExportRule into status.exports', async () => {
    // A Share whose path encodes to the same observed-id as a seeded ExportRule
    // row must populate status.exports[] from that row's status.rules[].
    seedShareWithPath(setup.state, 's1', '/mnt/data');
    seedExportRule(setup.state, '/mnt/data', [{ host_pattern: '10.0.0.0/24', options: ['rw'] }]);
    const res = await request(setup.app).get('/api/v1/shares/s1').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toEqual([
      { host_pattern: '10.0.0.0/24', options: ['rw'] },
    ]);
  });

  it('GET /shares joins the encoded-id ExportRule into status.exports', async () => {
    seedShareWithPath(setup.state, 's1', '/mnt/data');
    seedExportRule(setup.state, '/mnt/data', [{ host_pattern: '10.0.0.0/24', options: ['rw'] }]);
    const res = await request(setup.app).get('/api/v1/shares').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const share = res.body.result.find((s: { id: string }) => s.id === 's1');
    expect(share.status.exports).toEqual([{ host_pattern: '10.0.0.0/24', options: ['rw'] }]);
  });

  it('GET /shares/{id} returns empty status.exports when no ExportRule matches', async () => {
    seedShareWithPath(setup.state, 's1', '/mnt/data');
    const res = await request(setup.app).get('/api/v1/shares/s1').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toEqual([]);
  });

  it('GET /shares/{id}/sessions returns empty array', async () => {
    seedShare(setup.state, 's1');
    const res = await request(setup.app)
      .get('/api/v1/shares/s1/sessions')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /nfs-profiles lists profiles', async () => {
    seedNfsProfile(setup.state);
    const res = await request(setup.app)
      .get('/api/v1/nfs-profiles')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].id).toBe('default');
  });

  it('GET /nfs-profiles/{id} returns the profile', async () => {
    seedNfsProfile(setup.state);
    const res = await request(setup.app)
      .get('/api/v1/nfs-profiles/default')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.spec.threads.count).toBe(64);
  });

  it('GET /export-groups returns empty on fresh install', async () => {
    const res = await request(setup.app)
      .get('/api/v1/export-groups')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });
});
