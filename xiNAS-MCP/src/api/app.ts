import express, { type Express, Router } from 'express';
import type { ApiContext } from './context.js';
import { ApiException } from './errors.js';
import { executorUnavailable } from './handlers/unsupported.js';
import type { HeartbeatTracker } from './heartbeat.js';
import { internalRouter } from './internal/router.js';
import { auditMiddleware } from './middleware/audit.js';
import { authMiddleware } from './middleware/auth.js';
import { errorMiddleware } from './middleware/error.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { systemWarningsMiddleware } from './middleware/system-warnings.js';
import { auditRouter } from './routes/audit-query.js';
import { configHistoryRouter } from './routes/config-history.js';
import { eventsRouter } from './routes/events.js';
import { groupsRouter } from './routes/groups.js';
import { healthRouter } from './routes/health.js';
import { inventoryRouter } from './routes/inventory.js';
import { networkRouter } from './routes/network.js';
import { nfsIdmapRouter } from './routes/nfs-idmap.js';
import { nfsRouter } from './routes/nfs.js';
import { arraysRouter } from './routes/arrays.js';
import { referenceRouter } from './routes/reference.js';
import { storageRouter } from './routes/storage.js';
import { supportRouter } from './routes/support.js';
import { systemRouter } from './routes/system.js';
import { tasksRouter } from './routes/tasks.js';
import { usersRouter } from './routes/users.js';

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

  // The agent's exclusive write surface. Mounted after authMiddleware so
  // req.context.role is resolved before requireInternalAgent (inside the
  // sub-router) reads it; before /api/v1 so /internal/v1/* never falls
  // through to the public API's NOT_FOUND catch-all.
  //
  // systemWarningsMiddleware is intentionally NOT mounted at the top-level app
  // so that /internal/v1/* requests are excluded — the agent's own observation
  // push must not receive an EXECUTOR_DEGRADED self-warning (Fix H-review-2).
  app.use('/internal/v1', internalRouter(ctx));

  const v1 = Router();
  v1.use(systemWarningsMiddleware(ctx)); // after auth (context populated), before route handlers
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
  v1.use(usersRouter(ctx));
  v1.use(groupsRouter(ctx));
  v1.use(nfsIdmapRouter(ctx));

  // S2 reference plan/apply route — the first REAL mutating route, wired to
  // the task engine (ctx.tasks). Mounted before the executorUnavailable stub
  // loop below; /reference is not in that list, so there is no shadowing.
  v1.use(referenceRouter(ctx));

  // S3: POST /arrays (xiraid.array.create) is real — mounted before the stub
  // loop, and POST /arrays is excluded from it below. PATCH/DELETE /arrays/:id
  // (modify/delete) stay stubbed until their plans land (ADR-0006).
  v1.use(arraysRouter(ctx));

  // Mutating verbs all route to the executor-unavailable stub until their
  // real plan/apply routes ship. Per ADR-0002 §Agent heartbeat, plan and
  // apply both return INTERNAL/EXECUTOR_UNAVAILABLE. Each route gets its
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
    // POST /arrays is the real S3 create route mounted above.
    if (route !== '/arrays') v1.post(route, executorUnavailable(ctx));
    v1.patch(route, executorUnavailable(ctx));
    v1.put(route, executorUnavailable(ctx));
    v1.delete(route, executorUnavailable(ctx));
  }

  // Catch-all for /api/v1/* paths that didn't match any router. Without
  // this, unknown routes fall through to Express's default 404 which
  // returns text/html — breaking the envelope contract documented in
  // api-v1.yaml. ApiException is caught by errorMiddleware and emitted
  // as a NOT_FOUND envelope.
  v1.use((req, _res, next) => {
    next(new ApiException('NOT_FOUND', `no such API route: ${req.method} /api/v1${req.path}`));
  });

  app.use('/api/v1', v1);

  app.use(errorMiddleware());
  return app;
}

/**
 * Variant of createApp that requires a HeartbeatTracker in context.
 * Identical wiring to createApp; the narrowed type just documents that
 * callers building the production app (and the H3+ internal tests) supply
 * a tracker so /internal/v1/observed can call recordObservationPush.
 */
export function createAppWithTracker(ctx: ApiContext & { tracker: HeartbeatTracker }): Express {
  return createApp(ctx);
}
