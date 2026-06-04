# S2 Task Envelope + Plan/Apply Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the durable plan/apply + task engine (ADR-0004) that turns the read-only S0/S1 control plane into a mutating one, proven end-to-end through a built-in reference executor.

**Architecture:** The task engine is an in-process module of `xinas-api` persisting to the **existing** SQLite `tasks` / `task_stages` / `leases` tables (ADR-0004; migration `001-initial.sql`) and reusing the **existing `LeaseManager`** (`src/state/leases.ts`). api (unprivileged) owns the DB + dispatch + reconcile; agent (root) executes via a per-task runner + reference executor + xinas_history snapshot bridge and reports facts via `POST /internal/v1/task_progress`. Idempotency is the `UNIQUE(idempotency_key, principal)` constraint; serialization is a worker pool (cap=1 in S2) + per-resource leases.

**Tech Stack:** TypeScript (`module:Node16`, `exactOptionalPropertyTypes`), Express 5, **better-sqlite3 (prepared statements + `db.transaction`, like `leases.ts`)**, vitest + supertest, biome 1.9.4. Python `xinas_history` via subprocess. Spec: `docs/control-path/s2-task-envelope-spec.md`. ADR: `docs/control-path/adr/0004-task-engine.md`.

**Conventions (from S0/S1):** `.js` ESM imports; conditional spread for optionals; `sendOk`/`embedMetadata`/`ApiException`; inject `now()`/id-gen (no bare `Date.now()`/`randomUUID()` in engine modules); HEREDOC commits ending `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; never `git add -A`; per-task two-stage review; stacked operator-gated draft PRs (never merge without approval). Unit = `npm test`; e2e = `npm run test:e2e`; contracts = `npm run test:contracts`. **No `Requires-Rebuild` trailer** (pure TS/Python/docs; no Ansible role changes).

---

## Reuse-not-rebuild (read before starting)

These already exist — **use them, do not reinvent**:
- `xiNAS-MCP/src/state/leases.ts` → `LeaseManager` (`acquire`/`heartbeat`/`release`/`sweepExpired`). T2/T9 use it directly.
- `xiNAS-MCP/src/state/migrations/001-initial.sql` → `tasks`, `task_stages`, `leases` tables. T1 reads/writes them; do **not** recreate.
- `xiNAS-MCP/src/api/errors.ts` → reuse `CONFLICT` (409) + `PRECONDITION_FAILED` (412) with `details.reason`; **do not add `ErrorCode` values**.
- ADR-0004 §`tasks table` / §`task_stages table` → the authoritative column lists.

## File structure (locked)

**API side** (`xiNAS-MCP/src/api/`):
| File | Responsibility |
|------|----------------|
| `tasks/types.ts` | `Task`, `TaskStage`, `TaskState`, `StageStatus`, `TaskErrorCode`, `EventType`, `TaskProgressEvent`, `Plan`, `PlanProvider` — matching api-v1.yaml + ADR-0004 columns. |
| `tasks/store.ts` | `TaskStore`: prepared-statement CRUD over `tasks` + `task_stages`; lifecycle transitions; stage upsert + hybrid spill; `list`/`get`. |
| `tasks/engine.ts` | `TaskEngine`: the atomic apply `db.transaction` (idempotency + freshness + `LeaseManager.acquire` + insert), worker pool (cap=1), `dispatch()`, `reconcile()`. |
| `tasks/progress.ts` | `/internal/v1/task_progress` receiver: taxonomy validate + monotonic + apply to `task_stages`/`tasks` + spill + SSE notify. |
| `tasks/watch.ts` | Resumable SSE (replay from `task_stages`). |
| `plan/engine.ts` | `PlanEngine` + `PlanProvider` registry; writes the `plan_only` task row; `plan_hash`. |
| `plan/providers/reference.ts` | Reference `PlanProvider`. |
| `agent-client.ts` | api→agent JSON-RPC client (`task.begin`/`cancel`/`list_inflight`); generalizes `createAgentHealthProbe`. |

**Agent side** (`xiNAS-MCP/src/agent/`): `task/types.ts` (`Executor`/`ExecutorStage`/`ExecutorContext`), `task/registry.ts`, `task/reference-executor.ts` (stages + `rollback()`), `task/xinas-history-bridge.ts`, `task/progress-publisher.ts`, `task/runner.ts`, `rpc/methods/task.ts`.

**Modified:** `docs/control-path/api-v1.yaml`, `docs/control-path/adr/0002-agent-privilege-model.md`, `xiNAS-MCP/src/agent/rpc/methods/stubs.ts` (+ test — remove four `task.*`), `xiNAS-MCP/src/state/migrations/002-task-dispatch.sql` (new), `xiNAS-MCP/src/api/routes/tasks.ts`, `xiNAS-MCP/src/api/app.ts`/`server.ts`, `xiNAS-MCP/src/agent-server.ts`, `xinas_history/__main__.py` (+ test), `vitest.e2e.config.ts`.

---

## Task T0: Contract revisions + stub removal

**Files:** Modify `docs/control-path/api-v1.yaml`, `docs/control-path/adr/0002-agent-privilege-model.md`, `xiNAS-MCP/src/agent/rpc/methods/stubs.ts`, `xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts`.

- [ ] **Step 1: Failing test — none of the four `task.*` are api→agent stubs.** In `stubs.test.ts`:
```ts
it.each(['task.begin','task.cancel','task.list_inflight','task.stage_report'])(
  '%s is NOT in STUB_METHODS (real handler in T7 / push in T5)', (m) => {
    expect(STUB_METHODS).not.toHaveProperty(m);
  });
```
- [ ] **Step 2: Run — fails** (all four currently present). `cd xiNAS-MCP && npx vitest run src/__tests__/agent/rpc/methods/stubs.test.ts`.
- [ ] **Step 3: Remove** `'task.begin'`, `'task.cancel'`, `'task.list_inflight'`, `'task.stage_report'` from `STUB_METHOD_NAMES` (`stubs.ts`) and `REQUIRED_STUB_METHODS` (`stubs.test.ts`). (They are no longer enumerated stubs; begin/cancel/list_inflight get real handlers in T7, stage_report becomes the push. Until T7 lands they will return `-32601`, which is acceptable on the in-progress branch and fixed within the same stack.)
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: api-v1.yaml edits.** (a) `Plan`: add `observed_revision_expected: { type: [integer,"null"] }`, `observed_at: { type: [string,"null"], format: date-time }`. (b) `Task`: add `agent_acceptance_id: { type: [string,"null"] }`. (c) New `POST /internal/v1/task_progress` path + `TaskProgressEvent` schema: required `[task_id, sequence, event_type]`, `event_type` enum `accepted|stage_started|stage_succeeded|stage_failed|rollback_started|rollback_succeeded|rollback_failed|terminal`, optional `stage_index`/`stage_name`/`status`/`output_inline`/`output_size_bytes`/`error_code`/`error_message`/`snapshot_id`/`observed_at`. (d) In the `CONFLICT` error description, document `details.reason ∈ lease_held|idempotency_key_reused|plan_stale` (+ `holder_task_id` for `lease_held`). **Do NOT add new top-level error codes.** (e) Strike `task.stage_report` from the agent RPC method list prose.
- [ ] **Step 6: Validate.** `cd xiNAS-MCP && npm run test:contracts` — expect PASS.
- [ ] **Step 7: ADR-0002 edit** — add "Task engine (S2)": api owns the DB + dispatch + reconcile; agent executes + reports via `POST /internal/v1/task_progress`; `task.stage_report` is removed as an api→agent method. Cross-link ADR-0004 (persistence) + the S2 spec.
- [ ] **Step 8: Commit:** `feat(control-path): T0 — S2 contract revisions (plan freshness, agent_acceptance_id, task_progress; remove task.* stubs)`.

---

## Task T1: TaskStore over SQLite + migration 002

**Files:** Create `xiNAS-MCP/src/api/tasks/types.ts`, `xiNAS-MCP/src/api/tasks/store.ts`, `xiNAS-MCP/src/state/migrations/002-task-dispatch.sql`. Test `xiNAS-MCP/src/__tests__/api/tasks/store.test.ts`.

- [ ] **Step 1: Migration 002** (`002-task-dispatch.sql`): `ALTER TABLE tasks ADD COLUMN agent_acceptance_id TEXT;` Wire it into the migration runner (follow how `001-initial.sql` is registered in `src/state/`); bump `schema_version`.
- [ ] **Step 2: Types** (`tasks/types.ts`) — match api-v1.yaml + ADR-0004:
```ts
export type TaskState = 'plan_only'|'queued'|'running'|'success'|'failed'|'cancelled'|'requires_manual_recovery'|'imported';
export type StageStatus = 'pending'|'running'|'success'|'failed'|'skipped';
export type TaskErrorCode = 'FAILED_BEFORE_CHANGE'|'FAILED_PARTIAL_ROLLED_BACK'|'FAILED_MANUAL_RECOVERY_REQUIRED'|'FAILED_STATE_DESYNC';
export type EventType = 'accepted'|'stage_started'|'stage_succeeded'|'stage_failed'|'rollback_started'|'rollback_succeeded'|'rollback_failed'|'terminal';
export interface TaskStage { stage_index: number; name: string; status: StageStatus; started_at?: number; ended_at?: number;
  output_inline?: string; output_path?: string; output_size_bytes: number; error_code?: string; error_message?: string; }
export interface Task { kind: string /* operation kind, e.g. reference.echo */; task_id: string; state: TaskState;
  plan_id?: string; idempotency_key?: string; principal: string; client_type: string; request_id: string; correlation_id: string;
  input_hash: string; plan_hash?: string; result_hash?: string; state_revision_expected?: number; state_revision_at_apply?: number;
  risk_level: string; affected_resources: Array<{ kind: string; id: string; revision?: number }>;
  snapshot_before?: string; snapshot_after?: string; agent_acceptance_id?: string;
  cancel_requested_at?: number; cancel_refused_reason?: string;
  error_code?: TaskErrorCode; error_message?: string; remediation_hint?: string;
  created_at: number; updated_at: number; terminal_at?: number; stages: TaskStage[]; }
```
- [ ] **Step 3: Failing test.** Open a temp DB (run migrations 001+002); `store.createPlanOnly(...)` writes a `state:'plan_only'` row; `store.createApplyTask(...)` writes `queued`; `store.get(id)` returns it with `stages:[]`; `store.transition(id,{state:'running',agent_acceptance_id:'a1'})` updates + bumps `updated_at`; `store.upsertStage(id,{stage_index:0,name:'apply',status:'running',output_size_bytes:0})` inserts a `task_stages` row, a second call with the same `(task_id,stage_index)` updates it; entering a terminal state sets `terminal_at`. `affected_resources` round-trips through JSON.
- [ ] **Step 4: Run — fails.** `npx vitest run src/__tests__/api/tasks/store.test.ts`.
- [ ] **Step 5: Implement `TaskStore`** with better-sqlite3 prepared statements (model exactly on `leases.ts`): insert/select/update on `tasks`; `upsertStage` (INSERT or UPDATE keyed by `(task_id, stage_index)`); `get` joins `task_stages` ordered by `stage_index`; `list(filter)`; inject `now()`. `output_inline` is text ≤ 64 KiB; larger → caller passes `output_path` (spill happens in T5).
- [ ] **Step 6: Run — passes.** **Commit:** `feat(api): T1 — TaskStore over SQLite tasks/task_stages + migration 002 (agent_acceptance_id)`.

---

## Task T2: Apply transaction (idempotency + freshness + leases)

**Files:** Create `xiNAS-MCP/src/api/tasks/engine.ts` (apply-txn portion). Test `xiNAS-MCP/src/__tests__/api/tasks/apply.test.ts`.

- [ ] **Step 1: Failing test.** `engine.apply({ plan, applyReq, principal, client_type, request_id, correlation_id })` opens ONE `db.transaction` that: looks up the `plan_only` task; verifies each affected resource's current revision == `plan.state_revision_expected` (else throws `ApiException('PRECONDITION_FAILED', …, { stale: [...] })`); `LeaseManager.acquire` each resource (held → `ApiException('CONFLICT', …, { reason:'lease_held', holder_task_id })`); inserts the apply Task (`queued`). Tests: happy path returns the queued task with leases held; **idempotency** — a second apply with the same `idempotency_key`+same `input_hash` returns the **original** task (no new row, via the `UNIQUE(idempotency_key, principal)` catch), and with a **different** `input_hash` throws `CONFLICT { reason:'idempotency_key_reused' }`; a stale revision throws `PRECONDITION_FAILED` and **nothing** is written (assert no task row, no lease); a held lease throws `CONFLICT { reason:'lease_held' }` and rolls back.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `engine.apply` as a single `db.transaction(() => { … })`. Idempotency: attempt the task INSERT; on a `UNIQUE`-constraint error, `SELECT` the existing row — same `input_hash` → return it; else throw `CONFLICT`. (Mirror the `LeaseManager.acquire` try/catch-on-`UNIQUE` pattern.) Use the existing `LeaseManager` instance from `ctx`.
- [ ] **Step 4: Run — passes.** **Commit:** `feat(api): T2 — atomic apply transaction (idempotency UNIQUE + freshness + LeaseManager)`.

---

## Task T3: Plan engine + reference provider

**Files:** Create `xiNAS-MCP/src/api/plan/engine.ts`, `xiNAS-MCP/src/api/plan/providers/reference.ts`. Test `xiNAS-MCP/src/__tests__/api/plan/engine.test.ts`.

- [ ] **Step 1: Test.** `PlanProvider = { operation_kind; preflight(ctx, spec): Promise<PlanResult> }`. `PlanEngine.register(p)`, `PlanEngine.plan(operation_kind, spec, principal, …)` writes a `plan_only` Task (via `TaskStore.createPlanOnly`) with `plan_hash` = sha256 over canonicalized `{operation_kind, spec, affected_resources, diff, state_revision_expected, observed_revision_expected}`, and returns it. Identical inputs → identical `plan_hash`; changed spec → different hash; unknown kind → `ApiException('UNSUPPORTED', …)`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `PlanEngine` (registry + stable-stringify hash, sort keys) and `referencePlanProvider` (`risk_level:'non_disruptive'`, `diff` = echoed spec; reads the reference resource's desired/observed revision from KV to stamp freshness).
- [ ] **Step 4: Run — passes.** **Commit:** `feat(api): T3 — plan engine + reference provider (plan_only row, deterministic plan_hash)`.

---

## Task T4: Reference route + agent-client

**Files:** Create `xiNAS-MCP/src/api/agent-client.ts`, `xiNAS-MCP/src/api/routes/reference.ts`. Modify `xiNAS-MCP/src/api/app.ts`. Test `xiNAS-MCP/src/__tests__/api/routes-reference.test.ts`.

- [ ] **Step 1: agent-client.** Generalize `createAgentHealthProbe` into `createAgentRpcClient(socketPath)` with `call(method, params, timeoutMs)`. Unit-test with the `buildTestAppWithMockAgent` pattern.
- [ ] **Step 2: Route test.** `POST /api/v1/reference {mode:'plan', spec}` → 200 + `result.task_id` (the `plan_only` row) + `plan_hash` + `risk_level`. `{mode:'apply', plan_id, idempotency_key}` with the mock agent accepting (returns `agent_acceptance_id`) → **202** + `task_id`, task `state:'running'`, `agent_acceptance_id` set, leases held. Agent unavailable → task `failed (FAILED_BEFORE_CHANGE)`, leases released, **503**. Duplicate `idempotency_key`+same input → 202 same `task_id`, **no second** `task.begin`.
- [ ] **Step 3: Run — fails.**
- [ ] **Step 4: Implement** the route: plan → `PlanEngine.plan`; apply → `engine.apply` then `engine.dispatch(task)` (minimal inline dispatch for T4: `task.begin` via agent-client; accept → `transition running`+`agent_acceptance_id`+202; reject → `transition failed FAILED_BEFORE_CHANGE`+release leases+error). `sendOk`/`ApiException`.
- [ ] **Step 5: Run — passes.** **Commit:** `feat(api): T4 — reference plan/apply route + agent rpc client`.

---

## Task T5: Progress receiver (`/internal/v1/task_progress`)

**Files:** Create `xiNAS-MCP/src/api/tasks/progress.ts`. Modify internal router + `app.ts`. Test `xiNAS-MCP/src/__tests__/api/internal-task-progress.test.ts`.

- [ ] **Step 1: Test (under `requireInternalAgent`).** Posting `accepted`(seq1)→`stage_started`(seq2,stage0)→`stage_succeeded`(seq3,stage0) updates the task + upserts the `task_stages` row; a **duplicate/again-lower** `sequence` is a 200 no-op; a `terminal{status:'success'}` sets the task terminal + `snapshot_after` + releases leases; an output > 64 KiB is spilled to `/var/log/xinas/tasks/<id>/stage-<n>.log.zst` with `output_path`+`output_size_bytes` set and `output_inline` null; unknown `event_type` → 400.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `taskProgressHandler(ctx)`: validate taxonomy + `controller_id`/`task_id`; track a per-task high-water `sequence` (a column or a `MAX(stage_index)`-style guard — simplest: store `last_event_sequence` via the migration-002 column set or a small in-task field; if not persisted, guard monotonicity per-connection — **persist it**: add `last_event_sequence INTEGER DEFAULT 0` to migration 002 too). On a fresh event: single `db.transaction` → upsert stage / transition task / set snapshot fields / `LeaseManager.heartbeat` / on `terminal` release leases; then `ctx.taskWatch?.notify(task_id, event)`.
- [ ] **Step 4: Run — passes.** **Commit:** `feat(api): T5 — task_progress receiver (taxonomy + monotonic + task_stages + spill)`.

---

## Task T6: Agent runner + reference executor + xinas_history bridge (incl. `--format json`)

**Files:** Create agent `task/*` files. Modify `xinas_history/__main__.py`. Tests: `xiNAS-MCP/src/__tests__/agent/task/runner.test.ts`, `.../xinas-history-bridge.test.ts`, `.../reference-executor.test.ts`, and a Python test for the new flag.

- [ ] **Step 1: Python — add `--format json` to `snapshot create`.** In `xinas_history/__main__.py`, add `create_parser.add_argument("--format", choices=["json","text"], default="text")` and, when `json`, `print(json.dumps({"id": manifest.id}))` (confirm the field via `Manifest.to_dict()`). Add/extend a pytest asserting `snapshot create … --format json` prints parseable `{"id": …}`. Run the repo's python tests.
- [ ] **Step 2: Bridge test + impl.** `XinasHistoryBridge.snapshotCreate(operation, source)` runs `python3 -m xinas_history snapshot create --source <s> --operation <op> --format json` via an injected `runSubprocess(argv)`; parse `{id}`; non-zero exit → throw. (No rollback method — rollback is executor-provided.)
- [ ] **Step 3: Executor interface + reference executor + test.** `Executor = { operation_kind; stages: ExecutorStage[]; rollback(ctx): Promise<void> }`. `referenceExecutor`: stages `preflight`/`apply`/`verify` (no-ops recording output), `rollback` a trivial inverse; honors `ctx.spec.fail_at_stage`. Test the success path and the `fail_at_stage:'apply'` path (apply throws → rollback runs).
- [ ] **Step 4: Runner test.** `TaskRunner.run(beginParams)`: emit `accepted`; `snapshotCreate` → `snapshot_before` (record via a `snapshot_before` stage + task field on the next event); for each stage emit `stage_started`→run→`stage_succeeded`/`stage_failed`; on failure → executor `rollback()` (emit `rollback_started`→`rollback_succeeded`/`rollback_failed`) then `terminal{failed, FAILED_PARTIAL_ROLLED_BACK}`; on success → `snapshotCreate` → `snapshot_after`, `terminal{success}`. Each emit → injected `publish(event)` with a **monotonic `sequence`**; assert the exact ordered sequence. Maintain an in-flight `Map<task_id,{agent_acceptance_id}>`.
- [ ] **Step 5: Implement** publisher (push to api `POST /internal/v1/task_progress`, retry like the observation Publisher) + runner. Run all tests — pass.
- [ ] **Step 6: Commit:** `feat(agent): T6 — task runner + reference executor + xinas_history bridge (snapshot create --format json)`.

---

## Task T7: Agent task RPCs wired into agent-server

**Files:** Create `xiNAS-MCP/src/agent/rpc/methods/task.ts`. Modify `xiNAS-MCP/src/agent-server.ts`. Test `xiNAS-MCP/src/__tests__/agent/rpc/methods/task.test.ts`.

- [ ] **Step 1: Test — idempotent begin.** `task.begin({task_id, operation_kind, spec, plan})` → `{accepted:true, agent_acceptance_id}` and starts the runner; **same `task_id` again** → same `agent_acceptance_id`, no second run; `task.list_inflight()` lists it; `task.cancel({task_id})` sets a cancel flag the runner checks between stages → `{cancel_requested:true}`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `makeTaskHandlers({ runner, registry })` and register them in the `createDispatcher({...})` map in `agent-server.ts`. **No shadowing risk** — T0 removed the four `task.*` from `STUB_METHODS`, so the spread `...STUB_METHODS` no longer contains them; add the real handlers to the same object literal. `begin` is idempotent by `task_id` via the runner's in-flight registry; `cancel` sets a flag; `list_inflight` returns the registry snapshot.
- [ ] **Step 4: Run — passes** (+ re-run `stubs.test.ts`). **Commit:** `feat(agent): T7 — task.begin/cancel/list_inflight (idempotent begin), no stub shadowing`.

---

## Task T8: Resumable SSE watch + tasks metadata fold-in

**Files:** Create `xiNAS-MCP/src/api/tasks/watch.ts`. Modify `xiNAS-MCP/src/api/routes/tasks.ts`. Test `xiNAS-MCP/src/__tests__/api/tasks-watch.test.ts`.

- [ ] **Step 1: Test.** `GET /tasks/{id}/watch` with no `Last-Event-ID` sends the current Task then live events (`progress.notify`); with `Last-Event-ID: 2` **replays** `task_stages`/state past sequence 2 before live. `GET /tasks` + `/tasks/{id}` return synthesized `metadata` (reuse the `read-metadata.test.ts` shape).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `TaskWatch` (`Map<task_id, Set<res>>` + `notify`); the route streams `id: <sequence>\ndata: <json>\n\n`, replaying from the store on reconnect. `tasks.ts` list/get use `embedMetadata`. Wire `ctx.taskWatch` into the T5 receiver's `notify`.
- [ ] **Step 4: Run — passes.** **Commit:** `feat(api): T8 — resumable task watch (SSE) + tasks metadata fold-in`.

---

## Task T9: Reconcile + lease sweep on startup/reconnect

**Files:** Modify `xiNAS-MCP/src/api/tasks/engine.ts` (`reconcile()`), `xiNAS-MCP/src/api/server.ts`/`api-server.ts` (call on startup + heartbeat `offline→healthy`). Test `xiNAS-MCP/src/__tests__/api/reconcile.test.ts`.

- [ ] **Step 1: Test (spec §9 table).** Seed non-terminal tasks + leases; mock `agent-client.task.list_inflight`. Assert: `LeaseManager.sweepExpired()` moves an expired-lease `running` task → `requires_manual_recovery`; `queued` + not inflight → re-dispatched (or `failed FAILED_BEFORE_CHANGE` per the policy const); `running`+`agent_acceptance_id=null`+inflight → acceptance stored, kept running; `running`+`agent_acceptance_id=null`+not inflight → re-dispatch; `running`+acceptance+inflight → left running.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `engine.reconcile()`: call `LeaseManager.sweepExpired()`; fetch the agent in-flight set once; apply the §9 decision table (re-dispatch reuses `dispatch()`, safe because `task.begin` is idempotent by `task_id`). Call `reconcile()` at api startup after the tracker connects + on the `offline→healthy` transition.
- [ ] **Step 4: Run — passes.** **Commit:** `feat(api): T9 — reconcile + lease sweep (ADR-0004 recovery)`.

---

## Task T10: End-to-end suite

**Files:** Create `xiNAS-MCP/src/__tests__/e2e/task-engine-roundtrip.test.ts`.

- [ ] **Step 1: Success path.** Boot a real api + agent (fixture mode like `agent-api-roundtrip.test.ts`, with a `python3 -m xinas_history` shim on PATH that supports `snapshot create --format json`). plan → apply → poll `/tasks/{id}` to terminal → `state:'success'`, `snapshot_before/after` set, `task_stages` shows `accepted…terminal`.
- [ ] **Step 2: Failure→rollback.** Apply with `spec.fail_at_stage:'apply'` → `state:'failed'`, `error_code:'FAILED_PARTIAL_ROLLED_BACK'`, a `rollback`-named stage `success`.
- [ ] **Step 3: Idempotency conflict.** key `K`+plan `P1` (202), then key `K`+plan `P2` (different input) → **409 `CONFLICT` `details.reason:'idempotency_key_reused'`**; re-apply `K`+`P1` → 202 same `task_id`.
- [ ] **Step 4: Crash/reconcile.** Seed a `queued` task + lease (no agent inflight), call `engine.reconcile()`, assert the §9 outcome + lease consistency; seed an expired-lease `running` task and assert `sweepExpired` → `requires_manual_recovery`.
- [ ] **Step 5: Run** `npm run test:e2e`; `npm test`; `npm run test:contracts`; `npx tsc --noEmit`; `npm run lint` — all green.
- [ ] **Step 6: Commit:** `test(e2e): T10 — task engine round-trip (success, rollback, idempotency-conflict, reconcile/sweep)`.

---

## Self-review notes

- **Spec coverage:** T0→§12, T1→§3.1/§3.2/§4, T2→§3.3/§3.4/§5.2, T3→§5.1, T4→§5.2, T5→§6, T6→§7/§8, T7→§9-begin, T8→§3.2/§10, T9→§9, T10→§13. All mapped.
- **Reuse:** `LeaseManager` (T2/T9), existing tables (T1), existing error codes (everywhere). No KV task store, no new error codes, no global serialize lease.
- **Determinism:** inject `now()`/id-gen in `TaskStore`/`PlanEngine`/`TaskRunner`.
- **Migration 002** carries `agent_acceptance_id` + `last_event_sequence` (both additive, idempotent `ALTER TABLE`); bump `schema_version`.
- **Stub shadowing** is closed in T0 (removal), not by spread order.
- **No `Requires-Rebuild`** (pure TS/Python/docs).
- **Rollout:** stacked operator-gated draft PRs; never merge without approval.
