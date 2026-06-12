/**
 * Promoted legacy read routes (S8 T5, ADR-0010 §read-route promotion).
 *
 * The read-only tools the legacy MCP served from in-process adapters
 * become REAL /api/v1 routes on the one middleware spine — no second
 * audit/RBAC path. Every handler degrades to an empty result plus a
 * DEGRADED_BACKEND_UNAVAILABLE warning instead of failing, so the MCP
 * tools and xinasctl get honest structured behavior on hosts where a
 * backend is absent (no journal group yet, no quota mounts, xiRAID
 * daemon down).
 */

import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { type ReadSeams, createReadSeams } from '../handlers/read-seams.js';
import { listByPrefix, sendOk } from '../handlers/reads.js';

const DEGRADED = (what: string, hint: string) => ({
  code: 'DEGRADED_BACKEND_UNAVAILABLE',
  message: `${what} unavailable: ${hint}`,
});

const MAX_LOG_LINES = 2000;

/** Parse `repquota -a` block-quota lines into structured rows. */
export function parseRepquota(raw: string): Array<{
  name: string;
  block_used_kib: number;
  block_soft_kib: number;
  block_hard_kib: number;
}> {
  const rows: Array<{
    name: string;
    block_used_kib: number;
    block_soft_kib: number;
    block_hard_kib: number;
  }> = [];
  for (const line of raw.split('\n')) {
    const m = /^(\S+)\s+[-+]{2}\s+(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) {
      rows.push({
        name: m[1] as string,
        block_used_kib: Number(m[2]),
        block_soft_kib: Number(m[3]),
        block_hard_kib: Number(m[4]),
      });
    }
  }
  return rows;
}

export function promotedReadsRouter(ctx: ApiContext): Router {
  const r = Router();
  // Lazy per-request lookup: tests inject ctx.read_seams AFTER
  // createApp; production builds the default once on first use.
  let defaults: ReadSeams | undefined;
  const seamsOf = (): ReadSeams => {
    if (ctx.read_seams !== undefined) return ctx.read_seams;
    defaults ??= createReadSeams();
    return defaults;
  };

  r.get('/system/logs', async (req, res, next) => {
    try {
      const unit = typeof req.query.unit === 'string' ? req.query.unit : undefined;
      const lines = Math.min(
        Number.parseInt((req.query.lines as string | undefined) ?? '200', 10) || 200,
        MAX_LOG_LINES,
      );
      const out = await seamsOf().journalTail(unit, lines);
      if (out === null) {
        sendOk(
          req,
          res,
          { lines: [] },
          [],
          [DEGRADED('journal', 'journalctl failed — is the service user in systemd-journal?')],
        );
        return;
      }
      sendOk(req, res, { lines: out.split('\n').filter((l) => l.length > 0) });
    } catch (err) {
      next(err);
    }
  });

  r.get('/system/performance', async (req, res, next) => {
    try {
      const metrics = await seamsOf().prometheusMetrics();
      if (metrics === null) {
        sendOk(
          req,
          res,
          { available: false, metrics: null },
          [],
          [DEGRADED('performance metrics', 'the Prometheus exporter is unreachable')],
        );
        return;
      }
      sendOk(req, res, { available: true, metrics });
    } catch (err) {
      next(err);
    }
  });

  r.get('/quotas', async (req, res, next) => {
    try {
      const raw = await seamsOf().repquota();
      if (raw === null) {
        sendOk(
          req,
          res,
          { quotas: [] },
          [],
          [DEGRADED('quota report', 'repquota failed (may require privilege or quota mounts)')],
        );
        return;
      }
      sendOk(req, res, { quotas: parseRepquota(raw) });
    } catch (err) {
      next(err);
    }
  });

  const grpcRoute = (
    path: string,
    what: string,
    call: () => Promise<unknown | null>,
    key: string,
  ) => (
    r.get(path, async (req, res, next) => {
      try {
        const data = await call();
        if (data === null) {
          sendOk(
            req,
            res,
            { [key]: null },
            [],
            [DEGRADED(what, 'the xiRAID daemon is unreachable (deprecated read path, ADR-0010)')],
          );
          return;
        }
        sendOk(req, res, { [key]: data });
      } catch (err) {
        next(err);
      }
    }),
    undefined
  );

  // S9 T7 (ADR-0011): pools are first-class observed rows now — the
  // deprecated in-api gRPC pool read is RETIRED. referenced_by joins
  // the observed arrays' spare_pool names at read time.
  r.get('/pools', (req, res) => {
    const poolRows = listByPrefix<{ status?: Record<string, unknown> }>(
      ctx.state,
      '/xinas/v1/observed/Pool/',
    );
    const arrayRows = listByPrefix<{
      id?: string;
      status?: { spare_pool?: string };
    }>(ctx.state, '/xinas/v1/observed/XiraidArray/');
    const referencedBy = new Map<string, string[]>();
    for (const row of arrayRows) {
      const pool = row.value.status?.spare_pool;
      if (typeof pool === 'string' && pool.length > 0) {
        referencedBy.set(pool, [...(referencedBy.get(pool) ?? []), row.value.id ?? 'unknown']);
      }
    }
    sendOk(
      req,
      res,
      poolRows.map((row) => {
        const { observed_at: _dropped, ...fields } = row.value.status ?? {};
        const name = (fields.name as string) ?? '';
        return { ...fields, referenced_by: referencedBy.get(name) ?? [] };
      }),
      poolRows.map((row) => row.revision),
    );
  });

  grpcRoute('/mail/recipients', 'mail recipients', () => seamsOf().grpcMailShow(), 'recipients');
  grpcRoute('/mail/settings', 'mail settings', () => seamsOf().grpcSettingsMailShow(), 'settings');
  grpcRoute('/auth/modes', 'auth modes', () => seamsOf().grpcSettingsAuthShow(), 'modes');

  return r;
}
