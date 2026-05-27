import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

const MUTATING_PATHS: Array<[string, string]> = [
  ['POST', '/api/v1/arrays'],
  ['PATCH', '/api/v1/arrays/a1'],
  ['DELETE', '/api/v1/arrays/a1'],
  ['POST', '/api/v1/filesystems'],
  ['PATCH', '/api/v1/filesystems/f1'],
  ['DELETE', '/api/v1/filesystems/f1'],
  ['POST', '/api/v1/shares'],
  ['PATCH', '/api/v1/shares/s1'],
  ['DELETE', '/api/v1/shares/s1'],
  ['PUT', '/api/v1/nfs-profiles/default'],
  ['PATCH', '/api/v1/nfs-profiles/default'],
  ['PATCH', '/api/v1/network/interfaces/ibp0s4'],
  ['POST', '/api/v1/config-history/rollback'],
  ['POST', '/api/v1/support-bundle'],
];

describe('mutating endpoints', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  for (const [method, path] of MUTATING_PATHS) {
    it(`${method} ${path} returns INTERNAL/EXECUTOR_UNAVAILABLE`, async () => {
      const req = method === 'POST'
        ? request(setup.app).post(path)
        : method === 'PATCH'
        ? request(setup.app).patch(path)
        : method === 'PUT'
        ? request(setup.app).put(path)
        : request(setup.app).delete(path);
      const res = await req
        .set('Authorization', ADMIN_TOKEN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'plan' });
      expect(res.status).toBe(500);
      expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
    });
  }
});
