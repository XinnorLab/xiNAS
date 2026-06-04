# xiNAS S2 — Task envelope + plan/apply engine (design spec)

**Status:** design (brainstormed 2026-06-04). Successor to the S0/S1 control-path
foundation (landed on `main`). Implementation plan: `docs/plans/2026-06-04-s2-task-envelope-plan.md` (to be written).

**Goal.** Turn the read-only S0/S1 control plane into a *mutating* one: every
mutating API operation runs through a durable **plan/apply** + **task** engine
with per-resource locking, idempotency, before/after snapshots, and auto-rollback
— proven end-to-end now through a built-in **reference executor**, with the real
OS executors (xiRAID / fs / nfs / netplan) plugging into the same engine in their
own later work packages (S3–S6).

**Architecture base (approved).** The S0/S1 privilege boundary is kept and
extended: **api (unprivileged) owns durable control-plane state**; **agent (root)
owns privileged execution and reports facts back**. The api is the sole writer of
the KV state store; the agent never writes task/lock records directly.

---

## 1. Scope

### In scope (S2)
- The resource-agnostic **plan engine** (deterministic preflight → `Plan`) with a `PlanProvider` registry.
- The durable **Task engine**: dual state machines (task lifecycle + dispatch), CAS on every transition, an append-only **task event log**.
- **Per-resource lock leases** + a **global cap=1 serialize lease** (both KV-backed).
- **Idempotency** map with key+plan_hash semantics.
- The **agent task executor** + **reference executor** + the **xinas_history subprocess bridge** (real snapshots + rollback via the Python `TransactionalRunner`/`SnapshotEngine`).
- The agent↔api **progress event contract** (`POST /internal/v1/task_progress`) with an explicit event taxonomy.
- **Resumable SSE** `/tasks/{id}/watch`, tasks **metadata fold-in**, and the **dispatcher/reconciler** for crash recovery.
- **Contract revisions** to `api-v1.yaml`, `ADR-0002`, and this spec (incl. removing `task.stage_report` from the api→agent RPC surface).

### Out of scope (deferred)
- **Real OS executors** — xiRAID `arrays.*` (S3/WS5), `fs.*` (S4/WS6), `nfs.*` (S5/WS7), `network.*` (S6/WS8). They register into this engine later; their mutating routes stay `executorUnavailable` until then.
- **Concurrency > 1** — the engine runs **cap=1** (one task at a time). Per-resource leases exist so lifting the cap later is config, not redesign.
- HA / multi-controller task ownership (single-controller only).

---

## 2. Privilege split & component map

```
            REST (plan/apply, /tasks, /tasks/{id}/watch)
                              │
   api (unprivileged)         ▼                          agent (root)
   ┌──────────────────────────────────────┐    UDS      ┌────────────────────────────┐
   │ plan/engine.ts  + plan/providers/*    │  api→agent  │ rpc/methods/task.ts        │
   │ tasks/store.ts  (dual state machine)  │ ─task.begin→│  begin / cancel / list_inflight │
   │ tasks/locks.ts  (resource + global)   │             │ task/executor.ts           │
   │ tasks/idempotency.ts                  │             │  + task/registry.ts        │
   │ tasks/dispatcher.ts (dispatch+reconcile)│           │  + task/reference-executor.ts │
   │ tasks/progress.ts  (/internal push rx)│ ←progress── │ task/progress-publisher.ts │
   │ tasks/watch.ts  (resumable SSE)       │  agent→api  │ task/xinas-history-bridge.ts│
   └──────────────────────────────────────┘             └──────────────┬─────────────┘
                                                                        │ subprocess
                                                            python3 -m xinas_history (snapshot/rollback)
```

- **api side** (`xiNAS-MCP/src/api/`): `plan/engine.ts`, `plan/providers/reference.ts`, `tasks/store.ts`, `tasks/locks.ts`, `tasks/idempotency.ts`, `tasks/dispatcher.ts`, `tasks/progress.ts`, `tasks/watch.ts`; route wiring for the reference resource's plan/apply + the real `/tasks` lifecycle.
- **agent side** (`xiNAS-MCP/src/agent/`): `task/executor.ts`, `task/registry.ts`, `task/reference-executor.ts`, `task/xinas-history-bridge.ts`, `task/progress-publisher.ts`, `rpc/methods/task.ts`.

---

## 3. Data model (KV)

All under `/xinas/v1/`. The api is the sole writer; every write is a CAS
(`KvTransaction` with `expected_revision`).

### 3.1 Task — `/xinas/v1/tasks/<task_id>`
Current rolled-up record (full per-event history lives in the event log, §3.5).

| Field | Notes |
|-------|-------|
| `task_id` (uuid), `kind` (e.g. `reference.echo`), `principal`, `client_type`, `request_id`, `correlation_id` | identity/audit |
| **`state`** | lifecycle SM (§4.1): `queued`→`running`→`success`/`failed`/`cancelled`/`requires_manual_recovery` |
| **`dispatch_state`** | dispatch SM (§4.2): `queued`→`begin_sent`→`begin_accepted`→`begin_failed` |
| `dispatch_attempts` (int), `last_dispatch_at` (ts), `agent_acceptance_id` (uuid, set when the agent accepts) | reconcile inputs |
| `plan_id`, `plan_hash`, `idempotency_key`, `input_hash` | binding |
| `state_revision_expected`, `state_revision_at_apply`, `observed_revision_expected` | freshness binding (§5) |
| `risk_level`, `affected_resources[]` | from the plan |
| `snapshot_before`, `snapshot_after` (nullable) | xinas_history manifest IDs (api writes from agent-reported facts) |
| `rollback_attempted` (bool), `rollback_result` (`succeeded`/`failed`/`null`) | rollback authority is the api's record (§7) |
| `error_code` (`FAILED_BEFORE_CHANGE`/`FAILED_PARTIAL_ROLLED_BACK`/`FAILED_MANUAL_RECOVERY_REQUIRED`/`FAILED_STATE_DESYNC`), `error_message`, `remediation_hint` | terminal detail |
| `last_event_sequence` (int) | high-water mark for idempotent/monotonic progress (§6) |
| `stages[]` (latest summary per stage) | rolled-up; full detail in event log |
| `created_at`, `updated_at`, `terminal_at` | timestamps |

`metadata` is projected on read via the S0/S1 `embedMetadata()` helper (closes the deferred tasks-metadata fold-in).

### 3.2 Per-resource lock lease — `/xinas/v1/locks/resource/<kind>/<id>`
`{ task_id, owner: <controller_id>, acquired_at, expires_at, heartbeat_at }`.
Classification: **live** (`heartbeat_at`/`expires_at` fresh) · **expired** (past) ·
**ambiguous** (references a non-terminal task whose agent is unreachable). The api
bumps `heartbeat_at` on each progress event; terminal state **deletes** the lease.

### 3.3 Global serialize lease — `/xinas/v1/locks/global/serialize`
Same shape; held by the single running task (cap=1). **A KV lease, not an
in-memory mutex** — so api restart cannot break the serialization invariant.

### 3.4 Idempotency entry — `/xinas/v1/idempotency/<idempotency_key>`
`{ task_id, plan_hash, created_at }`. Lookups: same key+`plan_hash` → return the
referenced Task; same key+**different** `plan_hash` → `409 IDEMPOTENCY_KEY_REUSED`.

### 3.5 Task event log (append-only) — `/xinas/v1/task_events/<task_id>/<seq:012d>`
One immutable row per progress event (§6). Source of truth for debugging
rollback/partial failures and for **SSE resume**. The Task row is the rolled-up
projection; the event log is the history.

---

## 4. State machines (first-class)

### 4.1 Task lifecycle
```
queued ──begin_accepted──▶ running ──all stages ok──────────────▶ success
   │                          │
   │                          ├──stage fail + rollback ok────────▶ failed (FAILED_PARTIAL_ROLLED_BACK)
   │                          ├──stage fail + rollback fail──────▶ requires_manual_recovery (FAILED_MANUAL_RECOVERY_REQUIRED)
   │                          └──cancel at safe point────────────▶ cancelled
   └──begin rejected / never-started (reconcile)─────────────────▶ failed (FAILED_BEFORE_CHANGE)
```
`requires_manual_recovery` is terminal-but-actionable; it never auto-retries.

### 4.2 Dispatch state machine (the durable handoff — first-class)
Distinct from lifecycle. Answers reconcile's key question: *was this ever sent,
and might the agent have accepted it?*
```
queued ──api sends task.begin──▶ begin_sent ──agent acks (acceptance_id)──▶ begin_accepted
   │                                │
   │                                └──ack times out / error──▶ (reconcile: query task.list_inflight)
   └──(crash here = "never sent"; reconcile re-dispatches or rejects)
```
- **`task.begin` is idempotent**, keyed by `task_id`: re-sending returns the **same** `agent_acceptance_id`, so re-dispatch after a crash never double-executes.
- Reconcile (§9) maps `(dispatch_state, agent inflight set, lease)` → re-dispatch / confirm / reject / manual-recovery.

---

## 5. Plan / apply flow

### 5.1 Plan (`mode=plan`) — api-only, deterministic
1. Validate the spec against the resource's `PlanProvider`.
2. Preflight using **desired state + cached observed state**; compute `affected_resources`, `blockers[]`, `warnings[]`, `diff`, `risk_level`, `rollback_model`.
3. Record freshness: `state_revision_expected` (desired resource revision) **and** `observed_revision_expected` + `observed_at` (the observation the plan read).
4. Return `Plan` with `plan_id` + `plan_hash` (hash over the canonicalized plan inputs). The plan is cached so apply can bind to it.

### 5.2 Apply (`mode=apply`) — atomic, no orphan-by-design
1. Validate `plan_id`, `expected_revision`, `idempotency_key`.
2. **One KV transaction** (atomic):
   - Idempotency: key found+same `plan_hash` → return original Task (no new run); key found+different `plan_hash` → `409 IDEMPOTENCY_KEY_REUSED`.
   - Freshness: desired revision ≠ `state_revision_expected` → `412`; observed snapshot stale beyond plan rules → `409 PLAN_STALE`.
   - Locks: acquire the per-resource lease(s) + the global serialize lease; any held by a **live** lease → `409 LOCK_HELD`.
   - Write `Task{state: queued, dispatch_state: queued}` + idempotency entry + lease rows. Commit.
3. **Dispatch inline** (`tasks/dispatcher.ts`): set `dispatch_state: begin_sent`, send api→agent `task.begin(task_id, kind, spec, plan)`:
   - **accepted** → record `agent_acceptance_id`, `dispatch_state: begin_accepted`, `state: running`; return **202 + Task**.
   - **unavailable/rejected** (agent offline / `EXECUTOR_UNSUPPORTED`) → second txn: `state: failed (FAILED_BEFORE_CHANGE)`, `dispatch_state: begin_failed`, **release leases**; return `503`/`422`. Never a dangling 202.
4. The **reconciler** is the durable backstop for a crash between step 2 commit and a recorded outcome (§9).

---

## 6. Progress event contract (first-class)

The agent reports **facts**; the api applies them as the **sole writer**. Transport:
`POST /internal/v1/task_progress` (agent→api, Bearer agent-token — mirrors
`/internal/v1/observed`). This **replaces** the reserved `task.stage_report`
api→agent RPC (removed in T0).

**Event** `{ task_id, sequence, event_type, stage_index?, stage_name?, status?, output_inline?|output_ref?, error_code?, error_message?, snapshot_id?, rollback_result?, observed_at }`.

**`event_type` taxonomy** (defined in T0): `accepted` · `stage_started` ·
`stage_succeeded` · `stage_failed` · `rollback_started` · `rollback_succeeded` ·
`rollback_failed` · `terminal`.

**Application rules:**
- **Monotonic + idempotent:** `sequence` is per-task monotonic; the api ignores any event with `sequence ≤ task.last_event_sequence` (dup/out-of-order safe).
- **CAS:** the rolled-up Task update is a compare-and-swap; the event is appended to the log (§3.5) under its `sequence`.
- The api bumps the lease `heartbeat_at` on every event.
- `terminal` carries final `state`, `result_hash`, `snapshot_after`, and (on failure) `rollback_result` + `error_code`; the api releases leases on apply of a `terminal` event.

---

## 7. xinas_history bridge & rollback authority

The agent (root, TS) drives the mutation through `xinas_history` (Python) over the
**existing config-history subprocess protocol** (`python3 -m xinas_history …`,
JSON I/O):
1. `snapshot_before` = `xinas_history` snapshot create → agent reports the manifest ID via a progress event.
2. Run the executor stages.
3. On stage failure: `xinas_history` rollback to `snapshot_before` → report `rollback_started`/`rollback_succeeded`|`rollback_failed`.
4. `snapshot_after` = snapshot create → report ID on `terminal`.

**Rollback authority:** the agent only *reports* (snapshot IDs, rollback
attempted+result, executor outcome). The **api writes** the authoritative Task
fields (`snapshot_before/after`, `rollback_attempted`, `rollback_result`, final
`state`, `error_code`). The agent never writes the task record.

---

## 8. Reference executor

A built-in, safe, **inert** executor (`kind: reference.echo`) that exercises the
full path without touching real OS config:
- ≥3 stages (`preflight`, `apply`, `verify`) emitting the event taxonomy.
- A deliberate **failure mode** (e.g. `spec.fail_at_stage`) so the rollback path
  (`stage_failed` → `rollback_*` → `failed (FAILED_PARTIAL_ROLLED_BACK)`) is real
  and e2e-tested.
- Its `PlanProvider` produces a deterministic plan (diff = the echoed spec,
  `risk_level: non_disruptive`). It still goes through real snapshots so the
  xinas_history bridge is genuinely exercised.

---

## 9. Reconciliation / crash recovery (`tasks/dispatcher.ts`)

Runs on api start and on agent reconnect. For each non-terminal task, decide from
`(dispatch_state, agent inflight set via task.list_inflight, lease state)`:

| dispatch_state | agent inflight? | Action |
|----------------|-----------------|--------|
| `queued` | n/a | never sent → re-dispatch (or `failed FAILED_BEFORE_CHANGE` per policy) |
| `begin_sent` | yes (matches `task_id`) | confirm → `begin_accepted`, `running` |
| `begin_sent` | no | never actually started → re-dispatch / reject |
| `begin_accepted` | yes | live → resume watching |
| `begin_accepted` | no, lease live | brief grace, then re-query |
| `begin_accepted` | no, lease expired | agent died mid-run → `requires_manual_recovery` (`FAILED_MANUAL_RECOVERY_REQUIRED`) |

Re-dispatch is safe because `task.begin` is idempotent by `task_id`.

---

## 10. SSE watch (resumable)

`GET /tasks/{id}/watch` streams the event taxonomy. **In-memory fan-out** serves
live subscribers, but **reconnect is resumable**: the client sends
`Last-Event-ID: <sequence>` (or a KV revision); the api replays missed events from
the task event log (§3.5) before attaching to the live stream. A snapshot of the
current Task is sent first so a fresh subscriber is immediately consistent.

---

## 11. Error model (additions)

`PLAN_STALE` (409), `IDEMPOTENCY_KEY_REUSED` (409), `LOCK_HELD` (409),
`PRECONDITION_FAILED` (412, revision mismatch), plus the existing
`EXECUTOR_UNAVAILABLE`/`EXECUTOR_UNSUPPORTED` and the `FAILED_*` task error codes.
All envelope-wrapped per the S0/S1 error model.

---

## 12. Contract revisions (T0 — all three together)

1. **`api-v1.yaml`:** add `observed_revision_expected`/`observed_at` to `Plan`;
   add the `dispatch_state` + dispatch metadata to `Task`; add the
   `/internal/v1/task_progress` request schema + the `event_type` enum; add the
   new error codes; document the event log + resumable watch. **Remove
   `task.stage_report` from the api→agent RPC surface** and document the push.
2. **`ADR-0002`:** record the api-owns-store / agent-executes-and-reports split,
   the dual state machines, lease semantics, rollback authority, and the
   `task.stage_report`→push refinement.
3. **This spec.** Keep all three in sync (spec-first rule).
4. **Tests:** delete/replace the `task.stage_report` stub expectation in
   `stubs.ts` + `stubs.test.ts` (it is no longer an api→agent stub).

---

## 13. Testing strategy

- **Unit:** task store CAS + dual SM transitions; lease acquire/expire/classify; idempotency dedup vs conflict; plan freshness binding; progress monotonic/idempotent application; the reference executor stage + failure paths; the xinas_history bridge (mocked subprocess).
- **e2e (real agent↔api↔xinas_history):**
  1. **Success:** plan → apply → stages → `snapshot_before/after` → `success`.
  2. **Failure→rollback:** `spec.fail_at_stage` → `stage_failed` → `rollback_succeeded` → `failed (FAILED_PARTIAL_ROLLED_BACK)`.
  3. **Idempotency conflict:** same key + different `plan_hash` → `409 IDEMPOTENCY_KEY_REUSED`.
  4. **Crash/reconcile shape** (simulated): a `queued` task with no matching agent inflight task becomes `rejected`/`re-dispatched` per the documented rule.

---

## 14. Decomposition (T0–T10)

| # | Task |
|---|------|
| **T0** | Contract revisions (api-v1.yaml + ADR-0002 + this spec): Plan freshness, dual state machines + dispatch metadata, `/internal/v1/task_progress` + event taxonomy, error codes, event-log + resumable-watch contract; **remove `task.stage_report`** from stubs.ts + stubs.test.ts. |
| **T1** | `tasks/store.ts` — Task CRUD, dual state machines, CAS on every transition, append-only event log writer. |
| **T2** | `tasks/locks.ts` (per-resource + global serialize, both KV leases, classification) + `tasks/idempotency.ts`; the atomic apply transaction. |
| **T3** | `plan/engine.ts` + `plan/providers/reference.ts` (deterministic plan, revision + observation freshness binding). |
| **T4** | Reference mutating route — plan + apply (atomic txn → inline dispatch → 202-on-accept / terminal-on-reject). |
| **T5** | `tasks/progress.ts` — `/internal/v1/task_progress` receiver **skeleton** (validate taxonomy + monotonic/CAS apply + event-log append). *Before* agent work so the contract target is stable. |
| **T6** | `task/executor.ts` + `task/reference-executor.ts` + `task/xinas-history-bridge.ts` (real snapshots/rollback). |
| **T7** | `rpc/methods/task.ts` (`begin`/`cancel`/`list_inflight`, idempotent begin) + `task/progress-publisher.ts` (emits the taxonomy). |
| **T8** | `tasks/watch.ts` — resumable SSE + tasks metadata fold-in. |
| **T9** | `tasks/dispatcher.ts` reconcile/orphan recovery (dispatch_state + leases + `task.list_inflight`). |
| **T10** | e2e: success · failure→rollback · idempotency-conflict · crash/reconcile. |

---

## 15. Open questions / risks

- **xinas_history CLI surface:** confirm the exact `python3 -m xinas_history` subcommands + JSON shape for snapshot-create / rollback (the config-history MCP tools already use a subprocess protocol — reuse it). If a needed subcommand is missing, add it as a small xinas_history task within T6.
- **Reference executor realism:** it must exercise the bridge for real (real snapshots) while staying inert on host config — verify the snapshot of a no-op operation is well-defined.
- **Lease heartbeat cadence vs `expires_at`:** pick values so a legitimately slow stage never falsely expires (tunable; default e.g. 30s heartbeat / 5min expiry).
