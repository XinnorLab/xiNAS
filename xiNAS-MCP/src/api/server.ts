import http from 'node:http';
import { unlinkSync, existsSync, chmodSync } from 'node:fs';
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
      server.listen(socketPath, () => {
        // 0660 — owner (root) + group (xinas-admin, set by the
        // Ansible role) can connect; everyone else gets EACCES.
        // The auth middleware's isUnixSocketConnection() trusts
        // any caller who got past this gate as admin.
        chmodSync(socketPath, 0o660);
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
