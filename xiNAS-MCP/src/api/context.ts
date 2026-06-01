import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig, Role } from './config.js';
import type { Warning } from './envelope.js';
import type { HeartbeatTracker } from './heartbeat.js';

/**
 * A compiled Ajv validator for one observed kind. The handler only
 * calls `validate(value)` and reads `validate.errors` on failure, so
 * the surface kept here is deliberately minimal — pulling Ajv's full
 * `ValidateFunction` generic into the context would couple every route
 * module to ajv. Wired (with the matching `ajv`) in a later task; until
 * then `observedSchemas` is undefined and validation is skipped.
 */
export interface ObservedValidateFn {
  (data: unknown): boolean;
  errors?: unknown;
}

/**
 * Shared per-process context. Built once at startup and passed into
 * createApp(); route modules receive it through their factory.
 */
export interface ApiContext {
  config: ApiConfig;
  state: OpenedStateStore;
  /** Optional; absent until HeartbeatTracker is wired (H1+). */
  tracker?: HeartbeatTracker;
  /**
   * Optional per-kind Ajv validators for inbound observation deltas
   * (wired in a later task — H6/J3). When present, the /internal/v1/observed
   * handler fail-closes: every upsert delta is validated against its kind's
   * schema before any write. When absent (the H3 unit context), validation
   * is skipped.
   */
  observedSchemas?: Record<string, ObservedValidateFn>;
  /** Companion to observedSchemas; renders an Ajv validator's errors as text. */
  ajv?: { errorsText(errors: unknown): string };
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
  /** Populated by systemWarningsMiddleware from HeartbeatTracker. */
  system_warnings: Warning[];
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
