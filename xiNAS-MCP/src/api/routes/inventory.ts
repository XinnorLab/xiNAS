import { Router } from 'express';
import { sendOk, getOrNull } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function inventoryRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/inventory', (req, res) => {
    const inv = getOrNull<Record<string, unknown>>(
      ctx.state,
      '/xinas/v1/observed/inventory/snapshot',
    );
    sendOk(
      req,
      res,
      inv?.value ?? { hardware: null, software: null, captured_at: null },
      inv ? [inv.revision] : [],
    );
  });
  return r;
}
