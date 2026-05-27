import express, { type Express, Router } from 'express';
import type { ApiContext } from './context.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { authMiddleware } from './middleware/auth.js';
import { auditMiddleware } from './middleware/audit.js';
import { errorMiddleware } from './middleware/error.js';
import { systemRouter } from './routes/system.js';

export function createApp(ctx: ApiContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware());
  app.use(authMiddleware(ctx.config));
  app.use(auditMiddleware(ctx.state));

  const v1 = Router();
  v1.use(systemRouter(ctx));
  app.use('/api/v1', v1);

  app.use(errorMiddleware());
  return app;
}
