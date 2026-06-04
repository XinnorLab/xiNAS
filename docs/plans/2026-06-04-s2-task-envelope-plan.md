# S2 Task Envelope + Plan/Apply Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the durable plan/apply + task engine that turns the read-only S0/S1 control plane into a mutating one, proven end-to-end through a built-in reference executor.

**Architecture:** api (unprivileged) owns durable control-plane state — plan engine, Task store with dual state machines (lifecycle + dispatch), per-resource + global KV leases, idempotency, append-only event log, resumable SSE, reconciliation. agent (root) owns execution — the task runner, the reference executor, and the xinas_history snapshot/rollback subprocess bridge — and reports facts back via `POST /internal/v1/task_progress`. The api is the sole writer of all task/lock/idempotency records.

**Tech Stack:** TypeScript (`module:Node16`, `exactOptionalPropertyTypes`), Express 5, better-sqlite3 KvStore/KvTransaction (CAS via `expected_revision`), vitest + supertest, biome 1.9.4. Python `xinas_history` invoked via subprocess. Spec: `docs/control-path/s2-task-envelope-spec.md`.

**Conventions (from S0/S1):** `.js` ESM imports; conditional spread for optionals; `sendOk(req,res,result,revisions)` + `embedMetadata`; `ApiException`; HEREDOC commits ending `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; never `git add -A`; per-task two-stage review; stacked operator-gated draft PRs (never merge without approval). `npm test` excludes e2e; `npm run test:e2e` runs it.

---

## File structure (locked before tasks)

**API side** (`xiNAS-MCP/src/api/`):
| File | Responsibility |
|------|----------------|
| `tasks/types.ts` | All task-domain types: `Task`, `TaskStage`, `TaskState`, `DispatchState`, `LockLease`, `IdempotencyEntry`, `TaskEvent`, `EventType`, `Plan`, `PlanProvider`. |
| `tasks/store.ts` | `TaskStore`: create/get/list, CAS lifecycle+dispatch transitions, event-log append, rolled-up projection. |
| `tasks/locks.ts` | `LockManager`: acquire/release resource + global serialize leases (KV), classify (live/expired/ambiguous). |
| `tasks/idempotency.ts` | `IdempotencyStore`: `checkOrReserve(key, plan_hash, task_id)`. |
| `tasks/apply.ts` | `applyTransaction`: the single atomic KV txn (idempotency + freshness + locks + task create). |
| `tasks/dispatcher.ts` | `Dispatcher`: `dispatch(task)` (inline, 202-on-accept) + `reconcile()` (startup/reconnect). |
| `tasks/progress.ts` | `/internal/v1/task_progress` receiver: validate taxonomy, monotonic/CAS apply, event-log append, SSE notify. |
| `tasks/watch.ts` | Resumable SSE for `/tasks/{id}/watch` (replay from event log + live fan-out). |
| `plan/engine.ts` | `PlanEngine` + `PlanProvider` registry; deterministic `Plan` + `plan_hash`. |
| `plan/providers/reference.ts` | Reference resource `PlanProvider`. |
| `agent-client.ts` | api→agent JSON-RPC client (`task.begin`/`cancel`/`list_inflight`); generalizes `createAgentHealthProbe`. |

**Agent side** (`xiNAS-MCP/src/agent/`):
| File | Responsibility |
|------|----------------|
| `task/types.ts` | `Executor`, `ExecutorStage`, `ExecutorContext`, `BeginParams`. |
| `task/registry.ts` | `ExecutorRegistry` (kind → Executor). |
| `task/reference-executor.ts` | The inert `reference.echo` executor (3 stages + `fail_at_stage`). |
| `task/xinas-history-bridge.ts` | `XinasHistoryBridge`: subprocess client for `python3 -m xinas_history` (snapshot create / rollback). |
| `task/progress-publisher.ts` | Push events to api `POST /internal/v1/task_progress` (retry, like the observation Publisher). |
| `task/runner.ts` | `TaskRunner`: per-task stage loop + xinas_history wrap + progress emit + in-flight registry. |
| `rpc/methods/task.ts` | `task.begin`/`task.cancel`/`task.list_inflight` handlers (idempotent begin by task_id). |

**Modified:** `docs/control-path/api-v1.yaml`, `docs/control-path/adr/0002-agent-privilege-model.md`, `xiNAS-MCP/src/agent/rpc/methods/stubs.ts` (+ test), `xiNAS-MCP/src/api/routes/tasks.ts`, `xiNAS-MCP/src/api/app.ts` + `server.ts` (wire routes/receiver), `xiNAS-MCP/src/agent-server.ts` (wire runner/registry), `vitest.e2e.config.ts`.

**KV key layout:** `/xinas/v1/tasks/<id>`, `/xinas/v1/task_events/<id>/<seq:012d>`, `/xinas/v1/locks/resource/<kind>/<id>`, `/xinas/v1/locks/global/serialize`, `/xinas/v1/idempotency/<key>`.

---

## Task T0: Contract revisions (spec-first; all three docs + stub removal)

**Files:**
- Modify: `docs/control-path/api-v1.yaml`
- Modify: `docs/control-path/adr/0002-agent-privilege-model.md`
- Modify: `xiNAS-MCP/src/agent/rpc/methods/stubs.ts:79` (remove `'task.stage_report'`)
- Modify: `xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts:56` (remove `'task.stage_report'`)
- Create test: `xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts` (add: stage_report is NOT a stub)

- [ ] **Step 1: Failing test — `task.stage_report` is no longer an api→agent stub.** In `stubs.test.ts`, add:
```ts
it('task.stage_report is NOT an api→agent stub (it is an agent→api push, see /internal/v1/task_progress)', () => {
  expect(STUB_METHODS).not.toHaveProperty('task.stage_report');
});
```
- [ ] **Step 2: Run — fails** (`stage_report` still present). `npx vitest run src/__tests__/agent/rpc/methods/stubs.test.ts`.
- [ ] **Step 3: Remove** `'task.stage_report',` from `STUB_METHOD_NAMES` (stubs.ts) and from `REQUIRED_STUB_METHODS` (stubs.test.ts). The other three `task.*` (`begin`/`cancel`/`list_inflight`) stay (they remain api→agent until T7 implements them).
- [ ] **Step 4: Run — passes** (38→… stub tests green minus the removed one, plus the new assertion).
- [ ] **Step 5: api-v1.yaml edits.** (a) `Plan` schema: add `observed_revision_expected: { type: [integer,"null"] }` and `observed_at: { type: [string,"null"], format: date-time }`. (b) `Task` schema: add `dispatch_state` (enum `queued|begin_sent|begin_accepted|begin_failed`), `dispatch_attempts` (integer), `last_dispatch_at` ([string,"null"]), `agent_acceptance_id` ([string,"null"]), `last_event_sequence` (integer), `rollback_attempted` (boolean), `rollback_result` (enum `succeeded|failed`, nullable). (c) Add a new internal path `/internal/v1/task_progress` (POST, `TaskProgressEvent` request body) and the `TaskProgressEvent` schema with `event_type` enum `accepted|stage_started|stage_succeeded|stage_failed|rollback_started|rollback_succeeded|rollback_failed|terminal`, plus `task_id`, `sequence` (integer), optional `stage_index`/`stage_name`/`status`/`output_inline`/`error_code`/`error_message`/`snapshot_id`/`rollback_result`/`observed_at`. (d) Add error codes `PLAN_STALE`, `IDEMPOTENCY_KEY_REUSED`, `LOCK_HELD` to the error-code enum/docs. (e) In the agent RPC method list (if present in the yaml prose), strike `task.stage_report` and note it is the agent→api push.
- [ ] **Step 6: Validate openapi.** `cd xiNAS-MCP && npm run contracts` (or the repo's openapi lint task) — expect PASS.
- [ ] **Step 7: ADR-0002 + spec edits.** In `docs/control-path/adr/0002-agent-privilege-model.md`, add a section "Task envelope (S2)": the api-owns-store / agent-executes-and-reports split, dual state machines, lease semantics, rollback authority (api writes), and the `task.stage_report` → `POST /internal/v1/task_progress` refinement. The spec (`s2-task-envelope-spec.md`) is already aligned; cross-link it.
- [ ] **Step 8: Commit.**
```bash
git add docs/control-path/api-v1.yaml docs/control-path/adr/0002-agent-privilege-model.md xiNAS-MCP/src/agent/rpc/methods/stubs.ts xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts
git commit -m "$(cat <<'MSG'
feat(control-path): T0 — S2 contract revisions (plan freshness, dispatch SM, task_progress, remove stage_report RPC)
MSG
)"
```

---

## Task T1: Task store + dual state machines + event log

**Files:**
- Create: `xiNAS-MCP/src/api/tasks/types.ts`
- Create: `xiNAS-MCP/src/api/tasks/store.ts`
- Test: `xiNAS-MCP/src/__tests__/api/tasks/store.test.ts`

- [ ] **Step 1: Types.** In `tasks/types.ts`:
```ts
export type TaskState =
  | 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'requires_manual_recovery';
export type DispatchState = 'queued' | 'begin_sent' | 'begin_accepted' | 'begin_failed';
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
export type TaskErrorCode =
  | 'FAILED_BEFORE_CHANGE' | 'FAILED_PARTIAL_ROLLED_BACK'
  | 'FAILED_MANUAL_RECOVERY_REQUIRED' | 'FAILED_STATE_DESYNC';
export type EventType =
  | 'accepted' | 'stage_started' | 'stage_succeeded' | 'stage_failed'
  | 'rollback_started' | 'rollback_succeeded' | 'rollback_failed' | 'terminal';

export interface TaskStage { stage_index: number; name: string; status: StageStatus;
  started_at?: string; ended_at?: string; output_inline?: string; error_code?: string; error_message?: string; }

export interface Task {
  kind: 'Task'; task_id: string; operation_kind: string; principal: string; client_type: string;
  request_id: string; correlation_id?: string;
  state: TaskState; dispatch_state: DispatchState;
  dispatch_attempts: number; last_dispatch_at?: string; agent_acceptance_id?: string;
  plan_id?: string; plan_hash?: string; idempotency_key?: string; input_hash?: string;
  state_revision_expected?: number; state_revision_at_apply?: number; observed_revision_expected?: number;
  risk_level?: string; affected_resources: Array<{ kind: string; id: string; revision?: number }>;
  snapshot_before?: string; snapshot_after?: string;
  rollback_attempted: boolean; rollback_result?: 'succeeded' | 'failed';
  error_code?: TaskErrorCode; error_message?: string; remediation_hint?: string;
  last_event_sequence: number; stages: TaskStage[];
  created_at: string; updated_at: string; terminal_at?: string;
}

export interface TaskEvent { kind: 'TaskEvent'; task_id: string; sequence: number; event_type: EventType;
  stage_index?: number; stage_name?: string; status?: StageStatus; output_inline?: string;
  error_code?: string; error_message?: string; snapshot_id?: string; rollback_result?: 'succeeded' | 'failed'; observed_at: string; }

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['success', 'failed', 'cancelled', 'requires_manual_recovery']);
```
- [ ] **Step 2: Failing test — create + get + CAS transition.** In `store.test.ts` (model on `src/__tests__/api/heartbeat.test.ts` for the store/dir setup):
```ts
it('creates a queued task and reads it back', () => {
  const t = store.create({ operation_kind: 'reference.echo', principal: 'admin:test', client_type: 'rest', request_id: 'r1', affected_resources: [{ kind: 'Reference', id: 'x' }] });
  expect(t.state).toBe('queued'); expect(t.dispatch_state).toBe('queued'); expect(t.last_event_sequence).toBe(0);
  expect(store.get(t.task_id)?.task_id).toBe(t.task_id);
});
it('transitions state via CAS and rejects a stale expected_revision', () => {
  const t = store.create({ operation_kind: 'reference.echo', principal: 'p', client_type: 'rest', request_id: 'r', affected_resources: [] });
  const ok = store.transition(t.task_id, { state: 'running', dispatch_state: 'begin_accepted' });
  expect(ok.state).toBe('running');
  expect(() => store.transitionCas(t.task_id, 999, { state: 'success' })).toThrow(/revision/i);
});
```
- [ ] **Step 3: Run — fails** (no store). `npx vitest run src/__tests__/api/tasks/store.test.ts`.
- [ ] **Step 4: Implement `TaskStore`** in `store.ts`: `create(input)` (writes `/xinas/v1/tasks/<uuid>` with `state:'queued', dispatch_state:'queued', dispatch_attempts:0, last_event_sequence:0, rollback_attempted:false, stages:[]`, timestamps from an injected `now()`), `get(id)`, `list(filter)`, `transition(id, patch)` (read row → merge → CAS put with the row's current revision; set `terminal_at` when entering a `TERMINAL_STATES` value), `transitionCas(id, expectedRev, patch)` (CAS against a caller-supplied revision; throw `ApiException('PRECONDITION_FAILED', …)` on mismatch), `appendEvent(event)` (CAS-put `/xinas/v1/task_events/<id>/<seq padded>`; bump `last_event_sequence`). Inject `now: () => string` so tests are deterministic (no `Date.now()` in the module — pass a clock).
- [ ] **Step 5: Run — passes.**
- [ ] **Step 6: Commit** (`git add` the two source files + test): `feat(api): T1 — task store + dual state machines + event log`.

---

## Task T2: Lock leases + idempotency + atomic apply transaction

**Files:**
- Create: `xiNAS-MCP/src/api/tasks/locks.ts`, `xiNAS-MCP/src/api/tasks/idempotency.ts`, `xiNAS-MCP/src/api/tasks/apply.ts`
- Test: `xiNAS-MCP/src/__tests__/api/tasks/locks.test.ts`, `.../idempotency.test.ts`, `.../apply.test.ts`

- [ ] **Step 1: Lease types + test.** `LockLease = { task_id, owner, acquired_at, expires_at, heartbeat_at }`. Test: acquire a free resource lease succeeds; acquiring a **live** held lease throws `ApiException('LOCK_HELD',…)`; acquiring an **expired** lease succeeds (steals); `classify(lease, now)` returns `'live'|'expired'`; `release` deletes the row.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: `LockManager`** in `locks.ts`: `acquireResource(tx, kind, id, lease)`, `acquireGlobalSerialize(tx, lease)` (key `/xinas/v1/locks/global/serialize`), `release(tx, key)`, `heartbeat(id…)`, `classify(lease, nowMs)`. All take a `KvTransaction` so they compose into the apply txn. Inject clock + `leaseTtlMs` (default 300_000) / `heartbeatMs` (30_000).
- [ ] **Step 4: Idempotency test + impl.** `IdempotencyStore.checkOrReserve(tx, key, plan_hash, task_id)` → `{ status: 'fresh' }` (reserved) | `{ status: 'duplicate', task_id }` (same key+plan_hash) | throws `ApiException('IDEMPOTENCY_KEY_REUSED',…)` (same key, different plan_hash). Stores `/xinas/v1/idempotency/<key>`.
- [ ] **Step 5: Atomic apply txn test + impl.** `applyTransaction(ctx, { plan, applyReq, principal, … })` opens ONE `kv.transaction` that: (1) idempotency check (return original task on duplicate); (2) freshness: desired revision ≠ `plan.state_revision_expected` → `PRECONDITION_FAILED`; observed revision stale beyond plan rule → `PLAN_STALE`; (3) acquire resource lease(s) + global serialize lease; (4) `store.create` the Task (`queued`) **inside the txn**; (5) reserve idempotency entry. Returns the created Task. Test the happy path, the duplicate-returns-original path, the conflict (LOCK_HELD / IDEMPOTENCY_KEY_REUSED / PLAN_STALE) paths, and that **nothing is written** when any check fails (rollback — assert the KV has no task/lease/idempotency rows).
- [ ] **Step 6: Run all three — pass.**
- [ ] **Step 7: Commit:** `feat(api): T2 — lock leases + idempotency + atomic apply transaction`.

---

## Task T3: Plan engine + reference provider

**Files:**
- Create: `xiNAS-MCP/src/api/plan/engine.ts`, `xiNAS-MCP/src/api/plan/providers/reference.ts`
- Test: `xiNAS-MCP/src/__tests__/api/plan/engine.test.ts`

- [ ] **Step 1: Interfaces + test.** `PlanProvider = { operation_kind: string; preflight(ctx, spec): Promise<PlanResult> }` where `PlanResult = { affected_resources, blockers, warnings, diff, risk_level, rollback_model, state_revision_expected, observed_revision_expected?, observed_at? }`. `PlanEngine.register(provider)`, `PlanEngine.plan(operation_kind, spec, idempotency_key?)` → `Plan` with a deterministic `plan_id` (uuid) + `plan_hash` (sha256 over canonicalized `{operation_kind, spec, affected_resources, diff, state_revision_expected, observed_revision_expected}`). Test: registering + planning the reference kind returns a stable `plan_hash` for identical inputs and a different hash when the spec changes; unknown kind → `ApiException('UNSUPPORTED'…)`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement `PlanEngine`** (registry map; canonical-JSON hash via a small stable-stringify helper — sort keys) and `referencePlanProvider` (diff = the echoed spec; `risk_level: 'non_disruptive'`; reads the reference desired/observed revision from KV to stamp freshness).
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit:** `feat(api): T3 — plan engine + reference provider (deterministic plan_hash + freshness)`.

---

## Task T4: Reference mutating route (plan + apply)

**Files:**
- Create: `xiNAS-MCP/src/api/agent-client.ts`
- Create: `xiNAS-MCP/src/api/routes/reference.ts` (the reference resource's `POST /api/v1/reference` plan/apply endpoint)
- Modify: `xiNAS-MCP/src/api/app.ts` (mount the route)
- Test: `xiNAS-MCP/src/__tests__/api/routes-reference.test.ts`

- [ ] **Step 1: agent-client.** Generalize `createAgentHealthProbe` into `createAgentRpcClient(socketPath)` exposing `call(method, params, timeoutMs)` → result | throws (mapping JSON-RPC error). `task.begin`/`cancel`/`list_inflight` go through it. Unit-test against a mock UDS server (reuse the `buildTestAppWithMockAgent` pattern).
- [ ] **Step 2: Route test (plan).** `POST /api/v1/reference` with `{mode:'plan', spec:{...}}` → 200 + `result.plan_id` + `plan_hash` + `risk_level`. `mode:'apply'` with a valid `plan_id`+`expected_revision`+`idempotency_key`, agent accepting (mock returns an `agent_acceptance_id`) → **202** + `result.task_id`, task `dispatch_state:'begin_accepted'`, `state:'running'`. Agent unavailable → task `failed (FAILED_BEFORE_CHANGE)`, leases released, **503**. Duplicate idempotency key+same plan → 202 with the **same** task_id, no second `task.begin`.
- [ ] **Step 3: Run — fails.**
- [ ] **Step 4: Implement the route:** plan-mode → `PlanEngine.plan` + cache the plan (KV `/xinas/v1/plans/<plan_id>`); apply-mode → `applyTransaction` then `Dispatcher.dispatch(task)` (T9 provides the full Dispatcher; for T4 inline a minimal dispatch: set `begin_sent`, `agent.call('task.begin', …)`, on success `begin_accepted`/`running` + 202, on failure terminal+release+error). Use `sendOk`/`ApiException`.
- [ ] **Step 5: Run — passes.**
- [ ] **Step 6: Commit:** `feat(api): T4 — reference plan/apply route + agent rpc client (atomic apply, 202-on-accept)`.

---

## Task T5: Progress receiver skeleton (`/internal/v1/task_progress`)

**Files:**
- Create: `xiNAS-MCP/src/api/tasks/progress.ts`
- Modify: `xiNAS-MCP/src/api/internal/` router registration + `app.ts`
- Test: `xiNAS-MCP/src/__tests__/api/internal-task-progress.test.ts`

- [ ] **Step 1: Test (taxonomy + monotonic + CAS).** Mounted under `requireInternalAgent` (reuse H2). Posting `accepted` then `stage_started`(seq2) then `stage_succeeded`(seq3) updates the Task + appends 3 event-log rows; posting a **duplicate** seq (≤ `last_event_sequence`) is a 200 no-op (idempotent); a `terminal` event with `state:'success'` sets the task terminal, writes `snapshot_after`, releases leases. Unknown `event_type` → 400 `INVALID_ARGUMENT`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `taskProgressHandler(ctx)`: validate `event_type` ∈ taxonomy + `controller_id`/`task_id` present; if `sequence ≤ task.last_event_sequence` → 200 no-op; else single KV txn: append `TaskEvent`, apply the event to the rolled-up Task (stage upsert / state transition / snapshot fields / rollback fields — table per event_type), bump `last_event_sequence` + lease `heartbeat_at`; on `terminal` release leases. Then `ctx.taskWatch?.notify(task_id, event)` (T8 fan-out; optional in T5). Authoritative writes only — agent-reported facts.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit:** `feat(api): T5 — task_progress receiver (taxonomy + monotonic CAS + event log)`.

---

## Task T6: Agent task runner + reference executor + xinas_history bridge

**Files:**
- Create: `xiNAS-MCP/src/agent/task/types.ts`, `registry.ts`, `reference-executor.ts`, `xinas-history-bridge.ts`, `progress-publisher.ts`, `runner.ts`
- Test: `xiNAS-MCP/src/__tests__/agent/task/runner.test.ts`, `.../xinas-history-bridge.test.ts`, `.../reference-executor.test.ts`

- [ ] **Step 1: Bridge test (mock subprocess).** `XinasHistoryBridge.snapshotCreate(operation, source)` → `{ snapshot_id }`; `.rollback(snapshot_id)` → `{ ok }`. Inject a `runSubprocess(argv): Promise<{stdout,code}>` so tests mock `python3 -m xinas_history` JSON output; a non-zero exit → throws.
- [ ] **Step 2: Implement bridge** (argv builder + JSON parse + error map), reusing the config-history subprocess protocol shape from `docs/MCP/spec-config-history.md`.
- [ ] **Step 3: Executor interface + reference executor + test.** `Executor = { operation_kind; stages: ExecutorStage[] }`, `ExecutorStage = { name; run(ctx): Promise<void> }`. `referenceExecutor`: stages `preflight`/`apply`/`verify`, each a no-op that records output; honors `ctx.spec.fail_at_stage` (throw in that stage to drive rollback). Test the success path and the `fail_at_stage:'apply'` path (throws at apply).
- [ ] **Step 4: Runner test.** `TaskRunner.run(beginParams)` orchestrates: emit `accepted`; `snapshotCreate` (snapshot_before); for each stage emit `stage_started`→run→`stage_succeeded`/`stage_failed`; on stage failure → `rollback` (emit `rollback_started`→`rollback_succeeded`/`rollback_failed`) then `terminal` with `failed`+`FAILED_PARTIAL_ROLLED_BACK`; on success → `snapshotCreate` (snapshot_after) + `terminal` `success`. Each emit goes through an injected `publish(event)` (mock in test); assert the exact event sequence + monotonic `sequence`. Maintain an in-flight registry (`Map<task_id, {acceptance_id, …}>`) for `list_inflight`.
- [ ] **Step 5: Implement** the publisher (push to api, retry like the observation Publisher) + runner. Run tests — pass.
- [ ] **Step 6: Commit:** `feat(agent): T6 — task runner + reference executor + xinas_history bridge`.

---

## Task T7: Agent task RPCs + wire into agent-server

**Files:**
- Create: `xiNAS-MCP/src/agent/rpc/methods/task.ts`
- Modify: `xiNAS-MCP/src/agent-server.ts` (register `task.begin`/`cancel`/`list_inflight`; remove their entries from `STUB_METHODS` merge)
- Test: `xiNAS-MCP/src/__tests__/agent/rpc/methods/task.test.ts`

- [ ] **Step 1: Test — idempotent begin.** `task.begin({task_id, operation_kind, spec, plan})` returns `{ accepted: true, agent_acceptance_id }` and starts the runner in the background; calling `task.begin` **again with the same task_id** returns the **same** `agent_acceptance_id` and does NOT start a second run. `task.list_inflight()` returns the running task. `task.cancel({task_id})` at a safe point returns `{ cancel_requested: true }`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `makeTaskHandlers({ runner, registry })`: `begin` checks the in-flight registry by `task_id` (idempotent), else generates `agent_acceptance_id`, registers, and `void runner.run(...)` (fire-and-forget, errors absorbed → reported as `terminal failed`); `list_inflight` returns the registry snapshot; `cancel` sets a cancel flag the runner checks between stages. Wire into the dispatcher map in `agent-server.ts` ahead of `STUB_METHODS` (so these win over any stub).
- [ ] **Step 4: Run — passes.** Also re-run `stubs.test.ts` (begin/cancel/list_inflight may still be in the stub list as fallback — ensure the real handlers override; if the registry asserts them as stubs, update that test to reflect they are now real).
- [ ] **Step 5: Commit:** `feat(agent): T7 — task.begin/cancel/list_inflight (idempotent begin) wired into agent-server`.

---

## Task T8: Resumable SSE watch + tasks metadata fold-in

**Files:**
- Create: `xiNAS-MCP/src/api/tasks/watch.ts`
- Modify: `xiNAS-MCP/src/api/routes/tasks.ts` (real `/tasks/{id}/watch`; `embedMetadata` on `/tasks` + `/tasks/{id}`)
- Test: `xiNAS-MCP/src/__tests__/api/tasks-watch.test.ts`

- [ ] **Step 1: Test.** `GET /tasks/{id}/watch` with no `Last-Event-ID` first sends the current Task snapshot, then live events as `progress.notify` fires. With `Last-Event-ID: 2` it **replays** event-log rows with `sequence > 2` from the store before attaching live. `GET /tasks` returns each task with a synthesized `metadata` (reuse `read-metadata.test.ts` shape).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `TaskWatch` (an in-memory `Map<task_id, Set<res>>` fan-out + `notify(task_id, event)`); the route: parse `Last-Event-ID`, replay missing events from `/xinas/v1/task_events/<id>/`, subscribe, stream `id: <sequence>\ndata: <json>\n\n`. Update `tasks.ts` list/get to use `embedMetadata`/`unwrapResources`. Wire `ctx.taskWatch` into the progress receiver's `notify`.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit:** `feat(api): T8 — resumable task watch (SSE) + tasks metadata fold-in`.

---

## Task T9: Dispatcher reconcile / orphan recovery

**Files:**
- Modify: `xiNAS-MCP/src/api/tasks/dispatcher.ts` (full `Dispatcher` incl. `reconcile()`)
- Modify: `xiNAS-MCP/src/api/server.ts` / `api-server.ts` (call `reconcile()` on startup + on agent reconnect)
- Test: `xiNAS-MCP/src/__tests__/api/dispatcher-reconcile.test.ts`

- [ ] **Step 1: Test (the §9 table).** Seed non-terminal tasks + leases in KV; mock the agent's `task.list_inflight`. Assert: `dispatch_state:'queued'` + not inflight → re-dispatched (or `failed FAILED_BEFORE_CHANGE` per the chosen policy const); `'begin_sent'` + inflight(matching) → `begin_accepted`/`running`; `'begin_sent'` + not inflight → re-dispatch; `'begin_accepted'` + not inflight + **expired** lease → `requires_manual_recovery (FAILED_MANUAL_RECOVERY_REQUIRED)`; `'begin_accepted'` + inflight → left running.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** `Dispatcher.reconcile()`: list non-terminal tasks; fetch the agent in-flight set once (`agent-client.task.list_inflight`); for each task apply the §9 decision table (re-dispatch reuses `dispatch()`, which is safe because `task.begin` is idempotent by `task_id`). Wire a single `reconcile()` call at api startup after the tracker connects + on the heartbeat `offline→healthy` transition.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit:** `feat(api): T9 — dispatcher reconcile / orphan recovery (dispatch_state + leases)`.

---

## Task T10: End-to-end suite

**Files:**
- Create: `xiNAS-MCP/src/__tests__/e2e/task-engine-roundtrip.test.ts`
- Modify: `xiNAS-MCP/vitest.e2e.config.ts` (already includes `e2e/`)

- [ ] **Step 1: e2e — success path.** Boot a real api + a real agent (fixture/probe mode like `agent-api-roundtrip.test.ts`, with a fake `python3 -m xinas_history` shim on PATH or an injected bridge subprocess). `POST /api/v1/reference {mode:plan}` → `POST {mode:apply}` → poll `/tasks/{id}` until terminal → assert `state:'success'`, `snapshot_before`/`snapshot_after` set, the event log has `accepted…terminal`.
- [ ] **Step 2: e2e — failure → rollback.** Apply with `spec.fail_at_stage:'apply'` → poll → assert `state:'failed'`, `error_code:'FAILED_PARTIAL_ROLLED_BACK'`, `rollback_attempted:true`, `rollback_result:'succeeded'`, and a `rollback_succeeded` event.
- [ ] **Step 3: e2e — idempotency conflict.** Apply key `K`+plan `P1` (202), then apply key `K`+plan `P2` (different `plan_hash`) → **409 `IDEMPOTENCY_KEY_REUSED`**; re-apply key `K`+plan `P1` → 202 same `task_id`.
- [ ] **Step 4: e2e — crash/reconcile shape (simulated).** Directly seed a `dispatch_state:'queued'` task + lease in KV (no agent inflight), call `Dispatcher.reconcile()`, assert the task becomes re-dispatched/rejected per the documented rule and the lease is consistent.
- [ ] **Step 5: Run** `npm run test:e2e` — all pass; `npm test` (unit) still green; `npx tsc --noEmit`; `npm run lint`.
- [ ] **Step 6: Commit:** `test(e2e): T10 — task engine round-trip (success, rollback, idempotency-conflict, reconcile)`.

---

## Self-review notes (gaps to watch during execution)

- **Spec coverage:** T0→§12, T1→§3.1/§3.5/§4, T2→§3.2/§3.3/§3.4/§5.2, T3→§5.1, T4→§5.2, T5→§6, T6→§7/§8, T7→§4.2/§9-begin, T8→§3.1-metadata/§10, T9→§9, T10→§13. All spec sections mapped.
- **`now()`/randomness:** never call `Date.now()`/`Math.random()` directly in engine modules — inject a clock + id generator so tests are deterministic (matches the S0/S1 HeartbeatTracker pattern).
- **CAS everywhere:** every Task write in T1/T5/T9 is a compare-and-swap; concurrent progress + reconcile must not clobber (retry-on-PRECONDITION_FAILED loop in the store).
- **Requires-Rebuild:** none of T0–T10 touch Ansible roles (pure TS + docs), so **no `Requires-Rebuild` trailer** on these commits.
- **Rollout:** stack as operator-gated draft PRs (one per task or small groups), exactly as S0/S1; never merge without approval.
