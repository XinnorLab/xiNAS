# S15 MCP MRTR Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every MCP `mode=apply` require a human confirmation carried by an MCP `2026-07-28` Multi Round-Trip Request — in-band form acceptance for non-disruptive and access-changing plans, out-of-band operator approval for destructive plans — verified and consumed inside the task engine's apply transaction, without changing REST, `xinasctl` or TUI behavior.

**Architecture:** The plan engine starts persisting the public plan verbatim (`plan_document`) so a confirmation can show exactly what the client saw. The MCP dispatcher gains a `ConfirmationService` that, after the existing `mcp.allow_apply` gate, creates a durable `mcp_confirmations` record and answers `input_required` with an HMAC-protected `requestState`; the retry is validated byte-for-byte against the record and forwarded on the loopback with an `X-Xinas-Confirmation` header that only the loopback bearer can set. `TaskEngine.apply()` refuses any `client_type: mcp` apply without that trusted context and consumes the record in the same SQLite transaction that inserts the task. Operators approve destructive records over REST, `xinasctl`, or a cookie-free approval page served by the api.

**Tech Stack:** TypeScript (Node ≥20, ESM, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Express 5, better-sqlite3, `node:crypto` (HMAC-SHA-256, `timingSafeEqual`), vitest + supertest, biome, `@modelcontextprotocol/sdk` 1.x (legacy path, unchanged), `@modelcontextprotocol/client` 2.0.0 (tests only), `ajv` (schema validation in tests).

**Spec:** [docs/control-path/s15-mcp-mrtr-confirmation-spec.md](../../control-path/s15-mcp-mrtr-confirmation-spec.md). Its validation record and decisions are Appendix A of [docs/control-path/s15-mcp-mrtr-requirements.md](../../control-path/s15-mcp-mrtr-requirements.md). Amended contracts already on this branch: ADR-0010, S14 §5.1, S8 §4.1, S2 §17, `api-v1.yaml`.

## Global Constraints

- Work in the worktree `.claude/worktrees/s15-mcp-mrtr` on branch `feat/s15-mcp-mrtr-confirmation` (based on `origin/release/3.14`). Never `cd` into the shared main checkout. PR target is `release/3.14`, merged with `--merge`.
- **Spec-first is already satisfied on this branch** (the spec set is the first commit — Task 0). Do not reorder it behind code.
- All repository artifacts (code comments, docs, commit messages) are in **English**.
- Every commit touching `xiNAS-MCP/src/` carries the trailer `Requires-Rebuild: xinas_node_build` (compiled `dist/` is untracked; without it the change never reaches a host). Docs-only commits carry no trailer.
- Conventional Commits: `type(scope): subject`. End every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit per task as written; do **not** push.
- `docs/control-path/api-v1.yaml` changes are additive only (already made in Task 0); `ApplyRequest` MUST stay unchanged.
- Verification, run from `xiNAS-MCP/` before declaring any code task done: `npm run typecheck && npm run lint && npm run format:check` and `npm test`. Tasks that touch `src/__tests__/e2e/**` additionally run `npm run build && npm run test:e2e` (~55 s; `build` first is not optional).
- Docs verification for any `docs/**/*.md` change: `npx --yes markdownlint-cli2 'docs/**/*.md'`; for `api-v1.yaml`: `npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml` (0 errors; the 46 pre-existing `operation-description` warnings are not yours).
- Timestamps in the store are epoch-ms numbers; the HTTP boundary renders ISO strings. Never mix the two.
- Fixed values copied from the spec: request key `confirm_apply`; state prefix `xc1`; state cap 4096 bytes; rounds max **3**; TTL default **300 s**, range 60–900; `url_wait_seconds` default 25, range 1–55; per-principal open records 5 (1–50); per-node 100 (1–1000); creation rate 10/min (1–600); acknowledgement phrases `DATA MAY BE PERMANENTLY LOST` and `ROLLBACK IS NOT SUPPORTED`, exact and case-sensitive; header `X-Xinas-Confirmation`; page path `/mcp/approvals/{id}`; JSON-RPC `-32021` → HTTP 400, `-32602` → HTTP 200 with the fixed message `invalid request state` for every state failure.
- Tool error codes introduced: `MCP_CONFIRMATION_UNSUPPORTED`, `CONFIRMATION_URL_UNAVAILABLE`, `CONFIRMATION_LIMIT_EXCEEDED`, `CONFIRMATION_RATE_LIMITED`, `CONFIRMATION_DECLINED`, `CONFIRMATION_CANCELLED`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_ALREADY_CONSUMED`, `CONFIRMATION_ROUND_LIMIT`. REST keeps the existing `ErrorCode` union — new REST failures are `PRECONDITION_FAILED` / `CONFLICT` / `INVALID_ARGUMENT` with `details.reason`.
- There is **no** configuration key that disables confirmation (D-01). Never add one.
- `mcp.confirmation.allow_uds_approval` defaults to **false**. A UDS peer-trust decision is break-glass: refused unless that key is `true`, and then audited as `break_glass_used` in addition to the decision event (spec §3.5, §9.2).
- `approval_channel` is derived from the auth verdict only (`mcp_form | bearer | uds_break_glass`). The `X-Xinas-Approval-Interface` header (`web | rest`) is an untrusted label stored in `approval_interface`; no check may read it.
- `risk_level` and `rollback_model` are the `api-v1.yaml` enums and nothing else; the plan engine refuses any other value (Task 2b runs before any document is persisted).
- Every `plan_id` applied over MCP must have been created by the same principal (`document.created_by.principal`, spec §5.3 item 7).
- Security errors never echo a decoded `requestState`, a MAC, a token, the other principal, or plan data. No log line may contain a bearer or a `requestState`.
- The approval routes are `mcp_exposed: false` catalog entries: never in `tools/list`, never callable through `tools/call`.
- Everything inside `db.transaction(...)` is synchronous. No `await` inside the apply transaction.

---

## File structure

New files (all under `xiNAS-MCP/src/` unless noted):

| File | Responsibility |
|---|---|
| `state/migrations/006-mcp-confirmations.sql` | `tasks.plan_document`, `tasks.plan_document_hash`, table `mcp_confirmations` + indexes |
| `api/plan/document.ts` | `PlanDocument` type, `buildPlanDocument`, `redactValue`, `planDocumentHash`, `publicPlan`, `clientImpact` |
| `api/mcp/results.ts` | `ToolResult`, `InputRequiredToolResult`, `text()`, `errorResult()`, `isInputRequired()` (moved out of `dispatch.ts`) |
| `api/mcp/confirmation/errors.ts` | `McpProtocolError` (JSON-RPC code + HTTP status) |
| `api/mcp/confirmation/types.ts` | record/status/mode types, `MAX_ROUNDS`, phrases |
| `api/mcp/confirmation/store.ts` | `ConfirmationStore` — SQLite CRUD, guarded transitions, limits, sweep, prune |
| `api/mcp/confirmation/audit.ts` | `queueConfirmationEvent()` — the `mcp.confirmation.*` audit rows |
| `api/mcp/confirmation/state.ts` | key ring + `mintRequestState` / `verifyRequestState` |
| `api/mcp/confirmation/policy.ts` | `confirmationModeFor`, `argumentsHash`, `elicitationModes`, `isConfirmable`, `parseMrtrParams` |
| `api/mcp/confirmation/message.ts` | `renderConfirmationMessage`, `renderSummary` |
| `api/mcp/confirmation/metrics.ts` | `ConfirmationMetrics` interface + `noopMetrics` (Task 10); registry-backed implementation (Task 13) |
| `api/mcp/confirmation/service.ts` | `ConfirmationService` — the MRTR orchestration used by `callTool` and the REST routes |
| `api/mcp/confirmation/sweeper.ts` | periodic expiry sweep timer |
| `api/mcp/confirmation/approval-page.ts` | the HTML/CSS/JS approval page + security headers |
| `api/routes/mcp-confirmations.ts` | `GET /mcp/confirmations`, `GET /mcp/confirmations/{id}`, `POST …/approve`, `POST …/decline` |
| `api/routes/metrics.ts` | `GET /metrics` (Prometheus text) |
| `lib/metrics.ts` | dependency-free `MetricsRegistry` (counter / gauge / histogram / render) |
| `__tests__/contracts/mcp/2026-07-28/schema.json` | vendored MCP schema (draft 2020-12, `$defs`) |
| `__tests__/contracts/fixtures/McpConfirmation.json` | contract fixture for the new OpenAPI schema |

Modified files: `api/mcp/modern.ts`, `api/mcp/dispatch.ts`, `api/mcp/transport.ts`, `api/mcp/catalog.ts`, `api/mcp/discover.ts`, `api/plan/engine.ts`, `api/tasks/store.ts`, `api/tasks/types.ts`, `api/tasks/engine.ts`, `api/tasks/build.ts`, `api/routes/apply-helpers.ts`, `api/routes/arrays.ts`, `api/routes/filesystems.ts`, `api/routes/network.ts`, `api/routes/support.ts`, `api/middleware/auth.ts`, `api/context.ts`, `api/config.ts`, `api/app.ts`, `api/server.ts`, `state/gc.ts`, `cli/xinasctl.ts` (usage text only), `__tests__/api/_helpers.ts`, `package.json` (one devDependency), `docs/TODO.md`, `CLAUDE.md`, `docs/control-path/hardware-smoke-runbook.md`, `collection/roles/xinas_api/README.md`.

---

### Task 0: Commit the spec set (already written on this branch)

**Files:** everything under `docs/control-path/` that `git status` shows as modified/untracked, plus this plan.

- [ ] **Step 0: Confirm the branch base**

`git log --oneline -1` shows `169355b` (`release/3.14` as of 2026-09-04) or newer. If `origin/release/3.14` has moved again, `git fetch origin && git merge --ff-only origin/release/3.14` — the spec files never collide with installer commits. The three new docs are already staged (`git status` shows them as `A`).

- [ ] **Step 1: Verify the docs gates**

Run from the worktree root:

```bash
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

Expected: markdownlint `0 issues`; spectral `0 errors` (warnings are pre-existing).

- [ ] **Step 2: Commit**

```bash
git add docs/control-path/s15-mcp-mrtr-requirements.md docs/control-path/s15-mcp-mrtr-confirmation-spec.md docs/control-path/adr/0010-clients-mcp-cli-tui.md docs/control-path/s14-mcp-modern-era-spec.md docs/control-path/s8-clients-spec.md docs/control-path/s2-task-envelope-spec.md docs/control-path/api-v1.yaml docs/superpowers/plans/2026-09-04-s15-mcp-mrtr-confirmation.md
git commit -m "docs(control-path): S15 MCP MRTR confirmation — requirements, validation record, spec, ADR-0010/S14/S8/S2 amendments, api-v1 additions" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase A — protocol compliance, persistence, core enforcement, form flow

### Task 1: `resultType: "complete"` on every modern result

**Files:**
- Modify: `xiNAS-MCP/src/api/mcp/modern.ts:99-116`
- Test: `xiNAS-MCP/src/__tests__/api/mcp-discover.test.ts`
- Test: `xiNAS-MCP/src/__tests__/api/mcp-integration.test.ts`

**Interfaces:**
- Consumes: `listTools()`, `callTool()` from `dispatch.ts` (unchanged).
- Produces: modern `tools/list` result `{ resultType: 'complete', tools }`; modern `tools/call` result `{ ...ToolResult, resultType: 'complete' }`. Task 10 extends the same switch with the `input_required` branch.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('mcp modern era — server/discover (S14)')` block of `mcp-discover.test.ts`:

```ts
  // S15 T1 (requirement §4, V-23): every modern result carries resultType.
  it('stamps resultType: complete on tools/list, tools/call and tool errors', async () => {
    const list = await rpc(
      port,
      { jsonrpc: '2.0', id: 'rt-1', method: 'tools/list', params: { _meta: META } },
      { token: 'tok-admin' },
    );
    expect((list.body.result as { resultType?: string }).resultType).toBe('complete');

    const ok = await rpc(
      port,
      {
        jsonrpc: '2.0',
        id: 'rt-2',
        method: 'tools/call',
        params: { _meta: META, name: 'arrays.list', arguments: {} },
      },
      { token: 'tok-admin' },
    );
    expect((ok.body.result as { resultType?: string }).resultType).toBe('complete');

    const bad = await rpc(
      port,
      {
        jsonrpc: '2.0',
        id: 'rt-3',
        method: 'tools/call',
        params: { _meta: META, name: 'no.such.tool', arguments: {} },
      },
      { token: 'tok-admin' },
    );
    const err = bad.body.result as { resultType?: string; isError?: boolean };
    expect(err.isError).toBe(true);
    expect(err.resultType).toBe('complete');
  });
```

Append inside the first `describe('MCP integration: default posture (S8 T8)')` block of `mcp-integration.test.ts` (legacy wire shape must not change):

```ts
  it('S15: the legacy era result carries NO resultType (legacy wire shape retained)', async () => {
    const res = await rpc(
      port,
      { jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'arrays.list', arguments: {} } },
      { session: adminSession },
    );
    expect(res.body.result).toBeDefined();
    expect('resultType' in (res.body.result as object)).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `xiNAS-MCP/`: `npx vitest run src/__tests__/api/mcp-discover.test.ts -t "resultType"`
Expected: FAIL — `expected undefined to be 'complete'`.

- [ ] **Step 3: Implement**

In `modern.ts`, replace the two result lines:

```ts
      case 'tools/list':
        return { jsonrpc: '2.0', id: rpcId, result: { resultType: 'complete', tools: listTools() } };
```

and

```ts
        const result = await callTool(params.name, params.arguments ?? {}, opts);
        return { jsonrpc: '2.0', id: rpcId, result: { ...result, resultType: 'complete' } };
```

Add to the file header comment: "Every result on this path carries `resultType` (`2026-07-28` `Result.resultType` is mandatory — S14 §5.1). The legacy SDK path is untouched."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/api/mcp-discover.test.ts src/__tests__/api/mcp-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/modern.ts xiNAS-MCP/src/__tests__/api/mcp-discover.test.ts xiNAS-MCP/src/__tests__/api/mcp-integration.test.ts
git commit -m "fix(mcp): stamp resultType complete on every modern tools/list and tools/call result" -m "MCP 2026-07-28 makes Result.resultType mandatory (S14 §5.1, S15 requirement §4). Legacy results keep their wire shape." -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration `006` — plan document columns and the `mcp_confirmations` table

**Files:**
- Create: `xiNAS-MCP/src/state/migrations/006-mcp-confirmations.sql`
- Test: `xiNAS-MCP/src/__tests__/state/migrations.test.ts`

**Interfaces:**
- Produces: nullable `tasks.plan_document TEXT`, `tasks.plan_document_hash TEXT`; table `mcp_confirmations` with the columns of spec §6.1; indexes `mcp_confirmations_principal_status_idx`, `mcp_confirmations_status_expires_idx`, partial unique `mcp_confirmations_consumed_task_idx`.

- [ ] **Step 1: Write the failing test**

In `migrations.test.ts`, extend the first test's expectations: add `'mcp_confirmations'` to the `tables` array (alphabetical position: after `leases`), and add `{ version: 6, filename: '006-mcp-confirmations.sql' }` to `versions`. Then append:

```ts
  it('006 adds plan_document columns and the mcp_confirmations table (S15)', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(taskCols).toContain('plan_document');
    expect(taskCols).toContain('plan_document_hash');

    const confCols = (
      db.prepare('PRAGMA table_info(mcp_confirmations)').all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of [
      'confirmation_id', 'status', 'mode', 'principal', 'role', 'tool_name', 'operation_kind',
      'arguments_hash', 'plan_id', 'plan_hash', 'plan_document_hash', 'idempotency_key',
      'expected_revision', 'risk_level', 'rollback_model', 'request_state_nonce_hash', 'round',
      'created_at', 'expires_at', 'approved_at', 'approved_by', 'approval_channel', 'approval_interface', 'declined_at',
      'declined_by', 'decision_reason', 'consumed_at', 'consumed_task_id', 'expired_reason',
      'correlation_id', 'request_id', 'node_id',
    ]) {
      expect(confCols, `missing column ${col}`).toContain(col);
    }

    // status is CHECK-constrained
    expect(() =>
      db
        .prepare(
          `INSERT INTO mcp_confirmations (confirmation_id, status, mode, principal, role, tool_name,
             operation_kind, arguments_hash, plan_id, plan_hash, plan_document_hash, idempotency_key,
             expected_revision, risk_level, rollback_model, request_state_nonce_hash, round,
             created_at, expires_at, correlation_id, request_id, node_id)
           VALUES ('c1', 'bogus', 'form', 'p', 'admin', 't', 'k', 'a', 'pl', 'ph', 'dh', 'ik',
             0, 'non_disruptive', 'non_disruptive', 'nh', 1, 0, 1, 'c', 'r', 'n')`,
        )
        .run(),
    ).toThrow(/CHECK/);

    // a task can be produced by at most one confirmation
    const insert = db.prepare(
      `INSERT INTO mcp_confirmations (confirmation_id, status, mode, principal, role, tool_name,
         operation_kind, arguments_hash, plan_id, plan_hash, plan_document_hash, idempotency_key,
         expected_revision, risk_level, rollback_model, request_state_nonce_hash, round,
         created_at, expires_at, consumed_task_id, correlation_id, request_id, node_id)
       VALUES (?, 'consumed', 'form', 'p', 'admin', 't', 'k', 'a', 'pl', 'ph', 'dh', ?,
         0, 'non_disruptive', 'non_disruptive', 'nh', 1, 0, 1, 'task-1', 'c', 'r', 'n')`,
    );
    insert.run('c2', 'ik-2');
    expect(() => insert.run('c3', 'ik-3')).toThrow(/UNIQUE/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/state/migrations.test.ts`
Expected: FAIL — `mcp_confirmations` missing from the tables list.

- [ ] **Step 3: Write the migration**

Create `006-mcp-confirmations.sql`:

```sql
-- 006 (S15, docs/control-path/s15-mcp-mrtr-confirmation-spec.md §5, §6):
-- the persisted public plan and the MCP apply-confirmation records.
-- Additive only; version-gated by state/migrations.ts (each ALTER runs once).

-- The public Plan exactly as rendered to the client (JSON) + its own
-- sha256 over canonical JSON. NULL for plan_only rows created before 006;
-- such plans cannot be confirmed over MCP (PRECONDITION_FAILED
-- plan_predates_confirmation) — REST/CLI applies are unaffected.
ALTER TABLE tasks ADD COLUMN plan_document TEXT;
ALTER TABLE tasks ADD COLUMN plan_document_hash TEXT;

-- One row per MCP apply confirmation. The api is the sole writer. Timestamps
-- are epoch ms. request_state_nonce_hash is sha256(nonce) — the nonce itself
-- travels only inside the client-held requestState.
CREATE TABLE IF NOT EXISTS mcp_confirmations (
  confirmation_id          TEXT    PRIMARY KEY,
  status                   TEXT    NOT NULL
                             CHECK (status IN ('pending','approved','declined','cancelled','expired','consumed')),
  mode                     TEXT    NOT NULL CHECK (mode IN ('form','url')),
  principal                TEXT    NOT NULL,
  role                     TEXT    NOT NULL,
  tool_name                TEXT    NOT NULL,
  operation_kind           TEXT    NOT NULL,
  arguments_hash           TEXT    NOT NULL,
  plan_id                  TEXT    NOT NULL,
  plan_hash                TEXT    NOT NULL,
  plan_document_hash       TEXT    NOT NULL,
  idempotency_key          TEXT    NOT NULL,
  expected_revision        INTEGER NOT NULL,
  risk_level               TEXT    NOT NULL,
  rollback_model           TEXT    NOT NULL,
  request_state_nonce_hash TEXT    NOT NULL,
  round                    INTEGER NOT NULL DEFAULT 1,
  created_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  approved_at              INTEGER,
  approved_by              TEXT,
  approval_channel         TEXT,    -- verified: mcp_form | bearer | uds_break_glass
  approval_interface       TEXT,    -- untrusted UI label: web | rest
  declined_at              INTEGER,
  declined_by              TEXT,
  decision_reason          TEXT,
  consumed_at              INTEGER,
  consumed_task_id         TEXT,
  expired_reason           TEXT,
  correlation_id           TEXT    NOT NULL,
  request_id               TEXT    NOT NULL,
  node_id                  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_confirmations_principal_status_idx
  ON mcp_confirmations(principal, status);
CREATE INDEX IF NOT EXISTS mcp_confirmations_status_expires_idx
  ON mcp_confirmations(status, expires_at);
-- A task is produced by at most one confirmation (spec §6.1, §8.3).
CREATE UNIQUE INDEX IF NOT EXISTS mcp_confirmations_consumed_task_idx
  ON mcp_confirmations(consumed_task_id)
  WHERE consumed_task_id IS NOT NULL;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/state/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/state/migrations/006-mcp-confirmations.sql xiNAS-MCP/src/__tests__/state/migrations.test.ts
git commit -m "feat(state): migration 006 — plan_document columns and mcp_confirmations table (S15)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2b: Normalize `rollback_model` in the providers; the plan engine refuses off-enum values

Review finding V-53: four providers emit `reversible` / `executor_managed`, which the `Plan` enum does not contain, so their REST plans already violate the contract. This must land before any plan document is persisted (Task 3).

**Files:**
- Modify: `xiNAS-MCP/src/api/plan/providers/nfs.ts:293,369,409,453,539` — `'reversible'` → `'changing_access'`
- Modify: `xiNAS-MCP/src/api/plan/providers/pool.ts:163,221,258` — `'reversible'` → `'non_disruptive'`
- Modify: `xiNAS-MCP/src/api/plan/providers/config-rollback.ts:110` — `'executor_managed'` → `'unsupported'` (reset-to-baseline; its own diff says `destroying_data`); `:303` — `'executor_managed'` → `'changing_access'` (targeted restore, as S11 specifies)
- Modify: `xiNAS-MCP/src/api/plan/providers/support.ts:68` — `'executor_managed'` → `'non_disruptive'`
- Modify: `xiNAS-MCP/src/api/plan/engine.ts` (`plan()` enum guard)
- Test: `xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts:165,282,341,392,499` (expect `'changing_access'`), `xiNAS-MCP/src/__tests__/api/plan/engine.test.ts:197,226,253` (the fake providers return `'non_disruptive'`), plus new cases below

**Interfaces:**
- Produces: `RISK_LEVELS: ReadonlySet<string>` and `ROLLBACK_MODELS: ReadonlySet<string>` exported from `api/plan/engine.ts`; `PlanEngine.plan()` throws `ApiException('INTERNAL', …)` when a provider result is outside them.

- [ ] **Step 1: Write the failing tests**

In `engine.test.ts` append:

```ts
  it('S15 V-53: refuses a provider result whose rollback_model or risk_level is off the api-v1 enum', async () => {
    const off: PlanProvider = {
      operation_kind: 'test.off',
      preflight: async () => ({
        affected_resources: [{ kind: 'Reference', id: 'r1' }],
        blockers: [], warnings: [], diff: {},
        risk_level: 'non_disruptive',
        rollback_model: 'reversible',
      }),
    };
    h.engine.register(off);
    await expect(h.engine.plan({ ...makePlanArgs(), operation_kind: 'test.off' })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(h.countTasks()).toBe(0);
  });
```

Change the three fake providers at lines 197/226/253 from `rollback_model: 'reversible'` to `'non_disruptive'`. In `providers-nfs.test.ts` change the five `expect(result.rollback_model).toBe('reversible')` to `'changing_access'`. Add to `providers-nfs.test.ts` (or a new `providers-vocabulary.test.ts`) a case that runs `poolCreateProvider`, `supportBundleProvider` and `configRollbackProvider` (both branches, using the fixtures those providers' own suites already use) and asserts `ROLLBACK_MODELS.has(result.rollback_model)` for each.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/__tests__/api/plan/` → the new case fails (no guard), the nfs expectations fail (`reversible`).

- [ ] **Step 3: Implement**

`engine.ts` — export the enums next to `PlanResult`:

```ts
/** The api-v1.yaml `Plan` vocabularies — the ONLY values a provider may emit (S15 §3.2). */
export const RISK_LEVELS: ReadonlySet<string> = new Set([
  'non_disruptive', 'changing_access', 'destructive', 'unsupported_rollback',
]);
export const ROLLBACK_MODELS: ReadonlySet<string> = new Set([
  'non_disruptive', 'changing_access', 'destructive', 'unsupported',
]);
```

and in `plan()` right after `const result = await provider.preflight(...)`:

```ts
    if (!RISK_LEVELS.has(result.risk_level) || !ROLLBACK_MODELS.has(result.rollback_model)) {
      throw new ApiException(
        'INTERNAL',
        `plan provider ${args.operation_kind} returned an off-contract risk_level/rollback_model`,
        { risk_level: result.risk_level, rollback_model: result.rollback_model },
        'This is a provider bug: only the api-v1.yaml Plan enum values are allowed.',
      );
    }
```

Then the eleven one-word provider edits listed under **Files**.

- [ ] **Step 4: Run** — `npm test` (the nfs, pool, config-history, support route suites must stay green; grep `__tests__` for `'reversible'|'executor_managed'` — none may remain) and the gate.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/plan/engine.ts xiNAS-MCP/src/api/plan/providers/nfs.ts xiNAS-MCP/src/api/plan/providers/pool.ts xiNAS-MCP/src/api/plan/providers/config-rollback.ts xiNAS-MCP/src/api/plan/providers/support.ts xiNAS-MCP/src/__tests__/api/plan/
git commit -m "fix(plan): emit only the api-v1 rollback_model enum (nfs, pool, config-rollback, support) and refuse off-enum provider results (S15 §3.2, V-53)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Persist the plan document and render every Plan envelope from it

**Files:**
- Create: `xiNAS-MCP/src/api/plan/document.ts`
- Modify: `xiNAS-MCP/src/api/plan/engine.ts` (`PlanOutcome`, `plan()`)
- Modify: `xiNAS-MCP/src/api/tasks/types.ts` (`Task`)
- Modify: `xiNAS-MCP/src/api/tasks/store.ts` (`CreatePlanOnlyInput`, `INSERT_TASK_SQL`, `insertTask`, `TaskRow`, `rowToTask`, new `nextTaskId()`)
- Modify: `xiNAS-MCP/src/api/routes/apply-helpers.ts` (`planMode`, remove the local `clientImpact`)
- Modify: `xiNAS-MCP/src/api/routes/arrays.ts:146-175`, `:289-320`, `:431-462`; `xiNAS-MCP/src/api/routes/filesystems.ts:82-113`, `:233-264`, `:374-405`; `xiNAS-MCP/src/api/routes/network.ts:160-191`, `:311-342` (the nine `client_impact` render sites)
- Test: `xiNAS-MCP/src/__tests__/api/plan/document.test.ts` (new), `xiNAS-MCP/src/__tests__/api/plan/engine.test.ts`, `xiNAS-MCP/src/__tests__/api/routes-nfs-mutate.test.ts`

**Interfaces:**
- Produces:
  - `PlanDocument`, `PublicPlan`, `buildPlanDocument(input): PlanDocument`, `planDocumentHash(doc): string`, `publicPlan(doc): PublicPlan`, `redactValue(v): unknown`, `clientImpact(risk): string` in `document.ts`.
  - `PlanOutcome.document: PlanDocument`.
  - `Task.plan_document?: PlanDocument`, `Task.plan_document_hash?: string`.
  - `TaskStore.nextTaskId(): string`; `CreatePlanOnlyInput.task_id?: string`, `.plan_document?: PlanDocument`, `.plan_document_hash?: string`.
- Consumed later by: Task 9/10 (message + service read `task.plan_document`), Task 11 (page shows `publicPlan`).

- [ ] **Step 1: Write the failing unit test for the document helpers**

Create `src/__tests__/api/plan/document.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildPlanDocument,
  planDocumentHash,
  publicPlan,
  redactValue,
} from '../../../api/plan/document.js';

const base = {
  plan_id: 'plan-1',
  operation_kind: 'share.update',
  plan_hash: 'ph',
  state_revision_expected: 42,
  observed_revision_expected: 7,
  observed_at: '2026-09-04T10:00:00.000Z',
  affected_resources: [{ kind: 'Share', id: 'share-a', revision: 42 }],
  risk_level: 'changing_access',
  blockers: [],
  warnings: [{ code: 'W1', message: 'w' }],
  diff: { access: { before: 'rw', after: 'ro' } },
  rollback_model: 'changing_access',
  created_at_ms: Date.parse('2026-09-04T10:00:00.000Z'),
  principal: 'admin:demo',
  client_type: 'mcp',
};

describe('plan document (S15 §5)', () => {
  it('derives resource_ref from the primary affected resource and stamps bookkeeping', () => {
    const doc = buildPlanDocument(base);
    expect(doc.schema).toBe(1);
    expect(doc.resource_ref).toEqual({ kind: 'Share', id: 'share-a' });
    expect(doc.created_at).toBe('2026-09-04T10:00:00.000Z');
    expect(doc.created_by).toEqual({ principal: 'admin:demo', client_type: 'mcp' });
    expect(doc.client_impact).toBe('May affect NFS clients; review the diff.');
  });

  it('publicPlan strips exactly the bookkeeping fields', () => {
    const pub = publicPlan(buildPlanDocument(base));
    expect(Object.keys(pub).sort()).toEqual(
      [
        'affected_resources', 'blockers', 'client_impact', 'diff', 'observed_at',
        'observed_revision_expected', 'plan_hash', 'plan_id', 'risk_level', 'rollback_model',
        'state_revision_expected', 'warnings',
      ].sort(),
    );
  });

  it('hash is stable under key reordering and changes with any value', () => {
    const a = buildPlanDocument(base);
    const b = buildPlanDocument({ ...base, diff: { access: { after: 'ro', before: 'rw' } } });
    expect(planDocumentHash(a)).toBe(planDocumentHash(b));
    const c = buildPlanDocument({ ...base, diff: { access: { before: 'rw', after: 'rw' } } });
    expect(planDocumentHash(c)).not.toBe(planDocumentHash(a));
  });

  it('redacts secret-looking keys at any depth with a digest, never the value', () => {
    const out = redactValue({
      a: { Password: 'hunter2', nested: [{ api_key: 'k' }] },
      token: 'abc',
      fine: 'x',
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('"abc"');
    expect(out.fine).toBe('x');
    const tok = out.token as { redacted: string; digest: string };
    expect(tok.redacted).toBe('sha256');
    expect(tok.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the diff persisted in the document is redacted and the hash covers the redacted form', () => {
    const doc = buildPlanDocument({ ...base, diff: { secret: 's3', before: 1 } });
    expect(JSON.stringify(doc.diff)).not.toContain('s3');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/api/plan/document.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `document.ts`**

```ts
import { createHash } from 'node:crypto';
import { canonicalize } from '../../lib/canonical-json.js';
import type { ResourceRef } from '../tasks/types.js';

/**
 * The persisted public plan (S15 §5). Built once by PlanEngine.plan(), stored
 * on the plan_only row (migration 006), and the ONLY source every Plan
 * envelope is rendered from — so what the client saw and what a later
 * confirmation shows are the same bytes.
 */
export const PLAN_DOCUMENT_SCHEMA = 1 as const;

export interface PlanDocument {
  schema: typeof PLAN_DOCUMENT_SCHEMA;
  plan_id: string;
  operation_kind: string;
  /** Primary resource: affected_resources[0] (the S2 contract), id null for create kinds without one. */
  resource_ref: { kind: string; id: string | null };
  plan_hash: string;
  state_revision_expected: number;
  observed_revision_expected: number | null;
  observed_at: string | null;
  affected_resources: ResourceRef[];
  risk_level: string;
  client_impact: string;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  diff: unknown;
  rollback_model: string;
  created_at: string;
  created_by: { principal: string; client_type: string };
}

/** The api-v1.yaml `Plan` envelope: the document minus its bookkeeping. */
export type PublicPlan = Omit<
  PlanDocument,
  'schema' | 'operation_kind' | 'resource_ref' | 'created_at' | 'created_by'
>;

export interface BuildPlanDocumentInput {
  plan_id: string;
  operation_kind: string;
  plan_hash: string;
  state_revision_expected: number;
  observed_revision_expected?: number | undefined;
  observed_at?: string | undefined;
  affected_resources: ResourceRef[];
  risk_level: string;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  diff: unknown;
  rollback_model: string;
  created_at_ms: number;
  principal: string;
  client_type: string;
}

/** Plain-language NFS-client impact for the Plan envelope (moved from apply-helpers). */
export function clientImpact(riskLevel: string): string {
  return riskLevel === 'non_disruptive'
    ? 'No impact on NFS clients.'
    : 'May affect NFS clients; review the diff.';
}

const SECRET_KEY = /^(password|passwd|secret|token|api_key|private_key|authorization)$/i;

/** Replace secret-looking keys at any depth by a digest marker (S15 §5.2). */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? { redacted: 'sha256', digest: sha256(canonicalize(v)) } : redactValue(v);
    }
    return out;
  }
  return value;
}

export function buildPlanDocument(input: BuildPlanDocumentInput): PlanDocument {
  const primary = input.affected_resources[0];
  return {
    schema: PLAN_DOCUMENT_SCHEMA,
    plan_id: input.plan_id,
    operation_kind: input.operation_kind,
    resource_ref: { kind: primary?.kind ?? input.operation_kind, id: primary?.id ?? null },
    plan_hash: input.plan_hash,
    state_revision_expected: input.state_revision_expected,
    observed_revision_expected: input.observed_revision_expected ?? null,
    observed_at: input.observed_at ?? null,
    affected_resources: input.affected_resources,
    risk_level: input.risk_level,
    client_impact: clientImpact(input.risk_level),
    blockers: input.blockers,
    warnings: redactValue(input.warnings) as Array<{ code: string; message: string }>,
    diff: redactValue(input.diff),
    rollback_model: input.rollback_model,
    created_at: new Date(input.created_at_ms).toISOString(),
    created_by: { principal: input.principal, client_type: input.client_type },
  };
}

export function planDocumentHash(doc: PlanDocument): string {
  return sha256(canonicalize(doc));
}

export function publicPlan(doc: PlanDocument): PublicPlan {
  const { schema: _s, operation_kind: _k, resource_ref: _r, created_at: _c, created_by: _b, ...rest } =
    doc;
  return rest;
}

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Run the document test to verify it passes**

Run: `npx vitest run src/__tests__/api/plan/document.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing engine + store tests**

In `engine.test.ts` append inside `describe('PlanEngine.plan')`:

```ts
  it('S15: persists the plan document + hash and returns it; the row round-trips it', async () => {
    const { task, document } = await h.engine.plan(makePlanArgs());
    expect(document.plan_id).toBe(task.task_id);
    expect(document.plan_hash).toBe(task.plan_hash);
    expect(document.operation_kind).toBe('reference.echo');
    expect(document.created_by).toEqual({ principal: 'admin:test', client_type: 'rest' });
    const stored = h.store.get(task.task_id);
    expect(stored?.plan_document).toEqual(document);
    expect(stored?.plan_document_hash).toMatch(/^[0-9a-f]{64}$/);
  });
```

In `routes-nfs-mutate.test.ts` append inside the top-level describe:

```ts
  it('S15: the Plan envelope is byte-identical to the public projection of the stored document', async () => {
    const { publicPlan } = await import('../../api/plan/document.js');
    const res = await post('/api/v1/shares', { mode: 'plan', spec: CREATE_SPEC });
    expect(res.status).toBe(200);
    const result = res.body.result as Record<string, unknown>;
    const stored = setup.tasks.store.get(result.plan_id as string);
    expect(stored?.plan_document).toBeDefined();
    const { id: _echoedId, ...envelope } = result;
    expect(envelope).toEqual(publicPlan(stored?.plan_document as never));
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run src/__tests__/api/plan/engine.test.ts src/__tests__/api/routes-nfs-mutate.test.ts -t S15`
Expected: FAIL — `document` undefined / `plan_document` undefined.

- [ ] **Step 7: Store + types changes**

`api/tasks/types.ts` — add to `Task` after `desired_rollback?`:

```ts
  /** The public plan exactly as rendered (S15 §5); undefined before migration 006. */
  plan_document?: import('../plan/document.js').PlanDocument;
  plan_document_hash?: string;
```

`api/tasks/store.ts`:

1. `CreatePlanOnlyInput` gains `task_id?: string; plan_document?: PlanDocument; plan_document_hash?: string;` (import `type PlanDocument` from `'../plan/document.js'`).
2. `INSERT_TASK_SQL`: add `plan_document, plan_document_hash` to the column list (after `desired_rollback`) and `@plan_document, @plan_document_hash` to the values list.
3. `insertTask(fields)`: add `plan_document: unknown; plan_document_hash: string | undefined; task_id?: string | undefined;` to its parameter type; replace `const task_id = this.newId();` with `const task_id = fields.task_id ?? this.newId();`; in the `.run({...})` add `plan_document: fields.plan_document === undefined ? null : JSON.stringify(fields.plan_document), plan_document_hash: fields.plan_document_hash ?? null,`.
4. `createPlanOnly` passes `task_id: input.task_id, plan_document: input.plan_document, plan_document_hash: input.plan_document_hash`; `createApplyTask` passes `plan_document: undefined, plan_document_hash: undefined, task_id: undefined`.
5. `TaskRow` gains `plan_document: string | null; plan_document_hash: string | null;` and `rowToTask` adds
   `...(row.plan_document !== null ? { plan_document: JSON.parse(row.plan_document) as PlanDocument } : {}),`
   `...(row.plan_document_hash !== null ? { plan_document_hash: row.plan_document_hash } : {}),`.
6. Add a public method next to `createPlanOnly`:

```ts
  /** A fresh task id for a caller that must know the id before the insert (PlanEngine, S15 §5). */
  nextTaskId(): string {
    return this.newId();
  }
```

- [ ] **Step 8: Plan engine**

In `api/plan/engine.ts`: import `{ type PlanDocument, buildPlanDocument, planDocumentHash }` from `'./document.js'`; extend `PlanOutcome` with `document: PlanDocument;`; add `now?: () => number` to `PlanEngineDeps` (default `Date.now`) stored as `this.now`; in `plan()` after `planHash` is computed:

```ts
    const planId = this.store.nextTaskId();
    const document = buildPlanDocument({
      plan_id: planId,
      operation_kind: args.operation_kind,
      plan_hash: planHash,
      state_revision_expected: result.state_revision_expected ?? 0,
      observed_revision_expected: result.observed_revision_expected,
      observed_at: result.observed_at,
      affected_resources: result.affected_resources,
      risk_level: result.risk_level,
      blockers: result.blockers,
      warnings: result.warnings,
      diff: result.diff,
      rollback_model: result.rollback_model,
      created_at_ms: this.now(),
      principal: args.principal,
      client_type: args.client_type,
    });
```

and pass `task_id: planId, plan_document: document, plan_document_hash: planDocumentHash(document)` into `createPlanOnly`; return `{ task, planResult: result, document }`.

- [ ] **Step 9: Render from the document at all ten sites**

`api/routes/apply-helpers.ts`: delete the local `clientImpact`; import `{ publicPlan }` from `'../plan/document.js'`; in `planMode` destructure `{ task, document }` and replace the object literal with

```ts
  sendOk(req, res, { ...publicPlan(document), ...extra }, [revision]);
```

(keep `rc.operation_id = task.task_id;` and `const revision = task.state_revision_expected ?? 0;`).

At each of the nine bespoke sites (`arrays.ts` ×3, `filesystems.ts` ×3, `network.ts` ×2 — every place that builds a `{ plan_id, plan_hash, …, rollback_model }` literal): destructure `{ task, planResult, document }` from `planEngine.plan(...)` and replace the literal with `publicPlan(document)` (keep any route-specific extras by spreading them after). Remove the now-unused `clientImpact` imports; keep `planResult` only where the route still reads it (e.g. blockers for a 4xx), otherwise drop it from the destructuring.

- [ ] **Step 9b: Route-computed revision pins (ruling R-3.1, added during execution)**

Four kinds pin no `state_revision_expected` in their provider result — `xiraid.array.modify`, `xiraid.array.delete` (`arrays.ts`), the `fs.*` update kinds and `fs.unmanage` (`filesystems.ts`) — and their routes compute the live revision they report. A literal `publicPlan(document)` swap would render `0` there and break every later apply. Do NOT patch the response after rendering; instead:

- `PlanArgs` gains `document_overrides?: { state_revision_expected?: number; observed_revision_expected?: number | null; observed_at?: string | null }`.
- In `PlanEngine.plan()`, `buildPlanDocument` receives `state_revision_expected: args.document_overrides?.state_revision_expected ?? result.state_revision_expected ?? 0`, and `observed_revision_expected` / `observed_at` from the override when the key is present (a present `null` wins), else from the result. `createPlanOnly` is unchanged — the row column keeps the provider's (unpinned) value, because the engine's desired-revision freshness check reads it and those kinds deliberately do not pin it.
- The four routes compute their revision BEFORE calling `plan()` and pass it as `document_overrides`; their responses become pure `publicPlan(document)` with no post-spread override.
- Engine comment: "the row column feeds the freshness check those kinds skip; the document is what the client saw (S15 §5.1, R-3.1)."
- Parity: extend the parity assertion to one of these routes (e.g. `PATCH /api/v1/arrays/{id}` plan in `routes-arrays.test.ts`, or `PATCH /api/v1/filesystems/{id}` in `routes-filesystems.test.ts` — whichever suite already has a reachable plan fixture): `response.result` deep-equals `publicPlan(stored document)` and the stored document's `state_revision_expected` equals the response's non-zero value.

- [ ] **Step 10: Run the full suite**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: all green. If `format:check` fails, run `npm run format:write` and re-check.

- [ ] **Step 11: Commit**

```bash
git add xiNAS-MCP/src/api/plan/document.ts xiNAS-MCP/src/api/plan/engine.ts xiNAS-MCP/src/api/tasks/types.ts xiNAS-MCP/src/api/tasks/store.ts xiNAS-MCP/src/api/routes/apply-helpers.ts xiNAS-MCP/src/api/routes/arrays.ts xiNAS-MCP/src/api/routes/filesystems.ts xiNAS-MCP/src/api/routes/network.ts xiNAS-MCP/src/__tests__/api/plan/document.test.ts xiNAS-MCP/src/__tests__/api/plan/engine.test.ts xiNAS-MCP/src/__tests__/api/routes-nfs-mutate.test.ts
git commit -m "feat(plan): persist the public plan document and render every Plan envelope from it (S15 §5)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Configuration — `mcp.confirmation.*` and the key-ring path

**Files:**
- Modify: `xiNAS-MCP/src/api/config.ts`
- Test: `xiNAS-MCP/src/__tests__/api/config-mcp-confirmation.test.ts` (new)

**Interfaces:**
- Produces:
  - `ApproverPolicy = 'distinct_principal' | 'any_admin'`; `McpConfirmationConfig` (all optional); `ApiConfig.mcp.confirmation?: McpConfirmationConfig`; `ApiConfig.state.confirmationKeyPath?: string`.
  - `ResolvedConfirmationConfig` (all fields present) and `resolveConfirmationConfig(config: ApiConfig): ResolvedConfirmationConfig` with `approval_url_base: string | undefined` (trailing slash stripped).
  - `confirmationKeyPathFor(config: ApiConfig): string` — `state.confirmationKeyPath ?? join(dirname(state.databasePath), 'mcp-confirmation-keys.json')`.
  - `loadConfig()` throws at load on any out-of-range value (`validateMcpSection`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  type ApiConfig,
  confirmationKeyPathFor,
  loadConfig,
  resolveConfirmationConfig,
} from '../../api/config.js';

function inline(mcp: Record<string, unknown>): ApiConfig {
  return {
    controller_id: '00000000-0000-0000-0000-0000000000aa',
    listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
    tokens: {},
    state: { databasePath: '/var/lib/xinas/state/xinas.db', auditJsonlPath: '/tmp/a.jsonl' },
    mcp: mcp as ApiConfig['mcp'],
  };
}

describe('mcp.confirmation config (S15 §13)', () => {
  it('applies the defaults when the section is absent', () => {
    const r = resolveConfirmationConfig(inline({}));
    expect(r).toEqual({
      ttl_seconds: 300,
      url_wait_seconds: 25,
      max_pending_per_principal: 5,
      max_pending_total: 100,
      create_rate_per_minute: 10,
      approval_url_base: undefined,
      approver_policy: 'distinct_principal',
      allow_uds_approval: false,
    });
    expect(confirmationKeyPathFor(inline({}))).toBe(
      '/var/lib/xinas/state/mcp-confirmation-keys.json',
    );
  });

  it.each([
    ['ttl_seconds', 59],
    ['ttl_seconds', 901],
    ['url_wait_seconds', 0],
    ['url_wait_seconds', 56],
    ['max_pending_per_principal', 51],
    ['max_pending_total', 0],
    ['create_rate_per_minute', 601],
  ])('rejects %s = %s at load', (key, value) => {
    expect(() => loadConfig({ inline: inline({ confirmation: { [key]: value } }) })).toThrow(
      new RegExp(`mcp.confirmation.${key}`),
    );
  });

  it('rejects an unknown approver_policy and a non-boolean allow_uds_approval', () => {
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { approver_policy: 'anyone' } }) }),
    ).toThrow(/approver_policy/);
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { allow_uds_approval: 'yes' } }) }),
    ).toThrow(/allow_uds_approval/);
  });

  it('approval_url_base must be https, or http on a loopback host; trailing slash is stripped', () => {
    expect(
      resolveConfirmationConfig(
        inline({ confirmation: { approval_url_base: 'https://nas-01.example.com/' } }),
      ).approval_url_base,
    ).toBe('https://nas-01.example.com');
    expect(
      resolveConfirmationConfig(
        inline({ confirmation: { approval_url_base: 'http://127.0.0.1:8080' } }),
      ).approval_url_base,
    ).toBe('http://127.0.0.1:8080');
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { approval_url_base: 'http://nas-01:8080' } }) }),
    ).toThrow(/approval_url_base/);
    expect(() =>
      loadConfig({ inline: inline({ confirmation: { approval_url_base: 'not a url' } }) }),
    ).toThrow(/approval_url_base/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/api/config-mcp-confirmation.test.ts`
Expected: FAIL — `resolveConfirmationConfig` is not exported.

- [ ] **Step 3: Implement**

In `config.ts` add after `TokenPrincipal`:

```ts
export type ApproverPolicy = 'distinct_principal' | 'any_admin';

/** S15 §13 — every field optional; defaults in MCP_CONFIRMATION_DEFAULTS. */
export interface McpConfirmationConfig {
  ttl_seconds?: number;
  url_wait_seconds?: number;
  max_pending_per_principal?: number;
  max_pending_total?: number;
  create_rate_per_minute?: number;
  /** `https://host[:port][/prefix]`, or `http://` on a loopback host only. Required for URL mode. */
  approval_url_base?: string;
  approver_policy?: ApproverPolicy;
  allow_uds_approval?: boolean;
}

export interface ResolvedConfirmationConfig {
  ttl_seconds: number;
  url_wait_seconds: number;
  max_pending_per_principal: number;
  max_pending_total: number;
  create_rate_per_minute: number;
  approval_url_base: string | undefined;
  approver_policy: ApproverPolicy;
  allow_uds_approval: boolean;
}

export const MCP_CONFIRMATION_DEFAULTS: Omit<ResolvedConfirmationConfig, 'approval_url_base'> = {
  ttl_seconds: 300,
  url_wait_seconds: 25,
  max_pending_per_principal: 5,
  max_pending_total: 100,
  create_rate_per_minute: 10,
  approver_policy: 'distinct_principal',
  allow_uds_approval: false, // break-glass; spec §3.5
};
```

Extend `ApiConfig`: `state` gains `confirmationKeyPath?: string;` (comment: "HMAC key ring for MCP requestState (S15 §7.6); default beside the DB"); `mcp` gains `confirmation?: McpConfirmationConfig;`.

Add (imports `dirname`, `join` from `node:path`):

```ts
export function confirmationKeyPathFor(config: ApiConfig): string {
  return config.state.confirmationKeyPath ?? join(dirname(config.state.databasePath), 'mcp-confirmation-keys.json');
}

export function resolveConfirmationConfig(config: ApiConfig): ResolvedConfirmationConfig {
  const c = config.mcp?.confirmation ?? {};
  return {
    ttl_seconds: c.ttl_seconds ?? MCP_CONFIRMATION_DEFAULTS.ttl_seconds,
    url_wait_seconds: c.url_wait_seconds ?? MCP_CONFIRMATION_DEFAULTS.url_wait_seconds,
    max_pending_per_principal:
      c.max_pending_per_principal ?? MCP_CONFIRMATION_DEFAULTS.max_pending_per_principal,
    max_pending_total: c.max_pending_total ?? MCP_CONFIRMATION_DEFAULTS.max_pending_total,
    create_rate_per_minute: c.create_rate_per_minute ?? MCP_CONFIRMATION_DEFAULTS.create_rate_per_minute,
    approval_url_base: c.approval_url_base?.replace(/\/+$/, ''),
    approver_policy: c.approver_policy ?? MCP_CONFIRMATION_DEFAULTS.approver_policy,
    allow_uds_approval: c.allow_uds_approval ?? MCP_CONFIRMATION_DEFAULTS.allow_uds_approval,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function rangeCheck(name: string, value: unknown, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `mcp.confirmation.${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`,
    );
  }
}

/** S15 §13: out-of-range values fail at load, never at apply. */
function validateMcpSection(config: ApiConfig): void {
  const c = config.mcp?.confirmation;
  if (c === undefined) return;
  rangeCheck('ttl_seconds', c.ttl_seconds, 60, 900);
  rangeCheck('url_wait_seconds', c.url_wait_seconds, 1, 55);
  rangeCheck('max_pending_per_principal', c.max_pending_per_principal, 1, 50);
  rangeCheck('max_pending_total', c.max_pending_total, 1, 1000);
  rangeCheck('create_rate_per_minute', c.create_rate_per_minute, 1, 600);
  if (c.approver_policy !== undefined && c.approver_policy !== 'distinct_principal' && c.approver_policy !== 'any_admin') {
    throw new Error(`mcp.confirmation.approver_policy must be 'distinct_principal' or 'any_admin'`);
  }
  if (c.allow_uds_approval !== undefined && typeof c.allow_uds_approval !== 'boolean') {
    throw new Error('mcp.confirmation.allow_uds_approval must be a boolean');
  }
  if (c.approval_url_base !== undefined) {
    let url: URL;
    try {
      url = new URL(c.approval_url_base);
    } catch {
      throw new Error('mcp.confirmation.approval_url_base must be an absolute URL');
    }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error(
        'mcp.confirmation.approval_url_base must use https:// (http:// is accepted only on a loopback host)',
      );
    }
    if (url.search !== '' || url.hash !== '') {
      throw new Error('mcp.confirmation.approval_url_base must not carry a query or fragment');
    }
  }
  if (c.approver_policy === 'any_admin') {
    console.warn('mcp.confirmation.approver_policy=any_admin: the requesting principal may approve its own destructive request');
  }
  if (c.allow_uds_approval === true) {
    console.warn(
      'mcp.confirmation.allow_uds_approval=true: break-glass — anyone with root or xinas-admin on this node (an agent included) can approve MCP confirmations; every use is audited as break_glass_used',
    );
  }
}
```

Call `validateMcpSection(config)` right after each `validateTasksSection(...)` call in `loadConfig` (both the inline and the file branch).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/__tests__/api/config-mcp-confirmation.test.ts` → PASS. Then `npm run typecheck && npm run lint && npm run format:check`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/config.ts xiNAS-MCP/src/__tests__/api/config-mcp-confirmation.test.ts
git commit -m "feat(api): mcp.confirmation config section with bounded validation (S15 §13)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Shared results/errors modules and the `requestState` codec

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/results.ts`
- Create: `xiNAS-MCP/src/api/mcp/confirmation/errors.ts`
- Create: `xiNAS-MCP/src/api/mcp/confirmation/state.ts`
- Modify: `xiNAS-MCP/src/api/mcp/dispatch.ts` (import `ToolResult`, `text`, `errorResult` from `results.ts`; delete the local copies; keep `export type { ToolResult }` re-export so existing importers compile)
- Test: `xiNAS-MCP/src/__tests__/api/mcp/request-state.test.ts` (new)

**Interfaces:**
- `results.ts`: `ToolResult` (as today), `InputRequiredToolResult { resultType: 'input_required'; inputRequests: Record<string, ElicitRequestSpec>; requestState: string }`, `ElicitRequestSpec = { method: 'elicitation/create'; params: ElicitFormParams | ElicitUrlParams }`, `text(payload)`, `errorResult(code, message, details?)`, `isInputRequired(r): r is InputRequiredToolResult`.
- `errors.ts`: `class McpProtocolError extends Error { readonly code: number; readonly httpStatus: number; readonly data?: Record<string, unknown>; readonly reasonClass?: string }` — `reasonClass` is for audit only, never serialized.
- `state.ts`: `REQUEST_STATE_PREFIX = 'xc1'`, `REQUEST_STATE_MAX_BYTES = 4096`, `RequestStatePayload`, `KeyRing { active: string; keys: Map<string, Buffer> }`, `loadOrCreateKeyRing(path): KeyRing`, `mintRequestState(ring, payload): string`, `verifyRequestState(ring, encoded: unknown): RequestStatePayload` (throws `McpProtocolError(-32602, 'invalid request state')` with `reasonClass` in `size|format|kid|mac|schema`), `newNonce(): string`, `nonceHash(nonce): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpProtocolError } from '../../../api/mcp/confirmation/errors.js';
import {
  type KeyRing,
  type RequestStatePayload,
  REQUEST_STATE_MAX_BYTES,
  loadOrCreateKeyRing,
  mintRequestState,
  newNonce,
  nonceHash,
  verifyRequestState,
} from '../../../api/mcp/confirmation/state.js';

const payload: RequestStatePayload = {
  v: 1, cid: 'c-1', sub: 'admin:demo', role: 'admin', tool: 'shares.update', ah: 'a'.repeat(64),
  pid: 'plan-1', ph: 'b'.repeat(64), rev: 42, ik: 'idem-1', risk: 'changing_access', mode: 'form',
  iat: 1_757_000_000_000, exp: 1_757_000_300_000, nonce: 'n0nce', round: 1,
};

describe('requestState codec (S15 §7)', () => {
  let dir: string;
  let ring: KeyRing;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-keyring-'));
    ring = loadOrCreateKeyRing(join(dir, 'keys.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a 0600 key ring with one 32-byte active key and reloads it identically', () => {
    const path = join(dir, 'keys.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ring.keys.get(ring.active)?.length).toBe(32);
    const again = loadOrCreateKeyRing(path);
    expect(again.active).toBe(ring.active);
    expect(again.keys.get(again.active)?.equals(ring.keys.get(ring.active) as Buffer)).toBe(true);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { active: string; keys: Record<string, string> };
    expect(Object.keys(file.keys)).toEqual([ring.active]);
  });

  it('refuses a symlinked ring and a ring readable by group or world (review P1)', () => {
    const real = join(dir, 'real.json');
    loadOrCreateKeyRing(real);
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    expect(() => loadOrCreateKeyRing(link)).toThrow(/regular file/);
    chmodSync(real, 0o640);
    expect(() => loadOrCreateKeyRing(real)).toThrow(/group\/world/);
    chmodSync(real, 0o600);
    expect(loadOrCreateKeyRing(real).active).toBe('k1');
  });

  it('a lost EEXIST race loads the other writer\'s ring instead of overwriting it', () => {
    const path = join(dir, 'race.json');
    const first = loadOrCreateKeyRing(path);
    // Simulate "someone created it between our check and our write": the
    // second call must find the exclusive create failing with EEXIST and
    // load first's key, never a fresh one.
    const second = loadOrCreateKeyRing(path);
    expect(second.keys.get('k1')?.equals(first.keys.get('k1') as Buffer)).toBe(true);
  });

  it('round-trips a payload through mint → verify with the xc1 prefix', () => {
    const encoded = mintRequestState(ring, payload);
    expect(encoded.startsWith(`xc1.${ring.active}.`)).toBe(true);
    expect(encoded.split('.')).toHaveLength(4);
    expect(verifyRequestState(ring, encoded)).toEqual(payload);
  });

  it('rejects every single-character alteration with the same generic error', () => {
    const encoded = mintRequestState(ring, payload);
    for (let i = 0; i < encoded.length; i += 1) {
      const ch = encoded[i] === 'A' ? 'B' : 'A';
      const tampered = encoded.slice(0, i) + ch + encoded.slice(i + 1);
      if (tampered === encoded) continue;
      let err: unknown;
      try {
        verifyRequestState(ring, tampered);
      } catch (e) {
        err = e;
      }
      expect(err, `position ${i}`).toBeInstanceOf(McpProtocolError);
      expect((err as McpProtocolError).code).toBe(-32602);
      expect((err as McpProtocolError).message).toBe('invalid request state');
    }
  });

  it('rejects a foreign key, an unknown kid, a wrong prefix, truncation, oversize and non-strings', () => {
    const other = loadOrCreateKeyRing(join(dir, 'other.json'));
    const encoded = mintRequestState(other, payload);
    expect(() => verifyRequestState(ring, encoded)).toThrow('invalid request state');
    const [, , body, mac] = mintRequestState(ring, payload).split('.');
    expect(() => verifyRequestState(ring, `xc1.nope.${body}.${mac}`)).toThrow('invalid request state');
    expect(() => verifyRequestState(ring, `xc2.${ring.active}.${body}.${mac}`)).toThrow('invalid request state');
    expect(() => verifyRequestState(ring, `xc1.${ring.active}.${body}`)).toThrow('invalid request state');
    expect(() => verifyRequestState(ring, 'x'.repeat(REQUEST_STATE_MAX_BYTES + 1))).toThrow('invalid request state');
    expect(() => verifyRequestState(ring, 42)).toThrow('invalid request state');
    expect(() => verifyRequestState(ring, undefined)).toThrow('invalid request state');
  });

  it('rejects a well-signed payload with a wrong field type or unknown version', () => {
    const bad = mintRequestState(ring, { ...payload, rev: '42' } as unknown as RequestStatePayload);
    expect(() => verifyRequestState(ring, bad)).toThrow('invalid request state');
    const badV = mintRequestState(ring, { ...payload, v: 2 } as unknown as RequestStatePayload);
    expect(() => verifyRequestState(ring, badV)).toThrow('invalid request state');
  });

  it('accepts a state minted with a retired-but-listed key and rejects one whose kid was removed', () => {
    const k0 = ring.keys.get(ring.active) as Buffer;
    const encoded = mintRequestState(ring, payload);
    const rotated: KeyRing = { active: 'k2', keys: new Map([['k2', Buffer.alloc(32, 7)], [ring.active, k0]]) };
    expect(verifyRequestState(rotated, encoded)).toEqual(payload);
    const removed: KeyRing = { active: 'k2', keys: new Map([['k2', Buffer.alloc(32, 7)]]) };
    expect(() => verifyRequestState(removed, encoded)).toThrow('invalid request state');
  });

  it('nonces are 22-char base64url and nonceHash is sha256 hex', () => {
    const n = newNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonceHash(n)).toMatch(/^[0-9a-f]{64}$/);
    expect(nonceHash(n)).toBe(nonceHash(n));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/api/mcp/request-state.test.ts` → FAIL (module not found).

- [ ] **Step 3: Create `results.ts`**

```ts
/**
 * Tool-result shapes shared by the dispatcher, the modern handler and the
 * S15 confirmation service. Moved out of dispatch.ts so the confirmation
 * service can build results without importing the dispatcher (which imports
 * the service — types only, but keep the value graph acyclic).
 */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ElicitFormParams {
  mode: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'string'; enum: string[]; title: string }>;
    required: string[];
  };
}

export interface ElicitUrlParams {
  mode: 'url';
  message: string;
  url: string;
}

export interface ElicitRequestSpec {
  method: 'elicitation/create';
  params: ElicitFormParams | ElicitUrlParams;
}

/** The unfinished-MRTR answer (S15 §4.3/§4.4): always both fields. */
export interface InputRequiredToolResult {
  resultType: 'input_required';
  inputRequests: Record<string, ElicitRequestSpec>;
  requestState: string;
}

export const text = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

export const errorResult = (code: string, message: string, details?: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
  isError: true,
});

export function isInputRequired(r: ToolResult | InputRequiredToolResult): r is InputRequiredToolResult {
  return (r as InputRequiredToolResult).resultType === 'input_required';
}
```

In `dispatch.ts`: replace the local `ToolResult` interface, `text` and `errorResult` with `import { type ToolResult, errorResult, text } from './results.js';` and add `export type { ToolResult } from './results.js';` so `modern.ts` and tests keep importing it from `dispatch.ts`.

- [ ] **Step 4: Create `errors.ts`**

```ts
/**
 * A JSON-RPC protocol error raised on the modern path (S14 §5.1, S15 §11).
 * `httpStatus` is what transport.ts answers with (the 2026-07-28 schema
 * mandates 400 for -32021); `reasonClass` is for the audit trail only and
 * is never serialized to the client.
 */
export class McpProtocolError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly data?: Record<string, unknown>;
  readonly reasonClass?: string;

  constructor(
    code: number,
    message: string,
    opts: { httpStatus?: number; data?: Record<string, unknown>; reasonClass?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.httpStatus = opts.httpStatus ?? 200;
    if (opts.data !== undefined) this.data = opts.data;
    if (opts.reasonClass !== undefined) this.reasonClass = opts.reasonClass;
  }
}

export const INVALID_PARAMS = -32602;
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;

export function invalidRequestState(reasonClass: string): McpProtocolError {
  return new McpProtocolError(INVALID_PARAMS, 'invalid request state', { reasonClass });
}
```

- [ ] **Step 5: Create `state.ts`**

```ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalize } from '../../../lib/canonical-json.js';
import { invalidRequestState } from './errors.js';

/** S15 §7 — the opaque, HMAC-SHA-256-protected requestState. */
export const REQUEST_STATE_PREFIX = 'xc1';
export const REQUEST_STATE_MAX_BYTES = 4096;

export interface RequestStatePayload {
  v: 1;
  cid: string;
  sub: string;
  role: string;
  tool: string;
  ah: string;
  pid: string;
  ph: string;
  rev: number;
  ik: string;
  risk: string;
  mode: 'form' | 'url';
  iat: number;
  exp: number;
  nonce: string;
  round: number;
}

export interface KeyRing {
  active: string;
  keys: Map<string, Buffer>;
}

interface KeyRingFile {
  active: string;
  keys: Record<string, string>; // base64
}

const KID = /^[A-Za-z0-9_-]{1,16}$/;

const GROUP_OR_WORLD = 0o077;

/**
 * Exclusive, no-follow create (S15 §7.6, review P1). Returns false when the
 * path already existed — including when another actor won the race — so
 * the caller loads it. There is never an "exists, then write" window.
 */
function createExclusive(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    const file: KeyRingFile = { active: 'k1', keys: { k1: randomBytes(32).toString('base64') } };
    writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Refuse anything but a regular, owner-only file we own; read it without following links. */
function readRingSafely(path: string): KeyRingFile {
  const st = lstatSync(path);
  if (!st.isFile()) {
    throw new Error(`confirmation key ring ${path} must be a regular file (not a symlink)`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`confirmation key ring ${path} is owned by uid ${st.uid}, expected ${uid}`);
  }
  if ((st.mode & GROUP_OR_WORLD) !== 0) {
    throw new Error(
      `confirmation key ring ${path} mode 0${(st.mode & 0o777).toString(8)} grants group/world access; expected 0600`,
    );
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(readFileSync(fd, 'utf8')) as KeyRingFile;
  } finally {
    closeSync(fd);
  }
}

/** Load the ring, creating `{ active: 'k1', keys: { k1: <32 random bytes> } }` exclusively when absent. */
export function loadOrCreateKeyRing(path: string): KeyRing {
  createExclusive(path); // false → it exists (or another writer won the race): load it
  const raw = readRingSafely(path);
  const keys = new Map<string, Buffer>();
  for (const [kid, b64] of Object.entries(raw.keys)) {
    if (!KID.test(kid)) throw new Error(`confirmation key ring: invalid key id '${kid}' in ${path}`);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 32) throw new Error(`confirmation key ring: key '${kid}' is shorter than 32 bytes`);
    keys.set(kid, buf);
  }
  if (!keys.has(raw.active)) throw new Error(`confirmation key ring: active key '${raw.active}' is not listed`);
  return { active: raw.active, keys };
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(body, 'utf8').digest();
}

export function mintRequestState(ring: KeyRing, payload: RequestStatePayload): string {
  const key = ring.keys.get(ring.active);
  if (key === undefined) throw new Error('confirmation key ring has no active key');
  const body = `${REQUEST_STATE_PREFIX}.${ring.active}.${b64url(Buffer.from(canonicalize(payload), 'utf8'))}`;
  return `${body}.${b64url(mac(key, body))}`;
}

function isPayload(v: unknown): v is RequestStatePayload {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  const str = (k: string) => typeof p[k] === 'string' && (p[k] as string).length > 0;
  const int = (k: string) => typeof p[k] === 'number' && Number.isInteger(p[k]);
  return (
    p.v === 1 &&
    ['cid', 'sub', 'role', 'tool', 'ah', 'pid', 'ph', 'ik', 'risk', 'nonce'].every(str) &&
    ['rev', 'iat', 'exp', 'round'].every(int) &&
    (p.mode === 'form' || p.mode === 'url')
  );
}

/**
 * Verify in the order S15 §7.4 mandates: size → format → kid → MAC
 * (constant-time) → decode → schema. Every failure is the same generic
 * -32602; the class of failure is kept on the error for the audit trail.
 */
export function verifyRequestState(ring: KeyRing, encoded: unknown): RequestStatePayload {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > REQUEST_STATE_MAX_BYTES) {
    throw invalidRequestState('size');
  }
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== REQUEST_STATE_PREFIX) throw invalidRequestState('format');
  const [, kid, body, sig] = parts as [string, string, string, string];
  if (!KID.test(kid) || body.length === 0 || sig.length === 0) throw invalidRequestState('format');
  const key = ring.keys.get(kid);
  if (key === undefined) throw invalidRequestState('kid');
  // Compare the CANONICAL base64url text of the MAC, not decoded bytes:
  // base64url without padding has trailing-bit slack, so two different last
  // characters can decode to the same bytes — comparing text rejects every
  // single-character alteration and every non-canonical encoding.
  const expected = Buffer.from(b64url(mac(key, `${REQUEST_STATE_PREFIX}.${kid}.${body}`)), 'utf8');
  const given = Buffer.from(sig, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw invalidRequestState('mac');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalidRequestState('schema');
  }
  if (!isPayload(parsed)) throw invalidRequestState('schema');
  return parsed;
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}
```

Note: the MAC is compared as canonical base64url *text* in constant time (see the comment in the code) — decoding the client's signature first would accept non-canonical encodings whose trailing bits differ.

- [ ] **Step 6: Run the tests and the full gate**

Run: `npx vitest run src/__tests__/api/mcp/request-state.test.ts` → PASS; then `npm run typecheck && npm run lint && npm run format:check && npm test` → green (the `dispatch.ts` refactor must not change any existing test).

- [ ] **Step 7: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/results.ts xiNAS-MCP/src/api/mcp/confirmation/errors.ts xiNAS-MCP/src/api/mcp/confirmation/state.ts xiNAS-MCP/src/api/mcp/dispatch.ts xiNAS-MCP/src/__tests__/api/mcp/request-state.test.ts
git commit -m "feat(mcp): requestState HMAC codec with a persisted key ring; shared tool-result module (S15 §7)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `ConfirmationStore` — the durable record and its guarded transitions

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/confirmation/types.ts`
- Create: `xiNAS-MCP/src/api/mcp/confirmation/store.ts`
- Create: `xiNAS-MCP/src/api/mcp/confirmation/audit.ts`
- Test: `xiNAS-MCP/src/__tests__/api/mcp/confirmation-store.test.ts` (new)

**Interfaces:**
- `types.ts`: `ConfirmationStatus`, `ConfirmationMode`, `ApprovalChannel = 'mcp_form' | 'bearer' | 'uds_break_glass'` (verified, from the auth verdict), `ApprovalInterface = 'web' | 'rest'` (untrusted label), `ExpiredReason = 'ttl' | 'round_limit' | 'plan_stale' | 'revision_changed' | 'restart_sweep'`, `ConfirmationRecord` (spec §6.1, epoch-ms numbers, optionals absent when NULL), `MAX_ROUNDS = 3`, `TERMINAL_CONFIRMATION_STATUSES`, `ACK_DATA_LOSS = 'DATA MAY BE PERMANENTLY LOST'`, `ACK_NO_ROLLBACK = 'ROLLBACK IS NOT SUPPORTED'`, `REQUEST_KEY = 'confirm_apply'`.
- `store.ts`: `ConfirmationStore` with `constructor({ db, now, newId? })`, `create(input): ConfirmationRecord`, `get(id)`, `list({ status?, principal?, limit? })`, `findOpenByBindings(key: BindingKey)`, `countOpen(principal?)`, `reissue(id, nonceHash)`, `approve(id, by, channel, iface?, reason?)`, `decline(id, by, channel, iface?, reason?)`, `cancel(id, by)`, `expire(id, reason)`, `consume({ confirmation_id, task_id, from, principal, now }): boolean`, `countPendingByMode(): { form: number; url: number }` (pending + approved per mode — the scrape-time gauge source), `sweepExpired(now, reason): ConfirmationRecord[]`, `pruneTerminal(cutoffMs): number`. Every transition is a guarded `UPDATE … WHERE status IN (…)`; a miss returns `null` (or `false`).
- `audit.ts`: `ConfirmationEvent` union of the thirteen event names (spec §12.1, including `break_glass_used`) and `queueConfirmationEvent(audit, event, record, extra?)` building the `mcp.confirmation.<event>` row.

- [ ] **Step 1: Write the failing test**

```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CreateConfirmationInput,
  ConfirmationStore,
} from '../../../api/mcp/confirmation/store.js';
import { runMigrations } from '../../../state/migrations.js';

function harness() {
  const db = new Database(':memory:');
  runMigrations(db);
  let clock = 1_000_000;
  let n = 0;
  const store = new ConfirmationStore({ db, now: () => clock, newId: () => `c-${(n += 1)}` });
  return { db, store, setClock: (v: number) => { clock = v; } };
}

const input: CreateConfirmationInput = {
  mode: 'form', principal: 'admin:demo', role: 'admin', tool_name: 'shares.update',
  operation_kind: 'share.update', arguments_hash: 'ah', plan_id: 'plan-1', plan_hash: 'ph',
  plan_document_hash: 'dh', idempotency_key: 'ik', expected_revision: 42,
  risk_level: 'changing_access', rollback_model: 'changing_access',
  request_state_nonce_hash: 'nh1', ttl_ms: 300_000, correlation_id: 'corr', request_id: 'req',
  node_id: 'node',
};

describe('ConfirmationStore (S15 §6)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('creates a pending round-1 record with expires_at = created_at + ttl', () => {
    const r = h.store.create(input);
    expect(r).toMatchObject({ confirmation_id: 'c-1', status: 'pending', round: 1, created_at: 1_000_000, expires_at: 1_300_000 });
    expect(h.store.get('c-1')).toEqual(r);
    expect(h.store.get('nope')).toBeNull();
  });

  it('findOpenByBindings matches pending/approved rows with equal bindings only', () => {
    h.store.create(input);
    const key = { principal: 'admin:demo', tool_name: 'shares.update', arguments_hash: 'ah', plan_id: 'plan-1', idempotency_key: 'ik', expected_revision: 42 };
    expect(h.store.findOpenByBindings(key)?.confirmation_id).toBe('c-1');
    expect(h.store.findOpenByBindings({ ...key, expected_revision: 43 })).toBeNull();
    h.store.decline('c-1', 'op', 'rest');
    expect(h.store.findOpenByBindings(key)).toBeNull();
  });

  it('reissue bumps the round and swaps the nonce hash; a 4th round is refused by the caller, not here', () => {
    h.store.create(input);
    const r2 = h.store.reissue('c-1', 'nh2');
    expect(r2).toMatchObject({ round: 2, request_state_nonce_hash: 'nh2' });
    h.store.expire('c-1', 'round_limit');
    expect(h.store.reissue('c-1', 'nh3')).toBeNull(); // terminal rows never move again
  });

  it('approve / decline / cancel / expire are guarded transitions and terminal rows are frozen', () => {
    h.store.create({ ...input, mode: 'url' });
    expect(h.store.approve('c-1', 'admin:other', 'bearer', 'web', 'ok')).toMatchObject({ status: 'approved', approved_by: 'admin:other', approval_channel: 'bearer', approval_interface: 'web', decision_reason: 'ok', approved_at: 1_000_000 });
    expect(h.store.approve('c-1', 'x', 'bearer')).toBeNull(); // not pending any more
    expect(h.store.decline('c-1', 'admin:other', 'uds_break_glass')).toMatchObject({ status: 'declined', approval_channel: 'bearer' }); // channel of the APPROVAL is kept; the decline's own channel is in the audit row
    expect(h.store.cancel('c-1', 'admin:demo')).toBeNull();
    expect(h.store.expire('c-1', 'ttl')).toBeNull();
    expect(h.store.approve('c-1', 'x', 'bearer')).toBeNull();
    expect(h.store.get('c-1')?.status).toBe('declined');
  });

  it('consume: form needs pending, url needs approved; both refuse an expired row; single use', () => {
    h.store.create(input); // c-1 form
    h.store.create({ ...input, mode: 'url', idempotency_key: 'ik2' }); // c-2 url
    expect(h.store.consume({ confirmation_id: 'c-2', task_id: 't-1', from: 'approved', principal: 'admin:demo', now: 1_000_001 })).toBe(false);
    h.store.approve('c-2', 'admin:other', 'bearer', 'web');
    expect(h.store.consume({ confirmation_id: 'c-2', task_id: 't-1', from: 'approved', principal: 'admin:demo', now: 1_000_001 })).toBe(true);
    expect(h.store.get('c-2')).toMatchObject({ status: 'consumed', consumed_task_id: 't-1', consumed_at: 1_000_001, approved_by: 'admin:other' });
    expect(h.store.consume({ confirmation_id: 'c-2', task_id: 't-2', from: 'approved', principal: 'admin:demo', now: 1_000_002 })).toBe(false);

    expect(h.store.consume({ confirmation_id: 'c-1', task_id: 't-3', from: 'pending', principal: 'admin:demo', now: 1_300_000 })).toBe(false); // expired
    expect(h.store.consume({ confirmation_id: 'c-1', task_id: 't-3', from: 'pending', principal: 'admin:demo', now: 1_299_999 })).toBe(true);
    expect(h.store.get('c-1')).toMatchObject({ status: 'consumed', approved_by: 'admin:demo', approval_channel: 'mcp_form', approved_at: 1_299_999 });
  });

  it('countOpen counts pending + approved, per principal and globally', () => {
    h.store.create(input);
    h.store.create({ ...input, idempotency_key: 'b', principal: 'admin:two' });
    h.store.create({ ...input, idempotency_key: 'c', mode: 'url' });
    h.store.approve('c-3', 'x', 'bearer');
    h.store.decline('c-2', 'x', 'bearer');
    expect(h.store.countOpen()).toBe(2);
    expect(h.store.countOpen('admin:demo')).toBe(2);
    expect(h.store.countOpen('admin:two')).toBe(0);
    // the scrape-time gauge source: pending + approved, per mode (review P2)
    expect(h.store.countPendingByMode()).toEqual({ form: 1, url: 1 });
  });

  it('sweepExpired expires only open rows past expires_at and reports them; prune deletes old terminals', () => {
    h.store.create(input);
    h.store.create({ ...input, idempotency_key: 'b' });
    h.store.decline('c-2', 'x', 'bearer');
    expect(h.store.sweepExpired(1_299_999, 'ttl')).toEqual([]);
    const swept = h.store.sweepExpired(1_300_000, 'restart_sweep');
    expect(swept.map((r) => r.confirmation_id)).toEqual(['c-1']);
    expect(h.store.get('c-1')).toMatchObject({ status: 'expired', expired_reason: 'restart_sweep' });
    expect(h.store.pruneTerminal(1_000_001)).toBe(2);
    expect(h.store.list({})).toEqual([]);
  });

  it('list filters by status/principal, newest first, honoring limit', () => {
    h.store.create(input);
    h.setClock(2_000_000);
    h.store.create({ ...input, idempotency_key: 'b' });
    expect(h.store.list({}).map((r) => r.confirmation_id)).toEqual(['c-2', 'c-1']);
    expect(h.store.list({ limit: 1 }).map((r) => r.confirmation_id)).toEqual(['c-2']);
    expect(h.store.list({ principal: 'nobody' })).toEqual([]);
    expect(h.store.list({ status: 'pending' })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/__tests__/api/mcp/confirmation-store.test.ts` → module not found.

- [ ] **Step 3: Create `types.ts`**

```ts
export type ConfirmationStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'expired' | 'consumed';
export type ConfirmationMode = 'form' | 'url';
/** VERIFIED authentication channel of the deciding request — from the auth verdict, never a header. */
export type ApprovalChannel = 'mcp_form' | 'bearer' | 'uds_break_glass';
/** UNTRUSTED UI label self-reported via X-Xinas-Approval-Interface; consulted by nothing. */
export type ApprovalInterface = 'web' | 'rest';
export type ExpiredReason = 'ttl' | 'round_limit' | 'plan_stale' | 'revision_changed' | 'restart_sweep';

export const MAX_ROUNDS = 3;
export const REQUEST_KEY = 'confirm_apply';
export const ACK_DATA_LOSS = 'DATA MAY BE PERMANENTLY LOST';
export const ACK_NO_ROLLBACK = 'ROLLBACK IS NOT SUPPORTED';
export const TERMINAL_CONFIRMATION_STATUSES: ReadonlySet<ConfirmationStatus> = new Set([
  'declined', 'cancelled', 'expired', 'consumed',
]);

/** One row of mcp_confirmations (S15 §6.1). Epoch-ms timestamps; NULL columns are absent. */
export interface ConfirmationRecord {
  confirmation_id: string;
  status: ConfirmationStatus;
  mode: ConfirmationMode;
  principal: string;
  role: string;
  tool_name: string;
  operation_kind: string;
  arguments_hash: string;
  plan_id: string;
  plan_hash: string;
  plan_document_hash: string;
  idempotency_key: string;
  expected_revision: number;
  risk_level: string;
  rollback_model: string;
  request_state_nonce_hash: string;
  round: number;
  created_at: number;
  expires_at: number;
  approved_at?: number;
  approved_by?: string;
  approval_channel?: ApprovalChannel;
  approval_interface?: ApprovalInterface;
  declined_at?: number;
  declined_by?: string;
  decision_reason?: string;
  consumed_at?: number;
  consumed_task_id?: string;
  expired_reason?: ExpiredReason;
  correlation_id: string;
  request_id: string;
  node_id: string;
}
```

- [ ] **Step 4: Create `store.ts`**

```ts
import { randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { ApprovalChannel, ApprovalInterface, ConfirmationMode, ConfirmationRecord, ConfirmationStatus, ExpiredReason } from './types.js';

export interface ConfirmationStoreDeps {
  db: Database;
  now: () => number;
  /** 16 random bytes, base64url (22 chars) — the URL path segment. */
  newId?: () => string;
}

export interface CreateConfirmationInput {
  mode: ConfirmationMode;
  principal: string;
  role: string;
  tool_name: string;
  operation_kind: string;
  arguments_hash: string;
  plan_id: string;
  plan_hash: string;
  plan_document_hash: string;
  idempotency_key: string;
  expected_revision: number;
  risk_level: string;
  rollback_model: string;
  request_state_nonce_hash: string;
  ttl_ms: number;
  correlation_id: string;
  request_id: string;
  node_id: string;
}

export interface BindingKey {
  principal: string;
  tool_name: string;
  arguments_hash: string;
  plan_id: string;
  idempotency_key: string;
  expected_revision: number;
}

export interface ConfirmationListFilter {
  status?: ConfirmationStatus;
  principal?: string;
  limit?: number;
}

const COLUMNS = `confirmation_id, status, mode, principal, role, tool_name, operation_kind,
  arguments_hash, plan_id, plan_hash, plan_document_hash, idempotency_key, expected_revision,
  risk_level, rollback_model, request_state_nonce_hash, round, created_at, expires_at,
  approved_at, approved_by, approval_channel, approval_interface, declined_at, declined_by, decision_reason,
  consumed_at, consumed_task_id, expired_reason, correlation_id, request_id, node_id`;

type Row = Record<string, unknown>;

/**
 * Prepared-statement CRUD over mcp_confirmations (S15 §6). Same pattern as
 * TaskStore: injected clock and id generator; every status change is a
 * guarded UPDATE so a terminal row can never move again and a race between
 * two writers is decided by `changes()`.
 */
export class ConfirmationStore {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly insertStmt: Statement;
  private readonly getStmt: Statement;
  private readonly findOpenStmt: Statement;
  private readonly countOpenStmt: Statement;
  private readonly countOpenByPrincipalStmt: Statement;
  private readonly countPendingByModeStmt: Statement;
  private readonly reissueStmt: Statement;
  private readonly approveStmt: Statement;
  private readonly declineStmt: Statement;
  private readonly cancelStmt: Statement;
  private readonly expireStmt: Statement;
  private readonly consumeStmt: Statement;
  private readonly expiredCandidatesStmt: Statement;
  private readonly pruneStmt: Statement;

  constructor(deps: ConfirmationStoreDeps) {
    this.db = deps.db;
    this.now = deps.now;
    this.newId = deps.newId ?? (() => randomBytes(16).toString('base64url'));
    const db = deps.db;
    this.insertStmt = db.prepare(
      `INSERT INTO mcp_confirmations (${COLUMNS}) VALUES (
        @confirmation_id, 'pending', @mode, @principal, @role, @tool_name, @operation_kind,
        @arguments_hash, @plan_id, @plan_hash, @plan_document_hash, @idempotency_key, @expected_revision,
        @risk_level, @rollback_model, @request_state_nonce_hash, 1, @created_at, @expires_at,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, @correlation_id, @request_id, @node_id)`,
    );
    this.countPendingByModeStmt = db.prepare(
      `SELECT mode, COUNT(*) AS n FROM mcp_confirmations WHERE status IN ('pending','approved') GROUP BY mode`,
    );
    this.getStmt = db.prepare(`SELECT ${COLUMNS} FROM mcp_confirmations WHERE confirmation_id = ?`);
    this.findOpenStmt = db.prepare(
      `SELECT ${COLUMNS} FROM mcp_confirmations
        WHERE status IN ('pending','approved') AND principal = @principal AND tool_name = @tool_name
          AND arguments_hash = @arguments_hash AND plan_id = @plan_id
          AND idempotency_key = @idempotency_key AND expected_revision = @expected_revision
        ORDER BY created_at DESC LIMIT 1`,
    );
    this.countOpenStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM mcp_confirmations WHERE status IN ('pending','approved')`,
    );
    this.countOpenByPrincipalStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM mcp_confirmations WHERE status IN ('pending','approved') AND principal = ?`,
    );
    this.reissueStmt = db.prepare(
      `UPDATE mcp_confirmations SET round = round + 1, request_state_nonce_hash = @nonce
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.approveStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'approved', approved_at = @now, approved_by = @by,
          approval_channel = @channel, approval_interface = @iface, decision_reason = @reason
        WHERE confirmation_id = @id AND status = 'pending'`,
    );
    this.declineStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'declined', declined_at = @now, declined_by = @by,
          approval_channel = COALESCE(approval_channel, @channel),
          approval_interface = COALESCE(approval_interface, @iface), decision_reason = @reason
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.cancelStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'cancelled', declined_at = @now, declined_by = @by
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.expireStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'expired', expired_reason = @reason
        WHERE confirmation_id = @id AND status IN ('pending','approved')`,
    );
    this.consumeStmt = db.prepare(
      `UPDATE mcp_confirmations SET status = 'consumed', consumed_at = @now, consumed_task_id = @task_id,
          approved_at = COALESCE(approved_at, @now), approved_by = COALESCE(approved_by, @principal),
          approval_channel = COALESCE(approval_channel, 'mcp_form')
        WHERE confirmation_id = @id AND status = @from AND expires_at > @now`,
    );
    this.expiredCandidatesStmt = db.prepare(
      `SELECT ${COLUMNS} FROM mcp_confirmations
        WHERE status IN ('pending','approved') AND expires_at <= ? ORDER BY expires_at ASC`,
    );
    this.pruneStmt = db.prepare(
      `DELETE FROM mcp_confirmations
        WHERE status IN ('declined','cancelled','expired','consumed') AND created_at < ?`,
    );
  }

  create(input: CreateConfirmationInput): ConfirmationRecord {
    const created_at = this.now();
    const confirmation_id = this.newId();
    this.insertStmt.run({
      ...input,
      confirmation_id,
      created_at,
      expires_at: created_at + input.ttl_ms,
    });
    return this.get(confirmation_id) as ConfirmationRecord;
  }

  get(id: string): ConfirmationRecord | null {
    const row = this.getStmt.get(id) as Row | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  list(filter: ConfirmationListFilter): ConfirmationRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit ?? 100 };
    if (filter.status !== undefined) {
      clauses.push('status = @status');
      params.status = filter.status;
    }
    if (filter.principal !== undefined) {
      clauses.push('principal = @principal');
      params.principal = filter.principal;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM mcp_confirmations ${where} ORDER BY created_at DESC, confirmation_id DESC LIMIT @limit`)
      .all(params) as Row[];
    return rows.map(rowToRecord);
  }

  findOpenByBindings(key: BindingKey): ConfirmationRecord | null {
    const row = this.findOpenStmt.get(key) as Row | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  countOpen(principal?: string): number {
    const row = (principal === undefined
      ? this.countOpenStmt.get()
      : this.countOpenByPrincipalStmt.get(principal)) as { n: number };
    return row.n;
  }

  reissue(id: string, nonce: string): ConfirmationRecord | null {
    return this.reissueStmt.run({ id, nonce }).changes === 1 ? this.get(id) : null;
  }

  approve(
    id: string,
    by: string,
    channel: ApprovalChannel,
    iface?: ApprovalInterface,
    reason?: string,
  ): ConfirmationRecord | null {
    const info = this.approveStmt.run({ id, by, channel, iface: iface ?? null, reason: reason ?? null, now: this.now() });
    return info.changes === 1 ? this.get(id) : null;
  }

  decline(
    id: string,
    by: string,
    channel: ApprovalChannel,
    iface?: ApprovalInterface,
    reason?: string,
  ): ConfirmationRecord | null {
    const info = this.declineStmt.run({ id, by, channel, iface: iface ?? null, reason: reason ?? null, now: this.now() });
    return info.changes === 1 ? this.get(id) : null;
  }

  /** Scrape-time source for the pending gauge (S15 §12.2): open rows per mode. */
  countPendingByMode(): { form: number; url: number } {
    const out = { form: 0, url: 0 };
    for (const row of this.countPendingByModeStmt.all() as Array<{ mode: 'form' | 'url'; n: number }>) {
      out[row.mode] = row.n;
    }
    return out;
  }

  cancel(id: string, by: string): ConfirmationRecord | null {
    return this.cancelStmt.run({ id, by, now: this.now() }).changes === 1 ? this.get(id) : null;
  }

  expire(id: string, reason: ExpiredReason): ConfirmationRecord | null {
    return this.expireStmt.run({ id, reason }).changes === 1 ? this.get(id) : null;
  }

  /** The single guarded consume (S15 §8.3 step 8). Runs inside the caller's transaction. */
  consume(args: {
    confirmation_id: string;
    task_id: string;
    from: 'pending' | 'approved';
    principal: string;
    now: number;
  }): boolean {
    return (
      this.consumeStmt.run({
        id: args.confirmation_id,
        task_id: args.task_id,
        from: args.from,
        principal: args.principal,
        now: args.now,
      }).changes === 1
    );
  }

  sweepExpired(now: number, reason: 'ttl' | 'restart_sweep'): ConfirmationRecord[] {
    const rows = (this.expiredCandidatesStmt.all(now) as Row[]).map(rowToRecord);
    const out: ConfirmationRecord[] = [];
    for (const r of rows) {
      const expired = this.expire(r.confirmation_id, reason);
      if (expired !== null) out.push(expired);
    }
    return out;
  }

  pruneTerminal(cutoffMs: number): number {
    return this.pruneStmt.run(cutoffMs).changes;
  }
}

function rowToRecord(row: Row): ConfirmationRecord {
  const opt = <T>(k: string): { [key: string]: T } | Record<string, never> =>
    row[k] === null || row[k] === undefined ? {} : { [k]: row[k] as T };
  return {
    confirmation_id: row.confirmation_id as string,
    status: row.status as ConfirmationStatus,
    mode: row.mode as ConfirmationMode,
    principal: row.principal as string,
    role: row.role as string,
    tool_name: row.tool_name as string,
    operation_kind: row.operation_kind as string,
    arguments_hash: row.arguments_hash as string,
    plan_id: row.plan_id as string,
    plan_hash: row.plan_hash as string,
    plan_document_hash: row.plan_document_hash as string,
    idempotency_key: row.idempotency_key as string,
    expected_revision: row.expected_revision as number,
    risk_level: row.risk_level as string,
    rollback_model: row.rollback_model as string,
    request_state_nonce_hash: row.request_state_nonce_hash as string,
    round: row.round as number,
    created_at: row.created_at as number,
    expires_at: row.expires_at as number,
    correlation_id: row.correlation_id as string,
    request_id: row.request_id as string,
    node_id: row.node_id as string,
    ...opt<number>('approved_at'),
    ...opt<string>('approved_by'),
    ...opt<ApprovalChannel>('approval_channel'),
    ...opt<ApprovalInterface>('approval_interface'),
    ...opt<number>('declined_at'),
    ...opt<string>('declined_by'),
    ...opt<string>('decision_reason'),
    ...opt<number>('consumed_at'),
    ...opt<string>('consumed_task_id'),
    ...opt<ExpiredReason>('expired_reason'),
  } as ConfirmationRecord;
}
```

- [ ] **Step 5: Create `audit.ts`**

```ts
import { createHash } from 'node:crypto';
import type { AuditAppender } from '../../../state/audit.js';
import { canonicalize } from '../../../lib/canonical-json.js';
import type { ConfirmationRecord } from './types.js';

/** S15 §12.1 — the security events; kinds are `mcp.confirmation.<event>`. */
export type ConfirmationEvent =
  | 'requested' | 'reissued' | 'viewed' | 'approved' | 'declined' | 'cancelled' | 'expired'
  | 'break_glass_used' // a uds_break_glass decision — only with allow_uds_approval: true
  | 'verification_failed' | 'replay_rejected' | 'capability_missing' | 'consumed' | 'apply_task_created';

export interface ConfirmationEventExtra {
  /** Who acted when it is not the record's principal (approver, viewer). */
  actor?: string;
  actor_client_type?: 'rest' | 'mcp';
  task_id?: string;
  reason?: string;
  /** Free-form, never secrets: round numbers, channels, the OTHER principal on a replay. */
  detail?: Record<string, unknown>;
}

/**
 * Queue one lifecycle row. Safe inside a db.transaction (AuditAppender is
 * built for it) and outside (its own implicit transaction). Never includes
 * a requestState, a MAC, a token or plan content — only ids, hashes,
 * principals and reason codes.
 */
export function queueConfirmationEvent(
  audit: AuditAppender | undefined,
  event: ConfirmationEvent,
  record: ConfirmationRecord,
  extra: ConfirmationEventExtra = {},
): void {
  if (audit === undefined) return;
  const payload: Record<string, unknown> = {
    confirmation_id: record.confirmation_id,
    plan_id: record.plan_id,
    plan_hash: record.plan_hash,
    principal: record.principal,
    operation_kind: record.operation_kind,
    tool_name: record.tool_name,
    risk_level: record.risk_level,
    mode: record.mode,
    status: record.status,
    correlation_id: record.correlation_id,
    ...(extra.actor !== undefined ? { approver: extra.actor } : {}),
    ...(extra.task_id !== undefined ? { task_id: extra.task_id } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
  };
  audit.queue({
    kind: `mcp.confirmation.${event}`,
    principal: extra.actor ?? record.principal,
    client_type: extra.actor_client_type ?? 'mcp',
    request_id: record.request_id,
    parameters_hash: `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`,
    result_hash: `sha256:${createHash('sha256').update(event).digest('hex')}`,
    operation_id: record.confirmation_id,
    ...(extra.task_id !== undefined ? { task_id: extra.task_id } : {}),
    payload,
  });
}
```

- [ ] **Step 6: Run the tests + gate**

`npx vitest run src/__tests__/api/mcp/confirmation-store.test.ts` → PASS; `npm run typecheck && npm run lint && npm run format:check` → green.

- [ ] **Step 7: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/confirmation/types.ts xiNAS-MCP/src/api/mcp/confirmation/store.ts xiNAS-MCP/src/api/mcp/confirmation/audit.ts xiNAS-MCP/src/__tests__/api/mcp/confirmation-store.test.ts
git commit -m "feat(mcp): ConfirmationStore with guarded transitions, sweep and prune; lifecycle audit helper (S15 §6, §12.1)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Catalog — `operation_kinds`, `mcp_exposed`, the approval entries, and hiding them from MCP

**Files:**
- Modify: `xiNAS-MCP/src/api/mcp/catalog.ts`
- Modify: `xiNAS-MCP/src/api/mcp/dispatch.ts` (`listTools`, `callTool` lookup)
- Modify: `xiNAS-MCP/src/api/mcp/discover.ts:79` (`buildCapabilities` ignores hidden entries)
- Modify: `xiNAS-MCP/src/cli/xinasctl.ts:254-262` (usage text: one line naming the approval commands)
- Test: `xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts`, `xiNAS-MCP/src/__tests__/api/mcp-dispatch.test.ts`, `xiNAS-MCP/src/__tests__/cli/xinasctl.test.ts`

**Interfaces:**
- `CatalogEntry` gains `operation_kinds?: string[]`, `mcp_exposed?: boolean` (default true), `confirmation?: 'required'`.
- `planApply(name, method, path, description, minRole, operationKinds: string[], over?)` — new 6th positional parameter.
- New entries: `mcp_confirmations.list`, `mcp_confirmations.get`, `mcp_confirmations.approve`, `mcp_confirmations.decline` (all `min_role: 'admin'`, `mcp_exposed: false`), `system.metrics` (`GET /metrics`, `binary: true`, viewer).
- `listTools()` skips `mcp_exposed === false` and `binary === true`; `callTool()` answers `NOT_FOUND` for them.

- [ ] **Step 1: Write the failing tests**

Append to `mcp-catalog.test.ts` inside `describe('client catalog (S8 T2)')`:

```ts
  it('S15: every plan_apply entry names the engine kinds its route can produce', () => {
    const byName = new Map(CATALOG.map((e) => [e.name, e]));
    for (const e of CATALOG.filter((x) => x.mutability === 'plan_apply')) {
      expect(e.operation_kinds?.length, `${e.name} needs operation_kinds`).toBeGreaterThan(0);
    }
    expect(byName.get('shares.update')?.operation_kinds).toEqual(['share.update']);
    expect(byName.get('arrays.create')?.operation_kinds).toEqual(['xiraid.array.create']);
    expect(byName.get('arrays.import')?.operation_kinds).toEqual(['xiraid.array.import']);
    expect(byName.get('filesystems.update')?.operation_kinds).toEqual([
      'fs.mount', 'fs.unmount', 'fs.grow', 'fs.set_quota_mode',
    ]);
    expect(byName.get('filesystems.delete')?.operation_kinds).toEqual(['fs.unmanage']);
    expect(byName.get('config_history.rollback')?.operation_kinds).toEqual(['config.rollback']);
    expect(byName.get('network.pool.apply')?.operation_kinds).toEqual(['net.pool.apply']);
  });

  it('S15: the approval commands exist for the CLI and RBAC but are hidden from MCP', () => {
    const byName = new Map(CATALOG.map((e) => [e.name, e]));
    for (const name of [
      'mcp_confirmations.list', 'mcp_confirmations.get',
      'mcp_confirmations.approve', 'mcp_confirmations.decline',
    ]) {
      const e = byName.get(name);
      expect(e, name).toBeDefined();
      expect(e?.min_role).toBe('admin');
      expect(e?.mcp_exposed).toBe(false);
      expect(e?.requires_mcp_apply).toBe(false);
    }
    expect(matchCatalog('POST', '/mcp/confirmations/abc/approve')?.name).toBe('mcp_confirmations.approve');
    expect(matchCatalog('GET', '/mcp/confirmations')?.name).toBe('mcp_confirmations.list');
    expect(matchCatalog('GET', '/metrics')?.name).toBe('system.metrics');
    expect(byName.get('system.metrics')?.binary).toBe(true);
  });
```

Append to `mcp-dispatch.test.ts`:

```ts
import { listTools } from '../../api/mcp/dispatch.js';

describe('S15: hidden catalog entries never surface over MCP', () => {
  it('listTools omits mcp_exposed:false and binary entries', () => {
    const names = listTools().map((t) => t.name);
    expect(names).not.toContain('mcp_confirmations.approve');
    expect(names).not.toContain('mcp_confirmations.list');
    expect(names).not.toContain('system.metrics');
    expect(names).toContain('shares.update');
  });
});
```

(The `callTool` NOT_FOUND case is covered in Task 10's integration suite, where a dispatcher exists.)

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/__tests__/api/mcp-catalog.test.ts src/__tests__/api/mcp-dispatch.test.ts -t S15` → FAIL.

- [ ] **Step 3: Implement the catalog changes**

In `catalog.ts`:

**(a)** `CatalogEntry` gains, after `returns_async_task?`:

```ts
  /**
   * S15: the engine kinds this plan_apply entry's route can produce (most
   * list one; filesystems.update lists four). The confirmation service
   * requires the plan document's kind to be listed here — a plan_id cannot
   * be replayed against another tool.
   */
  operation_kinds?: string[];
  /**
   * S15: false = generated for xinasctl and RBAC only, never a tools/list
   * entry and never callable through tools/call (the approval commands —
   * a model must not approve its own request even with an admin token).
   */
  mcp_exposed?: boolean;
  /** S15: explicit opt-in for an entry that needs confirmation but fits neither shape. */
  confirmation?: 'required';
```

**(b)** `planApply` gains a 6th positional parameter `operationKinds: string[]` before `over`, and spreads `operation_kinds: operationKinds`. Update the 18 call sites with these arrays:

| entry | operation_kinds |
|---|---|
| `arrays.create` | `['xiraid.array.create']` |
| `arrays.import` | `['xiraid.array.import']` |
| `arrays.modify` | `['xiraid.array.modify']` |
| `arrays.delete` | `['xiraid.array.delete']` |
| `filesystems.create` | `['fs.create']` |
| `filesystems.update` | `['fs.mount', 'fs.unmount', 'fs.grow', 'fs.set_quota_mode']` |
| `filesystems.delete` | `['fs.unmanage']` |
| `shares.create` / `.update` / `.delete` | `['share.create']` / `['share.update']` / `['share.delete']` |
| `nfs_profiles.update` | `['nfs-profile.update']` |
| `nfs_idmap.set` | `['nfs-idmap.set']` |
| `network.interfaces.update` | `['net.iface.update']` |
| `network.pool.apply` | `['net.pool.apply']` |
| `config_history.rollback` | `['config.rollback']` |
| `pools.create` / `.modify` / `.delete` | `['pool.create']` / `['pool.modify']` / `['pool.delete']` |

**(c)** Append before the `// ── users / groups ──` block:

```ts
  // ── MCP apply confirmations (S15) — operator-only; hidden from MCP ──
  {
    ...read('mcp_confirmations.list', 'GET', '/mcp/confirmations',
      'List MCP apply confirmations (admin). Never an MCP tool.',
      { min_role: 'admin', mcp_exposed: false }),
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'declined', 'cancelled', 'expired', 'consumed'] },
        principal: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
      additionalProperties: false,
    },
  },
  read('mcp_confirmations.get', 'GET', '/mcp/confirmations/{id}',
    'Show one MCP apply confirmation with its stored plan and summary (admin).',
    { min_role: 'admin', mcp_exposed: false }),
  {
    name: 'mcp_confirmations.approve',
    description:
      'Approve a pending URL-mode MCP confirmation out of band (admin; approver policy applies). Destructive records require --acknowledge "DATA MAY BE PERMANENTLY LOST"; unsupported-rollback records require "ROLLBACK IS NOT SUPPORTED".',
    method: 'POST',
    path: '/mcp/confirmations/{id}/approve',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'confirmation id' },
        acknowledge: { type: 'string', description: 'exact acknowledgement phrase' },
        reason: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    mutability: 'direct',
    requires_mcp_apply: false,
    min_role: 'admin',
    status: 'live',
    mcp_exposed: false,
  },
  {
    name: 'mcp_confirmations.decline',
    description: 'Decline a pending or approved MCP confirmation (admin). The MCP client receives CONFIRMATION_DECLINED; nothing is mutated.',
    method: 'POST',
    path: '/mcp/confirmations/{id}/decline',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'confirmation id' }, reason: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    mutability: 'direct',
    requires_mcp_apply: false,
    min_role: 'admin',
    status: 'live',
    mcp_exposed: false,
  },
  read('system.metrics', 'GET', '/metrics',
    'Prometheus text exposition of api-internal counters (S15; CLI only).',
    { binary: true }),
```

Consumers of the new fields:

1. `dispatch.ts`: define once, near the top, `const mcpVisible = (e: CatalogEntry): boolean => e.binary !== true && e.mcp_exposed !== false;` and use it in `listTools()` (`CATALOG.filter(mcpVisible)`) and in `callTool()`'s lookup (`CATALOG.find((e) => e.name === name && mcpVisible(e))`).
2. `discover.ts`: `if (CATALOG.some((e) => e.binary !== true && e.mcp_exposed !== false)) capabilities.tools = {};`.
3. `xinasctl.ts` `usage()`: after the flags lines push `'approvals: xinasctl mcp_confirmations list|get <id>|approve <id> --acknowledge "<phrase>"|decline <id> [--reason ...]'`.

- [ ] **Step 4: Run the suite** — `npm test` (the catalog test's `same method+path entries share min_role` invariant still holds) and the gate.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/catalog.ts xiNAS-MCP/src/api/mcp/dispatch.ts xiNAS-MCP/src/api/mcp/discover.ts xiNAS-MCP/src/cli/xinasctl.ts xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts xiNAS-MCP/src/__tests__/api/mcp-dispatch.test.ts
git commit -m "feat(catalog): operation_kinds per plan_apply entry, mcp_exposed flag, approval and metrics entries hidden from MCP (S15 §9.4)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Core enforcement — loopback header, request context, and the apply-transaction gate

**Files:**
- Modify: `xiNAS-MCP/src/api/context.ts` (`RequestContext.mcp_confirmation_id`, `TaskEngines.confirmations`)
- Modify: `xiNAS-MCP/src/api/middleware/auth.ts:63-91`
- Modify: `xiNAS-MCP/src/api/tasks/engine.ts` (`ApplyRequest`, `TaskEngineDeps`, `apply()`)
- Modify: `xiNAS-MCP/src/api/tasks/build.ts` (build the store; pass `confirmations`, `audit`, `clock`, `allowMcpApply`)
- Modify: `xiNAS-MCP/src/api/server.ts:73-78` (pass `allowMcpApply`)
- Modify: `xiNAS-MCP/src/api/routes/apply-helpers.ts:235-245`; `arrays.ts` (3 apply sites), `filesystems.ts` (3), `network.ts` (2) — thread `confirmation_id`; `support.ts:104-113` — `confirmation_exempt: true`
- Test: `xiNAS-MCP/src/__tests__/api/tasks/apply.test.ts`, `xiNAS-MCP/src/__tests__/api/loopback-auth.test.ts`

**Interfaces:**
- `RequestContext.mcp_confirmation_id?: string` — set only by the loopback branch of `authMiddleware`.
- `ApplyRequest.confirmation_id?: string; confirmation_exempt?: true`.
- `TaskEngineDeps.confirmations?: ConfirmationStore; audit?: AuditAppender; clock?: () => number; allowMcpApply?: () => boolean`.
- `TaskEngines.confirmations: ConfirmationStore` (built in `buildTaskEngines` over `state.db` with the same `now`).
- `BuildTaskEnginesOptions.allowMcpApply?: () => boolean`.

- [ ] **Step 1: Write the failing engine tests**

In `apply.test.ts`, extend `makeHarness()`: import `ConfirmationStore` from `'../../../api/mcp/confirmation/store.js'`; after `const leases = …` add `let confCounter = 0; const confirmations = new ConfirmationStore({ db, now: () => clock, newId: () => \`c-${(confCounter += 1)}\` });` with `let allowApply = true;` declared above, then construct the engine as `new TaskEngine({ db, store, leases, kv, confirmations, clock: () => clock, allowMcpApply: () => allowApply })` and `setAllowApply(v: boolean) { allowApply = v; }` returned; also return `confirmations`. Then append:

```ts
describe('TaskEngine.apply — MCP confirmation gate (S15 §8.3)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  const mcpReq = (over: Partial<ApplyRequest> = {}): ApplyRequest =>
    makeApplyReq({ client_type: 'mcp', ...over });

  function createRecord(mode: 'form' | 'url', over: Record<string, unknown> = {}) {
    return h.confirmations.create({
      mode, principal: 'admin:test', role: 'admin', tool_name: 'reference.echo',
      operation_kind: 'reference.echo', arguments_hash: 'ah', plan_id: 'plan-1', plan_hash: 'phash-1',
      plan_document_hash: 'dh', idempotency_key: 'idem-1', expected_revision: 1,
      risk_level: 'non_disruptive', rollback_model: 'non_disruptive', request_state_nonce_hash: 'nh',
      ttl_ms: 300_000, correlation_id: 'corr-1', request_id: 'req-1', node_id: 'node',
      ...over,
    } as never);
  }

  it('refuses an MCP apply that carries no trusted confirmation context (fail closed)', () => {
    expect(() => h.engine.apply({ plan: makePlan(), applyReq: mcpReq() })).toThrow(ApiException);
    try {
      h.engine.apply({ plan: makePlan(), applyReq: mcpReq() });
    } catch (e) {
      expect((e as ApiException).details?.reason).toBe('confirmation_required');
    }
    expect(h.countTasks()).toBe(0);
    expect(h.countLeases()).toBe(0);
  });

  it('a REST apply is untouched by the gate', () => {
    expect(h.engine.apply({ plan: makePlan(), applyReq: makeApplyReq() }).state).toBe('queued');
  });

  it('confirmation_exempt (support.bundle) bypasses the gate for an MCP apply', () => {
    const task = h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_exempt: true }) });
    expect(task.state).toBe('queued');
  });

  it('mcp.allow_apply false is re-checked in the core', () => {
    createRecord('form');
    h.setAllowApply(false);
    expect(() => h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) }))
      .toThrow(/disabled/);
  });

  it('form: a pending record is consumed with the inserted task id in the same transaction', () => {
    createRecord('form');
    const task = h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) });
    expect(task.state).toBe('queued');
    expect(h.confirmations.get('c-1')).toMatchObject({
      status: 'consumed', consumed_task_id: task.task_id, approved_by: 'admin:test', approval_channel: 'mcp_form',
    });
  });

  it('url: pending is refused, approved is consumed', () => {
    createRecord('url');
    expect(() => h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) }))
      .toThrow(/not approved/);
    expect(h.countTasks()).toBe(0);
    h.confirmations.approve('c-1', 'admin:other', 'rest');
    const task = h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) });
    expect(h.confirmations.get('c-1')).toMatchObject({ status: 'consumed', consumed_task_id: task.task_id, approved_by: 'admin:other' });
  });

  it('every binding is checked: principal, plan, hash, key, revision, kind, expiry', () => {
    const cases: Array<[string, Partial<ApplyPlan>, Partial<ApplyRequest>, number]> = [
      ['principal', {}, { principal: 'admin:someone-else' }, 0],
      ['plan_id', { plan_id: 'plan-2' }, {}, 0],
      ['plan_hash', { plan_hash: 'phash-2' }, {}, 0],
      ['idempotency_key', {}, { idempotency_key: 'idem-9' }, 0],
      ['kind', { kind: 'share.update' }, {}, 0],
      ['expiry', {}, {}, 300_000],
    ];
    for (const [label, planOver, reqOver, advance] of cases) {
      h = makeHarness();
      createRecord('form');
      if (advance > 0) h.setClock(1_000 + advance);
      expect(
        () => h.engine.apply({ plan: makePlan(planOver), applyReq: mcpReq({ confirmation_id: 'c-1', ...reqOver }) }),
        label,
      ).toThrow(ApiException);
      expect(h.countTasks(), label).toBe(0);
      expect(h.confirmations.get('c-1')?.status, label).toBe('pending');
    }
  });

  it('a dangerous-gate failure rolls back without consuming; the corrected retry consumes', () => {
    createRecord('form', { risk_level: 'destructive' });
    const plan = makePlan({ risk_level: 'destructive' });
    expect(() => h.engine.apply({ plan, applyReq: mcpReq({ confirmation_id: 'c-1' }) })).toThrow(/dangerous/);
    expect(h.confirmations.get('c-1')?.status).toBe('pending');
    expect(h.countTasks()).toBe(0);
    const task = h.engine.apply({ plan, applyReq: mcpReq({ confirmation_id: 'c-1', dangerous: true }) });
    expect(h.confirmations.get('c-1')).toMatchObject({ status: 'consumed', consumed_task_id: task.task_id });
  });

  it('a revision-drift failure expires the record (re-plan required)', () => {
    createRecord('form');
    h.bumpResource();
    expect(() => h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) })).toThrow(/revision/);
    expect(h.confirmations.get('c-1')).toMatchObject({ status: 'expired', expired_reason: 'revision_changed' });
  });

  it('idempotent replay returns the same task only through the consumed record; a consumed record cannot back a second task', () => {
    createRecord('form'); // c-1
    const first = h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) });
    const replay = h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) });
    expect(replay.task_id).toBe(first.task_id);
    expect(h.countTasks()).toBe(1);
    // same confirmation, different key → the record is consumed → refused
    expect(() =>
      h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1', idempotency_key: 'idem-2' }) }),
    ).toThrow(/not approved/);
  });

  it('the same key with a different, fresh confirmation is idempotency_key_reused', () => {
    createRecord('form'); // c-1
    h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-1' }) });
    createRecord('form'); // c-2 — same idempotency_key 'idem-1', never consumed
    expect(() =>
      h.engine.apply({ plan: makePlan(), applyReq: mcpReq({ confirmation_id: 'c-2' }) }),
    ).toThrow(/idempotency key reused/);
    expect(h.countTasks()).toBe(1);
    expect(h.confirmations.get('c-2')?.status).toBe('pending');
  });
});
```

(The harness's `ConfirmationStore` uses a counter-based `newId` — `c-1`, `c-2`, … — see the harness change below.)

- [ ] **Step 2: Write the failing loopback-auth tests**

Append to `loopback-auth.test.ts`:

```ts
  it('S15: X-Xinas-Confirmation is copied into the context ONLY under the loopback bearer', async () => {
    const token = setup.ctx.loopback_token as string;
    let seen: string | undefined;
    setup.app.get('/probe-confirmation', (req, res) => {
      seen = req.context?.mcp_confirmation_id;
      res.json({ ok: true });
    });
    await request(setup.app)
      .get('/probe-confirmation')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Xinas-Forwarded-Principal', 'admin:test')
      .set('X-Xinas-Forwarded-Role', 'admin')
      .set('X-Xinas-Client-Type', 'mcp')
      .set('X-Xinas-Confirmation', 'c-123');
    expect(seen).toBe('c-123');

    seen = undefined;
    await request(setup.app)
      .get('/probe-confirmation')
      .set('Authorization', ADMIN_TOKEN)
      .set('X-Xinas-Client-Type', 'mcp')
      .set('X-Xinas-Confirmation', 'c-forged');
    expect(seen).toBeUndefined();
  });
```

(`buildTestApp()` returns the express app before any catch-all is registered for arbitrary top-level paths? It is not — `/probe-confirmation` is outside `/api/v1`, and `app.ts` mounts the 404 catch-all on the v1 router only; verify by running the test. If the route is swallowed, register the probe through `setup.app.use` before the request and assert the same way.)

- [ ] **Step 3: Run to verify they fail** — `npx vitest run src/__tests__/api/tasks/apply.test.ts src/__tests__/api/loopback-auth.test.ts` → FAIL (`confirmations` unknown property / header ignored).

- [ ] **Step 4: Context + auth**

`context.ts`: add to `RequestContext`:

```ts
  /**
   * S15 §8.1: the MCP confirmation the dispatcher validated, forwarded on the
   * loopback-only `X-Xinas-Confirmation` header and copied here by
   * authMiddleware ONLY under the ephemeral loopback bearer. Never read from
   * a request body.
   */
  mcp_confirmation_id?: string;
```

and to `TaskEngines`: `confirmations: import('./mcp/confirmation/store.js').ConfirmationStore;`.

`auth.ts` loopback branch, after `if (fwdClient === 'mcp') ctx.client_type = 'mcp';`:

```ts
        const fwdConfirmation = req.header('x-xinas-confirmation');
        if (typeof fwdConfirmation === 'string' && fwdConfirmation.length > 0) {
          ctx.mcp_confirmation_id = fwdConfirmation;
        }
```

and widen the warn condition: `if (fwdPrincipal !== undefined || fwdRole !== undefined || req.header('x-xinas-confirmation') !== undefined)` with the message mentioning `X-Xinas-Forwarded-*/X-Xinas-Confirmation`.

- [ ] **Step 5: Engine**

`engine.ts` imports: `import type { AuditAppender } from '../../state/audit.js';`, `import type { ConfirmationStore } from '../mcp/confirmation/store.js';`, `import type { ConfirmationRecord } from '../mcp/confirmation/types.js';`, `import { queueConfirmationEvent } from '../mcp/confirmation/audit.js';`.

`ApplyRequest` gains:

```ts
  /**
   * S15 §8.3 (ruling R-3.1): the integer the client echoed as
   * `expected_revision` in the apply body — the value the confirmation
   * record is compared against. Every apply route already parses it.
   */
  expected_revision?: number;
  /**
   * S15 §8.2: the confirmation the MCP dispatcher validated (from
   * ctx.mcp_confirmation_id — loopback-only). Required whenever
   * client_type is 'mcp' unless the route sets `confirmation_exempt`.
   */
  confirmation_id?: string;
  /** Route policy, never client input: only the support-bundle route sets it (ADR-0010 exemption). */
  confirmation_exempt?: true;
```

`TaskEngineDeps` gains `confirmations?: ConfirmationStore; audit?: AuditAppender; clock?: () => number; allowMcpApply?: () => boolean;` stored on the instance (`this.clock = deps.clock ?? (() => Date.now())`).

In `apply()`:

(a) step 1 idempotent-replay branch becomes:

```ts
        if (existing.input_hash === applyReq.input_hash) {
          if (applyReq.client_type === 'mcp' && applyReq.confirmation_exempt !== true) {
            // S15 §8.5: an MCP replay is honored only through the confirmation
            // that produced the task; any other confirmation is a reuse.
            const rec =
              applyReq.confirmation_id !== undefined
                ? (this.confirmations?.get(applyReq.confirmation_id) ?? null)
                : null;
            if (rec === null || rec.status !== 'consumed' || rec.consumed_task_id !== existing.task_id) {
              throw new ApiException(
                'CONFLICT',
                'idempotency key reused with a different request',
                { reason: 'idempotency_key_reused' },
                'Use a fresh idempotency_key for a different request, or re-send the original request.',
              );
            }
          }
          return existing;
        }
```

(b) insert step 2 right after the idempotency block and before the dangerous gate:

```ts
      // 2. S15 §8.3 — MCP confirmation gate: VERIFY here (before dangerous,
      //    so dangerous can never stand in for it); CONSUME after the INSERT.
      let confirmation: ConfirmationRecord | undefined;
      if (applyReq.client_type === 'mcp' && applyReq.confirmation_exempt !== true) {
        if (this.allowMcpApply !== undefined && !this.allowMcpApply()) {
          throw new ApiException(
            'PRECONDITION_FAILED',
            'apply via MCP is disabled',
            { reason: 'mcp_apply_disabled', config_key: 'mcp.allow_apply' },
            'Set mcp.allow_apply: true in the api config, or apply via REST/xinasctl.',
          );
        }
        if (this.confirmations === undefined || applyReq.confirmation_id === undefined) {
          throw new ApiException(
            'PRECONDITION_FAILED',
            'an MCP apply requires a verified confirmation',
            { reason: 'confirmation_required' },
            'Run the apply through the MCP confirmation flow (input_required). REST and xinasctl applies are not affected.',
          );
        }
        const record = this.confirmations.get(applyReq.confirmation_id);
        const now = this.clock();
        const consumableFrom = record?.mode === 'url' ? 'approved' : 'pending';
        if (
          record === null ||
          record.principal !== applyReq.principal ||
          record.plan_id !== plan.plan_id ||
          record.plan_hash !== (plan.plan_hash ?? '') ||
          record.idempotency_key !== applyReq.idempotency_key ||
          record.operation_kind !== plan.kind ||
          // Ruling R-3.1: the client's echoed revision, threaded like `dangerous`
          // — never the row column, which route-computed kinds leave unpinned.
          record.expected_revision !== applyReq.expected_revision ||
          record.expires_at <= now ||
          record.status !== consumableFrom
        ) {
          throw new ApiException(
            'PRECONDITION_FAILED',
            'the confirmation is not approved for this apply',
            { reason: 'confirmation_not_approved', ...(record !== null ? { status: record.status } : {}) },
            'Start a fresh apply through the MCP confirmation flow.',
          );
        }
        confirmation = record;
      }
```

(c) after `const task = this.store.createApplyTask({...});` and before the lease loop:

```ts
      // 8. S15 §8.3 — consume the confirmation with the id the INSERT just produced.
      if (confirmation !== undefined) {
        const ok = (this.confirmations as ConfirmationStore).consume({
          confirmation_id: confirmation.confirmation_id,
          task_id: task.task_id,
          from: confirmation.mode === 'url' ? 'approved' : 'pending',
          principal: applyReq.principal,
          now: this.clock(),
        });
        if (!ok) {
          throw new ApiException(
            'PRECONDITION_FAILED',
            'the confirmation was consumed by a concurrent apply',
            { reason: 'confirmation_not_approved', status: 'consumed' },
            'Retry the identical request to receive the task it produced, or start a fresh apply.',
          );
        }
        const consumed = (this.confirmations as ConfirmationStore).get(confirmation.confirmation_id) ?? confirmation;
        queueConfirmationEvent(this.audit, 'consumed', consumed, { task_id: task.task_id });
        queueConfirmationEvent(this.audit, 'apply_task_created', consumed, { task_id: task.task_id });
      }
```

(d) wrap the final `return run();` so a freshness failure expires the record:

```ts
    try {
      return run();
    } catch (err) {
      if (
        err instanceof ApiException &&
        this.confirmations !== undefined &&
        applyReq.client_type === 'mcp' &&
        applyReq.confirmation_id !== undefined
      ) {
        const reason =
          err.details?.reason === 'plan_stale'
            ? 'plan_stale'
            : err.details?.stale !== undefined
              ? 'revision_changed'
              : undefined;
        if (reason !== undefined) {
          const expired = this.confirmations.expire(applyReq.confirmation_id, reason);
          if (expired !== null) queueConfirmationEvent(this.audit, 'expired', expired, { reason });
        }
      }
      throw err;
    }
```

- [ ] **Step 6: Build + routes**

`build.ts`: import `ConfirmationStore`; after `const store = …` add `const confirmations = new ConfirmationStore({ db: state.db, now });`; pass `confirmations, audit: state.audit, clock: now, ...(opts.allowMcpApply !== undefined ? { allowMcpApply: opts.allowMcpApply } : {})` into `new TaskEngine({...})`; return `confirmations` in the bundle; add `allowMcpApply?: () => boolean` to `BuildTaskEnginesOptions`. `server.ts` passes `allowMcpApply: () => config.mcp?.allow_apply === true`.

Thread the id and the echoed revision: in `apply-helpers.ts` `applyMode` and the eight bespoke `taskEngine.apply({ applyReq: {...} })` literals in `arrays.ts`, `filesystems.ts`, `network.ts`, add

```ts
      expected_revision: expectedRevision, // the integer the route already validated from the body (R-3.1)
      ...(rc.mcp_confirmation_id !== undefined ? { confirmation_id: rc.mcp_confirmation_id } : {}),
```

(`applyMode` names it `expected`; when `requireExpectedRevision === false` — the `/reference` route — pass `typeof body.expected_revision === 'number' ? body.expected_revision : 0`.) Add to the engine tests: `mcpReq()` includes `expected_revision: 1` (matching the record's `expected_revision: 1`), and the 'expected_revision' row of the bindings table passes `{ expected_revision: 2 }` in `reqOver` and must be refused.

In `support.ts` add `confirmation_exempt: true,` to its `applyReq` with the comment `// ADR-0010 / S15 §3.1: support.bundle is a read-style diagnostic — exempt from MCP confirmation.`

- [ ] **Step 7: Run** — `npx vitest run src/__tests__/api/tasks/apply.test.ts src/__tests__/api/loopback-auth.test.ts` → PASS; then the full gate. `mcp-integration.test.ts`'s "apply passes the gate (and fails later in the handler)" still passes: the handler now fails with `NOT_FOUND` for `no-such-plan` before reaching the engine.

- [ ] **Step 8: Commit**

```bash
git add xiNAS-MCP/src/api/context.ts xiNAS-MCP/src/api/middleware/auth.ts xiNAS-MCP/src/api/tasks/engine.ts xiNAS-MCP/src/api/tasks/build.ts xiNAS-MCP/src/api/server.ts xiNAS-MCP/src/api/routes/apply-helpers.ts xiNAS-MCP/src/api/routes/arrays.ts xiNAS-MCP/src/api/routes/filesystems.ts xiNAS-MCP/src/api/routes/network.ts xiNAS-MCP/src/api/routes/support.ts xiNAS-MCP/src/__tests__/api/tasks/apply.test.ts xiNAS-MCP/src/__tests__/api/loopback-auth.test.ts
git commit -m "feat(tasks): verify and consume the MCP confirmation inside the apply transaction; loopback-only X-Xinas-Confirmation (S15 §8)" -m "An MCP-typed apply without trusted confirmation context is refused whichever dispatcher sent it; support.bundle stays exempt (ADR-0010)." -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Policy and message rendering (pure functions)

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/confirmation/policy.ts`
- Create: `xiNAS-MCP/src/api/mcp/confirmation/message.ts`
- Test: `xiNAS-MCP/src/__tests__/api/mcp/confirmation-policy.test.ts`, `xiNAS-MCP/src/__tests__/api/mcp/confirmation-message.test.ts` (new)

**Interfaces:**
- `policy.ts`: `ElicitationMode = 'form' | 'url'`; `confirmationModeFor(risk, rollback): ConfirmationMode`; `argumentsHash(name, args): string`; `elicitationModes(meta: unknown): Set<ElicitationMode>` (reads `meta['io.modelcontextprotocol/clientCapabilities'].elicitation`; `{}` ⇒ `form`); `isConfirmable(entry, args): boolean`; `parseMrtrParams(params: unknown): { inputResponses?: Record<string, ElicitResultLike>; requestState?: string }` (throws `McpProtocolError(-32602, 'invalid params: inputResponses' | 'invalid params: requestState')`); `ElicitResultLike = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }`.
- `message.ts`: `renderConfirmationMessage(input: { record, document, hostname, now }): string`; `renderSummary(input: { record, document }): { message: string; consequences: string; rollback_limitation: string }`; `summarizeDiff(diff, cap = 600): string`.

- [ ] **Step 1: Write the failing policy test**

```ts
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../../api/mcp/catalog.js';
import { McpProtocolError } from '../../../api/mcp/confirmation/errors.js';
import {
  argumentsHash,
  confirmationModeFor,
  elicitationModes,
  isConfirmable,
  parseMrtrParams,
} from '../../../api/mcp/confirmation/policy.js';

const entry = (name: string) => CATALOG.find((e) => e.name === name) as (typeof CATALOG)[number];

describe('confirmation policy (S15 §3, §14)', () => {
  it('maps risk × rollback to the confirmation mode', () => {
    expect(confirmationModeFor('non_disruptive', 'non_disruptive')).toBe('form');
    expect(confirmationModeFor('changing_access', 'changing_access')).toBe('form');
    expect(confirmationModeFor('destructive', 'destructive')).toBe('url');
    expect(confirmationModeFor('unsupported_rollback', 'destructive')).toBe('url');
    expect(confirmationModeFor('non_disruptive', 'unsupported')).toBe('url');
  });

  it('argumentsHash is stable under key order and sensitive to values', () => {
    const a = argumentsHash('shares.update', { id: 's', mode: 'apply', plan_id: 'p' });
    const b = argumentsHash('shares.update', { plan_id: 'p', mode: 'apply', id: 's' });
    expect(a).toBe(b);
    expect(argumentsHash('shares.update', { id: 's', mode: 'apply', plan_id: 'q' })).not.toBe(a);
    expect(argumentsHash('shares.delete', { id: 's', mode: 'apply', plan_id: 'p' })).not.toBe(a);
  });

  it('elicitationModes: absent → none; {} → form; explicit keys → those', () => {
    const key = 'io.modelcontextprotocol/clientCapabilities';
    expect([...elicitationModes(undefined)]).toEqual([]);
    expect([...elicitationModes({ [key]: {} })]).toEqual([]);
    expect([...elicitationModes({ [key]: { elicitation: {} } })]).toEqual(['form']);
    expect([...elicitationModes({ [key]: { elicitation: { url: {} } } })]).toEqual(['url']);
    expect([...elicitationModes({ [key]: { elicitation: { form: {}, url: {} } } })].sort()).toEqual(['form', 'url']);
  });

  it('isConfirmable: plan_apply+apply, direct+requires_mcp_apply, explicit opt-in; nothing else', () => {
    expect(isConfirmable(entry('shares.update'), { mode: 'apply' })).toBe(true);
    expect(isConfirmable(entry('shares.update'), { mode: 'plan' })).toBe(false);
    expect(isConfirmable(entry('arrays.list'), {})).toBe(false);
    expect(isConfirmable(entry('support.bundle'), {})).toBe(false);
    expect(isConfirmable(entry('tasks.cancel'), { id: 't' })).toBe(false);
    expect(isConfirmable({ ...entry('support.bundle'), requires_mcp_apply: true }, {})).toBe(true);
    expect(isConfirmable({ ...entry('arrays.list'), confirmation: 'required' }, {})).toBe(true);
  });

  it('parseMrtrParams accepts bare ElicitResults and rejects wrappers, bad actions and oversize state', () => {
    expect(parseMrtrParams({})).toEqual({});
    expect(
      parseMrtrParams({ inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } }, requestState: 'xc1.k.b.m' }),
    ).toEqual({ inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } }, requestState: 'xc1.k.b.m' });
    for (const bad of [
      { inputResponses: 'nope' },
      { inputResponses: { confirm_apply: { method: 'elicitation/create', result: { action: 'accept' } } } },
      { inputResponses: { confirm_apply: { action: 'yes' } } },
      { inputResponses: { confirm_apply: { action: 'accept', content: { nested: { a: 1 } } } } },
    ]) {
      expect(() => parseMrtrParams(bad)).toThrow(McpProtocolError);
      expect(() => parseMrtrParams(bad)).toThrow('invalid params: inputResponses');
    }
    expect(() => parseMrtrParams({ requestState: 42 })).toThrow('invalid params: requestState');
    expect(() => parseMrtrParams({ requestState: 'x'.repeat(4097) })).toThrow('invalid params: requestState');
  });
});
```

- [ ] **Step 2: Write the failing message test**

```ts
import { describe, expect, it } from 'vitest';
import { renderConfirmationMessage, renderSummary, summarizeDiff } from '../../../api/mcp/confirmation/message.js';
import type { ConfirmationRecord } from '../../../api/mcp/confirmation/types.js';
import type { PlanDocument } from '../../../api/plan/document.js';

const document: PlanDocument = {
  schema: 1, plan_id: '0d7f6c2e-1111-4222-8333-444455556666', operation_kind: 'share.update',
  resource_ref: { kind: 'Share', id: 'share-a' }, plan_hash: '9f3c1a2b7e4d'.padEnd(64, '0'),
  state_revision_expected: 42, observed_revision_expected: 17, observed_at: '2026-09-04T10:00:00.000Z',
  affected_resources: [{ kind: 'Share', id: 'share-a' }, { kind: 'ExportRule', id: 'share-a/10.0.0.0/24' }],
  risk_level: 'changing_access',
  client_impact: 'Clients of /srv/share-a from 10.0.0.0/24 lose write access; active sessions are not interrupted.',
  blockers: [], warnings: [{ code: 'NFS_SESSIONS_ACTIVE', message: '3 active sessions from 10.0.0.12, 10.0.0.15, 10.0.0.31' }],
  diff: { access_mode: { before: 'rw', after: 'ro' } }, rollback_model: 'changing_access',
  created_at: '2026-09-04T10:00:00.000Z', created_by: { principal: 'admin:demo', client_type: 'mcp' },
};

const record = {
  confirmation_id: 'c-1', status: 'pending', mode: 'form', principal: 'admin:demo', role: 'admin',
  tool_name: 'shares.update', operation_kind: 'share.update', arguments_hash: 'ah', plan_id: document.plan_id,
  plan_hash: document.plan_hash, plan_document_hash: 'dh', idempotency_key: 'ik', expected_revision: 42,
  risk_level: 'changing_access', rollback_model: 'changing_access', request_state_nonce_hash: 'nh', round: 1,
  created_at: Date.parse('2026-09-04T10:00:00Z'), expires_at: Date.parse('2026-09-04T10:05:00Z'),
  correlation_id: 'corr', request_id: 'req', node_id: '00000000-0000-0000-0000-000000000778',
} as ConfirmationRecord;

describe('confirmation message (S15 §10)', () => {
  it('contains every mandated line, built from the document only', () => {
    const msg = renderConfirmationMessage({ record, document, hostname: 'nas-01', now: Date.parse('2026-09-04T10:00:02Z') });
    for (const needle of [
      'xiNAS node nas-01', '000000000778', 'shares.update (share.update)', 'Share "share-a"',
      'Risk: changing_access', 'Rollback: changing_access', 'Client impact: Clients of /srv/share-a from 10.0.0.0/24',
      'ExportRule share-a/10.0.0.0/24', 'NFS_SESSIONS_ACTIVE', '10.0.0.12', 'access_mode', 'rw', 'ro',
      `Plan ${document.plan_id}`, 'hash 9f3c1a2b7e4d', 'expires 2026-09-04T10:05:00', 'in 4m58s', 'Choose APPLY',
    ]) {
      expect(msg, needle).toContain(needle);
    }
    expect(msg).not.toMatch(/https?:\/\//);
  });

  it('summarizeDiff caps at 600 chars with a tail note', () => {
    const big = { list: Array.from({ length: 200 }, (_, i) => `entry-${i}`) };
    const s = summarizeDiff(big);
    expect(s.length).toBeLessThanOrEqual(640);
    expect(s).toMatch(/… \(\d+ more characters; see the plan\)$/);
  });

  it('renderSummary spells out destructive consequences and rollback limitation', () => {
    const d = { ...document, risk_level: 'destructive', rollback_model: 'destructive' };
    const r = { ...record, risk_level: 'destructive', rollback_model: 'destructive' } as ConfirmationRecord;
    const s = renderSummary({ record: r, document: d });
    expect(s.consequences).toBe('This operation destroys data on Share share-a, ExportRule share-a/10.0.0.0/24. Data on them may be permanently lost.');
    expect(s.rollback_limitation).toContain('destructive');
    const u = renderSummary({ record: { ...r, rollback_model: 'unsupported' } as ConfirmationRecord, document: { ...d, rollback_model: 'unsupported' } });
    expect(u.rollback_limitation).toBe('xiNAS cannot roll this operation back automatically.');
  });
});
```

- [ ] **Step 3: Run both to verify they fail** — module not found.

- [ ] **Step 4: Create `policy.ts`**

```ts
import { createHash } from 'node:crypto';
import { canonicalize } from '../../../lib/canonical-json.js';
import type { CatalogEntry } from '../catalog.js';
import { INVALID_PARAMS, McpProtocolError } from './errors.js';
import { REQUEST_STATE_MAX_BYTES } from './state.js';
import type { ConfirmationMode } from './types.js';

export type ElicitationMode = 'form' | 'url';

const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

/** S15 §3.2 — decided from the persisted plan document only. */
export function confirmationModeFor(riskLevel: string, rollbackModel: string): ConfirmationMode {
  if (rollbackModel === 'unsupported') return 'url';
  return riskLevel === 'destructive' || riskLevel === 'unsupported_rollback' ? 'url' : 'form';
}

/** sha256 over canonical `{ name, arguments }` — key order irrelevant, any value change visible. */
export function argumentsHash(name: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize({ name, arguments: args }), 'utf8').digest('hex');
}

/**
 * Elicitation modes the CURRENT request declares (S15 §14.1). The vendor
 * rule: an empty `elicitation: {}` means form-only; absent means none.
 */
export function elicitationModes(meta: unknown): Set<ElicitationMode> {
  const out = new Set<ElicitationMode>();
  if (meta === null || typeof meta !== 'object') return out;
  const caps = (meta as Record<string, unknown>)[CLIENT_CAPABILITIES_META];
  if (caps === null || typeof caps !== 'object') return out;
  const elicitation = (caps as Record<string, unknown>).elicitation;
  if (elicitation === null || typeof elicitation !== 'object') return out;
  const e = elicitation as Record<string, unknown>;
  if (e.form !== undefined) out.add('form');
  if (e.url !== undefined) out.add('url');
  if (out.size === 0) out.add('form'); // backwards-compatibility rule
  return out;
}

/** S15 §3.1 — which calls the confirmation service must see. */
export function isConfirmable(entry: CatalogEntry, args: Record<string, unknown>): boolean {
  if (entry.confirmation === 'required') return true;
  if (entry.mutability === 'plan_apply') return args.mode === 'apply';
  if (entry.mutability === 'direct') return entry.requires_mcp_apply === true;
  return false;
}

export interface ElicitResultLike {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}

export interface MrtrParams {
  inputResponses?: Record<string, ElicitResultLike>;
  requestState?: string;
}

const isPrimitive = (v: unknown): boolean =>
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  (Array.isArray(v) && v.every((x) => typeof x === 'string'));

function isElicitResult(v: unknown): v is ElicitResultLike {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (r.action !== 'accept' && r.action !== 'decline' && r.action !== 'cancel') return false;
  if (r.content === undefined) return true;
  if (r.content === null || typeof r.content !== 'object' || Array.isArray(r.content)) return false;
  return Object.values(r.content as Record<string, unknown>).every(isPrimitive);
}

/** S14 §5.1 retry parsing: malformed → JSON-RPC -32602 (HTTP 200). */
export function parseMrtrParams(params: unknown): MrtrParams {
  const p = (params ?? {}) as Record<string, unknown>;
  const out: MrtrParams = {};
  if (p.inputResponses !== undefined) {
    const ir = p.inputResponses;
    if (ir === null || typeof ir !== 'object' || Array.isArray(ir) || !Object.values(ir as object).every(isElicitResult)) {
      throw new McpProtocolError(INVALID_PARAMS, 'invalid params: inputResponses');
    }
    out.inputResponses = ir as Record<string, ElicitResultLike>;
  }
  if (p.requestState !== undefined) {
    if (typeof p.requestState !== 'string' || Buffer.byteLength(p.requestState, 'utf8') > REQUEST_STATE_MAX_BYTES) {
      throw new McpProtocolError(INVALID_PARAMS, 'invalid params: requestState');
    }
    out.requestState = p.requestState;
  }
  return out;
}
```

- [ ] **Step 5: Create `message.ts`**

```ts
import { canonicalize } from '../../../lib/canonical-json.js';
import type { PlanDocument } from '../../plan/document.js';
import type { ConfirmationRecord } from './types.js';

const DIFF_CAP = 600;

/** Canonical JSON of the diff, capped (S15 §10.1). */
export function summarizeDiff(diff: unknown, cap = DIFF_CAP): string {
  const s = canonicalize(diff ?? null);
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}… (${s.length - cap} more characters; see the plan)`;
}

function resources(doc: PlanDocument): string {
  return doc.affected_resources.map((r) => `${r.kind} ${r.id}`).join('; ');
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export interface MessageInput {
  record: ConfirmationRecord;
  document: PlanDocument;
  hostname: string;
  now: number;
}

/**
 * The form-elicitation message (S15 §10.1). Built from the stored document
 * and the record only — never from anything the client sent. Plain text,
 * no URLs (form-mode fields must not carry clickable links).
 */
export function renderConfirmationMessage(input: MessageInput): string {
  const { record, document: doc } = input;
  const expiresIso = new Date(record.expires_at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const warnings =
    doc.warnings.length === 0
      ? 'Warnings: none'
      : `Warnings: ${doc.warnings.map((w, i) => `(${i + 1}) ${w.code} — ${w.message}`).join(' ')}`;
  const target = doc.resource_ref.id === null ? doc.resource_ref.kind : `${doc.resource_ref.kind} "${doc.resource_ref.id}"`;
  return [
    `xiNAS node ${input.hostname} (controller ${record.node_id})`,
    `Operation: ${record.tool_name} (${doc.operation_kind}) on ${target}`,
    `Risk: ${doc.risk_level} · Rollback: ${doc.rollback_model}`,
    `Client impact: ${doc.client_impact}`,
    `Affected: ${resources(doc)}`,
    warnings,
    `Diff (concise): ${summarizeDiff(doc.diff)}`,
    `Plan ${doc.plan_id} · hash ${doc.plan_hash.slice(0, 12)} · expires ${expiresIso} (in ${countdown(record.expires_at - input.now)})`,
    'Choose APPLY to confirm. Any other action leaves xiNAS unchanged.',
  ].join('\n');
}

export interface SummaryInput {
  record: ConfirmationRecord;
  document: PlanDocument;
}

/** The approval-page text (S15 §10.2). */
export function renderSummary(input: SummaryInput): {
  message: string;
  consequences: string;
  rollback_limitation: string;
} {
  const { record, document: doc } = input;
  const message = renderConfirmationMessage({ record, document: doc, hostname: record.node_id, now: record.created_at });
  let consequences = 'This operation changes the node configuration.';
  if (doc.risk_level === 'destructive') {
    consequences = `This operation destroys data on ${doc.affected_resources.map((r) => `${r.kind} ${r.id}`).join(', ')}. Data on them may be permanently lost.`;
  } else if (doc.risk_level === 'changing_access') {
    consequences = `This operation changes client access: ${doc.client_impact}`;
  }
  let rollback_limitation: string;
  switch (doc.rollback_model) {
    case 'unsupported':
      rollback_limitation = 'xiNAS cannot roll this operation back automatically.';
      break;
    case 'destructive':
      rollback_limitation = 'Rollback is itself destructive: undoing this operation cannot restore data.';
      break;
    case 'changing_access':
      rollback_limitation = 'Rollback restores the previous access rules; clients may see a brief interruption.';
      break;
    default:
      rollback_limitation = 'Rollback is non-disruptive.';
  }
  return { message, consequences, rollback_limitation };
}
```

- [ ] **Step 6: Run** — both suites PASS; `npm run typecheck && npm run lint && npm run format:check`.

- [ ] **Step 7: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/confirmation/policy.ts xiNAS-MCP/src/api/mcp/confirmation/message.ts xiNAS-MCP/src/__tests__/api/mcp/confirmation-policy.test.ts xiNAS-MCP/src/__tests__/api/mcp/confirmation-message.test.ts
git commit -m "feat(mcp): confirmation policy (mode mapping, capability parsing, MRTR param validation) and message rendering (S15 §3, §10, §14)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `ConfirmationService` and the MRTR path through `callTool` / `modern.ts` / `transport.ts`

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/confirmation/metrics.ts` (interface + `noopMetrics`; the registry-backed implementation is Task 13)
- Create: `xiNAS-MCP/src/api/mcp/confirmation/service.ts`
- Modify: `xiNAS-MCP/src/api/mcp/dispatch.ts` (`DispatcherOptions`, `callTool`, `buildMcpServer`)
- Modify: `xiNAS-MCP/src/api/mcp/modern.ts` (`tools/call` branch; `McpProtocolError` → error response with `httpStatus`)
- Modify: `xiNAS-MCP/src/api/mcp/transport.ts` (per-request `client`, status from the handler, `confirmations` from ctx)
- Modify: `xiNAS-MCP/src/api/context.ts` (`ApiContext.mcpConfirmations?: ConfirmationService`)
- Modify: `xiNAS-MCP/src/api/app.ts` (build the service when `ctx.tasks` exists)
- Modify: `xiNAS-MCP/src/__tests__/api/_helpers.ts` (extract `startMockAgentServer()`)
- Test: `xiNAS-MCP/src/__tests__/api/mcp/mcp-confirmation.test.ts` (new integration suite)

**Interfaces:**
- `metrics.ts`: `interface ConfirmationMetrics { requested(risk: string, mode: string): void; decided(outcome: 'approved' | 'declined' | 'cancelled' | 'expired' | 'consumed'): void; capabilityFailure(mode: string): void; stateValidationFailure(reason: string): void; replayRejected(): void; roundLimit(): void; confirmationToApply(seconds: number): void; approvedExpired(): void }`, `noopMetrics: ConfirmationMetrics`. (The pending gauge is not an event: Task 13 registers a scrape-time collector over `store.countPendingByMode()`.)
- `service.ts`: `McpClientInfo { era: 'legacy' | 'modern'; elicitation: Set<ElicitationMode> }`; `ConfirmationServiceDeps { store, tasks: TaskStore, keyRing, config: ResolvedConfirmationConfig, now, nodeId, hostname, audit?, metrics?, sleep? }`; `HandleInput { entry, args, identity, client, mrtr?: MrtrParams, correlationId }`; `HandleOutcome = { kind: 'proceed'; confirmation_id } | { kind: 'input_required'; result: InputRequiredToolResult } | { kind: 'error'; result: ToolResult }`; `class ConfirmationService { handle(input): Promise<HandleOutcome>; sweepExpired(reason): ConfirmationRecord[]; get store }`.
- `dispatch.ts`: `DispatcherOptions` gains `client: McpClientInfo; confirmations?: ConfirmationService`; `callTool(name, args, opts, mrtr?: MrtrParams & { correlationId?: string })` returns `Promise<ToolResult | InputRequiredToolResult>`; `buildMcpServer` narrows to `ToolResult` (throws if it ever sees `input_required` — unreachable, legacy is denied first).
- `modern.ts`: `handleModernRequest` returns `JsonRpcResponse & { httpStatus?: number }`; `transport.ts` strips `httpStatus` and uses it.
- `_helpers.ts`: `startMockAgentServer(socketPath): Promise<{ handle: MockAgentHandle-like; close(): Promise<void> }>` reused by `buildTestAppWithMockAgent` and by the new suite (which needs a real listener via `startServer`).

- [ ] **Step 1: Write the failing integration test**

Create `src/__tests__/api/mcp/mcp-confirmation.test.ts`. It boots a real api with `startServer` (loopback needed), a mock agent UDS (so applies dispatch), `mcp.allow_apply: true`, `approval_url_base: 'http://127.0.0.1:1'`, and drives the modern wire format with the hand-rolled `rpc()` from `mcp-discover.test.ts` (copy the function; add a `capabilities` parameter that becomes `_meta`). Helper shape:

```ts
const META = (elicitation?: Record<string, object>) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'conformance', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': elicitation === undefined ? {} : { elicitation },
});
const FORM = { form: {} };
const BOTH = { form: {}, url: {} };

async function call(port: number, token: string, id: string | number, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, caps: Record<string, object> | undefined = FORM) {
  return rpc(port, { jsonrpc: '2.0', id, method: 'tools/call', params: { _meta: META(caps), name, arguments: args, ...extra } }, { token });
}

async function planShareUpdate(port: number, token: string): Promise<{ plan_id: string; expected_revision: number }> {
  // seed: a Share must exist in desired state — create it through the same
  // MCP surface: shares.create plan → (form confirm) → apply is exercised
  // separately; here seed directly via handle.state.kv (seedShare from _helpers).
  ...
}
```

Seed a share with `seedShare(handle.state, 'share-a')` (exported from `_helpers.ts`) before planning `shares.update` with `{ id: 'share-a', mode: 'plan', spec: { clients: [{ pattern: '10.0.0.0/8', options: ['ro'] }] } }` → `changing_access` → form mode. For the destructive path use `shares.delete` (`share.delete` is destructive in the NFS provider; confirm by asserting the plan's `risk_level` and skip to `filesystems.delete` if it is not).

Cases (each an `it`; assert with `expect` on the JSON-RPC body):

1. **form happy path**: apply → `result.resultType === 'input_required'`, `inputRequests.confirm_apply.params.mode === 'form'`, `requestedSchema.properties.decision.enum` is `['APPLY']`, `requestState` starts with `xc1.`; message contains `share-a` and `changing_access`; **no task exists** (`GET /api/v1/tasks?state=queued` empty; `handle.state.db` `SELECT COUNT(*) FROM leases` is 0); record `pending` in `mcp_confirmations`. Retry with `inputResponses: { confirm_apply: { action: 'accept', content: { decision: 'APPLY' } } }` and the exact `requestState`, new id → `resultType: 'complete'`, `isError` falsy, payload has `result.task_id`; record `consumed` with that task id; one `http.PATCH./api/v1/shares/share-a` audit row plus `mcp.confirmation.requested/consumed/apply_task_created` rows (drain first).
2. **identical replay** after success → same `task_id`, no new task.
3. **decline / cancel** → `CONFIRMATION_DECLINED` / `CONFIRMATION_CANCELLED` tool errors, `task_created: false`, record terminal, no task.
4. **wrong decision** (`'yes'`) → treated as decline; **missing confirm_apply** → another `input_required` with `round` 2 (decode not needed: check the record's `round` in the DB), third → 3, fourth → `CONFIRMATION_ROUND_LIMIT` and record `expired` with `round_limit`.
5. **tampered state**: flip one character of `requestState` → JSON-RPC error `-32602`, message `invalid request state`, HTTP 200, no task; **cross-principal**: same state presented with `tok-admin2` (a second admin token in the config) → `-32602`, audit `mcp.confirmation.replay_rejected`.
6. **changed arguments / revision / key** on the retry → `-32602`.
6b. **plan ownership** (review P1): a plan created over REST with `tok-admin2` (`admin:two`) and applied over MCP by `tok-admin` → `PRECONDITION_FAILED plan_binding`, no record, and the error text does not name `admin:two`; the same plan applied over MCP by `tok-admin2` → `input_required` (same-principal cross-transport reuse works).
7. **capability**: destructive plan with `FORM` caps → HTTP **400**, `error.code === -32021`, `error.data.requiredCapabilities` equals `{ elicitation: { url: {} } }`, no record created; a modern client with **no** `elicitation` at all on a form plan → `-32021` with `{ elicitation: { form: {} } }`.
8. **URL mode**: destructive plan with `BOTH` caps → `input_required`, `mode: 'url'`, `url === 'http://127.0.0.1:1/mcp/approvals/<id>'` where `<id>` is the record id; retry with `{ action: 'accept' }` while pending → (with `url_wait_seconds: 1` in the config) another `input_required` after ~1 s; approve through the store directly (`handle`'s db: `UPDATE mcp_confirmations SET status='approved', approved_by='admin:other', approved_at=…`) then retry → task created **only when** `dangerous: true` was in the arguments; without `dangerous` → `PRECONDITION_FAILED dangerous_flag_required` and the record stays `approved`.
9. **legacy client** (`initialize` session, `mode: 'apply'`) → tool error `MCP_CONFIRMATION_UNSUPPORTED`; legacy `mode: 'plan'` and `arrays.list` unchanged.
10. **allow_apply false** (second server) → `MCP_APPLY_DISABLED` and **zero** rows in `mcp_confirmations`.
11. **hidden entries**: `tools/call` `mcp_confirmations.approve` → `NOT_FOUND`.
12. **blocked plan**: seed a plan_only row whose `plan_document.blockers` is non-empty (write it through `handle`'s TaskStore via `ctx`—the suite can import `buildTaskEngines`? No: use the db: `UPDATE tasks SET plan_document = json_set(plan_document, '$.blockers', json('[{"code":"X","message":"m"}]'))` and recompute nothing — the document hash check then fails first; so instead assert `plan_binding` → expect `PRECONDITION_FAILED` with reason `plan_binding` for a tampered document, and for the blocker case plan a `shares.delete` on a share with active sessions is not reproducible here — cover the blocker branch in the unit test of the service (below) with a hand-built document).

Add a small **unit** file `confirmation-service.test.ts` for branches hard to reach over the wire: blockers → `plan_blocked`; `plan_predates_confirmation` (null document); limits (`max_pending_per_principal: 1` → second distinct apply → `CONFIRMATION_LIMIT_EXCEEDED`); rate limit; `CONFIRMATION_URL_UNAVAILABLE` when `approval_url_base` is undefined; waiter cap. Build the service directly over an in-memory db with a `TaskStore` and a fake `sleep`.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/__tests__/api/mcp/mcp-confirmation.test.ts` → FAIL (`resultType` is `complete` with a `NOT_FOUND`/apply result instead of `input_required`).

- [ ] **Step 3: Create `metrics.ts`**

```ts
/** S15 §12.2 — the counters the confirmation service reports. Implemented over lib/metrics.ts in Task 13. */
export interface ConfirmationMetrics {
  requested(risk: string, mode: string): void;
  decided(outcome: 'approved' | 'declined' | 'cancelled' | 'expired' | 'consumed'): void;
  capabilityFailure(mode: string): void;
  stateValidationFailure(reason: string): void;
  replayRejected(): void;
  roundLimit(): void;
  confirmationToApply(seconds: number): void;
  approvedExpired(): void;
}

export const noopMetrics: ConfirmationMetrics = {
  requested() {}, decided() {}, capabilityFailure() {}, stateValidationFailure() {},
  replayRejected() {}, roundLimit() {}, confirmationToApply() {}, approvedExpired() {},
};
```

- [ ] **Step 4: Create `service.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { AuditAppender } from '../../../state/audit.js';
import type { ResolvedConfirmationConfig } from '../../config.js';
import { planDocumentHash } from '../../plan/document.js';
import type { PlanDocument } from '../../plan/document.js';
import type { TaskStore } from '../../tasks/store.js';
import { type CatalogEntry, ROLE_RANK } from '../catalog.js';
import type { McpIdentity } from '../dispatch.js';
import { type InputRequiredToolResult, type ToolResult, errorResult } from '../results.js';
import { queueConfirmationEvent } from './audit.js';
import { MISSING_REQUIRED_CLIENT_CAPABILITY, McpProtocolError, invalidRequestState } from './errors.js';
import { renderConfirmationMessage } from './message.js';
import { type ConfirmationMetrics, noopMetrics } from './metrics.js';
import { type ElicitationMode, type MrtrParams, argumentsHash, confirmationModeFor } from './policy.js';
import { type KeyRing, type RequestStatePayload, mintRequestState, newNonce, nonceHash, verifyRequestState } from './state.js';
import type { BindingKey, ConfirmationStore } from './store.js';
import { type ConfirmationMode, type ConfirmationRecord, MAX_ROUNDS, REQUEST_KEY } from './types.js';

export interface McpClientInfo {
  era: 'legacy' | 'modern';
  elicitation: Set<ElicitationMode>;
}

export interface ConfirmationServiceDeps {
  store: ConfirmationStore;
  tasks: TaskStore;
  keyRing: KeyRing;
  config: ResolvedConfirmationConfig;
  now: () => number;
  nodeId: string;
  hostname: string;
  audit?: AuditAppender;
  metrics?: ConfirmationMetrics;
  sleep?: (ms: number) => Promise<void>;
}

export interface HandleInput {
  entry: CatalogEntry;
  args: Record<string, unknown>;
  identity: McpIdentity;
  client: McpClientInfo;
  mrtr?: MrtrParams;
  correlationId: string;
}

export type HandleOutcome =
  | { kind: 'proceed'; confirmation_id: string }
  | { kind: 'input_required'; result: InputRequiredToolResult }
  | { kind: 'error'; result: ToolResult };

const MAX_WAITERS_PER_CONFIRMATION = 4;
const MAX_WAITERS_TOTAL = 32;
const WAIT_POLL_MS = 250;
const URL_MESSAGE =
  'This destructive xiNAS operation requires independent approval by a xiNAS operator. Open the approval page, review the plan, and approve or decline there.';

/**
 * The MRTR orchestration (S15 §3.3 gates 4–9, §4, §6.4, §7.3, §7.5). One
 * instance per api process; every method is safe to call concurrently
 * because all state lives in the store (SQLite) and the client-held
 * requestState.
 */
export class ConfirmationService {
  readonly store: ConfirmationStore;
  private readonly tasks: TaskStore;
  private readonly keyRing: KeyRing;
  private readonly config: ResolvedConfirmationConfig;
  private readonly now: () => number;
  private readonly nodeId: string;
  private readonly hostname: string;
  private readonly audit: AuditAppender | undefined;
  private readonly metrics: ConfirmationMetrics;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly waiters = new Map<string, number>();
  private totalWaiters = 0;

  constructor(deps: ConfirmationServiceDeps) {
    this.store = deps.store;
    this.tasks = deps.tasks;
    this.keyRing = deps.keyRing;
    this.config = deps.config;
    this.now = deps.now;
    this.nodeId = deps.nodeId;
    this.hostname = deps.hostname;
    this.audit = deps.audit;
    this.metrics = deps.metrics ?? noopMetrics;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async handle(input: HandleInput): Promise<HandleOutcome> {
    const { entry, args, identity, client } = input;

    // Gate 4 — apply request shape.
    const planId = args.plan_id;
    const expectedRevision = args.expected_revision;
    const idempotencyKey = args.idempotency_key;
    if (typeof planId !== 'string' || planId.length === 0) return err('INVALID_ARGUMENT', "'plan_id' is required");
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
      return err('INVALID_ARGUMENT', "'expected_revision' is required and must be an integer");
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return err('INVALID_ARGUMENT', "'idempotency_key' is required");
    if (args.dangerous !== undefined && typeof args.dangerous !== 'boolean') return err('INVALID_ARGUMENT', "'dangerous' must be a boolean");

    // Gate 5 — resolve the plan and its document.
    const planTask = this.tasks.get(planId);
    if (planTask === null || planTask.state !== 'plan_only') {
      return err('NOT_FOUND', `no plan_only task with plan_id ${planId}`, { remediation: 'Re-run mode=plan.' });
    }
    const doc = planTask.plan_document;
    if (doc === undefined || planTask.plan_document_hash === undefined) {
      return err('PRECONDITION_FAILED', 'this plan predates MCP confirmation support; re-plan', { reason: 'plan_predates_confirmation' });
    }

    // Gate 6 — integrity and binding (S15 §5.3).
    const pathParam = /\{([^}]+)\}/.exec(entry.path)?.[1];
    if (
      planDocumentHash(doc) !== planTask.plan_document_hash ||
      doc.plan_id !== planTask.task_id ||
      doc.plan_hash !== planTask.plan_hash ||
      !(entry.operation_kinds ?? []).includes(doc.operation_kind) ||
      doc.operation_kind !== planTask.kind ||
      (pathParam !== undefined && doc.resource_ref.id !== args[pathParam]) ||
      // S15 §5.3 item 7 (review P1): one principal never applies another's plan.
      doc.created_by.principal !== identity.principal ||
      ROLE_RANK[identity.role] < ROLE_RANK[entry.min_role]
    ) {
      return err('PRECONDITION_FAILED', 'the plan does not belong to this principal, tool and resource', { reason: 'plan_binding' });
    }
    // Ruling R-3.1: compare against what the plan RESPONSE said (the document),
    // never the row column — the route-computed kinds leave the row unpinned.
    if (doc.state_revision_expected !== expectedRevision) {
      return err('PRECONDITION_FAILED', `expected_revision ${expectedRevision} does not match the plan's ${doc.state_revision_expected}`, { expected_revision: expectedRevision, plan_revision: doc.state_revision_expected });
    }

    // Gate 7 — blockers.
    if (doc.blockers.length > 0) {
      return err('PRECONDITION_FAILED', 'the plan has unresolved blockers', { reason: 'plan_blocked', blockers: doc.blockers });
    }

    // Gate 8 — mode.
    const mode = confirmationModeFor(doc.risk_level, doc.rollback_model);
    const bindings: BindingKey = {
      principal: identity.principal,
      tool_name: entry.name,
      arguments_hash: argumentsHash(entry.name, args),
      plan_id: planId,
      idempotency_key: idempotencyKey,
      expected_revision: expectedRevision,
    };

    if (input.mrtr?.requestState !== undefined) {
      return this.retry(input, doc, planTask.plan_hash ?? '', mode, bindings);
    }
    return this.initial(input, doc, planTask.plan_hash ?? '', planTask.plan_document_hash, mode, bindings);
  }

  // ── initial call (S15 §4.2, §4.5, §6.4) ───────────────────────────────────

  private initial(
    input: HandleInput,
    doc: PlanDocument,
    planHash: string,
    docHash: string,
    mode: ConfirmationMode,
    bindings: BindingKey,
  ): HandleOutcome {
    const cap = this.requireCapability(input.client, mode, bindings);
    if (cap !== undefined) throw cap;

    const open = this.store.findOpenByBindings(bindings);
    if (open !== null) return this.reissue(open, doc);

    if (mode === 'url' && this.config.approval_url_base === undefined) {
      return err('CONFIRMATION_URL_UNAVAILABLE', 'destructive MCP applies need an approval page; mcp.confirmation.approval_url_base is not configured', { config_key: 'mcp.confirmation.approval_url_base' });
    }
    if (this.store.countOpen(bindings.principal) >= this.config.max_pending_per_principal) {
      return err('CONFIRMATION_LIMIT_EXCEEDED', 'too many open confirmations for this principal', { limit: this.config.max_pending_per_principal, config_key: 'mcp.confirmation.max_pending_per_principal' });
    }
    if (this.store.countOpen() >= this.config.max_pending_total) {
      return err('CONFIRMATION_LIMIT_EXCEEDED', 'too many open confirmations on this node', { limit: this.config.max_pending_total, config_key: 'mcp.confirmation.max_pending_total' });
    }
    if (!this.takeToken(bindings.principal)) {
      return err('CONFIRMATION_RATE_LIMITED', 'confirmation requests are rate limited', { limit_per_minute: this.config.create_rate_per_minute, config_key: 'mcp.confirmation.create_rate_per_minute' });
    }

    const nonce = newNonce();
    const record = this.store.create({
      mode,
      principal: bindings.principal,
      role: input.identity.role,
      tool_name: bindings.tool_name,
      operation_kind: doc.operation_kind,
      arguments_hash: bindings.arguments_hash,
      plan_id: bindings.plan_id,
      plan_hash: planHash,
      plan_document_hash: docHash,
      idempotency_key: bindings.idempotency_key,
      expected_revision: bindings.expected_revision,
      risk_level: doc.risk_level,
      rollback_model: doc.rollback_model,
      request_state_nonce_hash: nonceHash(nonce),
      ttl_ms: this.config.ttl_seconds * 1000,
      correlation_id: input.correlationId,
      request_id: randomUUID(),
      node_id: this.nodeId,
    });
    queueConfirmationEvent(this.audit, 'requested', record, { detail: { round: 1, expires_at: record.expires_at } });
    this.metrics.requested(record.risk_level, record.mode);
    return { kind: 'input_required', result: this.elicitation(record, doc, nonce) };
  }

  private reissue(record: ConfirmationRecord, doc: PlanDocument): HandleOutcome {
    if (record.round >= MAX_ROUNDS) {
      const expired = this.store.expire(record.confirmation_id, 'round_limit') ?? record;
      queueConfirmationEvent(this.audit, 'expired', expired, { reason: 'round_limit' });
      this.metrics.roundLimit();
      this.metrics.decided('expired');
      return err('CONFIRMATION_ROUND_LIMIT', 'too many confirmation rounds; start a fresh apply', { confirmation_id: record.confirmation_id, rounds: MAX_ROUNDS, task_created: false });
    }
    const nonce = newNonce();
    const bumped = this.store.reissue(record.confirmation_id, nonceHash(nonce));
    if (bumped === null) return this.terminalError(this.store.get(record.confirmation_id) ?? record);
    queueConfirmationEvent(this.audit, 'reissued', bumped, { detail: { round: bumped.round } });
    return { kind: 'input_required', result: this.elicitation(bumped, doc, nonce) };
  }

  // ── retry (S15 §4.3, §4.4, §7.3, §7.5) ────────────────────────────────────

  private async retry(
    input: HandleInput,
    doc: PlanDocument,
    planHash: string,
    mode: ConfirmationMode,
    bindings: BindingKey,
  ): Promise<HandleOutcome> {
    const cap = this.requireCapability(input.client, mode, bindings);
    if (cap !== undefined) throw cap;

    let payload: RequestStatePayload;
    try {
      payload = verifyRequestState(this.keyRing, input.mrtr?.requestState);
    } catch (e) {
      const reason = e instanceof McpProtocolError ? (e.reasonClass ?? 'unknown') : 'unknown';
      this.metrics.stateValidationFailure(reason);
      throw e;
    }
    const record = this.store.get(payload.cid);
    const mismatch =
      record === null ||
      payload.sub !== bindings.principal ||
      payload.role !== input.identity.role ||
      payload.tool !== bindings.tool_name ||
      payload.ah !== bindings.arguments_hash ||
      payload.pid !== bindings.plan_id ||
      payload.ph !== planHash ||
      payload.rev !== bindings.expected_revision ||
      payload.ik !== bindings.idempotency_key ||
      payload.risk !== doc.risk_level ||
      payload.mode !== mode ||
      record.principal !== bindings.principal ||
      record.arguments_hash !== bindings.arguments_hash ||
      record.plan_id !== bindings.plan_id ||
      record.idempotency_key !== bindings.idempotency_key ||
      record.expected_revision !== bindings.expected_revision ||
      record.tool_name !== bindings.tool_name ||
      nonceHash(payload.nonce) !== record.request_state_nonce_hash ||
      payload.round !== record.round ||
      payload.exp !== record.expires_at;
    if (mismatch) {
      if (record !== null) {
        queueConfirmationEvent(this.audit, 'replay_rejected', record, {
          detail: { presented_by: bindings.principal, presented_round: payload.round },
        });
      }
      this.metrics.replayRejected();
      throw invalidRequestState('binding');
    }

    if (record.status === 'pending' || record.status === 'approved') {
      if (record.expires_at <= this.now()) {
        const expired = this.store.expire(record.confirmation_id, 'ttl') ?? record;
        queueConfirmationEvent(this.audit, 'expired', expired, { reason: 'ttl' });
        this.metrics.decided('expired');
        if (record.status === 'approved') this.metrics.approvedExpired();
        return this.terminalError(expired);
      }
      const response = input.mrtr?.inputResponses?.[REQUEST_KEY];
      if (response === undefined) return this.reissue(record, doc); // missing → re-issue (V-16)
      if (response.action === 'decline') return this.declineByClient(record, 'declined');
      if (response.action === 'cancel') return this.declineByClient(record, 'cancelled');
      if (mode === 'form') {
        if (response.content?.decision !== 'APPLY') return this.declineByClient(record, 'declined');
        return { kind: 'proceed', confirmation_id: record.confirmation_id };
      }
      // url: accept means "the browser flow happened"; the record decides.
      const settled = await this.awaitOperator(record);
      if (settled.status === 'approved') return { kind: 'proceed', confirmation_id: settled.confirmation_id };
      if (settled.status === 'pending') return this.reissue(settled, doc);
      return this.terminalError(settled);
    }
    if (record.status === 'consumed') {
      // The engine decides whether this is the identical idempotent replay (§8.5).
      return { kind: 'proceed', confirmation_id: record.confirmation_id };
    }
    return this.terminalError(record);
  }

  private async awaitOperator(record: ConfirmationRecord): Promise<ConfirmationRecord> {
    const id = record.confirmation_id;
    const mine = this.waiters.get(id) ?? 0;
    if (mine >= MAX_WAITERS_PER_CONFIRMATION || this.totalWaiters >= MAX_WAITERS_TOTAL) {
      return this.store.get(id) ?? record;
    }
    this.waiters.set(id, mine + 1);
    this.totalWaiters += 1;
    try {
      const deadline = this.now() + this.config.url_wait_seconds * 1000;
      let current = this.store.get(id) ?? record;
      while (current.status === 'pending' && this.now() < deadline) {
        await this.sleep(WAIT_POLL_MS);
        current = this.store.get(id) ?? current;
      }
      return current;
    } finally {
      this.waiters.set(id, (this.waiters.get(id) ?? 1) - 1);
      this.totalWaiters -= 1;
    }
  }

  private declineByClient(record: ConfirmationRecord, outcome: 'declined' | 'cancelled'): HandleOutcome {
    const moved =
      outcome === 'declined'
        ? this.store.decline(record.confirmation_id, record.principal, 'mcp_form')
        : this.store.cancel(record.confirmation_id, record.principal);
    const final = moved ?? this.store.get(record.confirmation_id) ?? record;
    queueConfirmationEvent(this.audit, outcome, final);
    this.metrics.decided(outcome);
    return this.terminalError(final);
  }

  /** Map a terminal record to the tool error the client sees (S15 §11). */
  private terminalError(record: ConfirmationRecord): HandleOutcome {
    const details = { confirmation_id: record.confirmation_id, task_created: false };
    switch (record.status) {
      case 'declined':
        return err('CONFIRMATION_DECLINED', 'the confirmation was declined; no apply task was created', details);
      case 'cancelled':
        return err('CONFIRMATION_CANCELLED', 'the confirmation was cancelled; no apply task was created', details);
      case 'expired':
        return err('CONFIRMATION_EXPIRED', 'the confirmation expired; start a fresh apply', { ...details, expired_reason: record.expired_reason });
      case 'consumed':
        return err('CONFIRMATION_ALREADY_CONSUMED', 'the confirmation was already used for another request', details);
      default:
        return err('CONFIRMATION_DECLINED', 'the confirmation is not approved; no apply task was created', details);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private requireCapability(client: McpClientInfo, mode: ConfirmationMode, bindings: BindingKey): McpProtocolError | undefined {
    if (client.elicitation.has(mode)) return undefined;
    this.metrics.capabilityFailure(mode);
    // No record exists yet on the initial call; on a retry the record is
    // untouched. Audit without a record: use the bindings.
    if (this.audit !== undefined) {
      this.audit.queue({
        kind: 'mcp.confirmation.capability_missing',
        principal: bindings.principal,
        client_type: 'mcp',
        request_id: randomUUID(),
        parameters_hash: `sha256:${bindings.arguments_hash}`,
        result_hash: 'sha256:',
        payload: { tool_name: bindings.tool_name, plan_id: bindings.plan_id, required_mode: mode },
      });
    }
    return new McpProtocolError(
      MISSING_REQUIRED_CLIENT_CAPABILITY,
      'Server requires the elicitation capability for this request',
      { httpStatus: 400, data: { requiredCapabilities: { elicitation: { [mode]: {} } } } },
    );
  }

  private elicitation(record: ConfirmationRecord, doc: PlanDocument, nonce: string): InputRequiredToolResult {
    const payload: RequestStatePayload = {
      v: 1, cid: record.confirmation_id, sub: record.principal, role: record.role, tool: record.tool_name,
      ah: record.arguments_hash, pid: record.plan_id, ph: record.plan_hash, rev: record.expected_revision,
      ik: record.idempotency_key, risk: record.risk_level, mode: record.mode, iat: this.now(),
      exp: record.expires_at, nonce, round: record.round,
    };
    const requestState = mintRequestState(this.keyRing, payload);
    if (record.mode === 'url') {
      return {
        resultType: 'input_required',
        inputRequests: {
          [REQUEST_KEY]: {
            method: 'elicitation/create',
            params: { mode: 'url', message: URL_MESSAGE, url: `${this.config.approval_url_base}/mcp/approvals/${record.confirmation_id}` },
          },
        },
        requestState,
      };
    }
    return {
      resultType: 'input_required',
      inputRequests: {
        [REQUEST_KEY]: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: renderConfirmationMessage({ record, document: doc, hostname: this.hostname, now: this.now() }),
            requestedSchema: {
              type: 'object',
              properties: { decision: { type: 'string', enum: ['APPLY'], title: 'Confirm operation' } },
              required: ['decision'],
            },
          },
        },
      },
      requestState,
    };
  }

  private takeToken(principal: string): boolean {
    const rate = this.config.create_rate_per_minute;
    const now = this.now();
    const b = this.buckets.get(principal) ?? { tokens: rate, updated: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.updated) / 60_000) * rate);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(principal, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(principal, b);
    return true;
  }

  /** Expire open records past their TTL (startup + timer, S15 §6.3). */
  sweepExpired(reason: 'ttl' | 'restart_sweep'): ConfirmationRecord[] {
    const swept = this.store.sweepExpired(this.now(), reason);
    for (const r of swept) {
      queueConfirmationEvent(this.audit, 'expired', r, { reason });
      this.metrics.decided('expired');
      if (r.approved_at !== undefined) this.metrics.approvedExpired();
    }
    return swept; // the pending gauge is computed from the store at scrape time (Task 13)
  }
}

function err(code: string, message: string, details?: unknown): HandleOutcome {
  return { kind: 'error', result: errorResult(code, message, details) };
}
```

- [ ] **Step 5: Wire the dispatcher**

`dispatch.ts`:

- `DispatcherOptions` gains `client: McpClientInfo; confirmations?: ConfirmationService;` (import both as `type` from `./confirmation/service.js`); import `isConfirmable` and `type MrtrParams` from `./confirmation/policy.js`, `type InputRequiredToolResult` from `./results.js`.
- `callTool` signature: `(name, args, opts, mrtr: MrtrParams & { correlationId?: string } = {}): Promise<ToolResult | InputRequiredToolResult>`.
- After the `gateVerdict` block and before `buildRequest`:

```ts
  // S15 §3.1/§3.3 — confirmable calls go through the confirmation service.
  let confirmationId: string | undefined;
  if (isConfirmable(entry, args)) {
    if (opts.client.era !== 'modern') {
      return errorResult(
        'MCP_CONFIRMATION_UNSUPPORTED',
        'mode=apply over MCP requires MCP 2026-07-28 with elicitation support; apply via REST, xinasctl or the TUI instead',
        { required: 'MCP 2026-07-28 with elicitation', alternatives: ['REST', 'xinasctl', 'TUI'] },
      );
    }
    if (opts.confirmations === undefined) {
      return errorResult('INTERNAL', 'confirmation service unavailable (api not fully started)');
    }
    const identity = opts.identity();
    const outcome = await opts.confirmations.handle({
      entry,
      args,
      identity,
      client: opts.client,
      ...(mrtr.inputResponses !== undefined || mrtr.requestState !== undefined
        ? { mrtr: { ...(mrtr.inputResponses !== undefined ? { inputResponses: mrtr.inputResponses } : {}), ...(mrtr.requestState !== undefined ? { requestState: mrtr.requestState } : {}) } }
        : {}),
      correlationId: mrtr.correlationId ?? 'mcp',
    });
    if (outcome.kind !== 'proceed') return outcome.result;
    confirmationId = outcome.confirmation_id;
  }
```

- Add `...(confirmationId !== undefined ? { 'x-xinas-confirmation': confirmationId } : {})` to the loopback headers.
- `buildMcpServer`: wrap the handler result: `const r = await callTool(...); if ('resultType' in r && r.resultType === 'input_required') throw new Error('unreachable: legacy path received input_required'); return r;`.

`modern.ts`:

- `JsonRpcResponse` gains `httpStatus?: number;` and `error.data?: Record<string, unknown>`.
- In `tools/call`: `const mrtr = parseMrtrParams(msg.params);` (throws `McpProtocolError`), `const result = await callTool(params.name, params.arguments ?? {}, opts, { ...mrtr, correlationId: String(rpcId) });` then `if (isInputRequired(result)) return { jsonrpc: '2.0', id: rpcId, result }; return { jsonrpc: '2.0', id: rpcId, result: { ...result, resultType: 'complete' } };`.
- Add a `catch (err)` branch before the generic one: `if (err instanceof McpProtocolError) return { jsonrpc: '2.0', id: rpcId, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }, httpStatus: err.httpStatus };`.

`transport.ts`:

- Modern branch: `const { httpStatus, ...body } = await handleModernRequest(req.body, { ..., client: { era: 'modern', elicitation: elicitationModes((req.body as { params?: { _meta?: unknown } })?.params?._meta) }, ...(ctx.mcpConfirmations !== undefined ? { confirmations: ctx.mcpConfirmations } : {}) }); res.status(httpStatus ?? 200).json(body);`
- Legacy branch: `buildMcpServer({ ..., client: { era: 'legacy', elicitation: new Set() } })` (no `confirmations`).

`context.ts`: `mcpConfirmations?: import('./mcp/confirmation/service.js').ConfirmationService;`.

`app.ts` after `ctx.loopback_token ??= …`:

```ts
  // S15: the MRTR confirmation service, built over the same store the task
  // engine consumes from. Absent in read-only contexts (no ctx.tasks), where
  // /mcp cannot apply anyway.
  if (ctx.tasks !== undefined) {
    ctx.mcpConfirmations ??= new ConfirmationService({
      store: ctx.tasks.confirmations,
      tasks: ctx.tasks.store,
      keyRing: loadOrCreateKeyRing(confirmationKeyPathFor(ctx.config)),
      config: resolveConfirmationConfig(ctx.config),
      now: () => Date.now(),
      nodeId: ctx.config.controller_id,
      hostname: hostname(),
      audit: ctx.state.audit,
    });
  }
```

(imports: `hostname` from `node:os`, `ConfirmationService`, `loadOrCreateKeyRing`, `confirmationKeyPathFor`, `resolveConfirmationConfig`.)

`_helpers.ts`: lift the `createServer((conn) => {...})` mock-agent block out of `buildTestAppWithMockAgent` into an exported `startMockAgentServer(socketPath)` returning `{ respondToHealth, respondToTaskBegin, taskBeginCallCount, lastTaskBeginParams, close }`; `buildTestAppWithMockAgent` calls it (behavior unchanged — run the whole suite to prove it). The new integration suite calls it too and passes `agent: { socket }` to `startServer`.

- [ ] **Step 6: Run** — `npx vitest run src/__tests__/api/mcp/` → PASS; then `npm test` and the gate. Existing suites that construct `DispatcherOptions` (`mcp-dispatch.test.ts` does not; `transport`/`integration` go through HTTP) need no change beyond the `client` field wherever `buildMcpServer`/`handleModernRequest` are invoked directly (grep `handleModernRequest(` and `buildMcpServer(` under `src/__tests__` and add `client`).

- [ ] **Step 7: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/confirmation/metrics.ts xiNAS-MCP/src/api/mcp/confirmation/service.ts xiNAS-MCP/src/api/mcp/dispatch.ts xiNAS-MCP/src/api/mcp/modern.ts xiNAS-MCP/src/api/mcp/transport.ts xiNAS-MCP/src/api/context.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/_helpers.ts xiNAS-MCP/src/__tests__/api/mcp/mcp-confirmation.test.ts xiNAS-MCP/src/__tests__/api/mcp/confirmation-service.test.ts
git commit -m "feat(mcp): MRTR confirmation service — form and URL flows, retry binding checks, rounds, limits, legacy denial (S15 §4, §6.4, §7, §14)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Phase A exit:** with `mcp.allow_apply: true`, a modern client can plan → confirm (form) → apply → task; a destructive plan returns a URL elicitation that cannot yet be approved from a browser (Phase B) but can be approved by a direct store write in tests; a legacy client cannot apply; nothing mutates before acceptance.

---

## Phase B — out-of-band approval, observability, recovery, interoperability, docs

### Task 11: Operator approval over REST (and therefore `xinasctl`)

**Files:**
- Create: `xiNAS-MCP/src/api/routes/mcp-confirmations.ts`
- Modify: `xiNAS-MCP/src/api/mcp/confirmation/service.ts` (add `operatorDecide()` and `view()`)
- Modify: `xiNAS-MCP/src/api/app.ts` (mount the router on `v1`)
- Test: `xiNAS-MCP/src/__tests__/api/routes-mcp-confirmations.test.ts` (new), extend `mcp-confirmation.test.ts` with the URL happy path via REST

**Interfaces:**
- `ConfirmationService.view(id, viewer: { principal; client_type }): { record; plan: PublicPlan; summary } | null` — emits `viewed`.
- `ConfirmationService.operatorDecide(input: { id; decision: 'approve' | 'decline'; approver: { principal; role }; channel: 'bearer' | 'uds_break_glass'; interface?: 'web' | 'rest'; acknowledge?: string; reason?: string }): ConfirmationRecord` — `channel` is derived by the route from the auth verdict (`local:uds` → `uds_break_glass`, else `bearer`), never from a header; `interface` is the untrusted label. Throws `ApiException` (`NOT_FOUND`; `CONFLICT` `not_pending` / `form_mode` / `approver_policy`; `INVALID_ARGUMENT` for a wrong phrase). A `uds_break_glass` decision requires `allow_uds_approval: true` and emits `break_glass_used`.
- `renderConfirmation(record): McpConfirmationView` — ISO timestamps, no `request_state_nonce_hash`.
- Router `mcpConfirmationsRouter(ctx)` mounted at `/api/v1` (paths `/mcp/confirmations…`).

- [ ] **Step 1: Write the failing route tests**

`routes-mcp-confirmations.test.ts` uses `buildTestAppWithMockAgent()` (it has `tasks`, hence `ctx.mcpConfirmations`). Seed records directly through `setup.tasks.confirmations.create({...})` (a `url` record for `admin:test`, plan/doc fields may be dummies except where `view` needs the plan: create a real plan first with `POST /api/v1/shares { mode: 'plan' }` and use its `plan_id`, `plan_hash`, `plan_document_hash` from `setup.tasks.store.get(plan_id)`).

Cases:

```ts
  it('viewer/operator tokens are refused (admin only)', ...)         // 401 PERMISSION_DENIED via rbac
  it('GET list filters and renders ISO timestamps without the nonce hash', ...)
  it('GET one returns the record + plan (deep-equal publicPlan(stored)) + summary, and audits viewed', ...)
  it('approve: distinct_principal refuses the requester (CONFLICT approver_policy), accepts another admin', ...)
     // requester admin:test → use 'tok-admin2' → principal 'admin:two' added to the helper config
  it('approve: destructive needs the exact phrase; wrong phrase is INVALID_ARGUMENT and no transition', ...)
  it('approve on a form record is CONFLICT form_mode; approve on a terminal record is CONFLICT not_pending', ...)
  it('decline works from pending and approved; declined twice is CONFLICT not_pending', ...)
  it('UDS peer trust (local:uds) is REFUSED by default (CONFLICT approver_policy) and accepted only with allow_uds_approval:true, which also audits break_glass_used', ...)
     // supertest cannot do UDS: call service.operatorDecide directly with { principal: 'local:uds', role: 'admin' }, channel 'uds_break_glass', against the default service and against a second service built with allow_uds_approval:true; drain and assert the mcp.confirmation.break_glass_used row
  it('approval_channel is bearer for a token request regardless of X-Xinas-Approval-Interface; the header lands in approval_interface only, and a web-labelled request with a mismatching Origin is refused', ...)
```

For the config with `'tok-admin2'`, extend `buildTestAppWithMockAgent` tokens with `'tok-admin2': { principal: 'admin:two', role: 'admin' }` and export `ADMIN2_TOKEN = 'Bearer tok-admin2'`.

In `mcp-confirmation.test.ts` add: **URL happy path** — destructive plan (`BOTH` caps) → `input_required` url → `POST /api/v1/mcp/confirmations/<id>/approve` with `Bearer tok-admin2` and `{ acknowledge: 'DATA MAY BE PERMANENTLY LOST' }` → 200 `status: 'approved'` → MCP retry `{ action: 'accept' }` with `dangerous: true` → task; record `consumed` with `approved_by: 'admin:two'`, `approval_channel: 'bearer'`, `approval_interface: 'rest'`. And: the requester's own token on approve → 409 `approver_policy`.

- [ ] **Step 2: Run to verify they fail** — 404 `no such API route`.

- [ ] **Step 3: Service additions**

```ts
  view(id: string, viewer: { principal: string; client_type: 'rest' | 'mcp' }):
    { record: ConfirmationRecord; plan: PublicPlan; summary: ReturnType<typeof renderSummary> } | null {
    const record = this.store.get(id);
    if (record === null) return null;
    const planTask = this.tasks.get(record.plan_id);
    const doc = planTask?.plan_document;
    if (doc === undefined) return null; // the plan row was GC'd: treat as gone
    queueConfirmationEvent(this.audit, 'viewed', record, { actor: viewer.principal, actor_client_type: viewer.client_type });
    return { record, plan: publicPlan(doc), summary: renderSummary({ record, document: doc }) };
  }

  operatorDecide(input: {
    id: string;
    decision: 'approve' | 'decline';
    approver: { principal: string; role: string };
    channel: 'bearer' | 'uds_break_glass';
    interface?: 'web' | 'rest';
    acknowledge?: string;
    reason?: string;
  }): ConfirmationRecord {
    const record = this.store.get(input.id);
    if (record === null) throw new ApiException('NOT_FOUND', `no confirmation ${input.id}`);
    // S15 §9.2 — approver policy. `channel` is the route's derivation from
    // the auth verdict; `interface` is a label and is never consulted here.
    const isUds = input.channel === 'uds_break_glass';
    if (isUds && !this.config.allow_uds_approval) {
      throw new ApiException(
        'CONFLICT',
        'UDS peer-trust decisions are break-glass and disabled (mcp.confirmation.allow_uds_approval: false)',
        { reason: 'approver_policy', config_key: 'mcp.confirmation.allow_uds_approval' },
        'Decide from the HTTPS approval page or REST with a different admin credential. Enabling the key lets anyone with root or xinas-admin on this node approve (S15 §3.5).',
      );
    }
    if (input.approver.role !== 'admin') {
      throw new ApiException('CONFLICT', 'only an admin may decide a confirmation', { reason: 'approver_policy' });
    }
    if (this.config.approver_policy === 'distinct_principal' && !isUds && input.approver.principal === record.principal) {
      throw new ApiException('CONFLICT', 'the requesting principal may not approve its own request', { reason: 'approver_policy' }, 'Approve with a different admin credential, or xinasctl on the node.');
    }
    if (input.decision === 'approve') {
      if (record.mode === 'form') throw new ApiException('CONFLICT', 'form-mode confirmations are accepted by the MCP client, not here', { reason: 'form_mode' });
      const needed = record.rollback_model === 'unsupported' || record.risk_level === 'unsupported_rollback'
        ? ACK_NO_ROLLBACK
        : record.risk_level === 'destructive' ? ACK_DATA_LOSS : undefined;
      if (needed !== undefined && input.acknowledge !== needed) {
        throw new ApiException('INVALID_ARGUMENT', `approval requires acknowledge: "${needed}"`, { required_acknowledge: needed });
      }
      const moved = this.store.approve(record.confirmation_id, input.approver.principal, input.channel, input.interface, input.reason);
      if (moved === null) throw new ApiException('CONFLICT', `confirmation is ${record.status}, not pending`, { reason: 'not_pending', status: record.status });
      const detail = { channel: input.channel, interface: input.interface ?? null };
      queueConfirmationEvent(this.audit, 'approved', moved, { actor: input.approver.principal, actor_client_type: 'rest', detail, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
      if (isUds) queueConfirmationEvent(this.audit, 'break_glass_used', moved, { actor: input.approver.principal, actor_client_type: 'rest', detail: { decision: 'approve' } });
      this.metrics.decided('approved');
      return moved;
    }
    const moved = this.store.decline(record.confirmation_id, input.approver.principal, input.channel, input.interface, input.reason);
    if (moved === null) throw new ApiException('CONFLICT', `confirmation is ${record.status}, not pending or approved`, { reason: 'not_pending', status: record.status });
    const detail = { channel: input.channel, interface: input.interface ?? null };
    queueConfirmationEvent(this.audit, 'declined', moved, { actor: input.approver.principal, actor_client_type: 'rest', detail, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
    if (isUds) queueConfirmationEvent(this.audit, 'break_glass_used', moved, { actor: input.approver.principal, actor_client_type: 'rest', detail: { decision: 'decline' } });
    this.metrics.decided('declined');
    return moved;
  }
```

(imports: `ApiException`, `publicPlan`, `PublicPlan`, `renderSummary`, `ACK_DATA_LOSS`, `ACK_NO_ROLLBACK`.)

- [ ] **Step 4: Router**

```ts
import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';
import type { ConfirmationService } from '../mcp/confirmation/service.js';
import type { ConfirmationRecord, ConfirmationStatus } from '../mcp/confirmation/types.js';

const STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'declined', 'cancelled', 'expired', 'consumed']);

function requireConfirmations(ctx: ApiContext): ConfirmationService {
  if (ctx.mcpConfirmations === undefined) {
    throw new ApiException('INTERNAL', 'confirmation service is not available in this build', { code: 'EXECUTOR_UNAVAILABLE' });
  }
  return ctx.mcpConfirmations;
}

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

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

/** The VERIFIED channel — from the auth verdict (S15 §9.2), never from a header. */
function channelOf(principal: string): 'bearer' | 'uds_break_glass' {
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
      throw new ApiException('INVALID_ARGUMENT', "query param 'status' is not a confirmation status");
    }
    const principal = typeof req.query.principal === 'string' ? req.query.principal : undefined;
    const limitRaw = req.query.limit;
    const limit = limitRaw === undefined ? 100 : Number.parseInt(String(limitRaw), 10);
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
    sendOk(req, res, { ...renderConfirmation(view.record), plan: view.plan, summary: view.summary });
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
      const origin = req.header('origin');
      const base = ctx.config.mcp?.confirmation?.approval_url_base;
      if (iface === 'web' && origin !== undefined && base !== undefined && !base.startsWith(origin.replace(/\/+$/, ''))) {
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
```

Mount in `app.ts` on `v1` next to `tasksRouter`: `v1.use(mcpConfirmationsRouter(ctx));`. RBAC comes from the Task 7 catalog entries (admin).

- [ ] **Step 5: Run** — both suites PASS; gate green.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/api/routes/mcp-confirmations.ts xiNAS-MCP/src/api/mcp/confirmation/service.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/_helpers.ts xiNAS-MCP/src/__tests__/api/routes-mcp-confirmations.test.ts xiNAS-MCP/src/__tests__/api/mcp/mcp-confirmation.test.ts
git commit -m "feat(api): operator approval routes for MCP confirmations with approver policy and acknowledgement phrases (S15 §9.1–9.2)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The approval page

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/confirmation/approval-page.ts`
- Modify: `xiNAS-MCP/src/api/app.ts` (`mountApprovalPage(app)` right after `mountMcpTransport`)
- Test: `xiNAS-MCP/src/__tests__/api/mcp/approval-page.test.ts` (new)

**Interfaces:** `mountApprovalPage(app: Express): void` serving `GET /mcp/approvals/:id` (HTML shell), `GET /mcp/approvals/assets/app.js`, `GET /mcp/approvals/assets/app.css`. Exports `APPROVAL_PAGE_HEADERS` for the test.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, buildTestApp } from '../_helpers.js';

describe('approval page (S15 §9.3)', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { setup = await buildTestApp(); });
  afterEach(async () => { await setup.cleanup(); });

  it('serves an identical, unauthenticated shell for any id with the security headers', async () => {
    const a = await request(setup.app).get('/mcp/approvals/abc');
    const b = await request(setup.app).get('/mcp/approvals/does-not-exist');
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toMatch(/text\/html/);
    expect(a.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(a.headers['x-frame-options']).toBe('DENY');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.headers['referrer-policy']).toBe('no-referrer');
    expect(a.headers['x-content-type-options']).toBe('nosniff');
    // same document modulo the id (it appears more than once) → no existence leak
    expect(a.text.replaceAll('abc', 'X')).toBe(b.text.replaceAll('does-not-exist', 'X'));
    expect(a.text).not.toMatch(/<script[^>]*src="https?:/);
    expect(a.text).toContain('Do not paste the token your MCP client uses');
  });

  it('serves the script and stylesheet with no-store and nosniff', async () => {
    const js = await request(setup.app).get('/mcp/approvals/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe('no-store');
    expect(js.text).toContain('/api/v1/mcp/confirmations/');
    expect(js.text).toContain('X-Xinas-Approval-Interface');
    expect(js.text).toContain('DATA MAY BE PERMANENTLY LOST');
    const css = await request(setup.app).get('/mcp/approvals/assets/app.css');
    expect(css.status).toBe(200);
  });

  it('is not audited (the /mcp prefix skip) and neutralizes a non-id path segment', async () => {
    const res = await request(setup.app).get('/mcp/approvals/..%2Fetc');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-confirmation-id="invalid"');
    expect(res.text).not.toContain('etc');
    await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    await setup.state.drainer.drainNow();
    const rows = readFileSync(join(setup.dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind?: string });
    expect(rows.some((r) => r.kind?.startsWith('http.GET./mcp/'))).toBe(false);
    expect(rows.some((r) => r.kind === 'http.GET./api/v1/system')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — 404.

- [ ] **Step 3: Create `approval-page.ts`**

```ts
import type { Express, Request, Response } from 'express';

/** S15 §9.3 — headers on every page response. */
export const APPROVAL_PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const CSS = `
:root { color-scheme: light dark; font: 15px/1.45 system-ui, sans-serif; }
body { margin: 0; padding: 24px; max-width: 880px; }
h1 { font-size: 1.3rem; }
.warn { padding: 12px; border: 2px solid #b00; border-radius: 6px; background: rgba(187,0,0,.08); }
.muted { opacity: .75; }
dl { display: grid; grid-template-columns: 12rem 1fr; gap: 4px 12px; }
dt { font-weight: 600; }
pre { white-space: pre-wrap; word-break: break-all; border: 1px solid #8884; padding: 8px; border-radius: 4px; }
button { font: inherit; padding: 8px 14px; margin-right: 8px; }
button.danger { background: #b00; color: #fff; border: 0; }
input[type=text], input[type=password] { font: inherit; width: 100%; padding: 6px; }
label { display: block; margin: 8px 0; }
#status { margin-top: 12px; font-weight: 600; }
`;

const JS = String.raw`
'use strict';
(function () {
  var ACK_DATA_LOSS = 'DATA MAY BE PERMANENTLY LOST';
  var ACK_NO_ROLLBACK = 'ROLLBACK IS NOT SUPPORTED';
  var id = document.body.getAttribute('data-confirmation-id');
  var token = '';
  var record = null;
  var $ = function (s) { return document.querySelector(s); };
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
  function setStatus(t) { $('#status').textContent = t; }
  function api(method, path, body) {
    var headers = { 'Authorization': 'Bearer ' + token, 'X-Xinas-Approval-Interface': 'web' };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }
  function needsPhrase(rec) {
    if (rec.rollback_model === 'unsupported' || rec.risk_level === 'unsupported_rollback') return ACK_NO_ROLLBACK;
    if (rec.risk_level === 'destructive') return ACK_DATA_LOSS;
    return null;
  }
  function render(res) {
    record = res.result;
    var plan = record.plan, s = record.summary, dl = $('#facts');
    dl.textContent = '';
    var rows = [
      ['Node', record.node_id], ['Operation', record.tool_name + ' (' + record.operation_kind + ')'],
      ['Requested by', record.principal], ['Status', record.status], ['Risk', record.risk_level],
      ['Rollback', record.rollback_model], ['Affected', plan.affected_resources.map(function (r) { return r.kind + ' ' + r.id; }).join('; ')],
      ['Warnings', plan.warnings.length ? plan.warnings.map(function (w) { return w.code + ' — ' + w.message; }).join(' | ') : 'none'],
      ['Plan id', record.plan_id], ['Plan hash', record.plan_hash], ['Expires', record.expires_at]
    ];
    rows.forEach(function (r) { dl.appendChild(el('dt', r[0])); dl.appendChild(el('dd', r[1])); });
    $('#consequences').textContent = s.consequences;
    $('#rollback').textContent = s.rollback_limitation;
    $('#diff').textContent = JSON.stringify(plan.diff, null, 2);
    var phrase = needsPhrase(record);
    $('#phrase-row').hidden = phrase === null;
    $('#phrase-label').textContent = phrase ? 'Type exactly: ' + phrase : '';
    $('#approve').textContent = record.risk_level === 'destructive' ? 'Approve — data may be permanently lost' : 'Approve';
    $('#approve').disabled = record.status !== 'pending' || record.mode !== 'url';
    $('#decline').disabled = !(record.status === 'pending' || record.status === 'approved');
    $('#login').hidden = true; $('#review').hidden = false;
  }
  $('#login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    token = $('#token').value; $('#token').value = '';
    setStatus('Loading…');
    api('GET', '/api/v1/mcp/confirmations/' + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200) { setStatus('Could not load the confirmation (HTTP ' + r.status + '). Check the token and role.'); return; }
      setStatus(''); render(r.body);
    }).catch(function () { setStatus('Network error.'); });
  });
  function decide(kind) {
    var body = { reason: $('#reason').value || undefined };
    if (kind === 'approve') {
      if (!$('#reviewed').checked) { setStatus('Confirm that you reviewed the plan.'); return; }
      var phrase = needsPhrase(record);
      if (phrase !== null) { if ($('#phrase').value !== phrase) { setStatus('The acknowledgement phrase does not match.'); return; } body.acknowledge = phrase; }
    }
    setStatus('Submitting…');
    api('POST', '/api/v1/mcp/confirmations/' + encodeURIComponent(id) + '/' + kind, body).then(function (r) {
      if (r.status !== 200) { var e = (r.body.errors && r.body.errors[0]) || {}; setStatus('Refused: ' + (e.code || r.status) + ' ' + (e.message || '')); return; }
      setStatus(kind === 'approve' ? 'Approved. The MCP client may now retry its apply.' : 'Declined. Nothing was changed.');
      render(r.body);
    }).catch(function () { setStatus('Network error.'); });
  }
  $('#approve').addEventListener('click', function () { decide('approve'); });
  $('#decline').addEventListener('click', function () { decide('decline'); });
})();
`;

function html(id: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>xiNAS — approve MCP operation</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/mcp/approvals/assets/app.css"></head>
<body data-confirmation-id="${id}">
<h1>xiNAS operator approval</h1>
<p class="muted">Confirmation <code>${id}</code>. This page approves or declines one MCP-requested operation. It stores nothing in your browser.</p>
<section id="login">
  <p class="warn">Do not paste the token your MCP client uses. Approval must come from a different credential — and a different credential is not proof of a different person: keep this token off machines the agent can read.</p>
  <form id="login-form"><label>Operator token <input id="token" type="password" autocomplete="off" required></label><button type="submit">Load the plan</button></form>
</section>
<section id="review" hidden>
  <dl id="facts"></dl>
  <p class="warn" id="consequences"></p>
  <p id="rollback"></p>
  <h2>Diff</h2><pre id="diff"></pre>
  <label><input id="reviewed" type="checkbox"> I have reviewed the plan above.</label>
  <div id="phrase-row" hidden><label><span id="phrase-label"></span><input id="phrase" type="text" autocomplete="off"></label></div>
  <label>Reason (optional) <input id="reason" type="text" maxlength="512"></label>
  <button id="approve" class="danger" type="button">Approve</button>
  <button id="decline" type="button">Decline</button>
</section>
<p id="status"></p>
<script src="/mcp/approvals/assets/app.js"></script>
</body></html>
`;
}

function setHeaders(res: Response): void {
  for (const [k, v] of Object.entries(APPROVAL_PAGE_HEADERS)) res.setHeader(k, v);
}

/** Mount on the app itself (not /api/v1): unauthenticated shell; the JS authenticates the operator. */
export function mountApprovalPage(app: Express): void {
  app.get('/mcp/approvals/assets/app.js', (_req: Request, res: Response) => {
    setHeaders(res);
    res.type('application/javascript').send(JS);
  });
  app.get('/mcp/approvals/assets/app.css', (_req: Request, res: Response) => {
    setHeaders(res);
    res.type('text/css').send(CSS);
  });
  app.get('/mcp/approvals/:id', (req: Request, res: Response) => {
    setHeaders(res);
    const id = ID.test(req.params.id) ? req.params.id : 'invalid';
    res.type('text/html').send(html(id));
  });
}
```

Mount in `app.ts` immediately after `mountMcpTransport(app, ctx);`: `mountApprovalPage(app);` (before the JSON parser and auth — the shell is public by design; the audit middleware already skips `/mcp/*`).

- [ ] **Step 4: Run** — PASS + gate. Then a manual check: `npm run build && node dist/api-server.js --config <tmp config with approval_url_base http://127.0.0.1:PORT and a tcp listener>` and open `http://127.0.0.1:PORT/mcp/approvals/x` in a browser: the shell renders, the token prompt works against a seeded record. (Document the result in the PR.)

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/confirmation/approval-page.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/mcp/approval-page.test.ts
git commit -m "feat(mcp): cookie-free operator approval page with strict CSP (S15 §9.3)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Metrics registry, `/metrics`, confirmation metrics, and audit parity

**Files:**
- Create: `xiNAS-MCP/src/lib/metrics.ts`
- Create: `xiNAS-MCP/src/api/routes/metrics.ts`
- Modify: `xiNAS-MCP/src/api/mcp/confirmation/metrics.ts` (add `registryConfirmationMetrics(registry)`)
- Modify: `xiNAS-MCP/src/api/context.ts` (`ApiContext.metrics?: MetricsRegistry`), `xiNAS-MCP/src/api/app.ts` (create the registry, pass metrics into the service, mount the route)
- Test: `xiNAS-MCP/src/__tests__/lib/metrics.test.ts` (new), extend `mcp-confirmation.test.ts` (metrics + audit parity)

**Interfaces:**
- `MetricsRegistry`: `counter(name, help, labelNames: string[]): { inc(labels?: Record<string,string>, by?: number): void }`; `gauge(name, help, labelNames): { set(labels, value) }`; `gaugeCollect(name, help, labelNames, collect: () => Array<{ labels: Record<string,string>; value: number }>): void` (a gauge whose samples are computed by `collect()` at every `render()` — the scrape-time form review P2 asks for); `histogram(name, help, buckets: number[], labelNames): { observe(labels, value) }`; `render(): string` (Prometheus text 0.0.4: `# HELP`, `# TYPE`, samples, `_bucket{le=…}` cumulative + `+Inf`, `_sum`, `_count`).
- `registryConfirmationMetrics(registry, store: ConfirmationStore): ConfirmationMetrics` — the nine series of spec §12.2; the pending gauge is a `gaugeCollect` over `store.countPendingByMode()`.
- `GET /api/v1/metrics` → `text/plain; version=0.0.4; charset=utf-8`.

- [ ] **Step 1: Write the failing tests**

`lib/metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../../lib/metrics.js';

describe('MetricsRegistry (S15 §12.2)', () => {
  it('renders counters, gauges and histograms in the text exposition format', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('xinas_test_total', 'a counter', ['kind']);
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' }, 2);
    c.inc({ kind: 'b' });
    const g = reg.gauge('xinas_test_pending', 'a gauge', ['mode']);
    g.set({ mode: 'form' }, 3);
    const h = reg.histogram('xinas_test_seconds', 'a histogram', [1, 5], []);
    h.observe({}, 0.5);
    h.observe({}, 7);
    const out = reg.render();
    expect(out).toContain('# HELP xinas_test_total a counter\n# TYPE xinas_test_total counter\n');
    expect(out).toContain('xinas_test_total{kind="a"} 3\n');
    expect(out).toContain('xinas_test_total{kind="b"} 1\n');
    expect(out).toContain('# TYPE xinas_test_pending gauge\nxinas_test_pending{mode="form"} 3\n');
    expect(out).toContain('xinas_test_seconds_bucket{le="1"} 1\n');
    expect(out).toContain('xinas_test_seconds_bucket{le="5"} 1\n');
    expect(out).toContain('xinas_test_seconds_bucket{le="+Inf"} 2\n');
    expect(out).toContain('xinas_test_seconds_sum 7.5\n');
    expect(out).toContain('xinas_test_seconds_count 2\n');
  });

  it('gaugeCollect samples are recomputed on every render (review P2)', () => {
    const reg = new MetricsRegistry();
    let form = 1;
    reg.gaugeCollect('x_pending', 'open by mode', ['mode'], () => [
      { labels: { mode: 'form' }, value: form },
      { labels: { mode: 'url' }, value: 0 },
    ]);
    expect(reg.render()).toContain('x_pending{mode="form"} 1\n');
    form = 4;
    expect(reg.render()).toContain('x_pending{mode="form"} 4\n');
    expect(reg.render()).toContain('x_pending{mode="url"} 0\n');
  });

  it('escapes label values and rejects unknown labels', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('x_total', 'x', ['reason']);
    c.inc({ reason: 'a"b\\c\nd' });
    expect(reg.render()).toContain('x_total{reason="a\\"b\\\\c\\nd"} 1');
    expect(() => c.inc({ nope: 'v' })).toThrow(/label/);
  });
});
```

In `mcp-confirmation.test.ts` add:

```ts
  it('exposes the confirmation counters on GET /api/v1/metrics (viewer role) with no principal or id labels', async () => {
    // after at least one form flow ran in this suite
    const res = await http GET `/api/v1/metrics` with Bearer tok-viewer (reuse the raw http helper)
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain; version=0\.0\.4/);
    expect(res.text).toMatch(/xinas_mcp_confirmations_requested_total\{mode="form",risk="changing_access"\} [1-9]/);
    expect(res.text).toMatch(/xinas_mcp_confirmations_decided_total\{outcome="consumed"\} [1-9]/);
    expect(res.text).toContain('xinas_mcp_confirmation_to_apply_seconds_bucket');
    expect(res.text).not.toContain('admin:test');
    expect(res.text).not.toContain('xc1.');
  });

  it('audit parity: one http.* row for the loopback apply plus the lifecycle rows, none for /mcp frames', async () => {
    // drain, run one full form flow, drain, then:
    const rows = auditRows(dir).slice(before);
    expect(rows.filter((r) => r.kind?.startsWith('http.PATCH./api/v1/shares'))).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'http.POST./mcp')).toHaveLength(0);
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining([
      'mcp.confirmation.requested', 'mcp.confirmation.consumed', 'mcp.confirmation.apply_task_created',
    ]));
    const consumed = rows.find((r) => r.kind === 'mcp.confirmation.consumed');
    expect(consumed?.payload).toMatchObject({ confirmation_id: expect.any(String), plan_id: expect.any(String), task_id: expect.any(String), principal: 'admin:test' });
  });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Create `lib/metrics.ts`**

```ts
/**
 * Dependency-free Prometheus-style metrics (S15 §12.2, decision D-05).
 * Counters, gauges and fixed-bucket histograms with label sets, rendered in
 * the text exposition format 0.0.4. Values are held in memory per process.
 */

type Labels = Record<string, string>;

function key(labelNames: string[], labels: Labels): string {
  for (const k of Object.keys(labels)) {
    if (!labelNames.includes(k)) throw new Error(`unknown label '${k}'`);
  }
  return labelNames.map((n) => `${n}=${labels[n] ?? ''}`).join('\u0001');
}

function renderLabels(labelNames: string[], k: string): string {
  if (labelNames.length === 0) return '';
  const values = k.split('\u0001').map((pair) => pair.slice(pair.indexOf('=') + 1));
  const esc = (v: string) => v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  return `{${labelNames.map((n, i) => `${n}="${esc(values[i] ?? '')}"`).join(',')}}`;
}

interface Series { help: string; type: 'counter' | 'gauge' | 'histogram'; labelNames: string[]; render(): string }

export interface Counter { inc(labels?: Labels, by?: number): void }
export interface Gauge { set(labels: Labels, value: number): void }
export interface Histogram { observe(labels: Labels, value: number): void }

export class MetricsRegistry {
  private readonly series = new Map<string, Series>();

  counter(name: string, help: string, labelNames: string[]): Counter {
    const values = new Map<string, number>();
    this.register(name, { help, type: 'counter', labelNames, render: () => [...values].map(([k, v]) => `${name}${renderLabels(labelNames, k)} ${v}`).join('\n') });
    return { inc: (labels = {}, by = 1) => { const k = key(labelNames, labels); values.set(k, (values.get(k) ?? 0) + by); } };
  }

  gauge(name: string, help: string, labelNames: string[]): Gauge {
    const values = new Map<string, number>();
    this.register(name, { help, type: 'gauge', labelNames, render: () => [...values].map(([k, v]) => `${name}${renderLabels(labelNames, k)} ${v}`).join('\n') });
    return { set: (labels, value) => { values.set(key(labelNames, labels), value); } };
  }

  /** A gauge computed at scrape time: `collect()` runs on every render(). */
  gaugeCollect(
    name: string,
    help: string,
    labelNames: string[],
    collect: () => Array<{ labels: Labels; value: number }>,
  ): void {
    this.register(name, {
      help, type: 'gauge', labelNames,
      render: () => collect().map((s) => `${name}${renderLabels(labelNames, key(labelNames, s.labels))} ${s.value}`).join('\n'),
    });
  }

  histogram(name: string, help: string, buckets: number[], labelNames: string[]): Histogram {
    const sorted = [...buckets].sort((a, b) => a - b);
    const data = new Map<string, { counts: number[]; sum: number; count: number }>();
    this.register(name, {
      help, type: 'histogram', labelNames,
      render: () => [...data].flatMap(([k, d]) => {
        const base = renderLabels(labelNames, k);
        const withLe = (le: string) => base === '' ? `{le="${le}"}` : `${base.slice(0, -1)},le="${le}"}`;
        let cumulative = 0;
        const lines = sorted.map((b, i) => { cumulative += d.counts[i] ?? 0; return `${name}_bucket${withLe(String(b))} ${cumulative}`; });
        lines.push(`${name}_bucket${withLe('+Inf')} ${d.count}`, `${name}_sum${base} ${d.sum}`, `${name}_count${base} ${d.count}`);
        return lines;
      }).join('\n'),
    });
    return {
      observe: (labels, value) => {
        const k = key(labelNames, labels);
        const d = data.get(k) ?? { counts: sorted.map(() => 0), sum: 0, count: 0 };
        for (let i = 0; i < sorted.length; i += 1) { if (value <= (sorted[i] as number)) { d.counts[i] = (d.counts[i] ?? 0) + 1; break; } }
        d.sum += value; d.count += 1; data.set(k, d);
      },
    };
  }

  render(): string {
    const out: string[] = [];
    for (const [name, s] of this.series) {
      out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      const body = s.render();
      if (body.length > 0) out.push(body);
    }
    return `${out.join('\n')}\n`;
  }

  private register(name: string, s: Series): void {
    if (this.series.has(name)) throw new Error(`metric '${name}' already registered`);
    this.series.set(name, s);
  }
}
```

(The histogram's `_bucket` rendering uses a non-cumulative-per-bucket count then a running sum — the test above pins `le="5"` = 1 because 7 > 5; check the loop increments only the first matching bucket and the render accumulates. Adjust if the assertion disagrees; the assertion is the contract.)

- [ ] **Step 4: Confirmation metrics + route + wiring**

`confirmation/metrics.ts` add:

```ts
import type { MetricsRegistry } from '../../../lib/metrics.js';

export function registryConfirmationMetrics(reg: MetricsRegistry, store: ConfirmationStore): ConfirmationMetrics {
  const requested = reg.counter('xinas_mcp_confirmations_requested_total', 'MCP confirmations requested', ['risk', 'mode']);
  const decided = reg.counter('xinas_mcp_confirmations_decided_total', 'MCP confirmation outcomes', ['outcome']);
  const capability = reg.counter('xinas_mcp_confirmations_capability_failures_total', 'clients lacking the needed elicitation mode', ['mode']);
  const stateFail = reg.counter('xinas_mcp_confirmations_state_validation_failures_total', 'requestState rejections by class', ['reason']);
  const replay = reg.counter('xinas_mcp_confirmations_replay_rejected_total', 'binding/replay rejections', []);
  const roundLimit = reg.counter('xinas_mcp_confirmations_round_limit_total', 'confirmations expired by the round limit', []);
  // Scrape-time (review P2): the store is the truth; no event bookkeeping to drift.
  reg.gaugeCollect('xinas_mcp_confirmations_pending', 'open confirmations (pending + approved) by mode', ['mode'], () => {
    const n = store.countPendingByMode();
    return [{ labels: { mode: 'form' }, value: n.form }, { labels: { mode: 'url' }, value: n.url }];
  });
  const latency = reg.histogram('xinas_mcp_confirmation_to_apply_seconds', 'requested → consumed', [1, 5, 15, 30, 60, 120, 300, 600, 900], []);
  const approvedExpired = reg.counter('xinas_mcp_confirmations_approved_expired_total', 'approved but never consumed', []);
  return {
    requested: (risk, mode) => requested.inc({ risk, mode }),
    decided: (outcome) => decided.inc({ outcome }),
    capabilityFailure: (mode) => capability.inc({ mode }),
    stateValidationFailure: (reason) => stateFail.inc({ reason }),
    replayRejected: () => replay.inc(),
    roundLimit: () => roundLimit.inc(),
    confirmationToApply: (s) => latency.observe({}, s),
    approvedExpired: () => approvedExpired.inc(),
  };
}
```

In `service.ts`, when the engine consumes, the service does not run — so record the latency where the service learns of consumption: in `retry()` when `record.status === 'consumed'` on a later replay is too late. Instead the **engine** calls back: add `onConsumed?: (record) => void` to `TaskEngineDeps`; `app.ts` wires `onConsumed: (r) => { metrics.decided('consumed'); metrics.confirmationToApply(((r.consumed_at ?? Date.now()) - r.created_at) / 1000); }`. The engine invokes it after the transaction commits (outside `run()`), guarded by `confirmation !== undefined`.

`routes/metrics.ts`:

```ts
import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';

export function metricsRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/metrics', (_req, res) => {
    if (ctx.metrics === undefined) throw new ApiException('INTERNAL', 'metrics registry not available');
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain; version=0.0.4; charset=utf-8').send(ctx.metrics.render());
  });
  return r;
}
```

`context.ts`: `metrics?: import('../lib/metrics.js').MetricsRegistry;`. `app.ts`: `ctx.metrics ??= new MetricsRegistry();` before the service is built; pass `metrics: registryConfirmationMetrics(ctx.metrics, ctx.tasks.confirmations)` into `ConfirmationService` (import `type ConfirmationStore` in `confirmation/metrics.ts`); `v1.use(metricsRouter(ctx));`. In `mcp-confirmation.test.ts` also assert the gauge: after a form flow leaves one record consumed and a URL record pending, `GET /metrics` shows `xinas_mcp_confirmations_pending{mode="form"} 0` and `{mode="url"} 1`, and after the URL record is declined both read 0.

- [ ] **Step 5: Run** — PASS + gate.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/metrics.ts xiNAS-MCP/src/api/routes/metrics.ts xiNAS-MCP/src/api/mcp/confirmation/metrics.ts xiNAS-MCP/src/api/mcp/confirmation/service.ts xiNAS-MCP/src/api/tasks/engine.ts xiNAS-MCP/src/api/context.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/lib/metrics.test.ts xiNAS-MCP/src/__tests__/api/mcp/mcp-confirmation.test.ts
git commit -m "feat(api): dependency-free metrics registry, GET /metrics, MCP confirmation counters and audit parity (S15 §12)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Expiry sweep (startup + timer), GC prune, restart recovery

**Files:**
- Create: `xiNAS-MCP/src/api/mcp/confirmation/sweeper.ts`
- Modify: `xiNAS-MCP/src/api/server.ts` (startup sweep before `reconcile()`, start/stop the timer)
- Modify: `xiNAS-MCP/src/state/gc.ts` (`sweepConfirmations()` in `sweepAll`)
- Test: `xiNAS-MCP/src/__tests__/api/mcp/confirmation-restart.test.ts` (new), `xiNAS-MCP/src/__tests__/state/gc.test.ts`

**Interfaces:**
- `startConfirmationSweeper({ service, intervalMs? }): { stop(): void }` — default `CONFIRMATION_SWEEP_INTERVAL_MS = 30_000`, `unref()`ed, each tick calls `service.sweepExpired('ttl')` and swallows errors.
- `GcSweeper.sweepConfirmations(): { confirmations_deleted: number }` — `DELETE … WHERE status IN (terminal) AND created_at < now − taskRetentionMs`; `GcSweepResult` gains `confirmations_deleted`.

- [ ] **Step 1: Write the failing restart tests**

`confirmation-restart.test.ts` boots `startServer` twice on the same `databasePath` (the same temp dir), with the mock agent, driving the modern wire format like `mcp-confirmation.test.ts` (extract the `rpc`/`call`/`planShareUpdate` helpers of that suite into `src/__tests__/api/mcp/_mrtr-helpers.ts` now, and import them from both suites):

```ts
  it('a pending form confirmation survives restart and is consumable', ...)
     // apply → input_required; close(); startServer(same config); retry with the SAME requestState → task
  it('an approved URL confirmation survives restart and is consumable until expiry', ...)
  it('a consumed confirmation stays consumed across restart: identical retry → same task; changed key → CONFIRMATION_ALREADY_CONSUMED', ...)
  it('restart past expires_at expires the record with reason restart_sweep and audits it; the retry gets CONFIRMATION_EXPIRED', ...)
     // set ttl_seconds: 60; before restart, UPDATE mcp_confirmations SET expires_at = <now - 1> via better-sqlite3 on the closed db file
  it('the timer sweep expires an overdue record within two intervals (intervalMs: 50 in test via a config knob)', ...)
     // expose `confirmationSweepIntervalMs` on StartServerOptions (test-only override), default 30_000
```

`gc.test.ts`: append a case that inserts one terminal and one pending `mcp_confirmations` row older than the retention window and asserts `sweepAll()` deletes only the terminal one.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`sweeper.ts`:

```ts
import type { ConfirmationService } from './service.js';

/** S15 §6.3: TTL sweep every 30 s (the lease sweeper's cadence), unref()ed, error-swallowing. */
export const CONFIRMATION_SWEEP_INTERVAL_MS = 30_000;

export interface ConfirmationSweeperHandle { stop(): void }

export function startConfirmationSweeper(opts: { service: ConfirmationService; intervalMs?: number }): ConfirmationSweeperHandle {
  const timer = setInterval(() => {
    try {
      opts.service.sweepExpired('ttl');
    } catch {
      /* best-effort; the next tick retries */
    }
  }, opts.intervalMs ?? CONFIRMATION_SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

`server.ts`: after `const app = createApp(ctx);` (the service exists from then on) and **before** the startup `reconcile()`:

```ts
  // S15 §6.5 / §17.5: expire overdue confirmations before the task engine
  // reconciles; consumed rows are never touched.
  ctx.mcpConfirmations?.sweepExpired('restart_sweep');
  const confirmationSweeper =
    ctx.mcpConfirmations !== undefined
      ? startConfirmationSweeper({ service: ctx.mcpConfirmations, ...(opts.confirmationSweepIntervalMs !== undefined ? { intervalMs: opts.confirmationSweepIntervalMs } : {}) })
      : undefined;
```

and `confirmationSweeper?.stop();` in `close()` next to `leaseSweeper.stop()`. Add `confirmationSweepIntervalMs?: number` to `StartServerOptions` (documented as test-only). Note the ordering constraint: `createApp` is currently called after the engines/tracker are built — verify where `createApp(ctx)` sits in `startServer` and place the sweep call after it.

`gc.ts`: add

```ts
  sweepConfirmations(): { confirmations_deleted: number } {
    const cutoff = Date.now() - this.taskRetentionMs;
    const info = this.db
      .prepare(`DELETE FROM mcp_confirmations WHERE status IN ('declined','cancelled','expired','consumed') AND created_at < ?`)
      .run(cutoff);
    return { confirmations_deleted: info.changes };
  }
```

call it from `sweepAll()` and add `confirmations_deleted` to `GcSweepResult`.

- [ ] **Step 4: Run** — PASS + gate.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/confirmation/sweeper.ts xiNAS-MCP/src/api/server.ts xiNAS-MCP/src/state/gc.ts xiNAS-MCP/src/__tests__/api/mcp/confirmation-restart.test.ts xiNAS-MCP/src/__tests__/api/mcp/_mrtr-helpers.ts xiNAS-MCP/src/__tests__/api/mcp/mcp-confirmation.test.ts xiNAS-MCP/src/__tests__/state/gc.test.ts
git commit -m "feat(mcp): confirmation expiry sweep at startup and on a timer; GC prunes terminal records; restart recovery pinned (S15 §6.3–6.5)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: LLM instructions, vendored MCP schema validation, and the contract fixture

**Files:**
- Modify: `xiNAS-MCP/src/api/mcp/discover.ts:50-65` (`INSTRUCTIONS`)
- Create: `xiNAS-MCP/src/__tests__/contracts/mcp/2026-07-28/schema.json` (vendored verbatim from `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.json`; ~181 KB; add a one-line `README.md` beside it with the source URL and fetch date)
- Create: `xiNAS-MCP/src/__tests__/contracts/mcp-schema.test.ts`
- Create: `xiNAS-MCP/src/__tests__/contracts/fixtures/McpConfirmation.json`
- Test: `xiNAS-MCP/src/__tests__/api/mcp-discover.test.ts` (instructions assertion)

**Interfaces:** none new; AC15 ("all protocol examples validate against the MCP 2026-07-28 schema") gets its evidence here.

- [ ] **Step 1: Write the failing tests**

`mcp-schema.test.ts` (Ajv 2020-12 — `import Ajv2020 from 'ajv/dist/2020.js'`, same CJS-bridging cast the contracts test uses):

```ts
describe('S15 wire shapes validate against the vendored MCP 2026-07-28 schema', () => {
  // ajv.addSchema(schema, 'mcp'); const validate = (def) => ajv.getSchema(`mcp#/$defs/${def}`)
  it('InputRequiredResult (form) — built by the service', ...)   // construct via ConfirmationService.elicitation path: run the in-process service over a temp db with a seeded plan (reuse confirmation-service.test.ts harness) and validate the result
  it('InputRequiredResult (url)', ...)
  it('the retry ElicitResult examples', ...)                       // { action: 'accept', content: { decision: 'APPLY' } }, { action: 'accept' }, { action: 'decline' }, { action: 'cancel' }
  it('MissingRequiredClientCapabilityError as the transport emits it', ...) // { jsonrpc, id, error: { code: -32021, message, data: { requiredCapabilities: { elicitation: { url: {} } } } } }
  it('a complete CallToolResult with resultType', ...)             // { resultType: 'complete', content: [{ type: 'text', text: '{}' }], isError: true }
  it('ClientCapabilities shapes the server accepts', ...)          // { elicitation: {} }, { elicitation: { form: {}, url: {} } }
});
```

`McpConfirmation.json` fixture — a full record as `GET /mcp/confirmations/{id}` returns it (ISO timestamps, `plan` = a valid `Plan`, `summary`), validated by the existing `contracts.test.ts` loop automatically (it iterates every fixture file).

`mcp-discover.test.ts`: assert `result.instructions` contains `input_required`, `approval`, and `never` (the "never fabricate an acceptance" sentence).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`discover.ts` `INSTRUCTIONS` — replace the last two sentences with:

```ts
  'Applying through MCP is refused unless the node sets mcp.allow_apply; treat that',
  'refusal as final and route the operator to the REST API or xinasctl instead of',
  'retrying. When apply is allowed, every mode="apply" first answers',
  'resultType="input_required": a form the operator must answer with APPLY, or —',
  'for destructive operations — a URL the operator opens to approve on the node.',
  'Show that request to the operator and retry only with their real answer and the',
  'exact requestState you were given; never fabricate an acceptance, never invent',
  'dangerous=true, and never treat the word "yes" as approval.',
```

Vendor the schema file (`curl -fsSL <url> -o …/schema.json`), write the README line, write the fixture, write the test.

- [ ] **Step 4: Run** — `npm run test:contracts` and `npm test` PASS.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/mcp/discover.ts xiNAS-MCP/src/__tests__/contracts/mcp xiNAS-MCP/src/__tests__/contracts/mcp-schema.test.ts xiNAS-MCP/src/__tests__/contracts/fixtures/McpConfirmation.json xiNAS-MCP/src/__tests__/api/mcp-discover.test.ts
git commit -m "test(mcp): validate S15 wire shapes against the vendored MCP 2026-07-28 schema; McpConfirmation contract fixture; confirmation-aware LLM instructions" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: v2 SDK client interoperability tests and repository guidance

**Files:**
- Modify: `xiNAS-MCP/package.json` (devDependency `"@modelcontextprotocol/client": "2.0.0"` — exact pin), `package-lock.json` (via `npm install --save-dev --save-exact @modelcontextprotocol/client@2.0.0`)
- Create: `xiNAS-MCP/src/__tests__/api/mcp/sdk-v2-client.test.ts`
- Modify: `docs/TODO.md` (remove the "modern-era SDK client tests" entry; add the TUI approvals deferral)
- Modify: `CLAUDE.md` §MCP surface
- Modify: `docs/control-path/hardware-smoke-runbook.md` §5b
- Modify: `collection/roles/xinas_api/README.md` (config keys, key-ring rotation)

**Interfaces:** the v2 client API as installed (`node_modules/@modelcontextprotocol/client/dist/index.d.mts`): `new Client({ name, version }, { versionNegotiation: { mode }, capabilities: { elicitation: { form: {}, url: {} } }, inputRequired: { autoFulfill: true } })`, `client.setRequestHandler('elicitation/create', async (req) => ({ action, content }))`, `new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'), { requestInit: { headers: { authorization: 'Bearer tok-admin' } } })`, `await client.connect(transport)`, `client.getNegotiatedProtocolVersion()`, `await client.callTool({ name, arguments })`, `await client.close()`.

- [ ] **Step 1: Install and write the failing tests**

```bash
cd xiNAS-MCP && npm install --save-dev --save-exact @modelcontextprotocol/client@2.0.0
```

`sdk-v2-client.test.ts` (boots the same server as `mcp-confirmation.test.ts` via `_mrtr-helpers.ts`):

```ts
  it('S14 AC10: auto mode negotiates 2026-07-28 with no initialize', ...)
     // versionNegotiation: { mode: 'auto' } → getNegotiatedProtocolVersion() === '2026-07-28'; the server log/audit shows no legacy session (no Mcp-Session-Id returned — assert via a wrapped fetch that records response headers)
  it('S14 AC11: pinned to 2026-07-28 connects', ...)
  it('form flow end to end: the elicitation handler sees the generated message and returns APPLY → task', ...)
     // handler asserts params.mode === 'form', params.message includes 'share-a', returns { action: 'accept', content: { decision: 'APPLY' } }; callTool resolves with resultType complete and a task_id in the text payload
  it('decline in the handler → CONFIRMATION_DECLINED, no task', ...)
  it('URL elicitation reaches the handler with the approval URL; accept before the operator decides → the client sees another input_required round (autoFulfill re-drives it) and finally CONFIRMATION_ROUND_LIMIT', ...)
     // url_wait_seconds: 1 in the test config to keep it fast; assert the record ends expired/round_limit
```

- [ ] **Step 2: Run to verify they fail** (the first two fail before Task 1's server changes? No — they pass already against S14; keep them as regression pins. The form/decline/URL cases fail until the handler wiring is right; if any name from the interface list above differs in the installed typings, reconcile against `index.d.mts` and note it in the test file header).

- [ ] **Step 3: Make them pass; then the docs**

`docs/TODO.md`: delete the section "## MCP — the modern-era SDK client tests (acceptance criteria 10 and 11) are unwritten" entirely. Append:

```markdown
## MCP — the TUI "pending approvals" screen is deferred

*Deferred 2026-09-04, from the S15 MCP confirmation change
(`docs/control-path/s15-mcp-mrtr-confirmation-spec.md` §9.5, decision D-09).*

**What is missing.** A Management screen in `xinas_menu` listing pending
MCP confirmations (`GET /api/v1/mcp/confirmations?status=pending`) with
approve / decline actions, the plan summary, and the typed acknowledgement
phrase for destructive records.

**What the code does instead.** Operators approve on the web page
(`/mcp/approvals/{id}`), over REST, or with `xinasctl mcp_confirmations
approve <id> --acknowledge "…"` over the UDS; all three hit the same routes
and approver policy.

**Why it was cut.** Three channels already cover approval; the TUI screen is
additive UI and would have doubled the review surface of a security change.

**What done looks like.** `xinas_menu/screens/mcp_approvals.py` driven by
`control_client.py`, showing exactly the fields the web page shows (S15
§9.3), refusing to approve without the phrase, and a pytest against the
stub server for approve / decline / policy refusal rendering.
```

`CLAUDE.md` §MCP surface — extend the live-contract sentence: "`docs/control-path/adr/0010-clients-mcp-cli-tui.md`, `docs/control-path/s8-clients-spec.md`, `docs/control-path/s14-mcp-modern-era-spec.md` (modern era) and `docs/control-path/s15-mcp-mrtr-confirmation-spec.md` (MRTR apply confirmation — every MCP `mode=apply` needs a human confirmation after `mcp.allow_apply`)."

`hardware-smoke-runbook.md` §5b — append checklist items:

```markdown
- [ ] **S15 MCP confirmation (form) — this step is the verification of
  the target-client behavior in S15 §14.4; nothing before it counts as
  proof.** With `mcp.allow_apply: true`, from Claude Code ≥ 2.1.259
  registered against `xinas-mcp-stdio` as a **non-root** account that is
  not in `xinas-admin` (S15 §3.5): plan a
  share update, then apply — Claude Code shows the xiNAS form (node,
  operation, risk, diff, expiry); pick APPLY → the task runs; pick Decline
  → `CONFIRMATION_DECLINED` and no task. The api journal shows the retry
  arriving with a NEW JSON-RPC id and the exact `requestState`.
- [ ] **S15 destructive (URL):** set `mcp.confirmation.approval_url_base`
  (https, or `http://127.0.0.1:<port>` when testing on the node itself);
  `filesystems.delete` with `dangerous: true` → Claude Code shows the
  approval URL and asks consent; open it, load with a *different* admin
  token, type `DATA MAY BE PERMANENTLY LOST`, approve → the client's retry
  creates the task. Approving with the requester's own token → refused
  (`approver_policy`). `xinasctl mcp_confirmations list --status pending`
  works as root; `approve <id> --acknowledge "…"` as root is **refused**
  with the default config (break-glass off) and succeeds — leaving a
  `mcp.confirmation.break_glass_used` audit row — only after setting
  `allow_uds_approval: true`; set it back to false afterwards.
- [ ] **S15 Codex ≥ 0.147** with `protocol_version = "2026-07-28"`
  (upgrade first — the development Mac has 0.136.0): the form flow
  completes; a destructive apply without URL support fails with JSON-RPC
  `-32021` before any mutation. Record the observed behavior against the
  "expected" rows of S15 §14.4.
- [ ] Audit (`/var/log/xinas/audit.jsonl`): `mcp.confirmation.requested`,
  `…approved` (URL), `…consumed`, `…apply_task_created` rows plus exactly
  one `http.*` row for the apply; `GET /api/v1/metrics` shows the counters.
```

`collection/roles/xinas_api/README.md` — a new section "MCP apply confirmation (S15)" listing the `mcp.confirmation.*` keys with defaults and ranges, `state.confirmationKeyPath` (default `/var/lib/xinas/state/mcp-confirmation-keys.json`, created 0600 by the api on first boot), the rotation procedure (add a key under `keys`, point `active` at it, restart; remove the old key after `ttl_seconds`), and `allow_uds_approval` (default **false**, break-glass, audited as `break_glass_used`) together with the boundary statement of S15 §3.5: an agent with root or `xinas-admin` on the node is outside the MRTR guarantee, and such deployments approve from another machine.

- [ ] **Step 4: Run** — `npm test`, `npm run typecheck && npm run lint && npm run format:check`, `npx --yes markdownlint-cli2 'docs/**/*.md'`.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/package.json xiNAS-MCP/package-lock.json xiNAS-MCP/src/__tests__/api/mcp/sdk-v2-client.test.ts docs/TODO.md CLAUDE.md docs/control-path/hardware-smoke-runbook.md collection/roles/xinas_api/README.md
git commit -m "test(mcp): v2 SDK client interop (S14 AC10/11 + S15 form/decline/URL); docs: TODO, CLAUDE.md, runbook §5b, xinas_api README" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: e2e parity scenarios and the final sweep

**Files:**
- Modify: `xiNAS-MCP/src/__tests__/e2e/client-parity.test.ts` (scenarios 7–9 of S8 §7)
- Verify: everything

- [ ] **Step 1: Write the failing e2e cases**

In `client-parity.test.ts` (real `dist/api-server.js` + `dist/agent-server.js` + `dist/mcp-stdio.js`), with the api config carrying `mcp: { allow_apply: true, confirmation: { approval_url_base: 'http://127.0.0.1:1', url_wait_seconds: 1 } }`:

```ts
  it('7. confirmation parity: REST and xinasctl apply directly; modern MCP needs the form first; same plan_hash', ...)
     // drive the stdio adapter with the MODERN envelope (_meta) — the StdioMcp helper gains a `modern` option that adds _meta and passes through inputResponses/requestState
  it('8. destructive parity: filesystems.delete via MCP returns a URL; `xinasctl mcp_confirmations approve <id> --acknowledge "DATA MAY BE PERMANENTLY LOST"` over the UDS approves; the retry creates the task; dangerous:true was required', ...)
  it('9. legacy denial: the legacy session apply gets MCP_CONFIRMATION_UNSUPPORTED; reads/plan/support.bundle/tasks.cancel unchanged', ...)
```

- [ ] **Step 2: Build and run** — `npm run build && npm run test:e2e` (≈ 55 s + the new cases). Expected: PASS. Under load races, re-run with the ~100-busy-loop reproduction the repo notes describe before calling a flake real.

- [ ] **Step 3: Full verification (the CI mirror)**

From the worktree root:

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:contracts && npm run build && npm run test:e2e && cd ..
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
pytest --cov=xinas_history --cov-fail-under=20
ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper
ruff format --check .
pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper
yamllint -c .yamllint.yml .
```

All green. (`oasdiff` and `gitleaks` run only on the PR.)

- [ ] **Step 4: Commit and hand off**

```bash
git add xiNAS-MCP/src/__tests__/e2e/client-parity.test.ts
git commit -m "test(e2e): MCP confirmation parity — form, destructive URL via xinasctl approval, legacy denial (S8 §7 scenarios 7–9)" -m "Requires-Rebuild: xinas_node_build" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then open the PR against `release/3.14` (merge with `--merge`), body listing the acceptance-criteria table of spec §16 with the test file for each row, the manual runbook results for Claude Code and Codex, and the aggregated `Requires-Rebuild: xinas_node_build` trailer restated in the description.

---

## Done means

- Every acceptance criterion in spec §16 maps to a passing test named in this plan (1–12, 15) or a recorded runbook result (13, 14).
- `ApplyRequest` in `api-v1.yaml` is byte-identical to `release/3.14`; `oasdiff` on the PR reports no breaking change.
- A legacy MCP client's reads, plans, `support.bundle` and `tasks.cancel` behave exactly as before (existing suites unchanged and green).
- No configuration key disables confirmation; `mcp.allow_apply: false` still answers `MCP_APPLY_DISABLED` with zero rows written.
- `docs/TODO.md` no longer carries the SDK deferral and does carry the TUI screen deferral; `CLAUDE.md` names S15 as a live MCP contract.
