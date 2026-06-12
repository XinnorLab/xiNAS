import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

interface AuditRow {
  kind?: string;
  principal?: string;
}

function auditRows(dir: string): AuditRow[] {
  try {
    return readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRow);
  } catch {
    return [];
  }
}

/** S8 T4: loopback identity forwarding + /mcp audit dedupe. */
describe('loopback auth (S8 T4)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('forwarded headers under the loopback bearer set principal/role/client_type', async () => {
    const token = setup.ctx.loopback_token as string;
    expect(token).toBeTruthy();
    const res = await request(setup.app)
      .get('/api/v1/arrays')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Xinas-Forwarded-Principal', 'mcp:local_admin')
      .set('X-Xinas-Forwarded-Role', 'admin')
      .set('X-Xinas-Client-Type', 'mcp');
    expect(res.status).toBe(200);

    // the audit row carries the forwarded identity
    await setup.state.drainer.drainNow();
    const rows = auditRows(setup.dir);
    const row = rows.find((r) => r.kind === 'http.GET./arrays');
    expect(row?.principal).toBe('mcp:local_admin');
  });

  it('forwarded role is enforced by rbac (viewer forwarded → mutating denied)', async () => {
    const token = setup.ctx.loopback_token as string;
    const res = await request(setup.app)
      .post('/api/v1/arrays')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Xinas-Forwarded-Principal', 'mcp:viewer-guy')
      .set('X-Xinas-Forwarded-Role', 'viewer')
      .set('X-Xinas-Client-Type', 'mcp')
      .send({ mode: 'plan', spec: {} });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain('PERMISSION_DENIED');
  });

  it('forwarded headers from a NON-loopback bearer are ignored', async () => {
    const res = await request(setup.app)
      .get('/api/v1/arrays')
      .set('Authorization', ADMIN_TOKEN)
      .set('X-Xinas-Forwarded-Principal', 'evil:escalation')
      .set('X-Xinas-Forwarded-Role', 'admin');
    expect(res.status).toBe(200);
    await setup.state.drainer.drainNow();
    const rows = auditRows(setup.dir);
    const row = rows.find((r) => r.kind === 'http.GET./arrays');
    expect(row?.principal).toBe('admin:test'); // the REAL token principal
  });

  it('loopback bearer without identity headers is an error, not a fallthrough', async () => {
    const token = setup.ctx.loopback_token as string;
    const res = await request(setup.app)
      .get('/api/v1/arrays')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('/mcp requests produce NO audit rows', async () => {
    await request(setup.app).post('/mcp').send({});
    await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    await setup.state.drainer.drainNow();
    const rows = auditRows(setup.dir);
    expect(rows.length).toBeGreaterThan(0); // the /api/v1 row landed
    expect(rows.some((r) => typeof r.kind === 'string' && r.kind.includes('/mcp'))).toBe(false);
  });
});
