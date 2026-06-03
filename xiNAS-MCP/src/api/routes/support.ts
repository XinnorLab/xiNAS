import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { executorUnavailable } from '../handlers/unsupported.js';

export function supportRouter(ctx: ApiContext): Router {
  const r = Router();
  r.post('/support-bundle', executorUnavailable(ctx));
  r.get('/support-bundle/:task_id', (_req, _res) => {
    throw new ApiException('NOT_FOUND', 'no bundle for that task');
  });
  return r;
}
