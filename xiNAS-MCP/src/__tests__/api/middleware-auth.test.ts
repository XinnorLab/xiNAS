import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../api/middleware/request-id.js';
import { authMiddleware } from '../../api/middleware/auth.js';
import type { ApiConfig } from '../../api/config.js';

function appWith(config: ApiConfig) {
  const app = express();
  app.use(requestIdMiddleware());
  app.use(authMiddleware(config));
  app.get('/whoami', (req, res) => {
    res.json({ principal: req.context!.principal, role: req.context!.role });
  });
  return app;
}

const config: ApiConfig = {
  controller_id: '00000000-0000-0000-0000-0000000000aa',
  listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
  tokens: {
    'tok-admin': { principal: 'admin:alice', role: 'admin' },
    'tok-viewer': { principal: 'viewer:bob', role: 'viewer' },
    // A1 (S15 §3.5): the three surface scopes.
    'tok-mcp-only': { principal: 'mcp:agent', role: 'admin', surface: 'mcp' },
    'tok-rest-only': { principal: 'admin:rest', role: 'admin', surface: 'rest' },
    'tok-any': { principal: 'admin:any', role: 'admin', surface: 'any' },
  },
  state: { databasePath: ':memory:', auditJsonlPath: '/tmp/audit.jsonl' },
};

describe('authMiddleware', () => {
  it('accepts a bearer token and assigns its principal + role', async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer tok-admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principal: 'admin:alice', role: 'admin' });
  });

  it('rejects requests with no auth on a TCP connection', async () => {
    const res = await request(appWith(config)).get('/whoami');
    expect(res.status).toBe(401);
    expect(res.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
  });

  it('rejects an unknown bearer token', async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer no-such-token');
    expect(res.status).toBe(401);
    expect(res.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
  });
});

describe('authMiddleware — Unix socket trust', () => {
  async function callOverUds(authHeader?: string): Promise<{ status: number; body: string }> {
    const { createServer } = await import('node:http');
    const { mkdtempSync, rmSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { request: httpRequest } = await import('node:http');

    const dir = mkdtempSync(join(tmpdir(), 'xinas-auth-uds-'));
    const sockPath = join(dir, 'api.sock');
    const app = appWith(config);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => {
        server.listen(sockPath, () => {
          chmodSync(sockPath, 0o660);
          resolve();
        });
      });
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {};
        const req = httpRequest(
          { socketPath: sockPath, path: '/whoami', method: 'GET', headers },
          (res) => {
            let buf = '';
            res.on('data', (c) => {
              buf += c;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('promotes UDS connections to admin when NO bearer is sent', async () => {
    const { status, body } = await callOverUds();
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.principal).toBe('local:uds');
    expect(parsed.role).toBe('admin');
  });

  it('UDS + viewer bearer uses the bearer role (does NOT promote to admin)', async () => {
    const { status, body } = await callOverUds('Bearer tok-viewer');
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.principal).toBe('viewer:bob');
    expect(parsed.role).toBe('viewer');
  });

  it('UDS + unknown bearer returns 401 (does not silently fall back to UDS admin)', async () => {
    const { status, body } = await callOverUds('Bearer no-such-token');
    expect(status).toBe(401);
    const parsed = JSON.parse(body);
    expect(parsed.errors?.[0]?.code).toBe('PERMISSION_DENIED');
  });

  it('UDS + an mcp-scoped bearer is refused token_surface — it must NOT fall through to UDS admin (A1)', async () => {
    const { status, body } = await callOverUds('Bearer tok-mcp-only');
    expect(status).toBe(401);
    const parsed = JSON.parse(body);
    expect(parsed.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(parsed.errors?.[0]?.details).toEqual({ reason: 'token_surface', surface: 'mcp' });
  });
});

/**
 * A1 (S15 §3.5, final review C1) — a token scoped `surface: mcp` is an MCP
 * credential only: the REST surface refuses it so the MRTR confirmation
 * gate cannot be bypassed by replaying the same bearer against /api/v1.
 */
describe('authMiddleware — token surface scope (S15 §3.5)', () => {
  it("refuses a surface: 'mcp' token on REST with PERMISSION_DENIED / token_surface", async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer tok-mcp-only');
    expect(res.status).toBe(401);
    expect(res.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    expect(res.body.errors?.[0]?.message).toBe('this token is scoped to the MCP endpoint');
    expect(res.body.errors?.[0]?.details).toEqual({ reason: 'token_surface', surface: 'mcp' });
  });

  it("accepts a surface: 'rest' token on REST", async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer tok-rest-only');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principal: 'admin:rest', role: 'admin' });
  });

  it("accepts a surface: 'any' token on REST", async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer tok-any');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principal: 'admin:any', role: 'admin' });
  });

  it('accepts a token with no surface key at all (the default is any)', async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer tok-admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principal: 'admin:alice', role: 'admin' });
  });
});
