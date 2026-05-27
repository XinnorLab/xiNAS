import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig, Role } from './config.js';

/**
 * Shared per-process context. Built once at startup and passed into
 * createApp(); route modules receive it through their factory.
 */
export interface ApiContext {
  config: ApiConfig;
  state: OpenedStateStore;
}

/**
 * Per-request context. Populated by middleware (request-id, auth)
 * and consumed by route handlers and the audit middleware.
 */
export interface RequestContext {
  request_id: string;
  correlation_id: string;
  principal: string;
  role: Role;
  client_type: 'rest';
  /** Set by handlers when they want the audit row to carry an operation_id (e.g. for tasks). */
  operation_id?: string;
}

/**
 * Extension: attach RequestContext to Express's Request type so
 * handlers see req.context as typed without an ambient .locals dance.
 */
declare module 'express-serve-static-core' {
  interface Request {
    context?: RequestContext;
  }
}
