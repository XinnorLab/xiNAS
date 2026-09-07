import { Router } from 'express';
import { resolveConfirmationConfig } from '../config.js';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';
import type { ConfirmationService } from '../mcp/confirmation/service.js';
import type {
  ApprovalChannel,
  ConfirmationRecord,
  ConfirmationStatus,
} from '../mcp/confirmation/types.js';

/**
 * The operator approval surface over REST (S15 §9.1–9.2): the human-in-
 * the-loop half of MRTR confirmation. `xinasctl`'s approval commands are
 * thin wrappers over these same four routes (catalog entries
 * `mcp_confirmations.*`, admin-only, `mcp_exposed: false` — never an MCP
 * tool). Mounted on `/api/v1` next to `tasksRouter`.
 */

const STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'approved',
  'declined',
  'cancelled',
  'expired',
  'consumed',
]);

function requireConfirmations(ctx: ApiContext): ConfirmationService {
  if (ctx.mcpConfirmations === undefined) {
    throw new ApiException('INTERNAL', 'confirmation service is not available in this build', {
      code: 'EXECUTOR_UNAVAILABLE',
    });
  }
  return ctx.mcpConfirmations;
}

const iso = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString();

/** The api-v1 McpConfirmation view: ISO timestamps, no nonce hash. */
export function renderConfirmation(r: ConfirmationRecord): Record<string, unknown> {
  const { request_state_nonce_hash: _nonce, ...rest } = r;
  return {
    ...rest,
    created_at: iso(r.created_at),
    expires_at: iso(r.expires_at),
    approved_at: iso(r.approved_at),
    declined_at: iso(r.declined_at),
    consumed_at: iso(r.consumed_at),
  };
}

/**
 * The VERIFIED channel — from the auth verdict (S15 §9.2), never from a
 * header. Exported (F2a) so the `local:uds` -> `uds_break_glass` branch is
 * unit-tested directly, not only indirectly through a route.
 *
 * A11(g): the return type is the two channels an AUTH VERDICT can produce,
 * not the full `ApprovalChannel` union. `mcp_form` is written only by the
 * MCP client's own form-accept path (`store.consume`) and is never derived
 * from a credential — typing it in here forced a cast at the one call site
 * and made the impossible third case look reachable.
 */
export function channelOf(principal: string): Exclude<ApprovalChannel, 'mcp_form'> {
  return principal === 'local:uds' ? 'uds_break_glass' : 'bearer';
}

/** The UNTRUSTED UI label; stored for operators, consulted by no check. */
function interfaceOf(req: import('express').Request): 'web' | 'rest' {
  return req.header('x-xinas-approval-interface') === 'web' ? 'web' : 'rest';
}

export function mcpConfirmationsRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/mcp/confirmations', (req, res) => {
    const svc = requireConfirmations(ctx);
    const status = req.query.status;
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        "query param 'status' is not a confirmation status",
      );
    }
    const principalRaw = req.query.principal;
    // F9: a repeated query param (?principal=a&principal=b) parses as an
    // array — reject it rather than silently ignoring the filter.
    if (principalRaw !== undefined && typeof principalRaw !== 'string') {
      throw new ApiException('INVALID_ARGUMENT', "query param 'principal' must be a single value");
    }
    const principal = principalRaw;
    const limitRaw = req.query.limit;
    if (limitRaw !== undefined && typeof limitRaw !== 'string') {
      throw new ApiException('INVALID_ARGUMENT', "query param 'limit' must be a single value");
    }
    const limit = limitRaw === undefined ? 100 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ApiException('INVALID_ARGUMENT', "query param 'limit' must be in [1, 1000]");
    }
    const rows = svc.store.list({
      ...(status !== undefined ? { status: status as ConfirmationStatus } : {}),
      ...(principal !== undefined ? { principal } : {}),
      limit,
    });
    sendOk(req, res, rows.map(renderConfirmation));
  });

  r.get('/mcp/confirmations/:id', (req, res) => {
    const svc = requireConfirmations(ctx);
    const rc = req.context!;
    const view = svc.view(req.params.id, { principal: rc.principal, client_type: rc.client_type });
    if (view === null) throw new ApiException('NOT_FOUND', `no confirmation ${req.params.id}`);
    rc.operation_id = view.record.confirmation_id;
    sendOk(req, res, {
      ...renderConfirmation(view.record),
      plan: view.plan,
      summary: view.summary,
    });
  });

  for (const decision of ['approve', 'decline'] as const) {
    r.post(`/mcp/confirmations/:id/${decision}`, (req, res) => {
      const svc = requireConfirmations(ctx);
      const rc = req.context!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const channel = channelOf(rc.principal);
      const iface = interfaceOf(req);
      // S15 §9.3 defence in depth only: a request that labels itself as the
      // page must not arrive cross-origin. The label decides nothing else.
      // F4: compare as an ORIGIN (scheme + host + port), not a string
      // prefix — 'https://nas.example.co' is a STRING PREFIX MATCH of
      // 'https://nas.example.com' but a completely different origin.
      // `base` is the RESOLVED approval_url_base (trailing slash already
      // stripped by resolveConfirmationConfig), read fresh on every
      // request — never cached at startup.
      const origin = req.header('origin');
      const base = resolveConfirmationConfig(ctx.config).approval_url_base;
      if (
        iface === 'web' &&
        origin !== undefined &&
        base !== undefined &&
        new URL(base).origin !== origin
      ) {
        throw new ApiException('PERMISSION_DENIED', 'cross-origin approval request refused');
      }
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 512) : undefined;
      const acknowledge = typeof body.acknowledge === 'string' ? body.acknowledge : undefined;
      const record = svc.operatorDecide({
        id: req.params.id,
        decision,
        approver: { principal: rc.principal, role: rc.role },
        channel,
        interface: iface,
        ...(acknowledge !== undefined ? { acknowledge } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      rc.operation_id = record.confirmation_id;
      sendOk(req, res, renderConfirmation(record));
    });
  }

  return r;
}
