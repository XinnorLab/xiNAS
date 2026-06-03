import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import {
  embedMetadata,
  getOrNull,
  listByPrefix,
  sendOk,
  unwrapResources,
} from '../handlers/reads.js';

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
    // Embed the synthesized metadata (from each row's KV tracking) so the
    // public Node/Cluster responses carry the schema-required `metadata`.
    const nodeWithMeta = embedMetadata(nodes[0]!) as Record<string, unknown>;
    const agent = ctx.tracker?.currentSnapshot();
    const node = agent
      ? {
          ...nodeWithMeta,
          status: { ...((nodeWithMeta.status as Record<string, unknown>) ?? {}), agent },
        }
      : nodeWithMeta;

    sendOk(req, res, { cluster: embedMetadata(cluster), node }, [
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
      unwrapResources(nodes),
      nodes.map((n) => n.revision),
    );
  });

  return r;
}
