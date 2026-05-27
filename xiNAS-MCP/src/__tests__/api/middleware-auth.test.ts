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
  tokens: { 'tok-admin': { principal: 'admin:alice', role: 'admin' } },
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
  it('promotes UDS connections to admin without a token', async () => {
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
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ socketPath: sockPath, path: '/whoami', method: 'GET' }, (res) => {
          let buf = '';
          res.on('data', (c) => {
            buf += c;
          });
          res.on('end', () => resolve(buf));
        });
        req.on('error', reject);
        req.end();
      });
      const parsed = JSON.parse(body);
      expect(parsed.principal).toBe('local:uds');
      expect(parsed.role).toBe('admin');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
