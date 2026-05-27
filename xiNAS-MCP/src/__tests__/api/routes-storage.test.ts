import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';
import type { OpenedStateStore } from '../../state/index.js';

function seedDisk(state: OpenedStateStore, id: string): void {
  state.kv.put(`/xinas/v1/observed/Disk/${id}`, {
    kind: 'Disk',
    id,
    status: { device_path: `/dev/${id}`, serial: `S-${id}`, model: 'X', capacity_bytes: 1_000_000_000_000, safe_for_use: true },
  });
}

function seedArray(state: OpenedStateStore, id: string): void {
  state.kv.put(`/xinas/v1/observed/XiraidArray/${id}`, {
    kind: 'XiraidArray',
    id,
    spec: { name: id, level: 'raid5', member_disk_ids: ['d1', 'd2', 'd3'] },
    status: { state: 'optimal', volume_path: `/dev/xi_${id}`, usable_capacity_bytes: 2_000_000_000_000 },
  });
}

describe('storage routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /disks returns the list', async () => {
    seedDisk(setup.state, 'd1');
    seedDisk(setup.state, 'd2');
    const res = await request(setup.app).get('/api/v1/disks').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    expect(res.body.result[0].kind).toBe('Disk');
  });

  it('GET /arrays returns the list', async () => {
    seedArray(setup.state, 'a1');
    const res = await request(setup.app).get('/api/v1/arrays').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
  });

  it('GET /arrays/{id} returns the single array', async () => {
    seedArray(setup.state, 'a1');
    const res = await request(setup.app).get('/api/v1/arrays/a1').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe('a1');
  });

  it('GET /arrays/{id} returns 404 when missing', async () => {
    const res = await request(setup.app).get('/api/v1/arrays/missing').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET /filesystems returns the list', async () => {
    setup.state.kv.put('/xinas/v1/observed/Filesystem/f1', {
      kind: 'Filesystem',
      id: 'f1',
      spec: { fs_type: 'xfs', backing_device: '/dev/xi_a1', mountpoint: '/srv/fs1' },
      status: { mounted: true, uuid: 'u', size_bytes: 1, free_bytes: 1 },
    });
    const res = await request(setup.app).get('/api/v1/filesystems').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
  });
});
