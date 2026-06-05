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

export interface StartServerOptions {
  configPath?: string;
  inline?: ApiConfig;
}

export interface ServerHandle {
  address: AddressInfo | string;
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
    });
    tracker.start();
  }

  // S2 task engine: plan/apply/task engines over the shared SQLite handle,
  // plus an api→agent RPC client (when an agent socket is configured) the
  // mutating routes dispatch task.begin through.
  const tasks = buildTaskEngines({
    state,
    ...(config.agent ? { agentClient: createAgentRpcClient(config.agent.socket) } : {}),
  });

  // Conditional spread for the optionals — exactOptionalPropertyTypes refuses
  // an explicit `tracker: undefined` / `observedSchemas: undefined`.
  const ctx: ApiContext = {
    config,
    state,
    tasks,
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

  return {
    address,
    state,
    async close() {
      // Clear the heartbeat tick timer first so no probe fires mid-shutdown.
      tracker?.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await state.close();
    },
  };
}
