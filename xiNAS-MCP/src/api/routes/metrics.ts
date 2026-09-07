/**
 * `GET /api/v1/metrics` — Prometheus text exposition of the process's
 * in-memory `MetricsRegistry` (S15 §12.2, Task 13). Mounted like every
 * other `/api/v1` route, so `rbacMiddleware` gates it against the catalog
 * entry `system.metrics` (`min_role: 'viewer'`) — no bespoke auth here.
 */

import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';

export function metricsRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/metrics', (_req, res) => {
    if (ctx.metrics === undefined) {
      throw new ApiException('INTERNAL', 'metrics registry not available');
    }
    // Never cached: every scrape must see the current in-memory state,
    // including the scrape-time (gaugeCollect) pending-confirmations gauge.
    res.setHeader('Cache-Control', 'no-store');
    // res.type(...).send(string) runs the body through Express's charset
    // helper, which REORDERS an already-present charset param ahead of
    // 'version=0.0.4' — set the header verbatim and end() a Buffer instead
    // so the exact 'text/plain; version=0.0.4; charset=utf-8' contract holds.
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(Buffer.from(ctx.metrics.render(), 'utf8'));
  });
  return r;
}
