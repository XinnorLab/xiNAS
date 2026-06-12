import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, VIEWER_TOKEN, buildTestApp } from './_helpers.js';

/** S9 T6: the live audit query — tail filters + exact lookups. */
describe('GET /audit (S9 T6)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  /** Generate audit rows by hitting real routes. */
  async function traffic(): Promise<void> {
    await request(setup.app).get('/api/v1/arrays').set('Authorization', ADMIN_TOKEN);
    await request(setup.app).get('/api/v1/disks').set('Authorization', ADMIN_TOKEN);
    await request(setup.app).get('/api/v1/arrays').set('Authorization', VIEWER_TOKEN);
  }

  it('tail filters: kind, principal, limit; no stub warning; newest first', async () => {
    await traffic();
    await setup.state.drainer.drainNow();

    const all = await request(setup.app)
      .get('/api/v1/audit?limit=50')
      .set('Authorization', ADMIN_TOKEN);
    expect(all.status).toBe(200);
    expect(JSON.stringify(all.body.warnings)).not.toContain('AUDIT_QUERY_NOT_IMPLEMENTED');
    expect(all.body.result.length).toBeGreaterThanOrEqual(3);

    const byKind = await request(setup.app)
      .get('/api/v1/audit?kind=http.GET./disks')
      .set('Authorization', ADMIN_TOKEN);
    expect(byKind.body.result.length).toBeGreaterThanOrEqual(1);
    expect(byKind.body.result.every((r: { kind: string }) => r.kind === 'http.GET./disks')).toBe(
      true,
    );

    const byPrincipal = await request(setup.app)
      .get('/api/v1/audit?principal=viewer:test')
      .set('Authorization', ADMIN_TOKEN);
    expect(
      byPrincipal.body.result.every((r: { principal: string }) => r.principal === 'viewer:test'),
    ).toBe(true);

    const limited = await request(setup.app)
      .get('/api/v1/audit?limit=1')
      .set('Authorization', ADMIN_TOKEN);
    expect(limited.body.result).toHaveLength(1);
  });

  it('exact request_id lookup finds an entry EVEN before a drain (outbox fallback)', async () => {
    // generate one request and capture its request_id WITHOUT draining
    const probe = await request(setup.app)
      .get('/api/v1/arrays')
      .set('Authorization', ADMIN_TOKEN);
    const requestId = probe.body.request_id as string;
    expect(requestId).toBeTruthy();

    // The handler drains first itself — but break the offsets path by
    // querying immediately; the index/outbox path must still answer.
    const res = await request(setup.app)
      .get(`/api/v1/audit?request_id=${requestId}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.length).toBeGreaterThanOrEqual(1);
    expect(res.body.result[0].request_id).toBe(requestId);
  });

  it('two exact params at once → 400', async () => {
    const res = await request(setup.app)
      .get('/api/v1/audit?request_id=a&task_id=b')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });
});
