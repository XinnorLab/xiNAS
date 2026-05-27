import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { openStateStore, type OpenedStateStore } from '../../state/index.js';
import { requestIdMiddleware } from '../../api/middleware/request-id.js';
import { auditMiddleware } from '../../api/middleware/audit.js';

describe('auditMiddleware', () => {
  let dir: string;
  let state: OpenedStateStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-api-audit-'));
    state = await openStateStore({
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
      nodeId: 'node-1',
    });
  });

  afterEach(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function appWith() {
    const app = express();
    app.use(requestIdMiddleware());
    app.use((req, _res, next) => {
      req.context!.principal = 'admin:test';
      req.context!.role = 'admin';
      next();
    });
    app.use(auditMiddleware(state));
    app.get('/ping', (_req, res) => {
      res.json({ pong: true });
    });
    return app;
  }

  it('queues an audit row per successful request', async () => {
    await request(appWith()).get('/ping');
    // Audit fires inside res.on('finish'); allow event loop turn.
    await new Promise((r) => setImmediate(r));
    await state.drainer.drainNow();
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(true);
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.kind).toBe('http.GET./ping');
    expect(entry.principal).toBe('admin:test');
    expect(entry.client_type).toBe('rest');
    expect(entry.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
