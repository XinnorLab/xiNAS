import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, seedShare, seedNfsProfile } from './_helpers.js';

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
    const res = await request(setup.app).get('/api/v1/shares/missing').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('GET /shares/{id}/sessions returns empty array', async () => {
    seedShare(setup.state, 's1');
    const res = await request(setup.app).get('/api/v1/shares/s1/sessions').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /nfs-profiles lists profiles', async () => {
    seedNfsProfile(setup.state);
    const res = await request(setup.app).get('/api/v1/nfs-profiles').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].id).toBe('default');
  });

  it('GET /nfs-profiles/{id} returns the profile', async () => {
    seedNfsProfile(setup.state);
    const res = await request(setup.app).get('/api/v1/nfs-profiles/default').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.spec.threads.count).toBe(64);
  });

  it('GET /export-groups returns empty on fresh install', async () => {
    const res = await request(setup.app).get('/api/v1/export-groups').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });
});
