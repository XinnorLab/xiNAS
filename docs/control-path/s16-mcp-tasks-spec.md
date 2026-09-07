# xiNAS S16 — MCP Tasks extension (`io.modelcontextprotocol/tasks`) design spec

**Status:** design (2026-09-04). Implements
[`s16-mcp-tasks-requirements.md`](s16-mcp-tasks-requirements.md); the
requirement IDs below (`TASKS-*`) refer to that document, and Appendix A
records how every one of them was validated against the codebase and the
upstream protocol sources before this spec landed.

**Protocol target:** MCP `2026-07-28` core + the official extension
`io.modelcontextprotocol/tasks`, released schema `2026-07-28`
(SEP-2663). Normative upstream sources are pinned in §2.

**Extends / amends:** ADR-0010 (clients), ADR-0012 (cancel), ADR-0007
(filesystem), S2 (task envelope), S5 (filesystem), S8 (clients), S14
(modern MCP era), S15 (MRTR confirmation). Each amendment is a dated
section in the owning document; where they conflict with older text, the
dated section wins.

**Goal.** A modern MCP client starts a long xiNAS operation — the first
mandatory case is `filesystems.create` with its unbounded `mkfs.xfs`
stage — and receives a durable **task handle** instead of holding the
`tools/call` open. The handle *is* the existing xiNAS Task: same
`task_id`, same SQLite row, same leases, stages, cancellation, restart
reconcile and retention. Nothing about plan/apply, RBAC, idempotency, S15
confirmation or audit changes; S16 is a projection of an object that
already exists onto a wire contract that already exists.

---

## 1. Scope

### In scope

- Advertising the extension in `server/discover`
  (`capabilities.extensions["io.modelcontextprotocol/tasks"] = {}`).
- Per-request client capability parsing for the extension
  (`_meta["io.modelcontextprotocol/clientCapabilities"].extensions`).
- Returning `CreateTaskResult` (`resultType: "task"`) from an eligible
  modern `tools/call` when the request declared the extension.
- The three protocol methods `tasks/get`, `tasks/update`, `tasks/cancel`
  on the modern path, with the released `2026-07-28` extension shapes
  validated by explicit schemas.
- Streamable HTTP header agreement (`Mcp-Method`, `Mcp-Name`,
  `MCP-Protocol-Version`) for the task methods, and the stdio adapter
  mirroring those headers on the HTTP hop it makes on the client's behalf.
- The xiNAS → MCP projection: state map, `statusMessage`,
  `pollIntervalMs`, `ttlMs`, the terminal `CallToolResult`, redaction.
- Principal-bound access, generic not-found errors, cancel authorization.
- A new catalog eligibility flag (`creates_task`).
- `fs.create`: `rollback_model: "unsupported"` on every plan, and a
  **point of no return** at the `mkfs` stage honored by the agent runner
  and the shared cancellation core (`cancel_refused_reason:
  irreversible_stage_started`).
- Audit lifecycle events; a metrics interface (noop until the S15 metrics
  registry lands, §13.2).
- The compatibility fallback (`task_id` + `tasks.wait` hint) kept intact,
  and the legacy era untouched.
- Unit, integration (in-process api), and e2e tests including a
  deliberately blocked `mkfs` stage and an api restart mid-format.

### Out of scope (requirements §2, restated)

- `subscriptions/listen` / `notifications/tasks` (§14, deferred).
- `tasks/list`, `tasks/result` (absent from SEP-2663; never served).
- Task-time `input_required` flows (`tasks/update` is accepted and
  acknowledged; no xiNAS task ever enters `input_required`).
- A completion percentage for `mkfs.xfs` (none exists; `docs/TODO.md`).
- Live intra-stage output (`docs/TODO.md`, unchanged).
- Points of no return for executors other than `fs.create` (§9.6 records
  the follow-up).
- Prometheus wiring of the S16 counters (blocked on S15 Task 13, §13.2).
- Any change to the public REST `ApplyRequest`, `Task` or `Plan` schemas
  beyond descriptive text (§18).
- Claiming Claude Code or Codex as a *supported* native Tasks client (§12.4).

---

## 2. Verified facts this design rests on

Checked 2026-09-04 against vendor sources (CLAUDE.md spec-first rule 5)
and against the code in this branch (`feat/s16-mcp-tasks`, base
`feat/s15-mcp-mrtr-confirmation` @ `d8bfbb1`).

| # | Claim | Source | Verdict |
|---|---|---|---|
| V-01 | Extension id is `io.modelcontextprotocol/tasks`; clients declare it under `_meta["io.modelcontextprotocol/clientCapabilities"].extensions[id] = {}`; servers under `capabilities.extensions[id] = {}`; `TasksExtensionCapability = Record<string, never>` | [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md); [ext-tasks `schema/2026-07-28/schema.ts`](https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts) | **Confirmed** |
| V-02 | `Task = { taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs: number \| null, pollIntervalMs? }`; `TaskStatus = working \| input_required \| completed \| failed \| cancelled`; `CreateTaskResult = Result & Task & { resultType: "task" }` — flat, not nested | schema.ts (quoted in Appendix B) | **Confirmed** |
| V-03 | `GetTaskResult = Result & DetailedTask & { resultType: "complete" }`; `CompletedTask` adds `result: JSONObject`, `FailedTask` adds `error: JSONRPCErrorObject`, `InputRequiredTask` adds `inputRequests`, `WorkingTask`/`CancelledTask` add nothing | schema.ts | **Confirmed** |
| V-04 | `tasks/update` params `{ taskId, inputResponses }` → `{ resultType: "complete" }`; `tasks/cancel` params `{ taskId }` → `{ resultType: "complete" }` (acknowledgement only) | schema.ts | **Confirmed** |
| V-05 | `-32021` Missing Required Client Capability with `data.requiredCapabilities = { extensions: { "io.modelcontextprotocol/tasks": {} } }`; HTTP 400 on Streamable HTTP | SEP-2663; S15 §11 (same code, same status mapping already implemented in `transport.ts`) | **Confirmed** |
| V-06 | `tasks/result` removed (`-32601`); `tasks/list` not defined by the extension | SEP-2663 §"Legacy methods" | **Confirmed** |
| V-07 | MRTR + tasks: servers SHOULD resolve every MRTR exchange synchronously before returning `CreateTaskResult`; MRTR `inputRequests` keys and task `inputRequests` keys are independent | SEP-2663 §MRTR composition | **Confirmed** — drives §8 |
| V-08 | Streamable HTTP `2026-07-28`: `Mcp-Method` mirrors `method` on **all** requests; `Mcp-Name` mirrors `params.name`/`params.uri` on `tools/call`, `resources/read`, `prompts/get`; SEP-2663 extends `Mcp-Name` to `params.taskId` on `tasks/get`, `tasks/update`, `tasks/cancel`; a missing required header or a header/body mismatch is HTTP 400 + JSON-RPC `-32020` `HeaderMismatch`; `Mcp-Name` may carry the `=?base64?…?=` sentinel and servers MUST decode before comparing | [transports/streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) §Request Metadata, §Server Validation; SEP-2663 §Streamable HTTP | **Confirmed** — drives §5.6. **Deviation, deliberate:** S14 does not validate these headers on `tools/call` (its clients, including `xinas-mcp-stdio`, never sent them). S16 enforces them on the task methods only, and teaches the stdio adapter to mirror them; extending validation to every modern method is recorded in `docs/TODO.md`. |
| V-09 | `ttlMs` is the lifetime from `createdAt`, `null` = unlimited; may change over the task's life; `pollIntervalMs` is advisory and may change; a server MAY rate-limit faster polling | SEP-2663 §Task fields | **Confirmed** — drives §6.4–6.5 |
| V-10 | The published TypeScript SDK's modern typed maps exclude `tasks/*`; extension methods are served through explicit-schema custom handlers; the 2025-11-25 `experimental/tasks` types are `@deprecated` wire vocabulary only | [typescript-sdk `docs/migration/support-2026-07-28.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) | **Confirmed.** This repo resolves `@modelcontextprotocol/sdk` **1.27.1** (legacy only) and hand-rolls the modern era (S14 §2); S16 hand-rolls the extension the same way and imports **nothing** from `sdk/experimental/tasks`. |
| V-11 | xiNAS `TaskState` is `plan_only \| queued \| running \| success \| failed \| cancelled \| requires_manual_recovery \| imported`; `terminal_at` is stamped on the four terminal states; `created_at`/`updated_at` are epoch-ms in the store and ISO in `renderTask()` | `src/api/tasks/types.ts`, `render.ts` | **Confirmed** |
| V-12 | Terminal tasks are archived + deleted by `GcSweeper.sweepTasks()` when `terminal_at < now − taskRetentionDays·86400·1000`, default **30 days**; non-terminal rows are never pruned; the retention is not exposed to any consumer today | `src/state/gc.ts` | **Confirmed** — §6.5 adds a read-only getter |
| V-13 | `returns_async_task` is set on every `planApply()` entry, on `support.bundle` **and on `tasks.cancel`** (its 200 body is a Task envelope) | `src/api/mcp/catalog.ts` | **Confirmed** — TASKS-ELIG-001's separate flag is necessary |
| V-14 | The MCP dispatcher returns `text({ result, warnings?, next? })`; the `next` hint (`tasks.wait`, 25 s) is attached when `result.state ∈ {queued, running}` | `src/api/mcp/dispatch.ts` `nextHint()` | **Confirmed** — §12.1 keeps it byte-identical |
| V-15 | `fs.create` plan: `risk_level: destructive` / `rollback_model: unsupported` iff `spec.force === true`, else `non_disruptive` / `non_disruptive`; the executor's `rollback()` states "mkfs is not undone"; ADR-0007 §Create says the same | `src/api/plan/providers/filesystem.ts:218-219`, `src/agent/task/fs-executor.ts:206-209`, `adr/0007-filesystem.md` §Per-operation contracts | **Confirmed contradiction** — §9.1 fixes it |
| V-16 | Cancellation today: boundary check before every executor stage, stage-throw attribution while the flag is set, `fs.create` throws `checkCancelled()` at the start of `preflight`, `mkfs`, `install_unit`, `mount`; `task.cancel` RPC refuses only `not_found`; the engine records `cancel_refused_reason: agent_not_found` and answers 409 | `runner.ts`, `fs-executor.ts`, `agent/rpc/methods/task.ts`, `engine.ts cancel()` | **Confirmed** — a cancel arriving during `mkfs` is honored at the `install_unit` boundary, rolls back only the unit, and labels the task `cancelled` (the release blocker TASKS-SPEC-006 names); §9.2 fixes it |
| V-17 | `renderTask()` spreads the store row, so `plan_document` / `plan_document_hash` (S15, migration 006) reach the public Task; stage `output_path` is renamed `output_url`; `spec`, `plan_binding`, `desired_rollback` are stripped | `render.ts` | **Confirmed** — §6.6 strips the plan document and `output_url` from the MCP terminal result; the REST shape is unchanged (S15's concern) |
| V-18 | The modern handler resolves identity per request; UDS callers without a bearer are all `mcp:local_admin`; `Task.principal` is the apply's forwarded principal | `transport.ts resolveIdentity()`, `engine.ts createApplyTask` | **Confirmed** — §7.1 principal binding compares these strings; every local UDS caller is one principal by ADR-0001's trust model |
| V-19 | The e2e fake `FsHost` has deterministic hooks (`-fail`, `-busy`) but nothing that *blocks* `mkfs` | `src/agent/fs/fake-host.ts` | **Confirmed** — §16.4 adds a file-gated block |
| V-20 | `audit.queue()` is safe inside and outside a db transaction; S15 emits `mcp.confirmation.<event>` rows with hashed payloads and no state bytes | `state/audit.ts`, `mcp/confirmation/audit.ts` | **Confirmed** — §13.1 follows the same shape |
| V-21 | S15's `ConfirmationMetrics` is an interface with a noop default; the registry (`lib/metrics.ts`) and `GET /metrics` are S15 Task 13, **not yet on this branch** | `mcp/confirmation/metrics.ts`, S15 plan Task 13 | **Confirmed** — §13.2 defines the interface now and wires it when the registry exists |
| V-22 | Installed clients: Claude Code 2.1.259 binary contains the extension strings; Codex CLI 0.136.0; OpenAI's MCP docs list no Tasks support | requirement §16, unchanged on 2026-09-04 | **Not re-verified here** — S16 makes no support claim (§12.4) |

---

## 3. Capability negotiation

### 3.1 Identifier and shape (TASKS-CAP-001)

The only identifier is `io.modelcontextprotocol/tasks`. Its capability
object carries no settings. Parsing of the *client* declaration
(`parseTasksCapability(meta)` in `src/api/mcp/tasks/capability.ts`):

| `_meta` content | Result |
|---|---|
| no `clientCapabilities`, or no `extensions` key | `false` |
| `extensions` present but not a plain object | JSON-RPC `-32602` `invalid params: clientCapabilities.extensions must be an object` |
| `extensions[id]` absent | `false` |
| `extensions[id]` a plain object (any content, including `{}`) | `true` |
| `extensions[id]` present but not a plain object (`null`, `true`, `"yes"`, `[]`) | JSON-RPC `-32602` `invalid params: extensions["io.modelcontextprotocol/tasks"] must be an object` |

`clientInfo`, transport type, session, an earlier `server/discover` and
earlier requests are never consulted (TASKS-CAP-003, same rule as S15
§4.8). The parsed boolean travels in `DispatcherOptions.client.tasks`
(`McpClientInfo` gains `tasks: boolean`); the legacy path sets it to
`false` unconditionally.

### 3.2 Server advertisement (TASKS-CAP-002)

`buildCapabilities()` adds
`"io.modelcontextprotocol/tasks": {}` to the shared `capabilities.extensions`
map (which also carries S18's `io.modelcontextprotocol/ui`) **iff**
`TASKS_EXTENSION_READY` is `true`. That constant is computed once at
module load in `src/api/mcp/tasks/index.ts` from the presence of the
three method handlers and the `CreateTaskResult` schema, and is `true`
in every build that ships this spec; it exists so a future partial
refactor (a handler removed, a schema import broken) drops the
advertisement instead of advertising a method that answers `-32601`.
Notifications are optional in the extension, so their absence (§14) does
not affect advertisement.

### 3.3 Per-request declaration and `-32021` (TASKS-CAP-003/004)

- `tools/call`: `client.tasks === false` → the dispatcher never produces
  `CreateTaskResult`, whatever the catalog says (§4.2).
- `tasks/get`, `tasks/update`, `tasks/cancel`: `client.tasks === false` →
  JSON-RPC `-32021`, message `Missing required client capability`,
  `data.requiredCapabilities = { extensions: { "io.modelcontextprotocol/tasks": {} } }`,
  HTTP **400** (the same `McpProtocolError` mapping S15 uses for a
  missing elicitation mode). Evaluated **before** params validation,
  ownership and authorization, so an unauthorized principal without the
  capability learns nothing about the task.

xiNAS never answers `-32021` on `tools/call` for want of the Tasks
capability: the fallback (§12.1) is always serviceable.

---

## 4. Task eligibility and the server's choice

### 4.1 The catalog flag (TASKS-ELIG-001)

`CatalogEntry` gains:

```ts
/**
 * S16: this call CREATES (or idempotently replays) the durable xiNAS Task
 * its success body describes — the operation the handle would represent.
 * Distinct from `returns_async_task`: `tasks.cancel` returns a Task
 * envelope but represents nothing new, and must never yield a task
 * handle (cancelling one task cannot create another).
 */
creates_task?: boolean;
```

Set by the `planApply()` helper (every plan/apply entry) and on
`support.bundle`. **Not** set on `tasks.cancel`, `tasks.get`,
`tasks.wait`, `tasks.list` or any read. Catalog invariants (tested):
`creates_task ⇒ returns_async_task`; `tasks.cancel` has
`returns_async_task` and not `creates_task`.

### 4.2 Eligibility of one call

A `tools/call` is eligible for a task handle iff **all** hold:

1. `entry.creates_task === true`;
2. for a `plan_apply` entry, `args.mode === 'apply'` (a plan returns a
   Plan, not a Task);
3. the request is on the modern path (`client.era === 'modern'`);
4. `client.tasks === true` (this request's own declaration);
5. the loopback REST call succeeded (2xx) and `result.task_id` is a string;
6. the task row is readable in the store and its state is projectable
   (§6.1: `queued`, `running` or one of the four terminals);
7. `DispatcherOptions.tasks` (the S16 service, §15) is present — it is
   absent only in read-only contexts that cannot apply anyway.

Anything else falls back to the existing `CallToolResult` (§12.1).

### 4.3 Deterministic response mode (TASKS-ELIG-002)

**Rule: an eligible call always answers with the task handle**, whatever
the task's state — including an idempotent replay that finds the task
already terminal (`status: completed` or `cancelled`, `ttlMs` set,
`pollIntervalMs` omitted). The client's next `tasks/get` returns the
final `result`. A retry therefore never changes response *mode* based on
timing; only the projected `status` differs. This is the rule the
requirement recommends.

### 4.4 One durable object (TASKS-ELIG-003)

`CreateTaskResult.taskId === Task.task_id`, byte-for-byte. There is no
alias table, no in-memory task registry, no second state machine. The
projection module keeps no state at all.

### 4.5 Strong creation consistency (TASKS-ELIG-004)

The dispatcher reads the task row **after** the loopback REST apply
returned, i.e. after `TaskEngine.apply()`'s SQLite transaction committed
the row, consumed the confirmation and acquired the leases (S2 §17.2).
`tasks/get` reads the same store. A committed `queued` row is sufficient;
the response does not wait for agent acceptance. A failure before that
commit (confirmation, gate, freshness, lease conflict, dispatch admission
error) is the ordinary tool error and no handle is invented; a failure
*after* the commit (`failBeforeChange`) leaves the row `failed` and is
projected as `completed` + `isError` like any other terminal.

---

## 5. Wire contract (modern era)

### 5.1 `CreateTaskResult` (TASKS-WIRE-001)

```jsonc
{
  "resultType": "task",
  "taskId": "0192c5f6-…",           // === Task.task_id
  "status": "working",               // §6.1
  "statusMessage": "fs.create: queued, waiting for an executor slot; elapsed 0s",
  "createdAt": "2026-09-04T19:40:00.000Z",     // Task.created_at
  "lastUpdatedAt": "2026-09-04T19:40:00.000Z", // Task.updated_at
  "ttlMs": null,                     // §6.5
  "pollIntervalMs": 2000             // §6.4; absent on a terminal task
}
```

Flat: no `task`, `result`, `content` or REST envelope around it. The only
`_meta` member xiNAS adds is `io.xinas/warnings` — the REST envelope's
`warnings` array (for example `EXECUTOR_DEGRADED`), present only when the
apply returned one, so declaring the extension never costs the client the
warning the fallback result would have carried. The modern `tools/call` result union is therefore
`CallToolResult | InputRequiredResult | CreateTaskResult`, discriminated
by `resultType` (`complete` | `input_required` | `task`) — S14 §5.1 is
amended accordingly. The handler stamps `resultType: 'complete'` only on
a `CallToolResult`; the other two carry their own discriminator.

### 5.2 `tasks/get` (TASKS-WIRE-003)

Params: `{ taskId: string }` (non-empty; anything else `-32602`).
Result: `{ resultType: "complete", ...DetailedTask }` where the
status-specific shape is exactly one of:

| `status` | Extra fields |
|---|---|
| `working` | none |
| `completed` | `result`: the terminal `CallToolResult` (§6.6) |
| `failed` | `error`: the durably recorded JSON-RPC error object (§6.2) |
| `cancelled` | none |
| `input_required` | **never produced by xiNAS** (§5.3) |

`statusMessage` is present on every status (§6.3). `pollIntervalMs` is
present on `working` only. `ttlMs` is `null` on `working`, a number on
the three terminals.

### 5.3 `tasks/update` (TASKS-WIRE-004)

Params: `{ taskId: string, inputResponses: object }`; `inputResponses`
must be a plain object whose values are plain objects (the extension's
`InputResponses` map); anything else `-32602`. After capability (§3.3),
shape, ownership (§7.1) and projectability checks the server answers
`{ resultType: "complete" }` and changes nothing: no xiNAS task ever has
an outstanding task-time input request, so every key is "unknown or
already satisfied" and is ignored as SEP-2663 directs. The acceptance is
audited (§13.1) with the response **keys** only. A task in a terminal
state is still acknowledged (there is nothing to transition).

### 5.4 `tasks/cancel` (TASKS-WIRE-005)

Params: `{ taskId: string }`. After capability, shape, ownership and
cancel authorization (§7.3) the server routes the request into the
shared cancellation core (§10) and answers `{ resultType: "complete" }`
**regardless of the core's verdict**: accepted, refused at an
irreversible stage, refused because the task already finished, refused
because the executor is offline, or the task won the race and is
terminal. The acknowledgement means "the signal was accepted for
processing" and nothing more. A clearly invalid or unauthorized task is
`-32602` (§7.2).

### 5.5 Unsupported methods (TASKS-WIRE-002)

`tasks/list`, `tasks/result` and every other unknown method keep S14's
`-32601` answer. No handler for them exists, and the conformance test
pins that. `subscriptions/listen` is served since S17 for the
operational resource feeds (`xinas://events/*`); it carries no task
notifications (§14), and a `notifications.taskIds` filter is not honored.

### 5.6 Streamable HTTP request headers (TASKS-WIRE-006)

For a modern POST whose `method` is `tasks/get`, `tasks/update` or
`tasks/cancel`, `transport.ts` validates **before** calling the modern
handler (`validateTaskMethodHeaders()` in
`src/api/mcp/tasks/headers.ts`):

| Header | Rule |
|---|---|
| `Mcp-Method` | required; must equal `method` |
| `Mcp-Name` | required; after decoding the `=?base64?…?=` sentinel (UTF-8) must equal `params.taskId` |
| `MCP-Protocol-Version` | when present must equal `params._meta["io.modelcontextprotocol/protocolVersion"]`; when absent, tolerated (S14's existing tolerance for its own clients — V-08) |

A violation is HTTP **400** with JSON-RPC `-32020`, message
`Header mismatch: <header> …` (naming the header, never echoing a
`taskId` from the *body* when the header was the one that disagreed —
the message names the header value only). When `params.taskId` is not a
string the header check is skipped and the handler's `-32602` answers.
The check is *only* applied to the three task methods; `tools/call` and
the rest keep S14's behavior (V-08 deviation, `docs/TODO.md`).

**stdio adapter.** `xinas-mcp-stdio` is the HTTP client on the hop it
makes for the stdio client, so it mirrors the headers the way a
conforming Streamable HTTP client would: on every forwarded message with
a modern `_meta` it sets `MCP-Protocol-Version` from `_meta`,
`Mcp-Method` from `method`, and `Mcp-Name` from `params.name`
(`tools/call`) or `params.taskId` (task methods), base64-sentinel
encoded when not header-safe. The stdio *stream* itself carries no
headers (there is nothing to validate there). Legacy messages (no modern
`_meta`) are forwarded exactly as before.

### 5.7 Error summary

| Condition | Code | HTTP |
|---|---|---|
| task method without the Tasks capability | `-32021` + `requiredCapabilities` | 400 |
| task-method header missing / mismatched | `-32020` | 400 |
| malformed `extensions` capability object | `-32602` | 200 |
| malformed params (`taskId`, `inputResponses`) | `-32602` | 200 |
| unknown, pruned, non-projectable (`plan_only`, `imported`), other principal's, or role-insufficient (cancel) task | `-32602`, message **exactly** `task not found or expired` | 200 |
| S16 service absent (read-only api context) | `-32603` | 200 |
| `tasks/list`, `tasks/result` | `-32601` | 200 (S14 rule) |

HTTP 200 for `-32602`/`-32603`/`-32601` follows S14 §5.1 (only `-32021`
and `-32020` carry a mandated 400).

---

## 6. Projection: xiNAS Task → MCP Task

All functions are pure, live in `src/api/mcp/tasks/projection.ts`, take
the **store** `Task` (epoch-ms timestamps) plus `{ now, retentionMs }`,
and are the single source for `CreateTaskResult` and `tasks/get`.

### 6.1 State map (TASKS-MAP-001/002)

| xiNAS `state` | MCP `status` | Payload |
|---|---|---|
| `queued` | `working` | message: queued |
| `running` | `working` | message: current stage (§6.3) |
| `success` | `completed` | `result` = terminal `CallToolResult`, no `isError` |
| `failed` | `completed` | `result` with `isError: true` |
| `requires_manual_recovery` | `completed` | `result` with `isError: true` + remediation |
| `cancelled` | `cancelled` | message: cancellation summary; no `result` |
| `plan_only` | not projectable | `-32602` `task not found or expired` |
| `imported` | not projectable | `-32602` `task not found or expired` |

MCP `failed` is reserved for a JSON-RPC error that occurred while the
deferred `tools/call` itself executed. xiNAS has no such durable
condition today: every operational outcome, including `mkfs` failure,
rollback failure, manual-recovery, lease conflict and executor
unavailability, is a *tool-level* result and projects to `completed`.
The projection therefore never emits `failed`; the `FailedTask` schema
is still validated by the conformance harness so a future durable
projection error (TASKS-MAP-002 second paragraph) has a pinned shape.
A transient failure to serve one `tasks/get` (store error) is a
`-32603` for that poll and writes nothing.

### 6.2 Timestamps (TASKS-LIFE-004)

`createdAt = iso(task.created_at)`, `lastUpdatedAt = iso(task.updated_at)`.
Both come from the row; a poll never touches `updated_at` (the S16
service performs no writes on `tasks/get`). `updated_at` advances only
on the durable transitions the progress receiver and the engine already
perform.

### 6.3 `statusMessage` (TASKS-MAP-004, TASKS-FS-003)

Rendered by `statusMessageFor(task, now)` from `task.kind`,
`taskProgress(task, now)` (S2 §10.1) and the stage rows. Format
(non-normative wording, normative content):

| Situation | Message |
|---|---|
| `queued` | `<kind>: queued, waiting for an executor slot; elapsed <t>` |
| `running`, phase `preparing` | `<kind>: preparing (snapshot before change); elapsed <t>` |
| `running`, phase `executing` | `<kind>: stage '<stage_name>' (<position> of <total>) running for <stage_t>; elapsed <t>` — position/total only when known |
| … and the stage is the kind's **long stage** (§9.4) | append `; <long-stage note>` — for `fs.create`/`mkfs`: `mkfs.xfs does not report a completion percentage` |
| … and the task is past its point of no return (§9.2) | append `; cancellation can no longer safely stop <verb>` — for `fs.create`: `formatting` |
| … and `cancel_requested_at` is set | append `; cancellation requested, stopping at the next safe point` |
| `running`, phase `rolling_back` | `<kind>: rolling back after stage '<last failed stage>'; elapsed <t>` |
| `running`, phase `finalizing` | `<kind>: finalizing (snapshot after change); elapsed <t>` |
| `success` | `<kind>: succeeded in <t>` |
| `failed` | `<kind>: failed (<error_code>) after <t>: <error_message, truncated to 200 chars>` |
| `requires_manual_recovery` | `<kind>: requires manual recovery (<error_code>) after <t>: <error_message>` |
| `cancelled` | `<kind>: cancelled at a safe point after <t>; partial work rolled back` |

`<t>` and `<stage_t>` format as `Ns`, `Mm Ns`, `Hh Mm`; elapsed is
`taskProgress().elapsed_s` (`terminal_at ?? now − created_at`) so it
freezes on terminal tasks. **No percentage, ever**, and no estimated
completion. `completed_stages` is monotonic by construction (stage rows
are never demoted). Stage output appears only through the terminal
`result` (§6.6), i.e. only what the task engine durably recorded.

### 6.4 `pollIntervalMs` (TASKS-MAP-005)

| Situation | Value |
|---|---|
| terminal | omitted |
| `running` and the current executor stage is the kind's long stage (§9.4) | `5000` |
| every other non-terminal state | `2000` |

Rate limiting of faster polling is **not** implemented in this slice
(`docs/TODO.md`); polling never touches the underlying task in any case.

### 6.5 `ttlMs` (TASKS-MAP-006)

- non-terminal: `null`;
- terminal: `(terminal_at − created_at) + retentionMs`, where
  `retentionMs` is `GcSweeper.taskRetentionMs` (new read-only getter,
  default 30 days), exposed on the api context as `ctx.state.gc`.

After the GC archives and deletes the row, `tasks/get` answers `-32602`
`task not found or expired` (§5.7). The GC additionally audits each
pruned MCP-created task (§13.1).

### 6.6 Terminal `CallToolResult` (TASKS-MAP-003, TASKS-SEC-006)

`terminalResultFor(task)` returns `text({ result: publicTaskForMcp(task),
residual? })` with `isError: true` when `state ∈ {failed,
requires_manual_recovery}`. `publicTaskForMcp(task)` is `renderTask(task)`
(the shared public projection every REST read uses — one renderer) with:

- `plan_document` and `plan_document_hash` removed (internal to S15);
- every stage's `output_url` removed (a local spill path);
- nothing else altered: `task_id`, `kind`, `state`, `error_code`,
  `error_message`, `remediation_hint`, `affected_resources`, `stages[]`
  (name, status, timestamps, inline output, per-stage error), `progress`,
  `cancel_requested_at`, `cancel_refused_reason`, `metadata` all pass
  through.

`spec`, `plan_binding`, `desired_rollback` are already stripped by
`renderTask`. No confirmation identifiers, `requestState`, bearer or
loopback tokens exist on the row, so none can appear. `residual` is the
string from `residualNoteFor(task)` (§9.5) when the kind's irreversible
stage completed and the terminal state is not `success`; absent otherwise.
The renderer is deterministic — same row, same bytes — with one inherited
exception: `taskProgress()` derives `stage_elapsed_s` from `ended_at ?? now`,
so a crash-recovered terminal task whose running stage row never received
`ended_at` shows a live `stage_elapsed_s` inside `result.progress`; the REST
renderer has the same property and `elapsed_s` itself freezes at
`terminal_at`.

---

## 7. Ownership, authorization, retention

### 7.1 Principal binding (TASKS-SEC-002/004)

Every task method authenticates the request exactly as every modern
request does (`resolveIdentity`, S14 §6), then compares
`identity.principal === task.principal`. Only the creating principal may
`tasks/get`, `tasks/update` or `tasks/cancel` a task through the
extension; there is no admin override on this surface (REST/CLI keep
theirs). The check runs on every request; nothing is cached across
requests and no session exists. On the UDS without a bearer every local
caller is `mcp:local_admin` (ADR-0001), so local callers share tasks
among themselves by the node's trust model — documented, not fixable
here.

### 7.2 No existence oracle (TASKS-SEC-003)

Unknown id, pruned id, `plan_only`/`imported` id, another principal's
id, and (for `tasks/cancel`) an insufficient role all answer the same
`-32602` with the fixed message `task not found or expired` and no
`data`. Timing is not deliberately equalized (the store read is a single
indexed SELECT either way).

### 7.3 Cancel authorization (TASKS-SEC-004)

`tasks/cancel` additionally requires the current identity's role rank ≥
`operator` (the catalog `min_role` of `tasks.cancel`), evaluated from
the current request's bearer — a downgraded or revoked token fails
`resolveIdentity` or this rank check. The subsequent loopback call
(§10.1) re-applies the same RBAC in the api's middleware; the pre-check
only exists so the failure is the generic `-32602` rather than a
distinguishable `PERMISSION_DENIED`.

### 7.4 `tasks.list` (TASKS-SEC-005)

Unchanged: an ordinary read tool under its RBAC. Learning an id there
does not help — §7.1 applies to every extension method regardless of how
the id was obtained.

### 7.5 Opaque identifiers (TASKS-SEC-001)

`TaskStore.nextTaskId()` is the existing UUIDv7 generator (74 random
bits). No endpoint treats the timestamp portion as authorization.

---

## 8. Composition with the S15 MRTR confirmation

1. A confirmable `mode: "apply"` goes through `ConfirmationService.handle()`
   exactly as S15 specifies; each unfinished round answers
   `resultType: "input_required"` — never `resultType: "task"` and never a
   task in `status: "input_required"` (TASKS-MRTR-001).
2. Only the retry whose outcome is `proceed` reaches the loopback apply,
   where `TaskEngine.apply()` verifies bindings, single-use state,
   consumes the record, inserts the task and acquires leases in one
   transaction (S2 §17.2). `CreateTaskResult` is projected from the row
   that transaction committed; it is not part of the authorization
   decision (TASKS-MRTR-004).
3. Decline, cancel, expiry, malformed state, replay rejection and policy
   failure return their existing `complete` tool errors and create no
   Task and no handle (TASKS-MRTR-003).
4. The capabilities used are the **final retry's** — both the elicitation
   mode S15 needs and `io.modelcontextprotocol/tasks` are read from that
   request's `_meta` (TASKS-MRTR-002). A client may declare the Tasks
   extension on the first round and not on the retry (→ fallback), or
   the reverse (→ handle); the confirmation state is unaffected because
   it never records capabilities (S15 §4.8).
5. Confirmation ids, `requestState`, rounds and replay protection stay in
   the `mcp_confirmations` table; task ids stay in `tasks`; the only link
   is `consumed_task_id` (S2 §17.1). Nothing in S16 writes either table.

S15 §4.7's future-work wording is replaced by the amendment in that spec
pointing here.

---

## 9. Long-running filesystem creation

### 9.1 `fs.create` is rollback-unsupported (TASKS-SPEC-006, D-07)

`fsCreateProvider` returns `rollback_model: 'unsupported'` for **every**
create. `risk_level` is unchanged: `destructive` with `force: true`,
`non_disruptive` otherwise — the latter is honest only because
`preflight` re-proves live (blkid) that no filesystem exists, not because
formatting could be undone. Consequences:

- S15 `confirmationModeFor()` maps `rollback_model: unsupported` → `url`,
  so **every** `filesystems.create` apply over MCP is confirmed
  out-of-band by a xiNAS operator (S15 §3.2). This is deliberate
  (acceptance #12): a format is irreversible whether or not something was
  there before.
- The engine's `dangerous` gate is unchanged (still only `force: true`).
- REST, `xinasctl` and the TUI see the new value in the Plan envelope;
  none of them branches on `rollback_model` today.
- ADR-0007 §Create and S5 §4 are amended; the provider test and the
  S15 confirmation tests that relied on non-force create being form-mode
  are updated.

### 9.2 Point of no return (TASKS-FS-004, D-08)

**Executor declaration.** `Executor` gains
`readonly irreversible_from?: string` — the name of the first stage after
whose *start* the operation can no longer be safely unwound.
`makeFsCreateExecutor` declares `irreversible_from: 'mkfs'`. The stage
name is shared with the api through
`src/lib/tasks/irreversible-stages.ts`:

```ts
/** Per operation kind: the stage at whose START the operation becomes irreversible (S16 §9.2). */
export const IRREVERSIBLE_STAGE_BY_KIND: Readonly<Record<string, string>> = { 'fs.create': 'mkfs' };
/** Human verb for the irreversible stage, used in statusMessage. */
export const IRREVERSIBLE_STAGE_VERB: Readonly<Record<string, string>> = { 'fs.create': 'formatting' };
```

Both sides read the table (the executor to declare, the projection to
render), so the name cannot drift — the `stage-names.ts` pattern.

**Runner.** `InflightTask` gains `currentStage?: string` and
`irreversibleStageStarted?: string` (the stage name, set once). Immediately
after the boundary check — synchronously, before the `stage_started` event
is published and before `stage.run(ctx)` is awaited — the runner sets
`currentStage = stage.name` and, when `stage.name === executor.irreversible_from`,
`irreversibleStageStarted = stage.name`. `requestCancel(taskId)` now returns
`{ accepted: true } | { accepted: false; reason: 'not_found' } |
{ accepted: false; reason: 'irreversible_stage_started'; stage: string }`
and **does not set the flag** in the last case. Because Node runs the
RPC handler and the runner on one thread and no `await` separates the
boundary check from the mark, a cancel is either accepted before the
boundary check (and honored there, before any formatting) or refused from
the mark on — including one that lands while the `stage_started` event is
being published. There is no window in which the flag is set while `mkfs`
runs, so the post-`mkfs` boundary checks and stage-throw attribution can
never produce `cancelled` for a formatted device. The two `checkCancelled()`
calls after `mkfs` in `fs-executor.ts` are removed as dead code; the
`preflight` and `mkfs` ones stay as defense in depth (they catch a flag
accepted before the boundary check, never one set after the mark).

**Agent RPC.** `task.cancel` answers
`{ cancel_requested: false, reason: 'irreversible_stage_started', stage }`
in the refused case; `task.list_inflight` additionally reports
`current_stage` and `past_point_of_no_return` (`irreversibleStageStarted !==
undefined`; diagnostics only).

**Engine (the shared core, §10).** On that reply `TaskEngine.cancel()`
writes `cancel_refused_reason: 'irreversible_stage_started'` under the
running-state guard (as `agent_not_found` already does) and throws
`CONFLICT` with `details: { reason: 'irreversible_stage_started', stage }`
and the remediation `"the operation passed its point of no return; let it
finish and re-observe"`. The REST route therefore answers **409** and the
`tasks.cancel` tool the corresponding tool error; `tasks/cancel` (§5.4)
still acknowledges. ADR-0012 and S2 §16.3 are amended; `api-v1.yaml`
gains the value in the `cancel_refused_reason` description (free-form
string today — additive, no schema change).

### 9.3 What the client sees (TASKS-FS-001/002/003)

1. `filesystems.create` `mode: "plan"` → Plan with
   `rollback_model: "unsupported"`.
2. `mode: "apply"` with plan binding, idempotency key, elicitation `url`
   and the Tasks capability → `input_required` (URL) → operator approves
   out-of-band → retry → `CreateTaskResult` `working`, without waiting
   for `mkfs.xfs`. The original `tools/call` waits only for
   authentication, the confirmation round, the apply transaction and the
   bounded inline dispatch admission (S2 §5.3) — never for a stage.
3. `tasks/get` polls: `queued` → `preflight` → `mkfs` (5 s interval, the
   percentage disclaimer) → `install_unit` → `mount` → `verify` →
   `completed` with the terminal `result`.
4. No transport, tool or client timeout reaches the task after step 2:
   the api holds no reference to the client after answering, and the
   agent runs the executor independently of any api connection
   (TASKS-LIFE-002).

### 9.4 Long stage

`LONG_STAGE_BY_KIND` in the same shared module (`{ 'fs.create': 'mkfs' }`,
with the note `mkfs.xfs does not report a completion percentage`)
drives the slower `pollIntervalMs` and the disclaimer (§6.3, §6.4). It
coincides with the irreversible stage for `fs.create` but is a separate
concept (a long stage need not be irreversible).

### 9.5 Failure after formatting (TASKS-FS-005)

`mkfs` succeeded and a later stage failed → the runner's existing rollback
removes the unit and unmounts; the terminal is `failed`
(`FAILED_PARTIAL_ROLLED_BACK`) or `requires_manual_recovery` — never
`cancelled` (the flag cannot be set, §9.2). The projection is `completed`
with `isError: true`, and `residualNoteFor(task)` adds:

> `stage 'mkfs' completed before the failure and its effect was not undone:
> /dev/… may carry an unmanaged XFS filesystem. Re-observe first
> (filesystems.list, disks.list, blkid on the device) and decide from the
> observation; do not reformat the device blindly.`

The device path is recovered from the `mkfs.xfs …` line in the `mkfs`
stage's durable `output_inline`; when it is absent the note says "the
target device" instead. The note is derived at
render time from durable rows (the `mkfs` stage row status), not from
executor memory.

### 9.6 Other executors

`xiraid-array-executor.ts` also throws `checkCancelled()` mid-flight and
has no declared point of no return; `xicli raid create` semantics were not
investigated here. Recorded in `docs/TODO.md`; until then those
operations keep ADR-0012's generic stage-boundary rule.

---

## 10. Cancellation

### 10.1 One core (TASKS-CANCEL-001)

`TaskEngine.cancel()` remains the only cancellation logic. Three callers:

| Caller | Path |
|---|---|
| REST `POST /tasks/{id}/cancel` | route → engine |
| MCP tool `tasks.cancel` | `callTool` → loopback → route → engine |
| MCP `tasks/cancel` | S16 service → `callTool('tasks.cancel', { id })` → loopback → route → engine |

The S16 service reuses `callTool` deliberately: the loopback carries the
caller's real principal and role, `rbacMiddleware` enforces
`min_role: operator`, and the audit middleware writes the one
operational `http.POST./tasks/{id}/cancel` row — no second flag, no
second state machine, no second audit path.

### 10.2 Mapping the core's answer to the protocol (TASKS-CANCEL-002/003)

| Tool result from `callTool('tasks.cancel')` | `tasks/cancel` answer | Audit (§13.1) |
|---|---|---|
| success (200 row: accepted, or already `cancelled`) | `{ resultType: "complete" }` | `cancel_requested` `outcome: accepted` |
| `CONFLICT` `irreversible_stage_started` | ack | `cancel_refused_irreversible` (+ stage) |
| `CONFLICT` `not_cancellable` / `agent_not_found` / `dispatch_in_flight` | ack | `cancel_requested` `outcome: refused`, reason |
| `INTERNAL` `EXECUTOR_UNAVAILABLE` | ack | `cancel_requested` `outcome: undelivered` |
| `NOT_FOUND` (row pruned between the ownership read and the loopback) | `-32602` | `read_denied` `reason: unknown_or_pruned` |
| `PERMISSION_DENIED` (cannot happen after §7.3; defensive) | `-32602` | `read_denied` `reason: role` |

The client learns the outcome from a later `tasks/get`: `working`
(refused or still stopping), `completed` (won the race, or refused and
finished), or `cancelled` (honored) — TASKS-CANCEL-003.

### 10.3 Truthfulness (TASKS-CANCEL-004)

ADR-0012 §1 stands: xiNAS `cancelled` means stopped at a safe point *and*
unwound. §9.2 is what keeps that true for `fs.create`; a rollback failure
during an honored cancel still yields `requires_manual_recovery`
(projected `completed` + `isError`).

---

## 11. Restart, idempotency, lifecycle

- **Restart survival (TASKS-LIFE-001).** The handle is the row. After an
  api restart, `reconcile()` (S2 §9) leaves a `running` task the agent
  still reports in flight untouched; `tasks/get` returns the same
  `taskId` with the current projection. The agent's `mkfs` keeps running
  through the restart; its next progress event lands on the restarted api
  (the e2e in §16.4 restarts the api while `mkfs` is blocked).
- **Client disconnect (TASKS-LIFE-002).** Nothing in the api is tied to
  the client connection once the JSON response is written; the /mcp
  transport runs in JSON response mode with no server-push stream to
  close. Cancellation happens only through §10.
- **Idempotent replay (TASKS-LIFE-003, TASKS-FALLBACK-003).** The
  replayed `tools/call` reaches the same `TaskEngine.apply()` idempotency
  SELECT (S2 §17.2 step 1) and returns the existing row: no second
  format, no second confirmation consumption, no second lease, no new
  audit operation, no timestamp reset. Switching the Tasks capability
  between retries changes only the projection of that one response
  (§4.3 / §12.1). A reused key with different input keeps its `CONFLICT`.

---

## 12. Compatibility fallback and client interoperability

### 12.1 Clients without the extension (TASKS-FALLBACK-001)

Byte-identical to today: `text({ result: <REST Task>, warnings?, next: {
tool: 'tasks.wait', args: { id, timeout_s: 25 }, note } })` with
`resultType: 'complete'`. The original `tools/call` returns as soon as
the apply transaction and inline dispatch admission complete (S2 §5.3);
the client follows with the ordinary `tasks.wait` tool.

### 12.2 Legacy era (TASKS-FALLBACK-002)

`client.tasks` is `false` on the legacy path, and the legacy SDK server
never routes `tasks/*` (the SDK answers `-32601`). `buildMcpServer`'s
handler throws `unreachable` if a `CreateTaskResult` ever reaches it,
exactly as it does for `input_required`. S15's legacy apply denial is
unchanged.

### 12.3 Client guidance (S8 amendment, TASKS-SPEC-007)

S8 §3 gains §3.2 "Following a long operation with the Tasks extension":
declare the capability on the apply retry; persist `taskId` for
reconnect; honor the latest `pollIntervalMs`; treat `cancel` as a request
whose outcome must be read back; expect the terminal `result` to be the
same public Task the REST API returns; an adapter that hides tasks from
its caller polls internally and returns the final `CallToolResult`.

### 12.4 Named clients (TASKS-CLIENT-002/003)

S16 names **no** supported native Tasks client. Claude Code 2.1.259 and
Codex 0.136.0 use §12.1 until a captured end-to-end run
(`hardware-smoke-runbook.md` §5b, "MCP Tasks" step) proves the five
behaviors the requirement lists. The automated stand-in is the
hand-rolled conformance harness (§16.1), which speaks the released
schema byte-for-byte.

### 12.5 Timeouts (TASKS-CLIENT-004)

A client's tool-call timeout bounds only the wait for
`CreateTaskResult` / the fallback result. xiNAS never reads a client
timeout and never applies one to a task.

---

## 13. Audit and metrics

### 13.1 Audit events (TASKS-AUD-001)

`src/api/mcp/tasks/audit.ts` — `queueTaskEvent(audit, event, payload)`;
kind `mcp.task.<event>`, `client_type: 'mcp'`, `task_id` and
`operation_id = task_id` set so `/audit?task_id=` finds them,
`request_id` = a fresh UUID, `parameters_hash` over the canonical payload,
`result_hash` over the event name — the S15 shape. Payload: `task_id`,
`principal`, `kind` (operation kind), `tool_name` when known,
`correlation_id` (the server-minted per-HTTP-request id, never the
JSON-RPC id), plus per-event fields:

| Event | When | Extra |
|---|---|---|
| `handle_returned` | `CreateTaskResult` produced | `state` (xiNAS), `status` (MCP) |
| `read_denied` | `tasks/get`/`update`/`cancel` refused with `-32602` | `reason: unknown_or_pruned \| not_projectable \| not_owner \| role`; `requested_by` (the caller); **never** the owning principal, kind or state of the task |
| `update_accepted` | `tasks/update` acknowledged | `response_keys: string[]` (keys only) |
| `cancel_requested` | `tasks/cancel` reached the core | `outcome: accepted \| refused \| undelivered`, `reason?` |
| `cancel_refused_irreversible` | core answered `irreversible_stage_started` | `stage` |
| `pruned` | `GcSweeper.sweepTasks()` deleted a task whose `client_type` is `mcp` | `terminal_at`, `state` |

The `GcSweeper` gains an optional `audit?: AuditAppender` (wired by
`openStateStore`) for the last row. None of these duplicates the
operational `http.*` row the loopback apply/cancel already writes, and
none carries confirmation state, `requestState`, tokens or plan content.

### 13.2 Metrics (TASKS-AUD-002)

`src/api/mcp/tasks/metrics.ts`:

```ts
export interface TasksMetrics {
  handleReturned(kind: string): void;
  methodCall(method: 'tasks/get' | 'tasks/update' | 'tasks/cancel', outcome: 'ok' | 'protocol_error'): void;
  terminalProjected(state: string): void;          // xiNAS terminal state
  cancelRequested(outcome: 'accepted' | 'refused' | 'undelivered'): void;
  cancelRefusedIrreversible(): void;
  timeToTerminal(kind: string, seconds: number): void;
}
export const noopTasksMetrics: TasksMetrics;
```

Labels are bounded (`kind` is a catalog constant, `method`/`outcome`/`state`
are enums); no task id, principal, device, mountpoint or idempotency key
is ever a label. The service takes the interface with the noop default.
The Prometheus registration (`registryTasksMetrics(registry)`, the
active-projected-tasks gauge via `gaugeCollect` over
`TaskStore.countByState`) lands with S15 Task 13's registry; until then
this is the recorded deferral in `docs/TODO.md`.

---

## 14. Notifications (deferred, D-04)

Polling via `tasks/get` is the mandatory completion mechanism on both
transports. `subscriptions/listen` and `notifications/tasks` are not
implemented and not advertised (the extension's capability object has no
sub-flag for them; their absence is a documented gap). `docs/TODO.md`
records what "done" requires: per-task authorization on subscribe,
resume after transport interruption, the complete status-specific shape
on every notification, and no unrelated progress/message notifications
on the task stream. S17 provides the `subscriptions/listen` SSE/stdio
transport for resource feeds and deliberately emits no
`notifications/tasks` (ADR-0010, S17 decision 7); reusing that transport
for task status requires exactly this contract first.

---

## 15. Wiring (files)

| File | Change |
|---|---|
| `src/lib/tasks/irreversible-stages.ts` | **new** — `IRREVERSIBLE_STAGE_BY_KIND`, `IRREVERSIBLE_STAGE_VERB`, `LONG_STAGE_BY_KIND`, `LONG_STAGE_NOTE` |
| `src/agent/task/types.ts` | `Executor.irreversible_from?` |
| `src/agent/task/runner.ts` | `InflightTask.currentStage`, `irreversibleStageStarted`; `requestCancel()` returns a verdict |
| `src/agent/task/fs-executor.ts` | `irreversible_from: 'mkfs'`; drop the two post-`mkfs` `checkCancelled()` |
| `src/agent/fs/fake-host.ts` | `mkfsXfs`: device path ending `-block` or `_block` waits for `<dir>/mkfs-release` (poll 50 ms; 60 s cap); `releaseMkfs()` / `resetMkfsGate()` on the handle |
| `src/agent/rpc/methods/task.ts` | `task.cancel` `irreversible_stage_started` reason; `list_inflight` diagnostics |
| `src/api/tasks/engine.ts` | `cancel()`: the new refusal branch |
| `src/state/gc.ts` | `get taskRetentionMs()`; optional `audit` + `pruned` events |
| `src/state/index.ts` | pass `audit` into `GcSweeper` |
| `src/api/plan/providers/filesystem.ts` | `fs.create` `rollback_model: 'unsupported'` |
| `src/api/mcp/catalog.ts` | `creates_task` |
| `src/api/mcp/tasks/capability.ts` | `TASKS_EXTENSION_ID`, `parseTasksCapability()`, `missingTasksCapability()` (the `-32021` error) |
| `src/api/mcp/tasks/schema.ts` | zod schemas pinned to the released `2026-07-28` extension: `TaskStatusSchema`, `TaskSchema`, `CreateTaskResultSchema`, `DetailedTaskSchema` (discriminated on `status`), `GetTaskParamsSchema`, `UpdateTaskParamsSchema`, `CancelTaskParamsSchema`, `AckResultSchema`, `TASKS_EXTENSION_SCHEMA_REVISION = '2026-07-28'` |
| `src/api/mcp/tasks/projection.ts` | `mcpStatusFor`, `statusMessageFor`, `pollIntervalFor`, `ttlMsFor`, `publicTaskForMcp`, `residualNoteFor`, `terminalResultFor`, `projectTask`, `createTaskResultFor` |
| `src/api/mcp/tasks/headers.ts` | `validateTaskMethodHeaders()`, `decodeMcpHeaderValue()`, `encodeMcpHeaderValue()`, `TASK_METHODS` |
| `src/api/mcp/tasks/audit.ts` | `queueTaskEvent()` |
| `src/api/mcp/tasks/metrics.ts` | `TasksMetrics`, `noopTasksMetrics` |
| `src/api/mcp/tasks/service.ts` | `McpTasksService` — `get()`, `update()`, `cancel()`, `handleFor()` (post-apply projection + audit); deps `{ store, retentionMs, audit?, metrics?, now, cancelTool }` |
| `src/api/mcp/tasks/index.ts` | `TASKS_EXTENSION_READY`, re-exports |
| `src/api/mcp/results.ts` | `CreateTaskToolResult` type, `isCreateTaskResult()` |
| `src/api/mcp/confirmation/service.ts` | `McpClientInfo.tasks: boolean` |
| `src/api/mcp/dispatch.ts` | `DispatcherOptions.tasks?: McpTasksService`; `callTool` eligibility + projection; legacy `unreachable` guard |
| `src/api/mcp/discover.ts` | `extensions` advertisement |
| `src/api/mcp/modern.ts` | route `tasks/get`/`update`/`cancel`; pass `CreateTaskResult` through unstamped |
| `src/api/mcp/transport.ts` | parse the Tasks capability (with `-32602` on malformed), header validation for task methods, `-32020` → 400 |
| `src/api/context.ts` | `mcpTasks?: McpTasksService` |
| `src/api/app.ts` | build the service when `ctx.tasks` exists |
| `src/mcp-stdio.ts` | header mirroring |
| `docs/control-path/api-v1.yaml` | description text only: `cancel_refused_reason` values; cancel 409 reasons |

---

## 16. Tests

### 16.1 Unit (`npm test`)

- `tasks/capability.test.ts`: the §3.1 table; `-32021` error object shape.
- `tasks/schema.test.ts`: every fixture in Appendix B validates; a
  `resultType: 'task'` nested under `task` fails; `ttlMs: undefined`
  fails (must be `null` or number); `status: 'input_required'` without
  `inputRequests` fails; a `2025-11-25`-style task (`ttl` instead of
  `ttlMs`) fails — the pin against silent vocabulary drift
  (TASKS-TEST-007).
- `tasks/projection.test.ts`: every row of §6.1 (both non-projectable
  states), `statusMessage` for each situation in §6.3 including the
  `mkfs` disclaimer and the past-point-of-no-return clause, no digit
  followed by `%` in any message, `pollIntervalMs` per §6.4, `ttlMs` per
  §6.5 with a fixed clock, stable timestamps across two renders,
  `publicTaskForMcp` strips `plan_document*` and `output_url` and nothing
  else, `residualNoteFor` only when the irreversible stage succeeded and
  the terminal is non-success, `terminalResultFor` `isError` per state.
- `tasks/headers.test.ts`: required/mismatch/base64-sentinel/absent
  protocol version cases; non-task methods untouched.
- `mcp-catalog.test.ts`: the §4.1 invariants.
- `mcp-dispatch.test.ts`: eligibility matrix (§4.2) with a fake loopback
  and a fake service; fallback byte-identical when the capability is
  absent; `tasks.cancel` never yields a handle; legacy `unreachable`.
- `agent/task/runner.test.ts`: cancel accepted before the irreversible
  stage → `cancelled` before it runs; cancel requested while the
  irreversible stage runs → refused, flag unset, task completes; the
  refusal shape.
- `agent/task/fs-create-executor.test.ts`: `irreversible_from === 'mkfs'`;
  the fake host's `-block`/`_block` gate releases on the file; and the
  runner-level §9.5 proof — a cancel refused while `mkfs` is blocked, then
  a `mount` failure → `failed` / `FAILED_PARTIAL_ROLLED_BACK` (never
  `cancelled`), exactly one `mkfs.xfs`, the unit removed, `blkid` still
  `xfs`.
- `api/tasks/cancel.test.ts`: `irreversible_stage_started` → guarded
  metadata write + `CONFLICT` details.
- `api/plan/filesystem-provider.test.ts`: `rollback_model` is
  `unsupported` with and without `force`.
- `state/gc.test.ts` (extend): `taskRetentionMs` getter; `pruned` audit
  rows for `client_type: mcp` only.
- `mcp-stdio.test.ts` (extend): header mirroring, sentinel encoding.

### 16.2 Integration (in-process api, real SQLite — `mcp-tasks.test.ts`)

Mirrors `mcp-confirmation.test.ts` (hand-rolled JSON-RPC client, mock
agent). Cases, each named after the requirement it proves:

- discover advertises the extension under `capabilities.extensions`, and
  `tasks/get` answers for it (advertised ⇒ served).
- capability present → `resultType: 'task'`, `taskId === result.task_id`
  from a parallel REST read, `createdAt`/`lastUpdatedAt` equal the REST
  row; absent → the exact fallback shape with the `next` hint; the same
  idempotency key across ext → fallback → ext retries returns one task
  and one apply audit row.
- `tasks/get` without the capability → `-32021`/400 with the exact
  `requiredCapabilities`; with it → `working` then `completed` with
  `result.content[0].text` parsing to the public Task, `isError` per
  state (drive `failed` and `requires_manual_recovery` through the mock
  agent's terminal events).
- `plan_only` (a plan id) and a synthetic `imported` row → `-32602`
  `task not found or expired`; a second principal → identical error
  bytes; a viewer `tasks/cancel` → identical bytes; a made-up UUID →
  identical bytes.
- capability from one request is not cached: a `tasks/get` with the
  capability then one without → `-32021`.
- `tasks/update` → `{ resultType: 'complete' }`, no row change
  (`updated_at` equal before/after), audit `update_accepted` with keys.
- `tasks/cancel` on a running mock-agent task → ack; the row shows
  `cancel_requested_at`; on a terminal task → ack; on an offline agent →
  ack; audit outcomes per §10.2.
- headers: `tasks/get` with a wrong `Mcp-Name` → `-32020`/400; missing
  `Mcp-Method` → `-32020`/400; base64 sentinel accepted;
  `MCP-Protocol-Version` mismatch → `-32020`; `tools/call` without any
  header still works.
- `tasks/list` and `tasks/result` → `-32601` (S17's `subscriptions/listen` is a different method and is not asserted here); the legacy SDK client
  never sees `resultType: 'task'` and its `tasks/get` is `-32601`.
- MRTR: the first round (`input_required`) creates no task row even with
  the capability declared; decline creates none; the accepted retry
  produces the handle; the `mcp_confirmations` row is `consumed` with
  `consumed_task_id === taskId`.
- `tasks/get` polling does not advance `updated_at` and writes no audit
  row beyond the S16 events.

### 16.3 Contract (`npm run test:contracts`)

`contracts/mcp-tasks-extension.test.ts`: the Appendix B fixtures validate
against `schema.ts`; the served `server/discover` result still validates
against the vendored `2026-07-28` core `DiscoverResult` shape with the
`extensions` map present.

### 16.4 e2e (`npm run test:e2e`, `mcp-tasks-fs-create.test.ts`)

Fixture mode with the fake `FsHost`, two real processes, `mcp.allow_apply:
true`, a second admin token as the approver (S15's default
`approver_policy: distinct_principal`), and the create targeting
`/dev/xi_data_block` — xiRAID array names match `^[A-Za-z0-9_]{1,28}$`
(`lib/xiraid/schema.ts` `NAME_RE`), so the blocked device carries the
`_block` suffix; the fake host's gate accepts both `-block` and `_block`:

1. plan → `rollback_model: 'unsupported'`; apply with URL elicitation +
   Tasks capability → `input_required` (url) → the second admin approves
   over REST (`POST /api/v1/mcp/confirmations/{id}/approve` with
   `acknowledge: "ROLLBACK IS NOT SUPPORTED"`, S15's phrase for a
   rollback-unsupported record) → retry → `CreateTaskResult` within the
   test's normal request timeout while `mkfs` stays blocked.
2. `tasks/get` → `working`, message names `mkfs`, `(2 of 5)`, an elapsed
   time, the percentage disclaimer, the cancellation clause;
   `pollIntervalMs === 5000`; no `%`.
3. `tasks/cancel` → ack; REST shows `cancel_refused_reason:
   'irreversible_stage_started'`; the audit has
   `mcp.task.cancel_refused_irreversible`; `tasks/get` still `working`.
4. close the client's HTTP agent; SIGTERM the api; restart it on the same
   db and socket; `waitForAgentReady`; `tasks/get` → same `taskId`, still
   `working`, `createdAt` unchanged.
5. release `mkfs` (write `mkfs-release`); poll `tasks/get` through
   `install_unit`/`mount`/`verify` to `completed`; `result` parses to a
   public Task with `state: 'success'`, no `plan_document`, no
   `output_url`; the fake host recorded exactly one `mkfs.xfs`;
   `ttlMs === (terminal_at − created_at) + 30 d`.
6. queued cancel: a second blocked create (`/dev/xi_data2_block`, no log
   device) holds the single pool slot (`tasks.max_inflight: 1`); a
   `support.bundle` handle is therefore `queued`; `tasks/cancel` on it →
   `cancelled` (engine-local), and the fake host recorded no second
   `mkfs.xfs`.
7. failure after formatting is proven in process rather than across two
   processes (a `-fail` mount unit is unreachable through the real plan
   path — mountpoints escape `-` as `\x2d`): `fs-create-executor.test.ts`
   drives `TaskRunner` over the real executor and fake host with a blocked
   `mkfs` and a failing `mount` — a cancel during `mkfs` is refused with
   `irreversible_stage_started`, the terminal is `failed` /
   `FAILED_PARTIAL_ROLLED_BACK` (never `cancelled`), one `mkfs.xfs` ran, the
   unit was removed and `blkid` still reports `xfs`; the projection of that
   outcome (`completed` + `isError` + the residual note) is
   `tasks-projection.test.ts`.

### 16.5 Gates

Everything in CLAUDE.md §Verification, including
`npm run build && npm run test:e2e`.

---

## 17. Acceptance criteria → evidence

| # | Criterion (requirement §18) | Evidence |
|---|---|---|
| 1 | discover advertises the extension | §16.2 first case |
| 2 | eligible modern request with capability → durable `CreateTaskResult` | §16.2, §16.4 step 1 |
| 3 | no capability → never `resultType: "task"` | §16.2 fallback case, §16.1 dispatch matrix |
| 4 | `taskId` is `task_id` | §16.2 (REST parallel read) |
| 5 | `tasks/get`/`update`/`cancel` conform to the released schema | §16.1 schema tests, §16.3 |
| 6 | no `tasks/list`/`tasks/result` | §16.2 |
| 7 | fallback `task_id` + `tasks.wait` works | §16.2 fallback case (byte-identical to the existing S8 test expectations) |
| 8 | confirmation finishes before task creation, consumed atomically | §16.2 MRTR case + S15's own suite |
| 9 | long `mkfs.xfs` does not hold `tools/call` | §16.4 step 1 |
| 10 | polling survives client and api restart | §16.4 step 4 |
| 11 | honest `mkfs` progress, no percentage | §16.4 step 2, §16.1 projection |
| 12 | every `fs.create` plan `rollback_model: unsupported` → out-of-band confirmation | §16.1 provider test, §16.4 step 1 |
| 13 | cancel after `mkfs` starts cannot yield a misleading `cancelled` | §16.4 steps 3 and 7 (runner-level); §16.1 runner |
| 14 | xiNAS operational failures map to `completed` + `isError: true` | §16.2; §16.4 step 7 (projection-level) |
| 15 | principal-bound, no cross-principal metadata | §16.2 security cases |
| 16 | capability switching / replay never duplicates execution | §16.2 idempotency case |
| 17 | no client named supported without a captured run | §12.4; runbook §5b step |

---

## 18. Repository guidance and deferrals (TASKS-SPEC-008)

- `CLAUDE.md` §MCP surface: add S16 to the live contract list.
- `docs/TODO.md`: **add** (a) task notifications (§14), (b) S16 metrics
  registration (§13.2, blocked on S15 Task 13), (c) modern-era header
  validation on non-task methods (V-08), (d) points of no return for
  other executors (§9.6), (e) poll rate limiting (§6.4), (f) Claude Code /
  Codex Tasks interop capture (§12.4). **Keep** the two existing task
  entries (no live stage output; no percentage) — S16 does not resolve
  them. **Remove** nothing else.
- `api-v1.yaml`: descriptive text only (`cancel_refused_reason` values;
  the cancel route's 409 reasons). The task and apply shapes are
  unchanged; extension shapes are JSON-RPC contracts and stay out of the
  OpenAPI document.
- `hardware-smoke-runbook.md` §5b: an "MCP Tasks" step listing the five
  behaviors that must be captured before a client is named.
- `CHANGELOG.md` Unreleased: one entry.
- Commit trailer: every commit touching `xiNAS-MCP/src/` carries
  `Requires-Rebuild: xinas_node_build`.

---

## 19. Risks

- **URL-mode confirmation for every filesystem create over MCP.** A
  human operator with a second credential (or the break-glass UDS path)
  must approve each create. This is the cost of an honest rollback model;
  the TUI/REST/CLI paths are unaffected.
- **Header strictness on task methods only.** A client that mirrors
  headers on nothing will succeed on `tools/call` and fail on `tasks/get`
  with `-32020`. The error names the header, and the stdio adapter
  mirrors them, so the failing client is a third-party HTTP client that
  is non-conforming anyway.
- **Shared local principal.** All UDS callers without a bearer are
  `mcp:local_admin` and can see each other's tasks — inherent to
  ADR-0001; tokens separate principals where that matters.
- **`pruned` audit volume.** One row per pruned MCP task, monthly — negligible.

---

## Appendix A — Requirements validation (2026-09-04)

Each requirement ID from `s16-mcp-tasks-requirements.md`, with the verdict
after checking the upstream sources (§2) and the code on the S15 branch.

| ID | Verdict | Notes |
|---|---|---|
| TASKS-SPEC-001 | done | this document |
| TASKS-SPEC-002 | done | ADR-0010 §"MCP Tasks extension (S16)" — nine points recorded |
| TASKS-SPEC-003 | done | S14 §4 (`extensions`), §5.1 (result union, `resultType: task`), new §5.2 (task methods, `-32021`, `-32020`, headers, legacy absence, released schemas) |
| TASKS-SPEC-004 | done | S15 §4.7 replaced with the five-step sequencing |
| TASKS-SPEC-005 | done | S2 §4 note, §16.3/§16.4 refusal, new §18 MCP projection |
| TASKS-SPEC-006 | done — **confirmed as real defects** | V-15, V-16; fixed by §9.1, §9.2; ADR-0007 §Create amended too (the requirement listed S5 only; ADR-0007 is S5's contract and said the same wrong thing) |
| TASKS-SPEC-007 | done | S8 §3.2, §4.1 row, §7 scenario |
| TASKS-SPEC-008 | done | §18 |
| TASKS-CAP-001 | valid | shape confirmed (V-01); the "non-object → invalid params" rule is stricter than the schema (which merely types it) and is adopted |
| TASKS-CAP-002 | valid | §3.2; readiness is a static constant — there is no runtime health to observe for pure handlers |
| TASKS-CAP-003 | valid | §3.1; S15 already has the per-request precedent |
| TASKS-CAP-004 | valid | §3.3; `-32021` → 400 already implemented for elicitation |
| TASKS-ELIG-001 | valid — **`returns_async_task` insufficient confirmed** (V-13) | §4.1 `creates_task` |
| TASKS-ELIG-002 | valid; the recommended rule adopted | §4.3 |
| TASKS-ELIG-003 | valid | §4.4 |
| TASKS-ELIG-004 | valid | §4.5; the REST apply already commits before responding |
| TASKS-FALLBACK-001/002/003 | valid | §12.1, §12.2, §11 |
| TASKS-WIRE-001 | valid (V-02) | §5.1 |
| TASKS-WIRE-002 | valid (V-06) | §5.5 |
| TASKS-WIRE-003 | valid (V-03) | §5.2; `failed` never produced (§6.1) |
| TASKS-WIRE-004 | valid (V-04) | §5.3 |
| TASKS-WIRE-005 | valid (V-04) | §5.4 |
| TASKS-WIRE-006 | valid with one clarification (V-08) | the core spec makes `Mcp-Method` required on **all** modern requests and `-32020` the mismatch code; the requirement's "according to S14" for the protocol-version header resolves to "match when present" because S14 never validated it; the stdio adapter must mirror the headers on its HTTP hop (the requirement's "does not apply to the adapter's internal stream" is read as the stdio stream, not the HTTP hop) |
| TASKS-MAP-001 | valid (V-11) | §6.1 |
| TASKS-MAP-002 | valid | §6.1 — no durable JSON-RPC-error condition exists in xiNAS today, so `failed` is schema-pinned but never emitted |
| TASKS-MAP-003 | valid (V-17) | §6.6 — one renderer, two extra fields stripped for MCP |
| TASKS-MAP-004 | valid | §6.3 |
| TASKS-MAP-005 | valid (V-09) | §6.4; rate limiting deferred |
| TASKS-MAP-006 | valid (V-12) | §6.5; the retention getter is new |
| TASKS-FS-001/002 | valid | §9.3; the e2e proves the unbounded stage |
| TASKS-FS-003 | valid | §6.3 |
| TASKS-FS-004 | valid — **the current runner cannot satisfy it** (V-16) | §9.2 |
| TASKS-FS-005 | valid | §9.5 |
| TASKS-MRTR-001…004 | valid (V-07) | §8; S15 §8.3 already does the atomic handoff |
| TASKS-SEC-001 | valid | §7.5 |
| TASKS-SEC-002 | valid (V-18) | §7.1; note the shared UDS principal |
| TASKS-SEC-003 | valid | §7.2 |
| TASKS-SEC-004 | valid | §7.1, §7.3 |
| TASKS-SEC-005 | valid | §7.4 |
| TASKS-SEC-006 | valid | §6.6 |
| TASKS-CANCEL-001 | valid | §10.1 — routing through `callTool('tasks.cancel')` is what makes the three callers one core |
| TASKS-CANCEL-002/003/004 | valid | §10.2, §10.3 |
| TASKS-LIFE-001…004 | valid | §11, §6.2 |
| TASKS-NOTIFY-001/002 | valid | §14 |
| TASKS-AUD-001 | valid (V-20) | §13.1; "task expired or pruned" is emitted by the GC, the only place that knows |
| TASKS-AUD-002 | valid as SHOULD (V-21) | §13.2 interface now; registration deferred |
| TASKS-CLIENT-001 | valid | §16.1/§16.2 harness; the extension schema is pinned in `schema.ts` |
| TASKS-CLIENT-002/003/004 | valid (V-22) | §12.4, §12.5 — no support claim |
| TASKS-TEST-001…007 | valid | §16 |
| Appendix A D-01…D-10 | all adopted | D-10 confirmed against the SDK notes (V-10) |
| Appendix B baseline | all rows re-verified | one correction: the repo's SDK is `1.27.1` under `^1.12.0`, not the v2 family; the modern path is entirely hand-rolled, so "explicit-schema custom methods" means xiNAS's own zod schemas, not an SDK API |

## Appendix B — Released extension schema (pinned excerpt)

Quoted from `ext-tasks/schema/2026-07-28/schema.ts` on 2026-09-04; the
zod schemas in `src/api/mcp/tasks/schema.ts` and the contract fixtures
are derived from exactly this text.

```ts
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

export interface WorkingTask extends Task { status: "working"; }
export interface InputRequiredTask extends Task { status: "input_required"; inputRequests: InputRequests; }
export interface CompletedTask extends Task { status: "completed"; result: { [key: string]: unknown }; }
export interface FailedTask extends Task { status: "failed"; error: JSONRPCErrorObject; }
export interface CancelledTask extends Task { status: "cancelled"; }
export type DetailedTask = WorkingTask | InputRequiredTask | CompletedTask | FailedTask | CancelledTask;

export type CreateTaskResult = Result & Task & { resultType: "task" };
export type GetTaskRequest = JSONRPCRequest & { method: "tasks/get"; params: { taskId: string } };
export type GetTaskResult = Result & DetailedTask & { resultType: "complete" };
export type UpdateTaskRequest = JSONRPCRequest & { method: "tasks/update"; params: { taskId: string; inputResponses: InputResponses } };
export type UpdateTaskResult = Result & { resultType: "complete" };
export type CancelTaskRequest = JSONRPCRequest & { method: "tasks/cancel"; params: { taskId: string } };
export type CancelTaskResult = Result & { resultType: "complete" };
export type TasksExtensionCapability = Record<string, never>;
```

Fixtures (all must validate):

```jsonc
// CreateTaskResult, working
{ "resultType": "task", "taskId": "0192c5f6-0000-7000-8000-000000000001", "status": "working",
  "statusMessage": "fs.create: queued, waiting for an executor slot; elapsed 0s",
  "createdAt": "2026-09-04T19:40:00.000Z", "lastUpdatedAt": "2026-09-04T19:40:00.000Z",
  "ttlMs": null, "pollIntervalMs": 2000 }
// GetTaskResult, completed
{ "resultType": "complete", "taskId": "0192c5f6-0000-7000-8000-000000000001", "status": "completed",
  "statusMessage": "fs.create: succeeded in 4m 12s",
  "createdAt": "2026-09-04T19:40:00.000Z", "lastUpdatedAt": "2026-09-04T19:44:12.000Z",
  "ttlMs": 2592252000,
  "result": { "content": [ { "type": "text", "text": "{…public Task…}" } ] } }
// GetTaskResult, cancelled
{ "resultType": "complete", "taskId": "…", "status": "cancelled",
  "statusMessage": "fs.create: cancelled at a safe point after 3s; partial work rolled back",
  "createdAt": "…", "lastUpdatedAt": "…", "ttlMs": 2592003000 }
// UpdateTaskResult / CancelTaskResult
{ "resultType": "complete" }
// -32021
{ "code": -32021, "message": "Missing required client capability",
  "data": { "requiredCapabilities": { "extensions": { "io.modelcontextprotocol/tasks": {} } } } }
```
