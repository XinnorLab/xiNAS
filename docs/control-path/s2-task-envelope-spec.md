# xiNAS S2 — Task envelope + plan/apply engine (design spec)

**Status:** design (brainstormed 2026-06-04; revised after review to align with the accepted **ADR-0004**). Successor to the S0/S1 control-path foundation (landed on `main`). Implementation plan: `docs/plans/2026-06-04-s2-task-envelope-plan.md`.

**Goal.** Turn the read-only S0/S1 control plane into a *mutating* one: every mutating API operation runs through a durable **plan/apply** + **task** engine with per-resource leases, idempotency, before/after config snapshots, and executor-provided rollback — proven end-to-end now through a built-in **reference executor**, with real OS executors (xiRAID / fs / nfs / netplan) plugging into the same engine in their own later work packages (S3–S6).

**Authoritative prior art (this revision conforms to it).** ADR-0004 (Task engine, **Accepted**) already decides the persistence model, and the code already exists:
- `tasks` / `task_stages` / `leases` SQLite tables — `xiNAS-MCP/src/state/migrations/001-initial.sql`.
- `LeaseManager` — `xiNAS-MCP/src/state/leases.ts` (acquire via `INSERT … ON CONFLICT`, heartbeat, release, `sweepExpired` → `requires_manual_recovery`).
- `Task` / `TaskStage` schemas + the mutating-endpoint plan/apply contract — `docs/control-path/api-v1.yaml`.

**This spec does NOT invent a parallel KV store, a global serialize lease, or new error codes.** It implements ADR-0004 and reuses the existing tables, `LeaseManager`, and the `CONFLICT`/`PRECONDITION_FAILED` error codes.

**Architecture base (approved).** The S0/S1 privilege boundary is kept: **api (unprivileged) owns durable control-plane state** (the SQLite DB — sole writer per ADR-0002); **agent (root) owns privileged execution and reports facts back**. The task engine is an in-process module of `xinas-api` using the same `xinas.db`.

---

## 1. Scope

### In scope (S2)
- The resource-agnostic **plan engine** (deterministic preflight → a `plan_only` task row) with a `PlanProvider` registry.
- The **Task engine** over the existing `tasks` + `task_stages` SQLite tables: lifecycle state machine, stage rows with **hybrid log spill** (inline ≤64 KiB / `/var/log/xinas/tasks/<id>/stage-<n>.log.zst`).
- **Leases** via the existing `LeaseManager`; **idempotency** via the existing `UNIQUE(idempotency_key, principal)` constraint.
- A **bounded worker pool** (ADR-0004 model; S2 shipped an uncapped inline dispatcher; **S2.1 graduates it to the hybrid-admission pool in §5.3** — default cap 4, configurable; leases serialize contended resources).
- The **agent task executor** + **reference executor** (with an executor-provided `rollback()`) + the **xinas_history snapshot bridge** for real `snapshot_before/after` capture.
- The agent↔api **progress push** (`POST /internal/v1/task_progress`) applied to `tasks`/`task_stages`; **resumable SSE** `/tasks/{id}/watch`; tasks **metadata fold-in**; **startup reconciliation**.
- **Contract revisions** to `api-v1.yaml`, `ADR-0002`, and this spec (incl. removing the `task.*` methods from `STUB_METHODS`).

### Out of scope (deferred)
- **Real OS executors** — xiRAID `arrays.*` (S3/WS5), `fs.*` (S4/WS6), `nfs.*` (S5/WS7), `network.*` (S6/WS8). They register their own `Executor` (incl. operation-specific `rollback()`) into this engine later; their mutating routes stay `executorUnavailable` until then.
- **Arbitrary snapshot-restore** in xinas_history. The engine only has `reset-to-baseline` + an internal auto-rollback; S2 captures `snapshot_before/after` for audit/diff and relies on **executor-provided rollback**. File-level snapshot-rollback lands when the first file-based executor (S5 nfs) needs it.
- ~~**Worker pool cap > 1.**~~ Graduated in **S2.1** (§5.3): hybrid-admission pool, default cap 4. **Per-kind quotas remain deferred** (no second executor family needs them yet; the admission point in §5.3 is where they slot in).

---

## 2. Privilege split & component map

```
            REST (plan/apply, /tasks, /tasks/{id}/watch)
                              │
   api (unprivileged)         ▼                          agent (root)
   ┌──────────────────────────────────────┐    UDS      ┌────────────────────────────┐
   │ plan/engine.ts + plan/providers/*     │  api→agent  │ rpc/methods/task.ts        │
   │ tasks/store.ts  (tasks + task_stages) │ ─task.begin→│  begin / cancel / list_inflight │
   │ tasks/engine.ts (worker pool cap=1,   │             │ task/runner.ts             │
   │   apply txn, dispatch, reconcile)     │             │  + task/registry.ts        │
   │ state/leases.ts  LeaseManager (EXISTS)│ ←progress── │  + task/reference-executor.ts │
   │ tasks/progress.ts (/internal push rx) │  agent→api  │ task/progress-publisher.ts │
   │ tasks/watch.ts  (resumable SSE)       │             │ task/xinas-history-bridge.ts│
   └──────────────────────────────────────┘             └──────────────┬─────────────┘
                                                                        │ subprocess (snapshot create --format json)
                                                            python3 -m xinas_history
```

- **api side** (`xiNAS-MCP/src/api/`): `plan/engine.ts`, `plan/providers/reference.ts`, `tasks/store.ts` (Task + TaskStage CRUD over SQLite), `tasks/engine.ts` (worker pool + apply transaction + dispatch + reconcile), `tasks/progress.ts`, `tasks/watch.ts`, `agent-client.ts`. **Reuses** `state/leases.ts` (`LeaseManager`).
- **agent side** (`xiNAS-MCP/src/agent/`): `task/runner.ts`, `task/registry.ts`, `task/reference-executor.ts`, `task/xinas-history-bridge.ts`, `task/progress-publisher.ts`, `rpc/methods/task.ts`.

---

## 3. Data model — the ADR-0004 SQLite tables (existing)

All in `xinas.db`. The api is the sole writer; the apply path uses a single SQLite transaction.

### 3.1 `tasks` (existing migration; columns added in S2)
Columns per ADR-0004 §`tasks table` / `001-initial.sql`: `task_id` (uuid), `kind` (**the operation kind**, e.g. `reference.echo`/`share.create`), `state`, `plan_id`, `idempotency_key`, `principal`, `client_type`, `request_id`, `correlation_id`, `input_hash`, `plan_hash`, `result_hash`, `state_revision_expected`, `state_revision_at_apply`, `risk_level`, `affected_resources` (JSON), `snapshot_before`, `snapshot_after`, `cancel_requested_at`, `cancel_refused_reason`, `error_code`, `error_message`, `remediation_hint`, `created_at`, `updated_at`, `terminal_at`. `UNIQUE(idempotency_key, principal)` enforces idempotency.

**S2 adds columns** (ADR-0004 permits minor additions):
- migration `002`: `agent_acceptance_id TEXT` — the idempotent-begin correlation token (null until the agent accepts). This + `state` is all reconcile needs (§9); **no separate dispatch state machine**.
- migration `003`: `spec TEXT` (JSON) — the **raw operation spec** the requester submitted at plan time (`reference.echo`'s `{ message?, fail_at_stage? }`; a real executor's full input). It is persisted on the `plan_only` task and copied onto the apply task, then **forwarded verbatim to the agent** as the `task.begin` `spec` (and by reconcile re-dispatch, §9). `affected_resources` is the *lock set*, NOT the executor input — the two are distinct, so the spec is carried explicitly rather than reusing `affected_resources`. Null only for legacy rows / tasks created before 003. **Internal-only:** `spec` is NOT part of the public `Task` surface in api-v1.yaml — the read renderer (`GET /tasks`, `GET /tasks/{id}`) and the SSE watch snapshot frame (§10) both strip it, so a requester's operation input is never echoed back over a read endpoint.

### 3.2 `task_stages` (existing) — hybrid log spill
Per ADR-0004: `stage_id`, `task_id`, `stage_index`, `name` (`preflight`/`snapshot_before`/`apply`/`verify`/`rollback`/`snapshot_after`), `status`, `started_at`, `ended_at`, `output_inline` (BLOB, ≤64 KiB), `output_path` (relative, when spilled), `output_size_bytes` (**required**), `error_code`, `error_message`. The progress push (§6) writes/updates these rows; SSE resume **resyncs** from the rolled-up Task snapshot built over them (§10), not from a per-event log. This **replaces** the KV "event log" from the pre-review draft.

### 3.3 `leases` (existing) — via `LeaseManager`
Per ADR-0004 / `leases.ts`: `lease_id`, `resource_kind`, `resource_id`, `task_id`, `acquired_at`, `ttl_seconds`, `heartbeat_at`, `UNIQUE(resource_kind, resource_id)`. **No global serialize lease** — the worker pool cap=1 + per-resource leases are the serialization. Acquisition is `LeaseManager.acquire()` (INSERT-on-conflict → `held_by_other` with the holder `task_id`). Stale recovery is `LeaseManager.sweepExpired()` (already → `requires_manual_recovery`).

### 3.4 Idempotency
No separate map. The `UNIQUE(idempotency_key, principal)` constraint makes a retry's INSERT fail; the engine catches the conflict, reads the existing row, and returns it — **same `task_id`**. A different `plan_hash`/`input_hash` for the same key → the engine returns `CONFLICT` (§11).

---

## 4. State machine (ADR-0004 lifecycle)

```
plan_only         (mode=plan: a row that executes no privileged work; stages preflight + plan_render)

queued ──begin accepted──▶ running ──all stages ok──────────────▶ success
   │                          │
   │                          ├──stage fail + executor rollback ok──▶ failed (FAILED_PARTIAL_ROLLED_BACK)
   │                          ├──stage fail + rollback impossible──▶ requires_manual_recovery (FAILED_MANUAL_RECOVERY_REQUIRED)
   │                          └──cancel at safe point──────────────▶ cancelled
   └──begin rejected (no host change yet)────────────────────────▶ failed (FAILED_BEFORE_CHANGE)
```
`imported` (ADR-0004): synthetic tasks for pre-existing snapshots — not built in S2 (WS9), noted for completeness.

**Cancel arrow (S10, ADR-0012):** "cancel at safe point" means the runner
stopped before an executor stage AND ran the executor's `rollback()`
(best-effort) — `cancelled` implies the partial work was unwound, mirroring
the receiver's Model R desired-intent revert. Full semantics in §16.

**Dispatch tracking (no second SM):** apply inserts the task `queued` (+ leases + revision check, atomically); the engine then sends `task.begin`; accept → `running` + store `agent_acceptance_id`; reject → `failed (FAILED_BEFORE_CHANGE)` + release leases. Reconcile (§9) reads `(state, agent_acceptance_id, agent inflight set)`.

---

## 5. Plan / apply flow

### 5.1 Plan (`mode=plan`)
A `PlanProvider.preflight` computes `affected_resources`, `blockers`, `warnings`, `diff`, `risk_level`, `rollback_model`, `state_revision_expected`, and **observation freshness** (`observed_revision_expected` + `observed_at`). The engine writes a **`state=plan_only` task row** with `plan_hash` (sha256 over canonicalized inputs), the **raw `spec`** (persisted so apply/dispatch can forward it to the executor), and returns it (the `task_id` is the `plan_id` for apply). Stages limited to `preflight` + `plan_render`.

### 5.2 Apply (`mode=apply`) — one SQLite transaction
1. Validate `plan_id` + `idempotency_key`; look up the `plan_only` task; recompute `input_hash`.
2. **Single `db.transaction`:**
   - Idempotency: attempt the task INSERT; `UNIQUE(idempotency_key, principal)` conflict → read & return the existing task (same key+plan) or `CONFLICT` (same key, different `input_hash`/`plan_hash`).
   - Freshness (TOCTOU guard, ADR-0004 §Plan/apply binding): for each affected resource, current revision == `state_revision_expected` else `PRECONDITION_FAILED` (stale list in details); observed snapshot stale beyond the plan rule → `CONFLICT` (`details.reason: "plan_stale"`).
   - Leases: `LeaseManager.acquire()` each affected resource; `held_by_other` → `CONFLICT` (`details.reason: "lease_held"`, `holder_task_id`).
   - Insert the Task (`state: queued`, `state_revision_at_apply`, and the `spec` copied from the `plan_only` task).
3. **Pool admission + dispatch** (`tasks/engine.ts`, §5.3): if an in-flight slot is free, send api→agent `task.begin(task_id, kind, spec, plan)` — `spec` is the task's persisted raw spec (the executor input, e.g. `reference.echo`'s `{ message?, fail_at_stage? }`), NOT `affected_resources`. Accept → `running` + `agent_acceptance_id`, return **202 + Task**; unavailable/`EXECUTOR_UNSUPPORTED` → `failed (FAILED_BEFORE_CHANGE)` + release leases, return `503`/`422`. Never an orphan. **Pool full → no dispatch**: return **202 + Task in `state: queued`**; the drainer (§5.3) dispatches it FIFO when a slot frees. A pool-queued task already holds its leases, so conflicting applies still get `CONFLICT lease_held`.
4. The **reconciler** (§9) is the durable backstop for a crash before a recorded outcome.

### 5.3 Worker pool (S2.1 graduation — hybrid admission, ADR-0004 §Concurrency model)

The pool bounds **concurrently in-flight tasks end-to-end** (dispatch → terminal), not just concurrent `task.begin` RPCs. It is an api-side admission gate in `tasks/engine.ts`; the agent stays cap-unaware.

- **Cap.** `ApiConfig.tasks?: { max_inflight?: number }`, default **4** (ADR-0004). Values `< 1` are a config error (reject at load, same as other `ApiConfig` validation). Per-kind quotas: deferred (see §1).
- **In-flight accounting (stateless + reservation).** in_flight = `COUNT(tasks WHERE state = 'running')` (the api is the DB's single writer) **plus** an in-memory *dispatch-reservation* counter covering the async window where `task.begin` is awaited while the row is still `queued`. The reservation is incremented **synchronously at admission** (before any `await`, so concurrent applies cannot double-admit past the cap in Node's single thread) and released when the dispatch settles (accepted → the row is `running` and counted by the query; rejected → `failBeforeChange` already recorded). Reservations are not persisted: on crash they vanish and DB truth + reconcile (§9) recover.
- **Admission (hybrid).** `applyMode` runs the apply transaction exactly as in §5.2, then: slot free → reserve + dispatch inline (unchanged fast path, 202 `running`); pool full → skip dispatch, return 202 `queued`. No HTTP request ever blocks waiting for a slot. An idempotent replay of a task whose original dispatch is still mid-flight (reservation held) is returned as-is (202 `queued`) — never admitted a second time.
- **Drainer.** `drainQueued()`: while a slot is free, pick the oldest never-dispatched `queued` task (`created_at` ASC, `task_id` tiebreak; `agent_acceptance_id IS NULL`) and dispatch it via the reconciler's `rebuildDispatchInputs` mechanic. A dispatch failure (`failBeforeChange` fails the task + releases leases) does not abort the drain — continue to the next queued task. With no agent RPC client configured the drain is a no-op (queued tasks are left queued, mirroring §9's agent-unreachable rule — never mass-failed). Triggered after (a) any terminal transition recorded by the progress path, (b) any `failBeforeChange` on the inline-dispatch path, and (c) the end of a `reconcile()` pass (which agent reconnect already triggers). No timer: a queued task waits at most until the next slot-freeing event or reconcile.
- **Reconcile interplay (§9).** With the pool, `queued` is a *legitimate steady state*, not only crash residue. The default `redispatch` policy therefore drains queued tasks oldest-first **up to the available slots** and leaves the remainder `queued` (counted in the reconcile outcome's `left_queued`, not failed). The explicit `fail` policy keeps its existing semantics (fail **all** queued tasks) as an operator escape hatch.
- **Observability.** No schema change and no new public fields: clients see `state: queued` in the 202 body and the `queued → running` transition on `/tasks/{id}/watch` like any other state change.

---

## 6. Progress push (agent→api) — applied to `tasks`/`task_stages`

`POST /internal/v1/task_progress` (Bearer agent-token; mirrors `/internal/v1/observed`; under `requireInternalAgent`). **Replaces** the reserved `task.stage_report` RPC (removed in T0).

**Event** `{ task_id, sequence, event_type, stage_index?, stage_name?, status?, output_inline?, output_size_bytes?, error_code?, error_message?, snapshot_id?, observed_at }`, `event_type ∈ accepted | stage_started | stage_succeeded | stage_failed | rollback_started | rollback_succeeded | rollback_failed | terminal`.

**Application (the api is the sole writer of facts the agent reports):**
- **Monotonic/idempotent:** `sequence` is per-task monotonic; an event with `sequence ≤` the task's high-water mark is a 200 no-op.
- Each event upserts the relevant `task_stages` row (status/timestamps/output; spill output > 64 KiB to `/var/log/xinas/tasks/<id>/stage-<n>.log.zst`, store `output_path` + `output_size_bytes`) and/or transitions the `tasks` row (state, `snapshot_before/after`, `error_code`), and bumps the holding leases' `heartbeat_at`.
- `terminal` sets the terminal state + `result_hash` + `snapshot_after`, **releases leases**, and frees the worker slot.

### 6.1 Authoritative writes / rollback authority
The agent reports facts only. The **api writes** `snapshot_before/after`, the rollback stage outcome, and the final state. (There is no agent-written task row.)

---

## 7. xinas_history bridge & rollback model

The agent (root, TS) calls `python3 -m xinas_history` (subprocess, JSON) for **snapshot capture**:
- `snapshot_before` / `snapshot_after` = `snapshot create --source <s> --operation <op> --format json` → `{ id }`. **T6 adds `--format json` to `snapshot create`** (it does not exist today; create currently prints text).

**Rollback is executor-provided**, not a generic snapshot-restore (xinas_history has no arbitrary restore — only `reset-to-baseline` + an internal `_auto_rollback`). Each `Executor` declares `rollback(ctx)` that undoes its own change; the **reference executor's** is a trivial inverse (it is inert). Snapshots are captured for audit/diff and as the basis for file-level rollback when a file-based executor (S5 nfs) later needs it — at which point xinas_history gains an arbitrary-restore capability. S2 builds neither arbitrary-restore nor `reset-to-baseline` use.

---

## 8. Reference executor

Built-in, safe, **inert** (`kind: reference.echo`). Stages `preflight` → `apply` → `verify`, each a no-op that records output and emits the event taxonomy. `spec.fail_at_stage` forces a stage failure so the rollback path (`stage_failed` → executor `rollback()` → `rollback_succeeded` → `failed (FAILED_PARTIAL_ROLLED_BACK)`) is real and e2e-tested. It still calls the xinas_history bridge for real `snapshot_before/after` so the bridge is genuinely exercised. Its `PlanProvider` yields `risk_level: non_disruptive`, `diff` = the echoed spec.

---

## 9. Reconciliation / crash recovery (ADR-0004 model)

On api startup + on agent reconnect: `LeaseManager.sweepExpired()` first (expired leases of non-terminal tasks → `requires_manual_recovery`, already implemented). Then for each non-terminal task, decide from `(state, agent_acceptance_id, agent inflight set via task.list_inflight)`:

| state | agent_acceptance_id | inflight? | Action |
|-------|---------------------|-----------|--------|
| `queued` | null | n/a | never dispatched → re-dispatch oldest-first **up to free pool slots** (§5.3); remainder stays `queued` (or `failed FAILED_BEFORE_CHANGE` under the explicit `fail` policy, which fails all) |
| `running` | null | yes (task_id) | begin landed; confirm → store acceptance, keep running |
| `running` | null | no | begin never took → re-dispatch (safe: `task.begin` is idempotent by `task_id`) |
| `running` | set | yes | live → resume watching |
| `running` | set | no, lease live | brief grace, re-query |
| `running` | set | no, lease expired | handled by `sweepExpired` → `requires_manual_recovery` |

`task.begin` is **idempotent by `task_id`** (agent returns the same `agent_acceptance_id`), so re-dispatch never double-executes.

### S2 `TaskEngine.reconcile()` algorithm

`reconcile({ agentClient, queuedPolicy })` (an idempotent, re-entrancy-guarded method on `TaskEngine`) runs:

1. **Sweep first, always.** `LeaseManager.sweepExpired()` — expired-lease non-terminal tasks → `requires_manual_recovery (FAILED_STATE_DESYNC)`, expired leases of terminal tasks deleted. Runs even when the agent is unreachable.
2. **Fetch the agent in-flight set once** via `task.list_inflight` (a single best-effort RPC). **If the agent is unreachable** (no `agentClient`, connect-refused, or timeout) → **stop after the sweep**: leave `queued` tasks `queued` and `running` tasks untouched. They are recovered by the next reconcile — the **offline→healthy reconnect trigger** re-runs `reconcile()` once the agent is back, which is exactly when re-dispatch can succeed. Never fail a `queued` task just because the agent was momentarily down.
3. **With the in-flight set in hand**, walk the non-terminal tasks (states `queued` + `running`):
   - `running` + `agent_acceptance_id = null` + **inflight** → **adopt** the acceptance: store the `agent_acceptance_id` from the in-flight entry, keep `running`. (The agent accepted and is emitting progress; the api lost the dispatch ack across a restart.)
   - `running` + (any acceptance) + **not inflight** → **no-op in reconcile.** Running-task recovery is owned by the lease/sweep mechanism: lease still live → grace (a later sweep handles it if it expires); lease already expired → step 1 already moved it to `requires_manual_recovery`. reconcile never re-dispatches a `running` task (it may have already mutated host state).
   - `running` + acceptance set + inflight → live; leave running.
   - `queued` → never accepted, so **no host change happened** → apply `queuedPolicy`:
     - `'redispatch'` (**default**) → call `dispatch()` again. `task.begin` is idempotent by `task_id`, so a duplicate that the agent already has returns the same acceptance. Each re-dispatch is wrapped so one task's begin-failure (which `dispatch()`'s `failBeforeChange` already turns into `failed (FAILED_BEFORE_CHANGE)` + lease release) doesn't abort the rest of the sweep.
     - `'fail'` → mark `failed (FAILED_BEFORE_CHANGE)` + release leases directly; the client re-applies.

**Re-dispatch input reconstruction.** `dispatch()` needs `{ task, agentClient, spec, plan }`. Both are rebuilt from the **apply task's own columns** — no plan_only refetch: `plan` = an `ApplyPlan` projected from the apply task (`plan_id`, `kind`, `risk_level`, `affected_resources`, `plan_hash?`, `state_revision_expected?`), and `spec` = the apply task's persisted **`spec` column** (migration 003 — the same executor input the original dispatch forwarded). This works for any executor, not just the reference one.

**Triggers.** `reconcile()` is called (a) once at **api startup** after the task engine + heartbeat tracker are built (best-effort; a failure is logged, never fatal), and (b) on the **offline→healthy** edge of the `HeartbeatTracker` (including the agent's first appearance), wired via an optional `onReconnect` callback the tracker invokes when `currentState()` transitions into `healthy` from a non-healthy state. Both call the same `reconcile()`; the engine's re-entrancy guard makes an overlap a no-op.

---

## 10. SSE watch (resumable)

`GET /tasks/{id}/watch`: first send the current Task snapshot, then live events via an in-memory fan-out (`tasks/watch.ts`). Both the snapshot frame and every live frame carry the event `sequence` as the SSE `id`, so the id space is a **single, coherent event-sequence space**.

Reconnect uses a **resync**, not an event replay. The durable record is the rolled-up `task_stages` rows + `tasks` row — there is no per-event log to replay past an arbitrary sequence. So a reconnect with `Last-Event-ID: <sequence>` is handled as: if that sequence is **behind** the task's current `last_event_sequence`, re-send the current Task snapshot (which already carries every stage's latest state) keyed at `last_event_sequence`, then attach live; if it is **at/ahead of** the current sequence, send nothing and attach live directly. Reading the task and subscribing happen synchronously so no live event slips through the gap. A client that misses intermediate events still converges, because the snapshot is the full current state — it just does not see each missed transition individually.

Tasks reads (`/tasks`, `/tasks/{id}`) get the S0/S1 `embedMetadata` fold-in.

---

## 11. Error model — reuse the existing codes (no additions)

ADR-0004's prescriptions map onto the existing `ErrorCode` union (`src/api/errors.ts`):
- Stale revision → **`PRECONDITION_FAILED`** (412), stale resources in `details`.
- Lease held → **`CONFLICT`** (409), `details: { reason: "lease_held", holder_task_id }`.
- Idempotency key reused with a different plan → **`CONFLICT`** (409), `details: { reason: "idempotency_key_reused" }`.
- Plan stale (observation drift) → **`CONFLICT`** (409), `details: { reason: "plan_stale" }`.
- Agent offline → `INTERNAL` / `EXECUTOR_UNAVAILABLE`; executor unbuilt → `UNSUPPORTED` / `EXECUTOR_UNSUPPORTED`.
Task-internal `FAILED_*` codes (ADR-0004) are persisted on the task and surfaced in its record. **No new `ErrorCode` values; no `errors.ts` change.**

---

## 12. Contract revisions (T0 — all three together)

1. **`api-v1.yaml`:** add `observed_revision_expected`/`observed_at` to `Plan`; add `agent_acceptance_id` to `Task`; add `/internal/v1/task_progress` + the `TaskProgressEvent` schema (the §6 taxonomy); document the `CONFLICT` `details.reason` discriminators (`lease_held`/`idempotency_key_reused`/`plan_stale`) — **no new top-level error codes**. Strike `task.stage_report` from the agent RPC surface.
2. **`ADR-0002`:** record the task-engine split (api owns the DB + dispatch + reconcile; agent executes + reports), and the `task.stage_report` → push refinement. (Persistence is already ADR-0004; cross-link it.)
3. **This spec.** Keep all three in sync.
4. **Tests:** remove `task.begin`/`task.cancel`/`task.list_inflight`/`task.stage_report` from `STUB_METHODS` (`stubs.ts`) + `REQUIRED_STUB_METHODS` (`stubs.test.ts`) — they are no longer stubs (begin/cancel/list_inflight become real in T7; stage_report becomes the push).

---

## 13. Testing strategy

- **Unit:** `TaskStore` over SQLite (create/get/list, lifecycle transitions, stage upsert + spill cutoff); idempotency conflict → returns original / `CONFLICT`; the atomic apply txn (happy + each conflict path + full rollback on failure); `LeaseManager` reuse (acquire/conflict/sweep — light, it has its own tests); plan freshness; progress monotonic/idempotent application to `task_stages`; reference executor stage + `fail_at_stage`; xinas_history bridge (mocked subprocess, incl. the new `--format json`).
- **e2e (real agent↔api↔xinas_history with a `python3 -m xinas_history` shim):**
  1. **Success:** plan → apply → stages → `snapshot_before/after` → `success`.
  2. **Failure→rollback:** `spec.fail_at_stage:'apply'` → `stage_failed` → executor `rollback()` → `failed (FAILED_PARTIAL_ROLLED_BACK)`.
  3. **Idempotency conflict:** same key + different plan → `409 CONFLICT (idempotency_key_reused)`; re-apply same key+plan → 202 same `task_id`.
  4. **Crash/reconcile shape** (simulated): a `queued` task with no matching agent inflight task → re-dispatched/failed per the §9 rule; `sweepExpired` recovers an expired-lease running task.

---

## 14. Decomposition (T0–T10)

| # | Task |
|---|------|
| **T0** | Contract revisions (api-v1.yaml + ADR-0002 + this spec): Plan freshness, `agent_acceptance_id`, `/internal/v1/task_progress` + taxonomy, `CONFLICT.details.reason` discriminators; **remove all four `task.*` from `STUB_METHODS` + test**. Use `npm run test:contracts` to validate. |
| **T1** | `tasks/store.ts` — `TaskStore` over `tasks` + `task_stages` (better-sqlite3 prepared statements, like `LeaseManager`); migration `002` adds `agent_acceptance_id`; lifecycle transitions; stage upsert + hybrid spill. Types match api-v1.yaml (`kind`=operation kind, `output_size_bytes`). |
| **T2** | `tasks/engine.ts` apply transaction: idempotency (UNIQUE catch) + freshness (revision/observed) + `LeaseManager.acquire` + task insert, all in one `db.transaction`. Reuses the existing `LeaseManager`. |
| **T3** | `plan/engine.ts` + `plan/providers/reference.ts` (deterministic `plan_hash`, freshness; writes the `plan_only` task row). |
| **T4** | Reference mutating route `POST /api/v1/reference` (plan → plan_only row; apply → apply txn → inline dispatch → 202-on-accept / terminal-on-reject) + `agent-client.ts`. |
| **T5** | `tasks/progress.ts` — `/internal/v1/task_progress` receiver (taxonomy + monotonic + apply to `task_stages`/`tasks` + spill). *Before* the agent work so the contract target is stable. |
| **T6** | `task/runner.ts` + `task/reference-executor.ts` (with `rollback()`) + `task/xinas-history-bridge.ts`; **add `--format json` to `xinas_history snapshot create`** (Python + test). |
| **T7** | `rpc/methods/task.ts` (`begin`/`cancel`/`list_inflight`, idempotent begin) wired into `agent-server.ts` — and the four `task.*` already removed from `STUB_METHODS` in T0, so no shadowing. + `task/progress-publisher.ts`. |
| **T8** | `tasks/watch.ts` resumable SSE (resync from the current Task snapshot; single event-sequence id space) + tasks metadata fold-in. |
| **T9** | `tasks/engine.ts` reconcile + wire `LeaseManager.sweepExpired()` on startup/reconnect (§9 table). |
| **T9b** | Persist + forward the raw executor `spec`: migration `003` adds `tasks.spec TEXT`; `plan_only` stores it, apply copies it onto the apply task, dispatch + reconcile re-dispatch forward it as the `task.begin` `spec` (replaces the `affected_resources`-as-spec stopgap). Unblocks `fail_at_stage` over HTTP (§8). |
| **T10** | e2e: success · failure→rollback · idempotency-conflict (`CONFLICT`) · crash/reconcile + sweep. |

---

## 15. Open questions / risks

- **xinas_history `snapshot create` JSON output** is a real (small) Python change in T6; confirm the manifest-id field name (`Manifest.to_dict()`/`.id`).
- **Worker pool** graduated in S2.1 to the §5.3 hybrid-admission pool (default-4, `tasks.max_inflight`); per-kind quotas remain deferred until a second executor family exists.
- **`002` migration** must be additive + idempotent (`ALTER TABLE tasks ADD COLUMN agent_acceptance_id TEXT`) and respect the existing `schema_version` mechanism.

---

## 16. Cancel (S10, ADR-0012)

S2 shipped the flag plumbing (`task.cancel` RPC → runner
`cancelRequested`; `ctx.isCancelRequested()`; the receiver's
`terminal(cancelled)` handling incl. lease release + Model R revert;
the `cancel_requested_at` / `cancel_refused_reason` columns; the
OpenAPI route). S10 wires the rest: the REST route, the engine method,
and — the actual gap — the runner honoring the flag.

### 16.1 Route — `POST /api/v1/tasks/{id}/cancel`

Replaces the `executorUnavailable` stub. No request body. Sets
`rc.operation_id = task_id` (audit rows are found by
`/audit?task_id=`). Dispatch by current state:

| State | Result |
|---|---|
| unknown | 404 `NOT_FOUND` |
| `cancelled` | 200, the row as-is (idempotent) |
| `plan_only` / `imported` / `success` / `failed` / `requires_manual_recovery` | 409 `CONFLICT`, `details.reason: 'not_cancellable'` + the state |
| `queued` | engine-local cancel (§16.2) |
| `running` | forwarded cancel (§16.3) |

### 16.2 Queued cancel (engine-local)

No host work has started; the agent is not involved.

1. If the task is in `dispatchReservations` (inline dispatch
   mid-`task.begin`) → 409 `CONFLICT`
   (`details.reason: 'dispatch_in_flight'`, remediation: retry — the
   task is `running` once the begin resolves).
2. Guarded CAS flip: `TaskStore` gains a **conditional transition**
   (`UPDATE tasks SET … WHERE task_id = ? AND state = 'queued'`) — the
   unconditional `transition()` updates by id only and MUST NOT be
   used for this flip. No row changed → the drainer won the race →
   re-read and fall through to §16.3 (or 409 if now terminal).
3. On the won CAS: state `cancelled`, `cancel_requested_at` set,
   leases released, desired intent reverted (same revert the receiver
   performs for non-success terminals). 200 with the cancelled row.

The drainer needs no change: it re-picks queued tasks per iteration,
and a cancelled row has left the queued set.

### 16.3 Running cancel (forwarded)

1. Tracker offline → 500 `INTERNAL` / `EXECUTOR_UNAVAILABLE`. The
   cancel did not reach the executor; nothing durable is recorded
   (no pending-cancel queue — ADR-0012 alternatives).
2. Otherwise call the existing `task.cancel` RPC:
   - `cancel_requested: true` → write `cancel_requested_at` with a
     **state guard** (`… WHERE task_id = ? AND state = 'running'`) so
     a terminal that raced in is never clobbered or resurrected.
     Return 200 with the still-`running` row; the terminal state
     arrives via the normal progress push (poll or `/watch`).
   - `cancel_requested: false, reason: 'not_found'` → the agent does
     not have the task in flight (finished or desynced). Record
     `cancel_refused_reason: 'agent_not_found'` (same running-state
     guard) and return 409 `CONFLICT`
     (`details.reason: 'agent_not_found'`). The row stays `running`
     with refusal metadata; recovery remains with the existing
     lease-expiry/sweep path (reconcile's `running` + not-inflight
     no-op is unchanged — S10 adds no new reconcile action).

### 16.4 Runner — honoring the flag (agent)

Two rules, no new event types:

- **Boundary check:** immediately before starting each **executor**
  stage (including before stage 0, i.e. after the synthetic
  `snapshot_before`), if `cancelRequested` → emit the rollback
  taxonomy via the existing rollback machinery and terminate:
  rollback ok → `terminal(cancelled)` (no `error_code`); rollback
  threw → `terminal(requires_manual_recovery)` /
  `FAILED_MANUAL_RECOVERY_REQUIRED`. There is **no checkpoint between
  the last executor stage and `snapshot_after`/`terminal(success)`**
  — a cancel arriving after the last stage completed is ignored and
  the task finishes `success`. No `snapshot_after` on the cancelled
  path (parity with the failure path).
- **Stage-throw attribution:** a stage that throws while
  `cancelRequested` is set is attributed to the cancel: emit
  `stage_failed` (facts, incl. the real `error_message`), run
  rollback, and terminate `cancelled` (rollback ok) instead of
  `failed` — rollback throwing still yields
  `requires_manual_recovery`. This gives the existing
  `checkCancelled()` throws in the fs-create and xiraid-array-create
  executors correct semantics with zero executor changes.

Internal changes: agent `TaskTerminalState` widens with
`'cancelled'`; `#runRollback()` is parameterized on the
rollback-success terminal status (`failed` | `cancelled`) and omits
`FAILED_PARTIAL_ROLLED_BACK` for `cancelled`. The reference executor
gains an optional `spec.sleep_ms` (clamped to [0, 60_000]) so
tests/e2e have a deterministically slow, harmless task to cancel.

### 16.5 Clients

- **Catalog:** `tasks.cancel` flips to live; `min_role: operator`,
  `requires_mcp_apply: false` stay (ADR-0010 emergency stop —
  cancellation cannot apply new state). `xinasctl tasks cancel <id>`
  and the MCP tool follow from the catalog.
- **TUI:** `control_client.py` gains `cancel_task(task_id)` and
  `plan_apply_wait(..., cancel_check=…)` — polled each loop; on first
  true, the cancel is sent once and polling continues to terminal. A
  cancelled terminal raises `TaskCancelled` (subclass of
  `TaskFailed`) so screens message "operation cancelled" instead of a
  failure. The shared wait modal gets a Cancel button; the
  long-running screens (RAID create/delete, filesystem create) enable
  it.
