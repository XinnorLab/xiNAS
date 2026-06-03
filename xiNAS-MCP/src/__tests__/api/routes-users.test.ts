import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('GET /api/v1/users', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    // Seed observed Users
    setup.state.kv.put('/xinas/v1/observed/User/1000', {
      kind: 'User',
      id: '1000',
      spec: { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash' },
      status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
    });
    setup.state.kv.put('/xinas/v1/observed/User/1001', {
      kind: 'User',
      id: '1001',
      spec: { name: 'bob', uid: 1001, gid: 1001, home: '/home/bob', shell: '/bin/sh' },
      status: { resolvable: true, source: 'nss', observed_at: new Date().toISOString() },
    });
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('lists all users when source=all (default)', async () => {
    const res = await request(setup.app).get('/api/v1/users').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    expect(res.body.result.map((u: { id: string }) => u.id)).toContain('1000');
    expect(res.body.result.map((u: { id: string }) => u.id)).toContain('1001');
  });

  it('filters to source=local only', async () => {
    const res = await request(setup.app)
      .get('/api/v1/users?source=local')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].id).toBe('1000');
    expect(res.body.result[0].status.source).toBe('local');
  });

  it('filters to source=nss only', async () => {
    const res = await request(setup.app)
      .get('/api/v1/users?source=nss')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].status.source).toBe('nss');
  });

  it('returns 404 when uid not found', async () => {
    const res = await request(setup.app)
      .get('/api/v1/users/9999')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('returns a single user by uid', async () => {
    const res = await request(setup.app)
      .get('/api/v1/users/1000')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.spec.name).toBe('alice');
    expect(res.body.result.spec.uid).toBe(1000);
  });
});
