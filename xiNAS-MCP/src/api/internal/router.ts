import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { requireInternalAgent } from '../middleware/require-internal-agent.js';
import { observedHandler } from './observed.js';

/**
 * /internal/v1 sub-router — the xinas-agent's exclusive write surface.
 *
 * requireInternalAgent() gates every route here: only a bearer token
 * whose role is 'internal_agent' passes (H2). Mounted by createApp under
 * /internal/v1, after request-id + auth so req.context.role is resolved
 * before the gate reads it.
 *
 * H3 wires /observed only. H4 adds /agent_started.
 */
export function internalRouter(ctx: ApiContext): Router {
  const router = Router();
  router.use(requireInternalAgent());
  router.post('/observed', observedHandler(ctx));
  return router;
}
