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
 * Auth middleware. Tries:
 *   1. Unix peer-creds (trust UDS connections as admin; the socket
 *      file's mode + ownership is the actual gate).
 *   2. Bearer token in Authorization header → config.tokens lookup.
 *
 * On match, fills req.context.principal + role and calls next().
 * On no match, responds 401 with PERMISSION_DENIED.
 */
export function authMiddleware(config: ApiConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.context;
    if (!ctx) {
      next(new Error('authMiddleware requires requestIdMiddleware to run first'));
      return;
    }

    // 1. Unix peer-creds (trust UDS as admin).
    if (isUnixSocketConnection(req)) {
      ctx.principal = 'local:uds';
      ctx.role = 'admin';
      next();
      return;
    }

    // 2. Bearer token.
    const authHeader = req.header('Authorization') ?? req.header('authorization');
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.slice(7).trim();
      const principal = config.tokens[token];
      if (principal) {
        ctx.principal = principal.principal;
        ctx.role = principal.role;
        next();
        return;
      }
    }

    const err = makeError(
      'PERMISSION_DENIED',
      'authentication required (bearer token or Unix peer-creds)',
    );
    res
      .status(errorStatus('PERMISSION_DENIED'))
      .json(
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
