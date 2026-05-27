import http from 'node:http';
import { unlinkSync, existsSync, chmodSync, chownSync } from 'node:fs';
import { openStateStore, type OpenedStateStore } from '../state/index.js';
import { createApp } from './app.js';
import { loadConfig, type ApiConfig } from './config.js';
import type { AddressInfo } from 'node:net';

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

  const app = createApp({ config, state });
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
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await state.close();
    },
  };
}
