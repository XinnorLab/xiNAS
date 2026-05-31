/**
 * xinas-agent process entry point.
 *
 * Boot sequence (spec §Flow C step 2):
 *  1. Load AgentConfig (reads /etc/xinas-agent/config.json,
 *     /etc/xinas-agent/agent-token, /var/lib/xinas/controller-id).
 *  2. Build the RPC handler map: real methods + stubs.
 *  3. Create the JSON-RPC dispatcher.
 *  4. Bind the UDS RPC server (chmod 0660, chown root:xinas-api).
 *  5. Register SIGINT/SIGTERM for clean shutdown.
 *  6. Log startup complete.
 *
 * Collectors and publisher are wired in Phase F (F3).  In S0 the
 * collector registry is empty; agent.health reports status='starting'.
 */

import { execSync } from 'node:child_process';
import { loadAgentConfig } from './agent/config.js';
import { log } from './agent/log.js';
import { createDispatcher } from './agent/rpc/dispatch.js';
import { makeHealthHandler } from './agent/rpc/methods/health.js';
import { STUB_METHODS } from './agent/rpc/methods/stubs.js';
import { makeVersionHandler } from './agent/rpc/methods/version.js';
import { createAgentRpcServer } from './agent/rpc/server.js';

const VERSION = process.env['XINAS_AGENT_VERSION'] ?? '0.0.0-dev';
const GIT_SHA = process.env['XINAS_AGENT_GIT_SHA'];
const BUILD_DATE = process.env['XINAS_AGENT_BUILD_DATE'];

async function main(): Promise<void> {
  const configPath = process.env['XINAS_AGENT_CONFIG_PATH'];
  const config = loadAgentConfig(configPath !== undefined ? { configPath } : undefined);

  log('info', 'core', 'startup', {
    version: VERSION,
    controller_id: config.controller_id,
    agent_socket: config.agent_socket,
  });

  // Resolve the socket group GID.  On a provisioned host this is the
  // xinas-api group; in tests it may be the process's own gid.
  let socketGroupGid: number;
  try {
    const gidStr = execSync(`getent group "${config.socket_group}"`, {
      encoding: 'utf8',
    }).split(':')[2];
    socketGroupGid = parseInt(gidStr ?? '', 10);
    if (isNaN(socketGroupGid)) throw new Error('unparseable gid');
  } catch {
    log('warn', 'core', 'socket_group_resolve_failed', {
      group: config.socket_group,
      fallback: 'process gid',
    });
    socketGroupGid = process.getgid?.() ?? 0;
  }

  // Empty collector registry for S0 — Phase E wires real collectors.
  const getCollectorHealth = (): Record<string, string> => ({});

  const healthHandler = makeHealthHandler({
    version: VERSION,
    controllerId: config.controller_id,
    startedAt: Date.now(),
    getCollectorHealth,
  });

  const versionHandler = makeVersionHandler({
    version: VERSION,
    ...(GIT_SHA !== undefined ? { gitSha: GIT_SHA } : {}),
    ...(BUILD_DATE !== undefined ? { buildDate: BUILD_DATE } : {}),
  });

  const dispatch = createDispatcher({
    'agent.health': healthHandler,
    'agent.version': versionHandler,
    ...STUB_METHODS,
  });

  const server = await createAgentRpcServer({
    socketPath: config.agent_socket,
    dispatch,
    socketGroupGid,
  });

  log('info', 'core', 'listening', { socket: config.agent_socket });

  // Clean shutdown on SIGINT / SIGTERM.
  async function shutdown(signal: string): Promise<void> {
    log('info', 'core', 'shutdown', { signal });
    await server.close();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      subsystem: 'core',
      event: 'fatal',
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
