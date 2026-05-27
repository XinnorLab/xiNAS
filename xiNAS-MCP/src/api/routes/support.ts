import { Router } from 'express';
import { ApiException } from '../errors.js';
import { executorUnavailable } from '../handlers/unsupported.js';
import type { ApiContext } from '../context.js';

export function supportRouter(_ctx: ApiContext): Router {
  const r = Router();
  r.post('/support-bundle', executorUnavailable);
  r.get('/support-bundle/:task_id', (_req, _res) => {
    throw new ApiException('NOT_FOUND', 'no bundle for that task');
  });
  return r;
}
