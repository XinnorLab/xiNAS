import { chmodSync, chownSync, existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type OpenedStateStore, openStateStore } from '../state/index.js';
import { createAgentRpcClient } from './agent-client.js';
import { createApp } from './app.js';
import { type ApiConfig, loadConfig } from './config.js';
import type { ApiContext } from './context.js';
import { HeartbeatTracker, createAgentHealthProbe } from './heartbeat.js';
import { loadObservedSchemas } from './observed-schemas.js';
import { buildTaskEngines } from './tasks/build.js';
import { TaskWatch } from './tasks/watch.js';

export interface StartServerOptions {
  configPath?: string;
  inline?: ApiConfig;
}

export interface ServerHandle {
  address: AddressInfo | string;
  /** The optional dedicated MCP TCP listener address (S8 T7). */
  mcpAddress?: AddressInfo | string;
  state: OpenedStateStore;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const config = loadConfig(opts);
  // Conditional spread — exactOptionalPropertyTypes refuses
  // `archiveDir: config.state.archiveDir` when archiveDir is optional.
  const state = await openStateStore({
    databasePath: config.state.databasePath,
    auditJsonlPath: config.state.auditJsonlPath,
    nodeId: config.controller_id,
    ...(config.state.archiveDir !== undefined ? { archiveDir: config.state.archiveDir } : {}),
  });
  state.drainer.start();

  // Compile inbound-observation validators from api-v1.yaml once. Returns null
  // (validation skipped) when the spec isn't shipped — the graceful default.
  const observed = loadObservedSchemas();

  // S2 task engine: plan/apply/task engines over the shared SQLite handle,
  // plus an api→agent RPC client (when an agent socket is configured) the
  // mutating routes dispatch task.begin through. Built BEFORE the heartbeat
  // tracker so the tracker's onReconnect hook (T9) can trigger reconcile().
  // S2 resumable SSE fan-out (s2-task-envelope-spec §10). The task_progress
  // receiver (T5) calls taskWatch.notify() after applying each event so a live
  // /tasks/{id}/watch stream sees it; replay-on-reconnect is served from the
  // durable task_stages rows by the watch route. Created BEFORE the engines:
  // engine-local terminals (queued cancel / failBeforeChange — S10) notify
  // watchers through the same fan-out.
  const taskWatch = new TaskWatch();

  const tasks = buildTaskEngines({
    state,
    taskWatch,
    ...(config.agent ? { agentClient: createAgentRpcClient(config.agent.socket) } : {}),
    ...(config.tasks?.max_inflight !== undefined ? { maxInflight: config.tasks.max_inflight } : {}),
  });

  // When the api is configured to track a xinas-agent, poll its UDS for
  // agent.health on an interval and surface the derived state to routes.
  let tracker: HeartbeatTracker | undefined;
  if (config.agent) {
    tracker = new HeartbeatTracker({
      intervalMs: config.agent.heartbeat_interval_ms ?? 5000,
      controllerId: config.controller_id,
      state,
      agentSocketPath: config.agent.socket,
      healthProbe: createAgentHealthProbe(config.agent.socket),
      // T9 (s2-task-envelope-spec §9): on the offline→healthy edge (incl. the
      // agent's first appearance), reconcile — sweep expired leases and
      // adopt/redispatch in-flight work. Fire-and-forget; the engine's
      // re-entrancy guard makes any overlap with the startup reconcile a no-op.
      onReconnect: () => {
        void tasks.taskEngine.reconcile({ agentClient: tasks.agentClient }).catch(() => {
          /* best-effort: a reconcile-trigger failure is non-fatal */
        });
      },
    });
    tracker.start();
  }

  // Startup reconciliation (s2-task-envelope-spec §9): sweep expired leases and
  // adopt/redispatch in-flight work left by a prior api/agent restart.
  // Best-effort and fire-and-forget — a failure (e.g. agent not up yet) is
  // recovered by the offline→healthy reconnect trigger. The engine's
  // re-entrancy guard makes any overlap with the immediate heartbeat tick a no-op.
  void tasks.taskEngine.reconcile({ agentClient: tasks.agentClient }).catch(() => {
    /* best-effort */
  });

  // Conditional spread for the optionals — exactOptionalPropertyTypes refuses
  // an explicit `tracker: undefined` / `observedSchemas: undefined`.
  const ctx: ApiContext = {
    config,
    state,
    tasks,
    taskWatch,
    ...(tracker ? { tracker } : {}),
    ...(observed ? { observedSchemas: observed.schemas, ajv: observed.ajv } : {}),
  };
  const app = createApp(ctx);
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    if (config.listen.kind === 'unix') {
      if (existsSync(config.listen.socket)) unlinkSync(config.listen.socket);
      const socketPath = config.listen.socket;
      const socketGroup = config.listen.socketGroup;
      server.listen(socketPath, () => {
        // 0660 — owner + group can connect; everyone else gets
        // EACCES. The auth middleware trusts any UDS caller without
        // a bearer header as admin (a viewer token, if presented,
        // is still honored as viewer — see auth.ts).
        chmodSync(socketPath, 0o660);
        if (socketGroup !== undefined) {
          // chown to (-1, socketGroup): keep current owner, set group
          // to the configured gid (e.g. xinas-admin). The process
          // must be a member of that group (DynamicUser unit uses
          // SupplementaryGroups=xinas-admin). When socketGroup is
          // unset the socket keeps the process's primary group and
          // is effectively only reachable by the api process — safe
          // default, but production deployments MUST set it.
          chownSync(socketPath, -1, socketGroup);
        }
        server.off('error', onError);
        resolve();
      });
    } else {
      server.listen(config.listen.port, config.listen.host, () => {
        server.off('error', onError);
        resolve();
      });
    }
  });

  const address = server.address();
  if (!address) throw new Error('server.address() returned null');

  // S8 T7 (ADR-0010): the loopback fn the MCP dispatcher replays tool
  // calls through — targets the api's OWN primary listener so the full
  // middleware spine runs. Injected post-listen; /mcp 503s before this.
  ctx.loopback_fn = (lreq) =>
    new Promise((resolve, reject) => {
      const payload = lreq.body !== undefined ? JSON.stringify(lreq.body) : undefined;
      const base =
        typeof address === 'string'
          ? { socketPath: address }
          : { host: '127.0.0.1', port: address.port };
      const req2 = http.request(
        {
          ...base,
          path: lreq.path,
          method: lreq.method,
          headers: {
            ...lreq.headers,
            ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res2) => {
          const chunks: Buffer[] = [];
          res2.on('data', (c: Buffer) => chunks.push(c));
          res2.on('end', () => {
            const textBody = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try {
              body = textBody.length > 0 ? JSON.parse(textBody) : {};
            } catch {
              body = { raw: textBody };
            }
            resolve({ status: res2.statusCode ?? 0, body });
          });
        },
      );
      req2.on('error', reject);
      if (payload !== undefined) req2.write(payload);
      req2.end();
    });

  // Optional dedicated MCP TCP listener (same app — same routes,
  // same /mcp endpoint; the legacy demo port re-points here).
  let mcpServer: http.Server | undefined;
  if (config.mcp?.http !== undefined) {
    mcpServer = http.createServer(app);
    const mcpHttp = config.mcp.http;
    await new Promise<void>((resolve, reject) => {
      (mcpServer as http.Server).once('error', reject);
      (mcpServer as http.Server).listen(mcpHttp.port, mcpHttp.host, () => resolve());
    });
  }

  return {
    ...(mcpServer !== undefined && mcpServer.address() !== null
      ? { mcpAddress: mcpServer.address() as AddressInfo | string }
      : {}),
    address,
    state,
    async close() {
      // Clear the heartbeat tick timer first so no probe fires mid-shutdown.
      tracker?.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (mcpServer !== undefined) {
        await new Promise<void>((resolve, reject) => {
          (mcpServer as http.Server).close((err) => (err ? reject(err) : resolve()));
        });
      }
      await state.close();
    },
  };
}
