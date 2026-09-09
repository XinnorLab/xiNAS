/**
 * REST RBAC enforcement (S8 T3, ADR-0010 review P0).
 *
 * Before this middleware the api RESOLVED `ctx.role` (auth) but never
 * ENFORCED it on public routes — retiring the legacy MCP's RBAC
 * without this would have removed the only role gate in the system.
 *
 * The authorization table IS the client catalog: the request
 * (method + path relative to the /api/v1 router) matches a
 * CatalogEntry whose `min_role` ranks against the resolved role
 * (viewer < operator < admin). Unmatched public routes default to
 * admin (deny-by-default for anything the catalog does not know —
 * e.g. the executorUnavailable stubs and /reference). `/internal/v1`
 * is mounted before this and keeps `requireInternalAgent`; the
 * `internal_agent` role is treated as admin-rank here so an agent
 * token is never weaker than the operators it serves.
 *
 * An entry may declare an `escalation` (S8 §3): when the request carries
 * that one argument value (query string on GET, parsed body otherwise),
 * the escalation's `min_role` ranks instead of the entry's — this is what
 * keeps `GET /health?profile=deep` (active probes) off a viewer token
 * while `quick`/`standard` stay viewer reads.
 *
 * Mounted on the /api/v1 router AFTER authMiddleware (and after
 * express.json, so a body-carried escalation is visible here).
 */

import type { NextFunction, Request, Response } from 'express';
import {
  type CatalogEntry,
  type MinRole,
  ROLE_RANK,
  isEscalated,
  matchCatalog,
} from '../mcp/catalog.js';
import { ApiException } from '../errors.js';

const ADMIN_RANK = ROLE_RANK.admin;

function rankOf(role: string): number {
  if (role === 'internal_agent') return ADMIN_RANK;
  return ROLE_RANK[role as keyof typeof ROLE_RANK] ?? -1;
}

/** The entry's rank, or its escalation's when the request carries the escalating value. */
function requiredRole(entry: CatalogEntry, req: Request): MinRole {
  const esc = entry.escalation;
  if (esc === undefined) return entry.min_role;
  const args = (req.method === 'GET' ? req.query : req.body) as Record<string, unknown> | undefined;
  return args !== undefined && isEscalated(entry, args) ? esc.min_role : entry.min_role;
}

export function rbacMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = req.context;
    if (ctx === undefined) {
      next(new ApiException('INTERNAL', 'request context missing before rbac'));
      return;
    }
    const entry = matchCatalog(req.method, req.path);
    const required = entry === undefined ? 'admin' : requiredRole(entry, req);
    if (rankOf(ctx.role) < ROLE_RANK[required]) {
      next(
        new ApiException(
          'PERMISSION_DENIED',
          `role '${ctx.role}' may not ${req.method} ${req.path} (requires ${required})`,
          { required_role: required, ...(entry !== undefined ? { operation: entry.name } : {}) },
        ),
      );
      return;
    }
    next();
  };
}
