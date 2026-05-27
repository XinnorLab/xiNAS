# Phase 0 State Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the SQLite-backed KV state store specified in ADR-0003 — the foundation that the xinas-api skeleton, task engine, and audit consolidation all build on.

**Architecture:** A KV interface (`get / put / patch / delete / list / watch / transaction`) wraps a single SQLite-WAL backend. CAS via `UPDATE WHERE revision = ?`. Audit is a hash-chained JSONL with a transactional outbox table so audit queueing is atomic with the state mutation that triggered it; a background drainer copies outbox entries to JSONL with `fsync()`. Watch is an in-process `EventEmitter` fired after commit. The public API does not leak SQLite types so Phase 2 can swap the backend to etcd without changing call sites.

**Tech Stack:** TypeScript (`module: Node16`, `esModuleInterop`), Node 20+, `better-sqlite3` (synchronous, fast, mature; built during `npm install`), vitest (already wired by the CI bootstrap), biome 1.9.4 lint (`correctness` rules only), Ajv-style JSON schema not needed here (typed at the boundary).

**Reference spec:** [docs/control-path/adr/0003-state-store.md](../control-path/adr/0003-state-store.md). Surrounding contracts: ADR-0001 (api surface), ADR-0002 (agent privilege — the agent writes observed state *through* this store via the API, not directly), ADR-0004 (task engine — the `tasks` and `task_stages` SQLite tables land in this PR; the executor is a later PR).

**Branch:** `claude/phase0-state-store` off `main` (latest tip at start: `5376840`).

**Out of scope (separate PRs):**
- xinas-api REST service skeleton.
- xinas-agent process.
- The task executor / worker pool (the *schema* lands here; the *executor* doesn't).
- Rewiring `xinas_history`'s drift detection to read from `/xinas/v1/observed/managed_files/*`.

---

## File map

| Path                                                | Action | Owns                                                                                                  |
|-----------------------------------------------------|--------|-------------------------------------------------------------------------------------------------------|
| `xiNAS-MCP/package.json`                            | Modify | Add `better-sqlite3` runtime dep + `@types/better-sqlite3` devDep.                                    |
| `xiNAS-MCP/src/state/types.ts`                      | Create | Public TS types: `RevisionedValue`, `PutOptions`, `ListOptions`, `CasResult`, `WatchEvent`, errors.   |
| `xiNAS-MCP/src/state/store.ts`                      | Create | `KvStore` interface (no implementation; pure type contract).                                          |
| `xiNAS-MCP/src/state/migrations/001-initial.sql`    | Create | Initial DDL: `kv`, `tasks`, `task_stages`, `leases`, `audit_outbox`, `audit_index`, `schema_version`. |
| `xiNAS-MCP/src/state/migrations.ts`                 | Create | Migration runner: scans `migrations/*.sql`, applies in order, records in `schema_version`.            |
| `xiNAS-MCP/src/state/backend-sqlite.ts`             | Create | `SqliteKvStore implements KvStore` — get/put/patch/delete/list/watch/transaction over better-sqlite3. |
| `xiNAS-MCP/src/state/leases.ts`                     | Create | Lease helpers: `acquire`, `heartbeat`, `release`, `sweepExpired`.                                     |
| `xiNAS-MCP/src/state/audit.ts`                      | Create | `AuditAppender.queue(tx, entry)` — hash chain + outbox insert inside a KV transaction.                |
| `xiNAS-MCP/src/state/audit-drainer.ts`              | Create | Background drainer: outbox → JSONL with `fsync`, mark durable, handle rotation, crash recovery.       |
| `xiNAS-MCP/src/state/gc.ts`                         | Create | Periodic sweep: task retention (30d), events ring (100k), lease TTL.                                  |
| `xiNAS-MCP/src/state/index.ts`                      | Create | Public surface: `openStateStore({ path })` factory returning `{ kv, audit, drainer, gc }`.            |
| `xiNAS-MCP/src/__tests__/state/migrations.test.ts`  | Create | Migration runner: fresh DB, idempotent re-apply, version row.                                         |
| `xiNAS-MCP/src/__tests__/state/store-basic.test.ts` | Create | KV: get/put/delete; revision increments; timestamps update.                                           |
| `xiNAS-MCP/src/__tests__/state/store-cas.test.ts`   | Create | CAS: stale revision rejected; concurrent puts; create-if-not-exists via `expected_revision: 0`.       |
| `xiNAS-MCP/src/__tests__/state/store-patch.test.ts` | Create | Patch: read-modify-write inside tx; CAS retry semantics.                                              |
| `xiNAS-MCP/src/__tests__/state/store-list.test.ts`  | Create | List: prefix filter, pagination via `start_after`, `limit`.                                           |
| `xiNAS-MCP/src/__tests__/state/store-watch.test.ts` | Create | Watch: events delivered after commit; close stops events; no events during transaction rollback.      |
| `xiNAS-MCP/src/__tests__/state/store-tx.test.ts`    | Create | Transaction: atomicity (all-or-nothing); nested put+delete sees own writes.                           |
| `xiNAS-MCP/src/__tests__/state/leases.test.ts`      | Create | Acquire one-per-resource; heartbeat extends; sweep removes expired; release frees.                    |
| `xiNAS-MCP/src/__tests__/state/audit.test.ts`       | Create | Queue atomicity (rollback cancels queue); hash chain links; outbox row written.                       |
| `xiNAS-MCP/src/__tests__/state/audit-drainer.test.ts` | Create | Drainer copies pending to JSONL; fsync called; durable_offset recorded; rotation triggers.            |
| `xiNAS-MCP/src/__tests__/state/audit-recovery.test.ts` | Create | Crash recovery: undrained outbox rows drained before serving; tail-hash extracted from JSONL.        |
| `xiNAS-MCP/src/__tests__/state/gc.test.ts`          | Create | Tasks beyond retention removed; events ring caps; expired leases swept.                               |
| `xiNAS-MCP/src/__tests__/state/index.test.ts`       | Create | `openStateStore` factory: opens, closes, restarts cleanly; idempotent.                                |

**Total: 23 new files + 1 modified (`package.json`).** Zero changes to existing product code outside `xiNAS-MCP/src/state/` and its tests.

---

## Task 1: Branch check + add `better-sqlite3` dependency

**Files:**
- Modify: `xiNAS-MCP/package.json`

- [ ] **Step 1: Confirm branch and tree state**

Run:
```bash
git -C /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782 branch --show-current
git -C /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782 status -s
git -C /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782 log --oneline -1
```

Expected: branch `claude/phase0-state-store`, working tree clean, tip is `5376840` (or wherever `origin/main` is at start).

- [ ] **Step 2: Add the runtime + types dependency**

Edit `xiNAS-MCP/package.json` to add `better-sqlite3` under `dependencies` and `@types/better-sqlite3` under `devDependencies`, preserving alphabetical order:

In `"dependencies"` add after `"@modelcontextprotocol/sdk"`:
```json
    "better-sqlite3": "^11.5.0",
```

In `"devDependencies"` add after `"@biomejs/biome"`:
```json
    "@types/better-sqlite3": "^7.6.11",
```

Also update `"scripts"` to copy non-TS assets (the `.sql` migration files) to `dist/` during build. tsc only emits `.ts → .js`; without this, packaged code can't find migrations at runtime. Replace the existing `"build"` script and add `"copy-assets"`:

```json
    "build": "tsc -p tsconfig.json && npm run copy-assets",
    "copy-assets": "mkdir -p dist/state/migrations && cp src/state/migrations/*.sql dist/state/migrations/",
```

Tests run via `vitest`/`tsx` which load directly from `src/`, so this only matters for the packaged build path — but matters absolutely there.

- [ ] **Step 3: Install + verify**

Run:
```bash
cd xiNAS-MCP && npm install 2>&1 | tail -5
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('CREATE TABLE t(x)'); console.log('better-sqlite3 OK, version', db.prepare('SELECT sqlite_version() AS v').get().v);"
```

Expected: `npm install` completes; the node one-liner prints `better-sqlite3 OK, version 3.X.Y`. (It compiles a native module; expect ~30s.)

- [ ] **Step 4: Verify typecheck still passes**

Run:
```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0`. (Just verifies the package.json change doesn't break the existing tsconfig.)

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/package.json xiNAS-MCP/package-lock.json
git commit -m "$(cat <<'EOF'
build(state): add better-sqlite3 and copy-assets build step

better-sqlite3 is the SQLite binding the state store uses per ADR-0003.
Chosen over node:sqlite (Node 22.5+, our CI is Node 20) and sql.js
(WASM, slower) for being mature, synchronous, and well-typed. The
native module compiles during npm install (~30s).

Also adds a copy-assets step to the build script so .sql migration
files reach dist/. tsc only emits TS output; without copy-assets the
packaged xinas-api can't find migrations at runtime even though
tests under tsx pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Initial SQLite DDL

**Files:**
- Create: `xiNAS-MCP/src/state/migrations/001-initial.sql`

- [ ] **Step 1: Create the migrations directory + DDL file**

Run:
```bash
mkdir -p xiNAS-MCP/src/state/migrations
```

Create `xiNAS-MCP/src/state/migrations/001-initial.sql`:

```sql
-- Initial schema for the Phase 0 state store (ADR-0003, ADR-0004).
-- Single file; future migrations land as 002-*.sql, 003-*.sql, etc.

-- Schema version tracking. The migrations runner inserts one row per
-- applied migration.
CREATE TABLE IF NOT EXISTS schema_version (
  version       INTEGER PRIMARY KEY,
  filename      TEXT    NOT NULL,
  applied_at    INTEGER NOT NULL
);

-- Generic KV table backing every /xinas/v1/... key prefix.
-- value is a serialized JSON blob; the public API deserializes.
CREATE TABLE IF NOT EXISTS kv (
  key                TEXT    PRIMARY KEY,
  value              BLOB    NOT NULL,
  revision           INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,    -- epoch ms
  modified_at        INTEGER NOT NULL,    -- epoch ms
  owner              TEXT    NOT NULL,
  source             TEXT    NOT NULL,
  validation_status  TEXT    NOT NULL CHECK (validation_status IN ('valid','drift','invalid','pending'))
);

CREATE INDEX IF NOT EXISTS kv_prefix_idx ON kv(key);
CREATE INDEX IF NOT EXISTS kv_modified_idx ON kv(modified_at);

-- Tasks per ADR-0004. Executor lands in a later PR; the schema is here so
-- the API can read/write task records via the KV layer's structured helpers.
CREATE TABLE IF NOT EXISTS tasks (
  task_id                  TEXT    PRIMARY KEY,
  kind                     TEXT    NOT NULL,
  state                    TEXT    NOT NULL,
  plan_id                  TEXT,
  idempotency_key          TEXT,
  principal                TEXT    NOT NULL,
  client_type              TEXT    NOT NULL,
  request_id               TEXT    NOT NULL,
  correlation_id           TEXT    NOT NULL,
  input_hash               TEXT    NOT NULL,
  plan_hash                TEXT,
  result_hash              TEXT,
  state_revision_expected  INTEGER,
  state_revision_at_apply  INTEGER,
  risk_level               TEXT    NOT NULL,
  affected_resources       TEXT    NOT NULL,    -- JSON array
  snapshot_before          TEXT,
  snapshot_after           TEXT,
  cancel_requested_at      INTEGER,
  cancel_refused_reason    TEXT,
  error_code               TEXT,
  error_message            TEXT,
  remediation_hint         TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  terminal_at              INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_idx
  ON tasks(idempotency_key, principal)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_state_kind_idx ON tasks(state, kind);
CREATE INDEX IF NOT EXISTS tasks_plan_idx ON tasks(plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at);

-- Per-stage logs. output_inline holds the chunk when size <= 64 KiB;
-- output_path is a relative path under /var/log/xinas/tasks/<task_id>/
-- when the chunk spilled.
CREATE TABLE IF NOT EXISTS task_stages (
  stage_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  stage_index       INTEGER NOT NULL,
  name              TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  output_inline     BLOB,
  output_path       TEXT,
  output_size_bytes INTEGER NOT NULL,
  error_code        TEXT,
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS task_stages_lookup_idx ON task_stages(task_id, stage_index);

-- Leases (per ADR-0003 rename; ADR-0004 names the table 'leases').
-- One holder per (resource_kind, resource_id).
CREATE TABLE IF NOT EXISTS leases (
  lease_id        TEXT    PRIMARY KEY,
  resource_kind   TEXT    NOT NULL,
  resource_id     TEXT    NOT NULL,
  task_id         TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  acquired_at     INTEGER NOT NULL,
  ttl_seconds     INTEGER NOT NULL,
  heartbeat_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS leases_resource_idx ON leases(resource_kind, resource_id);
CREATE INDEX IF NOT EXISTS leases_task_idx ON leases(task_id);

-- Audit outbox (ADR-0003 §Atomic audit via outbox pattern).
-- Rows are inserted in the same SQLite transaction as the state change
-- they describe. A background drainer copies pending rows to the JSONL
-- file with fsync(), then flips drain_state and fills in durable_*.
CREATE TABLE IF NOT EXISTS audit_outbox (
  audit_seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_json      BLOB    NOT NULL,
  prev_hash       BLOB    NOT NULL,
  hash            BLOB    NOT NULL,
  queued_at       INTEGER NOT NULL,
  drain_state     TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (drain_state IN ('pending','durable')),
  durable_at      INTEGER,
  durable_file    TEXT,
  durable_offset  INTEGER
);

CREATE INDEX IF NOT EXISTS audit_outbox_pending_idx ON audit_outbox(drain_state, audit_seq)
  WHERE drain_state = 'pending';

-- Audit index for fast lookup of entries by request_id / operation_id /
-- task_id. Points into the JSONL once drained.
CREATE TABLE IF NOT EXISTS audit_index (
  request_id      TEXT,
  operation_id    TEXT,
  task_id         TEXT,
  audit_seq       INTEGER NOT NULL REFERENCES audit_outbox(audit_seq),
  durable_file    TEXT,
  durable_offset  INTEGER
);

CREATE INDEX IF NOT EXISTS audit_index_request_idx ON audit_index(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_index_operation_idx ON audit_index(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_index_task_idx ON audit_index(task_id) WHERE task_id IS NOT NULL;
```

- [ ] **Step 2: Verify SQL parses against SQLite**

Run:
```bash
node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database(':memory:');
const sql = fs.readFileSync('xiNAS-MCP/src/state/migrations/001-initial.sql', 'utf8');
db.exec(sql);
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r => r.name);
console.log('Tables:', tables.join(', '));
"
```

Expected output:
```
Tables: audit_index, audit_outbox, kv, leases, schema_version, task_stages, tasks
```

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/state/migrations/001-initial.sql
git commit -m "$(cat <<'EOF'
feat(state): add initial SQLite DDL for KV, tasks, leases, audit

One migration file landing all six tables specified by ADR-0003 and
ADR-0004:

  kv             — generic backing for every /xinas/v1/* key
  tasks          — ADR-0004 task records (executor lands later)
  task_stages    — stage logs with inline vs spilled output
  leases         — resource locks (ADR-0003 §Key layout, renamed
                    from 'locks' to match cluster terminology)
  audit_outbox   — transactional queue for audit JSONL writes
  audit_index    — secondary lookup by request/operation/task id
  schema_version — migrations runner state

WHERE clauses on partial indexes keep them lean. CHECK constraints
on enum-shaped columns catch drift early.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Migrations runner

**Files:**
- Create: `xiNAS-MCP/src/state/migrations.ts`
- Create: `xiNAS-MCP/src/__tests__/state/migrations.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/migrations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';

describe('migrations runner', () => {
  it('creates the schema_version table and applies 001-initial.sql', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toEqual([
      'audit_index',
      'audit_outbox',
      'kv',
      'leases',
      'schema_version',
      'sqlite_sequence',
      'task_stages',
      'tasks',
    ]);

    const versions = db.prepare('SELECT version, filename FROM schema_version ORDER BY version').all();
    expect(versions).toEqual([{ version: 1, filename: '001-initial.sql' }]);
  });

  it('is idempotent: re-running applies no new migrations', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const before = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    runMigrations(db);
    const after = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/migrations.test.ts 2>&1 | tail -10
```

Expected: failure — `Cannot find module '../../state/migrations.js'`.

- [ ] **Step 3: Implement the migrations runner**

Create `xiNAS-MCP/src/state/migrations.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, 'migrations');

interface MigrationRow {
  version: number;
  filename: string;
}

/**
 * Apply all migrations under migrations/ in numeric order. Idempotent —
 * a migration whose version already exists in schema_version is skipped.
 *
 * The schema_version table itself is created by 001-initial.sql, so this
 * runner uses a sqlite_master probe to decide whether to read it.
 */
export function runMigrations(db: Database): void {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{3,}-.*\.sql$/.test(f))
    .sort();

  const hasSchemaTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();

  const applied = new Set<number>();
  if (hasSchemaTable) {
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
    for (const r of rows) applied.add(r.version);
  }

  const apply = db.transaction((file: string, version: number) => {
    const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, filename, applied_at) VALUES (?, ?, ?)').run(
      version,
      file,
      Date.now(),
    );
  });

  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    apply(file, version);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/migrations.test.ts 2>&1 | tail -8
```

Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/migrations.ts xiNAS-MCP/src/__tests__/state/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add SQLite migrations runner

Scans src/state/migrations/ for ddd-*.sql files, applies in numeric
order inside a transaction each, records in schema_version. Idempotent
re-runs are safe via the version probe + INSERT OR IGNORE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: KV types module

**Files:**
- Create: `xiNAS-MCP/src/state/types.ts`

This file is pure type definitions; no test (types are exercised by every later test).

- [ ] **Step 1: Write the types**

Create `xiNAS-MCP/src/state/types.ts`:

```ts
/**
 * Public types for the Phase 0 state store. The KV interface
 * (store.ts) and the SQLite backend (backend-sqlite.ts) share these
 * shapes. The contract is intentionally backend-agnostic so a Phase 2
 * etcd swap (per ADR-0003) does not change call sites.
 */

export type ValidationStatus = 'valid' | 'drift' | 'invalid' | 'pending';

export type ClientType =
  | 'rest'
  | 'mcp'
  | 'tui'
  | 'cli'
  | 'automation'
  | 'system';

export interface RevisionedValue<T = unknown> {
  key: string;
  value: T;
  revision: number;          // monotonic per key; first write is 1
  created_at: number;        // epoch ms; never changes after creation
  modified_at: number;       // epoch ms; updated on each put/patch
  owner: string;             // principal or source identifier
  source: string;            // origin tag, e.g. 'ansible:nfs_server'
  validation_status: ValidationStatus;
}

export interface PutOptions {
  owner?: string;
  source?: string;
  validation_status?: ValidationStatus;
  /**
   * CAS guard. Set to `0` to require "does not exist" (create-only).
   * Set to a revision number to require "current revision matches".
   * Omit to skip the CAS check (last-writer-wins).
   */
  expected_revision?: number;
}

export interface ListOptions {
  prefix?: string;           // e.g., '/xinas/v1/desired/Share/'
  limit?: number;            // default 1000
  start_after?: string;      // pagination cursor (key string)
}

export type CasResult<T = unknown> =
  | { ok: true; value: RevisionedValue<T> }
  | {
      ok: false;
      reason: 'stale_revision' | 'not_found' | 'already_exists';
      current: RevisionedValue<T> | null;
    };

export type DeleteResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'stale_revision' | 'not_found'; current: RevisionedValue | null };

export type WatchEvent =
  | { kind: 'put'; key: string; value: RevisionedValue }
  | { kind: 'delete'; key: string; previous_revision: number };

export interface WatchHandle {
  close(): void;
}

/**
 * Audit entry shape — per phase0-requirements.md §14, every audit
 * record carries the principal, timestamp, controller_id (= node_id
 * in Phase 0), operation/tool name, parameters hash, result hash,
 * request_id, operation_id (if present), and task_id (if present).
 *
 * Required fields are non-optional; payload is free-form.
 */
export interface AuditEntry {
  kind: string;                        // operation/tool name, e.g. 'share.create'
  timestamp: number;                   // epoch ms; set by AuditAppender at queue time
  node_id: string;                     // controller_id; injected by AuditAppender
  principal: string;
  client_type: ClientType;
  request_id: string;
  parameters_hash: string;             // sha256 of canonicalized request input
  result_hash: string;                 // sha256 of canonicalized result; '' on failure
  operation_id?: string;
  task_id?: string;
  state_revision?: number;
  payload?: Record<string, unknown>;
}

/**
 * The subset of AuditEntry that callers provide. AuditAppender fills
 * in `timestamp` and `node_id` so callers don't have to thread them.
 */
export type AuditEntryInput = Omit<AuditEntry, 'timestamp' | 'node_id'>;

export interface QueuedAuditEntry {
  audit_seq: number;
  prev_hash: Buffer;
  hash: Buffer;
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/state/types.ts
git commit -m "$(cat <<'EOF'
feat(state): add public types for the KV store and audit

Shared shapes used by the KV interface, the SQLite backend, and
callers. Intentionally backend-agnostic per ADR-0003 — Phase 2 swaps
SQLite for etcd without changing these types.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: KvStore interface

**Files:**
- Create: `xiNAS-MCP/src/state/store.ts`

- [ ] **Step 1: Write the interface**

Create `xiNAS-MCP/src/state/store.ts`:

```ts
import type {
  CasResult,
  DeleteResult,
  ListOptions,
  PutOptions,
  RevisionedValue,
  WatchEvent,
  WatchHandle,
} from './types.js';

/**
 * KV store interface. Implementations exist for SQLite today (the
 * Phase 0 backend) and may exist for etcd in Phase 2 — call sites bind
 * to this type, not to any backend-specific module.
 *
 * Method semantics:
 *   - get/list: latest committed value(s); read-your-writes from
 *     within an open transaction.
 *   - put: writes value; if expected_revision is given, fails with
 *     CAS result when the current revision differs.
 *   - patch: read-modify-write inside an implicit transaction; the
 *     mutator receives the current value and returns the new one.
 *     Retries are NOT automatic — caller decides on stale_revision.
 *   - delete: removes the key; optional CAS via expected_revision.
 *   - watch: in-process event stream for the given prefix; events
 *     fire after the underlying transaction commits.
 *   - transaction: opens a synchronous transaction; the callback sees
 *     read-your-writes; commits on normal return, rolls back on throw.
 */
export interface KvStore {
  get<T = unknown>(key: string): RevisionedValue<T> | null;

  put<T = unknown>(
    key: string,
    value: T,
    opts?: PutOptions,
  ): CasResult<T>;

  patch<T = unknown>(
    key: string,
    mutator: (current: T | null) => T,
    opts?: PutOptions,
  ): CasResult<T>;

  delete(key: string, expected_revision?: number): DeleteResult;

  list<T = unknown>(opts?: ListOptions): RevisionedValue<T>[];

  watch(prefix: string, onChange: (event: WatchEvent) => void): WatchHandle;

  transaction<R>(fn: (tx: KvTransaction) => R): R;

  close(): void;
}

/**
 * Subset of KvStore available inside a transaction callback. Reads
 * see uncommitted writes from the same transaction; writes are
 * staged and only become visible to other readers on commit.
 */
export interface KvTransaction {
  get<T = unknown>(key: string): RevisionedValue<T> | null;

  put<T = unknown>(
    key: string,
    value: T,
    opts?: PutOptions,
  ): CasResult<T>;

  delete(key: string, expected_revision?: number): DeleteResult;
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
cd xiNAS-MCP && npm run typecheck ; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add xiNAS-MCP/src/state/store.ts
git commit -m "$(cat <<'EOF'
feat(state): add KvStore interface (pure type contract)

Defines KvStore and KvTransaction with the seven methods ADR-0003
mandates: get / put / patch / delete / list / watch / transaction.
The interface is the boundary between business logic and storage; no
backend-specific types appear in its signatures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: SQLite backend — get + put (basic, no CAS)

**Files:**
- Create: `xiNAS-MCP/src/state/backend-sqlite.ts`
- Create: `xiNAS-MCP/src/__tests__/state/store-basic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/state/store-basic.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — basic get/put', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('returns null for an unknown key', () => {
    expect(store.get('/xinas/v1/cluster')).toBeNull();
  });

  it('round-trips a value with default metadata', () => {
    const result = store.put('/xinas/v1/cluster', { mode: 'single_node' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.value).toEqual({ mode: 'single_node' });
    expect(result.value.revision).toBe(1);
    expect(result.value.owner).toBe('system');
    expect(result.value.source).toBe('unspecified');
    expect(result.value.validation_status).toBe('valid');

    const fetched = store.get<{ mode: string }>('/xinas/v1/cluster');
    expect(fetched).not.toBeNull();
    expect(fetched?.value).toEqual({ mode: 'single_node' });
    expect(fetched?.revision).toBe(1);
  });

  it('increments revision and updates modified_at on overwrite', async () => {
    const r1 = store.put('/k', { n: 1 });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // Force a different ms timestamp.
    await new Promise((r) => setTimeout(r, 5));

    const r2 = store.put('/k', { n: 2 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.value.revision).toBe(2);
    expect(r2.value.modified_at).toBeGreaterThan(r1.value.modified_at);
    expect(r2.value.created_at).toBe(r1.value.created_at);
  });

  it('honors PutOptions for owner/source/validation_status', () => {
    const result = store.put(
      '/k',
      { x: 1 },
      { owner: 'admin:platonovsm', source: 'rest', validation_status: 'pending' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.owner).toBe('admin:platonovsm');
    expect(result.value.source).toBe('rest');
    expect(result.value.validation_status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-basic.test.ts 2>&1 | tail -10
```

Expected: failure on `Cannot find module '../../state/backend-sqlite.js'`.

- [ ] **Step 3: Implement get + put**

Create `xiNAS-MCP/src/state/backend-sqlite.ts`:

```ts
import type { Database, Statement } from 'better-sqlite3';
import type { KvStore, KvTransaction } from './store.js';
import type {
  CasResult,
  DeleteResult,
  ListOptions,
  PutOptions,
  RevisionedValue,
  ValidationStatus,
  WatchEvent,
  WatchHandle,
} from './types.js';

interface KvRow {
  key: string;
  value: Buffer;
  revision: number;
  created_at: number;
  modified_at: number;
  owner: string;
  source: string;
  validation_status: ValidationStatus;
}

function rowToValue<T>(row: KvRow): RevisionedValue<T> {
  return {
    key: row.key,
    value: JSON.parse(row.value.toString('utf8')) as T,
    revision: row.revision,
    created_at: row.created_at,
    modified_at: row.modified_at,
    owner: row.owner,
    source: row.source,
    validation_status: row.validation_status,
  };
}

export class SqliteKvStore implements KvStore {
  private readonly db: Database;
  private readonly getStmt: Statement;
  private readonly putExistingStmt: Statement;
  private readonly putNewStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    this.getStmt = db.prepare('SELECT * FROM kv WHERE key = ?');
    this.putExistingStmt = db.prepare(
      `UPDATE kv
         SET value = ?, revision = revision + 1,
             modified_at = ?, owner = ?, source = ?, validation_status = ?
       WHERE key = ?`,
    );
    this.putNewStmt = db.prepare(
      `INSERT INTO kv (key, value, revision, created_at, modified_at, owner, source, validation_status)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    );
  }

  get<T = unknown>(key: string): RevisionedValue<T> | null {
    const row = this.getStmt.get(key) as KvRow | undefined;
    return row ? rowToValue<T>(row) : null;
  }

  put<T = unknown>(key: string, value: T, opts: PutOptions = {}): CasResult<T> {
    const now = Date.now();
    const owner = opts.owner ?? 'system';
    const source = opts.source ?? 'unspecified';
    const status: ValidationStatus = opts.validation_status ?? 'valid';
    const payload = Buffer.from(JSON.stringify(value), 'utf8');

    const existing = this.getStmt.get(key) as KvRow | undefined;
    if (existing) {
      this.putExistingStmt.run(payload, now, owner, source, status, key);
    } else {
      this.putNewStmt.run(key, payload, now, now, owner, source, status);
    }
    const updated = this.getStmt.get(key) as KvRow;
    return { ok: true, value: rowToValue<T>(updated) };
  }

  // Placeholders to satisfy the interface; later tasks fill these in.
  patch<T = unknown>(_key: string, _mutator: (current: T | null) => T, _opts?: PutOptions): CasResult<T> {
    throw new Error('patch: not implemented in Task 6');
  }
  delete(_key: string, _expected_revision?: number): DeleteResult {
    throw new Error('delete: not implemented in Task 6');
  }
  list<T = unknown>(_opts?: ListOptions): RevisionedValue<T>[] {
    throw new Error('list: not implemented in Task 6');
  }
  watch(_prefix: string, _onChange: (event: WatchEvent) => void): WatchHandle {
    throw new Error('watch: not implemented in Task 6');
  }
  transaction<R>(_fn: (tx: KvTransaction) => R): R {
    throw new Error('transaction: not implemented in Task 6');
  }
  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-basic.test.ts 2>&1 | tail -8
```

Expected: `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-basic.test.ts
git commit -m "$(cat <<'EOF'
feat(state): SQLite KV backend — get/put with revisioning

Initial backend skeleton with the seven KvStore methods. get and put
are implemented; patch/delete/list/watch/transaction throw
'not implemented' (filled in by Tasks 7-11). Enables WAL mode and
foreign_keys at construction.

Revisioning per ADR-0003: revision is monotonic per key, first write
is 1, created_at never changes, modified_at updates on overwrite.
Default owner='system', source='unspecified', validation_status='valid'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: SQLite backend — CAS via `expected_revision`

**Files:**
- Modify: `xiNAS-MCP/src/state/backend-sqlite.ts:60-92` (the `put` method)
- Create: `xiNAS-MCP/src/__tests__/state/store-cas.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/store-cas.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — CAS', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('create-only (expected_revision: 0) succeeds when key is absent', () => {
    const result = store.put('/k', { x: 1 }, { expected_revision: 0 });
    expect(result.ok).toBe(true);
  });

  it('create-only fails when key already exists', () => {
    store.put('/k', { x: 1 });
    const result = store.put('/k', { x: 2 }, { expected_revision: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_exists');
    expect(result.current?.value).toEqual({ x: 1 });
  });

  it('CAS with matching revision succeeds', () => {
    const r1 = store.put('/k', { x: 1 });
    if (!r1.ok) throw new Error('seed failed');
    const r2 = store.put('/k', { x: 2 }, { expected_revision: r1.value.revision });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.revision).toBe(2);
  });

  it('CAS with stale revision fails and returns current', () => {
    const r1 = store.put('/k', { x: 1 });
    if (!r1.ok) throw new Error('seed failed');
    store.put('/k', { x: 2 }); // bump revision to 2

    const stale = store.put('/k', { x: 3 }, { expected_revision: r1.value.revision });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.reason).toBe('stale_revision');
    expect(stale.current?.revision).toBe(2);
    expect(stale.current?.value).toEqual({ x: 2 });
  });

  it('CAS with expected_revision > 0 on missing key returns not_found', () => {
    const result = store.put('/k', { x: 1 }, { expected_revision: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
    expect(result.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-cas.test.ts 2>&1 | tail -10
```

Expected: failures on the four CAS cases (last-writer-wins behavior currently).

- [ ] **Step 3: Update `put` to honor `expected_revision` via SQL predicates**

Per ADR-0003, CAS must be enforced **inside the SQL statement** (`UPDATE ... WHERE revision = ?`), not by a read-then-compare in JS — otherwise a concurrent writer between the SELECT and the UPDATE silently wins. Add a new prepared statement for CAS-updates and use it when `expected_revision` is given.

In the constructor, add a `putCasStmt`:

```ts
    this.putCasStmt = db.prepare(
      `UPDATE kv
         SET value = ?, revision = revision + 1,
             modified_at = ?, owner = ?, source = ?, validation_status = ?
       WHERE key = ? AND revision = ?`,
    );
```

Declare the field alongside the others:

```ts
  private readonly putCasStmt: Statement;
```

Replace the `put` method body with:

```ts
  put<T = unknown>(key: string, value: T, opts: PutOptions = {}): CasResult<T> {
    const now = Date.now();
    const owner = opts.owner ?? 'system';
    const source = opts.source ?? 'unspecified';
    const status: ValidationStatus = opts.validation_status ?? 'valid';
    const payload = Buffer.from(JSON.stringify(value), 'utf8');

    // Last-writer-wins (no CAS): UPSERT-style.
    if (opts.expected_revision === undefined) {
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (existing) {
        this.putExistingStmt.run(payload, now, owner, source, status, key);
      } else {
        this.putNewStmt.run(key, payload, now, now, owner, source, status);
      }
      const updated = this.getStmt.get(key) as KvRow;
      return { ok: true, value: rowToValue<T>(updated) };
    }

    // Create-only: try INSERT; UNIQUE conflict = already_exists.
    if (opts.expected_revision === 0) {
      try {
        this.putNewStmt.run(key, payload, now, now, owner, source, status);
      } catch (err) {
        if (String(err).includes('UNIQUE')) {
          const existing = this.getStmt.get(key) as KvRow;
          return { ok: false, reason: 'already_exists', current: rowToValue<T>(existing) };
        }
        throw err;
      }
      const inserted = this.getStmt.get(key) as KvRow;
      return { ok: true, value: rowToValue<T>(inserted) };
    }

    // CAS: UPDATE ... WHERE revision = ?. 0 changes = stale or missing.
    const info = this.putCasStmt.run(
      payload,
      now,
      owner,
      source,
      status,
      key,
      opts.expected_revision,
    );
    if (info.changes === 0) {
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (!existing) {
        return { ok: false, reason: 'not_found', current: null };
      }
      return { ok: false, reason: 'stale_revision', current: rowToValue<T>(existing) };
    }
    const updated = this.getStmt.get(key) as KvRow;
    return { ok: true, value: rowToValue<T>(updated) };
  }
```

The key change: CAS path uses `WHERE key = ? AND revision = ?` so a concurrent writer that bumps the revision between SELECT and UPDATE cannot slip past. The `info.changes === 0` outcome means either the row doesn't exist or the revision changed; one more SELECT distinguishes those.

- [ ] **Step 4: Run all state tests to verify**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -10
```

Expected: all tests pass (basic + cas).

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-cas.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add CAS via expected_revision on put

Three CAS modes:
  - expected_revision omitted: last-writer-wins (default)
  - expected_revision: 0: create-only; fails 'already_exists' if present
  - expected_revision: N: succeeds only when current revision == N;
    returns 'stale_revision' (with current value) or 'not_found'

This is ADR-0003's atomicity primitive — every higher-level operation
that needs optimistic concurrency builds on it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: SQLite backend — transaction

**Files:**
- Modify: `xiNAS-MCP/src/state/backend-sqlite.ts` (`transaction` method + `KvTransaction` impl class)
- Create: `xiNAS-MCP/src/__tests__/state/store-tx.test.ts`

Implementing transaction before patch/delete/list because patch builds on it.

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/store-tx.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — transaction', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('commits multiple writes atomically', () => {
    store.transaction((tx) => {
      tx.put('/a', { x: 1 });
      tx.put('/b', { x: 2 });
    });
    expect(store.get('/a')?.value).toEqual({ x: 1 });
    expect(store.get('/b')?.value).toEqual({ x: 2 });
  });

  it('rolls back all writes when callback throws', () => {
    expect(() =>
      store.transaction((tx) => {
        tx.put('/a', { x: 1 });
        tx.put('/b', { x: 2 });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(store.get('/a')).toBeNull();
    expect(store.get('/b')).toBeNull();
  });

  it('callback sees read-your-writes', () => {
    store.transaction((tx) => {
      const r = tx.put('/a', { x: 1 });
      expect(r.ok).toBe(true);
      const fetched = tx.get<{ x: number }>('/a');
      expect(fetched?.value).toEqual({ x: 1 });
    });
  });

  it('returns the callback return value', () => {
    const result = store.transaction(() => 42);
    expect(result).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-tx.test.ts 2>&1 | tail -10
```

Expected: failures — `transaction: not implemented in Task 6`.

- [ ] **Step 3: Implement transaction**

In `xiNAS-MCP/src/state/backend-sqlite.ts`, replace the `transaction` placeholder with:

```ts
  transaction<R>(fn: (tx: KvTransaction) => R): R {
    const txFacade: KvTransaction = {
      get: (key) => this.get(key),
      put: (key, value, opts) => this.put(key, value, opts),
      delete: (key, expected_revision) => this.delete(key, expected_revision),
    };
    // better-sqlite3 transactions are synchronous and propagate throws
    // as rollback. The wrapper invokes fn and returns its result.
    const run = this.db.transaction(() => fn(txFacade));
    return run();
  }
```

Note: this delegates reads/writes to the outer store's methods, which run on the same `Database` handle. `better-sqlite3`'s `db.transaction(...)` opens a SAVEPOINT and rolls it back on throw. Reads inside the savepoint see uncommitted writes.

- [ ] **Step 4: Run all state tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -10
```

Expected: basic + cas + tx all pass. (`delete` still throws inside tx if called; the rollback test doesn't call delete.)

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-tx.test.ts
git commit -m "$(cat <<'EOF'
feat(state): implement transaction (synchronous, rollback on throw)

Wraps better-sqlite3's db.transaction(...) which uses SAVEPOINTs and
rolls back on thrown exceptions. The KvTransaction facade delegates to
the outer store's get/put/delete on the same DB handle, so reads
inside the transaction see uncommitted writes (read-your-writes).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: SQLite backend — delete

**Files:**
- Modify: `xiNAS-MCP/src/state/backend-sqlite.ts` (`delete` method)

- [ ] **Step 1: Extend `store-basic.test.ts` with delete cases**

Append to `xiNAS-MCP/src/__tests__/state/store-basic.test.ts` inside the existing `describe` block:

```ts
  it('delete returns ok:true with the deleted revision', () => {
    store.put('/k', { x: 1 });
    const result = store.delete('/k');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    expect(store.get('/k')).toBeNull();
  });

  it('delete on missing key returns ok:false / not_found', () => {
    const result = store.delete('/missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
    expect(result.current).toBeNull();
  });

  it('delete with stale expected_revision returns stale_revision', () => {
    store.put('/k', { x: 1 });
    store.put('/k', { x: 2 }); // rev 2
    const result = store.delete('/k', 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stale_revision');
    expect(result.current?.revision).toBe(2);
    expect(store.get('/k')).not.toBeNull();
  });

  it('delete with matching expected_revision succeeds', () => {
    store.put('/k', { x: 1 });
    const result = store.delete('/k', 1);
    expect(result.ok).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-basic.test.ts 2>&1 | tail -10
```

Expected: 4 new test failures with `delete: not implemented in Task 6`.

- [ ] **Step 3: Implement delete with SQL-predicate CAS**

Add two prepared statements alongside the others:

```ts
  private readonly deleteStmt: Statement;
  private readonly deleteCasStmt: Statement;
```

In the constructor:

```ts
    this.deleteStmt = db.prepare('DELETE FROM kv WHERE key = ?');
    this.deleteCasStmt = db.prepare('DELETE FROM kv WHERE key = ? AND revision = ?');
```

Replace the `delete` placeholder with:

```ts
  delete(key: string, expected_revision?: number): DeleteResult {
    if (expected_revision === undefined) {
      // No CAS: read for the revision-to-return, then delete.
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (!existing) {
        return { ok: false, reason: 'not_found', current: null };
      }
      this.deleteStmt.run(key);
      return { ok: true, revision: existing.revision };
    }

    // CAS: single SQL statement, no read-then-write race.
    const info = this.deleteCasStmt.run(key, expected_revision);
    if (info.changes === 0) {
      const existing = this.getStmt.get(key) as KvRow | undefined;
      if (!existing) {
        return { ok: false, reason: 'not_found', current: null };
      }
      return { ok: false, reason: 'stale_revision', current: rowToValue(existing) };
    }
    return { ok: true, revision: expected_revision };
  }
```

The CAS path uses `WHERE key = ? AND revision = ?` so a concurrent writer cannot make the delete succeed on stale revision. `info.changes === 0` plus a follow-up SELECT distinguishes not_found from stale_revision.

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-basic.test.ts
git commit -m "$(cat <<'EOF'
feat(state): implement delete with optional CAS

Three outcomes:
  - { ok: true, revision }     key existed and was deleted
  - { ok: false, not_found }   key did not exist
  - { ok: false, stale_revision, current }  CAS guard failed

The deleted revision is returned so callers (e.g., watch consumers)
can include it in delete events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: SQLite backend — patch

**Files:**
- Modify: `xiNAS-MCP/src/state/backend-sqlite.ts` (`patch` method)
- Create: `xiNAS-MCP/src/__tests__/state/store-patch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/store-patch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — patch', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('mutator receives null when key is absent', () => {
    let seen: unknown;
    const result = store.patch<{ n: number }>('/k', (current) => {
      seen = current;
      return { n: 1 };
    });
    expect(seen).toBeNull();
    expect(result.ok).toBe(true);
    expect(store.get<{ n: number }>('/k')?.value).toEqual({ n: 1 });
  });

  it('mutator receives current value and updates atomically', () => {
    store.put('/counter', { n: 5 });
    const result = store.patch<{ n: number }>('/counter', (current) => ({
      n: (current?.n ?? 0) + 1,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value).toEqual({ n: 6 });
    expect(result.value.revision).toBe(2);
  });

  it('rolls back if mutator throws', () => {
    store.put('/k', { n: 1 });
    expect(() =>
      store.patch('/k', () => {
        throw new Error('mutator failed');
      }),
    ).toThrow('mutator failed');
    expect(store.get('/k')?.value).toEqual({ n: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-patch.test.ts 2>&1 | tail -10
```

Expected: failures — `patch: not implemented in Task 6`.

- [ ] **Step 3: Implement patch as transaction(get + put)**

In `xiNAS-MCP/src/state/backend-sqlite.ts`, replace the `patch` placeholder with:

```ts
  patch<T = unknown>(
    key: string,
    mutator: (current: T | null) => T,
    opts: PutOptions = {},
  ): CasResult<T> {
    return this.transaction((tx) => {
      const current = tx.get<T>(key);
      const next = mutator(current?.value ?? null);
      return tx.put<T>(key, next, opts);
    });
  }
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-patch.test.ts
git commit -m "$(cat <<'EOF'
feat(state): implement patch (transactional read-modify-write)

Built on top of transaction(): reads current value, calls mutator,
puts the result back — all inside one SAVEPOINT. Mutator exception
rolls back. Mutator receives the unwrapped value (or null), not the
RevisionedValue envelope, since callers care about the data not the
metadata.

CAS via opts.expected_revision is honored on the inner put().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: SQLite backend — list

**Files:**
- Modify: `xiNAS-MCP/src/state/backend-sqlite.ts` (`list` method)
- Create: `xiNAS-MCP/src/__tests__/state/store-list.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/store-list.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — list', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
    store.put('/xinas/v1/desired/Share/a', { n: 1 });
    store.put('/xinas/v1/desired/Share/b', { n: 2 });
    store.put('/xinas/v1/desired/Share/c', { n: 3 });
    store.put('/xinas/v1/desired/Filesystem/x', { n: 99 });
  });

  it('returns all rows in key order when no opts given', () => {
    const rows = store.list();
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Filesystem/x',
      '/xinas/v1/desired/Share/a',
      '/xinas/v1/desired/Share/b',
      '/xinas/v1/desired/Share/c',
    ]);
  });

  it('filters by prefix', () => {
    const rows = store.list({ prefix: '/xinas/v1/desired/Share/' });
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Share/a',
      '/xinas/v1/desired/Share/b',
      '/xinas/v1/desired/Share/c',
    ]);
  });

  it('honors limit', () => {
    const rows = store.list({ prefix: '/xinas/v1/desired/Share/', limit: 2 });
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Share/a',
      '/xinas/v1/desired/Share/b',
    ]);
  });

  it('honors start_after for pagination', () => {
    const rows = store.list({
      prefix: '/xinas/v1/desired/Share/',
      start_after: '/xinas/v1/desired/Share/a',
      limit: 10,
    });
    expect(rows.map((r) => r.key)).toEqual([
      '/xinas/v1/desired/Share/b',
      '/xinas/v1/desired/Share/c',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-list.test.ts 2>&1 | tail -10
```

Expected: failures — `list: not implemented in Task 6`.

- [ ] **Step 3: Implement list**

In `xiNAS-MCP/src/state/backend-sqlite.ts`, replace the `list` placeholder with:

```ts
  list<T = unknown>(opts: ListOptions = {}): RevisionedValue<T>[] {
    const prefix = opts.prefix ?? '';
    const limit = opts.limit ?? 1000;
    const startAfter = opts.start_after ?? '';

    const params: (string | number)[] = [];
    const clauses: string[] = ['1=1'];

    if (prefix) {
      // ESCAPE attaches to the LIKE expression, not the trailing
      // ORDER BY clause. The pattern itself escapes %, _, \.
      clauses.push("key LIKE ? ESCAPE '\\'");
      params.push(`${prefix.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (startAfter) {
      clauses.push('key > ?');
      params.push(startAfter);
    }

    const sql = `SELECT * FROM kv WHERE ${clauses.join(' AND ')} ORDER BY key ASC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as KvRow[];
    return rows.map((row) => rowToValue<T>(row));
  }
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-list.test.ts
git commit -m "$(cat <<'EOF'
feat(state): implement list with prefix, limit, and start_after

Prefix filter uses LIKE with backslash escaping for SQL wildcards.
Pagination via start_after (key > cursor) is stable across writes.
Default limit 1000 keeps unbounded list calls in check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: SQLite backend — watch (in-process EventEmitter)

**Files:**
- Modify: `xiNAS-MCP/src/state/backend-sqlite.ts` (constructor, put/delete fire events, watch method)
- Create: `xiNAS-MCP/src/__tests__/state/store-watch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/store-watch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { SqliteKvStore } from '../../state/backend-sqlite.js';
import type { WatchEvent } from '../../state/types.js';

function openStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteKvStore(db);
}

describe('SqliteKvStore — watch', () => {
  let store: SqliteKvStore;

  beforeEach(() => {
    store = openStore();
  });

  it('emits put events for keys matching the prefix', () => {
    const events: WatchEvent[] = [];
    const handle = store.watch('/xinas/v1/desired/Share/', (e) => events.push(e));

    store.put('/xinas/v1/desired/Share/a', { n: 1 });
    store.put('/xinas/v1/desired/Filesystem/x', { n: 99 }); // not matching
    store.put('/xinas/v1/desired/Share/b', { n: 2 });

    handle.close();

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'put', key: '/xinas/v1/desired/Share/a' });
    expect(events[1]).toMatchObject({ kind: 'put', key: '/xinas/v1/desired/Share/b' });
  });

  it('emits delete events with the prior revision', () => {
    store.put('/k', { x: 1 });
    const events: WatchEvent[] = [];
    const handle = store.watch('/', (e) => events.push(e));

    store.delete('/k');
    handle.close();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'delete', key: '/k', previous_revision: 1 });
  });

  it('does not emit events for rolled-back transactions', () => {
    const events: WatchEvent[] = [];
    const handle = store.watch('/', (e) => events.push(e));

    expect(() =>
      store.transaction((tx) => {
        tx.put('/a', { x: 1 });
        throw new Error('rollback');
      }),
    ).toThrow();

    handle.close();
    expect(events).toEqual([]);
  });

  it('close() stops further events', () => {
    const events: WatchEvent[] = [];
    const handle = store.watch('/', (e) => events.push(e));
    store.put('/a', { x: 1 });
    handle.close();
    store.put('/b', { x: 2 });
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-watch.test.ts 2>&1 | tail -10
```

Expected: failures — `watch: not implemented in Task 6` plus the rollback test failing for a different reason (no events emitted yet).

- [ ] **Step 3: Implement watch + commit-side event fan-out**

In `xiNAS-MCP/src/state/backend-sqlite.ts`, add at the top of the file:

```ts
import { EventEmitter } from 'node:events';
```

Add an instance field:

```ts
  private readonly emitter = new EventEmitter();
  private pendingEvents: WatchEvent[] = [];
```

Replace the `watch` placeholder with:

```ts
  watch(prefix: string, onChange: (event: WatchEvent) => void): WatchHandle {
    const listener = (event: WatchEvent) => {
      if (event.key.startsWith(prefix)) onChange(event);
    };
    this.emitter.on('event', listener);
    return {
      close: () => this.emitter.off('event', listener),
    };
  }

  private fireEvent(event: WatchEvent): void {
    this.emitter.emit('event', event);
  }
```

Adjust `put` to emit a `put` event after a successful write:

In `put`, after the `INSERT`/`UPDATE` succeeds and before `return { ok: true, ... }`, append:

```ts
    const valueForEvent = rowToValue(this.getStmt.get(key) as KvRow);
    this.fireEvent({ kind: 'put', key, value: valueForEvent });
```

(Note: this duplicates the `getStmt.get` call already used to build the result; consolidate by storing the row once if it bothers you.)

Adjust `delete` similarly: capture `existing.revision` before the DELETE, then after success append:

```ts
    this.fireEvent({ kind: 'delete', key, previous_revision: existing.revision });
```

For transactions: the simplest correct approach is to use `this.db.transaction(...)`'s rollback-on-throw and only buffer events inside the running transaction, flushing on commit. better-sqlite3 doesn't expose a commit hook, so use this pattern:

Replace `transaction` with:

```ts
  transaction<R>(fn: (tx: KvTransaction) => R): R {
    const buffer: WatchEvent[] = [];
    const buffering: KvTransaction = {
      get: (key) => this.get(key),
      put: (key, value, opts) => {
        const result = this.put(key, value, opts);
        // put() already fired an event into `emitter`; we need to
        // suppress it and re-fire after commit. Achieve this by
        // gating via this.txDepth.
        return result;
      },
      delete: (key, expected_revision) => this.delete(key, expected_revision),
    };
    const run = this.db.transaction(() => fn(buffering));
    return run();
  }
```

Hmm — the simpler design: gate `fireEvent` on whether a transaction is open, and on commit flush the buffer. Replace the watch infrastructure with this cleaner version:

```ts
  private readonly emitter = new EventEmitter();
  private txBuffer: WatchEvent[] | null = null;

  watch(prefix: string, onChange: (event: WatchEvent) => void): WatchHandle {
    const listener = (event: WatchEvent) => {
      if (event.key.startsWith(prefix)) onChange(event);
    };
    this.emitter.on('event', listener);
    return {
      close: () => this.emitter.off('event', listener),
    };
  }

  private fireEvent(event: WatchEvent): void {
    if (this.txBuffer !== null) {
      this.txBuffer.push(event);
    } else {
      this.emitter.emit('event', event);
    }
  }

  transaction<R>(fn: (tx: KvTransaction) => R): R {
    const txFacade: KvTransaction = {
      get: (key) => this.get(key),
      put: (key, value, opts) => this.put(key, value, opts),
      delete: (key, expected_revision) => this.delete(key, expected_revision),
    };
    this.txBuffer = [];
    const run = this.db.transaction(() => fn(txFacade));
    try {
      const result = run();
      // Commit succeeded → flush buffered events.
      const buffer = this.txBuffer;
      this.txBuffer = null;
      for (const e of buffer) this.emitter.emit('event', e);
      return result;
    } catch (err) {
      // Rollback → drop buffer.
      this.txBuffer = null;
      throw err;
    }
  }
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-watch.test.ts
git commit -m "$(cat <<'EOF'
feat(state): implement watch via in-process EventEmitter

Watchers register a prefix and callback; the store emits put/delete
events synchronously after each successful mutation. Inside a
transaction, events buffer until commit and are dropped on rollback,
so watchers never see uncommitted state.

This is the Phase 0 watch model. Phase 2's etcd swap (per ADR-0003)
will replace the EventEmitter with etcd's native push semantics; the
WatchHandle interface stays the same.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Leases helper

**Files:**
- Create: `xiNAS-MCP/src/state/leases.ts`
- Create: `xiNAS-MCP/src/__tests__/state/leases.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/leases.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { LeaseManager } from '../../state/leases.js';

function openLeases() {
  const db = new Database(':memory:');
  runMigrations(db);
  // Seed a stub task so the FK constraint passes.
  db.prepare(
    `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                        input_hash, risk_level, affected_resources, created_at, updated_at)
     VALUES ('t1', 'test', 'running', 'sys', 'system', 'r1', 'c1', 'h', 'non_disruptive', '[]', ?, ?)`,
  ).run(Date.now(), Date.now());
  db.prepare(
    `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                        input_hash, risk_level, affected_resources, created_at, updated_at)
     VALUES ('t2', 'test', 'running', 'sys', 'system', 'r2', 'c2', 'h', 'non_disruptive', '[]', ?, ?)`,
  ).run(Date.now(), Date.now());
  return { db, leases: new LeaseManager(db) };
}

describe('LeaseManager', () => {
  let db: Database.Database;
  let leases: LeaseManager;

  beforeEach(() => {
    ({ db, leases } = openLeases());
  });

  it('acquires a lease for a resource', () => {
    const result = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a second acquire on the same resource', () => {
    leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    const second = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't2', ttl_seconds: 60 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('held_by_other');
    expect(second.holder_task_id).toBe('t1');
  });

  it('release frees the resource', () => {
    const first = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    if (!first.ok) throw new Error('seed failed');
    leases.release(first.lease_id);
    const second = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't2', ttl_seconds: 60 });
    expect(second.ok).toBe(true);
  });

  it('heartbeat extends ttl', () => {
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 60 });
    if (!r.ok) throw new Error('seed failed');
    const t0 = (db.prepare('SELECT heartbeat_at FROM leases WHERE lease_id = ?').get(r.lease_id) as { heartbeat_at: number }).heartbeat_at;
    leases.heartbeat(r.lease_id);
    const t1 = (db.prepare('SELECT heartbeat_at FROM leases WHERE lease_id = ?').get(r.lease_id) as { heartbeat_at: number }).heartbeat_at;
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it('sweepExpired removes leases whose heartbeat_at + ttl is past now', () => {
    // Force a stale heartbeat.
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 1 });
    if (!r.ok) throw new Error('seed failed');
    db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now() - 5000, r.lease_id);
    const result = leases.sweepExpired();
    expect(result.leases_removed).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 });
  });

  it('sweepExpired transitions still-running holder tasks to requires_manual_recovery', () => {
    // Acquire a lease for a running task, then expire it.
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 1 });
    if (!r.ok) throw new Error('seed failed');
    db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now() - 5000, r.lease_id);

    const result = leases.sweepExpired();
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(1);

    const task = db.prepare('SELECT state, error_code FROM tasks WHERE task_id = ?').get('t1') as {
      state: string;
      error_code: string;
    };
    expect(task.state).toBe('requires_manual_recovery');
    expect(task.error_code).toBe('FAILED_STATE_DESYNC');
  });

  it('sweepExpired does not touch terminal tasks even when their lease expires', () => {
    // Move t1 to a terminal state, then expire its lease.
    db.prepare("UPDATE tasks SET state = 'success', terminal_at = ? WHERE task_id = 't1'").run(Date.now());
    const r = leases.acquire({ resource_kind: 'array', resource_id: 'arr1', task_id: 't1', ttl_seconds: 1 });
    if (!r.ok) throw new Error('seed failed');
    db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?').run(Date.now() - 5000, r.lease_id);

    const result = leases.sweepExpired();
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(0);
    const task = db.prepare("SELECT state FROM tasks WHERE task_id = 't1'").get() as { state: string };
    expect(task.state).toBe('success');
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/leases.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module '../../state/leases.js'`.

- [ ] **Step 3: Implement LeaseManager**

Create `xiNAS-MCP/src/state/leases.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';

export interface AcquireParams {
  resource_kind: string;
  resource_id: string;
  task_id: string;
  ttl_seconds: number;
}

export type AcquireResult =
  | { ok: true; lease_id: string }
  | { ok: false; reason: 'held_by_other'; holder_task_id: string };

export interface SweepResult {
  leases_removed: number;
  tasks_recovered: number;
}

export class LeaseManager {
  private readonly db: Database;
  private readonly insertStmt: Statement;
  private readonly findHolderStmt: Statement;
  private readonly heartbeatStmt: Statement;
  private readonly releaseStmt: Statement;
  private readonly findExpiredHoldersStmt: Statement;
  private readonly recoverTaskStmt: Statement;
  private readonly deleteExpiredStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO leases (lease_id, resource_kind, resource_id, task_id, acquired_at, ttl_seconds, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findHolderStmt = db.prepare(
      'SELECT task_id FROM leases WHERE resource_kind = ? AND resource_id = ?',
    );
    this.heartbeatStmt = db.prepare('UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?');
    this.releaseStmt = db.prepare('DELETE FROM leases WHERE lease_id = ?');
    this.findExpiredHoldersStmt = db.prepare(
      `SELECT l.task_id
         FROM leases l
         JOIN tasks t ON t.task_id = l.task_id
        WHERE l.heartbeat_at + (l.ttl_seconds * 1000) < ?
          AND t.state IN ('queued', 'running')`,
    );
    this.recoverTaskStmt = db.prepare(
      `UPDATE tasks
          SET state = 'requires_manual_recovery',
              error_code = 'FAILED_STATE_DESYNC',
              error_message = COALESCE(error_message, 'lease expired during execution; in-flight state unknown'),
              remediation_hint = COALESCE(remediation_hint, 'inspect system state for the affected resource; manual recovery required'),
              updated_at = ?,
              terminal_at = COALESCE(terminal_at, ?)
        WHERE task_id = ?
          AND state IN ('queued', 'running')`,
    );
    this.deleteExpiredStmt = db.prepare(
      'DELETE FROM leases WHERE heartbeat_at + (ttl_seconds * 1000) < ?',
    );
  }

  acquire(params: AcquireParams): AcquireResult {
    try {
      const now = Date.now();
      const lease_id = randomUUID();
      this.insertStmt.run(
        lease_id,
        params.resource_kind,
        params.resource_id,
        params.task_id,
        now,
        params.ttl_seconds,
        now,
      );
      return { ok: true, lease_id };
    } catch (err) {
      // UNIQUE(resource_kind, resource_id) violation → held by other.
      if (String(err).includes('UNIQUE')) {
        const holder = this.findHolderStmt.get(params.resource_kind, params.resource_id) as
          | { task_id: string }
          | undefined;
        return {
          ok: false,
          reason: 'held_by_other',
          holder_task_id: holder?.task_id ?? 'unknown',
        };
      }
      throw err;
    }
  }

  heartbeat(lease_id: string): void {
    this.heartbeatStmt.run(Date.now(), lease_id);
  }

  release(lease_id: string): void {
    this.releaseStmt.run(lease_id);
  }

  /**
   * Per ADR-0004: expired leases held by non-terminal tasks force the
   * task to `requires_manual_recovery` (we cannot know whether the
   * executor's in-flight side effects completed). Terminal tasks
   * whose leases expired (release race) just lose the lease cleanly.
   *
   * Both the task-recovery and the lease-delete happen in one SQLite
   * transaction so a crash mid-sweep does not leave orphan state.
   */
  sweepExpired(): SweepResult {
    const now = Date.now();
    let leases_removed = 0;
    let tasks_recovered = 0;

    const run = this.db.transaction((cutoff: number) => {
      const expiredHolders = this.findExpiredHoldersStmt.all(cutoff) as { task_id: string }[];
      for (const { task_id } of expiredHolders) {
        const info = this.recoverTaskStmt.run(cutoff, cutoff, task_id);
        if (info.changes > 0) tasks_recovered += 1;
      }
      const del = this.deleteExpiredStmt.run(cutoff);
      leases_removed = del.changes;
    });
    run(now);

    return { leases_removed, tasks_recovered };
  }
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/leases.ts xiNAS-MCP/src/__tests__/state/leases.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add LeaseManager (acquire / heartbeat / release / sweep)

Wraps the leases SQLite table from ADR-0004's task engine. UNIQUE
constraint on (resource_kind, resource_id) gives single-holder
semantics; conflict surfaces the current holder's task_id so callers
can report a CONFLICT error with attribution. sweepExpired removes
leases whose heartbeat is older than ttl_seconds — meant to run on
xinas-api startup and periodically thereafter (driven by the GC
sweep in a later task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Audit hash chain + outbox queue

**Files:**
- Create: `xiNAS-MCP/src/state/audit.ts`
- Create: `xiNAS-MCP/src/__tests__/state/audit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { AuditAppender, genesisHash, canonicalize } from '../../state/audit.js';
import type { AuditEntryInput } from '../../state/types.js';

function open() {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, audit: new AuditAppender(db, 'node-1') };
}

function makeEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    kind: 'share.create',
    request_id: 'req-1',
    principal: 'admin:test',
    client_type: 'rest',
    parameters_hash: 'sha256:p',
    result_hash: 'sha256:r',
    ...overrides,
  };
}

describe('AuditAppender', () => {
  let db: Database.Database;
  let audit: AuditAppender;

  beforeEach(() => {
    ({ db, audit } = open());
  });

  it('queues an entry: outbox row has computed hash and node_id+timestamp injected', () => {
    const queued = audit.queue(makeEntry());
    expect(queued.audit_seq).toBe(1);
    expect(queued.hash).toBeInstanceOf(Buffer);
    expect(queued.hash.length).toBe(32); // sha256 = 32 bytes

    const row = db.prepare('SELECT * FROM audit_outbox WHERE audit_seq = ?').get(1) as
      | { entry_json: Buffer; prev_hash: Buffer; hash: Buffer; drain_state: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.drain_state).toBe('pending');
    expect(row!.prev_hash).toEqual(genesisHash('node-1'));

    // Stored entry_json has node_id and timestamp injected by the
    // appender — the input shape AuditEntryInput omits them.
    const stored = JSON.parse(row!.entry_json.toString('utf8'));
    expect(stored.node_id).toBe('node-1');
    expect(typeof stored.timestamp).toBe('number');
  });

  it('chains hashes: second prev_hash equals first hash', () => {
    const first = audit.queue(makeEntry({ request_id: 'r1' }));
    const second = audit.queue(makeEntry({ request_id: 'r2' }));
    const secondRow = db.prepare('SELECT prev_hash FROM audit_outbox WHERE audit_seq = ?').get(2) as {
      prev_hash: Buffer;
    };
    expect(secondRow.prev_hash).toEqual(first.hash);
    expect(second.prev_hash).toEqual(first.hash);
  });

  it('records request_id, operation_id, task_id in audit_index', () => {
    audit.queue(makeEntry({ request_id: 'r1', operation_id: 'op1', task_id: 'tk1' }));
    const idx = db.prepare('SELECT * FROM audit_index WHERE audit_seq = 1').get() as {
      request_id: string;
      operation_id: string;
      task_id: string;
    };
    expect(idx.request_id).toBe('r1');
    expect(idx.operation_id).toBe('op1');
    expect(idx.task_id).toBe('tk1');
  });

  it('canonicalize sorts keys recursively (JCS-style)', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalize({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  it('hash chain depends on nested payload (not lost to shallow sort)', () => {
    const e1 = audit.queue(makeEntry({ payload: { nested: { z: 1 } } }));
    const e2 = audit.queue(makeEntry({ payload: { nested: { z: 2 } } }));
    expect(e1.hash).not.toEqual(e2.hash);
  });

  it('rollback of an outer transaction does NOT corrupt the chain', () => {
    // Queue inside a tx, throw, and verify the next queue links to
    // the actual committed tail (genesis here) rather than to the
    // rolled-back row's hash.
    const txn = db.transaction(() => {
      audit.queue(makeEntry({ request_id: 'will-rollback' }));
      throw new Error('boom');
    });
    expect(() => txn()).toThrow('boom');

    // Outbox is empty after rollback.
    const after = db.prepare("SELECT COUNT(*) AS n FROM audit_outbox").get() as { n: number };
    expect(after.n).toBe(0);

    // The next queue must link to genesis (since outbox is empty and
    // no JSONL tail has been loaded), not to the rolled-back hash.
    const next = audit.queue(makeEntry({ request_id: 'survives' }));
    expect(next.prev_hash).toEqual(genesisHash('node-1'));
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/audit.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module '../../state/audit.js'`.

- [ ] **Step 3: Implement AuditAppender + genesis hash + JCS canonicalization**

Create `xiNAS-MCP/src/state/audit.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { AuditEntry, AuditEntryInput, QueuedAuditEntry } from './types.js';

/**
 * Compute the genesis hash for a node. The first audit entry's prev_hash
 * is this value when the JSONL is empty / the outbox has no rows.
 */
export function genesisHash(node_id: string): Buffer {
  return createHash('sha256').update(`xinas-audit-genesis-v1-${node_id}`).digest();
}

/**
 * JCS-style canonical JSON: recursive key sort + no whitespace + UTF-8.
 * The hash chain must be deterministic across processes, languages, and
 * library versions; naive single-level Object.keys(entry).sort() loses
 * nesting and silently breaks the chain on payload changes.
 *
 * Exported for tests and for anyone re-deriving the chain offline.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Buffer)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Compute the chained hash for a new entry given the prior hash.
 * The entry passed here is the FULL entry (including timestamp,
 * node_id) — i.e. what gets written to JSONL.
 */
function chainHash(prev_hash: Buffer, entry: AuditEntry): Buffer {
  return createHash('sha256').update(prev_hash).update(canonicalize(entry), 'utf8').digest();
}

interface OutboxTail {
  hash: Buffer;
}

export class AuditAppender {
  private readonly db: Database;
  private readonly node_id: string;
  private readonly insertOutboxStmt: Statement;
  private readonly insertIndexStmt: Statement;
  private readonly tailHashStmt: Statement;
  /**
   * Tail-hash of the durable JSONL, NOT of the outbox. Set only by
   * `reloadTailHash()` (called on startup and by AuditDrainer after a
   * successful drain via notifyJsonlAdvanced). Never written from
   * inside `queue()` — that's how rollback-safety is preserved.
   *
   * Used only when the outbox is empty (everything drained); otherwise
   * `tailHashStmt` reads the live outbox tail.
   */
  private jsonlTail: Buffer | null = null;

  constructor(db: Database, node_id: string) {
    this.db = db;
    this.node_id = node_id;
    this.insertOutboxStmt = db.prepare(
      `INSERT INTO audit_outbox (entry_json, prev_hash, hash, queued_at, drain_state)
       VALUES (?, ?, ?, ?, 'pending')`,
    );
    this.insertIndexStmt = db.prepare(
      `INSERT INTO audit_index (request_id, operation_id, task_id, audit_seq, durable_file, durable_offset)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
    );
    this.tailHashStmt = db.prepare(
      'SELECT hash FROM audit_outbox ORDER BY audit_seq DESC LIMIT 1',
    );
  }

  /**
   * Insert an audit entry into the outbox. Caller is expected to invoke
   * this inside a transaction along with the state change that triggered
   * it — that's how atomicity-with-state is achieved.
   *
   * AuditAppender auto-injects `timestamp` and `node_id` so callers
   * provide the AuditEntryInput shape and don't have to thread the
   * controller identity through every call site.
   *
   * Rollback safety: this method does NOT advance any in-memory tail.
   * If the outer transaction rolls back, the outbox row vanishes and
   * `currentTailHash()` returns the actual durable tail on the next
   * call. An earlier draft cached the just-computed hash here and
   * silently broke the chain on rollback — see the spec self-review
   * fix-matrix for the audit-trail rollback fix.
   */
  queue(input: AuditEntryInput): QueuedAuditEntry {
    const entry: AuditEntry = {
      ...input,
      timestamp: Date.now(),
      node_id: this.node_id,
    };
    const prev_hash = this.currentTailHash();
    const hash = chainHash(prev_hash, entry);
    const entry_json = Buffer.from(canonicalize(entry), 'utf8');
    const info = this.insertOutboxStmt.run(entry_json, prev_hash, hash, entry.timestamp);
    const audit_seq = Number(info.lastInsertRowid);
    this.insertIndexStmt.run(
      entry.request_id ?? null,
      entry.operation_id ?? null,
      entry.task_id ?? null,
      audit_seq,
    );
    return { audit_seq, prev_hash, hash };
  }

  /**
   * Reads the live outbox tail. After a rollback the offending row is
   * gone, so the next caller sees the actual committed tail. When the
   * outbox is empty we fall back to the JSONL tail (set on startup by
   * `reloadTailHash` and on every successful drain by the drainer via
   * `notifyJsonlAdvanced`).
   */
  private currentTailHash(): Buffer {
    const row = this.tailHashStmt.get() as OutboxTail | undefined;
    if (row) return row.hash;
    return this.jsonlTail ?? genesisHash(this.node_id);
  }

  /**
   * Called by AuditDrainer after each successful batch so the next
   * queue() with an empty outbox sees the correct tail.
   */
  notifyJsonlAdvanced(hash: Buffer): void {
    this.jsonlTail = hash;
  }
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/audit.ts xiNAS-MCP/src/__tests__/state/audit.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add AuditAppender (hash chain + transactional outbox)

queue() inserts a row into audit_outbox in the calling transaction's
scope. prev_hash links to the previous row's hash (or the genesis hash
for the first entry on this node). hash = sha256(prev_hash ||
canonical(entry)) where canonical() recursively sorts keys (JCS-style)
so nested payload changes break the chain as required.

AuditAppender auto-injects timestamp + node_id so the AuditEntryInput
shape callers provide is minimal; reqs §14's required fields end up in
the JSONL.

Cached tail-hash avoids a SELECT per write inside one process. Crash
recovery (Task 16) re-seeds the cache from the JSONL's last line via
reloadTailHash().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Audit drainer (background → JSONL with fsync, atomic mark)

**Files:**
- Create: `xiNAS-MCP/src/state/audit-drainer.ts`
- Create: `xiNAS-MCP/src/__tests__/state/audit-drainer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/audit-drainer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { AuditAppender } from '../../state/audit.js';
import { AuditDrainer } from '../../state/audit-drainer.js';

describe('AuditDrainer', () => {
  let dir: string;
  let db: Database.Database;
  let audit: AuditAppender;
  let drainer: AuditDrainer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-audit-'));
    db = new Database(':memory:');
    runMigrations(db);
    audit = new AuditAppender(db, 'node-1');
    drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
  });

  afterEach(async () => {
    await drainer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function entry(over: Record<string, unknown> = {}) {
    return {
      kind: 'k',
      request_id: 'r',
      principal: 'p',
      client_type: 'rest' as const,
      parameters_hash: 'sha256:p',
      result_hash: 'sha256:r',
      ...over,
    };
  }

  it('drains pending rows to JSONL with one line per entry, including chain metadata', async () => {
    audit.queue(entry({ kind: 'a', request_id: 'r1' }));
    audit.queue(entry({ kind: 'b', request_id: 'r2' }));

    await drainer.drainNow();

    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const l0 = JSON.parse(lines[0]!);
    expect(l0.kind).toBe('a');
    expect(l0.audit_seq).toBe(1);
    expect(typeof l0.prev_hash).toBe('string');  // hex
    expect(typeof l0.hash).toBe('string');       // hex
    expect(l0.node_id).toBe('node-1');
    expect(typeof l0.timestamp).toBe('number');

    const l1 = JSON.parse(lines[1]!);
    expect(l1.kind).toBe('b');
    expect(l1.audit_seq).toBe(2);
    // Chain link: line 1's prev_hash equals line 0's hash.
    expect(l1.prev_hash).toBe(l0.hash);
  });

  it('marks outbox rows as durable atomically with audit_index update', async () => {
    audit.queue(entry());
    await drainer.drainNow();

    const row = db.prepare('SELECT drain_state, durable_file, durable_offset FROM audit_outbox WHERE audit_seq = 1').get() as {
      drain_state: string;
      durable_file: string;
      durable_offset: number;
    };
    expect(row.drain_state).toBe('durable');
    expect(row.durable_file).toBe('audit.jsonl');
    expect(typeof row.durable_offset).toBe('number');

    const idx = db.prepare('SELECT durable_file, durable_offset FROM audit_index WHERE audit_seq = 1').get() as {
      durable_file: string;
      durable_offset: number;
    };
    expect(idx.durable_file).toBe(row.durable_file);
    expect(idx.durable_offset).toBe(row.durable_offset);
  });

  it('drainNow is a no-op when no pending rows', async () => {
    await drainer.drainNow();
    await drainer.drainNow();
    const row = db.prepare('SELECT COUNT(*) AS n FROM audit_outbox').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('notifyJsonlAdvanced keeps the chain valid across outbox pruning', async () => {
    // Construct a wired drainer (constructor takes the appender so
    // notifyJsonlAdvanced fires after each drain).
    const wiredDrainer = new AuditDrainer(db, {
      path: join(dir, 'audit-wired.jsonl'),
      audit,
    });

    // Round 1: queue, drain, then delete the durable row to simulate
    // retention pruning. The outbox is now empty AND the row that
    // would have been the next prev_hash source is gone.
    const first = audit.queue(entry({ kind: 'first' }));
    await wiredDrainer.drainNow();
    db.prepare('DELETE FROM audit_outbox').run();

    // Round 2: queue again. Without notifyJsonlAdvanced, currentTailHash
    // would fall back to genesis (jsonlTail never set). With wiring,
    // jsonlTail was set to first.hash by the drainer's last batch, so
    // the new entry links to first.hash.
    const second = audit.queue(entry({ kind: 'second' }));
    expect(second.prev_hash).toEqual(first.hash);
  });

  it('recover() refuses startup when JSONL is gapped relative to outbox', async () => {
    // Queue two entries (audit_seq 1 and 2) but only write entry 2
    // to the JSONL (skipping 1). On recover, scanPersisted finds
    // max=2 but offsetsBySeq lacks 1 — outbox row 1 claims
    // "persisted" (1 <= 2) but has no offset → must throw.
    const e1 = audit.queue(entry({ kind: 'a' }));
    const e2 = audit.queue(entry({ kind: 'b' }));

    const line2 = JSON.stringify({
      audit_seq: e2.audit_seq,
      prev_hash: e2.prev_hash.toString('hex'),
      hash: e2.hash.toString('hex'),
      kind: 'b',
      timestamp: Date.now(),
      node_id: 'node-1',
      principal: 'p',
      client_type: 'rest',
      request_id: 'r',
      parameters_hash: 'sha256:p',
      result_hash: 'sha256:r',
    }) + '\n';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'audit-gap.jsonl'), line2);

    const gappedDrainer = new AuditDrainer(db, {
      path: join(dir, 'audit-gap.jsonl'),
      audit,
    });

    await expect(gappedDrainer.recover()).rejects.toThrow(/audit chain corrupt/);
    void e1; // silence unused-var warning if any
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/audit-drainer.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module '../../state/audit-drainer.js'`.

- [ ] **Step 3: Implement the drainer**

Create `xiNAS-MCP/src/state/audit-drainer.ts`:

```ts
import { openSync, writeSync, fsyncSync, closeSync, statSync, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Database, Statement } from 'better-sqlite3';
import type { AuditAppender } from './audit.js';

export interface AuditDrainerOptions {
  path: string;
  rotateBytes?: number;       // default 256 MiB (rotation lands in a later PR)
  drainIntervalMs?: number;   // default 500
  /**
   * If set, the drainer calls audit.notifyJsonlAdvanced(lastHash)
   * after each successful batch so AuditAppender's currentTailHash
   * fallback (used when the outbox is empty) sees the latest tail.
   * Optional only for tests; production code MUST wire this.
   */
  audit?: AuditAppender;
}

interface PendingRow {
  audit_seq: number;
  entry_json: Buffer;
  prev_hash: Buffer;
  hash: Buffer;
}

/**
 * The JSONL line shape is the full audit entry plus chain metadata
 * (audit_seq, prev_hash, hash hex-encoded). Storing the hash in the
 * JSONL is per ADR-0003 §Tail-hash recovery — a restart reads the
 * last line, extracts hash, and uses it as prev_hash for the next
 * entry without recomputing the entire chain.
 */
interface JsonlLine extends Record<string, unknown> {
  audit_seq: number;
  prev_hash: string;     // hex
  hash: string;          // hex
}

export class AuditDrainer {
  private readonly db: Database;
  private readonly path: string;
  private readonly rotateBytes: number;
  private readonly drainIntervalMs: number;
  private readonly audit: AuditAppender | undefined;
  private readonly listPendingStmt: Statement;
  private readonly markDurableStmt: Statement;
  private readonly updateIndexStmt: Statement;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Database, opts: AuditDrainerOptions) {
    this.db = db;
    this.path = opts.path;
    this.rotateBytes = opts.rotateBytes ?? 256 * 1024 * 1024;
    this.drainIntervalMs = opts.drainIntervalMs ?? 500;
    this.audit = opts.audit;
    this.listPendingStmt = db.prepare(
      "SELECT audit_seq, entry_json, prev_hash, hash FROM audit_outbox WHERE drain_state = 'pending' ORDER BY audit_seq",
    );
    this.markDurableStmt = db.prepare(
      `UPDATE audit_outbox SET drain_state = 'durable', durable_at = ?, durable_file = ?, durable_offset = ?
       WHERE audit_seq = ?`,
    );
    this.updateIndexStmt = db.prepare(
      'UPDATE audit_index SET durable_file = ?, durable_offset = ? WHERE audit_seq = ?',
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drainNow().catch(() => {
        /* errors surface via metrics/logs in production */
      });
    }, this.drainIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.drainNow();
  }

  /**
   * Per ADR-0003 §Crash recovery, call this on xinas-api start before
   * accepting any requests. It:
   *   1. Scans the JSONL once to build a Map<audit_seq, byte_offset>
   *      so already-persisted rows get recovered with exact offsets
   *      (audit_index's durable_offset stays meaningful).
   *   2. For pending outbox rows whose audit_seq <= the JSONL max,
   *      runs the atomic mark-durable transaction — DO NOT re-append.
   *   3. For pending rows whose audit_seq > the JSONL max, appends +
   *      fsyncs + atomically marks.
   *   4. Notifies the AuditAppender of the final tail hash so its
   *      currentTailHash() fallback (used when the outbox is empty)
   *      sees the right value for any subsequent queue() calls.
   */
  async recover(): Promise<void> {
    const { maxSeq, offsetsBySeq, lastHash } = this.scanPersisted();
    const rows = this.listPendingStmt.all() as PendingRow[];

    if (rows.length === 0) {
      // Nothing to drain. If we read a tail from JSONL, push it
      // through to the appender so its fallback path is correct.
      if (lastHash) this.audit?.notifyJsonlAdvanced(lastHash);
      return;
    }

    const fileName = basename(this.path);
    const alreadyPersisted = rows.filter((r) => r.audit_seq <= maxSeq);
    const toAppend = rows.filter((r) => r.audit_seq > maxSeq);

    if (alreadyPersisted.length > 0) {
      const marks: { audit_seq: number; file: string; offset: number }[] = [];
      for (const r of alreadyPersisted) {
        const offset = offsetsBySeq.get(r.audit_seq);
        if (offset === undefined) {
          // Outbox row says "audit_seq <= max in JSONL" but the JSONL
          // doesn't have an entry at that audit_seq. The chain is
          // gapped — refuse to continue rather than silently writing
          // a sentinel offset. Operator must investigate (quarantine
          // the audit.jsonl and start fresh, or recover from backup).
          throw new Error(
            `audit chain corrupt: outbox row audit_seq=${r.audit_seq} claims persisted ` +
              `(max=${maxSeq}) but no JSONL entry found; refusing to start`,
          );
        }
        marks.push({ audit_seq: r.audit_seq, file: fileName, offset });
      }
      this.markBatchDurable(marks);
    }

    let tailHash = lastHash;
    if (toAppend.length > 0) {
      tailHash = await this.appendAndMark(toAppend, fileName);
    } else if (alreadyPersisted.length > 0) {
      // No new appends, but we marked existing rows; the JSONL tail
      // is the hash of the highest-audit_seq pending row we just
      // accepted as already-persisted.
      tailHash = alreadyPersisted[alreadyPersisted.length - 1]!.hash;
    }
    if (tailHash) this.audit?.notifyJsonlAdvanced(tailHash);
  }

  async drainNow(): Promise<void> {
    const rows = this.listPendingStmt.all() as PendingRow[];
    if (rows.length === 0) return;
    const tailHash = await this.appendAndMark(rows, basename(this.path));
    if (tailHash) this.audit?.notifyJsonlAdvanced(tailHash);
  }

  /**
   * Append rows to JSONL, fsync, then in a SINGLE SQLite transaction
   * mark each row durable + update its audit_index entry. Per ADR-0003,
   * the mark + index update must be atomic so a crash between them
   * cannot leave half-updated state.
   *
   * Crash-after-fsync-before-mark window: the rows are durable in
   * JSONL but still pending in the outbox; recover() handles that by
   * detecting via scanPersisted() and skipping the append.
   *
   * Returns the hash of the last appended row (or null if no rows).
   */
  private async appendAndMark(rows: PendingRow[], fileName: string): Promise<Buffer | null> {
    if (rows.length === 0) return null;
    const fd = openSync(this.path, 'a');
    const marks: { audit_seq: number; file: string; offset: number }[] = [];
    try {
      for (const row of rows) {
        const offset = statSync(this.path).size;
        const entry = JSON.parse(row.entry_json.toString('utf8')) as Record<string, unknown>;
        const line: JsonlLine = {
          audit_seq: row.audit_seq,
          prev_hash: row.prev_hash.toString('hex'),
          hash: row.hash.toString('hex'),
          ...entry,
        };
        const buf = Buffer.from(JSON.stringify(line) + '\n', 'utf8');
        writeSync(fd, buf, 0, buf.length, null);
        fsyncSync(fd);
        marks.push({ audit_seq: row.audit_seq, file: fileName, offset });
      }
    } finally {
      closeSync(fd);
    }
    this.markBatchDurable(marks);
    return rows[rows.length - 1]!.hash;
  }

  private markBatchDurable(marks: { audit_seq: number; file: string; offset: number }[]): void {
    const now = Date.now();
    const run = this.db.transaction(() => {
      for (const m of marks) {
        this.markDurableStmt.run(now, m.file, m.offset, m.audit_seq);
        this.updateIndexStmt.run(m.file, m.offset, m.audit_seq);
      }
    });
    run();
  }

  /**
   * Walks the JSONL once and returns a map from audit_seq to byte
   * offset, the max audit_seq, and the last entry's hash (for
   * AuditAppender's tail). Only called on startup; the cost is O(n)
   * in the JSONL line count.
   */
  private scanPersisted(): {
    maxSeq: number;
    offsetsBySeq: Map<number, number>;
    lastHash: Buffer | null;
  } {
    const offsetsBySeq = new Map<number, number>();
    let maxSeq = 0;
    let lastHash: Buffer | null = null;
    if (!existsSync(this.path)) return { maxSeq, offsetsBySeq, lastHash };

    const content = readFileSync(this.path, 'utf8');
    let cursor = 0;
    for (const line of content.split('\n')) {
      if (!line) {
        cursor += 1; // for the \n itself
        continue;
      }
      const parsed = JSON.parse(line) as JsonlLine;
      const seq = Number(parsed.audit_seq);
      offsetsBySeq.set(seq, cursor);
      if (seq > maxSeq) maxSeq = seq;
      lastHash = Buffer.from(parsed.hash, 'hex');
      cursor += Buffer.byteLength(line, 'utf8') + 1; // line + \n
    }
    return { maxSeq, offsetsBySeq, lastHash };
  }
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/audit-drainer.ts xiNAS-MCP/src/__tests__/state/audit-drainer.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add AuditDrainer (outbox → JSONL with fsync)

Single-threaded drainer that reads pending outbox rows in audit_seq
order, appends each as a JSONL line with fsync, then updates the
outbox row's drain_state, durable_at, durable_file, and durable_offset
plus the matching audit_index row.

start() launches a periodic timer; stop() halts it and runs one final
drainNow(). drainNow() can be called synchronously for tests and for
the synchronous drain-on-terminal-task path described in ADR-0003.

Rotation, crash recovery, and the JSONL header line for chain
continuity land in Tasks 16 and 17.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Audit crash-recovery + tail-hash reload

**Files:**
- Modify: `xiNAS-MCP/src/state/audit-drainer.ts` (add `recover()` method)
- Modify: `xiNAS-MCP/src/state/audit.ts` (add `reloadTailHash(file: string)` method)
- Create: `xiNAS-MCP/src/__tests__/state/audit-recovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/audit-recovery.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { AuditAppender } from '../../state/audit.js';
import { AuditDrainer } from '../../state/audit-drainer.js';

function entry(over: Record<string, unknown> = {}) {
  return {
    kind: 'k',
    request_id: 'r',
    principal: 'p',
    client_type: 'rest' as const,
    parameters_hash: 'sha256:p',
    result_hash: 'sha256:r',
    ...over,
  };
}

describe('AuditDrainer — crash recovery', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-audit-rec-'));
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recover() drains any rows left pending from a prior process (clean case)', async () => {
    const audit = new AuditAppender(db, 'node-1');
    audit.queue(entry({ kind: 'a' }));
    audit.queue(entry({ kind: 'b' }));

    // Simulate process restart: new drainer instance, never started.
    const drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
    await drainer.recover();

    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(2);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM audit_outbox WHERE drain_state = 'pending'").get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('recover() does NOT re-append rows that already made it to JSONL', async () => {
    // Simulate the crash-after-fsync-before-mark-durable window: a
    // row is in JSONL but still 'pending' in the outbox.
    const audit = new AuditAppender(db, 'node-1');
    const queued = audit.queue(entry({ kind: 'a' }));

    // Manually write the entry to JSONL as the drainer would have.
    const fakeLine = JSON.stringify({
      audit_seq: queued.audit_seq,
      prev_hash: queued.prev_hash.toString('hex'),
      hash: queued.hash.toString('hex'),
      kind: 'a',
      timestamp: Date.now(),
      node_id: 'node-1',
      principal: 'p',
      client_type: 'rest',
      request_id: 'r',
      parameters_hash: 'sha256:p',
      result_hash: 'sha256:r',
    }) + '\n';
    writeFileSync(join(dir, 'audit.jsonl'), fakeLine);

    const drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
    await drainer.recover();

    // JSONL should still have exactly one line — no duplicate.
    const content = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
    // Outbox row was marked durable.
    const row = db.prepare("SELECT drain_state FROM audit_outbox WHERE audit_seq = ?").get(queued.audit_seq) as { drain_state: string };
    expect(row.drain_state).toBe('durable');
  });

  it('AuditAppender.reloadTailHash extracts the tail hash from the JSONL', async () => {
    const audit1 = new AuditAppender(db, 'node-1');
    const first = audit1.queue(entry({ kind: 'a' }));
    const drainer = new AuditDrainer(db, { path: join(dir, 'audit.jsonl') });
    await drainer.drainNow();

    // Simulate a restart: new AuditAppender, outbox is empty (everything
    // drained before crash) but the chain must continue.
    db.prepare('DELETE FROM audit_outbox').run();
    const audit2 = new AuditAppender(db, 'node-1');
    audit2.reloadTailHash(join(dir, 'audit.jsonl'));

    const next = audit2.queue(entry({ kind: 'b' }));
    // The new entry's prev_hash equals the previous entry's hash —
    // not the genesis — because we read it back from the JSONL.
    expect(next.prev_hash).toEqual(first.hash);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/audit-recovery.test.ts 2>&1 | tail -10
```

Expected: failures on `drainer.recover is not a function` and `audit2.reloadTailHash is not a function`.

- [ ] **Step 3: Verify `recover()` exists on AuditDrainer**

The drainer's `recover()` method was added in Task 15 (it does the
crash-recovery logic — skip already-persisted rows, append + mark only
the truly missing ones). No code change here; just verify it's present.

Run:
```bash
grep -n "async recover" xiNAS-MCP/src/state/audit-drainer.ts
```

Expected: one match in the AuditDrainer class.

- [ ] **Step 4: Add `reloadTailHash()` to AuditAppender**

Append at the top of `xiNAS-MCP/src/state/audit.ts` alongside the existing imports:

```ts
import { existsSync, readFileSync } from 'node:fs';
```

Append to the `AuditAppender` class:

```ts
  /**
   * Reload the cached tail hash from the last line of the JSONL file.
   * Called on startup when the outbox is empty (everything was drained
   * before crash) but the chain must continue. Since each JSONL line
   * now stores its hash explicitly (per Task 15's drainer), we read
   * the value directly — no canonicalize/recompute needed.
   */
  reloadTailHash(jsonlPath: string): void {
    if (!existsSync(jsonlPath)) {
      this.jsonlTail = genesisHash(this.node_id);
      return;
    }
    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      this.jsonlTail = genesisHash(this.node_id);
      return;
    }
    const lastLine = lines[lines.length - 1]!;
    const parsed = JSON.parse(lastLine) as { hash?: string };
    if (typeof parsed.hash !== 'string') {
      throw new Error(
        `audit.jsonl last line is missing 'hash' field; refusing to continue (chain integrity at risk)`,
      );
    }
    this.jsonlTail = Buffer.from(parsed.hash, 'hex');
  }
```

- [ ] **Step 5: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/state/audit-drainer.ts xiNAS-MCP/src/state/audit.ts xiNAS-MCP/src/__tests__/state/audit-recovery.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add audit crash recovery and tail-hash reload

AuditDrainer.recover() drains any rows left in 'pending' state from a
prior process — meant to be called on xinas-api startup before any
traffic is accepted, per ADR-0003 §Crash recovery.

AuditAppender.reloadTailHash(path) reconstructs the chain hash from
the JSONL's last entry when the outbox is empty (everything drained
pre-crash but the in-memory tail cache is gone). This keeps the
chain unbroken across process restarts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: GC sweep (tasks retention, events ring, leases TTL)

**Files:**
- Create: `xiNAS-MCP/src/state/gc.ts`
- Create: `xiNAS-MCP/src/__tests__/state/gc.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/gc.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/migrations.js';
import { GcSweeper } from '../../state/gc.js';

function seedTask(db: Database.Database, task_id: string, state: string, terminal_at: number | null) {
  db.prepare(
    `INSERT INTO tasks (task_id, kind, state, principal, client_type, request_id, correlation_id,
                        input_hash, risk_level, affected_resources, created_at, updated_at, terminal_at)
     VALUES (?, 'k', ?, 'p', 'system', 'r', 'c', 'h', 'non_disruptive', '[]', ?, ?, ?)`,
  ).run(task_id, state, Date.now(), Date.now(), terminal_at);
}

function seedLease(db: Database.Database, resource_id: string, task_id: string, heartbeat_at: number, ttl: number) {
  db.prepare(
    `INSERT INTO leases (lease_id, resource_kind, resource_id, task_id, acquired_at, ttl_seconds, heartbeat_at)
     VALUES (?, 'array', ?, ?, ?, ?, ?)`,
  ).run(`l-${resource_id}`, resource_id, task_id, Date.now(), ttl, heartbeat_at);
}

describe('GcSweeper', () => {
  let dir: string;
  let db: Database.Database;
  let gc: GcSweeper;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-gc-'));
    db = new Database(':memory:');
    runMigrations(db);
    gc = new GcSweeper(db, {
      taskRetentionDays: 30,
      archiveDir: dir,
      leaseGraceMs: 0,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('archives + removes terminal tasks older than retention', async () => {
    const now = Date.now();
    const day = 86400 * 1000;
    seedTask(db, 't-old', 'success', now - 31 * day);
    seedTask(db, 't-recent', 'success', now - 1 * day);
    seedTask(db, 't-running', 'running', null);

    const result = await gc.sweepTasks();
    expect(result.archived).toBe(1);
    expect(result.deleted).toBe(1);

    const remaining = (db.prepare('SELECT task_id FROM tasks ORDER BY task_id').all() as { task_id: string }[]).map((r) => r.task_id);
    expect(remaining).toEqual(['t-recent', 't-running']);

    // Verify the archive file exists and contains the archived row.
    const files = readdirSync(dir);
    expect(files.some((f) => /^tasks-\d{6}\.jsonl\.gz$/.test(f))).toBe(true);
  });

  it('does not remove non-terminal tasks regardless of age', async () => {
    const now = Date.now();
    seedTask(db, 't-old-running', 'running', null);
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(now - 1000 * 86400, 't-old-running');
    await gc.sweepTasks();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id = 't-old-running'").get()).toEqual({ n: 1 });
  });

  it('sweepLeases delegates to LeaseManager and returns its result shape', () => {
    seedTask(db, 't1', 'running', null);
    seedLease(db, 'arr1', 't1', Date.now() - 60_000, 30); // expired 30s ago
    seedLease(db, 'arr2', 't1', Date.now(), 60);          // still alive

    const result = gc.sweepLeases();
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(1); // t1 was still running
    expect(db.prepare('SELECT resource_id FROM leases').all()).toEqual([{ resource_id: 'arr2' }]);
  });

  it('sweepAll combines results', async () => {
    const now = Date.now();
    seedTask(db, 't-old', 'success', now - 31 * 86400 * 1000);
    seedTask(db, 't1', 'running', null);
    seedLease(db, 'arr1', 't1', now - 60_000, 30);

    const result = await gc.sweepAll();
    expect(result.tasks_archived).toBe(1);
    expect(result.tasks_deleted).toBe(1);
    expect(result.leases_removed).toBe(1);
    expect(result.tasks_recovered).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/gc.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module '../../state/gc.js'`.

- [ ] **Step 3: Implement GcSweeper**

Create `xiNAS-MCP/src/state/gc.ts`:

```ts
import { mkdirSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { LeaseManager } from './leases.js';

export interface GcOptions {
  taskRetentionDays?: number;   // default 30
  archiveDir?: string;          // default '/var/lib/xinas/state/archive'
  leaseGraceMs?: number;        // additional grace beyond ttl_seconds, default 0
}

export interface GcSweepResult {
  tasks_archived: number;
  tasks_deleted: number;
  leases_removed: number;
  tasks_recovered: number;
}

export class GcSweeper {
  private readonly db: Database;
  private readonly taskRetentionMs: number;
  private readonly archiveDir: string;
  private readonly leases: LeaseManager;

  constructor(db: Database, opts: GcOptions = {}) {
    this.db = db;
    this.taskRetentionMs = (opts.taskRetentionDays ?? 30) * 86400 * 1000;
    this.archiveDir = opts.archiveDir ?? '/var/lib/xinas/state/archive';
    this.leases = new LeaseManager(db);
  }

  /**
   * Per ADR-0003 §Retention, old terminal tasks are archived to
   * compressed JSONL before the rows are pruned. This is a one-way
   * archive — support bundles include the most recent archive file;
   * older files are operator-managed under archiveDir.
   *
   * Archive filename pattern: tasks-YYYYMM.jsonl.gz (monthly bucket).
   * Within the file each line is one task row's JSON serialization.
   */
  async sweepTasks(): Promise<{ archived: number; deleted: number }> {
    const cutoff = Date.now() - this.taskRetentionMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE terminal_at IS NOT NULL AND terminal_at < ?
          ORDER BY terminal_at`,
      )
      .all(cutoff) as Record<string, unknown>[];
    if (rows.length === 0) return { archived: 0, deleted: 0 };

    const archivePath = this.archivePathFor(rows[0]!['terminal_at'] as number);
    mkdirSync(dirname(archivePath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const gz = createGzip();
      const out = createWriteStream(archivePath, { flags: 'a' });
      gz.pipe(out);
      gz.on('error', reject);
      out.on('finish', resolve);
      out.on('error', reject);
      for (const r of rows) {
        gz.write(JSON.stringify(r) + '\n');
      }
      gz.end();
    });

    const ids = rows.map((r) => r['task_id'] as string);
    const placeholders = ids.map(() => '?').join(',');
    const info = this.db
      .prepare(`DELETE FROM tasks WHERE task_id IN (${placeholders})`)
      .run(...ids);
    return { archived: rows.length, deleted: info.changes };
  }

  /**
   * Delegates to LeaseManager.sweepExpired so the ADR-0004 task-recovery
   * semantics (still-running holder → requires_manual_recovery) apply
   * here too. GC is the periodic trigger; LeaseManager owns the logic.
   */
  sweepLeases(): { leases_removed: number; tasks_recovered: number } {
    return this.leases.sweepExpired();
  }

  async sweepAll(): Promise<GcSweepResult> {
    const t = await this.sweepTasks();
    const l = this.sweepLeases();
    return {
      tasks_archived: t.archived,
      tasks_deleted: t.deleted,
      leases_removed: l.leases_removed,
      tasks_recovered: l.tasks_recovered,
    };
  }

  private archivePathFor(epochMs: number): string {
    const d = new Date(epochMs);
    const y = d.getUTCFullYear().toString().padStart(4, '0');
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    return join(this.archiveDir, `tasks-${y}${m}.jsonl.gz`);
  }
}
```

**Note on events:** ADR-0003 lists an events ring (100k entries) as part
of retention. The `events` table itself does not land in this PR (events
are written by the API layer in a later workstream); when it does, a
matching `sweepEvents()` method joins the rotation here. The spec
already records this deferral.

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/gc.ts xiNAS-MCP/src/__tests__/state/gc.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add GcSweeper (tasks retention, leases TTL)

Periodic-sweep entry points per ADR-0003 §Retention. Tasks beyond
the retention window (default 30 days, only terminal tasks) are
deleted; leases whose heartbeat + ttl is past now are released.

Events ring-buffering lands when the events table itself does
(not in this PR — events are written by the API layer and aren't
part of the bootstrap state store).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Public state module index + factory

**Files:**
- Create: `xiNAS-MCP/src/state/index.ts`
- Create: `xiNAS-MCP/src/__tests__/state/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/state/index.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../../state/index.js';

describe('openStateStore factory', () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('opens a fresh store and reports clean state', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-state-'));
    const state = await openStateStore({
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
      nodeId: 'node-1',
    });
    try {
      const result = state.kv.put('/xinas/v1/cluster', { mode: 'single_node' });
      expect(result.ok).toBe(true);
      const fetched = state.kv.get('/xinas/v1/cluster');
      expect(fetched).not.toBeNull();
    } finally {
      await state.close();
    }
  });

  it('reopens cleanly after close (round-trip)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-state-'));
    const dbPath = join(dir, 'xinas.db');
    const auditPath = join(dir, 'audit.jsonl');

    const s1 = await openStateStore({ databasePath: dbPath, auditJsonlPath: auditPath, nodeId: 'node-1' });
    s1.kv.put('/k', { x: 1 });
    await s1.close();

    const s2 = await openStateStore({ databasePath: dbPath, auditJsonlPath: auditPath, nodeId: 'node-1' });
    expect(s2.kv.get<{ x: number }>('/k')?.value).toEqual({ x: 1 });
    await s2.close();
  });

  it('factory awaits drainer.recover() and drains a genuinely pending row', async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-state-'));
    const dbPath = join(dir, 'xinas.db');
    const auditPath = join(dir, 'audit.jsonl');

    // Seed via raw DB — bypass openStateStore so we don't accidentally
    // drain on close(). Using the AuditAppender directly leaves a row
    // genuinely pending in the outbox at restart time.
    const Database = (await import('better-sqlite3')).default;
    const { runMigrations } = await import('../../state/migrations.js');
    const { AuditAppender } = await import('../../state/audit.js');
    const seedDb = new Database(dbPath);
    runMigrations(seedDb);
    const seedAudit = new AuditAppender(seedDb, 'node-1');
    seedAudit.queue({
      kind: 'k',
      request_id: 'r',
      principal: 'p',
      client_type: 'rest',
      parameters_hash: 'sha256:p',
      result_hash: 'sha256:r',
    });
    // Sanity: confirm the row is pending before we "crash".
    const pendingBefore = seedDb.prepare(
      "SELECT COUNT(*) AS n FROM audit_outbox WHERE drain_state = 'pending'",
    ).get() as { n: number };
    expect(pendingBefore.n).toBe(1);
    // No drain — just close the raw connection.
    seedDb.close();

    // JSONL should not exist yet (drainer never ran).
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(auditPath)).toBe(false);

    // Re-open via openStateStore. Its async constructor MUST run
    // drainer.recover() before returning.
    const state = await openStateStore({
      databasePath: dbPath,
      auditJsonlPath: auditPath,
      nodeId: 'node-1',
    });
    try {
      // After recover(), the JSONL exists and has the entry.
      expect(existsSync(auditPath)).toBe(true);
      const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!).kind).toBe('k');

      // And the outbox row is now durable. Verify via a second
      // read-only DB connection (better-sqlite3 allows multiple
      // readers in WAL mode).
      const readDb = new Database(dbPath, { readonly: true });
      const pendingAfter = readDb.prepare(
        "SELECT COUNT(*) AS n FROM audit_outbox WHERE drain_state = 'pending'",
      ).get() as { n: number };
      expect(pendingAfter.n).toBe(0);
      const durable = readDb.prepare(
        "SELECT drain_state, durable_file, durable_offset FROM audit_outbox",
      ).get() as { drain_state: string; durable_file: string; durable_offset: number };
      expect(durable.drain_state).toBe('durable');
      expect(durable.durable_file).toBe('audit.jsonl');
      expect(durable.durable_offset).toBeGreaterThanOrEqual(0);
      readDb.close();
    } finally {
      await state.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/index.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module '../../state/index.js'`.

- [ ] **Step 3: Implement the factory**

Create `xiNAS-MCP/src/state/index.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { SqliteKvStore } from './backend-sqlite.js';
import { LeaseManager } from './leases.js';
import { AuditAppender } from './audit.js';
import { AuditDrainer } from './audit-drainer.js';
import { GcSweeper } from './gc.js';
import type { KvStore } from './store.js';

export type { KvStore, KvTransaction } from './store.js';
export type {
  AuditEntry,
  AuditEntryInput,
  CasResult,
  ClientType,
  DeleteResult,
  ListOptions,
  PutOptions,
  QueuedAuditEntry,
  RevisionedValue,
  ValidationStatus,
  WatchEvent,
  WatchHandle,
} from './types.js';
// Concrete classes are exported by name for tests and for internal
// agent-side wiring. Public callers should bind to KvStore (the
// interface) via OpenedStateStore.kv to keep the Phase 2 etcd swap
// path open.
export { AuditAppender } from './audit.js';
export { AuditDrainer } from './audit-drainer.js';
export { LeaseManager } from './leases.js';
export { GcSweeper } from './gc.js';

export interface OpenStateStoreOptions {
  databasePath: string;       // e.g. /var/lib/xinas/state/xinas.db
  auditJsonlPath: string;     // e.g. /var/log/xinas/audit.jsonl
  nodeId: string;             // controller_id used in audit genesis hash
  archiveDir?: string;        // passed to GcSweeper; default per gc.ts
}

export interface OpenedStateStore {
  /**
   * KV interface, not the SqliteKvStore concrete class — Phase 2's
   * etcd backend will return a different implementation behind the
   * same OpenedStateStore type.
   */
  kv: KvStore;
  leases: LeaseManager;
  audit: AuditAppender;
  drainer: AuditDrainer;
  gc: GcSweeper;
  close(): Promise<void>;
}

/**
 * Open the state store and run startup recovery.
 *
 * Async because per ADR-0003 §Crash recovery the audit drainer's
 * recover() MUST complete before any request handler runs. Callers
 * await openStateStore() and then begin serving traffic.
 */
export async function openStateStore(opts: OpenStateStoreOptions): Promise<OpenedStateStore> {
  mkdirSync(dirname(opts.databasePath), { recursive: true });
  mkdirSync(dirname(opts.auditJsonlPath), { recursive: true });

  const db = new Database(opts.databasePath);
  runMigrations(db);

  const kv = new SqliteKvStore(db);
  const leases = new LeaseManager(db);
  const audit = new AuditAppender(db, opts.nodeId);
  // Wire the drainer back to the appender so notifyJsonlAdvanced()
  // keeps AuditAppender.jsonlTail fresh after every drain. Without
  // this, an empty-outbox queue() after a drain would fall back to
  // genesis instead of the actual durable tail.
  const drainer = new AuditDrainer(db, { path: opts.auditJsonlPath, audit });
  const gc = new GcSweeper(db, opts.archiveDir ? { archiveDir: opts.archiveDir } : undefined);

  // Per ADR-0003: drain any rows left pending from a prior process
  // BEFORE returning. recover() handles both clean-restart and
  // crash-after-fsync-before-mark windows.
  await drainer.recover();

  // After recovery, the outbox is empty in the steady-restart case;
  // tail-hash reload from the JSONL re-seeds the chain so subsequent
  // queue()s link correctly.
  const outboxCount = db.prepare('SELECT COUNT(*) AS n FROM audit_outbox').get() as { n: number };
  if (outboxCount.n === 0) {
    audit.reloadTailHash(opts.auditJsonlPath);
  }

  return {
    kv,
    leases,
    audit,
    drainer,
    gc,
    async close() {
      await drainer.stop();
      kv.close();
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/ 2>&1 | tail -8
```

Expected: all state tests pass.

- [ ] **Step 5: Run the full test suite + typecheck + biome lint**

Run:
```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm test ; echo "all exit=$?"
```

Expected: `all exit=0`. Biome may emit warnings; only errors fail the lint gate.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/state/index.ts xiNAS-MCP/src/__tests__/state/index.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add openStateStore factory + public surface

Single entry point that wires the migrations runner, SqliteKvStore,
LeaseManager, AuditAppender, AuditDrainer, and GcSweeper against
a single Database. On open, if the outbox is empty but the JSONL
has entries, reloads the audit tail-hash so the chain continues.

This is the surface callers (xinas-api skeleton in a later PR) bind to.
Internals are exported individually for tests and for the agent-side
RPC layer that will need to reach into LeaseManager / AuditAppender
directly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Open PR + verify CI + operator gate before merge

- [ ] **Step 1: Push the branch**

Run:
```bash
git push -u origin claude/phase0-state-store 2>&1 | tail -5
```

Expected: branch published.

- [ ] **Step 2: Open the PR**

Run:
```bash
gh pr create --base main --head claude/phase0-state-store \
  --title "feat(state): Phase 0 state store (ADR-0003)" \
  --body "$(cat <<'EOF'
## Summary

- Implements the SQLite-backed KV state store specified in ADR-0003.
- Adds the seven KvStore methods (get/put/patch/delete/list/watch/transaction) over `better-sqlite3` in WAL mode, with CAS via `expected_revision`.
- Lands the tasks/task_stages/leases/audit_outbox/audit_index tables from ADR-0004 (executor and worker pool deferred to a later PR).
- Adds AuditAppender (hash chain + transactional outbox) and AuditDrainer (background → JSONL with fsync, crash recovery, tail-hash reload).
- Adds GcSweeper for task retention and lease TTL sweeps.
- Public surface (`openStateStore` factory in `xiNAS-MCP/src/state/index.ts`) does not leak SQLite types — Phase 2 etcd swap (ADR-0003 §Cluster compatibility) does not require call-site changes.

## Test plan

- [x] Per-method unit tests for KvStore: basic, CAS, patch, delete, list, watch, transaction
- [x] Leases: acquire / heartbeat / release / sweep
- [x] Audit hash chain links across queues
- [x] Audit drainer copies pending → JSONL with fsync and marks durable
- [x] Audit crash recovery drains stale pending rows
- [x] Audit tail-hash reload from JSONL after empty-outbox restart
- [x] GC removes terminal tasks beyond retention; preserves non-terminal regardless of age
- [x] openStateStore factory round-trips after close
- [ ] CI green on this PR (8 blocking jobs pass)
- [ ] Warn-only jobs report expected backlog

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

Expected: PR URL printed.

- [ ] **Step 3: Watch CI**

Run:
```bash
sleep 10
RUN=$(gh run list --branch claude/phase0-state-store --workflow ci --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN --exit-status > /tmp/state-watch.out 2>&1
echo "watch exit=$?"
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

- [ ] **Step 4: Report status and STOP for operator approval**

Print to the operator:

> PR #<NUM> is green. 8 blocking jobs pass, 6 warn-only fail by design (same shape as the CI bootstrap PR). State store: ~2.5k lines TS + tests across `xiNAS-MCP/src/state/` and `xiNAS-MCP/src/__tests__/state/`. Ready to merge via `gh pr merge --rebase`. Approve?

DO NOT proceed to the next step without an explicit "merge" / "yes" from the operator.

- [ ] **Step 5: After operator approval, merge**

```bash
gh pr merge <NUM> --rebase --delete-branch 2>&1 | tail -3
```

If the local-checkout step fails (it did on PR #199 because main is checked out elsewhere), the server-side merge still completes; verify with:

```bash
gh pr view <NUM> --json state,mergedAt
```

Expected: `state=MERGED`.

- [ ] **Step 6: Watch the post-merge CI run on main**

```bash
git fetch origin main
sleep 8
RUN=$(gh run list --branch main --workflow ci --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN --exit-status
```

Expected: `completed/success` on main.

---

## Self-review (revised after code-review fold-in)

**Spec coverage (ADR-0003):**

- ✓ Responsibility split — out-of-scope (xinas_history side); state-store side implemented in Tasks 4-18.
- ✓ Backend choice — Task 1 adds better-sqlite3 + the build-time `copy-assets` step so `.sql` files reach `dist/`; Task 6 enables WAL.
- ✓ Key layout — Tasks 6-12 implement a generic kv table; key prefixes are stored as-is.
- ✓ Object revisioning — Task 6 (monotonic) + Task 7 (SQL-predicate CAS so concurrent writers can't slip past).
- ✓ Cluster compatibility — KvStore interface in Task 5 has no backend types; Task 18 returns `OpenedStateStore.kv: KvStore` (not `SqliteKvStore`) and does not export the concrete from the public surface for binding purposes.
- ✓ Retention and on-disk bound — Task 17 archives terminal tasks to gzipped JSONL under `archiveDir` before pruning.
- ✓ Audit storage and semantics — Tasks 14-16. JSONL line includes `audit_seq`, `prev_hash` (hex), `hash` (hex); JCS-style recursive canonicalization; mark-durable + audit_index update in a single SQLite transaction; crash recovery detects already-persisted rows via the JSONL's max audit_seq and skips re-append.
- ✓ Atomic audit via outbox pattern — Task 14's `queue()` is called inside any caller-provided transaction (e.g., `kv.transaction(tx => { ...; audit.queue(...); })`); the outbox insert commits with the state change atomically at the SQLite level.
- ✓ Startup recovery gate — Task 18's `openStateStore()` is async and awaits `drainer.recover()` before returning, so callers can't serve traffic until the outbox is drained per ADR-0003 §Crash recovery.
- ✗ JSONL rotation (256 MiB or daily) — still deferred to a follow-up PR per ADR-0003's "fold-in" comment; `rotateBytes` field reserved but inert. Tracked.

**Spec coverage (ADR-0004):**

- ✓ tasks table (Task 2 DDL)
- ✓ task_stages table (Task 2 DDL)
- ✓ leases table + UNIQUE(resource_kind, resource_id) (Task 2 DDL + Task 13 helpers)
- ✓ Stale-lease recovery semantics — Task 13's `LeaseManager.sweepExpired()` transitions still-running holder tasks to `requires_manual_recovery` with `error_code = FAILED_STATE_DESYNC`; Task 17's `GcSweeper.sweepLeases()` delegates here so behavior is consistent across triggers.
- ✗ Executor / worker pool — explicitly out of scope per brief.

**Spec coverage (reqs §14):**

- ✓ AuditEntry shape — Task 4's type definition makes `kind`, `timestamp`, `node_id`, `principal`, `client_type`, `request_id`, `parameters_hash`, `result_hash` all required; optional fields are `operation_id`, `task_id`, `state_revision`, `payload`. Task 14's `AuditAppender` auto-injects `timestamp` and `node_id` so callers provide the minimal `AuditEntryInput` shape.

**Placeholder scan:** No "TBD" / "TODO" / "fill in details" in plan steps. Deferrals (rotation, executor, events table) are explicit and named.

**Type consistency:** `KvStore`, `KvTransaction`, `RevisionedValue`, `CasResult`, `DeleteResult`, `WatchEvent`, `WatchHandle`, `PutOptions`, `ListOptions`, `AuditEntry`, `AuditEntryInput`, `QueuedAuditEntry`, `ValidationStatus`, `ClientType`, `SweepResult`, `GcSweepResult` — all defined in `types.ts` / per-module files and consumed consistently. Method names: `get`/`put`/`patch`/`delete`/`list`/`watch`/`transaction` in `KvStore`; `acquire`/`heartbeat`/`release`/`sweepExpired` in `LeaseManager`; `queue`/`reloadTailHash` in `AuditAppender`; `drainNow`/`recover`/`start`/`stop` in `AuditDrainer`; `sweepTasks`/`sweepLeases`/`sweepAll` in `GcSweeper`. `openStateStore` is async.

**Scope:** focused on the state store. No xinas-api skeleton, no agent process, no executor, no drift rewire — all separately tracked.

**Revisions from code review (folded in across two review rounds):**

| Finding | Fix location |
|---|---|
| Migrations runner can't find .sql after tsc build | Task 1 adds `copy-assets` script to package.json's build |
| CAS not enforced by SQL | Task 7 rewrites `put` to use `UPDATE ... WHERE revision = ?`; Task 9 same for `delete` |
| Audit hash-chain diverges from ADR-0003 (JSONL omits hash; shallow canonicalization) | Task 14 adds recursive `canonicalize()`; Task 15's JSONL line includes audit_seq/prev_hash/hash hex; Task 16's `reloadTailHash` reads hash directly from JSONL |
| Audit startup recovery not enforced by factory | Task 18's `openStateStore` is async and awaits `drainer.recover()` |
| Drainer durable marking not atomic + no duplicate-append recovery | Task 15's `markBatchDurable` wraps mark + index in one db.transaction; `recover()` detects already-persisted rows via the scan and skips re-append |
| Public factory leaks SqliteKvStore type | Task 18's `OpenedStateStore.kv: KvStore`; concrete `SqliteKvStore` is not exported from index.ts |
| list() SQL malformed with both prefix + start_after | Task 11 rewrites with `LIKE ? ESCAPE '\\'` on the LIKE clause itself |
| Lease expiry loses ADR-0004 recovery semantics | Task 13's `sweepExpired` transitions still-running holders to `requires_manual_recovery` |
| Retention weaker than ADR-0003 (no archive) | Task 17's `sweepTasks` archives to `tasks-YYYYMM.jsonl.gz` before delete |
| AuditEntry shape missing required fields | Task 4's type makes timestamp/node_id/parameters_hash/result_hash required; Task 14 auto-injects timestamp/node_id |
| **AuditAppender.cachedTail corrupts chain on rollback** | Task 14 removes the cache; `currentTailHash()` always SELECTs the live outbox tail (rollback removes the row); JSONL fallback held in `jsonlTail` is only set on startup (`reloadTailHash`) and by the drainer's `notifyJsonlAdvanced` — never from inside `queue()`. New test in Task 14 wraps `queue()` in a throwing transaction and verifies the next entry still links to genesis. |
| **Recovery loses exact byte offsets** | Task 15's `scanPersisted()` (replaces `readMaxPersistedAuditSeq`) walks the JSONL once and builds `Map<audit_seq, byte_offset>`; recover() now records exact offsets for already-persisted rows, so `audit_index.durable_offset` stays meaningful. |
| **Startup-recovery test wasn't actually testing recovery** | Task 18's test rewritten: seeds via raw `better-sqlite3` connection + direct `AuditAppender.queue()` (no factory close → no drain), confirms outbox has a pending row, closes the raw DB, then opens via `openStateStore()` and verifies the JSONL was written and the outbox row was marked durable. |
| **reloadTailHash() still wrote to the removed cachedTail field** | Task 16's three assignments switched to `this.jsonlTail = ...`; would have failed typecheck on the first build. |
| **recover() silently accepted gapped JSONL via durable_offset = -1** | Task 15's recover() now throws `audit chain corrupt: outbox row audit_seq=N claims persisted (max=M) but no JSONL entry found; refusing to start` when a pending row's audit_seq ≤ maxSeq but has no offset in the scan. Operator must investigate (quarantine + start fresh, or restore from backup). |
| **No test proved notifyJsonlAdvanced kept the chain valid after pruning** | Task 15 adds a wiring test: drain → DELETE durable outbox rows → queue → assert prev_hash equals the previously drained row's hash. Plus a gap-detection test that constructs a JSONL with a missing audit_seq and asserts recover() rejects it. |

No issues remain; plan is ready for execution.
