# xiNAS S16 — MCP Tasks extension requirements

> **Status:** draft requirements, 2026-09-04.
>
> **Protocol target:** MCP `2026-07-28`, official extension
> `io.modelcontextprotocol/tasks`.
>
> **Normative sources:**
> [SEP-2663: Tasks extension](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md),
> [released `2026-07-28` extension schema](https://github.com/modelcontextprotocol/ext-tasks/tree/main/schema/2026-07-28),
> and [MCP TypeScript SDK support notes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).
>
> **Extends:** ADR-0010, S2 task envelope, S5 filesystem, S8 clients,
> S14 modern MCP and S15 MRTR confirmation.
>
> The binding behavior contract for this work MUST be written as
> `s16-mcp-tasks-spec.md` and approved before implementation. This file records
> the product and safety requirements that the spec must satisfy.

---

## 1. Goal

Implement the official MCP Tasks extension so a modern MCP client can start a
long-running xiNAS operation, receive a durable task handle without holding the
original `tools/call` open, and later observe, resume or request cancellation
of that operation.

The first mandatory scenario is `filesystems.create` / `fs.create`, including
an XFS formatting stage whose duration is not bounded by an MCP tool-call
timeout.

The implementation MUST:

- reuse the existing xiNAS durable task engine rather than create a parallel
  job system;
- use the same identifier for the MCP task and the xiNAS task;
- keep the original plan/apply, RBAC, lease, idempotency, audit and recovery
  guarantees;
- complete S15 MRTR confirmation before creating or returning an MCP task;
- return a task only to a request that declares the Tasks extension;
- retain a working fallback for clients that do not implement the extension;
- preserve task observability across client, API and agent restarts;
- never report an irreversible partial filesystem change as successfully
  cancelled or rolled back.

## 2. Non-goals

S16 does not:

- replace the xiNAS `tasks` table, Task engine, stages, leases or REST task
  endpoints;
- replace S15 confirmation with task `input_required`;
- introduce the removed `tasks/list` or `tasks/result` MCP methods;
- make the existing xiNAS tool names `tasks.list`, `tasks.get`, `tasks.wait`
  or `tasks.cancel` part of the MCP Tasks extension;
- add task augmentation to request types other than `tools/call`;
- invent a completion percentage for `mkfs.xfs`;
- promise that a cooperative cancellation will stop an operation;
- expose internal task specs, confirmation state, credentials, device secrets
  or stage-log filesystem paths;
- require task-status notifications in the first implementation slice;
- change the public REST `ApplyRequest` body.

## 3. Required specification updates

All specification changes in this section MUST land before implementation.

### TASKS-SPEC-001 — Create S16

Create `docs/control-path/s16-mcp-tasks-spec.md` as the authoritative contract
for:

- extension capability negotiation;
- task-eligible tool calls;
- `CreateTaskResult`;
- `tasks/get`, `tasks/update` and `tasks/cancel`;
- xiNAS-to-MCP state projection;
- ownership, authorization and retention;
- result and error projection;
- MRTR composition;
- filesystem formatting behavior;
- legacy fallback and client interoperability;
- audit, metrics and acceptance criteria.

### TASKS-SPEC-002 — Amend ADR-0010

ADR-0010 MUST record that:

1. the official Tasks extension is available only on the modern MCP path;
2. the existing xiNAS Task remains the sole durable execution object;
3. an MCP task uses the same `task_id`, with no alias or second state machine;
4. the server, not the client, decides whether an eligible `tools/call`
   returns a task;
5. a request without the extension receives the existing xiNAS asynchronous
   result and `tasks.wait` hint;
6. S15 confirmation is synchronous and precedes task creation;
7. `tasks/get`, `tasks/update` and `tasks/cancel` are protocol methods, while
   `tasks.get`, `tasks.wait` and `tasks.cancel` are ordinary xiNAS tools;
8. no MCP `tasks/list` method exists;
9. extension task access is bound to the authenticated xiNAS principal.

### TASKS-SPEC-003 — Amend S14 modern MCP

S14 MUST define:

- `CallToolResult | InputRequiredResult | CreateTaskResult` as the modern
  `tools/call` result union;
- the `resultType: "task"` discriminator;
- method routing and schema validation for `tasks/get`, `tasks/update` and
  `tasks/cancel` ahead of the legacy SDK path;
- per-request client capability parsing;
- `server/discover` advertisement of
  `capabilities.extensions["io.modelcontextprotocol/tasks"] = {}`;
- `-32021 Missing Required Client Capability` behavior;
- Streamable HTTP routing-header validation for task methods;
- absence of task methods from the legacy era;
- use of the released extension schemas rather than the deprecated
  `2025-11-25` core task vocabulary.

The modern handler is already hand-rolled because the current SDK does not
provide typed inbound handlers for the `2026-07-28` extension methods. S16 MUST
continue to validate explicit released schemas; it MUST NOT import the old
experimental Task types and present them as SEP-2663.

### TASKS-SPEC-004 — Amend S15 MRTR

Replace the future-work wording in S15 §4.7 with the following sequencing
contract:

1. resolve every pre-execution MRTR exchange synchronously;
2. create no task for a pending, declined, cancelled or expired confirmation;
3. consume the accepted confirmation in the same transaction that creates the
   xiNAS apply task;
4. only then return `CreateTaskResult` when the final retry declared the Tasks
   extension;
5. keep confirmation and task state, identifiers and replay protection
   separate.

### TASKS-SPEC-005 — Amend S2 task envelope

S2 MUST define:

- the MCP projection of the existing Task state machine;
- strong consistency of task creation;
- terminal `CallToolResult` rendering;
- principal-bound access to extension methods;
- extension cancellation as an adapter over the S10/ADR-0012 cancellation
  path;
- TTL derivation from existing terminal-task retention;
- restart and GC behavior;
- the filesystem cancellation correction in §9 of this document.

### TASKS-SPEC-006 — Amend S5 filesystem

S5 MUST correct the `fs.create` safety contract:

- `mkfs` is irreversible in xiNAS and is never undone by rollback;
- `rollback_model` MUST be `unsupported` for every `fs.create` plan;
- `risk_level` remains `destructive` when `force: true`; a non-force create may
  retain `non_disruptive` risk only because live preflight proves there is no
  existing filesystem, not because formatting is reversible;
- S15 therefore requires out-of-band confirmation for every `fs.create`, due
  to `rollback_model: "unsupported"`;
- cancellation MUST be refused after the `mkfs` stage starts;
- a task MUST NOT reach xiNAS `cancelled` after `mkfs` changed the device.

The current provider returns `rollback_model: "non_disruptive"` for a
non-force create even though the executor states that `mkfs` is not undone.
The current stage-boundary cancellation path can also observe a cancellation
after `mkfs`, roll back only the mount/unit work, and label the task
`cancelled`. Both contradictions are release blockers for S16.

### TASKS-SPEC-007 — Amend S8 clients

S8 MUST document:

- extension-aware client behavior;
- transparent client polling versus exposing task handles to the application;
- persistence of `taskId` for reconnect and restart;
- honoring `pollIntervalMs`;
- fallback through the existing xiNAS `task_id` + `tasks.wait` flow;
- user-visible cancellation limitations;
- Claude Code and Codex interop tests, without assuming support from version
  strings or embedded protocol symbols alone.

### TASKS-SPEC-008 — API and repository guidance

The public OpenAPI task and apply shapes MUST remain backward compatible. MCP
extension schemas are JSON-RPC wire contracts and MUST NOT be added to
`ApplyRequest`.

After implementation:

- add S16 to the live MCP contract list in `CLAUDE.md`;
- remove only those MCP Tasks deferrals in `docs/TODO.md` that S16 actually
  resolves;
- retain explicit deferrals for notifications and intra-stage progress if they
  remain unimplemented.

## 4. Capability negotiation

### TASKS-CAP-001 — Extension identifier

The only supported identifier is:

```text
io.modelcontextprotocol/tasks
```

No extension-specific settings are defined. Any non-object value for the
extension capability MUST be rejected as invalid params.

### TASKS-CAP-002 — Server advertisement

`server/discover` MUST advertise the extension only when all three lifecycle
methods and `CreateTaskResult` validation are installed and healthy.

The server MUST NOT advertise partial support. Disabling task notifications
does not prevent advertisement because notifications are optional.

### TASKS-CAP-003 — Per-request client declaration

Every eligible `tools/call` and every `tasks/get`, `tasks/update` or
`tasks/cancel` request MUST be evaluated against that request's own:

```json
{
  "_meta": {
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": {
        "io.modelcontextprotocol/tasks": {}
      }
    }
  }
}
```

The server MUST NOT infer capability from an earlier `server/discover`, an
earlier request, a session, `clientInfo`, a tool argument or transport type.

### TASKS-CAP-004 — Missing capability

The server MUST NOT return `CreateTaskResult` to a request that omitted the
extension.

An inbound `tasks/get`, `tasks/update` or `tasks/cancel` without the capability
MUST fail with JSON-RPC `-32021` and:

```json
{
  "requiredCapabilities": {
    "extensions": {
      "io.modelcontextprotocol/tasks": {}
    }
  }
}
```

xiNAS does not require `-32021` for its existing long-running tools because
the non-extension fallback in §6 remains serviceable.

## 5. Task eligibility and server choice

### TASKS-ELIG-001 — Eligible calls

In the initial slice, a `tools/call` is task-eligible only when all of the
following are true:

- the catalog entry explicitly declares that it creates or replays a durable
  xiNAS Task;
- the call's successful REST result contains that Task;
- the Task is `queued`, `running` or already terminal;
- the request is on the modern `2026-07-28` path;
- the request declares the Tasks extension.

All `mode: "apply"` calls for plan/apply tools are eligible. `support.bundle`
is eligible because it creates a durable diagnostic task.

`mode: "plan"`, reads, `tasks.get`, `tasks.wait`, and the ordinary
`tasks.cancel` tool are not eligible. In particular, cancelling one task MUST
NOT create a nested task.

The catalog MUST use a dedicated task-eligibility field. The existing
`returns_async_task` flag is insufficient because `tasks.cancel` returns a Task
envelope but does not create the operation being represented.

### TASKS-ELIG-002 — Server-directed behavior

For an eligible extension-aware request, xiNAS SHOULD return
`CreateTaskResult` whenever the created/replayed Task is non-terminal.

If idempotent replay finds the Task already terminal, xiNAS MAY return either
the immediate final `CallToolResult` or a terminal `CreateTaskResult`. The S16
spec MUST choose one deterministic rule; the recommended rule is always to
return the same task handle for the same idempotency record so retries do not
change response mode based on timing.

### TASKS-ELIG-003 — One durable object

`CreateTaskResult.taskId` MUST equal the existing `Task.task_id` exactly.

No alias table, client-scoped task ID, in-memory-only job object or second task
state machine is permitted.

### TASKS-ELIG-004 — Strong creation consistency

The server MUST NOT return `CreateTaskResult` until:

- the xiNAS Task row is committed;
- any required S15 confirmation is atomically consumed;
- an authorized `tasks/get` for the returned `taskId` can resolve immediately.

The response does not need to wait for agent acceptance or for the first stage
to start. A committed `queued` task is sufficient.

If failure occurs before durable task creation, return the normal tool or
JSON-RPC error and do not invent a task handle. If failure occurs after the
Task is committed, preserve the Task and expose its resulting state through
the task lifecycle.

## 6. Compatibility fallback

### TASKS-FALLBACK-001 — Clients without Tasks

A client that does not declare the extension MUST retain the current xiNAS
behavior:

- the original `tools/call` returns `CallToolResult`;
- the result contains the xiNAS `task_id` and current Task envelope;
- a live task includes the existing `next.tool: "tasks.wait"` hint;
- the client may repeatedly call the ordinary xiNAS `tasks.wait` tool.

The fallback MUST not hold the original `tools/call` open for the duration of
the operation.

### TASKS-FALLBACK-002 — Stable legacy era

The legacy MCP era MUST keep its current wire shapes. It MUST NOT receive
`resultType: "task"` or any `tasks/*` protocol method.

S15 legacy apply denial remains unchanged. Reads, plans, task reads and
permitted direct operations continue to work as already specified.

### TASKS-FALLBACK-003 — No semantic split

Extension and fallback paths MUST create at most one xiNAS Task for the same
principal and idempotency key. Switching capability declaration between
retries MUST NOT create another apply, consume another confirmation or acquire
another lease.

## 7. MCP task wire contract

### TASKS-WIRE-001 — CreateTaskResult

The result returned in place of `CallToolResult` MUST contain:

- `resultType: "task"`;
- `taskId`;
- `status`;
- optional `statusMessage`;
- `createdAt`;
- `lastUpdatedAt`;
- `ttlMs`;
- optional `pollIntervalMs`.

The Task object is flat. It MUST NOT be nested under `task`, `result` or the
xiNAS REST envelope.

### TASKS-WIRE-002 — Supported protocol methods

The modern path MUST support exactly:

- `tasks/get`;
- `tasks/update`;
- `tasks/cancel`.

The extension MUST NOT implement `tasks/list` or `tasks/result`.

### TASKS-WIRE-003 — Get result

Every successful `tasks/get` MUST return `resultType: "complete"` plus the
complete status-specific Task shape:

- `working`: base Task fields;
- `input_required`: base fields plus all outstanding `inputRequests`;
- `completed`: base fields plus the final `result`;
- `failed`: base fields plus a JSON-RPC `error`;
- `cancelled`: base Task fields.

### TASKS-WIRE-004 — Update result

`tasks/update` MUST validate an object `inputResponses` and return only:

```json
{ "resultType": "complete" }
```

No current xiNAS task requires input after creation. Therefore the initial S16
implementation MUST accept a valid owned task, ignore unknown or already
satisfied response keys as SEP-2663 directs, and acknowledge the request. It
MUST NOT transition a current xiNAS task to `input_required` merely to
demonstrate the method.

Future task-time input requires a separate spec update covering durable
request keys, replay, trust presentation and worker wake-up.

### TASKS-WIRE-005 — Cancel result

`tasks/cancel` MUST return only:

```json
{ "resultType": "complete" }
```

The acknowledgement means that the cancellation signal was accepted for
processing. It does not mean the task stopped, rolled back or reached
`cancelled`.

### TASKS-WIRE-006 — Streamable HTTP headers

For task methods over Streamable HTTP, the modern transport MUST validate:

- `MCP-Protocol-Version` according to S14;
- `Mcp-Method` equal to the JSON-RPC method;
- `Mcp-Name` equal to `params.taskId`.

These headers do not apply to the stdio adapter's internal message stream.

## 8. State and result projection

### TASKS-MAP-001 — State map

The projection MUST be:

| xiNAS Task state | MCP Task status | Required payload |
|---|---|---|
| `queued` | `working` | status message says the operation is queued |
| `running` | `working` | status message identifies the current stage when known |
| `success` | `completed` | final `CallToolResult`, `isError` absent or false |
| `failed` | `completed` | final `CallToolResult` with `isError: true` |
| `requires_manual_recovery` | `completed` | final `CallToolResult` with `isError: true` and explicit remediation |
| `cancelled` | `cancelled` | cancellation summary, no `result` |
| `plan_only` | not projectable | `-32602` unless it was explicitly returned as a future task type |
| `imported` | not projectable | `-32602` |

xiNAS operational failure states are tool-level outcomes, not JSON-RPC
failures. MCP `failed` MUST NOT be used for `mkfs` failure, rollback failure,
manual-recovery requirement, lease conflict or another ordinary xiNAS result.

### TASKS-MAP-002 — MCP failed status

MCP `status: "failed"` is reserved for a JSON-RPC error that occurs while the
deferred `tools/call` itself is executing. It MUST carry the original JSON-RPC
error object.

Serialization errors, a corrupted task invariant or an internal projection
failure MAY use this state only when the error is durably recorded. A transient
failure to serve one `tasks/get` request MUST return a JSON-RPC error for that
poll and MUST NOT rewrite the underlying task.

### TASKS-MAP-003 — Final CallToolResult

For `completed`, `result` MUST be a valid `CallToolResult` representing the
terminal xiNAS operation. It MUST include enough information to determine:

- operation kind and `task_id`;
- terminal xiNAS state;
- affected resources;
- stage outcomes;
- operational error and remediation, when present;
- whether manual recovery is required.

The renderer MUST be deterministic and use the shared public Task projection.
It MUST NOT expose `spec`, `plan_binding`, `desired_rollback`, confirmation
state, bearer tokens or local `output_path` values.

### TASKS-MAP-004 — Status message

`statusMessage` is human/model-facing and MUST be concise, truthful and derived
from durable state. For a running task it SHOULD include:

- operation name;
- current stage name;
- stage position and total when known;
- elapsed time;
- cancellation limitation when the operation passed a point of no return.

It MUST NOT claim a percentage unless the executor reports a real measured
percentage.

### TASKS-MAP-005 — Poll interval

The S16 spec MUST set a default `pollIntervalMs` in the range 1–5 seconds and a
slower interval for a running `mkfs` stage. The recommended values are:

- 2,000 ms while queued or between short stages;
- 5,000 ms while `mkfs` is running;
- omitted on a terminal task.

Clients SHOULD honor the latest returned interval. Rate limiting of sustained
faster polling MAY be added, but it MUST never affect execution of the
underlying xiNAS Task.

### TASKS-MAP-006 — TTL and retention

Non-terminal xiNAS tasks are not pruned, so their MCP `ttlMs` MUST be `null`.

For a terminal task, `ttlMs` MUST describe the total permitted lifetime from
`createdAt`, not merely the retention duration after completion:

```text
ttlMs = (terminal_at - created_at) + terminal_task_retention_ms
```

With the current default, `terminal_task_retention_ms` is 30 days. After the
row is archived and removed, `tasks/get` MUST return `-32602` with a generic
not-found-or-expired message.

## 9. Long-running filesystem creation

### TASKS-FS-001 — Mandatory scenario

The acceptance scenario MUST use the existing `filesystems.create` tool and
`fs.create` executor:

1. call `filesystems.create` with `mode: "plan"`;
2. present and complete the S15 out-of-band confirmation;
3. retry `filesystems.create` with `mode: "apply"`, the plan binding,
   idempotency key and both required client capabilities;
4. receive `CreateTaskResult` without waiting for `mkfs.xfs` to finish;
5. poll `tasks/get` across `queued`, `preflight`, `mkfs`, `install_unit`,
   `mount` and `verify`;
6. receive the terminal `CallToolResult`.

### TASKS-FS-002 — Formatting duration

The original `tools/call` MUST NOT be held open for the duration of
`mkfs.xfs`. It may wait only for normal authentication, confirmation
completion, transactional task creation and bounded dispatch admission.

No MCP transport timeout, Codex/Claude tool timeout or disconnected client may
terminate the xiNAS task after its durable creation.

### TASKS-FS-003 — Honest formatting progress

While the `mkfs` stage is running, `tasks/get` MUST return `working` and a
message equivalent to:

```text
Creating filesystem: formatting XFS (stage 2 of 5), elapsed 2m 14s;
mkfs.xfs does not report a completion percentage.
```

The exact wording is non-normative. The following are normative:

- current stage and elapsed time are visible;
- no fabricated percentage or estimated completion time is shown;
- completed stage count never moves backwards;
- stage output appears only when the existing task engine durably records it.

### TASKS-FS-004 — Point of no return

For `fs.create`, the point of no return is the start of the `mkfs` executor
stage.

Before that point, cancellation may produce xiNAS/MCP `cancelled`. At or after
that point:

- `tasks/cancel` still returns its protocol-required acknowledgement;
- the core cancellation adapter MUST record refusal reason
  `irreversible_stage_started` (or a spec-approved equivalent);
- the executor MUST NOT be interrupted by S16;
- the task remains `working` and may ultimately complete or fail;
- `statusMessage` MUST say cancellation can no longer safely stop formatting;
- the task MUST NOT become `cancelled` merely because rollback removed a mount
  unit while leaving the device formatted.

### TASKS-FS-005 — Failure after formatting

If `mkfs` succeeds but a later stage fails, the existing rollback may remove
the unit and unmount the filesystem, but the device remains formatted.

The terminal result MUST therefore:

- use xiNAS `failed` or `requires_manual_recovery`, never `cancelled`;
- project to MCP `completed` with `CallToolResult.isError: true`;
- state that the device may contain an unmanaged XFS filesystem;
- include a safe remediation path that begins with re-observation and does not
  recommend blindly reformatting the device.

## 10. Composition with MRTR confirmation

### TASKS-MRTR-001 — Confirmation before task

Every S15 confirmation exchange MUST finish before task creation. The initial
and intermediate MRTR responses use `resultType: "input_required"`, not
`resultType: "task"` and not task `status: "input_required"`.

### TASKS-MRTR-002 — Final retry capability

The final accepted `tools/call` retry MUST independently declare both:

- the elicitation capability required by S15; and
- `io.modelcontextprotocol/tasks` when the client wants to accept a task
  result.

The server MUST use capabilities from that retry, not from the first round.

### TASKS-MRTR-003 — No task on non-acceptance

Decline, cancel, expiry, malformed state, replay rejection and approval-policy
failure MUST create no Task and return no task handle.

### TASKS-MRTR-004 — Atomic handoff

For an accepted apply, the following remain one atomic control-path action:

- verify confirmation bindings;
- verify single-use state;
- consume the confirmation;
- insert or resolve the idempotent xiNAS Task;
- acquire leases and write desired intent as already specified by S2.

`CreateTaskResult` is a projection after that commit. It is not part of the
authorization decision.

## 11. Authorization and information security

### TASKS-SEC-001 — Opaque identifiers

Task IDs MUST remain opaque, non-sequential and impractical to guess. The
existing UUIDv7 generator is acceptable if it retains cryptographically random
bits and no endpoint treats the timestamp portion as authorization.

### TASKS-SEC-002 — Principal binding

Every extension task method MUST authenticate the caller and compare the
resolved xiNAS principal with `Task.principal`.

Only the creating principal may use MCP `tasks/get`, `tasks/update` or
`tasks/cancel` for that task. Administrative cross-principal inspection and
recovery remain on the existing REST/CLI surfaces and are not added to this
extension.

### TASKS-SEC-003 — No existence oracle

Unknown, expired, non-projectable and unauthorized task IDs MUST all return the
same JSON-RPC `-32602` class and a generic not-found-or-expired message. The
response MUST NOT reveal another principal, operation name, state or creation
time.

### TASKS-SEC-004 — Authorization on every request

Task authorization MUST be re-evaluated on every request. Possession of a
`taskId`, a prior successful poll, an MCP session or a prior bearer token is
not sufficient.

`tasks/cancel` additionally requires the current principal to satisfy the
existing operator-level cancellation authorization. A downgraded or revoked
principal may not cancel through MCP.

### TASKS-SEC-005 — Existing task-list tool

The ordinary xiNAS `tasks.list` tool is not the MCP `tasks/list` method. It MAY
remain available under its existing product RBAC, but learning another task ID
through that tool MUST NOT grant access through extension task methods.

### TASKS-SEC-006 — Output hygiene

Task responses and status messages MUST undergo the same redaction and public
rendering rules as REST Task responses. In particular, they MUST NOT contain:

- request or confirmation state bytes;
- bearer or loopback tokens;
- raw operation specs when those are internal-only;
- local log paths;
- secrets present in command lines or environment variables;
- details about an unauthorized task.

## 12. Cancellation

### TASKS-CANCEL-001 — Shared core

MCP `tasks/cancel`, the ordinary `tasks.cancel` tool and REST
`POST /tasks/{id}/cancel` MUST call one shared cancellation core. They MUST NOT
maintain separate cancellation flags or race each other through different
state machines.

### TASKS-CANCEL-002 — Ack-only protocol result

After validating capability, shape, ownership and cancellation authorization,
MCP `tasks/cancel` MUST acknowledge the request even when:

- the worker will observe it later;
- the task wins the race and completes first;
- the current stage is not safely cancellable;
- the core records a refusal reason.

A clearly invalid or unauthorized task still returns `-32602`.

### TASKS-CANCEL-003 — Eventual outcome

The client MUST NOT infer terminal state from the acknowledgement. A later
`tasks/get` may report `working`, `completed`, `failed` or `cancelled`.

### TASKS-CANCEL-004 — Safety truthfulness

xiNAS `cancelled` continues to mean the operation was stopped at a safe point
and partial work was unwound according to the operation's contract. If that
claim is no longer true, the state MUST be `failed` or
`requires_manual_recovery`, projected as MCP `completed` with an error result.

The `fs.create` rule in §9.4 is mandatory and takes precedence over the generic
stage-boundary cancellation rule.

## 13. Restart, idempotency and lifecycle

### TASKS-LIFE-001 — Restart survival

Because the MCP task is the xiNAS Task, API or client restart MUST NOT lose the
handle. After normal task reconciliation, an authorized `tasks/get` MUST
return the same `taskId` and current projected state.

### TASKS-LIFE-002 — Client disconnect

Disconnecting the MCP client after `CreateTaskResult` MUST NOT cancel the task.
Cancellation occurs only through an explicit authorized cancellation request
or existing operator recovery procedures.

### TASKS-LIFE-003 — Idempotent replay

Replaying the accepted `tools/call` with the same principal and idempotency key
MUST return the existing task and MUST NOT:

- repeat formatting;
- consume a second confirmation;
- acquire duplicate leases;
- create another audit operation;
- reset task timestamps or progress.

An idempotency key reused with different input retains the existing xiNAS
conflict behavior.

### TASKS-LIFE-004 — Timestamps

`createdAt` maps to `Task.created_at`; `lastUpdatedAt` maps to
`Task.updated_at`. Both MUST be UTC ISO 8601 timestamps and MUST remain stable
across reads except that `lastUpdatedAt` advances on a durable state or stage
change.

Elapsed time shown in `statusMessage` is derived at render time and MUST NOT
touch `updated_at` merely because a client polled.

## 14. Notifications

### TASKS-NOTIFY-001 — Polling baseline

`tasks/get` polling is the mandatory completion mechanism and MUST work on
stdio and Streamable HTTP.

### TASKS-NOTIFY-002 — Deferred push

The boundary with S17 (`s17-mcp-subscriptions-spec.md`, amended here per
SUBS-SPEC-004, 2026-09-04) is:

- S17 implements the core `subscriptions/listen` transport (HTTP SSE and
  stdio) and the operational resource feeds (`xinas://events/*`).
- Phase 1 of S17 does **not** emit `notifications/tasks` and does not turn
  Task state into a domain-event replacement for `tasks/get`; a domain event
  may carry `cause.taskId` from durable execution context, but the task's
  own status is read only through `tasks/get`.
- A future task-status notification MAY reuse the S17 transport only after
  this S16 contract defines task authorization, the complete task projection
  (the same status-specific shape as `tasks/get`) and reconnect behavior.

The server MUST NOT advertise or partially emit task notifications until it
can:

- authorize every subscribed task;
- resume after transport interruption;
- send the same complete status-specific shape as `tasks/get`;
- avoid sending unsupported progress/message notifications on the task stream.

## 15. Audit and metrics

### TASKS-AUD-001 — Audit events

The implementation MUST emit lifecycle audit events for:

- MCP task handle returned;
- task read denied;
- task update accepted;
- cancellation requested;
- cancellation refused at an irreversible stage;
- task expired or pruned.

Events MUST reference the existing `task_id`, principal, tool/operation kind
and request correlation ID. They MUST NOT duplicate the existing operational
apply audit row or contain credentials and protected MRTR state.

### TASKS-AUD-002 — Metrics

The existing S15 Prometheus endpoint SHOULD add bounded-cardinality metrics
for:

- task handles returned, by operation kind;
- `tasks/get` requests and protocol errors;
- active projected tasks by MCP status;
- terminal results by xiNAS state;
- cancellation requests and refusals;
- task age and time to terminal;
- polls rejected or rate-limited.

Task IDs, principals, device paths, mountpoints and idempotency keys MUST NOT be
metric labels.

## 16. Client interoperability

### TASKS-CLIENT-001 — Protocol harness is authoritative

Acceptance MUST use a client harness built from the released extension schema.
It MUST test both a client that exposes task handles and a client adapter that
polls internally and returns only the final `CallToolResult` to its caller.

### TASKS-CLIENT-002 — Claude Code

The installed Claude Code 2.1.259 binary contains Tasks extension method and
identifier strings, but that is not proof of capability declaration, polling,
UI behavior or cancellation correctness.

A Claude Code version is supported for the xiNAS demo only after a captured
end-to-end run proves:

- it declares the extension on the relevant requests;
- it accepts `CreateTaskResult`;
- it polls or otherwise observes the same task;
- it renders terminal success and `isError` correctly;
- reconnect resumes rather than starts another apply.

### TASKS-CLIENT-003 — Codex

The installed Codex CLI is 0.136.0. The official OpenAI MCP documentation
available on 2026-09-04 lists transport, authentication, instructions and tool
support but does not document the MCP Tasks extension. S16 MUST therefore not
claim native Codex Tasks support from general MCP support alone.

A Codex version becomes a supported Tasks client only after the same captured
interop flow as §16.2. Until then Codex uses the compatibility fallback in §6,
whose ordinary `tools/call` returns quickly with `task_id` and a `tasks.wait`
hint.

### TASKS-CLIENT-004 — Timeouts

Client tool-call timeouts apply only until `CreateTaskResult` or the fallback
`CallToolResult` is returned. They MUST NOT be reused as execution deadlines
for the underlying xiNAS task.

## 17. Verification requirements

### TASKS-TEST-001 — Protocol conformance

Automated tests MUST cover:

- extension advertisement;
- per-request capability parsing;
- task returned only to a declaring client;
- `-32021` for extension methods without capability;
- valid status-specific response schemas;
- absence of `tasks/list` and `tasks/result`;
- Streamable HTTP header agreement;
- legacy era isolation;
- explicit-schema interop without deprecated 2025 task types.

### TASKS-TEST-002 — Projection

Test every row of §8.1, including:

- xiNAS `failed` → MCP `completed` + `isError: true`;
- `requires_manual_recovery` → MCP `completed` + remediation;
- only a deferred JSON-RPC error → MCP `failed`;
- `plan_only` and `imported` rejected;
- no internal fields leaked;
- stable timestamps and TTL.

### TASKS-TEST-003 — Security

Tests MUST prove:

- same-principal get/update/cancel succeeds as allowed;
- cross-principal access returns the same error as an unknown ID;
- a viewer cannot cancel through the extension;
- capability from one request is not cached for the next;
- guessed, expired and pruned IDs reveal no metadata;
- task-list visibility does not bypass extension ownership.

### TASKS-TEST-004 — MRTR composition

Tests MUST prove:

- no Task exists before confirmation completes;
- decline/cancel/expiry/tamper create no Task;
- accepted confirmation and Task creation are atomic;
- the final retry's Tasks capability controls only the response projection;
- an idempotent retry returns the same `taskId`;
- extension-to-fallback and fallback-to-extension retries never duplicate an
  apply.

### TASKS-TEST-005 — Long-running format

The fake host MUST support a controllable, deliberately blocked `mkfs` stage.
An end-to-end test MUST prove:

1. `tools/call` returns a task while `mkfs` remains blocked;
2. `tasks/get` reports `working`, the `mkfs` stage and elapsed time;
3. no percentage is fabricated;
4. a client disconnect does not stop execution;
5. polling resumes with the same ID after API restart/reconcile;
6. releasing `mkfs` allows later stages and a terminal result;
7. the terminal result has the expected `CallToolResult` shape.

### TASKS-TEST-006 — Cancellation point of no return

Tests MUST prove:

- queued or pre-`mkfs` cancellation can reach `cancelled` with no filesystem
  change;
- cancellation while `mkfs` is blocked is acknowledged but refused by the
  core;
- the task does not become `cancelled` after the device was formatted;
- later failure exposes the formatted-but-unmanaged residual;
- cancellation racing terminal success may end in success;
- rollback failure ends in `requires_manual_recovery`, projected as a completed
  error result.

### TASKS-TEST-007 — Regression gates

The implementation is not complete until all repository gates in `CLAUDE.md`
pass, including unit, contract, build and e2e suites. The released extension
schema MUST be pinned in tests so a future draft cannot silently change the
accepted wire format.

## 18. Acceptance criteria

S16 is accepted only when all statements below are true:

1. `server/discover` advertises the official Tasks extension.
2. An eligible modern request with the capability can receive a durable
   `CreateTaskResult`.
3. A request without the capability never receives `resultType: "task"`.
4. The MCP `taskId` is the xiNAS `task_id`.
5. `tasks/get`, `tasks/update` and `tasks/cancel` conform to the released
   `2026-07-28` extension schema.
6. No `tasks/list` or `tasks/result` protocol method exists.
7. The fallback `task_id` + ordinary `tasks.wait` workflow still works.
8. S15 confirmation finishes before task creation and is consumed atomically
   with apply.
9. A long `mkfs.xfs` does not hold the original `tools/call` open.
10. Task polling survives client and API restart.
11. `mkfs` progress is truthful and does not invent a percentage.
12. Any `fs.create` plan has `rollback_model: "unsupported"` and therefore
    receives S15 out-of-band confirmation.
13. Cancellation after `mkfs` starts cannot produce a misleading
    `cancelled` state.
14. xiNAS operational failures map to MCP `completed` with
    `CallToolResult.isError: true`.
15. Task access is bound to the authenticated principal and reveals no
    cross-principal metadata.
16. Capability switching and idempotent retries never duplicate execution.
17. Claude Code or Codex is named as a supported native Tasks client only
    after a captured interop run; otherwise the documented fallback is used.

## Appendix A — Decisions carried into the S16 design

| ID | Decision | Rationale |
|---|---|---|
| D-01 | Use the existing xiNAS `task_id` as MCP `taskId` | One durable state machine; restart and audit already exist |
| D-02 | Preserve the non-extension `task_id` + `tasks.wait` fallback | Current Codex support is not established; legacy clients remain useful |
| D-03 | Do not implement MCP `tasks/list` or `tasks/result` | Both are absent from SEP-2663; listing also weakens authorization scoping |
| D-04 | Polling first; task notifications deferred | Polling is normative and works across both supported transports |
| D-05 | Implement `tasks/update`, but create no task-time input flows yet | Full method surface is required; current xiNAS execution needs no post-start input |
| D-06 | Resolve S15 confirmation before returning a task | SEP-2663 recommends synchronous MRTR before task creation; authorization must precede work |
| D-07 | Treat all `fs.create` plans as rollback-unsupported | `mkfs` is never undone, regardless of whether an existing filesystem was present |
| D-08 | Refuse cancellation after `mkfs` starts | A formatted device cannot truthfully satisfy the existing `cancelled = unwound` contract |
| D-09 | Map xiNAS operational failures to MCP completed tool errors | SEP-2663 reserves `failed` for JSON-RPC execution errors |
| D-10 | Use released extension schemas through explicit modern handlers | The current TypeScript SDK typed maps intentionally exclude the extension methods |

## Appendix B — Verified implementation baseline (2026-09-04)

| Area | Current fact | S16 consequence |
|---|---|---|
| xiNAS Task engine | Durable SQLite Task and stage rows, UUIDv7 IDs, leases, restart reconcile, terminal retention | Reuse directly |
| MCP catalog | Plan/apply tools and `support.bundle` return Task envelopes; `tasks.cancel` is also marked async | Add a dedicated task-creation eligibility field |
| MCP modern handler | Handles `server/discover`, `tools/list`, `tools/call`, MRTR; unknown methods return `-32601` | Add explicit extension routing and schemas |
| MCP discovery | Deliberately omits `extensions` today | Advertise only after the lifecycle surface is complete |
| MCP fallback | Live task results include a `tasks.wait` next hint | Preserve unchanged |
| Task progress | Stage, position, total and elapsed time exist; no percentage or live output line | Render honest `statusMessage` |
| Filesystem executor | `preflight → mkfs → install_unit → mount → verify`; `mkfs` is not rolled back | Make rollback and cancellation contracts truthful |
| Terminal GC | Terminal tasks retained 30 days by default, measured from terminal time | Derive protocol TTL as total lifetime from creation |
| TypeScript SDK | Modern core typed maps exclude `tasks/*`; explicit-schema custom methods are required | Do not use deprecated 2025 task interception/types |
| Claude Code | Installed 2.1.259 binary contains extension strings | Manual interop required before support claim |
| Codex | Installed 0.136.0; official MCP docs do not list Tasks support | Use fallback unless a newer version passes interop |
