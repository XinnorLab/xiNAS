import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('query contract: /health?profile', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it.each(['quick', 'standard', 'deep'])('accepts profile=%s', async (p) => {
    const res = await request(setup.app)
      .get(`/api/v1/health?profile=${p}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.profile).toBe(p);
  });

  it('rejects an unknown profile with INVALID_ARGUMENT/400', async () => {
    const res = await request(setup.app)
      .get('/api/v1/health?profile=bogus')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('query contract: /disks?safe_for_use', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
    setup.state.kv.put('/xinas/v1/observed/Disk/safe1', {
      kind: 'Disk',
      id: 'safe1',
      status: {
        device_path: '/dev/nvme0n1',
        serial: 's1',
        model: 'm',
        capacity_bytes: 1,
        safe_for_use: true,
      },
    });
    setup.state.kv.put('/xinas/v1/observed/Disk/unsafe1', {
      kind: 'Disk',
      id: 'unsafe1',
      status: {
        device_path: '/dev/nvme1n1',
        serial: 's2',
        model: 'm',
        capacity_bytes: 1,
        safe_for_use: false,
      },
    });
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('no filter → returns all disks', async () => {
    const res = await request(setup.app).get('/api/v1/disks').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(2);
  });

  it('safe_for_use=true → returns only safe disks', async () => {
    const res = await request(setup.app)
      .get('/api/v1/disks?safe_for_use=true')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].id).toBe('safe1');
  });

  it('safe_for_use=false → returns only unsafe disks', async () => {
    const res = await request(setup.app)
      .get('/api/v1/disks?safe_for_use=false')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].id).toBe('unsafe1');
  });

  it('safe_for_use=garbage → 400 INVALID_ARGUMENT', async () => {
    const res = await request(setup.app)
      .get('/api/v1/disks?safe_for_use=garbage')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('query contract: /tasks state/kind/limit', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
    setup.state.kv.put('/xinas/v1/tasks/t-running-create', {
      task_id: 't-running-create',
      kind: 'share.create',
      state: 'running',
    });
    setup.state.kv.put('/xinas/v1/tasks/t-done-delete', {
      task_id: 't-done-delete',
      kind: 'share.delete',
      state: 'succeeded',
    });
    setup.state.kv.put('/xinas/v1/tasks/t-running-delete', {
      task_id: 't-running-delete',
      kind: 'share.delete',
      state: 'running',
    });
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('state=running filters to running tasks', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks?state=running')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(2);
    expect(res.body.result.every((t: { state: string }) => t.state === 'running')).toBe(true);
  });

  it('kind=share.delete filters to delete tasks', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks?kind=share.delete')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(2);
  });

  it('combined state + kind narrows correctly', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks?state=running&kind=share.delete')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].task_id).toBe('t-running-delete');
  });

  it('limit=1 truncates', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks?limit=1')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(1);
  });

  it('limit=0 → 400 INVALID_ARGUMENT', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks?limit=0')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });

  it('limit=10000 → 400 INVALID_ARGUMENT', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks?limit=10000')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });

  it('limit=not-an-int → 400 INVALID_ARGUMENT', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks?limit=abc')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });
});

describe('query contract: /config-history/diff requires from + to', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('missing both → 400 INVALID_ARGUMENT', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/diff')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0]?.code).toBe('INVALID_ARGUMENT');
  });

  it('missing to → 400 INVALID_ARGUMENT', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/diff?from=a')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });

  it('both present → 200 with warning + echo', async () => {
    const res = await request(setup.app)
      .get('/api/v1/config-history/diff?from=a&to=b')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.from).toBe('a');
    expect(res.body.result.to).toBe('b');
    // S9 T4: diff is live but needs the agent — this read-only test app
    // has none, so it degrades (the NOT_INTEGRATED stub era is over).
    expect(res.body.warnings.some((w: { code: string }) => w.code === 'EXECUTOR_UNAVAILABLE')).toBe(
      true,
    );
  });
});
