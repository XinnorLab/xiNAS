import express, { type Express, Router } from 'express';
import type { ApiContext } from './context.js';
import { ApiException } from './errors.js';
import { executorUnavailable } from './handlers/unsupported.js';
import { rbacMiddleware } from './middleware/rbac.js';
import { promotedReadsRouter } from './routes/promoted-reads.js';
import { mountMcpTransport } from './mcp/transport.js';
import { randomBytes } from 'node:crypto';
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
import { nfsMutateRouter } from './routes/nfs-mutate.js';
import { nfsRouter } from './routes/nfs.js';
import { arraysRouter } from './routes/arrays.js';
import { filesystemsRouter } from './routes/filesystems.js';
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
  // S8 T7: the MCP transport endpoint (ADR-0010) — mounted BEFORE the
  // json body-parser limit applies to /api/v1 (express.json below also
  // parses /mcp bodies, which the transport consumes pre-parsed).
  // Audit skips /mcp (T4); auth does not run for /mcp (the transport
  // resolves identity itself and replays through the loopback).
  mountMcpTransport(app, ctx);

  // S8 T4: the loopback token is minted per process start (ADR-0010).
  ctx.loopback_token ??= randomBytes(32).toString('hex');

  app.use(requestIdMiddleware());
  app.use(auditMiddleware(ctx.state));
  app.use(express.json({ limit: '1mb' }));
  app.use(authMiddleware(ctx.config, () => ctx.loopback_token));

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
  // S8 T3 (ADR-0010 review P0): the FIRST role enforcement on public
  // routes — auth resolves ctx.role, this ranks it against the
  // catalog's min_role (unmatched routes require admin).
  v1.use(rbacMiddleware());
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
  // S8 T5 (ADR-0010): the promoted legacy read routes.
  v1.use(promotedReadsRouter(ctx));

  // S2 reference plan/apply route — the first REAL mutating route, wired to
  // the task engine (ctx.tasks). Mounted before the executorUnavailable stub
  // loop below; /reference is not in that list, so there is no shadowing.
  v1.use(referenceRouter(ctx));

  // S3-NFS N5 + N7.3 — the real NFS mutating routes (share.create/update/
  // delete + nfs-profile.update + nfs-idmap.set) over the N4 plan providers.
  // Mounted BEFORE the executorUnavailable stub loop so the five real verbs
  // (POST /shares, PATCH/DELETE /shares/:id, PATCH /nfs-profiles/:id, PATCH
  // /nfs-idmap) take precedence over the '/shares' + '/shares/:id' +
  // '/nfs-profiles/:id' stub registrations below; the verbs this router does
  // not register (e.g. PUT /shares/:id, PUT /nfs-profiles/:id — the full
  // replace stays stubbed) and every other resource still fall through
  // to the stubs.
  v1.use(nfsMutateRouter(ctx));

  // S3-xiraid: POST /arrays (xiraid.array.create) is real — mounted before
  // the stub loop, and POST /arrays is excluded from it below. PATCH/DELETE
  // /arrays/:id (modify/delete) stay stubbed until their plans land
  // (ADR-0006).
  v1.use(arraysRouter(ctx));

  // S5: POST /filesystems (fs.create) is real — mounted before the stub
  // loop; POST /filesystems is excluded from it below. PATCH/DELETE join
  // in T9-T11.
  v1.use(filesystemsRouter(ctx));

  // Remaining mutating verbs route to the executor-unavailable stub until
  // their executor ships. Per ADR-0002 §Agent heartbeat, plan and apply
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
  ];
  for (const route of mutatingRoutes) {
    // POST /arrays is the real S3 create/import route mounted above.
    if (route !== '/arrays' && route !== '/filesystems') v1.post(route, executorUnavailable(ctx));
    // PATCH + DELETE /arrays/:id are the real S4 modify/delete routes;
    // PATCH /filesystems/:id is the real S5 one-intent route.
    if (
      route !== '/arrays/:id' &&
      route !== '/filesystems/:id' &&
      // PATCH /network/interfaces/:id is the real S6 update route.
      route !== '/network/interfaces/:id'
    ) {
      v1.patch(route, executorUnavailable(ctx));
    }
    v1.put(route, executorUnavailable(ctx));
    // DELETE /arrays/:id (S4) and /filesystems/:id (S5 unmanage) are real.
    if (route !== '/arrays/:id' && route !== '/filesystems/:id') {
      v1.delete(route, executorUnavailable(ctx));
    }
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
