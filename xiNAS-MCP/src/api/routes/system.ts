import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function systemRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/system', (req, res) => {
    const cluster = getOrNull<Record<string, unknown>>(ctx.state, '/xinas/v1/cluster');
    if (!cluster) throw new ApiException('NOT_FOUND', 'cluster not initialized');
    const nodes = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/nodes/');
    if (nodes.length === 0) throw new ApiException('NOT_FOUND', 'no node registered');
    sendOk(req, res, { cluster: cluster.value, node: nodes[0]!.value }, [
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
