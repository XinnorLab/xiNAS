import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { requireInternalAgent } from '../middleware/require-internal-agent.js';
import { taskProgressHandler } from '../tasks/progress.js';
import { agentStartedHandler } from './agent-started.js';
import { observedHandler } from './observed.js';

/**
 * /internal/v1 sub-router — the xinas-agent's exclusive write surface.
 *
 * requireInternalAgent() gates every route here: only a bearer token
 * whose role is 'internal_agent' passes (H2). Mounted by createApp under
 * /internal/v1, after request-id + auth so req.context.role is resolved
 * before the gate reads it.
 *
 * H3 wires /observed. H4 adds /agent_started. T5 adds /task_progress (the
 * agent→api task progress push that replaces the removed task.stage_report RPC).
 */
export function internalRouter(ctx: ApiContext): Router {
  const router = Router();
  router.use(requireInternalAgent());
  router.post('/observed', observedHandler(ctx));
  router.post('/agent_started', agentStartedHandler(ctx));
  router.post('/task_progress', taskProgressHandler(ctx));
  return router;
}
