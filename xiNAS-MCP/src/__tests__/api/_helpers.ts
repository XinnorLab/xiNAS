import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { createAgentRpcClient } from '../../api/agent-client.js';
import { createApp } from '../../api/app.js';
import type { ApiConfig } from '../../api/config.js';
import type { ApiContext } from '../../api/context.js';
import { HeartbeatTracker, createAgentHealthProbe } from '../../api/heartbeat.js';
import { buildTaskEngines } from '../../api/tasks/build.js';
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
    tokens: {
      'tok-admin': { principal: 'admin:test', role: 'admin' },
      'tok-operator': { principal: 'operator:test', role: 'operator' },
      'tok-viewer': { principal: 'viewer:test', role: 'viewer' },
    },
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
export const OPERATOR_TOKEN = 'Bearer tok-operator';
export const VIEWER_TOKEN = 'Bearer tok-viewer';

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

/** A canned `task.begin` reply: accept (with an acceptance id) or error. */
export type MockTaskBeginReply =
  | { kind: 'accept'; agent_acceptance_id?: string }
  | { kind: 'error'; code: number; message: string; data?: unknown };

export interface MockAgentHandle {
  /**
   * Set the payload the mock agent returns for subsequent `agent.health`
   * JSON-RPC calls. The next heartbeat tick (within heartbeatIntervalMs)
   * picks this up and drives the tracker to the matching state.
   */
  respondToHealth(payload: MockAgentHealth): void;
  /**
   * Set how the mock agent answers `task.begin`. Default: accept with a
   * fresh `agent_acceptance_id`. The T4 reference-route dispatch test drives
   * this to exercise accept (→ running/202) vs error (→ failed/422-503).
   */
  respondToTaskBegin(reply: MockTaskBeginReply): void;
  /** Number of `task.begin` RPCs the mock agent has received so far. */
  taskBeginCallCount(): number;
  /**
   * Params of the LAST `task.begin` the mock agent received (`{ task_id, kind,
   * spec, plan }`), or undefined if none yet. Lets a test assert the api
   * forwarded the raw executor spec end-to-end (T9b).
   */
  lastTaskBeginParams(): Record<string, unknown> | undefined;
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
export async function buildTestAppWithMockAgent(
  opts: { maxInflight?: number } = {},
): Promise<MockAgentSetup> {
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

  // Wire the S2 task engines + an agent RPC client pointed at the mock UDS so
  // the reference route (T4) can dispatch task.begin end-to-end.
  const tasks = buildTaskEngines({
    state,
    agentClient: createAgentRpcClient(agentSockPath),
    ...(opts.maxInflight !== undefined ? { maxInflight: opts.maxInflight } : {}),
  });

  const ctx: ApiContext = { config, state, tracker, tasks };
  const app = createApp(ctx);

  // Boot the mock agent UDS server. It answers agent.health with the
  // configured payload (empty/offline-ish until respondToHealth is called)
  // and task.begin per the configured reply (default: accept).
  let currentHealthPayload: MockAgentHealth | null = null;
  let taskBeginReply: MockTaskBeginReply = { kind: 'accept' };
  let taskBeginCalls = 0;
  let lastTaskBeginParams: Record<string, unknown> | undefined;
  // Track live server-side connections so teardown can force-destroy them; a
  // half-open UDS conn the client destroyed keeps server.close() from resolving.
  const agentConns = new Set<Socket>();
  let agentServer: Server | null = createServer((conn) => {
    agentConns.add(conn);
    conn.on('close', () => agentConns.delete(conn));
    let buf = '';
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: { id?: number | string | null; method?: string; params?: unknown };
        try {
          req = JSON.parse(line) as typeof req;
        } catch {
          continue;
        }
        const id = req.id ?? null;
        if (req.method === 'agent.health' && currentHealthPayload) {
          conn.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: currentHealthPayload })}\n`);
        } else if (req.method === 'task.begin') {
          taskBeginCalls += 1;
          lastTaskBeginParams =
            req.params !== null && typeof req.params === 'object'
              ? (req.params as Record<string, unknown>)
              : {};
          if (taskBeginReply.kind === 'accept') {
            conn.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id,
                result: {
                  accepted: true,
                  agent_acceptance_id: taskBeginReply.agent_acceptance_id ?? randomUUID(),
                },
              })}\n`,
            );
          } else {
            conn.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: {
                  code: taskBeginReply.code,
                  message: taskBeginReply.message,
                  ...(taskBeginReply.data !== undefined ? { data: taskBeginReply.data } : {}),
                },
              })}\n`,
            );
          }
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
    respondToTaskBegin(reply) {
      taskBeginReply = reply;
    },
    taskBeginCallCount() {
      return taskBeginCalls;
    },
    lastTaskBeginParams() {
      return lastTaskBeginParams;
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
        for (const c of agentConns) c.destroy();
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
        for (const c of agentConns) c.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
