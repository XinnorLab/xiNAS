import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { closeLoopback, listenLoopback } from '../_listen.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { createApp } from '../../api/app.js';
import type { ApiConfig } from '../../api/config.js';
import type { ApiContext } from '../../api/context.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { type OpenedStateStore, openStateStore } from '../../state/index.js';

const NODE_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'Bearer internal-agent-tok-test';
const ADMIN_TOKEN = 'Bearer tok-admin';

/**
 * The xinas-agent's observation push (POST /internal/v1/observed) is
 * high-frequency telemetry ingest, not an operator operation. It must NOT
 * generate audit rows — otherwise the trail is flooded with hundreds of
 * identical http.POST./observed rows that bury real actions.
 */
describe('audit: agent observation push', () => {
  let dir: string;
  let state: OpenedStateStore;
  let app: HttpServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-observed-audit-'));
    const config: ApiConfig = {
      controller_id: NODE_ID,
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      tokens: {
        'tok-admin': { principal: 'admin:test', role: 'admin' },
        'internal-agent-tok-test': { principal: 'agent:root', role: 'internal_agent' },
      },
      state: {
        databasePath: join(dir, 'xinas.db'),
        auditJsonlPath: join(dir, 'audit.jsonl'),
      },
    };
    state = await openStateStore({
      databasePath: config.state.databasePath,
      auditJsonlPath: config.state.auditJsonlPath,
      nodeId: NODE_ID,
    });
    const tracker = new HeartbeatTracker({
      intervalMs: 5_000,
      controllerId: NODE_ID,
      state,
      agentSocketPath: '/tmp/nonexistent.sock',
    });
    const ctx: ApiContext = { config, state, tracker };
    app = await listenLoopback(createApp(ctx));
  });

  afterEach(async () => {
    await closeLoopback(app);
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not recorded in the audit trail, while a normal read still is', async () => {
    const res = await request(app)
      .post('/internal/v1/observed')
      .set('Authorization', AGENT_TOKEN)
      .send({
        observed_at: '2026-07-10T22:00:00.000Z',
        controller_id: NODE_ID,
        deltas: [],
        complete_snapshots: [],
      });
    expect(res.status).toBe(200);

    // A normal read is still audited — proves the middleware is active and
    // the exclusion is scoped to the observation push only.
    await request(app).get('/api/v1/disks').set('Authorization', ADMIN_TOKEN);

    await new Promise((r) => setImmediate(r));
    await state.drainer.drainNow();

    const entries = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });

    expect(entries.some((e) => e.kind.includes('observed'))).toBe(false);
    expect(entries.some((e) => e.kind === 'http.GET./disks')).toBe(true);
  });
});
