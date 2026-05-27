import express, { type Express, Router } from 'express';
import type { ApiContext } from './context.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { authMiddleware } from './middleware/auth.js';
import { auditMiddleware } from './middleware/audit.js';
import { errorMiddleware } from './middleware/error.js';
import { systemRouter } from './routes/system.js';
import { storageRouter } from './routes/storage.js';
import { nfsRouter } from './routes/nfs.js';
import { networkRouter } from './routes/network.js';
import { healthRouter } from './routes/health.js';
import { tasksRouter } from './routes/tasks.js';
import { eventsRouter } from './routes/events.js';
import { auditRouter } from './routes/audit-query.js';
import { configHistoryRouter } from './routes/config-history.js';
import { supportRouter } from './routes/support.js';
import { inventoryRouter } from './routes/inventory.js';
import { executorUnavailable } from './handlers/unsupported.js';

export function createApp(ctx: ApiContext): Express {
  const app = express();
  app.disable('x-powered-by');
  // Middleware order rationale:
  //   1. requestId runs first so even body-parser SyntaxErrors and
  //      auth failures carry a real request_id / correlation_id in
  //      the envelope (otherwise errorMiddleware falls back to
  //      "unknown" and the audit/correlation trail is lost).
  //   2. audit registers its res.on('finish') hook next so every
  //      response — including auth 401s — gets an audit entry per
  //      reqs §14. The audit middleware uses 'unauthenticated' as
  //      the principal fallback when auth never assigned one.
  //   3. json comes after audit (its parse failures still surface
  //      a 400 INVALID_ARGUMENT via errorMiddleware; the audit
  //      finish hook fires regardless).
  //   4. auth runs last; failed auth still triggers the audit
  //      finish hook because audit registered before this.
  app.use(requestIdMiddleware());
  app.use(auditMiddleware(ctx.state));
  app.use(express.json({ limit: '1mb' }));
  app.use(authMiddleware(ctx.config));

  const v1 = Router();
  v1.use(systemRouter(ctx));
  v1.use(storageRouter(ctx));
  v1.use(nfsRouter(ctx));
  v1.use(networkRouter(ctx));
  v1.use(healthRouter(ctx));
  v1.use(tasksRouter(ctx));
  v1.use(eventsRouter(ctx));
  v1.use(auditRouter(ctx));
  v1.use(configHistoryRouter(ctx));
  v1.use(supportRouter(ctx));
  v1.use(inventoryRouter(ctx));

  // Mutating verbs all route to the executor-unavailable stub until
  // xinas-agent ships. Per ADR-0002 §Agent heartbeat, plan and apply
  // both return INTERNAL/EXECUTOR_UNAVAILABLE. Each route gets its
  // own real handler in a later PR.
  const mutatingRoutes = [
    '/arrays',
    '/arrays/:id',
    '/filesystems',
    '/filesystems/:id',
    '/shares',
    '/shares/:id',
    '/nfs-profiles/:id',
    '/network/interfaces/:id',
    '/config-history/rollback',
  ];
  for (const route of mutatingRoutes) {
    v1.post(route, executorUnavailable);
    v1.patch(route, executorUnavailable);
    v1.put(route, executorUnavailable);
    v1.delete(route, executorUnavailable);
  }

  app.use('/api/v1', v1);

  app.use(errorMiddleware());
  return app;
}
