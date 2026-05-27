import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('tasks routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  it('GET /tasks returns empty array on fresh install', async () => {
    const res = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /tasks/{id} 404s when no such task', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('GET /tasks returns seeded tasks', async () => {
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'share.create',
      state: 'plan_only',
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '00000000-0000-0000-0000-000000000010',
      correlation_id: 'fixture-task-1',
      input_hash: 'sha256:fixture',
      risk_level: 'non_disruptive',
      affected_resources: [],
      created_at: '2026-05-27T11:00:00Z',
      updated_at: '2026-05-27T11:00:00Z',
    });
    const res = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].kind).toBe('share.create');
  });

  it('POST /tasks/{id}/cancel returns EXECUTOR_UNAVAILABLE', async () => {
    const res = await request(setup.app)
      .post('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/cancel')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('GET /tasks/{id}/watch emits one SSE event then closes', async () => {
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'k',
      state: 'running',
    });
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/watch')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: snapshot');
    expect(res.text).toContain('"state":"running"');
  });
});
