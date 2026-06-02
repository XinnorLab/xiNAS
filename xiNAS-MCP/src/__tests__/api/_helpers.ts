import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../api/app.js';
import type { ApiConfig } from '../../api/config.js';
import type { ApiContext } from '../../api/context.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';
import { type OpenedStateStore, openStateStore } from '../../state/index.js';

export interface TestSetup {
  dir: string;
  config: ApiConfig;
  state: OpenedStateStore;
  app: ReturnType<typeof createApp>;
  ctx: ApiContext;
}

const NODE_ID = '00000000-0000-0000-0000-0000000000aa';

/**
 * Build an app + state store wired together for a single test.
 * Caller must call cleanup() at the end of the test.
 */
export async function buildTestApp(): Promise<TestSetup & { cleanup(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'xinas-api-test-'));
  const config: ApiConfig = {
    controller_id: NODE_ID,
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
    state: {
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
    },
  };
  const state = await openStateStore({
    databasePath: config.state.databasePath,
    auditJsonlPath: config.state.auditJsonlPath,
    nodeId: NODE_ID,
  });
  // Wire an (unstarted, so always-offline) HeartbeatTracker so routes that
  // surface agent state — e.g. /api/v1/system → node.status.agent — have a
  // deterministic tracker. It never start()s, so no tick timer/probe runs.
  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: NODE_ID,
    state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });
  const ctx: ApiContext = { config, state, tracker };
  const app = createApp(ctx);
  return {
    dir,
    config,
    state,
    app,
    ctx,
    async cleanup() {
      await state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Standard admin Authorization header for supertest calls. */
export const ADMIN_TOKEN = 'Bearer tok-admin';

/** Seed a singleton Cluster object. */
export function seedCluster(state: OpenedStateStore): void {
  state.kv.put('/xinas/v1/cluster', {
    kind: 'Cluster',
    id: 'default',
    spec: { display_name: 'test-cluster' },
    status: {
      mode: 'single_node',
      capabilities: {
        ha: 'not_enabled',
        quorum: 'not_enabled',
        witness: 'not_enabled',
        'nfs.v3_locking_managed': false,
        'nfs.recovery_state_managed': false,
        'mcp.allow_apply': false,
      },
      member_node_ids: [NODE_ID],
    },
  });
}

/** Seed the singleton Node. */
export function seedNode(state: OpenedStateStore): void {
  state.kv.put(`/xinas/v1/nodes/${NODE_ID}`, {
    kind: 'Node',
    id: NODE_ID,
    spec: { hostname: 'test-host' },
    status: {
      agent_state: 'offline',
      observation_age_seconds: 0,
    },
  });
}

/** Seed a Share under /xinas/v1/desired/Share/<id>. */
export function seedShare(state: OpenedStateStore, id: string): void {
  state.kv.put(`/xinas/v1/desired/Share/${id}`, {
    kind: 'Share',
    id,
    spec: {
      path: `/srv/nfs/${id}`,
      clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
      fsid: 42,
    },
  });
}

/** Seed the NfsProfile singleton. */
export function seedNfsProfile(state: OpenedStateStore): void {
  state.kv.put('/xinas/v1/desired/NfsProfile/default', {
    kind: 'NfsProfile',
    id: 'default',
    spec: {
      versions: {
        v3: { enabled: false },
        v4_0: { enabled: false },
        v4_1: { enabled: true },
        v4_2: { enabled: true },
      },
      rdma: { enabled: true, port: 20049 },
      threads: { count: 64 },
    },
  });
}
