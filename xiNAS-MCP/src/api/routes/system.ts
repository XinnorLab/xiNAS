import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { getOrNull, listByPrefix, sendOk, unwrapValues } from '../handlers/reads.js';

export function systemRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/system', (req, res) => {
    const cluster = getOrNull<Record<string, unknown>>(ctx.state, '/xinas/v1/cluster');
    if (!cluster) throw new ApiException('NOT_FOUND', 'cluster not initialized');
    const nodes = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/nodes/');
    if (nodes.length === 0) throw new ApiException('NOT_FOUND', 'no node registered');

    // Merge the live agent state into node.status.agent. currentSnapshot()
    // (H1) bundles state/version/last_heartbeat_at/last_observed_push_at/
    // collectors, so the agent version + per-collector health surface here
    // without a fresh RPC. Omitted when no tracker is wired (the optional
    // agent sub-object in api-v1.yaml). The pre-existing node.status.agent_state
    // field is preserved alongside it.
    const nodeValue = nodes[0]!.value as Record<string, unknown>;
    const agent = ctx.tracker?.currentSnapshot();
    const node = agent
      ? {
          ...nodeValue,
          status: { ...((nodeValue.status as Record<string, unknown>) ?? {}), agent },
        }
      : nodeValue;

    sendOk(req, res, { cluster: cluster.value, node }, [
      cluster.revision,
      ...nodes.map((n) => n.revision),
    ]);
  });

  r.get('/capabilities', (req, res) => {
    const cluster = getOrNull<{ status: { capabilities: Record<string, unknown> } }>(
      ctx.state,
      '/xinas/v1/cluster',
    );
    if (!cluster) throw new ApiException('NOT_FOUND', 'cluster not initialized');
    sendOk(req, res, cluster.value.status.capabilities, [cluster.revision]);
  });

  r.get('/controllers', (req, res) => {
    const nodes = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/nodes/');
    sendOk(
      req,
      res,
      unwrapValues(nodes),
      nodes.map((n) => n.revision),
    );
  });

  return r;
}
