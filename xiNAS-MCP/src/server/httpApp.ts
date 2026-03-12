/**
 * Shared Express application for SSE and Streamable HTTP transports.
 * Provides Bearer token authentication middleware.
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { resolveTokenRole } from '../config/serverConfig.js';
import type { Role } from '../types/common.js';

/** Extended request with resolved auth role. */
export interface AuthenticatedRequest extends Request {
  mcpRole?: Role;
  mcpPrincipal?: string;
}

/**
 * Create the shared Express app with JSON parsing and auth middleware.
 */
export function createHttpApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  return app;
}

/**
 * Extract Bearer token from Authorization header and resolve role.
 * No token → viewer role (safe default for remote connections).
 */
function authMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const role = resolveTokenRole(token);
    if (role) {
      req.mcpRole = role;
      req.mcpPrincipal = token;
    } else {
      // Unknown token — deny
      req.mcpRole = 'viewer';
      req.mcpPrincipal = 'unknown-token';
    }
  } else {
    // No auth header — default to viewer for remote
    req.mcpRole = 'viewer';
    req.mcpPrincipal = 'anonymous';
  }
  next();
}
