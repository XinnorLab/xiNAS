# ADR-0012: Task cancellation (cooperative, rollback-on-cancel)

- **Status:** accepted
- **Date:** 2026-06-12
- **Stream:** S10
- **Supersedes / amends:** completes the `cancelled` arm of the ADR-0004
  lifecycle; amends `s2-task-envelope-spec.md` (new §16)

## Context

S2 built most of the cancel plumbing and then stopped short of wiring
it end-to-end:

- The agent's `task.cancel` RPC is real: it sets the runner's per-task
  `cancelRequested` flag (`rpc/methods/task.ts`).
- The runner exposes `ctx.isCancelRequested()` to executors, and two
  executors already poll it (fs create, xiraid array create) — but the
  **runner itself never checks the flag**, and an executor that honors
  it can only `throw`, which the runner reports as `stage_failed` →
  `terminal(failed)`. Cancel currently produces the WRONG terminal
  state even where it "works".
- The progress receiver fully handles `terminal(cancelled)`: state
  transition, lease release, and the Model R desired-KV revert
  (`progress.ts` — cancelled is explicitly a non-success terminal).
- `tasks` has `cancel_requested_at` / `cancel_refused_reason` columns;
  `api-v1.yaml` has `POST /tasks/{id}/cancel`; the MCP catalog entry
  exists (degraded, allowed without `allow_apply` per ADR-0010 — an
  emergency stop cannot apply new state).
- The REST route is an `executorUnavailable` stub; the engine has no
  cancel method.

## Decision

### 1. `cancelled` means "stopped at a safe point AND rolled back"

A cancelled task stopped before completing its stages **and** had its
partial work unwound by the executor's existing `rollback()`
(best-effort). Rationale: the receiver already reverts the desired-KV
intent on `cancelled` (Model R), so observed state must be unwound too
or every cancel manufactures drift. Rollback failure during a cancel →
`requires_manual_recovery`, exactly as for a stage failure.

### 2. Safe points are before each EXECUTOR stage

The runner checks `cancelRequested` immediately before starting each
executor stage (including before stage 0, i.e. after the synthetic
`snapshot_before`). There is **no checkpoint between the final executor
stage and `snapshot_after`/`terminal(success)`**: once all stages have
run, the work is done and a late cancel is ignored — the task finishes
`success`. Honored cancel at a boundary: emit the rollback taxonomy
(`rollback_started` → `rollback_succeeded|rollback_failed`) and then
`terminal(cancelled)` (rollback ok) or
`terminal(requires_manual_recovery)` (rollback threw). No new event
types — the 8-value taxonomy is unchanged.

### 3. Stage-throw attribution rule (no sentinel error type)

If a stage **throws while `cancelRequested` is set**, the throw is
attributed to the cancel: the runner emits `stage_failed` (the facts),
runs rollback as usual, and terminates with `terminal(cancelled)` on
rollback success (instead of `failed` / `FAILED_PARTIAL_ROLLED_BACK`);
rollback throwing still yields `requires_manual_recovery`. This gives
the two existing mid-stage `checkCancelled()` throws (fs create, xiraid
array create) correct semantics with zero executor changes, and avoids
a shared sentinel-error class coupling executors to the runner.
Deliberate ambiguity: a genuine failure that happens to land after a
cancel request is also reported `cancelled` — acceptable, because the
host outcome is identical (work rolled back) and the stage row still
records the real `error_message`.

### 4. Queued cancel is engine-local, with a guarded CAS

`queued` tasks (worker pool full, never dispatched) are cancelled
without agent involvement: release leases, revert the desired intent,
set `cancel_requested_at`, transition to `cancelled`. Two guards:

- **In-memory:** a task in `dispatchReservations` is mid-`task.begin`
  → refuse with `CONFLICT` (`details.reason: 'dispatch_in_flight'`,
  remediation "retry") — on retry it is `running` and takes the RPC
  path.
- **Durable:** `TaskStore.transition()` updates by `task_id` with no
  state guard, so the queued→cancelled flip MUST use a new conditional
  transition (`UPDATE … WHERE task_id = ? AND state = 'queued'`,
  CAS-style, returning whether a row changed). A lost race (the drainer
  dispatched concurrently) → re-read the row and fall through to the
  running-cancel path (or 409 `not_cancellable` if it raced to
  terminal).

An engine-local cancel produces no agent progress event, and watch
live fan-out + `Last-Event-ID` resync both key off the progress
pipeline (`TaskWatch.notify()` / `last_event_sequence`). The engine
therefore emits a **synthetic terminal event** via a shared helper —
advance `last_event_sequence` and notify a terminal-shaped
`cancelled` frame — so live watchers close out and reconnects resync.
The helper is also wired into `failBeforeChange` for queued tasks the
drainer fails (the same watcher-hang gap, fixed by the same helper).

### 5. Running cancel is a forwarded request, refused honestly offline

`running` tasks: forward the existing `task.cancel` RPC.

- Tracker offline → `INTERNAL` / `EXECUTOR_UNAVAILABLE` (500). The
  cancel did NOT reach the executor; no durable pending-cancel is
  recorded (rejected alternative below). The same applies to any RPC
  rejection AFTER the tracker check (connect error, timeout,
  malformed response — `AgentRpcClient.call()` rejects on all three
  even when the tracker just looked healthy): nothing durable, 500
  `EXECUTOR_UNAVAILABLE`, matching the class the begin path already
  treats as executor-unavailable.
- Agent answers `cancel_requested: true` → set `cancel_requested_at`
  (guarded: only while the row is still `running`, so a terminal that
  raced in cannot be clobbered or resurrected) and return 200 with the
  still-`running` row. The terminal state arrives via the normal
  progress push; clients poll or watch.
- Agent answers `not_found` (task finished or desynced) → record
  `cancel_refused_reason: 'agent_not_found'` (same running-state
  guard) and return `CONFLICT`. The row is left `running` with refusal
  metadata; the existing lease-expiry/sweep path owns recovery — S10
  adds **no** new reconcile action (`running` + not-inflight remains a
  reconcile no-op by design).

### 6. Eligibility by state

| Task state | Behavior |
|---|---|
| unknown | 404 `NOT_FOUND` |
| `cancelled` | 200 with the row (idempotent re-cancel) |
| `plan_only`, `imported`, `success`, `failed`, `requires_manual_recovery` | 409 `CONFLICT` (`details.reason: 'not_cancellable'`, state named) |
| `queued` | engine-local cancel (Decision 4) |
| `running` | forwarded cancel (Decision 5) |

The route sets `rc.operation_id = task_id`, so the cancel's audit row
is found by `/audit?task_id=` (the S9 task_id mirror).

### 7. Internal type/helper changes

- Agent `TaskTerminalState` widens to include `'cancelled'`
  (`agent/task/types.ts` currently excludes it).
- The runner's `#runRollback()` is parameterized on the
  rollback-success terminal status (`failed` for stage failure,
  `cancelled` for honored cancel) instead of hardcoding
  `terminal(failed)`; the `error_code` is omitted for `cancelled`
  (`FAILED_PARTIAL_ROLLED_BACK` stays failure-only).
- `reference-executor` gains an optional `spec.sleep_ms` (bounded) so
  tests and the e2e have a deterministically slow, harmless task to
  cancel.

### 8. Clients

- **Catalog:** `tasks.cancel` flips `degraded` → live. `min_role:
  operator` and `requires_mcp_apply: false` stay (ADR-0010 emergency
  stop). CLI (`xinasctl tasks cancel <id>`) and the MCP tool pick the
  entry up with no extra work.
- **TUI:** `control_client.py` gains `cancel_task(task_id)`;
  `plan_apply_wait` gains an optional `cancel_check` callback polled
  each loop — when it first returns true, the client sends the cancel
  once and keeps polling to terminal. A cancelled terminal raises a
  distinct `TaskCancelled` (subclass of `TaskFailed`) so screens
  report "operation cancelled" instead of a failure toast. The shared
  wait modal gets a Cancel button wired to `cancel_check`; the
  long-running screens (RAID create/delete, filesystem create) enable
  it.

## Alternatives considered

- **Stop-only cancel (keep partial work):** simpler runner change, but
  the receiver reverts the desired intent on `cancelled`, so observed
  and desired state would disagree after every cancel — manufactured
  drift. Rejected.
- **Sentinel cancel-error class:** executors throw
  `TaskCancelledError` and the runner switches on `instanceof`.
  Couples every executor to a runner type and still needs the
  attribution rule for plain throws. The flag is already shared state;
  checking it in the catch path is strictly less machinery. Rejected.
- **Durable pending-cancel (agent offline):** persist the request and
  deliver on reconnect. Needs a pending-cancel sweep, an expiry
  policy, and the task may finish before delivery anyway. The honest
  refusal is simpler and the operator can retry. Rejected for S10.
- **New `cancel_honored` event type:** the 8-value taxonomy is pinned
  by the receiver, api-v1.yaml, and tests; `terminal(cancelled)` plus
  the rollback events already express everything. Rejected.

## Consequences

- A cancel can no longer surface as `failed` — the two executors that
  poll the flag start reporting `cancelled` correctly with no code
  change to them.
- Every cancel that lands after partial work costs a rollback (same
  cost profile as a stage failure) plus the snapshot_before already
  taken; there is no snapshot_after on the cancelled path (parity with
  the failure path).
- `cancel_requested_at` is only meaningful on `running`/`cancelled`
  rows; `cancel_refused_reason` records agent-side refusal on rows
  that stayed `running`.
- The reconcile contract is unchanged; cancel introduces no new
  recovery obligations.
