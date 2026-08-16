# MCP task progress — design

Date: 2026-08-16
Status: proposed (revision 2 — addresses the 2026-08-16 review)
Area: control path (`xiNAS-MCP/`), task engine (S2) + client surface (S8)

Durable specs this change updates **before** any code lands (spec-first
rule, `CLAUDE.md`): `docs/control-path/api-v1.yaml`,
`docs/control-path/s2-task-envelope-spec.md`,
`docs/control-path/s8-clients-spec.md`.

## Problem

Creating a filesystem is a long operation (`mkfs.xfs` on a multi-drive
array, followed by mount and verify). A client driving `filesystems.create`
over MCP gets a `task_id` back within milliseconds and then has no
indication that anything is still happening — no stage, no elapsed time,
no signal that it should look again. The same gap applies to every other
long-running operation the task engine executes.

The data exists; the presentation does not.

## Current state (verified against HEAD `9d69c96`)

- `mode=apply` on any plan/apply route answers **202 + a Task envelope**
  (`task_id`, `state`) and returns immediately —
  `xiNAS-MCP/src/api/handlers/plan-apply.ts:22` (`taskEnvelope`).
  `POST /support-bundle` does the same from a `direct` tool
  (`xiNAS-MCP/src/api/routes/support.ts:103`).
- The agent's `TaskRunner` executes the executor's stages and pushes a
  typed `TaskProgressEvent` per transition to
  `POST /internal/v1/task_progress` — `xiNAS-MCP/src/agent/task/runner.ts`.
  `fs.create` runs five executor stages: `preflight`, `mkfs`,
  `install_unit`, `mount`, `verify`
  (`xiNAS-MCP/src/agent/task/fs-executor.ts:185`).
- The api is the sole writer of `tasks` / `task_stages`
  (`xiNAS-MCP/src/api/tasks/progress.ts`) and exposes the result on
  `GET /tasks/{id}` and on the SSE stream `GET /tasks/{id}/watch`.
- The MCP catalog carries `tasks.list` / `tasks.get` / `tasks.cancel`
  (`xiNAS-MCP/src/api/mcp/catalog.ts:311`), so a client *can* poll — but
  nothing in the apply result says it should, and `GET /tasks/{id}`
  returns a raw stage array with no rolled-up summary.
- `/mcp` runs in JSON response mode (`enableJsonResponse: true`), and
  `GET /mcp` answers 405 — `xiNAS-MCP/src/api/mcp/transport.ts:132`.
  There is no server-push stream, so MCP `notifications/progress` cannot
  be delivered without changing the transport mode. This design does not
  change it.

Five facts constrain the design. The first three were found by the
review of revision 1, each of which had produced a wrong claim in that
draft:

1. **The api does not know how many stages a task has.** `task_stages`
   rows materialize as events arrive, so a denominator for "stage 2 of 5"
   does not exist today.
2. **`stage_index` is an emission ordinal, not an executor-stage index.**
   The runner assigns indices to synthetic rows too — `snapshot_before`
   (index 0), then the executor stages, then `rollback` and/or
   `snapshot_after` (`runner.ts:141`, `runner.ts:58`). Deriving a position
   arithmetically from `stage_index` reads one too high.
3. **Stage output is not visible while a stage runs.** `ctx.emitOutput()`
   appends to an in-memory array that is drained only into the
   `stage_succeeded` / `stage_failed` event (`runner.ts:98`,
   `runner.ts:114`). While `mkfs.xfs` runs, the durable running row
   carries no output at all. Revision 1 promised a live "last output
   line"; it could not have delivered one.
4. **The SSE watch does not use the shared renderer.** `watchTask()`
   builds its snapshot frame by copying the raw store `Task` and deleting
   three internal columns (`xiNAS-MCP/src/api/routes/tasks.ts:245`), so
   the frame ships epoch-ms timestamps and `output_path`. Anything added
   to `renderTask` does *not* reach it for free.
5. **A `direct` tool can start a task too.** `support.bundle` is
   `mutability: 'direct'` and returns a 202 Task envelope
   (`catalog.ts:327`). Keying "this started a task" off `plan_apply`
   would leave it behind.

## Goals

- A client working over MCP can see, for any running task: which stage is
  running, how far along the stage list it is, and how long it has been
  going.
- A client can *wait* for the next change instead of hammering
  `tasks.get`.
- The MCP result of any call that starts a task explicitly tells the
  client what to call next.
- Every task kind benefits, not just `fs.create` — the mechanism lives in
  the shared task engine.

## Non-goals

- No fabricated percentages. `mkfs.xfs` reports no completion percentage;
  the honest granularity is stage plus elapsed time. A `percent` field can
  be added later, additively, by an executor that can compute one honestly
  (xiRAID initialization is the obvious first candidate).
- **No live stage output.** Fact 3 above: delivering it requires a new
  progress event carrying intra-stage output, which is its own change
  (see Deferred). The rollup reports no output line at all rather than a
  stale one — `stages[]` already carries each finished stage's output.
- No change to the `/mcp` transport mode and no MCP
  `notifications/progress`.
- No change to `xinasctl --wait` in this change (see Deferred).

## Design

### 1. The denominator: `stage_total` on the `accepted` event

The runner knows `executor.stages.length` before it runs anything. It
sends that count on the `accepted` event as a new optional field
`stage_total` (`TaskProgressEvent.stage_total`). The api stores it on the
task row (`tasks.stage_total`, migration `005-task-stage-total.sql`).

The count is the number of **executor** stages — it deliberately excludes
the synthetic `snapshot_before` / `snapshot_after` / `rollback` rows, so
`fs.create` reports 5, matching what a human sees in the executor.

Rejected alternative: a static `kind → stage count` table on the api side.
It duplicates knowledge that lives in the executor and drifts silently the
first time a stage is added.

Tasks created before this change have no `stage_total`; the rollup then
omits the denominator rather than guessing.

### 2. Synthetic stage names become a shared constant

`snapshot_before`, `snapshot_after`, and `rollback` are minted in
`runner.ts` and must be recognized by the api's rollup. They move to a
shared module (`xiNAS-MCP/src/lib/tasks/stage-names.ts`) exporting
`SNAPSHOT_BEFORE_STAGE`, `SNAPSHOT_AFTER_STAGE`, `ROLLBACK_STAGE`, and
`SYNTHETIC_STAGE_NAMES`. The runner imports its names from there; the api
rollup filters on the same set. One definition, two consumers.

### 3. The rollup: `Task.progress`

`renderTask` moves out of `src/api/routes/tasks.ts` into
`src/api/tasks/render.ts` (the wait route needs it too, and importing it
back from the route module would create a cycle) and gains a `progress`
object computed from the stage rows already loaded.

```jsonc
"progress": {
  "phase": "executing",        // preparing | executing | rolling_back | finalizing | done
  "stage_name": "mkfs",
  "stage_status": "running",   // pending | running | success | failed | skipped
  "stage_index": 2,            // raw emission index — correlates with `stages[]`
  "stage_position": 2,         // 1-based position among executor stages
  "stage_total": 5,            // omitted when the task predates stage_total
  "completed_stages": 1,
  "elapsed_s": 96,
  "stage_elapsed_s": 41
}
```

Rules:

- **Current stage** — the row with `status: running`, if any; otherwise
  the highest-index row. A task with no stage rows yet (`queued`, or
  `accepted` only) reports `phase: "preparing"` with no stage fields. A
  `plan_only` task has no `progress` at all.
- **`phase`** — `preparing` until the first executor stage starts (covers
  `queued`, `accepted`, and `snapshot_before`); `executing` while a real
  executor stage is current; `rolling_back` when the current row is
  `rollback`; `finalizing` on `snapshot_after`; `done` once the task is
  terminal, whatever the terminal state.
- **`stage_position` / `completed_stages`** count only non-synthetic rows,
  so the pair reads correctly against `stage_total`. A synthetic current
  stage has no `stage_position`.
- **`elapsed_s`** = `(terminal_at ?? now) − created_at`.
  **`stage_elapsed_s`** = `(ended_at ?? now) − started_at` of the current
  stage.

**The SSE snapshot is switched to the shared renderer.** `watchTask()`'s
hand-rolled projection is replaced by a `renderTask(task)` call, which is
what actually makes the claim "one renderer, every consumer" true. This
changes the snapshot frame's shape: epoch-ms timestamps become ISO
strings, `output_path` becomes `output_url`, and the synthesized
`metadata` object appears — the same shape `GET /tasks/{id}` has always
returned, and the shape `api-v1.yaml`'s `Task` schema already describes.
The repository has no non-test consumer of `/tasks/{id}/watch` (the TUI
and `xinasctl` both poll `GET /tasks/{id}`), so the change is contained;
it is called out in `s2-task-envelope-spec.md` §10 regardless.

### 4. `GET /tasks/{id}/wait` — bounded long-poll

```
GET /api/v1/tasks/{id}/wait?timeout_s=25&since_revision=7
```

- `timeout_s` — **validated**, not clamped: a value outside `[1, 60]` is
  an `INVALID_ARGUMENT` (400), matching the `minimum`/`maximum` in
  `api-v1.yaml`. Default 25, which sits well under the request timeout of
  typical MCP clients.
- `since_revision` — the `last_event_sequence` the caller already has.
  Optional; absent means "return as soon as anything is known", i.e.
  immediately.

Returns when the first of these holds: the task is terminal; its
`last_event_sequence` exceeds `since_revision`; or the timeout expires.

```jsonc
"result": {
  "changed": true,
  "waited_s": 12,
  "task": { /* the same rendered Task as GET /tasks/{id}, progress included */ }
}
```

**Cost control.** Three bounds, because a waiter is a held request:

1. The poll loop reads a new `TaskStore.revisionOf(id)` — a single-row
   `SELECT state, last_event_sequence FROM tasks WHERE task_id = ?` — not
   `store.get()`, which also loads every stage row. The full task is
   loaded once, when the call returns.
2. **Per-task cap: 4 concurrent waiters. Global cap: 32.** Over either
   cap, the call does not queue and does not error: it answers
   immediately with the current task and a `WAIT_CAPACITY` warning in the
   envelope, degrading to the plain-read behavior the client would have
   had anyway. An in-process counter incremented on entry and decremented
   in a `finally` is sufficient — a waiter cannot outlive its request.
3. `timeout_s ≤ 60` bounds how long any waiter can hold a slot.

**Disconnect is bounded, not immediate.** The handler wires
`res.on('close')` so a direct REST client hanging up ends the loop at the
next tick. That guard does **not** fire for a call arriving through the
MCP loopback: `ctx.loopback_fn` issues a real `http.request` against the
api's own listener (`xiNAS-MCP/src/api/server.ts:174`) and nothing aborts
that inner request when the outer MCP client disconnects. So an abandoned
MCP wait holds its slot until `timeout_s` expires. That is why the caps
above are part of the design rather than a later hardening: the timeout
bounds one waiter, the caps bound their accumulation.

Rejected alternative: subscribing to `TaskWatch`. That class is typed
against the Express `Response` and writes SSE frames
(`xiNAS-MCP/src/api/tasks/watch.ts`); generalizing it into an emitter is a
larger change than this endpoint justifies. If a future change needs
push-based waiting anywhere else, that generalization becomes worth doing
and this loop should move onto it.

`404` for an unknown task, matching `GET /tasks/{id}`. `min_role: viewer`
— it is a read.

### 5. MCP presentation: `returns_async_task` and the `next` hint

The catalog gains an explicit boolean `returns_async_task`, set on every
entry whose success response is a Task envelope: all `plan_apply` entries
(via the `planApply()` helper), plus the two `direct` entries that start
or affect a task — `support.bundle` and `tasks.cancel`. Keying off
`mutability` would silently miss `support.bundle`, which is exactly the
"task_id with no way to follow it" case this change exists to fix.

When a successful response carries a `result.task_id` and `result.state`
is `queued` or `running`, and the entry is flagged, the dispatcher adds:

```jsonc
"next": {
  "tool": "tasks.wait",
  "args": { "id": "<task_id>", "timeout_s": 25 },
  "note": "long-running operation — call this repeatedly until state is terminal (success, failed, cancelled, requires_manual_recovery)"
}
```

This lives in the MCP layer only: the REST `Task` envelope is unchanged,
and no contract field exists solely to instruct a client. `tasks.wait`
joins the catalog as a read entry with input schema `{ id, timeout_s,
since_revision }` — `buildRequest` already turns non-path args of a `GET`
entry into query parameters, so no dispatcher change is needed for it.

Tool descriptions for flagged entries gain a clause naming the asynchrony
("returns a task_id; execution is asynchronous — follow it with
tasks.wait"), generated from the flag in `tools/list` rather than written
into 20 description strings.

### 6. Contract changes (`docs/control-path/api-v1.yaml`)

All additive, so `oasdiff` should stay green:

1. `Task.progress` → `$ref: TaskProgress` (optional).
2. `Task.stage_total` — optional integer.
3. `TaskProgressEvent.stage_total` — optional integer, set on `accepted`.
4. New schemas `TaskProgress` and `TaskWaitResult`.
5. New path `/tasks/{id}/wait`, with `timeout_s` bounded
   `minimum: 1, maximum: 60`.

`returns_async_task` is a catalog field, not an API field — it does not
appear in `api-v1.yaml`.

**These edits land before the code**, per the repository's spec-first rule
(`CLAUDE.md`): the contract and the S2/S8 specs are the first task of the
plan, not the last.

## Data model

`xiNAS-MCP/src/state/migrations/005-task-stage-total.sql`:

```sql
ALTER TABLE tasks ADD COLUMN stage_total INTEGER;
```

`Task.stage_total?: number` in `xiNAS-MCP/src/api/tasks/types.ts`; the
store's read path carries it; `applyEvent` writes it when an `accepted`
event supplies it.

## Testing

Test-driven, in this order:

- **Rollup unit tests** (`taskProgress`): running mid-stage; a task whose
  `stage_total` is absent (pre-migration row); rollback in flight
  (`phase: rolling_back`, no `stage_position`, rollback not counted);
  terminal success (`elapsed_s` frozen at `terminal_at`); `plan_only`
  (no `progress`); `queued` with no stage rows.
- **`stage_total` propagation**: the runner emits it on `accepted`, and on
  that event only; `applyEvent` persists it; an event without the field
  (an older agent) still transitions the task. Replay protection needs no
  new test — the sequence high-water check in `taskProgressHandler` sits
  upstream of `applyEvent` and is already covered.
- **SSE parity**: the `/tasks/{id}/watch` snapshot frame carries
  `progress` and ISO timestamps, and still omits `spec`, `plan_binding`,
  and `desired_rollback`.
- **`/tasks/{id}/wait`**: returns immediately when already past
  `since_revision`; returns on a progress event that lands mid-wait;
  returns `changed: false` at timeout; rejects a `timeout_s` outside
  `[1, 60]` with 400; 404 on an unknown task; over the per-task cap,
  returns immediately with the `WAIT_CAPACITY` warning. The
  client-disconnect guard is not covered by a test — supertest has no
  clean way to abort mid-request — so it stays a code-review item.
- **Dispatcher**: `next` present for an apply that returns a running
  task; present for `support.bundle`; absent for a terminal task, for a
  plan, and for a read.
- **E2E**: extend `src/__tests__/e2e/task-engine-roundtrip.test.ts` to
  assert the progress rollup on the finished task.
- **Contract**: `spectral lint` on `api-v1.yaml`.

## Risks

- **Held requests through the MCP loopback.** Bounded by `timeout_s ≤ 60`
  and the waiter caps; an abandoned MCP wait still holds its slot until
  the timeout, by design (§4).
- **Old task rows have no `stage_total`.** Every consumer must treat the
  denominator as optional; the rollup omits it rather than defaulting to
  the stage-row count (which would include synthetic rows and read wrong).
- **`stage_index` semantics are easy to get wrong.** `stage_position` is
  computed by counting non-synthetic rows, never derived arithmetically
  from `stage_index`. The rollback test covers this.
- **The SSE frame shape changes** (§3). No in-repo consumer, but any
  external client reading `/watch` sees ISO timestamps where it saw
  epoch-ms.

## Deferred (recorded in `docs/TODO.md` as part of this change)

- **Intra-stage output.** A `stage_output` progress event carrying a
  drained chunk while a stage runs, so a long `mkfs` can show its own
  log line. Needs a 9th value in the event taxonomy, a drain policy in
  the runner (interval or line count), and a spill decision on the api
  side. Until then the rollup carries no output line.
- **`xinasctl --wait`** keeps its own poll loop against
  `GET /tasks/{id}` and does not use the rollup or `/wait`.
- **An honest `percent`** for executors that can compute one.

## Rebuild marker

Every commit touching `xiNAS-MCP/src/` in this change carries
`Requires-Rebuild: xinas_node_build` — `xinas-api` and `xinas-agent` run
compiled JS from `dist/`, which is not tracked in git.
