import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from '../_helpers.js';

describe('approval page (S15 §9.3)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => {
    await setup.cleanup();
  });

  it('serves an identical, unauthenticated shell for any id with the security headers', async () => {
    const a = await request(setup.app).get('/mcp/approvals/abc');
    const b = await request(setup.app).get('/mcp/approvals/does-not-exist');
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toMatch(/text\/html/);
    expect(a.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(a.headers['x-frame-options']).toBe('DENY');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.headers['referrer-policy']).toBe('no-referrer');
    expect(a.headers['x-content-type-options']).toBe('nosniff');
    // same document modulo the id (it appears more than once) → no existence leak
    expect(a.text.replaceAll('abc', 'X')).toBe(b.text.replaceAll('does-not-exist', 'X'));
    expect(a.text).not.toMatch(/<script[^>]*src="https?:/);
    expect(a.text).toContain('Do not paste the token your MCP client uses');
  });

  it('serves the script and stylesheet with no-store and nosniff', async () => {
    const js = await request(setup.app).get('/mcp/approvals/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe('no-store');
    expect(js.text).toContain('/api/v1/mcp/confirmations/');
    expect(js.text).toContain('X-Xinas-Approval-Interface');
    expect(js.text).toContain('DATA MAY BE PERMANENTLY LOST');
    const css = await request(setup.app).get('/mcp/approvals/assets/app.css');
    expect(css.status).toBe(200);
  });

  it('is not audited (the /mcp prefix skip) and neutralizes a non-id path segment', async () => {
    const res = await request(setup.app).get('/mcp/approvals/..%2Fetc');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-confirmation-id="invalid"');
    expect(res.text).not.toContain('etc');
    await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    await setup.state.drainer.drainNow();
    const rows = readFileSync(join(setup.dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind?: string });
    expect(rows.some((r) => r.kind?.startsWith('http.GET./mcp/'))).toBe(false);
    expect(rows.some((r) => r.kind === 'http.GET./api/v1/system')).toBe(true);
  });
});
