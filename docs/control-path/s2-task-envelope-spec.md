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
- A **bounded worker pool** (ADR-0004 model; S2 runs **cap=1**; leases serialize contended resources).
- The **agent task executor** + **reference executor** (with an executor-provided `rollback()`) + the **xinas_history snapshot bridge** for real `snapshot_before/after` capture.
- The agent↔api **progress push** (`POST /internal/v1/task_progress`) applied to `tasks`/`task_stages`; **resumable SSE** `/tasks/{id}/watch`; tasks **metadata fold-in**; **startup reconciliation**.
- **Contract revisions** to `api-v1.yaml`, `ADR-0002`, and this spec (incl. removing the `task.*` methods from `STUB_METHODS`).

### Out of scope (deferred)
- **Real OS executors** — xiRAID `arrays.*` (S3/WS5), `fs.*` (S4/WS6), `nfs.*` (S5/WS7), `network.*` (S6/WS8). They register their own `Executor` (incl. operation-specific `rollback()`) into this engine later; their mutating routes stay `executorUnavailable` until then.
- **Arbitrary snapshot-restore** in xinas_history. The engine only has `reset-to-baseline` + an internal auto-rollback; S2 captures `snapshot_before/after` for audit/diff and relies on **executor-provided rollback**. File-level snapshot-rollback lands when the first file-based executor (S5 nfs) needs it.
- **Worker pool cap > 1.** The pool + leases support it; S2 fixes cap=1.

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

### 3.1 `tasks` (existing migration; one column added in S2)
Columns per ADR-0004 §`tasks table` / `001-initial.sql`: `task_id` (uuid), `kind` (**the operation kind**, e.g. `reference.echo`/`share.create`), `state`, `plan_id`, `idempotency_key`, `principal`, `client_type`, `request_id`, `correlation_id`, `input_hash`, `plan_hash`, `result_hash`, `state_revision_expected`, `state_revision_at_apply`, `risk_level`, `affected_resources` (JSON), `snapshot_before`, `snapshot_after`, `cancel_requested_at`, `cancel_refused_reason`, `error_code`, `error_message`, `remediation_hint`, `created_at`, `updated_at`, `terminal_at`. `UNIQUE(idempotency_key, principal)` enforces idempotency.

**S2 adds one column** (ADR-0004 permits minor additions) via migration `002`: `agent_acceptance_id TEXT` — the idempotent-begin correlation token (null until the agent accepts). This + `state` is all reconcile needs (§9); **no separate dispatch state machine**.

### 3.2 `task_stages` (existing) — hybrid log spill
Per ADR-0004: `stage_id`, `task_id`, `stage_index`, `name` (`preflight`/`snapshot_before`/`apply`/`verify`/`rollback`/`snapshot_after`), `status`, `started_at`, `ended_at`, `output_inline` (BLOB, ≤64 KiB), `output_path` (relative, when spilled), `output_size_bytes` (**required**), `error_code`, `error_message`. The progress push (§6) writes/updates these rows; SSE resume replays them. This **replaces** the KV "event log" from the pre-review draft.

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

**Dispatch tracking (no second SM):** apply inserts the task `queued` (+ leases + revision check, atomically); the engine then sends `task.begin`; accept → `running` + store `agent_acceptance_id`; reject → `failed (FAILED_BEFORE_CHANGE)` + release leases. Reconcile (§9) reads `(state, agent_acceptance_id, agent inflight set)`.

---

## 5. Plan / apply flow

### 5.1 Plan (`mode=plan`)
A `PlanProvider.preflight` computes `affected_resources`, `blockers`, `warnings`, `diff`, `risk_level`, `rollback_model`, `state_revision_expected`, and **observation freshness** (`observed_revision_expected` + `observed_at`). The engine writes a **`state=plan_only` task row** with `plan_hash` (sha256 over canonicalized inputs) and returns it (the `task_id` is the `plan_id` for apply). Stages limited to `preflight` + `plan_render`.

### 5.2 Apply (`mode=apply`) — one SQLite transaction
1. Validate `plan_id` + `idempotency_key`; look up the `plan_only` task; recompute `input_hash`.
2. **Single `db.transaction`:**
   - Idempotency: attempt the task INSERT; `UNIQUE(idempotency_key, principal)` conflict → read & return the existing task (same key+plan) or `CONFLICT` (same key, different `input_hash`/`plan_hash`).
   - Freshness (TOCTOU guard, ADR-0004 §Plan/apply binding): for each affected resource, current revision == `state_revision_expected` else `PRECONDITION_FAILED` (stale list in details); observed snapshot stale beyond the plan rule → `CONFLICT` (`details.reason: "plan_stale"`).
   - Leases: `LeaseManager.acquire()` each affected resource; `held_by_other` → `CONFLICT` (`details.reason: "lease_held"`, `holder_task_id`).
   - Insert the Task (`state: queued`, `state_revision_at_apply`).
3. **Dispatch** (`tasks/engine.ts`, worker pool cap=1): send api→agent `task.begin(task_id, kind, spec, plan)`; accept → `running` + `agent_acceptance_id`, return **202 + Task**; unavailable/`EXECUTOR_UNSUPPORTED` → `failed (FAILED_BEFORE_CHANGE)` + release leases, return `503`/`422`. Never an orphan.
4. The **reconciler** (§9) is the durable backstop for a crash before a recorded outcome.

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
| `queued` | null | n/a | never dispatched → re-dispatch (or `failed FAILED_BEFORE_CHANGE` per policy) |
| `running` | null | yes (task_id) | begin landed; confirm → store acceptance, keep running |
| `running` | null | no | begin never took → re-dispatch (safe: `task.begin` is idempotent by `task_id`) |
| `running` | set | yes | live → resume watching |
| `running` | set | no, lease live | brief grace, re-query |
| `running` | set | no, lease expired | handled by `sweepExpired` → `requires_manual_recovery` |

`task.begin` is **idempotent by `task_id`** (agent returns the same `agent_acceptance_id`), so re-dispatch never double-executes.

---

## 10. SSE watch (resumable)

`GET /tasks/{id}/watch`: first send the current Task snapshot, then live events via an in-memory fan-out. Reconnect with `Last-Event-ID: <sequence>` **replays** from the `task_stages` rows + task state past that sequence before attaching to the live stream. Tasks reads (`/tasks`, `/tasks/{id}`) get the S0/S1 `embedMetadata` fold-in.

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
| **T8** | `tasks/watch.ts` resumable SSE (replay from `task_stages`) + tasks metadata fold-in. |
| **T9** | `tasks/engine.ts` reconcile + wire `LeaseManager.sweepExpired()` on startup/reconnect (§9 table). |
| **T10** | e2e: success · failure→rollback · idempotency-conflict (`CONFLICT`) · crash/reconcile + sweep. |

---

## 15. Open questions / risks

- **xinas_history `snapshot create` JSON output** is a real (small) Python change in T6; confirm the manifest-id field name (`Manifest.to_dict()`/`.id`).
- **Worker pool** is a thin cap=1 sequencer in S2 (`tasks/engine.ts`); the ADR-0004 default-4 + per-kind quotas are deferred (config).
- **`002` migration** must be additive + idempotent (`ALTER TABLE tasks ADD COLUMN agent_acceptance_id TEXT`) and respect the existing `schema_version` mechanism.
