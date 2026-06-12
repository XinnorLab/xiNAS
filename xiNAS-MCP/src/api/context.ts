import type { LeaseManager, OpenedStateStore } from '../state/index.js';
import type { AgentRpcClient } from './agent-client.js';
import type { ApiConfig, Role } from './config.js';
import type { Warning } from './envelope.js';
import type { HeartbeatTracker } from './heartbeat.js';
import type { PlanEngine } from './plan/engine.js';
import type { TaskEngine } from './tasks/engine.js';
import type { TaskStore } from './tasks/store.js';
import type { TaskWatch } from './tasks/watch.js';

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
 * The S2 task-engine bundle: the plan/apply engines, the durable task
 * store, the lease manager, and the api→agent RPC client the mutating
 * routes (T4: POST /api/v1/reference) dispatch `task.begin` through.
 * Built once at startup from the SQLite handle + the agent socket and
 * hung off ApiContext so route factories reach it without re-deriving it
 * per request. Optional: absent in the read-only test contexts that never
 * mount a mutating engine route.
 */
export interface TaskEngines {
  planEngine: PlanEngine;
  taskEngine: TaskEngine;
  store: TaskStore;
  leases: LeaseManager;
  /** api→agent JSON-RPC client; undefined when no agent socket is configured. */
  agentClient?: AgentRpcClient;
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
  /** Optional; the S2 plan/apply/task engines (T4+). Absent in read-only contexts. */
  tasks?: TaskEngines;
  /**
   * Ephemeral in-process loopback bearer (S8 T4, ADR-0010): minted by
   * createApp, never persisted; the ONLY bearer under which the auth
   * middleware honors X-Xinas-Forwarded-* identity headers (the MCP
   * dispatcher's path back into the api).
   */
  loopback_token?: string;
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
  /**
   * Base directory the task_progress receiver (T5) spills oversized stage
   * output to (`<dir>/<task_id>/stage-<n>.log[.zst]`). Defaults to
   * `/var/log/xinas/tasks` in production; tests inject a temp dir so the
   * spill path is assertable and self-contained. Injectable here (not
   * hardcoded in the handler) per s2-task-envelope-spec §6 / T5.
   */
  taskProgressSpillDir?: string;
  /**
   * Resumable-SSE fan-out (s2-task-envelope-spec §10). Built in T8 by
   * server.ts / the test harness. The task_progress receiver (T5) calls
   * `notify` after applying each event so a live `/tasks/{id}/watch` stream
   * sees it; the watch route calls `subscribe` to attach a client. Optional
   * (guarded with `?.`) so the receiver and read-only contexts work without it.
   */
  taskWatch?: TaskWatch;
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
  client_type: 'rest' | 'mcp';
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
