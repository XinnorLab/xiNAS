import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

describe('GET /api/v1/groups', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    setup.state.kv.put('/xinas/v1/observed/Group/1000', {
      kind: 'Group',
      id: '1000',
      spec: { name: 'alice', gid: 1000, members: [] },
      status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
    });
    setup.state.kv.put('/xinas/v1/observed/Group/2000', {
      kind: 'Group',
      id: '2000',
      spec: { name: 'domain_users', gid: 2000, members: ['alice', 'bob'] },
      status: { resolvable: true, source: 'nss', observed_at: new Date().toISOString() },
    });
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('lists all groups when source=all (default)', async () => {
    const res = await request(setup.app).get('/api/v1/groups').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    expect(res.body.result.map((g: { id: string }) => g.id)).toContain('1000');
    expect(res.body.result.map((g: { id: string }) => g.id)).toContain('2000');
  });

  it('filters to source=local only', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups?source=local')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].spec.name).toBe('alice');
    expect(res.body.result[0].status.source).toBe('local');
  });

  it('filters to source=nss only', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups?source=nss')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].spec.members).toContain('alice');
  });

  it('returns 404 when gid not found', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups/9999')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('returns a single group by gid', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups/2000')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.spec.name).toBe('domain_users');
    expect(res.body.result.spec.members).toHaveLength(2);
  });
});
