# S10 Task Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the last degraded catalog entry (`tasks.cancel`) goes live with rollback-on-cancel semantics: a real `POST /tasks/{id}/cancel` route + `engine.cancel()` (queued = engine-local guarded CAS; running = forwarded `task.cancel` RPC), the runner honoring `cancelRequested` at executor-stage boundaries plus the stage-throw attribution rule, synthetic terminal events for engine-local terminals (watch story), and a TUI cancel surface. Contract: ADR-0012 + `s2-task-envelope-spec.md` §16.

**Tech stack:** TS (xiNAS-MCP, vitest), Python TUI (xinas_menu + pytest), api-v1.yaml (already amended — error_code wording landed with the docs).

**Conventions (every task):** TDD; `.js` ESM suffixes; conditional spreads (exactOptionalPropertyTypes); per-task HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; gate per task = named tests + `npx tsc --noEmit`; full gate at T7 (all suites + build + e2e + contracts + biome format + markdownlint + spectral + oasdiff + pytest + ruff + pyright(venv) + ansible-lint + gitleaks main..HEAD).

---

### T1 — Store: conditional (CAS) transition

**Files:** modify `xiNAS-MCP/src/api/tasks/store.ts`; test `xiNAS-MCP/src/__tests__/api/tasks/store.test.ts`.

- [ ] Failing tests: `transitionIf(taskId, 'queued', {state:'cancelled', …})` (a) flips a queued row and returns the updated Task (terminal_at set — reuse the TERMINAL_STATES stamp rule from `transition()`); (b) returns `null` and writes NOTHING when the row is `running`; (c) returns `null` for an unknown id (no throw — the caller re-reads).
- [ ] Implement `transitionIf(taskId: string, expectedState: TaskState, patch: TaskPatch): Task | null` — same merged-UPDATE as `transition()` but `WHERE task_id = @task_id AND state = @expected_state`; `info.changes === 0` → null, else `this.get(taskId)`. Do NOT touch `transition()`.
- [ ] `npx vitest run src/__tests__/api/tasks/store.test.ts` green; tsc clean.
- [ ] Commit `feat(api): S10 T1 — TaskStore.transitionIf (guarded CAS transition)`.

### T2 — Runner: honor cancel at executor-stage boundaries + attribution

**Files:** modify `xiNAS-MCP/src/agent/task/runner.ts`, `xiNAS-MCP/src/agent/task/types.ts:98` (`TaskTerminalState` += `'cancelled'`); test `xiNAS-MCP/src/__tests__/agent/task/runner.test.ts`.

- [ ] Failing tests (drive with a 2-stage fake executor + a publish recorder, the file's existing pattern):
  - cancel flag set during stage 1 (`requestCancel` from inside the stage's run) → stage 1 still `stage_succeeded`, then NO stage 2 events; emits `rollback_started` → `rollback_succeeded` → `terminal(status:'cancelled')` with NO `error_code`; inflight entry removed.
  - cancel flag set before stage 0 (set via `requestCancel` inside a `snapshot_before`-time hook — set the flag, then assert stage 0 never started) → rollback + `terminal(cancelled)`.
  - stage THROWS while flag set → `stage_failed` (real error_message) → rollback ok → `terminal(cancelled)` (NOT `failed`/`FAILED_PARTIAL_ROLLED_BACK`).
  - stage throws while flag set + rollback throws → `terminal(requires_manual_recovery)` / `FAILED_MANUAL_RECOVERY_REQUIRED` (unchanged).
  - flag set AFTER the last stage succeeded (set inside stage 2's run, 2-stage executor) → `snapshot_after` + `terminal(success)` — late cancel ignored.
  - plain stage failure with NO flag → unchanged `terminal(failed)`/`FAILED_PARTIAL_ROLLED_BACK` (regression pin).
- [ ] Implement: in the stage loop, before `stage_started`, `if (inflight.cancelRequested) { await this.#runRollback(executor, ctx, emit, drainOutput, nextStageIndex(), 'cancelled'); return; }`. In the stage `catch`, pass `inflight.cancelRequested ? 'cancelled' : 'failed'`. `#runRollback` gains a final param `terminalStatus: 'failed' | 'cancelled'`; on rollback success emit `terminal({status: terminalStatus, ...(terminalStatus === 'failed' ? {error_code: 'FAILED_PARTIAL_ROLLED_BACK'} : {})})`. No checkpoint after the loop (the §16.4 post-work rule).
- [ ] `npx vitest run src/__tests__/agent/task/runner.test.ts` green; tsc clean.
- [ ] Commit `feat(agent): S10 T2 — runner honors cancel (boundary checks + stage-throw attribution)`.

### T3 — Reference executor: `spec.sleep_ms`

**Files:** modify `xiNAS-MCP/src/agent/task/reference-executor.ts`; test `xiNAS-MCP/src/__tests__/agent/task/runner.test.ts` (same file — it drives the reference executor today).

- [ ] Failing tests: spec `{sleep_ms: 150}` → the `apply` stage takes ≥150 ms and succeeds; spec `{sleep_ms: 300}` + `requestCancel` fired at ~50 ms → the apply stage throws (`cancelled during sleep`), runner (T2) terminates `cancelled`; `sleep_ms: 999_999` clamps to 60_000 (assert via a clamp unit on the exported helper, not a real wait).
- [ ] Implement: `readSpec` += `sleep_ms?: number`; export `clampSleepMs(v: unknown): number` (non-finite/negative → 0, cap 60_000). In the `apply` stage only: sleep in 100 ms chunks, polling `ctx.isCancelRequested()` each chunk and throwing `new Error('reference.echo: cancelled during sleep')` when set (the T2 attribution rule turns this into `cancelled`).
- [ ] `npx vitest run src/__tests__/agent/task/runner.test.ts` green; tsc clean.
- [ ] Commit `feat(agent): S10 T3 — reference executor sleep_ms (cancellable slow task)`.

### T4 — Engine: `cancel()` + synthetic terminal helper (watch story)

**Files:** modify `xiNAS-MCP/src/api/tasks/engine.ts`, `xiNAS-MCP/src/api/tasks/build.ts` (thread `taskWatch` into the engine opts; `ctx.taskWatch` already exists on context); test `xiNAS-MCP/src/__tests__/api/tasks/apply.test.ts` (engine tests live here) or a new `xiNAS-MCP/src/__tests__/api/tasks/cancel.test.ts`.

- [ ] Failing tests (new `cancel.test.ts`, reusing apply.test.ts's engine harness):
  - unknown id → `ApiException NOT_FOUND`.
  - `plan_only` and each non-cancelled terminal → `CONFLICT` `details.reason:'not_cancellable'` + the state.
  - already `cancelled` → returns the row (no throw, idempotent).
  - queued, unreserved → returns row with `state:'cancelled'`, `cancel_requested_at` set, leases released (assert via LeaseManager), desired KV reverted, `last_event_sequence` advanced to 1, and a `TaskWatch.notify` fake received `{event_type:'terminal', status:'cancelled', sequence:1}`.
  - queued but in `dispatchReservations` → `CONFLICT` `details.reason:'dispatch_in_flight'`.
  - queued, but a concurrent flip raced (pre-set the row to `running` between read and CAS via a store spy or by calling with a running row) → falls through to the running path.
  - running + `trackerOffline:true` → `INTERNAL` + `details.code:'EXECUTOR_UNAVAILABLE'`, and NO durable write (`cancel_requested_at` still null).
  - running + RPC resolves `{cancel_requested:true}` → row returned still `running` with `cancel_requested_at` set (guarded write: `transitionIf(id,'running',…)`).
  - running + RPC resolves `{cancel_requested:false, reason:'not_found'}` → `CONFLICT` `details.reason:'agent_not_found'` and `cancel_refused_reason:'agent_not_found'` persisted.
  - running + RPC REJECTS (fake client throws) → `INTERNAL`/`EXECUTOR_UNAVAILABLE`, no durable write.
  - `failBeforeChange` on a queued task (drainer path) now ALSO advances `last_event_sequence` + notifies a `terminal(failed)` frame (the shared helper — assert via the watch fake on a dispatch-failure test).
- [ ] Implement:
  - engine opts += `taskWatch?: TaskWatch`; build.ts passes it through.
  - private `emitSyntheticTerminal(task: Task, status: 'cancelled' | 'failed'): void` — `seq = (task.last_event_sequence ?? 0) + 1`; include `last_event_sequence: seq` in the terminal transition patch; `this.taskWatch?.notify(task.task_id, {task_id, sequence: seq, event_type:'terminal', status, observed_at: new Date().toISOString()})`.
  - `async cancel(args: {taskId: string; agentClient: AgentRpcClient | undefined; trackerOffline: boolean}): Promise<Task>` implementing the §16.1–16.3 ladder; queued flip via `transitionIf(taskId, 'queued', {state:'cancelled', cancel_requested_at: Date.now(), last_event_sequence: seq})` + `leases.releaseByTask` + `revertDesired` + notify; CAS-null → re-read + fall through; running metadata writes via `transitionIf(taskId, 'running', …)` (a null result here means a terminal raced in — re-read and return the row as-is).
  - `failBeforeChange` switches its terminal transition to go through `emitSyntheticTerminal` (sequence + notify) while keeping its existing error fields.
- [ ] `npx vitest run src/__tests__/api/tasks/` green; tsc clean.
- [ ] Commit `feat(api): S10 T4 — engine.cancel (queued CAS + forwarded RPC) + synthetic terminal watch events`.

### T5 — Route: real `POST /tasks/{id}/cancel`

**Files:** modify `xiNAS-MCP/src/api/routes/tasks.ts:161` (replace the `executorUnavailable` stub); test `xiNAS-MCP/src/__tests__/api/routes-tasks.test.ts` (+ update the stub pin in `xiNAS-MCP/src/__tests__/api/routes-stubs.test.ts` if it lists this route).

- [ ] Failing tests (buildTestAppWithMockAgent): 404 unknown; 409 `not_cancellable` on a `success` row; 200 idempotent on a `cancelled` row; 200 queued→cancelled (seeded queued row, pool saturated or no dispatch); RBAC: viewer → 403, operator → allowed (catalog `min_role: operator`); response envelope `result` is the task row; `rc.operation_id` lands in the audit row (assert via the audit handler or skip if covered by e2e).
- [ ] Implement: `r.post('/tasks/:id/cancel', async (req,res,next) => { try { const rc = requestContext(res); const task = await requireTasks(ctx).taskEngine.cancel({taskId: req.params.id as string, agentClient: ctx.agentClient, trackerOffline: ctx.tracker ? ctx.tracker.currentState() === 'offline' : true}); rc.operation_id = task.task_id; sendOk(req, res, taskEnvelope(task), [task.state_revision_at_apply ?? 0]); } catch (err) { next(err); } })` — match the file's existing helpers (`taskEnvelope`, context access) exactly; set `rc.operation_id` BEFORE sendOk.
- [ ] `npx vitest run src/__tests__/api/routes-tasks.test.ts src/__tests__/api/routes-stubs.test.ts` green; tsc clean.
- [ ] Commit `feat(api): S10 T5 — POST /tasks/{id}/cancel live`.

### T6 — Catalog flip + client pins

**Files:** modify `xiNAS-MCP/src/api/mcp/catalog.ts` (tasks.cancel: drop `status: 'degraded'`, rewrite description: cooperative cancel, queued+running, rollback-on-cancel, late-cancel ignored; keep `requires_mcp_apply: false`, `min_role: 'operator'`); update pins in `xiNAS-MCP/src/__tests__/api/mcp-catalog.test.ts` + `xiNAS-MCP/src/__tests__/api/mcp-integration.test.ts` (degraded-list assertions — `tasks.cancel` leaves the degraded set; the "last degraded entry" expectation becomes an EMPTY degraded set).
- [ ] Failing test first: degraded set `[]`; `tasks.cancel` callable via /mcp WITHOUT `allow_apply` (existing gate matrix gains/keeps this pin).
- [ ] `npx vitest run src/__tests__/api/mcp-catalog.test.ts src/__tests__/api/mcp-integration.test.ts` green; tsc clean. (xinasctl + MCP need no code — catalog-driven.)
- [ ] Commit `feat(api): S10 T6 — tasks.cancel live in the catalog (degraded set now empty)`.

### T7 — TUI: cancel surface

**Files:** modify `xinas_menu/api/control_client.py` (after `plan_apply_wait`, `:163`); the shared wait dialog (locate via `grep -rn "on_progress" xinas_menu/screens/` — the modal that renders plan_apply_wait progress); screens `xinas_menu/screens/raid.py`, `xinas_menu/screens/filesystem.py` (long-running ops enable the button). Test: `tests/` pytest unit for the client (fake transport pattern used by the S8 client tests).

- [ ] Failing pytest: `cancel_task(task_id)` POSTs `/api/v1/tasks/{id}/cancel` and returns the envelope result; `plan_apply_wait(..., cancel_check=lambda: True)` sends the cancel exactly ONCE and, when the task terminates `cancelled`, raises `TaskCancelled` (new exception, subclass of `TaskFailed`, carrying task_id); `cancel_check=None` behaves exactly as before (regression).
- [ ] Implement: `TaskCancelled(TaskFailed)`; `def cancel_task(self, task_id: str) -> dict[str, Any]: return self.result(f"/api/v1/tasks/{task_id}/cancel", method="POST") or {}` (match the client's existing request helper signatures); in the poll loop: `if cancel_check is not None and not cancel_sent and cancel_check(): self.cancel_task(task_id); cancel_sent = True` before the sleep; on terminal `cancelled` raise `TaskCancelled(task_id, "cancelled", None)`.
- [ ] Wait modal: add a Cancel button/binding that flips a flag the screen passes as `cancel_check`; RAID create/delete + filesystem create pass it; cancelled outcome shows "operation cancelled" notice (not the failure toast).
- [ ] `/tmp/xinas-pytest-venv/bin/python -m pytest tests/ -q` green; ruff + pyright(venv) clean on touched files.
- [ ] Commit `feat(tui): S10 T7 — cancel surface (cancel_task + cancel_check + TaskCancelled)`.

### T8 — e2e + runbook + FULL gate

**Files:** create `xiNAS-MCP/src/__tests__/e2e/task-cancel.test.ts` (harness copied from `bridge-pools.test.ts` — real api+agent over UDS, fixture mode, python3 shim, seeded cluster + Node rows, poll-interval env overrides); modify `docs/control-path/hardware-smoke-runbook.md` (new §5d).

- [ ] e2e scenarios (reference.echo tasks via `POST /api/v1/reference`):
  1. **Running cancel:** apply `{sleep_ms: 20_000}` → 202 → cancel at ~300 ms → poll to `cancelled`; assert `cancel_requested_at` set, a `rollback` stage row exists, NO `error_code`, leases freed (a follow-up apply on the same resource succeeds).
  2. **Queued cancel + watch:** saturate the pool (4 × `sleep_ms: 20_000`) → 5th apply returns 202 `queued` → open `/tasks/{id}/watch` (raw http) → cancel → SSE delivers a `terminal/cancelled` frame with `id: 1`; row `cancelled`; then cancel the 4 runners (cleanup).
  3. **Late/terminal cancel:** apply a fast echo to `success` → cancel → 409 `not_cancellable`; re-cancel an already-cancelled task → 200.
  4. **CLI:** `xinasctl tasks cancel <id>` on a running sleep task → exits 0, task reaches `cancelled`.
- [ ] Runbook §5d: on-node checks — cancel a slow reference apply from xinasctl (state `cancelled`, rollback stage in `xinasctl tasks show`), cancel via MCP with `allow_apply: false` (must be permitted), cancel a queued task while the pool is busy, audit row findable via `/audit?task_id=`.
- [ ] FULL gate: `npm test` && `npm run build` && `npm run test:e2e` && `npm run test:contracts` && `npm run format:write` (then `format:check`) && markdownlint && spectral && oasdiff vs main && pytest && ruff && pyright(venv) && ansible-lint && `gitleaks git --config .gitleaks.toml --log-opts="main..HEAD" .`.
- [ ] Commit `test(e2e): S10 T8 — task-cancel end-to-end + runbook §5d`.

---

**Self-review notes:** §16 coverage map — 16.1→T5, 16.2→T1+T4 (CAS, watch helper, failBeforeChange wiring), 16.3→T4 (offline, RPC-reject, not_found, guarded writes), 16.4→T2+T3 (boundaries, attribution, TaskTerminalState, sleep_ms), 16.5→T6+T7. The api-v1.yaml error_code wording already landed with the docs commits (no T0 needed). Type threads: `transitionIf` (T1) is used by T4; `#runRollback(…, terminalStatus)` (T2) is runner-internal; `TaskCancelled`/`cancel_task`/`cancel_check` (T7) used by the modal in the same task.
