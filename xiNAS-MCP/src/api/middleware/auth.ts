import type { Request, Response, NextFunction } from 'express';
import type { ApiConfig } from '../config.js';
import { buildEnvelope } from '../envelope.js';
import { errorStatus, makeError } from '../errors.js';

/**
 * Detect whether the request arrived over a Unix-domain socket.
 *
 * On UDS connections, Node's net.Socket reports `remoteAddress` as
 * undefined or empty (vs. a real IP for TCP).
 *
 * Trust model: the Unix socket file is created at startup with mode
 * 0660 owned by root:xinas-admin (see server.ts chmod). Anyone who
 * can connect to the socket has already passed the OS-level
 * permission check — they're either root or in the xinas-admin
 * group. We therefore promote UDS connections to admin without
 * SO_PEERCRED: the file system IS the auth gate. Same pattern
 * ADR-0002 uses for the agent socket.
 *
 * For TCP connections, this returns false and the request falls
 * through to bearer-token auth.
 */
function isUnixSocketConnection(req: Request): boolean {
  const sock = req.socket;
  if (!sock) return false;
  // UDS: no remoteAddress.
  if (sock.remoteAddress) return false;
  return true;
}

/**
 * Auth middleware. Resolves the request principal in this order:
 *
 *   1. Bearer token in Authorization header → config.tokens lookup.
 *      If a bearer header is present, the principal/role are taken
 *      from the token — even on a UDS connection. This prevents a
 *      viewer-token caller over UDS from getting silently promoted
 *      to admin. An unknown bearer is a hard 401 (we do NOT fall
 *      through to UDS trust — explicit-but-wrong creds are a worse
 *      signal than no creds). A token carrying `surface: 'mcp'` is
 *      refused here for the same reason (S15 §3.5): it is an MCP
 *      credential, and honouring it on REST would let its holder apply
 *      without the MRTR confirmation the /mcp path enforces.
 *
 *   2. Unix peer-creds. If no bearer header was sent AND the
 *      connection is UDS, trust the caller as admin. The socket
 *      file's mode + ownership (0o660 root:xinas-admin, set by
 *      server.ts chmod/chown) is the actual gate — anyone who got
 *      this far has already passed the OS-level permission check.
 *      Same trust-via-file-system pattern ADR-0002 uses for the
 *      agent socket.
 *
 *   3. Otherwise 401 PERMISSION_DENIED.
 */
export function authMiddleware(config: ApiConfig, getLoopbackToken?: () => string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.context;
    if (!ctx) {
      next(new Error('authMiddleware requires requestIdMiddleware to run first'));
      return;
    }

    const authHeader = req.header('Authorization') ?? req.header('authorization');
    const hasBearer = authHeader != null && authHeader.toLowerCase().startsWith('bearer ');

    // 0. Loopback identity forwarding (S8 T4, ADR-0010): ONLY under
    //    the process-ephemeral loopback bearer do the X-Xinas-Forwarded
    //    headers carry identity (the MCP dispatcher replaying a tool
    //    call). From any other caller they are ignored (warn-logged) —
    //    the request then authenticates normally.
    const fwdPrincipal = req.header('x-xinas-forwarded-principal');
    const fwdRole = req.header('x-xinas-forwarded-role');
    const fwdClient = req.header('x-xinas-client-type');
    const loopback = getLoopbackToken?.();
    if (hasBearer && loopback !== undefined && authHeader.slice(7).trim() === loopback) {
      if (
        typeof fwdPrincipal === 'string' &&
        fwdPrincipal.length > 0 &&
        (fwdRole === 'viewer' || fwdRole === 'operator' || fwdRole === 'admin')
      ) {
        ctx.principal = fwdPrincipal;
        ctx.role = fwdRole;
        if (fwdClient === 'mcp') ctx.client_type = 'mcp';
        const fwdConfirmation = req.header('x-xinas-confirmation');
        if (typeof fwdConfirmation === 'string' && fwdConfirmation.length > 0) {
          ctx.mcp_confirmation_id = fwdConfirmation;
        }
        next();
        return;
      }
      next(new Error('loopback request missing forwarded identity headers'));
      return;
    }
    if (
      fwdPrincipal !== undefined ||
      fwdRole !== undefined ||
      req.header('x-xinas-confirmation') !== undefined
    ) {
      console.warn(
        `auth: ignoring X-Xinas-Forwarded-*/X-Xinas-Confirmation headers from non-loopback caller (principal hint: ${fwdPrincipal ?? '?'})`,
      );
    }

    // 1. Bearer token wins, even on UDS.
    if (hasBearer) {
      const token = authHeader.slice(7).trim();
      const principal = config.tokens[token];
      if (principal) {
        // A1 (S15 §3.5, final review C1): a token scoped to the MCP
        // endpoint is not a REST credential. Without this, an agent
        // holding an "MCP" bearer applies over /api/v1 with no MRTR
        // confirmation at all — the gate would constrain only the path.
        // Refused outright: no fall-through to UDS trust (an
        // explicit-but-wrong-surface credential is the same class of
        // signal as an unknown bearer, §auth order above).
        if (principal.surface === 'mcp') {
          const scoped = makeError(
            'PERMISSION_DENIED',
            'this token is scoped to the MCP endpoint',
            { reason: 'token_surface', surface: 'mcp' },
          );
          res.status(errorStatus('PERMISSION_DENIED')).json(
            buildEnvelope({
              request_id: ctx.request_id,
              correlation_id: ctx.correlation_id,
              state_revision: 0,
              errors: [scoped],
              result: null,
            }),
          );
          return;
        }
        ctx.principal = principal.principal;
        ctx.role = principal.role;
        next();
        return;
      }
      // Unknown bearer: do not fall through to UDS trust.
    } else if (isUnixSocketConnection(req)) {
      // 2. UDS without bearer → trust as admin.
      ctx.principal = 'local:uds';
      ctx.role = 'admin';
      next();
      return;
    }

    const err = makeError(
      'PERMISSION_DENIED',
      hasBearer
        ? 'unknown bearer token'
        : 'authentication required (bearer token or Unix peer-creds)',
    );
    res.status(errorStatus('PERMISSION_DENIED')).json(
      buildEnvelope({
        request_id: ctx.request_id,
        correlation_id: ctx.correlation_id,
        state_revision: 0,
        errors: [err],
        result: null,
      }),
    );
  };
}
