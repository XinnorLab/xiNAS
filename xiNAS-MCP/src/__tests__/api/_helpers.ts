import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../api/app.js';
import type { ApiConfig } from '../../api/config.js';
import type { ApiContext } from '../../api/context.js';
import { HeartbeatTracker, createAgentHealthProbe } from '../../api/heartbeat.js';
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

// ---------------------------------------------------------------------------
// Mock-agent helper (Task J1)
// ---------------------------------------------------------------------------

/** controller_id used by the mock-agent setup (matches the bound config). */
const MOCK_CONTROLLER_ID = '00000000-0000-0000-0000-000000000099';
/** internal_agent bearer the mock agent posts observations with. */
const MOCK_AGENT_TOKEN = 'internal-agent-tok-test';
/** Fast heartbeat interval so ticks fire within a test's lifetime. */
const MOCK_HEARTBEAT_INTERVAL_MS = 200;

/**
 * Payload the mock agent returns for an `agent.health` JSON-RPC call. Mirrors
 * the agent's real health result; the tracker only consumes `version` +
 * `collectors`, but the test passes the full shape so the mock is realistic.
 */
export interface MockAgentHealth {
  status: string;
  version: string;
  uptime_seconds: number;
  controller_id: string;
  in_flight_tasks: number;
  collectors: Record<string, string>;
}

/** What the mock agent will return for the NEXT observation POST. */
interface ObservationBody {
  observed_at: string;
  controller_id: string;
  deltas: unknown[];
  complete_snapshots: string[];
}

export interface MockAgentHandle {
  /**
   * Set the payload the mock agent returns for subsequent `agent.health`
   * JSON-RPC calls. The next heartbeat tick (within heartbeatIntervalMs)
   * picks this up and drives the tracker to the matching state.
   */
  respondToHealth(payload: MockAgentHealth): void;
  /**
   * POST an observation batch to /internal/v1/observed with the internal
   * agent bearer so observed state becomes readable via the public GET
   * routes. Driven through supertest against the in-process app (the app is
   * not bound to a real UDS in tests).
   */
  postObservation(body: ObservationBody): Promise<void>;
  /**
   * Stop the mock agent from answering (close its UDS server) so the next
   * heartbeat tick's probe rejects with ECONNREFUSED → tracker → offline.
   * Resolves once the tracker has actually observed the offline transition.
   */
  simulateOffline(): Promise<void>;
}

export interface MockAgentSetup {
  app: Express;
  state: OpenedStateStore;
  config: ApiConfig;
  controllerId: string;
  heartbeatIntervalMs: number;
  mockAgent: MockAgentHandle;
  teardown(): Promise<void>;
}

/**
 * Build an app wired to a real mock-agent UDS server plus a started
 * HeartbeatTracker. Unlike buildTestApp(), the tracker here uses the
 * production createAgentHealthProbe() pointed at the mock socket, so the
 * tick loop performs real JSON-RPC-over-UDS round-trips and heartbeat state
 * transitions can be exercised end-to-end.
 *
 * Caller MUST call teardown() — it stops the tracker tick (so the runner
 * doesn't hang), closes the mock server, closes the state store, and removes
 * the temp dir.
 */
export async function buildTestAppWithMockAgent(): Promise<MockAgentSetup> {
  const dir = mkdtempSync(join(tmpdir(), 'xinas-mock-agent-'));
  const agentSockPath = join(dir, 'agent.sock');

  const config: ApiConfig = {
    controller_id: MOCK_CONTROLLER_ID,
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    tokens: {
      'tok-admin': { principal: 'admin:test', role: 'admin' },
      [MOCK_AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
    },
    state: {
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
    },
  };

  const state = await openStateStore({
    databasePath: config.state.databasePath,
    auditJsonlPath: config.state.auditJsonlPath,
    nodeId: MOCK_CONTROLLER_ID,
  });

  // Seed cluster + node so /api/v1/system returns 200; the live agent state
  // is supplied by the tracker's currentSnapshot(), not the seeded node.
  seedCluster(state);
  seedNode(state);

  const tracker = new HeartbeatTracker({
    intervalMs: MOCK_HEARTBEAT_INTERVAL_MS,
    controllerId: MOCK_CONTROLLER_ID,
    state,
    agentSocketPath: agentSockPath,
    healthProbe: createAgentHealthProbe(agentSockPath),
  });

  const ctx: ApiContext = { config, state, tracker };
  const app = createApp(ctx);

  // Boot the mock agent UDS server. It answers agent.health with the
  // configured payload (empty/offline-ish until respondToHealth is called).
  let currentHealthPayload: MockAgentHealth | null = null;
  let agentServer: Server | null = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: { id?: number | string | null; method?: string };
        try {
          req = JSON.parse(line) as typeof req;
        } catch {
          continue;
        }
        const id = req.id ?? null;
        if (req.method === 'agent.health' && currentHealthPayload) {
          conn.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: currentHealthPayload })}\n`);
        } else {
          conn.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32000,
                message: 'stubbed',
                data: { code: 'EXECUTOR_UNSUPPORTED' },
              },
            })}\n`,
          );
        }
      }
    });
    conn.on('error', () => conn.destroy());
  });
  await new Promise<void>((resolve) => agentServer?.listen(agentSockPath, resolve));

  // Start the heartbeat tick (fires immediately, then every interval).
  tracker.start();

  const mockAgent: MockAgentHandle = {
    respondToHealth(payload) {
      currentHealthPayload = payload;
    },
    async postObservation(body) {
      await request(app)
        .post('/internal/v1/observed')
        .set('Authorization', `Bearer ${MOCK_AGENT_TOKEN}`)
        .send(body);
    },
    async simulateOffline() {
      currentHealthPayload = null;
      if (agentServer) {
        const server = agentServer;
        agentServer = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      // Wait for a tick to fire against the now-closed socket so the probe
      // rejects (ECONNREFUSED/ENOENT) and the tracker records connect-refused.
      const deadline = Date.now() + MOCK_HEARTBEAT_INTERVAL_MS * 8 + 500;
      while (tracker.currentState() !== 'offline' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, MOCK_HEARTBEAT_INTERVAL_MS / 4));
      }
    },
  };

  return {
    app,
    state,
    config,
    controllerId: MOCK_CONTROLLER_ID,
    heartbeatIntervalMs: MOCK_HEARTBEAT_INTERVAL_MS,
    mockAgent,
    async teardown() {
      tracker.stop();
      if (agentServer) {
        const server = agentServer;
        agentServer = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
