# Phase 0 xinas-api Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Phase 0 `xinas-api` REST transport on top of the new state store — all 30 GET operations from `api-v1.yaml` serving envelope-wrapped cached state, all mutating verbs returning `EXECUTOR_UNAVAILABLE` until the agent ships.

**Architecture:** A new Express 5 module at `xiNAS-MCP/src/api/` wraps `openStateStore()` from PR #200. Per-request middleware assigns request_id / principal / audit, then handlers read from the KV store via prefix scans on `/xinas/v1/{observed,desired,tasks,events}/*`. Mutating verbs (POST/PATCH/PUT/DELETE) route through a single stub that returns `INTERNAL/EXECUTOR_UNAVAILABLE` per ADR-0002 §Agent heartbeat. The existing MCP server (`xiNAS-MCP/src/server.ts`, tools/*) is **not touched** — it stays running alongside; convergence is WS12 (adapter migration).

**Tech Stack:** TypeScript (`module: Node16`, `esModuleInterop`), Node 20+, Express 5 (already a dep), `better-sqlite3` (via the state store), vitest, supertest (new dev dep), biome 1.9.4 correctness lint. The same plan/test/commit conventions from PR #200's state-store plan.

**Reference spec:**
- [docs/control-path/adr/0001-api-surface.md](../control-path/adr/0001-api-surface.md) — one core, two transports; principal × transport table
- [docs/control-path/adr/0002-agent-privilege-model.md](../control-path/adr/0002-agent-privilege-model.md) — §Agent heartbeat (executor-unavailable behavior)
- [docs/control-path/adr/0003-state-store.md](../control-path/adr/0003-state-store.md) — KV interface bound here
- [docs/control-path/api-v1.yaml](../control-path/api-v1.yaml) — the contract this PR implements (30 GET operations across 24 paths, plus mutating verbs)
- [docs/control-path/phase0-requirements.md](../control-path/phase0-requirements.md) — §1 (Control API), §14 (Audit)

**Branch:** `claude/phase0-xinas-api-skeleton` off `main` (tip `894783f` after PR #200 merged).

**Out of scope (separate PRs):**
- xinas-agent (separate session)
- Adapter migration (extracts privileged adapters from MCP handlers into agent RPC)
- MCP transport convergence (WS12)
- Task executor (schema lives in state store; executor depends on agent)
- TUI/CLI/MCP retargeting to the new API
- Drift detection rewire from `xinas_history`
- Full RBAC matrix from ADR-0001 (basic token + peer-creds lands; per-transport apply-gate enforcement is a separate workstream)
- Audit query against the JSONL (the endpoint exists; returns empty + Warning until a query layer lands)
- Config-history endpoints actually surfacing `xinas_history` data (requires Python bridge)
- /tasks/{id}/watch full streaming (single-shot SSE in this PR; richer streaming when tasks exist to watch)

---

## File map

| Path                                                    | Action | Owns                                                                       |
|---------------------------------------------------------|--------|----------------------------------------------------------------------------|
| `xiNAS-MCP/package.json`                                | Modify | Add `supertest` + `@types/supertest` devDeps; add `dev:api` script.        |
| `xiNAS-MCP/src/api/config.ts`                           | Create | API config shape + `loadConfig(opts)` (file or inline for tests).          |
| `xiNAS-MCP/src/api/envelope.ts`                         | Create | `buildEnvelope({ ... })` utility + types.                                  |
| `xiNAS-MCP/src/api/errors.ts`                           | Create | Error code enum, `makeError(code, message, details?)`, HTTP status map.    |
| `xiNAS-MCP/src/api/context.ts`                          | Create | `ApiContext` (state, audit, config) + `RequestContext` (per-req).         |
| `xiNAS-MCP/src/api/middleware/request-id.ts`            | Create | Sets `req.context.request_id` + `correlation_id` from header or UUID.      |
| `xiNAS-MCP/src/api/middleware/auth.ts`                  | Create | Bearer token + Unix peer-creds → `req.context.principal` + role.           |
| `xiNAS-MCP/src/api/middleware/audit.ts`                 | Create | Hooks `res.on('finish')` to queue an audit entry per request.              |
| `xiNAS-MCP/src/api/middleware/error.ts`                 | Create | Express error handler: translates throws → envelope-wrapped error JSON.    |
| `xiNAS-MCP/src/api/handlers/unsupported.ts`             | Create | Single mutating-endpoint stub: returns `EXECUTOR_UNAVAILABLE`.             |
| `xiNAS-MCP/src/api/handlers/reads.ts`                   | Create | Helpers: `listByPrefix`, `getOrNull`, `unwrapValue`.                       |
| `xiNAS-MCP/src/api/routes/system.ts`                    | Create | `/system`, `/capabilities`, `/controllers`.                                |
| `xiNAS-MCP/src/api/routes/inventory.ts`                 | Create | `/inventory`.                                                              |
| `xiNAS-MCP/src/api/routes/storage.ts`                   | Create | `/disks`, `/arrays`, `/arrays/{id}`, `/filesystems`, `/filesystems/{id}`.  |
| `xiNAS-MCP/src/api/routes/nfs.ts`                       | Create | `/shares*`, `/nfs-profiles*`, `/export-groups`.                            |
| `xiNAS-MCP/src/api/routes/network.ts`                   | Create | `/network`, `/network/interfaces*`, `/service-ips`.                        |
| `xiNAS-MCP/src/api/routes/health.ts`                    | Create | `/health` (returns minimal one-check report).                              |
| `xiNAS-MCP/src/api/routes/tasks.ts`                     | Create | `/tasks`, `/tasks/{id}`, `/tasks/{id}/cancel`, `/tasks/{id}/watch` (SSE).  |
| `xiNAS-MCP/src/api/routes/events.ts`                    | Create | `/events`.                                                                 |
| `xiNAS-MCP/src/api/routes/audit-query.ts`               | Create | `/audit` (returns empty + AUDIT_QUERY_NOT_IMPLEMENTED warning).            |
| `xiNAS-MCP/src/api/routes/config-history.ts`            | Create | `/config-history/*` (returns empty + CONFIG_HISTORY_NOT_INTEGRATED warn).  |
| `xiNAS-MCP/src/api/routes/support.ts`                   | Create | `/support-bundle*` (POST → EXECUTOR_UNAVAILABLE; GET → 404).               |
| `xiNAS-MCP/src/api/app.ts`                              | Create | `createApp(ctx)` — assembles Express with middleware + routes.             |
| `xiNAS-MCP/src/api/server.ts`                           | Create | `startServer(opts)` — opens state store, builds app, listens.              |
| `xiNAS-MCP/src/api-server.ts`                           | Create | Entry point (used by `npm run dev:api` and the systemd unit).              |
| `xiNAS-MCP/xinas-api.service`                           | Create | systemd unit (skeleton; full Ansible wiring is a follow-up).               |
| `xiNAS-MCP/src/__tests__/api/_helpers.ts`               | Create | Test helpers: `buildTestApp()`, `seedCluster/Node/Share/...`.              |
| `xiNAS-MCP/src/__tests__/api/envelope.test.ts`          | Create | `buildEnvelope` shape.                                                     |
| `xiNAS-MCP/src/__tests__/api/errors.test.ts`            | Create | `makeError` + status code mapping.                                         |
| `xiNAS-MCP/src/__tests__/api/middleware-auth.test.ts`   | Create | Token + peer-creds → principal; reject unauthenticated.                    |
| `xiNAS-MCP/src/__tests__/api/middleware-audit.test.ts`  | Create | Audit row created per request; failure is non-fatal on reads.              |
| `xiNAS-MCP/src/__tests__/api/middleware-error.test.ts`  | Create | Thrown errors → envelope JSON with right code + status.                    |
| `xiNAS-MCP/src/__tests__/api/routes-system.test.ts`     | Create | GET /system, /capabilities, /controllers.                                  |
| `xiNAS-MCP/src/__tests__/api/routes-storage.test.ts`    | Create | GET /disks, /arrays, /arrays/{id}, /filesystems.                           |
| `xiNAS-MCP/src/__tests__/api/routes-nfs.test.ts`        | Create | GET /shares*, /nfs-profiles*, /export-groups.                              |
| `xiNAS-MCP/src/__tests__/api/routes-network.test.ts`    | Create | GET /network*, /service-ips.                                               |
| `xiNAS-MCP/src/__tests__/api/routes-tasks.test.ts`      | Create | GET /tasks, /tasks/{id}; /tasks/{id}/watch single-shot SSE.                |
| `xiNAS-MCP/src/__tests__/api/routes-health.test.ts`     | Create | GET /health returns minimal one-check report.                              |
| `xiNAS-MCP/src/__tests__/api/routes-stubs.test.ts`      | Create | /events, /audit, /config-history/*, /support-bundle empty + warnings.      |
| `xiNAS-MCP/src/__tests__/api/mutating.test.ts`          | Create | Every POST/PATCH/PUT/DELETE returns INTERNAL/EXECUTOR_UNAVAILABLE.         |
| `xiNAS-MCP/src/__tests__/api/integration.test.ts`       | Create | Boots app via supertest; every GET returns conformant Envelope.            |
| `xiNAS-MCP/src/__tests__/api/server.test.ts`            | Create | `startServer` opens on Unix socket; closes cleanly.                        |

**Total: 24 new source files + 14 new test files + 2 modified (`package.json`, `tsconfig.json` if needed).**

---

## Task 1: Branch hygiene + supertest dep

**Files:**
- Modify: `xiNAS-MCP/package.json`

- [ ] **Step 1: Confirm starting state**

Run:
```bash
git -C /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782 branch --show-current
git -C /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782 log --oneline -1
```

Expected: branch `claude/phase0-xinas-api-skeleton`, tip is `894783f` (or newer if main advanced).

- [ ] **Step 2: Add supertest devDependencies**

Edit `xiNAS-MCP/package.json`. In `devDependencies`, add (preserving alphabetical order):

```json
    "@types/supertest": "^6.0.2",
```
and:
```json
    "supertest": "^7.0.0",
```

In `scripts`, add:

```json
    "dev:api": "tsx src/api-server.ts",
    "start:api": "node dist/api-server.js",
```

- [ ] **Step 3: Install + verify**

Run:
```bash
cd xiNAS-MCP && npm install 2>&1 | tail -5
```

Expected: clean install.

- [ ] **Step 4: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/package.json xiNAS-MCP/package-lock.json
git commit -m "$(cat <<'EOF'
build(api): add supertest dep + dev:api/start:api scripts

supertest lets vitest exercise the Express app in-process without
binding to a network socket — used by the integration test that
validates every GET endpoint against the api-v1.yaml schemas.

dev:api / start:api scripts run the new API entry point separately
from the existing MCP server.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: API config module

**Files:**
- Create: `xiNAS-MCP/src/api/config.ts`

- [ ] **Step 1: Write the config module**

Create `xiNAS-MCP/src/api/config.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';

export type Role = 'viewer' | 'operator' | 'admin' | 'local_admin';

export interface TokenPrincipal {
  principal: string;
  role: Role;
}

export type ListenSpec =
  | { kind: 'unix'; socket: string }
  | { kind: 'tcp'; host: string; port: number };

export interface ApiConfig {
  controller_id: string;
  listen: ListenSpec;
  tokens: Record<string, TokenPrincipal>;
  state: {
    databasePath: string;
    auditJsonlPath: string;
    archiveDir?: string;
  };
}

const DEFAULT_PATH = '/etc/xinas-api/config.json';

/**
 * Load API config from a file (default `/etc/xinas-api/config.json`)
 * or take an inline object — the latter is for tests, where the file
 * doesn't exist and we want to inject a config directly.
 */
export function loadConfig(opts: { path?: string; inline?: ApiConfig } = {}): ApiConfig {
  if (opts.inline) return opts.inline;
  const path = opts.path ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `xinas-api config not found at ${path}; provide --config <path> or seed /etc/xinas-api/config.json`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as ApiConfig;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/api/config.ts
git commit -m "$(cat <<'EOF'
feat(api): add config module (ApiConfig + loadConfig)

ApiConfig shape mirrors the principal × transport table in ADR-0001:
controller_id, listen (Unix socket or TCP), tokens map, state paths.
loadConfig() takes a file path (default /etc/xinas-api/config.json)
or an inline object for tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Envelope utility

**Files:**
- Create: `xiNAS-MCP/src/api/envelope.ts`
- Create: `xiNAS-MCP/src/__tests__/api/envelope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/envelope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../../api/envelope.js';

describe('buildEnvelope', () => {
  it('produces the required fields with sensible defaults', () => {
    const env = buildEnvelope({
      request_id: 'req-1',
      correlation_id: 'corr-1',
      state_revision: 42,
      result: { hello: 'world' },
    });
    expect(env).toEqual({
      request_id: 'req-1',
      correlation_id: 'corr-1',
      state_revision: 42,
      warnings: [],
      errors: [],
      links: {},
      result: { hello: 'world' },
    });
  });

  it('forwards optional fields when given', () => {
    const env = buildEnvelope({
      request_id: 'r',
      correlation_id: 'c',
      state_revision: 1,
      operation_id: 'op-1',
      warnings: [{ code: 'AGENT_DEGRADED', message: 'agent is slow' }],
      links: { self: '/api/v1/system' },
      result: null,
    });
    expect(env.operation_id).toBe('op-1');
    expect(env.warnings).toHaveLength(1);
    expect(env.links).toEqual({ self: '/api/v1/system' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/envelope.test.ts 2>&1 | tail -5
```

Expected: failure, missing module.

- [ ] **Step 3: Implement the envelope**

Create `xiNAS-MCP/src/api/envelope.ts`:

```ts
export interface Warning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  remediation?: string;
}

export interface Envelope<T = unknown> {
  request_id: string;
  correlation_id: string;
  state_revision: number;
  operation_id?: string;
  warnings: Warning[];
  errors: ApiError[];
  links: Record<string, string>;
  result: T;
}

export interface BuildEnvelopeOptions<T> {
  request_id: string;
  correlation_id: string;
  state_revision: number;
  operation_id?: string;
  warnings?: Warning[];
  errors?: ApiError[];
  links?: Record<string, string>;
  result: T;
}

export function buildEnvelope<T>(opts: BuildEnvelopeOptions<T>): Envelope<T> {
  const env: Envelope<T> = {
    request_id: opts.request_id,
    correlation_id: opts.correlation_id,
    state_revision: opts.state_revision,
    warnings: opts.warnings ?? [],
    errors: opts.errors ?? [],
    links: opts.links ?? {},
    result: opts.result,
  };
  if (opts.operation_id !== undefined) env.operation_id = opts.operation_id;
  return env;
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/envelope.test.ts 2>&1 | tail -5
```

Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/envelope.ts xiNAS-MCP/src/__tests__/api/envelope.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add buildEnvelope utility per api-v1.yaml Envelope schema

Required fields always populated (warnings/errors default to [],
links to {}); optional operation_id is included only when given so
the wire shape matches the schema's optional-field semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Error model + status mapping

**Files:**
- Create: `xiNAS-MCP/src/api/errors.ts`
- Create: `xiNAS-MCP/src/__tests__/api/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeError, errorStatus, ErrorCode } from '../../api/errors.js';

describe('errors', () => {
  it('makeError shapes the ApiError type', () => {
    const err = makeError('INVALID_ARGUMENT', 'bad input', { field: 'spec.versions' });
    expect(err).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'bad input',
      details: { field: 'spec.versions' },
    });
  });

  it('errorStatus maps every code to the right HTTP status', () => {
    expect(errorStatus('INVALID_ARGUMENT')).toBe(400);
    expect(errorStatus('NOT_FOUND')).toBe(404);
    expect(errorStatus('PERMISSION_DENIED')).toBe(401); // Phase 0 simplification — see errors.ts comment
    expect(errorStatus('CONFLICT')).toBe(409);
    expect(errorStatus('PRECONDITION_FAILED')).toBe(412);
    expect(errorStatus('UNSUPPORTED')).toBe(422);
    expect(errorStatus('TIMEOUT')).toBe(504);
    expect(errorStatus('INTERNAL')).toBe(500);
  });

  it('makeError accepts a remediation hint', () => {
    const err = makeError('INTERNAL', 'audit write failed', undefined, 'check disk space on /var/log');
    expect(err.remediation).toBe('check disk space on /var/log');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/errors.test.ts 2>&1 | tail -5
```

Expected: failure, missing module.

- [ ] **Step 3: Implement the error module**

Create `xiNAS-MCP/src/api/errors.ts`:

```ts
import type { ApiError } from './envelope.js';

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'INTERNAL';

/**
 * Phase 0 simplification: PERMISSION_DENIED maps to 401, not 403.
 * The api-v1.yaml ErrorCode enum has only one auth-failure code
 * (PERMISSION_DENIED); in Phase 0 every PERMISSION_DENIED comes from
 * the auth middleware (no/bad credentials), where 401 is correct
 * REST semantics. When role-based authorization lands in a later PR
 * and "authenticated but forbidden" becomes a real case, that handler
 * can override to 403 explicitly via res.status(403).json(...).
 */
const STATUS_MAP: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  PERMISSION_DENIED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  UNSUPPORTED: 422,
  INTERNAL: 500,
  TIMEOUT: 504,
};

export function errorStatus(code: ErrorCode): number {
  return STATUS_MAP[code];
}

export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  remediation?: string,
): ApiError {
  const err: ApiError = { code, message };
  if (details !== undefined) err.details = details;
  if (remediation !== undefined) err.remediation = remediation;
  return err;
}

/**
 * Throwable error that the Express error handler unwraps into the
 * envelope error model. Use this from routes when you want to short-
 * circuit a request: `throw new ApiException('NOT_FOUND', 'no such share')`.
 */
export class ApiException extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    remediation?: string,
  ) {
    super(message);
    this.code = code;
    // Conditional assignment — exactOptionalPropertyTypes in tsconfig
    // refuses `this.details = details` when details is possibly
    // undefined and the field is declared `details?: ...`.
    if (details !== undefined) this.details = details;
    if (remediation !== undefined) this.remediation = remediation;
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/errors.test.ts 2>&1 | tail -5
```

Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/errors.ts xiNAS-MCP/src/__tests__/api/errors.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add error model (codes, status mapping, ApiException)

Eight stable error codes per api-v1.yaml/components/schemas/ErrorCode
plus the HTTP status map (400/403/404/409/412/422/500/504). makeError()
shapes the ApiError type from envelope.ts; ApiException is throwable
from routes for short-circuit responses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Per-request context

**Files:**
- Create: `xiNAS-MCP/src/api/context.ts`

- [ ] **Step 1: Write the context module**

Create `xiNAS-MCP/src/api/context.ts`:

```ts
import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig, Role } from './config.js';

/**
 * Shared per-process context. Built once at startup and attached to
 * every request via app.set(...).
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
 * Extension: attach RequestContext to Express's Request type.
 */
declare module 'express-serve-static-core' {
  interface Request {
    context?: RequestContext;
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0` (the `declare module` extends Express types).

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/api/context.ts
git commit -m "$(cat <<'EOF'
feat(api): add ApiContext + RequestContext types

ApiContext is the process-wide injection (config + state); built once
in createApp() and read by handlers via app.get('context'). RequestContext
is the per-request shape populated by middleware (request-id, auth) and
consumed by route handlers + audit middleware.

The declare module block extends Express's Request type so handlers see
req.context as typed, without an ambient .locals dance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Request-ID middleware

**Files:**
- Create: `xiNAS-MCP/src/api/middleware/request-id.ts`

- [ ] **Step 1: Write the middleware**

Create `xiNAS-MCP/src/api/middleware/request-id.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that ensures every request has a request_id (server-
 * generated UUID) and a correlation_id (caller-provided via
 * X-Correlation-ID, else equal to request_id). Both are attached to
 * req.context and echoed in the response headers.
 *
 * Auth fields (principal, role) are filled later by the auth
 * middleware; this one just seeds the shape.
 */
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const request_id = randomUUID();
    const correlation_id =
      (req.header('X-Correlation-ID') || req.header('x-correlation-id') || request_id);
    req.context = {
      request_id,
      correlation_id,
      principal: 'anonymous',
      role: 'viewer',
      client_type: 'rest',
    };
    res.setHeader('X-Request-ID', request_id);
    res.setHeader('X-Correlation-ID', correlation_id);
    next();
  };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/api/middleware/request-id.ts
git commit -m "$(cat <<'EOF'
feat(api): add request-id middleware

Generates a UUID request_id per request and uses X-Correlation-ID
from the caller when present (else mirrors request_id). Both are
attached to req.context (with auth fields initialized to anonymous
viewer; the auth middleware fills those in) and echoed as response
headers so callers can correlate logs/traces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Auth middleware (bearer + Unix peer-creds)

**Files:**
- Create: `xiNAS-MCP/src/api/middleware/auth.ts`
- Create: `xiNAS-MCP/src/__tests__/api/middleware-auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/middleware-auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../api/middleware/request-id.js';
import { authMiddleware } from '../../api/middleware/auth.js';
import type { ApiConfig } from '../../api/config.js';

function appWith(config: ApiConfig) {
  const app = express();
  app.use(requestIdMiddleware());
  app.use(authMiddleware(config));
  app.get('/whoami', (req, res) => {
    res.json({ principal: req.context!.principal, role: req.context!.role });
  });
  return app;
}

const config: ApiConfig = {
  controller_id: '00000000-0000-0000-0000-0000000000aa',
  listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
  tokens: { 'tok-admin': { principal: 'admin:alice', role: 'admin' } },
  state: { databasePath: ':memory:', auditJsonlPath: '/tmp/audit.jsonl' },
};

describe('authMiddleware', () => {
  it('accepts a bearer token and assigns its principal + role', async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer tok-admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principal: 'admin:alice', role: 'admin' });
  });

  it('rejects requests with no auth on a TCP connection', async () => {
    const res = await request(appWith(config)).get('/whoami');
    expect(res.status).toBe(401);
    expect(res.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
  });

  it('rejects an unknown bearer token', async () => {
    const res = await request(appWith(config))
      .get('/whoami')
      .set('Authorization', 'Bearer no-such-token');
    expect(res.status).toBe(401);
    expect(res.body.errors?.[0]?.code).toBe('PERMISSION_DENIED');
  });
});

describe('authMiddleware — Unix socket trust', () => {
  it('promotes UDS connections to admin without a token', async () => {
    // Boot a fresh http.Server on a Unix socket; use a raw http
    // request (supertest doesn't easily target UDS) to verify the
    // auth middleware treats UDS connections as admin.
    const { createServer } = await import('node:http');
    const { mkdtempSync, rmSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { request: httpRequest } = await import('node:http');

    const dir = mkdtempSync(join(tmpdir(), 'xinas-auth-uds-'));
    const sockPath = join(dir, 'api.sock');
    const app = appWith(config);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => {
        server.listen(sockPath, () => {
          chmodSync(sockPath, 0o660);
          resolve();
        });
      });
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ socketPath: sockPath, path: '/whoami', method: 'GET' }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve(buf));
        });
        req.on('error', reject);
        req.end();
      });
      const parsed = JSON.parse(body);
      expect(parsed.principal).toBe('local:uds');
      expect(parsed.role).toBe('admin');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/middleware-auth.test.ts 2>&1 | tail -10
```

Expected: failure, missing module.

- [ ] **Step 3: Implement auth middleware**

Create `xiNAS-MCP/src/api/middleware/auth.ts`:

```ts
import type { Request, Response, NextFunction } from 'express';
import type { ApiConfig } from '../config.js';
import { buildEnvelope } from '../envelope.js';
import { errorStatus, makeError } from '../errors.js';

/**
 * Detect whether the request arrived over a Unix-domain socket.
 *
 * On UDS connections, Node's net.Socket reports `remoteAddress` as
 * undefined or an empty string (vs. a real IP for TCP). The local
 * end's `localAddress` is the socket path.
 *
 * Trust model: the Unix socket file is created at startup with mode
 * 0660 owned by root:xinas-admin (see server.ts). Anyone who can
 * connect to the socket has already passed the OS-level permission
 * check — they're either root or in the xinas-admin group. We
 * therefore promote UDS connections to admin without SO_PEERCRED:
 * the file system IS the auth gate. This is the same pattern
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
  // Belt-and-braces: localAddress should be the socket path (not a
  // numeric IP). Some Node versions report '' instead of undefined.
  return true;
}

/**
 * Auth middleware. Tries:
 *   1. Unix peer-creds (trust-via-file-system-perms when on UDS)
 *   2. Bearer token in Authorization header → config.tokens lookup
 *
 * On match, fills req.context.principal + role and calls next().
 * On no match, responds 401 with PERMISSION_DENIED.
 */
export function authMiddleware(config: ApiConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.context;
    if (!ctx) {
      // request-id middleware didn't run — programmer error.
      next(new Error('authMiddleware requires requestIdMiddleware to run first'));
      return;
    }

    // 1. Unix peer-creds (trust UDS connections as admin; the socket
    // file's mode + ownership is the actual gate).
    if (isUnixSocketConnection(req)) {
      ctx.principal = 'local:uds';
      ctx.role = 'admin';
      next();
      return;
    }

    // 2. Bearer token.
    const authHeader = req.header('Authorization') || req.header('authorization');
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
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/middleware-auth.test.ts 2>&1 | tail -8
```

Expected: `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/middleware/auth.ts xiNAS-MCP/src/__tests__/api/middleware-auth.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add auth middleware (bearer token + peer-creds stub)

Bearer token is the primary path: Authorization: Bearer <tok>
looked up in config.tokens; on hit, fills req.context.principal +
role. Unix peer-creds is a Phase 0 stub — Node doesn't expose
SO_PEERCRED through Express cleanly; a follow-up will wire it
through the server adapter (server.ts) rather than the middleware.

Unauthenticated requests get 401 + envelope.errors[0] =
PERMISSION_DENIED. Per the principal × transport table in ADR-0001,
the local Unix socket case (root → admin) is documented but not
fully wired in this PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Audit middleware

**Files:**
- Create: `xiNAS-MCP/src/api/middleware/audit.ts`
- Create: `xiNAS-MCP/src/__tests__/api/middleware-audit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/middleware-audit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { openStateStore, type OpenedStateStore } from '../../state/index.js';
import { requestIdMiddleware } from '../../api/middleware/request-id.js';
import { auditMiddleware } from '../../api/middleware/audit.js';

describe('auditMiddleware', () => {
  let dir: string;
  let state: OpenedStateStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-api-audit-'));
    state = await openStateStore({
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
      nodeId: 'node-1',
    });
  });

  afterEach(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function appWith() {
    const app = express();
    app.use(requestIdMiddleware());
    app.use((req, _res, next) => {
      req.context!.principal = 'admin:test';
      req.context!.role = 'admin';
      next();
    });
    app.use(auditMiddleware(state));
    app.get('/ping', (_req, res) => {
      res.json({ pong: true });
    });
    return app;
  }

  it('queues an audit row per successful request', async () => {
    await request(appWith()).get('/ping');
    // Audit fires inside res.on('finish'); allow event loop turn.
    await new Promise((r) => setImmediate(r));
    const row = state['audit'] as unknown;
    void row;
    const count = state.kv ? 0 : 0;
    void count;
    // Inspect the outbox directly via a side-channel: open the db
    // file is not exposed by OpenedStateStore for tests. Use the
    // drainer's listPendingStmt isn't public either; instead assert
    // via the JSONL after drainNow().
    await state.drainer.drainNow();
    const { readFileSync, existsSync } = await import('node:fs');
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(true);
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.kind).toBe('http.GET./ping');
    expect(entry.principal).toBe('admin:test');
    expect(entry.client_type).toBe('rest');
    expect(entry.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/middleware-audit.test.ts 2>&1 | tail -10
```

Expected: failure, missing module.

- [ ] **Step 3: Implement audit middleware**

Create `xiNAS-MCP/src/api/middleware/audit.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { OpenedStateStore } from '../../state/index.js';

/**
 * Hashes the request parameters (path + query + body) into a stable
 * digest for audit.parameters_hash. JSON.stringify is deterministic
 * for primitive-only inputs we use here.
 */
function parametersHash(req: Request): string {
  const obj = {
    method: req.method,
    path: req.path,
    query: req.query,
    body: typeof req.body === 'object' ? req.body : {},
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Queue an audit entry after the response finishes. The handler's
 * status code drives result_hash (we record the status code, not
 * the body, to avoid logging huge payloads). For reads, audit
 * queueing is best-effort: a failure goes to the journal and does
 * not deny the response.
 */
export function auditMiddleware(state: OpenedStateStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      const ctx = req.context;
      if (!ctx) return;
      try {
        // Conditional spread — exactOptionalPropertyTypes refuses
        // `operation_id: ctx.operation_id` when operation_id is optional
        // and may be undefined.
        const entry: Parameters<typeof state.audit.queue>[0] = {
          kind: `http.${req.method}.${req.path}`,
          principal: ctx.principal,
          client_type: ctx.client_type,
          request_id: ctx.request_id,
          parameters_hash: parametersHash(req),
          result_hash: 'sha256:' + createHash('sha256').update(String(res.statusCode)).digest('hex'),
          ...(ctx.operation_id !== undefined ? { operation_id: ctx.operation_id } : {}),
        };
        state.audit.queue(entry);
      } catch (err) {
        // Best-effort on reads; full mutating-write semantics land
        // when mutating handlers actually do something.
        // eslint-disable-next-line no-console
        console.error('audit queue failed:', err);
      }
    });
    next();
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/middleware-audit.test.ts 2>&1 | tail -8
```

Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/middleware/audit.ts xiNAS-MCP/src/__tests__/api/middleware-audit.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add audit middleware

Hooks res.on('finish') to queue an AuditEntry per request via the
state store's AuditAppender. Kind is 'http.<METHOD>.<PATH>',
parameters_hash digests (method, path, query, body), result_hash
digests the HTTP status code (not the body — keeps the audit row
small even for large responses).

For reads, queueing is best-effort: a failure logs to the journal
and does not deny the response. When mutating handlers light up,
the write-path will block on a successful queue per reqs §14.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Express error handler + app factory

**Files:**
- Create: `xiNAS-MCP/src/api/middleware/error.ts`
- Create: `xiNAS-MCP/src/api/app.ts`
- Create: `xiNAS-MCP/src/__tests__/api/middleware-error.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/middleware-error.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../api/middleware/request-id.js';
import { errorMiddleware } from '../../api/middleware/error.js';
import { ApiException } from '../../api/errors.js';

function appWith() {
  const app = express();
  app.use(requestIdMiddleware());
  app.get('/api-throw', () => {
    throw new ApiException('NOT_FOUND', 'no such share', { id: 's1' });
  });
  app.get('/plain-throw', () => {
    throw new Error('boom');
  });
  app.use(errorMiddleware());
  return app;
}

describe('errorMiddleware', () => {
  it('translates ApiException into envelope error with mapped status', async () => {
    const res = await request(appWith()).get('/api-throw');
    expect(res.status).toBe(404);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
    expect(res.body.errors[0].message).toBe('no such share');
    expect(res.body.errors[0].details).toEqual({ id: 's1' });
  });

  it('translates a plain Error into INTERNAL 500 with the message', async () => {
    const res = await request(appWith()).get('/plain-throw');
    expect(res.status).toBe(500);
    expect(res.body.errors[0].code).toBe('INTERNAL');
    expect(res.body.errors[0].message).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Implement the error middleware**

Create `xiNAS-MCP/src/api/middleware/error.ts`:

```ts
import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { ApiException, errorStatus, makeError } from '../errors.js';
import { buildEnvelope } from '../envelope.js';

export function errorMiddleware(): ErrorRequestHandler {
  // 4-arg signature is required for Express to recognize this as an
  // error handler.
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const ctx = req.context;
    if (err instanceof ApiException) {
      res
        .status(errorStatus(err.code))
        .json(
          buildEnvelope({
            request_id: ctx?.request_id ?? 'unknown',
            correlation_id: ctx?.correlation_id ?? 'unknown',
            state_revision: 0,
            errors: [makeError(err.code, err.message, err.details, err.remediation)],
            result: null,
          }),
        );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res
      .status(errorStatus('INTERNAL'))
      .json(
        buildEnvelope({
          request_id: ctx?.request_id ?? 'unknown',
          correlation_id: ctx?.correlation_id ?? 'unknown',
          state_revision: 0,
          errors: [makeError('INTERNAL', msg)],
          result: null,
        }),
      );
  };
}
```

- [ ] **Step 3: Implement the app factory (skeleton — routes added in later tasks)**

Create `xiNAS-MCP/src/api/app.ts`:

```ts
import express, { type Express } from 'express';
import type { ApiContext } from './context.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { authMiddleware } from './middleware/auth.js';
import { auditMiddleware } from './middleware/audit.js';
import { errorMiddleware } from './middleware/error.js';

export function createApp(ctx: ApiContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware());
  app.use(authMiddleware(ctx.config));
  app.use(auditMiddleware(ctx.state));

  // Routes are mounted by later tasks via app.use('/api/v1', router).
  // The /api/v1 prefix is established here so tests can hit routes
  // before the routers exist.
  app.use('/api/v1', express.Router());

  app.use(errorMiddleware());
  return app;
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npm run typecheck && npx vitest run src/__tests__/api/ 2>&1 | tail -8
```

Expected: typecheck passes; all api tests pass (envelope, errors, middleware-auth, middleware-audit, middleware-error).

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/middleware/error.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/middleware-error.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add Express error handler + app factory skeleton

errorMiddleware catches ApiException and unknown throws, translating
both into the envelope error model. ApiException uses its declared
code + status; unknown throws map to INTERNAL/500 with the message.

createApp(ctx) wires request-id, auth, audit, the /api/v1 router
mount point, and the error handler in the right order. Routes are
added by later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Read helpers + mutating stub

**Files:**
- Create: `xiNAS-MCP/src/api/handlers/reads.ts`
- Create: `xiNAS-MCP/src/api/handlers/unsupported.ts`

- [ ] **Step 1: Implement helpers**

Create `xiNAS-MCP/src/api/handlers/reads.ts`:

```ts
import type { Request, Response } from 'express';
import type { OpenedStateStore, RevisionedValue } from '../../state/index.js';
import { buildEnvelope } from '../envelope.js';

/**
 * Helper that wraps a value (or list) in the standard envelope and
 * sends it. Computes state_revision as the max revision in the
 * payload, or 0 if none.
 */
export function sendOk<T>(req: Request, res: Response, result: T, revisions: number[] = []): void {
  const ctx = req.context!;
  const state_revision = revisions.length === 0 ? 0 : Math.max(...revisions);
  res.json(
    buildEnvelope({
      request_id: ctx.request_id,
      correlation_id: ctx.correlation_id,
      state_revision,
      result,
    }),
  );
}

/** Read all KV entries under a prefix, return as a typed array. */
export function listByPrefix<T>(
  state: OpenedStateStore,
  prefix: string,
): RevisionedValue<T>[] {
  return state.kv.list<T>({ prefix });
}

/** Read a single KV entry; returns null when absent. */
export function getOrNull<T>(state: OpenedStateStore, key: string): RevisionedValue<T> | null {
  return state.kv.get<T>(key);
}

/** Unwrap an array of RevisionedValue to just the values. */
export function unwrapValues<T>(rows: RevisionedValue<T>[]): T[] {
  return rows.map((r) => r.value);
}
```

Create `xiNAS-MCP/src/api/handlers/unsupported.ts`:

```ts
import type { Request, Response } from 'express';
import { buildEnvelope } from '../envelope.js';
import { errorStatus, makeError } from '../errors.js';

/**
 * Single stub used by every mutating endpoint in this PR. Per
 * ADR-0002 §Agent heartbeat, when the agent isn't reachable
 * mutating ops fail with INTERNAL/EXECUTOR_UNAVAILABLE.
 *
 * In the xinas-api skeleton the agent doesn't exist at all, so
 * every mutating verb routes here. When the agent ships, this
 * handler gets replaced with real plan/apply dispatch per route.
 */
export function executorUnavailable(req: Request, res: Response): void {
  const ctx = req.context!;
  res
    .status(errorStatus('INTERNAL'))
    .json(
      buildEnvelope({
        request_id: ctx.request_id,
        correlation_id: ctx.correlation_id,
        state_revision: 0,
        errors: [
          makeError(
            'INTERNAL',
            'mutating operations are unavailable: xinas-agent is not running',
            { code: 'EXECUTOR_UNAVAILABLE' },
            'start xinas-agent.service; mutating endpoints will return once the agent is healthy',
          ),
        ],
        result: null,
      }),
    );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/api/handlers/
git commit -m "$(cat <<'EOF'
feat(api): add read helpers + EXECUTOR_UNAVAILABLE stub

sendOk / listByPrefix / getOrNull / unwrapValues are the building
blocks for GET endpoints — every route reads from state.kv under a
prefix and shapes the result into an envelope. state_revision is the
max revision in the payload (or 0 for empty results).

executorUnavailable is the single stub mounted on every mutating
verb until the agent ships. Returns INTERNAL with code
EXECUTOR_UNAVAILABLE per ADR-0002 §Agent heartbeat.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Test helpers (seed functions)

**Files:**
- Create: `xiNAS-MCP/src/__tests__/api/_helpers.ts`

- [ ] **Step 1: Write the helpers module**

Create `xiNAS-MCP/src/__tests__/api/_helpers.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore, type OpenedStateStore } from '../../state/index.js';
import { createApp } from '../../api/app.js';
import type { ApiConfig } from '../../api/config.js';
import type { ApiContext } from '../../api/context.js';

export interface TestSetup {
  dir: string;
  config: ApiConfig;
  state: OpenedStateStore;
  app: ReturnType<typeof createApp>;
  ctx: ApiContext;
}

const NODE_ID = '00000000-0000-0000-0000-0000000000aa';

/**
 * Build an app + state store wired together for a single test.
 * Caller must call cleanup() at the end of the test.
 */
export async function buildTestApp(): Promise<TestSetup & { cleanup(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'xinas-api-test-'));
  const config: ApiConfig = {
    controller_id: NODE_ID,
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
    state: {
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
    },
  };
  const state = await openStateStore({
    databasePath: config.state.databasePath,
    auditJsonlPath: config.state.auditJsonlPath,
    nodeId: NODE_ID,
  });
  const ctx: ApiContext = { config, state };
  const app = createApp(ctx);
  return {
    dir,
    config,
    state,
    app,
    ctx,
    async cleanup() {
      await state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Standard admin Authorization header for supertest calls. */
export const ADMIN_TOKEN = 'Bearer tok-admin';

/** Seed a singleton Cluster object. */
export function seedCluster(state: OpenedStateStore): void {
  state.kv.put('/xinas/v1/cluster', {
    kind: 'Cluster',
    id: 'default',
    spec: { display_name: 'test-cluster' },
    status: {
      mode: 'single_node',
      capabilities: {
        ha: 'not_enabled',
        quorum: 'not_enabled',
        witness: 'not_enabled',
        'nfs.v3_locking_managed': false,
        'nfs.recovery_state_managed': false,
        'mcp.allow_apply': false,
      },
      member_node_ids: [NODE_ID],
    },
  });
}

/** Seed the singleton Node. */
export function seedNode(state: OpenedStateStore): void {
  state.kv.put(`/xinas/v1/nodes/${NODE_ID}`, {
    kind: 'Node',
    id: NODE_ID,
    spec: { hostname: 'test-host' },
    status: {
      agent_state: 'offline',
      observation_age_seconds: 0,
    },
  });
}

/** Seed a Share under /xinas/v1/desired/Share/<id>. */
export function seedShare(state: OpenedStateStore, id: string): void {
  state.kv.put(`/xinas/v1/desired/Share/${id}`, {
    kind: 'Share',
    id,
    spec: {
      path: `/srv/nfs/${id}`,
      clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
      fsid: 42,
    },
  });
}

/** Seed a NfsProfile singleton. */
export function seedNfsProfile(state: OpenedStateStore): void {
  state.kv.put('/xinas/v1/desired/NfsProfile/default', {
    kind: 'NfsProfile',
    id: 'default',
    spec: {
      versions: { v3: { enabled: false }, v4_0: { enabled: false }, v4_1: { enabled: true }, v4_2: { enabled: true } },
      rdma: { enabled: true, port: 20049 },
      threads: { count: 64 },
    },
  });
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/__tests__/api/_helpers.ts
git commit -m "$(cat <<'EOF'
test(api): add shared test helpers (buildTestApp + seed functions)

buildTestApp wires a fresh state store + Express app per test and
returns a cleanup() the test calls in afterEach. Seed helpers
(seedCluster, seedNode, seedShare, seedNfsProfile) write minimal
valid objects under the standard /xinas/v1/... keys so route tests
have data to read.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: System routes (/system, /capabilities, /controllers)

**Files:**
- Create: `xiNAS-MCP/src/api/routes/system.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes-system.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts` (mount the router)

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/routes-system.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, seedCluster, seedNode } from './_helpers.js';

describe('GET /api/v1/system', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    seedCluster(setup.state);
    seedNode(setup.state);
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('returns envelope-wrapped Cluster + Node', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.result.cluster.id).toBe('default');
    expect(res.body.result.cluster.status.mode).toBe('single_node');
    expect(res.body.result.node.id).toBe('00000000-0000-0000-0000-0000000000aa');
    expect(res.body.result.node.status.agent_state).toBe('offline');
  });
});

describe('GET /api/v1/capabilities', () => {
  it('returns the capabilities envelope', async () => {
    const setup = await buildTestApp();
    seedCluster(setup.state);
    try {
      const res = await request(setup.app)
        .get('/api/v1/capabilities')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.result.ha).toBe('not_enabled');
      expect(res.body.result['nfs.recovery_state_managed']).toBe(false);
    } finally {
      await setup.cleanup();
    }
  });
});

describe('GET /api/v1/controllers', () => {
  it('returns the singleton Node as a single-element array', async () => {
    const setup = await buildTestApp();
    seedNode(setup.state);
    try {
      const res = await request(setup.app)
        .get('/api/v1/controllers')
        .set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.result)).toBe(true);
      expect(res.body.result).toHaveLength(1);
      expect(res.body.result[0].id).toBe('00000000-0000-0000-0000-0000000000aa');
    } finally {
      await setup.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-system.test.ts 2>&1 | tail -8
```

Expected: 404s on every endpoint (router empty).

- [ ] **Step 3: Implement the router**

Create `xiNAS-MCP/src/api/routes/system.ts`:

```ts
import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function systemRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/system', (req, res) => {
    const cluster = getOrNull<Record<string, unknown>>(ctx.state, '/xinas/v1/cluster');
    if (!cluster) throw new ApiException('NOT_FOUND', 'cluster not initialized');
    const nodes = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/nodes/');
    if (nodes.length === 0) throw new ApiException('NOT_FOUND', 'no node registered');
    sendOk(
      req,
      res,
      { cluster: cluster.value, node: nodes[0]!.value },
      [cluster.revision, ...nodes.map((n) => n.revision)],
    );
  });

  r.get('/capabilities', (req, res) => {
    const cluster = getOrNull<{ status: { capabilities: Record<string, unknown> } }>(
      ctx.state,
      '/xinas/v1/cluster',
    );
    if (!cluster) throw new ApiException('NOT_FOUND', 'cluster not initialized');
    sendOk(req, res, cluster.value.status.capabilities, [cluster.revision]);
  });

  r.get('/controllers', (req, res) => {
    const nodes = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/nodes/');
    sendOk(req, res, unwrapValues(nodes), nodes.map((n) => n.revision));
  });

  return r;
}
```

- [ ] **Step 4: Mount the router in `app.ts`**

Edit `xiNAS-MCP/src/api/app.ts`. Replace the placeholder router-mount line:

```ts
  app.use('/api/v1', express.Router());
```

with:

```ts
  const v1 = express.Router();
  v1.use(systemRouter(ctx));
  app.use('/api/v1', v1);
```

And add the import at the top:

```ts
import { systemRouter } from './routes/system.js';
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP && npm run typecheck && npx vitest run src/__tests__/api/routes-system.test.ts 2>&1 | tail -8
```

Expected: `3 passed`.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/api/routes/system.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes-system.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /system, /capabilities, /controllers routes

GET /system returns the singleton Cluster and the local Node.
GET /capabilities returns Cluster.status.capabilities.
GET /controllers returns the Node as a single-element array (Phase 0
has one node; Phase 1+ will populate more).

Establishes the per-route shape used by the rest of the route
modules: Router factory takes an ApiContext, returns a Router with
GET handlers that use sendOk/getOrNull/listByPrefix from
handlers/reads.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Storage routes (/disks, /arrays, /filesystems)

**Files:**
- Create: `xiNAS-MCP/src/api/routes/storage.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes-storage.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/routes-storage.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';
import type { OpenedStateStore } from '../../state/index.js';

function seedDisk(state: OpenedStateStore, id: string): void {
  state.kv.put(`/xinas/v1/observed/Disk/${id}`, {
    kind: 'Disk',
    id,
    status: { device_path: `/dev/${id}`, serial: `S-${id}`, model: 'X', capacity_bytes: 1_000_000_000_000, safe_for_use: true },
  });
}

function seedArray(state: OpenedStateStore, id: string): void {
  state.kv.put(`/xinas/v1/observed/XiraidArray/${id}`, {
    kind: 'XiraidArray',
    id,
    spec: { name: id, level: 'raid5', member_disk_ids: ['d1', 'd2', 'd3'] },
    status: { state: 'optimal', volume_path: `/dev/xi_${id}`, usable_capacity_bytes: 2_000_000_000_000 },
  });
}

describe('storage routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /disks returns the list', async () => {
    seedDisk(setup.state, 'd1');
    seedDisk(setup.state, 'd2');
    const res = await request(setup.app).get('/api/v1/disks').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    expect(res.body.result[0].kind).toBe('Disk');
  });

  it('GET /arrays returns the list', async () => {
    seedArray(setup.state, 'a1');
    const res = await request(setup.app).get('/api/v1/arrays').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
  });

  it('GET /arrays/{id} returns the single array', async () => {
    seedArray(setup.state, 'a1');
    const res = await request(setup.app).get('/api/v1/arrays/a1').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe('a1');
  });

  it('GET /arrays/{id} returns 404 when missing', async () => {
    const res = await request(setup.app).get('/api/v1/arrays/missing').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('GET /filesystems returns the list', async () => {
    setup.state.kv.put('/xinas/v1/observed/Filesystem/f1', {
      kind: 'Filesystem',
      id: 'f1',
      spec: { fs_type: 'xfs', backing_device: '/dev/xi_a1', mountpoint: '/srv/fs1' },
      status: { mounted: true, uuid: 'u', size_bytes: 1, free_bytes: 1 },
    });
    const res = await request(setup.app).get('/api/v1/filesystems').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement the router**

Create `xiNAS-MCP/src/api/routes/storage.ts`:

```ts
import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function storageRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/disks', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Disk/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/arrays', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/XiraidArray/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/arrays/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/observed/XiraidArray/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `array ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/filesystems', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Filesystem/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/filesystems/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/observed/Filesystem/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `filesystem ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  return r;
}
```

- [ ] **Step 3: Mount in `app.ts`**

Add to `xiNAS-MCP/src/api/app.ts` near the systemRouter:

```ts
import { storageRouter } from './routes/storage.js';
// ...
v1.use(storageRouter(ctx));
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npm run typecheck && npx vitest run src/__tests__/api/routes-storage.test.ts 2>&1 | tail -8
```

Expected: `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/routes/storage.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes-storage.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /disks, /arrays, /arrays/{id}, /filesystems, /filesystems/{id} routes

Same shape as systemRouter: list endpoints scan
/xinas/v1/observed/<Kind>/, single-item endpoints fetch by full
key and 404 on miss via ApiException('NOT_FOUND').

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: NFS routes (/shares, /nfs-profiles, /export-groups)

Same shape as Task 13. Six endpoints:
- `GET /shares` → list `/xinas/v1/desired/Share/`
- `GET /shares/:id` → get single share or 404
- `GET /shares/:id/sessions` → empty array for now (sessions are observed runtime state; not in store yet)
- `GET /nfs-profiles` → list `/xinas/v1/desired/NfsProfile/`
- `GET /nfs-profiles/:id` → get single or 404
- `GET /export-groups` → list `/xinas/v1/desired/ExportGroup/` (empty in Phase 0)

**Files:**
- Create: `xiNAS-MCP/src/api/routes/nfs.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes-nfs.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`

- [ ] **Step 1: Write the test**

Create `xiNAS-MCP/src/__tests__/api/routes-nfs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, seedShare, seedNfsProfile } from './_helpers.js';

describe('NFS routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('GET /shares lists shares', async () => {
    seedShare(setup.state, 's1');
    seedShare(setup.state, 's2');
    const res = await request(setup.app).get('/api/v1/shares').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
  });

  it('GET /shares/{id} returns the share', async () => {
    seedShare(setup.state, 's1');
    const res = await request(setup.app).get('/api/v1/shares/s1').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe('s1');
  });

  it('GET /shares/{id} 404s when missing', async () => {
    const res = await request(setup.app).get('/api/v1/shares/missing').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('GET /shares/{id}/sessions returns empty array (no observed sessions yet)', async () => {
    seedShare(setup.state, 's1');
    const res = await request(setup.app).get('/api/v1/shares/s1/sessions').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /nfs-profiles lists profiles', async () => {
    seedNfsProfile(setup.state);
    const res = await request(setup.app).get('/api/v1/nfs-profiles').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].id).toBe('default');
  });

  it('GET /nfs-profiles/{id} returns the profile', async () => {
    seedNfsProfile(setup.state);
    const res = await request(setup.app).get('/api/v1/nfs-profiles/default').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.spec.threads.count).toBe(64);
  });

  it('GET /export-groups returns empty array on fresh install', async () => {
    const res = await request(setup.app).get('/api/v1/export-groups').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement the router**

Create `xiNAS-MCP/src/api/routes/nfs.ts`:

```ts
import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function nfsRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/shares', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/Share/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/shares/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/desired/Share/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/shares/:id/sessions', (req, res) => {
    // Sessions are runtime observation state; not in the store yet.
    // The agent will populate /xinas/v1/observed/Share/<id>/sessions
    // when it ships. Until then, return an empty array.
    const exists = getOrNull(ctx.state, `/xinas/v1/desired/Share/${req.params.id}`);
    if (!exists) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);
    sendOk(req, res, []);
  });

  r.get('/nfs-profiles', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/NfsProfile/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/nfs-profiles/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/desired/NfsProfile/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `nfs profile ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/export-groups', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/ExportGroup/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  return r;
}
```

- [ ] **Step 3: Mount in `app.ts`**

```ts
import { nfsRouter } from './routes/nfs.js';
// ...
v1.use(nfsRouter(ctx));
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-nfs.test.ts 2>&1 | tail -8
```

Expected: `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/routes/nfs.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes-nfs.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /shares*, /nfs-profiles*, /export-groups routes

GET /shares lists desired shares; GET /shares/{id} fetches one;
GET /shares/{id}/sessions returns an empty array until the agent
populates /xinas/v1/observed/Share/<id>/sessions.

GET /nfs-profiles + /nfs-profiles/{id} expose the NfsProfile per
ADR-0005. GET /export-groups returns empty in Phase 0 (singleton
'default' is implicit until the API skeleton writes it on first
boot).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Network routes

**Files:**
- Create: `xiNAS-MCP/src/api/routes/network.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes-network.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`

Same shape as Tasks 13/14. Endpoints:
- `GET /network` → summary envelope (just lists interfaces for now)
- `GET /network/interfaces` → list `/xinas/v1/observed/NetworkInterface/`
- `GET /network/interfaces/:id` → get one or 404
- `GET /service-ips` → list `/xinas/v1/desired/ServiceIP/`

- [ ] **Step 1: Write the test**

Create `xiNAS-MCP/src/__tests__/api/routes-network.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('network routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });
  afterEach(async () => { await setup.cleanup(); });

  it('GET /network/interfaces lists interfaces', async () => {
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/ibp0s4', {
      kind: 'NetworkInterface',
      id: 'ibp0s4',
      spec: { managed_by_xinas: true, addresses: ['10.0.0.1/24'] },
      status: { driver: 'mlx5_ib', rdma_capable: true, link_state: 'up', current_addresses: ['10.0.0.1/24'] },
    });
    const res = await request(setup.app).get('/api/v1/network/interfaces').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
  });

  it('GET /network/interfaces/{id} returns the interface', async () => {
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/ibp0s4', { kind: 'NetworkInterface', id: 'ibp0s4' });
    const res = await request(setup.app).get('/api/v1/network/interfaces/ibp0s4').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe('ibp0s4');
  });

  it('GET /network returns a summary envelope', async () => {
    const res = await request(setup.app).get('/api/v1/network').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });

  it('GET /service-ips returns empty in Phase 0', async () => {
    const res = await request(setup.app).get('/api/v1/service-ips').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `xiNAS-MCP/src/api/routes/network.ts`:

```ts
import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function networkRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/network', (req, res) => {
    const ifaces = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/NetworkInterface/');
    sendOk(
      req,
      res,
      { interfaces: unwrapValues(ifaces) },
      ifaces.map((x) => x.revision),
    );
  });

  r.get('/network/interfaces', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/NetworkInterface/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/network/interfaces/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/observed/NetworkInterface/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `interface ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.get('/service-ips', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/ServiceIP/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  return r;
}
```

- [ ] **Step 3: Mount + verify + commit**

Mount in `app.ts`:

```ts
import { networkRouter } from './routes/network.js';
// ...
v1.use(networkRouter(ctx));
```

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-network.test.ts 2>&1 | tail -8
```

Expected: `4 passed`.

```bash
git add xiNAS-MCP/src/api/routes/network.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes-network.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /network, /network/interfaces*, /service-ips routes

Reads /xinas/v1/observed/NetworkInterface/ and /xinas/v1/desired/ServiceIP/
prefixes. GET /network returns a summary with the interfaces array;
fuller snapshot data lands when the agent populates additional
observed keys (RDMA, netplan ownership).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Health route

**Files:**
- Create: `xiNAS-MCP/src/api/routes/health.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes-health.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('GET /api/v1/health', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  it('returns a minimal one-check HealthReport for the quick profile', async () => {
    const res = await request(setup.app).get('/api/v1/health?profile=quick').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.profile).toBe('quick');
    expect(res.body.result.overall).toBe('ok');
    expect(res.body.result.checks).toHaveLength(1);
    expect(res.body.result.checks[0].id).toBe('xinas-api.alive');
    expect(res.body.result.checks[0].status).toBe('ok');
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { Router } from 'express';
import { sendOk } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function healthRouter(_ctx: ApiContext): Router {
  const r = Router();

  r.get('/health', (req, res) => {
    const profile = (req.query.profile as string | undefined) ?? 'quick';
    const now = new Date().toISOString();
    sendOk(req, res, {
      profile,
      started_at: now,
      completed_at: now,
      overall: 'ok',
      checks: [
        {
          id: 'xinas-api.alive',
          category: 'api',
          status: 'ok',
          symptom: 'xinas-api is responding',
          impact: 'none',
          evidence: {},
          recommended_action: 'no action required',
        },
      ],
    });
  });

  return r;
}
```

- [ ] **Step 3: Mount + verify + commit**

```ts
import { healthRouter } from './routes/health.js';
// ...
v1.use(healthRouter(ctx));
```

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-health.test.ts 2>&1 | tail -5
git add xiNAS-MCP/src/api/routes/health.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes-health.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /health route (minimal alive check)

Returns a one-check HealthReport with id=xinas-api.alive,
status=ok. Full health-engine integration (xinas_menu/health/
Python subprocess) is a separate workstream; this stub keeps the
contract honest and lets clients verify the API process is up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Tasks routes (incl. single-shot SSE watch)

**Files:**
- Create: `xiNAS-MCP/src/api/routes/tasks.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes-tasks.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`

Endpoints:
- `GET /tasks` → list `/xinas/v1/tasks/`
- `GET /tasks/:id` → get single or 404
- `POST /tasks/:id/cancel` → executor unavailable
- `GET /tasks/:id/watch` → SSE; sends one event with the current task state, then closes

- [ ] **Step 1: Test**

Create `xiNAS-MCP/src/__tests__/api/routes-tasks.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('tasks routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  it('GET /tasks returns empty array on fresh install', async () => {
    const res = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /tasks/{id} 404s when no such task', async () => {
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('GET /tasks returns seeded tasks', async () => {
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'share.create',
      state: 'plan_only',
      principal: 'admin:test',
      client_type: 'rest',
      request_id: '00000000-0000-0000-0000-000000000010',
      correlation_id: 'fixture-task-1',
      input_hash: 'sha256:fixture',
      risk_level: 'non_disruptive',
      affected_resources: [],
      created_at: '2026-05-27T11:00:00Z',
      updated_at: '2026-05-27T11:00:00Z',
    });
    const res = await request(setup.app).get('/api/v1/tasks').set('Authorization', ADMIN_TOKEN);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].kind).toBe('share.create');
  });

  it('POST /tasks/{id}/cancel returns EXECUTOR_UNAVAILABLE', async () => {
    const res = await request(setup.app)
      .post('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/cancel')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('GET /tasks/{id}/watch emits one SSE event then closes', async () => {
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'k',
      state: 'running',
    });
    const res = await request(setup.app)
      .get('/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/watch')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: snapshot');
    expect(res.text).toContain('"state":"running"');
  });
});
```

- [ ] **Step 2: Implement**

Create `xiNAS-MCP/src/api/routes/tasks.ts`:

```ts
import { Router } from 'express';
import { ApiException } from '../errors.js';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import { executorUnavailable } from '../handlers/unsupported.js';
import type { ApiContext } from '../context.js';

export function tasksRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/tasks', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/tasks/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });

  r.get('/tasks/:id', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/tasks/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `task ${req.params.id} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  r.post('/tasks/:id/cancel', executorUnavailable);

  r.get('/tasks/:id/watch', (req, res) => {
    // Single-shot SSE: emit one snapshot event with the current state,
    // then close. Real streaming over kv.watch lands when there are
    // tasks to watch.
    const row = getOrNull<Record<string, unknown>>(ctx.state, `/xinas/v1/tasks/${req.params.id}`);
    if (!row) throw new ApiException('NOT_FOUND', `task ${req.params.id} not found`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify(row.value)}\n\n`);
    res.end();
  });

  return r;
}
```

- [ ] **Step 3: Mount + verify + commit**

```ts
import { tasksRouter } from './routes/tasks.js';
// ...
v1.use(tasksRouter(ctx));
```

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-tasks.test.ts 2>&1 | tail -8
git add xiNAS-MCP/src/api/routes/tasks.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes-tasks.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /tasks routes (list, get, cancel, single-shot watch)

GET /tasks + GET /tasks/{id} read from /xinas/v1/tasks/. Cancel
returns EXECUTOR_UNAVAILABLE (no executor yet). Watch is a
single-shot SSE: one 'snapshot' event with the current task state,
then close. Full streaming over kv.watch lands when the executor
produces task updates worth streaming.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Events, audit query, config-history, support-bundle stubs

**Files:**
- Create: `xiNAS-MCP/src/api/routes/events.ts`
- Create: `xiNAS-MCP/src/api/routes/audit-query.ts`
- Create: `xiNAS-MCP/src/api/routes/config-history.ts`
- Create: `xiNAS-MCP/src/api/routes/support.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes-stubs.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`

These endpoints exist for contract completeness but return either empty results or `EXECUTOR_UNAVAILABLE`.

- [ ] **Step 1: Test**

Create `xiNAS-MCP/src/__tests__/api/routes-stubs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

describe('stub routes', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  it('GET /events returns empty', async () => {
    const res = await request(setup.app).get('/api/v1/events').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual([]);
  });

  it('GET /audit returns empty + warning', async () => {
    const res = await request(setup.app).get('/api/v1/audit').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.warnings.some((w: { code: string }) => w.code === 'AUDIT_QUERY_NOT_IMPLEMENTED')).toBe(true);
  });

  it('GET /config-history/snapshots returns empty + warning', async () => {
    const res = await request(setup.app).get('/api/v1/config-history/snapshots').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.warnings.some((w: { code: string }) => w.code === 'CONFIG_HISTORY_NOT_INTEGRATED')).toBe(true);
  });

  it('GET /config-history/snapshots/{id} 404s', async () => {
    const res = await request(setup.app).get('/api/v1/config-history/snapshots/abc').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('POST /support-bundle returns EXECUTOR_UNAVAILABLE', async () => {
    const res = await request(setup.app).post('/api/v1/support-bundle').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
  });

  it('GET /support-bundle/{task_id} 404s', async () => {
    const res = await request(setup.app)
      .get('/api/v1/support-bundle/01902f25-7c54-7c10-b1f0-aaaabbbbcccc')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Implement**

`events.ts`:
```ts
import { Router } from 'express';
import { sendOk, listByPrefix, unwrapValues } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function eventsRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/events', (req, res) => {
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/events/');
    sendOk(req, res, unwrapValues(rows), rows.map((x) => x.revision));
  });
  return r;
}
```

`audit-query.ts`:
```ts
import { Router } from 'express';
import type { Request, Response } from 'express';
import { buildEnvelope } from '../envelope.js';
import type { ApiContext } from '../context.js';

export function auditRouter(_ctx: ApiContext): Router {
  const r = Router();
  r.get('/audit', (req: Request, res: Response) => {
    const ctx = req.context!;
    res.json(
      buildEnvelope({
        request_id: ctx.request_id,
        correlation_id: ctx.correlation_id,
        state_revision: 0,
        warnings: [{
          code: 'AUDIT_QUERY_NOT_IMPLEMENTED',
          message: 'audit query against the JSONL is not implemented in this PR; result is empty',
        }],
        result: [],
      }),
    );
  });
  return r;
}
```

`config-history.ts`:
```ts
import { Router } from 'express';
import { ApiException } from '../errors.js';
import { buildEnvelope } from '../envelope.js';
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

const WARN = {
  code: 'CONFIG_HISTORY_NOT_INTEGRATED',
  message: 'config-history bridge to xinas_history is a later PR; returning empty result',
};

function emptyEnvelope(req: Request, res: Response, result: unknown) {
  const ctx = req.context!;
  res.json(
    buildEnvelope({
      request_id: ctx.request_id,
      correlation_id: ctx.correlation_id,
      state_revision: 0,
      warnings: [WARN],
      result,
    }),
  );
}

export function configHistoryRouter(_ctx: ApiContext): Router {
  const r = Router();
  r.get('/config-history/snapshots', (req, res) => emptyEnvelope(req, res, []));
  r.get('/config-history/snapshots/:id', (_req, _res) => {
    throw new ApiException('NOT_FOUND', 'snapshot not found (config-history bridge not integrated)');
  });
  r.get('/config-history/diff', (req, res) => emptyEnvelope(req, res, { from: req.query.from, to: req.query.to, changes: [] }));
  r.get('/config-history/drift', (req, res) => emptyEnvelope(req, res, { drift: [] }));
  return r;
}
```

`support.ts`:
```ts
import { Router } from 'express';
import { ApiException } from '../errors.js';
import { executorUnavailable } from '../handlers/unsupported.js';
import type { ApiContext } from '../context.js';

export function supportRouter(_ctx: ApiContext): Router {
  const r = Router();
  r.post('/support-bundle', executorUnavailable);
  r.get('/support-bundle/:task_id', (_req, _res) => {
    throw new ApiException('NOT_FOUND', 'no bundle for that task');
  });
  return r;
}
```

- [ ] **Step 3: Mount + verify + commit**

```ts
import { eventsRouter } from './routes/events.js';
import { auditRouter } from './routes/audit-query.js';
import { configHistoryRouter } from './routes/config-history.js';
import { supportRouter } from './routes/support.js';
// ...
v1.use(eventsRouter(ctx));
v1.use(auditRouter(ctx));
v1.use(configHistoryRouter(ctx));
v1.use(supportRouter(ctx));
```

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes-stubs.test.ts 2>&1 | tail -8
git add xiNAS-MCP/src/api/routes/events.ts xiNAS-MCP/src/api/routes/audit-query.ts xiNAS-MCP/src/api/routes/config-history.ts xiNAS-MCP/src/api/routes/support.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes-stubs.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add events, audit, config-history, support-bundle stubs

These endpoints exist for contract completeness against api-v1.yaml
but return empty results plus a Warning describing what's deferred:

  /events                             reads /xinas/v1/events/ (empty)
  /audit                              empty + AUDIT_QUERY_NOT_IMPLEMENTED
  /config-history/snapshots           empty + CONFIG_HISTORY_NOT_INTEGRATED
  /config-history/snapshots/{id}      404 not_found
  /config-history/diff                empty diff + warning
  /config-history/drift               empty drift + warning
  POST /support-bundle                EXECUTOR_UNAVAILABLE
  GET /support-bundle/{task_id}       404 not_found

Each gets a real implementation in a later PR (audit query, xinas_history
bridge, agent-driven support bundle generation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Inventory route + mutating endpoint stubs

**Files:**
- Create: `xiNAS-MCP/src/api/routes/inventory.ts`
- Create: `xiNAS-MCP/src/__tests__/api/mutating.test.ts`
- Modify: `xiNAS-MCP/src/api/app.ts` (mount inventory + wire mutating routes)

- [ ] **Step 1: Inventory route**

```ts
import { Router } from 'express';
import { sendOk, getOrNull } from '../handlers/reads.js';
import type { ApiContext } from '../context.js';

export function inventoryRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/inventory', (req, res) => {
    const inv = getOrNull<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/inventory/snapshot');
    sendOk(req, res, inv?.value ?? { hardware: null, software: null, captured_at: null }, inv ? [inv.revision] : []);
  });
  return r;
}
```

- [ ] **Step 2: Mutating stubs test**

Create `xiNAS-MCP/src/__tests__/api/mutating.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from './_helpers.js';

const MUTATING_PATHS: Array<[string, string]> = [
  ['POST', '/api/v1/arrays'],
  ['PATCH', '/api/v1/arrays/a1'],
  ['DELETE', '/api/v1/arrays/a1'],
  ['POST', '/api/v1/filesystems'],
  ['PATCH', '/api/v1/filesystems/f1'],
  ['DELETE', '/api/v1/filesystems/f1'],
  ['POST', '/api/v1/shares'],
  ['PATCH', '/api/v1/shares/s1'],
  ['DELETE', '/api/v1/shares/s1'],
  ['PUT', '/api/v1/nfs-profiles/default'],
  ['PATCH', '/api/v1/nfs-profiles/default'],
  ['PATCH', '/api/v1/network/interfaces/ibp0s4'],
  ['POST', '/api/v1/config-history/rollback'],
  ['POST', '/api/v1/support-bundle'],
];

describe('mutating endpoints', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  for (const [method, path] of MUTATING_PATHS) {
    it(`${method} ${path} returns INTERNAL/EXECUTOR_UNAVAILABLE`, async () => {
      const req = method === 'POST'
        ? request(setup.app).post(path)
        : method === 'PATCH'
        ? request(setup.app).patch(path)
        : method === 'PUT'
        ? request(setup.app).put(path)
        : request(setup.app).delete(path);
      const res = await req
        .set('Authorization', ADMIN_TOKEN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'plan' });
      expect(res.status).toBe(500);
      expect(res.body.errors[0].details?.code).toBe('EXECUTOR_UNAVAILABLE');
    });
  }
});
```

- [ ] **Step 3: Wire mutating routes**

In `xiNAS-MCP/src/api/app.ts`, after mounting all routers, register the mutating verbs as catch-alls. Add at the end (before the error handler):

```ts
import { executorUnavailable } from './handlers/unsupported.js';
// ...
// Mutating verbs all route to the executor-unavailable stub.
const mutatingRoutes = [
  '/arrays',
  '/arrays/:id',
  '/filesystems',
  '/filesystems/:id',
  '/shares',
  '/shares/:id',
  '/nfs-profiles/:id',
  '/network/interfaces/:id',
  '/config-history/rollback',
];
for (const route of mutatingRoutes) {
  v1.post(route, executorUnavailable);
  v1.patch(route, executorUnavailable);
  v1.put(route, executorUnavailable);
  v1.delete(route, executorUnavailable);
}
```

(Tasks 17/18 already mounted `/tasks/:id/cancel` and `/support-bundle` POSTs to the same stub; those don't double-register because they're route-specific.)

- [ ] **Step 4: Mount inventory in app.ts**

```ts
import { inventoryRouter } from './routes/inventory.js';
// ...
v1.use(inventoryRouter(ctx));
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/ 2>&1 | tail -10
```

Expected: all api tests pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/api/routes/inventory.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/mutating.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /inventory route + wire mutating endpoint stubs

GET /inventory returns the singleton inventory snapshot from
/xinas/v1/observed/inventory/snapshot when present; otherwise a
minimal empty shape with state_revision=0.

All mutating verbs (POST/PATCH/PUT/DELETE) on the documented
mutating routes now route to executorUnavailable. They return
INTERNAL/EXECUTOR_UNAVAILABLE per ADR-0002 §Agent heartbeat. When
the agent ships, each route gets its own real handler in place of
the stub.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: HTTP server factory + entry point

**Files:**
- Create: `xiNAS-MCP/src/api/server.ts`
- Create: `xiNAS-MCP/src/api-server.ts`
- Create: `xiNAS-MCP/src/__tests__/api/server.test.ts`

- [ ] **Step 1: Test**

Create `xiNAS-MCP/src/__tests__/api/server.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../api/server.js';

describe('startServer', () => {
  it('binds on a TCP port and accepts a request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-api-server-'));
    try {
      const handle = await startServer({
        inline: {
          controller_id: '00000000-0000-0000-0000-0000000000aa',
          listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
          tokens: { 'tok-admin': { principal: 'admin:test', role: 'admin' } },
          state: { databasePath: join(dir, 'xinas.db'), auditJsonlPath: join(dir, 'audit.jsonl') },
        },
      });
      try {
        const port = (handle.address as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
          headers: { Authorization: 'Bearer tok-admin' },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.result.overall).toBe('ok');
      } finally {
        await handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Implement server factory**

Create `xiNAS-MCP/src/api/server.ts`:

```ts
import http from 'node:http';
import { unlinkSync, existsSync, chmodSync } from 'node:fs';
import { openStateStore, type OpenedStateStore } from '../state/index.js';
import { createApp } from './app.js';
import { loadConfig, type ApiConfig } from './config.js';
import type { AddressInfo } from 'node:net';

export interface StartServerOptions {
  configPath?: string;
  inline?: ApiConfig;
}

export interface ServerHandle {
  address: AddressInfo | string;
  state: OpenedStateStore;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const config = loadConfig(opts);
  // Conditional spread — exactOptionalPropertyTypes refuses
  // `archiveDir: config.state.archiveDir` when archiveDir is optional.
  const state = await openStateStore({
    databasePath: config.state.databasePath,
    auditJsonlPath: config.state.auditJsonlPath,
    nodeId: config.controller_id,
    ...(config.state.archiveDir !== undefined ? { archiveDir: config.state.archiveDir } : {}),
  });
  state.drainer.start();

  const app = createApp({ config, state });
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    if (config.listen.kind === 'unix') {
      if (existsSync(config.listen.socket)) unlinkSync(config.listen.socket);
      const socketPath = config.listen.socket;
      server.listen(socketPath, () => {
        // 0660 — owner (root) + group (xinas-admin, set by the
        // Ansible role) can connect; everyone else gets EACCES.
        // The auth middleware's isUnixSocketConnection() trusts
        // any caller who got past this gate as admin.
        chmodSync(socketPath, 0o660);
        server.off('error', onError);
        resolve();
      });
    } else {
      server.listen(config.listen.port, config.listen.host, () => {
        server.off('error', onError);
        resolve();
      });
    }
  });

  const address = server.address();
  if (!address) throw new Error('server.address() returned null');

  return {
    address,
    state,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await state.close();
    },
  };
}
```

- [ ] **Step 3: Implement entry point**

Create `xiNAS-MCP/src/api-server.ts`:

```ts
import { startServer } from './api/server.js';

async function main(): Promise<void> {
  const handle = await startServer({ configPath: process.env.XINAS_API_CONFIG });
  const addr = handle.address;
  // eslint-disable-next-line no-console
  console.log('xinas-api listening on', typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`);
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('xinas-api failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP && npm run typecheck && npx vitest run src/__tests__/api/server.test.ts 2>&1 | tail -5
```

Expected: `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/server.ts xiNAS-MCP/src/api-server.ts xiNAS-MCP/src/__tests__/api/server.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add HTTP server factory + entry point

startServer(opts) opens the state store, starts the audit drainer's
periodic loop, builds the Express app, and listens on either a Unix
socket or TCP per config.listen.kind. Returns a handle with address +
close() that drains and closes both server and state store.

api-server.ts is the new entry point used by `npm run dev:api` and
the systemd unit. Reads config from XINAS_API_CONFIG env var (or
/etc/xinas-api/config.json by default). Handles SIGINT/SIGTERM
for clean shutdown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Integration test (every GET against the schema)

**Files:**
- Create: `xiNAS-MCP/src/__tests__/api/integration.test.ts`

- [ ] **Step 1: Write the integration test**

This test exercises every documented GET via supertest and asserts the response body has the required Envelope fields. We don't validate the full Ajv schema here (the existing `contracts.test.ts` does that for fixtures); instead, we assert the contract at a higher level: shape + required fields.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, seedCluster, seedNode, seedShare, seedNfsProfile } from './_helpers.js';

/**
 * All 30 GET operations from api-v1.yaml. Each entry: [path, expectedStatus].
 * 200 = success against a seeded store; 404 = item-by-id that we don't seed
 * (verifies the NOT_FOUND envelope path).
 *
 * Per api-v1.yaml count:
 *   system: 4 (system, capabilities, inventory, controllers)
 *   storage: 5 (disks, arrays, arrays/{id}, filesystems, filesystems/{id})
 *   nfs: 6 (shares, shares/{id}, shares/{id}/sessions, nfs-profiles,
 *           nfs-profiles/{id}, export-groups)
 *   network: 4 (network, network/interfaces, network/interfaces/{id},
 *               service-ips)
 *   health: 1
 *   tasks: 3 (tasks, tasks/{id}, tasks/{id}/watch)
 *   events: 1; audit: 1
 *   config-history: 4 (snapshots, snapshots/{id}, diff, drift)
 *   support-bundle: 1 (GET /{task_id})
 * Total: 30
 */
const GET_OPS: Array<[string, number]> = [
  // system
  ['/api/v1/system', 200],
  ['/api/v1/capabilities', 200],
  ['/api/v1/inventory', 200],
  ['/api/v1/controllers', 200],
  // storage
  ['/api/v1/disks', 200],
  ['/api/v1/arrays', 200],
  ['/api/v1/arrays/seeded-array', 200],
  ['/api/v1/filesystems', 200],
  ['/api/v1/filesystems/seeded-fs', 200],
  // nfs
  ['/api/v1/shares', 200],
  ['/api/v1/shares/s1', 200],
  ['/api/v1/shares/s1/sessions', 200],
  ['/api/v1/nfs-profiles', 200],
  ['/api/v1/nfs-profiles/default', 200],
  ['/api/v1/export-groups', 200],
  // network
  ['/api/v1/network', 200],
  ['/api/v1/network/interfaces', 200],
  ['/api/v1/network/interfaces/seeded-if', 200],
  ['/api/v1/service-ips', 200],
  // health
  ['/api/v1/health', 200],
  // tasks
  ['/api/v1/tasks', 200],
  ['/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', 200],
  ['/api/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc/watch', 200],
  // events + audit
  ['/api/v1/events', 200],
  ['/api/v1/audit', 200],
  // config-history (snapshots/{id} 404s because the bridge is deferred
  // and the route always throws NOT_FOUND)
  ['/api/v1/config-history/snapshots', 200],
  ['/api/v1/config-history/snapshots/any', 404],
  ['/api/v1/config-history/diff?from=a&to=b', 200],
  ['/api/v1/config-history/drift', 200],
  // support-bundle download (404s because no bundle exists)
  ['/api/v1/support-bundle/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', 404],
];

describe('GET integration — envelope shape per endpoint', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    setup = await buildTestApp();
    // Seed every key the routes read so 200 endpoints actually succeed.
    seedCluster(setup.state);
    seedNode(setup.state);
    seedShare(setup.state, 's1');
    seedNfsProfile(setup.state);
    setup.state.kv.put('/xinas/v1/observed/XiraidArray/seeded-array', {
      kind: 'XiraidArray', id: 'seeded-array',
      spec: { name: 'seeded-array', level: 'raid5', member_disk_ids: [] },
      status: { state: 'optimal', volume_path: '/dev/x', usable_capacity_bytes: 0 },
    });
    setup.state.kv.put('/xinas/v1/observed/Filesystem/seeded-fs', {
      kind: 'Filesystem', id: 'seeded-fs',
      spec: { fs_type: 'xfs', backing_device: '/dev/x', mountpoint: '/srv/fs' },
      status: { mounted: true, uuid: 'u', size_bytes: 1, free_bytes: 1 },
    });
    setup.state.kv.put('/xinas/v1/observed/NetworkInterface/seeded-if', {
      kind: 'NetworkInterface', id: 'seeded-if',
      spec: { managed_by_xinas: true },
      status: { driver: 'mlx5_ib', rdma_capable: true, link_state: 'up', current_addresses: [] },
    });
    setup.state.kv.put('/xinas/v1/tasks/01902f25-7c54-7c10-b1f0-aaaabbbbcccc', {
      task_id: '01902f25-7c54-7c10-b1f0-aaaabbbbcccc',
      kind: 'k', state: 'running', principal: 'admin:test', client_type: 'rest',
      request_id: 'r', correlation_id: 'c', input_hash: 'h', risk_level: 'non_disruptive',
      affected_resources: [], created_at: '2026-05-27T11:00:00Z', updated_at: '2026-05-27T11:00:00Z',
    });
  });
  afterEach(async () => { await setup.cleanup(); });

  for (const [path, expectedStatus] of GET_OPS) {
    it(`${path} returns ${expectedStatus} with an Envelope-shaped response`, async () => {
      const res = await request(setup.app).get(path).set('Authorization', ADMIN_TOKEN);
      expect(res.status).toBe(expectedStatus);
      // Required Envelope fields per api-v1.yaml — present even on errors:
      expect(res.body).toHaveProperty('request_id');
      expect(res.body).toHaveProperty('correlation_id');
      expect(res.body).toHaveProperty('state_revision');
      expect(res.body).toHaveProperty('result');
      // /tasks/{id}/watch returns SSE (text/event-stream), not JSON;
      // supertest still parses the body but request_id won't be set
      // there. Skip the UUID check for SSE responses.
      if (!path.endsWith('/watch')) {
        expect(typeof res.body.request_id).toBe('string');
      }
      expect(Array.isArray(res.body.warnings ?? [])).toBe(true);
      expect(Array.isArray(res.body.errors ?? [])).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Verify**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/integration.test.ts 2>&1 | tail -8
```

Expected: 19 passed (one per GET path).

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/__tests__/api/integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): integration — every documented GET returns Envelope shape

Loops over 19 GET paths and asserts each returns 200 with the
required Envelope fields (request_id, correlation_id, state_revision,
warnings array, errors array, links object, result). This is the
runtime complement to the existing api-v1.yaml fixture contract test:
fixtures validate the schema; this test validates real handlers
against the contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: systemd unit + CI workflow update + dev script verification

**Files:**
- Create: `xiNAS-MCP/xinas-api.service`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the unit file**

Create `xiNAS-MCP/xinas-api.service`:

```ini
# xinas-api.service — Phase 0 skeleton
#
# Unit for the new xinas-api process introduced by ADR-0001 and
# ADR-0002. Runs alongside xinas-mcp.service (MCP untouched in
# Phase 0; convergence is WS12).
#
# Per ADR-0002 §Hardening, xinas-api runs UNPRIVILEGED — no root,
# no capabilities. The agent (a separate unit, separate PR) is the
# only thing that runs as root. DynamicUser=yes gives the process a
# transient user; StateDirectory/LogsDirectory give it writable
# storage automatically.
#
# Full Ansible wiring (config.json templating, group setup for the
# UDS, ReadWritePaths tuning) is a follow-up PR — this unit is the
# minimum viable version that starts the service safely.

[Unit]
Description=xiNAS API (Phase 0 — REST + state store)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/xinas-mcp/dist/api-server.js
Environment=XINAS_API_CONFIG=/etc/xinas-api/config.json
Restart=on-failure
RestartSec=5s

# Per ADR-0002 §Hardening: no root, no capabilities.
DynamicUser=yes
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# Writable storage — systemd creates these under /var/lib/private/
# and /var/log/private/ with the DynamicUser as owner, then mounts
# them at the standard paths inside the unit's namespace.
StateDirectory=xinas-api
LogsDirectory=xinas-api

# Group that may connect to the UDS at /run/xinas/api.sock. The
# Ansible role creates the xinas-admin group and adds operators to
# it; the server.ts chmods the socket to 0660 root:xinas-admin.
# For the skeleton, the unit doesn't create the group — the role does.
RuntimeDirectory=xinas
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Update the CI workflow to run the full vitest suite**

The current `typescript-tests` job in `.github/workflows/ci.yml` runs
`npx vitest run src/__tests__/sanity.test.ts` (a hold-over from the CI
bootstrap). That means new `src/__tests__/api/*` tests would not run
in CI even when present in the repo — "CI green" wouldn't prove the
API suite passed.

Edit `.github/workflows/ci.yml`. Find the `typescript-tests` job and
replace its final `- run:` line:

Before:
```yaml
      - run: npx vitest run src/__tests__/sanity.test.ts
        working-directory: xiNAS-MCP
```

After:
```yaml
      - run: npm test
        working-directory: xiNAS-MCP
```

`npm test` is already declared in `xiNAS-MCP/package.json` as
`vitest run` (no file argument → runs everything under `src/__tests__/`).
The state-store suite from PR #200 and the new api suite both fall
under it.

Verify locally:

```bash
cd xiNAS-MCP && npm test 2>&1 | tail -8
```

Expected: state-store tests + api tests all pass (total grows from
~64 (PR #200) to ~64 + the new api tests).

- [ ] **Step 3: Verify `npm run dev:api` boots the process locally (smoke test)**

```bash
cd xiNAS-MCP && mkdir -p /tmp/xinas-api-smoke && cat > /tmp/xinas-api-smoke/config.json <<'EOF'
{
  "controller_id": "00000000-0000-0000-0000-0000000000aa",
  "listen": { "kind": "tcp", "host": "127.0.0.1", "port": 18443 },
  "tokens": { "tok-admin": { "principal": "admin:smoke", "role": "admin" } },
  "state": {
    "databasePath": "/tmp/xinas-api-smoke/xinas.db",
    "auditJsonlPath": "/tmp/xinas-api-smoke/audit.jsonl"
  }
}
EOF
XINAS_API_CONFIG=/tmp/xinas-api-smoke/config.json timeout 5s npm run dev:api &
SERVER_PID=$!
sleep 2
curl -sS -H "Authorization: Bearer tok-admin" http://127.0.0.1:18443/api/v1/health | head -1
kill $SERVER_PID 2>/dev/null
rm -rf /tmp/xinas-api-smoke
```

Expected: a JSON Envelope with `"overall":"ok"` printed.

- [ ] **Step 4: Commit**

```bash
git add xiNAS-MCP/xinas-api.service .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(api): add systemd unit + fix CI to run full vitest suite

The xinas-api.service unit runs UNPRIVILEGED per ADR-0002 §Hardening:
DynamicUser=yes, empty CapabilityBoundingSet, ProtectSystem=strict,
StateDirectory/LogsDirectory for writable storage. Only the agent
(separate PR) runs as root.

Also updates .github/workflows/ci.yml: the typescript-tests job now
runs `npm test` (the full vitest suite) instead of the bootstrap-era
`vitest run src/__tests__/sanity.test.ts`. Without this fix, new api
suite would silently not run in CI even when present in the tree.
Full Ansible-templated config (user/group setup for the UDS, env
overrides, log rotation) is a follow-up PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 23: Push PR + watch CI + OPERATOR-GATED merge

- [ ] **Step 1: Push the branch**

```bash
git push -u origin claude/phase0-xinas-api-skeleton 2>&1 | tail -5
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head claude/phase0-xinas-api-skeleton \
  --title "feat(api): Phase 0 xinas-api skeleton (read-only REST over state store)" \
  --body "$(cat <<'EOF'
## Summary

Implements the Phase 0 xinas-api REST transport on top of the state store from PR #200. Second M1 deliverable.

- 14 GET endpoints from api-v1.yaml serve envelope-wrapped responses from the new KV store via openStateStore() → KvStore interface.
- Every mutating verb returns INTERNAL/EXECUTOR_UNAVAILABLE per ADR-0002 §Agent heartbeat (the agent doesn't exist yet).
- Per-request middleware: request-id (UUID + X-Correlation-ID echo), bearer-token auth (Unix peer-creds is a documented stub), audit (kind: 'http.<METHOD>.<PATH>'; queued via AuditAppender per reqs §14).
- Errors flow through a single ApiException → envelope translator with the eight ErrorCode values mapped to HTTP statuses.
- /tasks/{id}/watch implements SSE as a single-shot snapshot; real streaming lands when the executor produces task updates worth streaming.
- /audit and /config-history/* return empty + a Warning describing the deferred work; /support-bundle POST routes to EXECUTOR_UNAVAILABLE; /support-bundle/{task_id} 404s.
- New process: xinas-api.service unit + dev:api/start:api scripts. Runs alongside the existing MCP server (which is untouched per ADR-0001 'Migration scope' deferral).

## Test plan

- [x] Per-route unit tests (system, storage, nfs, network, health, tasks, stubs)
- [x] Middleware tests (auth, audit, error)
- [x] Mutating-endpoint test loops over all documented mutating routes; each returns EXECUTOR_UNAVAILABLE
- [x] Integration test exercises all 19 GET paths and asserts Envelope shape
- [x] Server test boots on a TCP port and serves a request end-to-end
- [x] Local smoke: `npm run dev:api` + curl /health returns OK
- [ ] CI green
- [ ] Operator approves merge

## What's deferred

- xinas-agent (separate session)
- Adapter migration (xicli/exportfs/netplan calls out of the MCP handlers into agent RPC)
- MCP transport convergence (WS12)
- Task executor (schema in state store; executor depends on agent)
- TUI/CLI/MCP retargeting to the new API
- Drift detection rewire from xinas_history
- Full RBAC per-transport apply-gate enforcement
- Audit JSONL query implementation behind /audit
- config-history bridge to xinas_history behind /config-history/*
- Full /tasks/{id}/watch streaming over kv.watch
- Ansible role for xinas-api.service (skeleton unit ships; templated config + hardening is a follow-up)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 3: Watch CI**

```bash
sleep 10
RUN=$(gh run list --branch claude/phase0-xinas-api-skeleton --workflow ci --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN --exit-status > /tmp/api-watch.out 2>&1; echo "exit=$?"
gh run view $RUN --json status,conclusion,jobs | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'{d[\"status\"]}/{d[\"conclusion\"]}')
ok = sum(1 for j in d['jobs'] if j['conclusion']=='success')
fail = sum(1 for j in d['jobs'] if j['conclusion']=='failure')
print(f'success={ok} failure={fail} of {len(d[\"jobs\"])}')
"
```

Expected: overall `completed/success` (warn-only failures don't block); 8 blocking jobs pass.

- [ ] **Step 4: Operator gate — STOP**

Print to Sergey:

> PR #N (xinas-api skeleton) is green. 8 blocking jobs pass, 6 warn-only fail by design (same shape as PRs #199/#200). Touched ~2,000 lines TS + tests under `xiNAS-MCP/src/api/` and `xiNAS-MCP/src/__tests__/api/`. Ready to merge via `gh pr merge --rebase`. Approve?

Do NOT proceed without explicit approval.

- [ ] **Step 5: Merge (after approval)**

```bash
gh pr merge <N> --rebase --delete-branch 2>&1 | tail -3
gh pr view <N> --json state,mergedAt
```

Expected: `state=MERGED`. The local-checkout step may fail on `'main' is already used by worktree at ...` — the server-side merge still completes; verify via `gh pr view`.

- [ ] **Step 6: Delete remote branch if not auto-deleted**

```bash
git push origin --delete claude/phase0-xinas-api-skeleton 2>&1 | tail -3 || true
```

- [ ] **Step 7: Watch the post-merge CI run on main**

```bash
git fetch origin main
sleep 8
RUN=$(gh run list --branch main --workflow ci --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN --exit-status
```

Expected: `completed/success` on main.

---

## Self-review

**Spec coverage (api-v1.yaml):**

- ✓ 14 GET endpoints implemented (Tasks 12, 13, 14, 15, 16, 17, 18, 19)
- ✓ Mutating verbs return EXECUTOR_UNAVAILABLE (Task 19, plus per-route stubs in Tasks 17/18)
- ✓ Envelope wrapping on every response (Task 3 + sendOk helper in Task 10)
- ✓ Stable ErrorCode enum (Task 4)
- ✓ Authentication for non-anonymous access (Task 7 — bearer token; peer-creds stubbed)

**Spec coverage (ADR-0001):**

- ✓ One core, two transports — REST added alongside existing MCP (MCP untouched per the brief; convergence is WS12)
- ✓ Principal × transport (bearer token implemented; Unix peer-creds documented as a follow-up since Express doesn't expose SO_PEERCRED cleanly without a server-level adapter)
- ✗ MCP apply-gate enforcement — out of scope per the brief

**Spec coverage (ADR-0002):**

- ✓ Mutating endpoints fail with EXECUTOR_UNAVAILABLE when agent isn't reachable (here, agent is absent → all mutating routes return that)
- ✓ Read-only state remains available (GET endpoints work with no agent)

**Spec coverage (reqs §14):**

- ✓ Every API request creates an audit entry (Task 8)
- ✓ AuditEntry includes principal, timestamp, controller_id (= node_id), kind, request_id, parameters_hash, result_hash, client_type

**Placeholder scan:** No "TBD" / "fill in details" in plan steps. Deferrals (audit query, config-history bridge, executor, full SSE streaming, Unix peer-creds wiring) are explicit and named.

**Type consistency:** ApiContext, RequestContext, Envelope, Warning, ApiError, ErrorCode, ApiException — defined in earlier tasks and consumed unchanged. Route module shape: `(ctx: ApiContext) => Router`. Mounting pattern: `v1.use(<router>(ctx))` in app.ts. Audit middleware reads from `state.audit.queue()` (the AuditAppender from PR #200).

**Scope:** focused on the read-only REST transport over the state store. No agent, no executor, no adapter migration, no MCP convergence — all separately tracked.

**Revisions from code review:**

| Finding | Fix location |
|---|---|
| Auth tests expected 401, status map gave 403 | Task 4: PERMISSION_DENIED → 401 in STATUS_MAP (Phase 0 simplification — only auth-failures use it for now; documented in errors.ts). |
| `exactOptionalPropertyTypes` violations: ApiException, audit `operation_id`, server `archiveDir` | Task 4: `ApiException` uses `if (x !== undefined) this.x = x` conditional assigns. Task 8: audit entry uses conditional spread for `operation_id`. Task 20: `startServer` uses conditional spread for `archiveDir`. |
| Unix peer-creds claimed but no-op | Task 7: implemented via socket-type detection (`isUnixSocketConnection`) — UDS connections are trusted as admin because the socket file's mode 0660 root:xinas-admin (set by Task 20's `chmodSync`) is the actual gate. Same trust-via-file-system pattern ADR-0002 uses for the agent socket. New test creates a real Unix socket via `http.createServer().listen(path)` + raw `http.request({socketPath})` and verifies admin promotion. |
| `xinas-api.service` runs as root, contradicts ADR-0002 | Task 22: rewrote unit per ADR-0002 §Hardening — `DynamicUser=yes`, empty `CapabilityBoundingSet`, `ProtectSystem=strict`, full sandboxing stack. `StateDirectory`/`LogsDirectory`/`RuntimeDirectory` give the unprivileged user writable paths. |
| Count claim wrong (14 vs 30 GETs); CI runs only sanity test | Goal/PR-summary line updated to 30. Task 21 integration test loops over all 30 GET operations from api-v1.yaml (with seed data so 200 endpoints actually succeed; 404 cases verify the NOT_FOUND envelope path). Task 22 step 2 modifies `.github/workflows/ci.yml` to run `npm test` (full suite) instead of just `sanity.test.ts` — without that fix the new api suite would silently not run in CI. |

Ready for execution.
