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
 * Collectors and publisher are wired by the convergence module (J3 /
 * deferred F3): buildConvergence() instantiates the real probes,
 * collectors, registry, and publisher; runConvergence() runs the boot
 * sweep + starts event streams. The RPC server binds FIRST so agent.health
 * answers immediately; the boot sweep runs in the BACKGROUND afterwards so
 * an unavailable api can't block startup.
 */

import { execFileSync } from 'node:child_process';
import { loadAgentConfig } from './agent/config.js';
import { buildConvergence, runConvergence } from './agent/convergence.js';
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
    const gidStr = execFileSync('getent', ['group', config.socket_group], {
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

  // Build the convergence (probes -> collectors -> registry + publisher)
  // BEFORE the dispatcher so the health handler's closure can read the live
  // registry. Construction is pure — no probes are run and no event streams
  // are started here; that happens in the background after the server binds.
  const convergence = buildConvergence(config);
  const getCollectorHealth = (): Record<string, string> => convergence.registry.healthSnapshot();

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

  // Kick off the boot sequence + steady-state event streams in the
  // BACKGROUND — never awaited before the server is up. runConvergence is
  // written to absorb every failure (api briefly down, a host tool missing),
  // so this fire-and-forget task cannot crash the agent or surface an
  // unhandled rejection. agent.health already reflects per-collector health
  // via the registry as the boot sweep progresses.
  void runConvergence(convergence);

  // Clean shutdown on SIGINT / SIGTERM. server.close() resolves only once
  // all open connections close, so a held-open client would block teardown
  // until systemd SIGKILLs. Race the close against a short timer and
  // force-exit so we never hang past systemd's stop timeout.
  async function shutdown(signal: string): Promise<void> {
    log('info', 'core', 'shutdown', { signal });
    const forced = setTimeout(() => {
      log('warn', 'core', 'shutdown_forced', { signal });
      process.exit(0);
    }, 3000);
    forced.unref?.();
    // Stop collectors FIRST so their event subprocesses (udevadm / ip
    // monitor) and the subprocess-monitor restart timers are torn down and
    // don't survive past shutdown. allSettled inside registry.stop() means
    // one stubborn collector can't block the rest; the 3s timer is the
    // backstop if a stop() hangs.
    try {
      await convergence.registry.stop();
    } catch {
      /* ignore — registry.stop is allSettled; this guards a sync throw */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    clearTimeout(forced);
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
