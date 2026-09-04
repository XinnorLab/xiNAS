# xiNAS S15 — MCP MRTR Safe Operation Confirmation Requirements

> **Status:** incoming requirements, received 2026-09-04. Filed under
> `docs/control-path/` beside `phase0-requirements.md` — the control-path
> area owns the live MCP contract (ADR-0010, S8, S14). It is deliberately
> **not** filed under `docs/MCP/`: that folder describes the retired
> standalone server and is reference-only, and §2 of this document forbids
> modifying it.
>
> **The binding design and behavior contract for this work is
> [`s15-mcp-mrtr-confirmation-spec.md`](s15-mcp-mrtr-confirmation-spec.md).**
> This file is the unmodified requirement text, kept so the spec can be
> audited against what was actually asked for.
>
> **Validation.** Every third-party claim (MCP `2026-07-28` schema, SEP-2322,
> the elicitation specification, the named client versions) and every claim
> about the current xiNAS code was checked on 2026-09-04 per `CLAUDE.md`
> §spec-first rule 5. The findings — confirmations, corrections, gaps and
> the decisions they force — are recorded in **Appendix A** at the end of
> this file, after the unmodified text. The S15 spec cites them by ID.

---

**Status:** Draft
**Protocol:** MCP `2026-07-28`
**Normative source:** [SEP-2322: Multi Round-Trip Requests](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2322-MRTR.md)
**Extends:** ADR-0010, S8, S14, S2 task envelope specification

## 1. Goal

Implement MCP Multi Round-Trip Requests so that an MCP client cannot execute a state-changing xiNAS operation without first receiving the authoritative plan and completing the confirmation flow required for the operation's risk level.

The implementation MUST:

- preserve the existing xiNAS plan/apply model;
- preserve RBAC, audit, idempotency, revision checks and leases;
- keep `mcp.allow_apply` as the master administrative gate;
- prevent a model from treating `dangerous: true` as user confirmation;
- bind confirmation to the exact plan, arguments, principal and revision;
- reject tampered, expired, replayed or cross-principal confirmations;
- retain legacy read and plan compatibility;
- fail closed when the client cannot provide the required confirmation.

## 2. Non-goals

This work does not:

- replace `mcp.allow_apply`;
- change REST, CLI or TUI confirmation semantics;
- use `requestState` as an authorization token by itself;
- treat MCP `clientInfo` as trusted identity;
- allow the model to approve its own destructive request;
- introduce MCP Tasks; MRTR must work before the Tasks extension is implemented;
- modify the reference-only specifications under `docs/MCP/`.

## 3. Required specification updates

Specification changes MUST be completed and approved before implementation.

### SPEC-001 — Create S15

Create:
`docs/control-path/s15-mcp-mrtr-confirmation-spec.md`

S15 becomes the authoritative contract for:

- MRTR request and response shapes;
- confirmation policy;
- risk-level mapping;
- confirmation state machine;
- approval persistence;
- `requestState` protection;
- legacy-client behavior;
- audit and acceptance criteria.

### SPEC-002 — Update ADR-0010

Update `docs/control-path/adr/0010-clients-mcp-cli-tui.md`.

The ADR MUST record the following decisions:

1. `mcp.allow_apply` remains the first MCP mutation gate.
2. Every MCP `mode="apply"` call requires confirmation.
3. `dangerous` is an execution precondition and not evidence of confirmation.
4. Modern MCP clients use MRTR.
5. Legacy MCP clients may read and create plans but may not apply after MRTR enforcement is enabled.
6. `support.bundle` and `tasks.cancel` remain exempt because they are respectively a diagnostic and an emergency-stop action.
7. Destructive approval is verified inside the control-path core, not only in the MCP transport.
8. REST, CLI and TUI behavior remains unchanged.

### SPEC-003 — Update S14 modern MCP specification

Update `docs/control-path/s14-mcp-modern-era-spec.md`.

The scope MUST be extended to include MRTR for `tools/call`.

S14 MUST define:

- `CallToolResult | InputRequiredResult` as the modern `tools/call` result union;
- parsing of `params.inputResponses`;
- parsing and validation of `params.requestState`;
- new JSON-RPC request ID on every retry;
- preservation of the original tool name and arguments;
- client elicitation capability checks;
- MRTR round limits;
- the relationship between MRTR and a future MCP Tasks extension.

S14 MUST also correct the current protocol-compliance gap:

- every successful modern result MUST contain `resultType`;
- ordinary `tools/list`, `tools/call` and tool-error results MUST use `resultType: "complete"`;
- an unfinished MRTR result MUST use `resultType: "input_required"`.

The MCP `2026-07-28` schema requires `resultType` on every result. [Current schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)

### SPEC-004 — Update S8 client specification

Update `docs/control-path/s8-clients-spec.md` with:

- modern client MRTR behavior;
- legacy MCP apply denial;
- interaction with `mcp.allow_apply`;
- risk-to-confirmation-mode mapping;
- required client fallback behavior;
- Claude Code and Codex interoperability scenarios;
- user-visible handling of decline, cancel and expiration.

### SPEC-005 — Update S2 task specification

Update `docs/control-path/s2-task-envelope-spec.md`.

The specification MUST define:

- persistence of an exact, canonical confirmation representation of the plan;
- atomic consumption of approval with task creation;
- relationship between `confirmation_id`, `plan_id`, `idempotency_key` and the resulting `task_id`;
- behavior for concurrent retries;
- restart recovery of pending and consumed approvals.

### SPEC-006 — Update API contract notes

The public REST `ApplyRequest` MUST remain unchanged.

MRTR fields MUST NOT be added to the public REST body:

- `requestState`;
- `inputResponses`;
- `confirmation_id`;
- approval tokens.

A loopback-only confirmation context MAY be introduced, but it MUST only be accepted when the request is authenticated with the internal ephemeral loopback token.

### SPEC-007 — Update repository guidance

After implementation:

- add S15 to the live MCP contract list in `CLAUDE.md`;
- remove obsolete SDK/MRTR deferrals from `docs/TODO.md`;
- record any deliberately deferred URL-approval UI work in `docs/TODO.md`.

## 4. Existing compliance blocker

The current modern handler returns:

- `{tools: [...]}` from `tools/list`;
- the current `ToolResult` from `tools/call`.

Neither result currently includes the mandatory `resultType: "complete"`.

This MUST be fixed before adding `input_required`; otherwise the same method would return one schema-compliant variant and one non-compliant variant.

Affected current paths:

- `src/api/mcp/modern.ts`;
- `src/api/mcp/dispatch.ts`;
- modern protocol tests.

Legacy MCP responses MUST retain their legacy wire shape.

## 5. Confirmation policy

### MRTR-POL-001 — Calls requiring confirmation

MRTR confirmation MUST be required for:

- every catalog entry with `mutability: "plan_apply"` when `mode="apply"`;
- every future direct tool with `requires_mcp_apply: true`;
- any future operation explicitly marked with a confirmation policy.

MRTR confirmation MUST NOT be required for:

- read operations;
- `mode="plan"`;
- `support.bundle`;
- `tasks.cancel`;
- internal agent callbacks;
- REST, CLI and TUI calls.

### MRTR-POL-002 — Risk mapping

| Plan risk | Required confirmation | Assurance |
|---|---|---|
| `non_disruptive` | MRTR form | Protection against accidental agent execution |
| `changing_access` | MRTR form | Explicit interactive acknowledgement |
| `destructive` | Out-of-band xiNAS approval | Independently authenticated human approval |
| `unsupported_rollback` | Out-of-band xiNAS approval | Independently authenticated human approval |

`rollback_model: "unsupported"` SHOULD raise the confirmation level to out-of-band even if the plan's `risk_level` is lower.

### MRTR-POL-003 — Master gate order

The server MUST evaluate gates in this order:

1. authenticate the MCP caller;
2. authorize the tool through normal RBAC;
3. check `mcp.allow_apply`;
4. validate the apply request shape;
5. resolve the referenced plan;
6. verify plan ownership and tool/resource binding;
7. reject non-advisory blockers;
8. determine confirmation mode from the authoritative stored plan;
9. execute MRTR;
10. revalidate plan freshness;
11. atomically consume the confirmation and create the task;
12. dispatch the task.

If `mcp.allow_apply` is false, the server MUST return `MCP_APPLY_DISABLED` immediately and MUST NOT create an approval request.

### MRTR-POL-004 — `dangerous` independence

For destructive plans:

- the apply arguments MUST still contain `dangerous: true`;
- MRTR approval MUST also be present;
- satisfying one condition MUST NOT satisfy the other.

`dangerous: true` proves only that the caller constructed a destructive apply request. It does not prove that a person reviewed or approved the plan.

## 6. Plan persistence requirements

The existing task row preserves `plan_hash`, risk and affected resources, but does not persist the complete public plan response containing `diff`, warnings and client impact.

### MRTR-PLAN-001 — Canonical plan document

Plan creation MUST persist a canonical `plan_document` containing:

- `plan_id`;
- operation kind;
- resource identifier;
- `plan_hash`;
- `state_revision_expected`;
- `observed_revision_expected`;
- `observed_at`;
- `affected_resources`;
- `risk_level`;
- `client_impact`;
- `blockers`;
- `warnings`;
- `diff`;
- `rollback_model`;
- creation timestamp;
- principal that created the plan.

The document MUST represent exactly the material shown to the client in the plan response.

### MRTR-PLAN-002 — Integrity

The confirmation service MUST verify that:

- the stored document belongs to the supplied `plan_id`;
- its hash matches the stored `plan_hash`;
- its operation kind matches the invoked tool;
- its resource identity matches the tool arguments;
- the authenticated principal is allowed to apply it.

### MRTR-PLAN-003 — Sensitive data

The confirmation document MUST NOT contain:

- bearer tokens;
- passwords;
- private keys;
- raw authentication headers;
- unredacted support-bundle content;
- internal loopback credentials.

If a tool's spec may contain secrets, the confirmation document MUST contain only a redacted summary and hashes of protected values.

## 7. MRTR form workflow

Form confirmation is intended for `non_disruptive` and `changing_access` operations.

### MRTR-FORM-001 — Initial request

The client sends the ordinary apply call:

```json
{
  "jsonrpc": "2.0",
  "id": 100,
  "method": "tools/call",
  "params": {
    "name": "shares.update",
    "arguments": {
      "id": "share-a",
      "mode": "apply",
      "plan_id": "PLAN_UUID",
      "expected_revision": 42,
      "idempotency_key": "CLIENT_GENERATED_KEY"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": {
          "form": {}
        }
      }
    }
  }
}
```

### MRTR-FORM-002 — Input-required response

The server MUST stop before the loopback apply request and return:

```json
{
  "jsonrpc": "2.0",
  "id": 100,
  "result": {
    "resultType": "input_required",
    "inputRequests": {
      "confirm_apply": {
        "method": "elicitation/create",
        "params": {
          "mode": "form",
          "message": "Apply the reviewed xiNAS plan ...",
          "requestedSchema": {
            "type": "object",
            "properties": {
              "decision": {
                "type": "string",
                "enum": ["APPLY"],
                "title": "Confirm operation"
              }
            },
            "required": ["decision"]
          }
        }
      }
    },
    "requestState": "OPAQUE_SERVER_MINTED_VALUE"
  }
}
```

At least one of `inputRequests` or `requestState` is mandatory for an `InputRequiredResult`. xiNAS confirmation responses MUST contain both.

### MRTR-FORM-003 — Confirmation message

The message shown to the user MUST be generated from the stored canonical plan and MUST contain:

- xiNAS node identity;
- operation name;
- affected resources;
- risk level;
- plain-language client impact;
- rollback model;
- warnings;
- concise diff;
- plan ID;
- plan hash abbreviation;
- approval expiry time.

The message MUST NOT be constructed from model-provided prose.

For `changing_access`, the message MUST explicitly describe affected NFS clients, exports, addresses or access rules.

### MRTR-FORM-004 — Retry

The retry MUST:

- use a new JSON-RPC ID;
- repeat the same method;
- repeat the same tool name;
- repeat byte-equivalent semantic arguments;
- return the exact opaque `requestState`;
- include a bare `ElicitResult` under the original request key.

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "tools/call",
  "params": {
    "name": "shares.update",
    "arguments": {
      "id": "share-a",
      "mode": "apply",
      "plan_id": "PLAN_UUID",
      "expected_revision": 42,
      "idempotency_key": "CLIENT_GENERATED_KEY"
    },
    "inputResponses": {
      "confirm_apply": {
        "action": "accept",
        "content": {
          "decision": "APPLY"
        }
      }
    },
    "requestState": "OPAQUE_SERVER_MINTED_VALUE",
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": {
          "form": {}
        }
      }
    }
  }
}
```

The `inputResponses` entry MUST NOT be wrapped in an additional `{method, result}` object.

### MRTR-FORM-005 — Accepted response

`action: "accept"` MUST be accepted only when:

- the response key is exactly `confirm_apply`;
- `content` passes the requested schema;
- `decision` is exactly `APPLY`;
- `requestState` is valid;
- all bindings remain valid;
- the approval has not expired or been consumed.

### MRTR-FORM-006 — Decline and cancel

The following outcomes MUST NOT mutate xiNAS:

- `action: "decline"`;
- `action: "cancel"`;
- missing response;
- missing content;
- any decision other than exact `APPLY`.

Decline and cancel SHOULD return a normal completed tool result with:

- `resultType: "complete"`;
- `isError: true`;
- `CONFIRMATION_DECLINED` or `CONFIRMATION_CANCELLED`;
- confirmation ID;
- explicit statement that no apply task was created.

## 8. Destructive out-of-band workflow

A form response originates from the MCP client. A compromised or incorrectly implemented client can fabricate `action: "accept"`. Therefore form elicitation MUST NOT be the production security boundary for destructive operations.

### MRTR-OOB-001 — URL elicitation

For `destructive` and `unsupported_rollback`, xiNAS MUST return URL-mode elicitation:

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "confirm_apply": {
      "method": "elicitation/create",
      "params": {
        "mode": "url",
        "message": "This destructive xiNAS operation requires independent approval.",
        "url": "https://xinas.example/mcp/approvals/APPROVAL_ID"
      }
    }
  },
  "requestState": "OPAQUE_SERVER_MINTED_VALUE"
}
```

### MRTR-OOB-002 — Independent authentication

The approval page MUST require an independently authenticated xiNAS operator.

The server MUST NOT treat any of the following as proof of human approval:

- MCP bearer token;
- `clientInfo`;
- form `action: "accept"` alone;
- model-generated confirmation text;
- possession of `requestState`;
- `dangerous: true`.

### MRTR-OOB-003 — Approval page

The page MUST display the authoritative stored plan:

- node;
- operation;
- resource identifiers;
- exact risk;
- affected resources;
- warnings;
- destructive consequences;
- rollback limitations;
- diff;
- plan ID and hash;
- expiration.

The operator MUST perform an explicit destructive confirmation action.

For data-destroying operations, the confirmation control MUST state that data may be permanently lost.

### MRTR-OOB-004 — Transport security

A production approval URL MUST:

- use HTTPS;
- contain no MCP bearer token;
- contain no internal loopback token;
- use a cryptographically random approval identifier;
- implement CSRF protection;
- set restrictive CSP;
- deny framing;
- load no third-party scripts;
- prevent caching of the confirmation page;
- avoid logging sensitive URL parameters.

Plain HTTP MAY be used only on a verified loopback development endpoint.

### MRTR-OOB-005 — Completion

When the MCP client retries:

- `action: "accept"` means only that the client believes the browser flow is complete;
- the server MUST independently read the approval record;
- the operation may proceed only when the record is `approved`;
- the approving identity and the MCP principal MUST satisfy the configured authorization relationship.

If the operator declined, the retry MUST return `CONFIRMATION_DECLINED`.

## 9. Confirmation state

### MRTR-STATE-001 — Persistent approval record

Create a durable approval record with at least:

- `confirmation_id`;
- `status`: `pending | approved | declined | expired | consumed`;
- `principal`;
- `role`;
- `plan_id`;
- `plan_hash`;
- `tool_name`;
- `arguments_hash`;
- `idempotency_key`;
- `expected_revision`;
- `risk_level`;
- `confirmation_mode`;
- `request_state_nonce_hash`;
- `created_at`;
- `expires_at`;
- `approved_at`;
- `approved_by`;
- `consumed_at`;
- `consumed_task_id`;
- `correlation_id`.

### MRTR-STATE-002 — Expiration

Default approval TTL: 300 seconds.

The value SHOULD be configurable within a bounded range. The initial implementation SHOULD allow 60–900 seconds.

An expired approval:

- MUST never be revived;
- MUST not create a task;
- MUST require a fresh apply attempt;
- SHOULD require re-planning when the plan's observation freshness is no longer valid.

### MRTR-STATE-003 — Single use

A confirmation MUST be single-use.

Consumption MUST occur atomically with:

- final freshness validation;
- lease acquisition;
- idempotency evaluation;
- apply-task insertion.

Concurrent accepted retries MUST create no more than one task.

An identical retry using the same idempotency key MAY return the existing `task_id`. A retry with changed bindings MUST fail.

### MRTR-STATE-004 — Restart behavior

Pending and approved confirmations MUST survive an API restart.

On startup:

- expired pending approvals MUST be marked expired;
- consumed approvals MUST remain consumed;
- an approved but unconsumed record MAY still be used until expiry;
- no restart may reset a consumed record to approved.

## 10. `requestState` security

### MRTR-SEC-001 — Untrusted intermediary

The client MUST be treated as an untrusted intermediary. SEP-2322 requires servers to validate returned state and bind user-specific state to the authenticated user.

### MRTR-SEC-002 — Required bindings

`requestState` MUST bind:

- schema version;
- confirmation ID;
- authenticated principal;
- role or authorization context;
- tool name;
- canonical arguments hash;
- plan ID;
- plan hash;
- expected revision;
- idempotency key;
- risk level;
- confirmation mode;
- issued-at time;
- expiry;
- nonce;
- MRTR round number.

It MUST NOT contain bearer credentials or raw secrets.

### MRTR-SEC-003 — Protection

`requestState` MUST be authenticated with:

- HMAC-SHA-256 or stronger; or
- authenticated encryption such as AES-GCM.

Unsigned base64 JSON is forbidden.

Verification MUST:

- use a strict algorithm allowlist;
- reject unknown versions and key IDs;
- use constant-time signature comparison;
- enforce a maximum encoded size;
- support controlled key rotation;
- occur before interpreting any state field.

Recommended maximum encoded size: 4 KiB.

### MRTR-SEC-004 — Replay and hijacking

The server MUST reject:

- state minted for another principal;
- state minted for another tool;
- changed arguments;
- changed plan or revision;
- changed idempotency key;
- an expired state;
- a consumed confirmation;
- a nonce not matching the stored record.

`serverInfo` and `clientInfo` are self-reported and MUST NOT participate in authorization.

## 11. Control-path integration

### MRTR-CORE-001 — No mutation before acceptance

Before successful confirmation, the MCP path MUST NOT:

- call the REST apply route;
- acquire resource leases;
- create an apply task;
- modify desired state;
- invoke the agent;
- perform any privileged operation.

Creating the approval record is the only permitted write.

### MRTR-CORE-002 — Loopback context

After validation, the MCP layer MAY forward a confirmation ID through a loopback-only internal header.

That header MUST:

- be ignored on all externally authenticated requests;
- be accepted only with the ephemeral loopback bearer;
- be copied into trusted request context rather than the public request body.

### MRTR-CORE-003 — Core enforcement

For `client_type: "mcp"`, the apply transaction MUST fail closed if trusted confirmation context is absent.

The task engine MUST verify and consume the confirmation inside the same SQLite transaction that creates the apply task.

This prevents bypass through:

- a future alternative MCP dispatcher;
- concurrent retries;
- direct invocation of the internal apply route;
- a crash between approval consumption and task creation.

### MRTR-CORE-004 — Existing safeguards

Successful confirmation MUST NOT bypass:

- RBAC;
- `mcp.allow_apply`;
- expected-revision validation;
- observed-state freshness;
- plan hash verification;
- blockers;
- idempotency;
- leases;
- dangerous gate;
- worker-pool admission;
- task rollback behavior.

## 12. Client capability and compatibility

### MRTR-COMPAT-001 — Capability checking

Before returning an elicitation request, the server MUST inspect the current request's:

`_meta["io.modelcontextprotocol/clientCapabilities"].elicitation`

Required capability:

- form confirmation: `elicitation.form`;
- destructive approval: `elicitation.url`.

Capability from a previous request MUST NOT be cached as authorization evidence.

### MRTR-COMPAT-002 — Missing capability

If the operation requires a capability the client did not declare, return:

- JSON-RPC code `-32021`;
- HTTP status `400` for Streamable HTTP;
- `data.requiredCapabilities` containing the missing capability.

The server MUST NOT silently execute the operation or downgrade a destructive approval from URL to form.

### MRTR-COMPAT-003 — Legacy clients

Legacy MCP clients:

- may list tools;
- may execute reads;
- may execute `mode="plan"`;
- may call `support.bundle`;
- may call `tasks.cancel`;
- MUST be denied `mode="apply"` once S15 enforcement is enabled.

The denial MUST identify that MCP `2026-07-28` plus elicitation support is required and direct the operator to REST, `xinasctl` or the TUI.

### MRTR-COMPAT-004 — Round limit

xiNAS MUST allow no more than three input-required rounds for one logical confirmation.

Exceeding the limit MUST return `CONFIRMATION_ROUND_LIMIT` without mutation.

Normally a xiNAS apply confirmation requires exactly one round.

## 13. Error behavior

| Condition | Required result |
|---|---|
| `mcp.allow_apply=false` | `MCP_APPLY_DISABLED` |
| Client lacks elicitation capability | JSON-RPC `-32021` |
| Malformed `inputResponses` | JSON-RPC `-32602` |
| Invalid or tampered `requestState` | JSON-RPC `-32602`, generic message |
| Cross-principal state | Reject without revealing original principal |
| User declines | `CONFIRMATION_DECLINED` |
| User closes dialog | `CONFIRMATION_CANCELLED` |
| Confirmation expires | `CONFIRMATION_EXPIRED` |
| Confirmation already used with different request | `CONFIRMATION_ALREADY_CONSUMED` |
| Plan revision changed | Existing `PRECONDITION_FAILED` |
| Observed state became stale | Existing `CONFLICT`, reason `plan_stale` |
| Active plan blocker | Existing `PRECONDITION_FAILED` |
| Same idempotency key and same operation | Return original task |
| Same idempotency key with changed operation | Existing `CONFLICT`, reason `idempotency_key_reused` |

Security errors MUST NOT echo decoded `requestState`, signatures, tokens or protected plan data.

## 14. Audit and observability

### MRTR-AUD-001 — Approval events

Audit events MUST be emitted for:

- confirmation requested;
- confirmation viewed;
- approved;
- declined;
- cancelled;
- expired;
- verification failed;
- replay rejected;
- consumed;
- apply task created.

Each event MUST include:

- confirmation ID;
- plan ID;
- plan hash;
- principal;
- approver identity where available;
- operation kind;
- risk level;
- correlation ID;
- resulting task ID where available;
- reason code.

### MRTR-AUD-002 — Audit row parity

The final apply MUST still produce exactly one operational audit row through the normal REST loopback path.

MRTR lifecycle events are security events and MUST NOT create duplicate operation rows.

### MRTR-AUD-003 — Metrics

Expose counters for:

- confirmations requested by risk and mode;
- accepted, declined, cancelled and expired;
- capability failures;
- state-validation failures;
- replay attempts;
- round-limit failures;
- confirmation-to-apply latency;
- approved confirmations that expired without consumption.

Metrics MUST NOT include tokens or complete `requestState` values.

## 15. Resource limits

The implementation MUST bound:

- pending confirmations per principal;
- pending confirmations globally;
- confirmation creation rate;
- MRTR rounds;
- requestState size;
- approval lifetime;
- retained audit records.

Recommended initial defaults:

- five pending confirmations per principal;
- 100 pending confirmations per node;
- 300-second TTL;
- three MRTR rounds;
- 4 KiB requestState limit.

Limit exhaustion MUST fail closed and MUST NOT evict an approved confirmation in a way that permits a different operation to reuse it.

## 16. Required tests

### Unit tests

- all modern complete results contain `resultType: "complete"`;
- input-required result validates against MCP 2026-07-28 schema;
- form and URL capability detection;
- canonical arguments hash stability;
- requestState signing and verification;
- wrong key, altered byte, expired state and unknown version rejection;
- action handling for `accept`, `decline` and `cancel`;
- risk-to-confirmation-mode mapping;
- round-limit enforcement;
- redaction of secrets.

### Integration tests

- plan → form confirmation → apply → task;
- destructive plan → URL approval → apply → task;
- destructive plan cannot use form-only client;
- apply creates no task before approval;
- declined/cancelled/expired approval creates no task;
- different principal cannot use the confirmation;
- changed tool arguments invalidate confirmation;
- changed revision fails;
- changed idempotency key fails;
- non-advisory blocker prevents confirmation creation;
- `dangerous: true` without approval fails;
- approval without `dangerous: true` fails for a destructive plan;
- external callers cannot inject the internal confirmation header;
- legacy read and plan paths remain unchanged;
- legacy apply is denied;
- `support.bundle` and `tasks.cancel` remain available.

### Concurrency and recovery tests

- two simultaneous accepted retries create exactly one task;
- identical retry returns the same task;
- different retry with reused idempotency key returns conflict;
- restart while approval is pending;
- restart after approval but before consumption;
- restart after consumption;
- expiration cleanup after restart.

### Client interoperability tests

- Claude Code 2.1.259 or newer:
  - form dialog;
  - URL dialog;
  - exact requestState echo;
  - new JSON-RPC request ID;
  - decline and cancel.
- Codex 0.147 or newer with MCP 2026-07-28 enabled:
  - form confirmation;
  - exact retry;
  - safe failure if URL elicitation is unavailable.
- Hand-written conformance client:
  - malformed and hostile protocol cases;
  - capability absence;
  - cross-principal replay.

## 17. Acceptance criteria

The implementation is accepted only when all statements are true:

1. No modern xiNAS result omits `resultType`.
2. No MCP apply operation reaches the REST apply handler before confirmation.
3. No destructive operation can proceed on form acceptance alone.
4. Confirmation is bound to principal, tool, arguments, plan, revision and idempotency key.
5. Tampering with any byte of protected state is rejected.
6. A confirmation can create at most one apply task.
7. Restart does not make consumed approval reusable.
8. `dangerous`, RBAC, freshness, blockers and `mcp.allow_apply` remain independently enforced.
9. Legacy reads and plans retain their existing behavior.
10. Legacy MCP apply fails closed.
11. REST, CLI and TUI contracts are unchanged.
12. Every approval decision is auditable.
13. Claude Code completes the reference flow end to end.
14. Codex either completes the supported flow or fails before mutation with a precise capability error.
15. All protocol examples validate against the MCP `2026-07-28` schema.

## 18. Reference demonstration

The acceptance demonstration SHOULD use a real xiNAS plan/apply operation:

1. Request deletion or destructive recreation of a test filesystem.
2. xiNAS returns the deterministic plan.
3. Client sends `mode="apply"` with `dangerous: true`.
4. xiNAS returns `resultType: "input_required"`.
5. Client opens the independent xiNAS approval page.
6. Operator sees the exact filesystem, backing array, affected exports, data-loss warning and rollback limitation.
7. Operator approves.
8. Client retries with the exact `requestState`.
9. xiNAS atomically consumes approval and creates the apply task.
10. Client follows the task to completion.
11. Audit shows the plan, approval identity, confirmation ID and resulting task ID.

No test or demonstration may use a model-generated word such as "yes" as the sole authorization for a destructive operation.

---

## Appendix A — Validation record (2026-09-04)

Everything above this line is the requirement text as received. This
appendix is the audit of its claims, performed before any spec or code
was written (`CLAUDE.md` §spec-first rule 5). Verdicts: **confirmed**,
**corrected** (the requirement is right in intent but wrong in a detail
the spec has to handle), **gap** (the requirement assumes something the
code does not have), **note** (context, no action). Each row has an ID
the S15 spec cites.

Sources checked: MCP `2026-07-28` [`schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
and its `examples/`, the [MRTR pattern page](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/patterns/mrtr.mdx),
the [elicitation page](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/client/elicitation.mdx),
the [tools page](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx),
[SEP-2322](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2322-MRTR.md),
npm metadata and tarballs of the MCP SDK packages, the installed Claude
Code binary, the Codex `rust-v0.147.0` release notes, and the xiNAS
control-path source at `release/3.14` (`8afc9dc`).

### A.1 MCP protocol claims

| ID | Claim in the requirement | Source | Verdict |
|---|---|---|---|
| V-01 | `resultType` is mandatory on every `2026-07-28` result | `schema.ts` `Result.resultType`: "Servers implementing this protocol version MUST include this field"; clients treat an *absent* field as `complete` only for servers of an earlier version | **confirmed** |
| V-02 | The modern `tools/call` result is `CallToolResult \| InputRequiredResult` | `schema.ts` `CallToolResponse.result: CallToolResult \| InputRequiredResult` | **confirmed** |
| V-03 | An `InputRequiredResult` needs at least one of `inputRequests` / `requestState` | `schema.ts` `InputRequiredResult` doc; mrtr.mdx server requirement 6 | **confirmed** — xiNAS always sends both (stricter, schema-valid) |
| V-04 | Missing client capability → JSON-RPC `-32021`, HTTP `400`, `data.requiredCapabilities` | `MISSING_REQUIRED_CLIENT_CAPABILITY = -32021`; `MissingRequiredClientCapabilityError`: "For HTTP, the response status code MUST be `400 Bad Request`"; `data.requiredCapabilities` is a `ClientCapabilities` object, e.g. `{"elicitation": {"url": {}}}` | **confirmed** |
| V-05 | Capability is read from `_meta["io.modelcontextprotocol/clientCapabilities"].elicitation.{form,url}` | elicitation.mdx §Capabilities; `schema.ts` `ClientCapabilities.elicitation?: { form?, url? }` | **corrected** — an *empty* `elicitation: {}` MUST be treated as form-only support (backwards-compatibility rule). S15 §14 counts it as `form` capable |
| V-06 | A form `requestedSchema` with `{type: string, enum: ["APPLY"], title}` is valid | elicitation.mdx form schema subset: single-select enum without titles | **confirmed** |
| V-07 | In URL mode `action: "accept"` means the user consented to open the URL, not that the flow completed; the server decides from its own state | elicitation.mdx §URL Mode: "It does not mean that the interaction is complete … the server determines from the echoed `requestState` (or its own stored state) whether the out-of-band interaction has completed, and either returns the final result or responds with another `InputRequiredResult`"; the flow diagram notes the server "may need to block until the request is fulfilled" | **confirmed** — drives the bounded wait + re-issue rule in S15 §4.5 |
| V-08 | `inputResponses` entries are bare `ElicitResult`s keyed by the request key | `schema.ts` `InputResponses`, `examples/InputResponses/*.json` | **confirmed** |
| V-09 | The retry MUST carry a new JSON-RPC id | mrtr.mdx client requirement 3; tools.mdx | **confirmed** |
| V-10 | The server MUST NOT send a mode the client did not declare, and MUST NOT downgrade | mrtr.mdx server requirement 7; elicitation.mdx "Servers MUST NOT send elicitation requests with modes that are not supported by the client" | **confirmed** |
| V-11 | `requestState` is attacker-controlled; integrity protection is required when it influences authorization; bind principal, TTL, request identity; single-use must be enforced server-side | mrtr.mdx server requirements 4–5 (MUST protect integrity, SHOULD bind, warning: "Servers for which a given `requestState` must be consumed at most once … MUST enforce that invariant server-side") | **confirmed** — the requirement upgrades the vendor SHOULDs to MUSTs, which is allowed |
| V-12 | "SEP-2322 requires servers to validate returned state and bind user-specific state to the authenticated user" | SEP §Protocol Requirements for Ephemeral Workflow, server behavior | **confirmed** |
| V-13 | An approval URL must be independently authenticated, never pre-authenticated, HTTPS in production | elicitation.mdx §Security: servers MUST bind elicitation to client and user identity; MUST NOT provide a pre-authenticated URL; MUST verify the identity of the user who opens the URL (phishing scenario); SHOULD use HTTPS outside development | **confirmed** |
| V-14 | MRTR works without the Tasks extension | SEP §Ephemeral Tool Workflow; the published `2026-07-28` MRTR page lists `prompts/get`, `resources/read`, `tools/call` as the supported requests | **confirmed** |
| V-15 | Round limits | Not a protocol concept; mrtr.mdx server requirement 8 permits repeated `InputRequiredResult` | **note** — xiNAS-local policy |
| V-16 | Malformed `inputResponses` → `-32602` | mrtr.mdx §Error Handling: protocol errors return a JSON-RPC error; *missing* responses SHOULD get a fresh `InputRequiredResult` rather than an error | **corrected** — S15 distinguishes *malformed* (JSON-RPC `-32602`) from *missing* (re-issue, counted against the round limit) |
| V-17 | Tampered `requestState` → `-32602` with a generic message | Vendor: "MUST reject state that fails verification"; code unspecified | **note** — xiNAS choice, compatible |
| V-18 | (implicit) xiNAS may define its own JSON-RPC codes | `schema.ts` error-code partition: `-32000..-32019` implementation-defined, `-32020..-32099` reserved for the specification | **note** — xiNAS already uses `-32000` (401/405/503 on `/mcp`); any new xiNAS-specific JSON-RPC code stays in `-32000..-32019` |

### A.2 Client and SDK claims

| ID | Claim | Evidence | Verdict |
|---|---|---|---|
| V-19 | Claude Code 2.1.259+ supports the flow (form dialog, URL dialog, exact `requestState` echo, new id) | The installed `claude` 2.1.259 binary (`@anthropic-ai/claude-code/bin/claude.exe`) contains `server/discover` ×40, `2026-07-28` ×26, `input_required` ×29, `requestState` ×35, `inputResponses` ×9, `elicitation/create` ×39, `versionNegotiation` ×34 — the v2 SDK client with modern-era negotiation is embedded. Form and URL elicitation dialogs shipped in 2.1.76 (changelog). The changelog text never names `2026-07-28` | **target client, not a verified claim** — strings prove the client is embedded, not that its form/URL UI, state echo or id handling are correct; the spec (§14.4) states expected behavior and the runbook step is the only proof |
| V-20 | Codex 0.147+ with MCP `2026-07-28` enabled supports form confirmation and exact retry | `rust-v0.147.0` release notes: "Support the opt-in MCP 2026-07-28 protocol, including paginated discovery, multi-round requests, and non-blocking server startup"; opt-in via `protocol_version = "2026-07-28"` in `config.toml` (third-party guides) | **target client** — MRTR support is documented upstream; **URL-mode support unverified**, and the locally installed copy is 0.136.0 (V-54); the `-32021` path is the safe failure the requirement expects |
| V-21 | (S14 / `docs/TODO.md` premise) no published SDK implements the modern era | `@modelcontextprotocol/sdk` latest is still `1.30.0` (legacy-only). The modern era shipped as the **v2 package family** `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core` `2.0.0` (npm, 2026-07-28); their tarballs contain `server/discover`, `input_required`, `createRequestStateCodec`, `versionNegotiation` and elicitation handling | **corrected** — the deferral is obsolete (SPEC-007); the v2 client is the natural interop test client (S14 AC10/11 become implementable as a by-product) |
| V-22 | Examples can be validated against the `2026-07-28` schema | `ajv` is already a devDependency (`src/__tests__/contracts/`); `schema/2026-07-28/schema.json` is 181 KB and vendorable | **confirmed** |
| V-54 | (review, 2026-09-04) the Codex manual acceptance can run on the development Mac | `codex --version` → `codex-cli 0.136.0`; MRTR needs ≥ 0.147.0 | **gap** — upgrade Codex before the runbook step; until then the Codex rows in §14.4 of the spec are targets, not results |

### A.3 Codebase claims

| ID | Claim | Evidence (paths relative to `xiNAS-MCP/src/`) | Verdict |
|---|---|---|---|
| V-23 | §4 compliance blocker: modern `tools/list` / `tools/call` results lack `resultType` | `api/mcp/modern.ts:100` returns `{ tools }`; `:114` returns the raw `ToolResult`; only `server/discover` carries `resultType`. `__tests__/api/mcp-discover.test.ts` never asserts it on `tools/*` | **confirmed** |
| V-24 | The task row keeps `plan_hash`, risk, affected resources but not the full plan | There is **no plans table**: `plan_id` is the `task_id` of a `state='plan_only'` row. Persisted: `plan_hash`, `risk_level`, `affected_resources`, `state_revision_expected`, `spec`, `plan_binding`, `input_hash`, `principal`. **Not** persisted: `blockers`, `warnings`, `diff`, `client_impact`, `rollback_model`, `observed_at`; `observed_revision_expected` only indirectly via `plan_binding` (`api/plan/engine.ts:113-124`, `:168-176`) | **confirmed, wider than stated** — `plan_document` is a new column (migration `006`) |
| V-25 | "its hash matches the stored `plan_hash`" | `plan_hash` is sha256 over the *enriched internal* record (`operation_kind`, enriched spec, `affected_resources`, `diff`, revisions, `lease_resources`, `desired_mutations`; `api/plan/engine.ts:194-205`), not over the public plan body | **corrected** — S15 §5 stores `plan_hash` *inside* the document and adds `plan_document_hash` for the document's own integrity |
| V-26 | Step 7 of POL-003, "reject non-advisory blockers" | The task engine never checks blockers. The bespoke routes (`routes/arrays.ts:218`, `network.ts:228`, `filesystems.ts:142`) re-run `provider.preflight` at apply; the shared `applyMode` (`routes/apply-helpers.ts:174-272`, used by shares, nfs-profiles, pools, config-history, reference) does not | **gap** — S15 enforces it from the persisted document for the MCP path; the REST-side inconsistency is pre-existing and outside this scope (decision D-07) |
| V-27 | "same idempotency key with changed operation → `CONFLICT` `idempotency_key_reused`" | Change detection is `input_hash` = sha256(`{operation_kind, raw spec}`) (`api/tasks/engine.ts:366-378`); it excludes `plan_id`, `expected_revision`, `dangerous` | **corrected** — holds for kind/spec changes only; S15 binds the confirmation to plan id, plan hash, revision and key, so any other change fails on the confirmation before idempotency is consulted |
| V-28 | Consumption can be atomic with task creation | `TaskEngine.apply()` (`api/tasks/engine.ts:361-538`) runs one `db.transaction` (`:364`): idempotency → dangerous gate → freshness → desired-KV mutation → task insert → leases. Everything inside is synchronous (better-sqlite3); HMAC and record checks fit | **confirmed** — hook after the idempotency SELECT (`:370`), before the dangerous gate (`:384`) |
| V-29 | Lifecycle events must not duplicate the operational audit row | The one operational row is written by `middleware/audit.ts:47-80` after the response, outside the transaction; `/mcp` frames are skipped (`:29-32`). `AuditAppender.queue()` (`state/audit.ts:60-89`) is designed for in-transaction use and has no caller today | **confirmed** — lifecycle events are queued explicitly with distinct kinds `mcp.confirmation.*` (S15 §12) |
| V-30 | Metrics can be exposed | No `prom-client`, no registry, no counter anywhere; the only Prometheus contact is a read-through of the external xiRAID exporter (`api/handlers/read-seams.ts:74`) | **gap** — decision D-05 |
| V-31 | An approval page can be served | No HTML, cookie, CSP, CSRF or static-file code exists in the api; the only non-JSON responses are SSE and gzip | **gap** — greenfield, decision D-02 |
| V-32 | Capability checking is new | `_meta` is read for `protocolVersion` only (`api/mcp/modern.ts:39,57`); `clientCapabilities`, `clientInfo`, `elicit*` appear nowhere in `src/` | **confirmed** |
| V-33 | HMAC and canonical hashing | `createHmac` is unused; `lib/canonical-json.ts` `canonicalize()` already backs `plan_hash` and the audit hash chain | **confirmed** — reuse `canonicalize()` for the arguments hash; add `createHmac` |
| V-34 | `dangerous` is independent of confirmation | The gate is `plan.risk_level === 'destructive' && dangerous !== true` → `PRECONDITION_FAILED` `details.reason: dangerous_flag_required`, inside the apply transaction (`api/tasks/engine.ts:384-391`); it is not a catalog field | **confirmed** — POL-004 falls out of the transaction ordering |
| V-35 | Bounded configuration | `ApiConfig` is a TS interface loaded by `JSON.parse` without structural validation; the only bounded validator is `validateTasksSection` for `tasks.max_inflight` (`api/config.ts:118-132`) | **confirmed** — pattern to copy for `mcp.confirmation.*` |
| V-36 | TTL logic is testable | `TaskEngine` calls `Date.now()` directly (`engine.ts:241,290,340,746`); `TaskStore` takes an injected `now()` | **note** — S15 injects a clock into the confirmation store and engine deps |
| V-37 | Plan freshness after expiry | No plan TTL exists; `plan_only` rows are never GC'd (`state/gc.ts:38-47` prunes terminal tasks only) | **note** — approval TTL is self-contained; confirmation rows get their own GC |
| V-38 | "at most one apply task" when dispatch fails | `failBeforeChange` runs outside the transaction (`engine.ts:732-775`) | **note** — a consumed confirmation stays consumed; the task exists as `failed (FAILED_BEFORE_CHANGE)`; the operator re-plans |
| V-39 | The bound principal is the MCP caller | `api/mcp/transport.ts:43-63` `resolveIdentity()` is a second auth resolver (bearer → `config.tokens`; UDS → `mcp:local_admin`), distinct from `middleware/auth.ts` (UDS → `local:uds`) | **note** — the record binds the MCP-resolved `{principal, role}`; the core compares against the forwarded principal, which is the same string |
| V-40 | (out of scope) | A known legacy `Mcp-Session-Id` dispatches before the token is re-checked (`transport.ts:127-131`); the `sessions` map is unbounded | **note** — pre-existing; not changed by S15; flagged |
| V-41 | (out of scope) | `STATUS_MAP` maps `PERMISSION_DENIED` to 401 (`api/errors.ts:22-31`) | **note** |
| V-42 | Reference demonstration uses a destructive filesystem operation | `filesystems.delete` / destructive recreate are `plan_apply` entries; their plan providers' `risk_level` for the delete path is assumed `destructive` | **to confirm during implementation** against `s5-filesystem-spec.md` |
| V-53 | (review, 2026-09-04) `rollback_model` values are the `Plan` enum | `api/plan/providers/nfs.ts` (5 sites) and `pool.ts` (3) emit `reversible`; `config-rollback.ts` (2) and `support.ts` emit `executor_managed`; the enum is `[non_disruptive, changing_access, destructive, unsupported]`; `reference.ts` was normalized in S3 T0, the rest were not | **gap** — pre-existing contract violation of live REST plans; S15 normalizes the providers before persisting any document (spec §3.2) and makes the engine refuse out-of-enum values |

### A.4 Internal consistency of the requirement

| ID | Observation | Resolution in S15 |
|---|---|---|
| V-43 | POL-001 requires confirmation for "every future direct tool with `requires_mcp_apply: true`"; both existing `direct` entries carry `false` | Consistent; the rule is forward-looking |
| V-44 | FORM-002 and OOB-001 require both `inputRequests` and `requestState` although the schema needs only one | Stricter local rule, schema-valid (V-03) |
| V-45 | §13 maps "client lacks elicitation capability" to `-32021`, but COMPAT-003 legacy clients carry no `_meta` at all and cannot act on a capability error | Legacy apply is a **tool error** `MCP_CONFIRMATION_UNSUPPORTED` in the legacy wire shape; `-32021` is reserved for modern clients that omit the needed mode (§11) |
| V-46 | STATE-001 lists statuses `pending \| approved \| declined \| expired \| consumed`; FORM-006 and AUD-001 name a *cancelled* outcome | The record status set gains `cancelled` so the audit trail and the record agree (§6) |
| V-47 | COMPAT-004 allows three rounds, but in URL mode an eager client can retry before the human has decided and exhaust the limit | Bounded server-side wait (`url_wait_seconds`, default 25) before a re-issue; a re-issue counts as a round; exhausting the limit expires the record (§4.5) |
| V-48 | SEC-002 binds "role or authorization context" | The MCP identity is `{principal, role}`; both are bound |
| V-49 | POL-002 raises `rollback_model: "unsupported"` to out-of-band | The api enum is `[non_disruptive, changing_access, destructive, unsupported]`; mapping in §3.2 |
| V-50 | COMPAT-003 says "once S15 enforcement is enabled", implying a switch | S15 has **no** switch that disables confirmation (decision D-01); the only knobs are TTL, limits, approver policy and URL base |
| V-51 | OOB-004 requires HTTPS for a production approval URL; the api has no TLS of its own (S8 §6c: TLS is a front proxy's job) | `mcp.confirmation.approval_url_base` must be configured; without it URL mode fails closed (decision D-03) |
| V-52 | §6 requires the document to be "exactly the material shown to the client" | The plan response is rendered *from* the persisted document (single source), pinned by a test (§5) |

### A.5 Decisions taken (override in review if wrong)

| ID | Decision | Why |
|---|---|---|
| D-01 | Confirmation enforcement is unconditional once S15 ships; there is no `enabled: false` | A disable knob is a bypass; `mcp.allow_apply` already is the administrative off-switch for MCP mutation |
| D-02 | The approval page is served by `xinas-api` at `/mcp/approvals/{id}`; the operator authenticates on the page with a xiNAS api bearer token of role `admin`; no cookies, token held in page memory only; the same decision is available over REST (`/api/v1/mcp/confirmations/{id}/approve`); `xinasctl` over the UDS only as break-glass (D-06). **Accepted conditionally in review:** a distinct credential is a separate *credential*, not proof of a separate *person* — spec §3.5 states the boundary | Reuses the one credential store that exists; no session/cookie machinery; CSRF has no ambient credential to ride on |
| D-03 | `mcp.confirmation.approval_url_base` (an `https://` origin, or `http://` on a loopback host) is required for URL mode; when unset, a destructive MCP apply fails closed with `CONFIRMATION_URL_UNAVAILABLE` naming the key | Honest fail-closed instead of emitting an insecure URL |
| D-04 | `requestState` is HMAC-SHA-256 with a persisted key ring (`state.confirmationKeyPath`, default beside the DB; key ids; rotation by adding a key and restarting — no CLI in this slice) | Approvals must survive restart (STATE-004), so the key cannot be per-process |
| D-05 | Metrics: a dependency-free in-process registry rendered in Prometheus text format at `GET /api/v1/metrics` (viewer role) | AUD-003 needs *some* surface; the node already speaks Prometheus (xiRAID exporter) |
| D-06 | **Revised in review (P0).** The default approver policy is `distinct_principal` (approver ≠ requester, role `admin`). UDS peer-trust approvals (`local:uds`) are **disabled by default** (`allow_uds_approval: false`), are an explicitly enabled break-glass, and emit their own audit event (`break_glass_used`). The MRTR guarantee is stated to hold only for an agent without root or `xinas-admin` on the node; where root is in the threat model, approval happens off the node (spec §3.5) | An agent with root can read every token, edit SQLite or the api itself — a UDS switch closes one path, not the boundary; the contract must say so rather than imply the switch is the fix |
| D-07 | The REST-side blocker gap (V-26) is not fixed here | Out of the requested scope; flagged for a separate fix |
| D-08 | `@modelcontextprotocol/client` 2.0.0 becomes a devDependency for interop tests; the S14 AC10/11 tests are written as a by-product and the obsolete `docs/TODO.md` entry is removed | SPEC-007 asks for the obsolete deferral to go; the cheapest honest way is to do the deferred work |
| D-09 | A TUI "pending MCP approvals" screen is deferred and recorded in `docs/TODO.md` | The page, REST and `xinasctl` cover approvals; the TUI is additive |
