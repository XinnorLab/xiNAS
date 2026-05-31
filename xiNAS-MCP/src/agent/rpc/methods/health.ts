/**
 * agent.health RPC handler.
 *
 * Reports the agent's overall health status derived from the live
 * collector registry snapshot.  Status computation:
 *   "starting"  — no real collectors have reported yet
 *   "healthy"   — all registered collectors are 'running' or 'stubbed'
 *   "degraded"  — at least one collector is in an 'error: ...' state
 *
 * The HeartbeatTracker on the api side maps 'degraded' to its own
 * EXECUTOR_DEGRADED warning per spec §Flow B.
 */

export type CollectorHealthSnapshot = Record<string, string>;

export interface HealthHandlerOptions {
  version: string;
  controllerId: string;
  startedAt: number; // Date.now() at agent startup
  getCollectorHealth: () => CollectorHealthSnapshot;
}

export type RpcHandler = (params: unknown) => unknown;

export function makeHealthHandler(opts: HealthHandlerOptions): RpcHandler {
  return function healthHandler(_params: unknown): unknown {
    const collectors = opts.getCollectorHealth();
    const entries = Object.values(collectors);
    const uptimeSeconds = Math.floor((Date.now() - opts.startedAt) / 1000);

    let status: 'starting' | 'healthy' | 'degraded' | 'stubbed';
    if (entries.length === 0) {
      status = 'starting';
    } else if (entries.some((v) => v.startsWith('error:'))) {
      status = 'degraded';
    } else if (entries.every((v) => v === 'stubbed')) {
      status = 'starting'; // no real collectors yet
    } else {
      status = 'healthy';
    }

    return {
      status,
      version: opts.version,
      uptime_seconds: uptimeSeconds,
      controller_id: opts.controllerId,
      in_flight_tasks: 0,
      collectors,
    };
  };
}
