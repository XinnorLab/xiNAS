# xiNAS S15 — MCP MRTR safe-operation confirmation (design spec)

**Status:** implemented (2026-09-05) — Tasks 0–12 via PR #375, Tasks 13–17 and the whole-feature review wave via the follow-up PR into release/3.14; §3.5 token-surface ruling recorded. Extends **ADR-0010** /
`s8-clients-spec.md` (the `/mcp` transport inside `xinas-api.service`),
**S14** (`s14-mcp-modern-era-spec.md`, the MCP `2026-07-28` modern era) and
**S2** (`s2-task-envelope-spec.md`, the plan/apply task engine).

**Requirements source:** [`s15-mcp-mrtr-requirements.md`](s15-mcp-mrtr-requirements.md)
(unmodified incoming text; its Appendix A is the validation record this
spec cites as `V-nn` / `D-nn`). Where this spec deviates from that
document it says so inline and points at the row that forced it.

**Goal.** An MCP client cannot make xiNAS change state without a human
confirming the *authoritative, persisted* plan through a channel the model
does not control. Non-disruptive and access-changing operations are
confirmed in-band through an MCP `2026-07-28` **Multi Round-Trip Request**
(form elicitation). Destructive operations are approved **out of band** by
an independently authenticated xiNAS operator, and the MRTR only carries
the client's acknowledgement that the browser flow happened. The
confirmation is bound to the principal, the tool, the arguments, the plan
and the idempotency key; it is single-use; it is verified and consumed
inside the same SQLite transaction that creates the apply task; and it sits
*behind* — never instead of — `mcp.allow_apply`, RBAC, the `dangerous`
flag, revision freshness, blockers, idempotency and leases.

---

## 1. Scope

### In scope

- **T0 contracts:** this spec; ADR-0010 amendment; S14 §MRTR; S8 §MRTR
  client behavior; S2 §17 confirmation consumption; `api-v1.yaml`
  additions (§9, §11, §12 — all additive; `ApplyRequest` untouched).
- **T1 `resultType` compliance** (requirement §4, V-23): every modern
  result carries `resultType`; `complete` for `tools/list`, `tools/call`
  and tool errors; `input_required` for an unfinished MRTR. Legacy results
  keep their wire shape.
- **T2 plan document** (§5): the public plan is persisted verbatim on the
  `plan_only` row and the plan response is rendered from it. **T2b** first
  normalizes the four providers whose `rollback_model` is off-contract
  (§3.2, V-53) and makes the plan engine refuse out-of-enum values.
- **T3 confirmation store + state machine** (§6): `mcp_confirmations`
  table (migration `006`), TTL, limits, GC, startup expiry.
- **T4 `requestState` codec** (§7): HMAC-SHA-256, key ring, bindings,
  constant-time verification, 4 KiB cap.
- **T5 MRTR dispatch** (§4, §14): capability checks, form flow, URL flow,
  retry validation, decline/cancel, round limit, legacy denial, JSON-RPC
  error mapping with HTTP status.
- **T6 core enforcement** (§8): loopback-only confirmation header →
  trusted context → verified and consumed inside `TaskEngine.apply()`.
- **T7 out-of-band approval** (§9): REST routes, `xinasctl` commands
  (catalog entries hidden from MCP), the approval page.
- **T8 audit + metrics** (§12).
- **T9 configuration** (§13).
- **T10 tests** (§15) including the v2 SDK client and a hostile
  conformance client.
- **T11 repository guidance** (§17): `CLAUDE.md` live-contract list,
  `docs/TODO.md` (obsolete SDK deferral removed; TUI screen deferral
  recorded).

### Out of scope

- Changing REST, `xinasctl` or TUI confirmation semantics (those keep the
  `dangerous` flag and their own dialogs — requirement §2).
- The MCP Tasks extension (§4.7 records how MRTR relates to it).
- A TUI "pending MCP approvals" screen (D-09, recorded in `docs/TODO.md`).
- Fixing the REST-side blocker re-check gap in `applyMode` (V-26, D-07).
- Anything under `docs/MCP/` (reference-only).
- The legacy-session observations V-40 / V-41.

---

## 2. Verified facts this design rests on

The full audit is Appendix A of the requirements file. The rows below are
the ones a reader needs to follow this spec.

| Fact | Row |
|---|---|
| `resultType` is mandatory on every `2026-07-28` result; `tools/call` returns `CallToolResult \| InputRequiredResult`; an `InputRequiredResult` needs ≥ 1 of `inputRequests` / `requestState` | V-01, V-02, V-03 |
| Missing capability is JSON-RPC `-32021`, HTTP 400, `data.requiredCapabilities: ClientCapabilities` | V-04 |
| `elicitation: {}` means form-only; `elicitation.url` must be declared explicitly for URL mode; the server never sends an undeclared mode | V-05, V-10 |
| URL-mode `accept` is consent to open, not completion; the server decides from its own state and may re-issue an `InputRequiredResult` | V-07 |
| `requestState` is attacker-controlled: integrity-protect, bind principal/TTL/request, enforce single use server-side | V-11, V-12 |
| Claude Code 2.1.259 embeds the v2 modern-era client; Codex 0.147 has opt-in `2026-07-28` with multi-round requests; the v2 SDK (`@modelcontextprotocol/{server,client,core}` 2.0.0) implements MRTR | V-19, V-20, V-21 |
| There is no plans table; the public plan fields `blockers`, `warnings`, `diff`, `client_impact`, `rollback_model`, `observed_at` are not persisted today | V-24 |
| `plan_hash` is not a hash of the public plan body | V-25 |
| The task engine does not check blockers; only the bespoke routes do | V-26 |
| `TaskEngine.apply()` is one synchronous `db.transaction`; the hook point is after the idempotency SELECT and before the `dangerous` gate | V-28, V-34 |
| The operational audit row is written by middleware after the response; `AuditAppender.queue()` supports in-transaction use; `/mcp` frames are not audited | V-29 |
| No metrics registry, no HTML/cookie/CSP code, no HMAC helper exist; `canonicalize()` does | V-30, V-31, V-33 |
| Four plan providers emit `rollback_model` values outside the `Plan` enum (`reversible`, `executor_managed`); normalized in T2b | V-53 |
| The installed Codex is 0.136.0; MRTR needs ≥ 0.147 — the manual acceptance requires an upgrade | V-54 |

---

## 3. Confirmation policy

### 3.1 What needs a confirmation (MRTR-POL-001)

A **confirmable call** is a `tools/call` whose catalog entry and arguments
are one of:

- `mutability: 'plan_apply'` with `arguments.mode === 'apply'`;
- `mutability: 'direct'` with `requires_mcp_apply: true` (none exist
  today; the rule is forward-looking, V-43);
- any entry carrying the new optional catalog field
  `confirmation: 'required'` (explicit opt-in for a future operation that
  fits neither shape).

Everything else never sees the confirmation service: reads, `mode: 'plan'`,
`support.bundle`, `tasks.cancel`, `tasks.wait`, internal agent callbacks,
and every REST / `xinasctl` / TUI request (their `client_type` is not
`mcp`, so §8 does not engage).

### 3.2 Confirmation mode from risk (MRTR-POL-002)

The mode is decided **only** from the persisted plan document (§5), never
from anything the client sent:

| `plan_document.risk_level` | `plan_document.rollback_model` | mode |
|---|---|---|
| `non_disruptive` | anything but `unsupported` | `form` |
| `changing_access` | anything but `unsupported` | `form` |
| `destructive` | any | `url` |
| `unsupported_rollback` | any | `url` |
| any | `unsupported` | `url` |

The last row is the requirement's SHOULD promoted to a rule: a plan whose
rollback model is `unsupported` gets out-of-band approval regardless of
its risk level (V-49).

**Vocabulary (review P1, V-53).** `rollback_model` is the four-value enum
of `api-v1.yaml` `Plan` — `non_disruptive | changing_access | destructive
| unsupported`, the risk class of *undoing* the operation. Review found
four providers still emitting the off-contract values `reversible` and
`executor_managed` (the reference provider had been normalized in S3 T0;
the others were not), so every REST plan from them already violates the
contract. S15 normalizes the providers **before** any document is
persisted (plan T2b) rather than widening the enum with values that are
not risk classes:

| provider kinds | was | becomes | why |
|---|---|---|---|
| `share.create`, `share.update`, `share.delete`, `nfs-profile.update`, `nfs-idmap.set` | `reversible` | `changing_access` | undoing re-applies exports / restarts nfsd: client access changes |
| `pool.create`, `pool.modify`, `pool.delete` | `reversible` | `non_disruptive` | spare-pool membership; no data or access change |
| `support.bundle` | `executor_managed` | `non_disruptive` | nothing to undo |
| `config.rollback` reset-to-baseline | `executor_managed` | `unsupported` | its own diff says `destroying_data`; there is no undo |
| `config.rollback` targeted restore | `executor_managed` | `changing_access` | what S11 §*plan* already specifies |

The plan engine refuses (`INTERNAL`) any provider result whose
`risk_level` or `rollback_model` is outside the enums, so the vocabulary
cannot drift again unnoticed.

### 3.3 Gate order (MRTR-POL-003)

Evaluated in this order; the first failure answers the call and nothing
later runs. Column three names where the check already exists today (paths
under `xiNAS-MCP/src/`).

| # | Gate | Where |
|---|---|---|
| 1 | Authenticate the MCP caller | `api/mcp/transport.ts` `resolveIdentity()` (unchanged) |
| 2 | RBAC for the tool | `middleware/rbac.ts` via the loopback today; **S15 adds a pre-check in the dispatcher** against the entry's `min_role` so a viewer never reaches the confirmation service (the loopback check stays as the authority) |
| 3 | `mcp.allow_apply` | `api/mcp/dispatch.ts` `gateVerdict()` (unchanged) → `MCP_APPLY_DISABLED`; **no approval record is created** |
| 4 | Apply request shape | new: `plan_id` (uuid), `expected_revision` (integer), `idempotency_key` (non-empty string), `dangerous` (boolean or absent) — `INVALID_ARGUMENT` tool error otherwise |
| 5 | Resolve the plan | new: `plan_only` row + its `plan_document` (§5); missing → `NOT_FOUND` |
| 6 | Plan ownership and binding | new: document `operation_kind` equals the entry's kind; document `resource_ref` equals the tool's path arguments; document integrity (§5.3) |
| 7 | Blockers | new: `plan_document.blockers` non-empty after excluding the engine-owned `dangerous_flag_required` advisory (the engine enforces the real flag at apply, §3.4; REST routes filter it the same way) → `PRECONDITION_FAILED` (`details.reason: plan_blocked`, the blocker list) — no record is created (V-26) |
| 8 | Confirmation mode | §3.2 from the document — and if the plan is `destructive` and the arguments do not carry `dangerous: true`, answer `PRECONDITION_FAILED dangerous_flag_required` with no record (§3.4) |
| 9 | Execute MRTR | §4 |
| 10 | Revalidate freshness | inside the apply transaction (existing `PRECONDITION_FAILED` / `CONFLICT plan_stale`) |
| 11 | Consume + create task | §8, same transaction |
| 12 | Dispatch | unchanged (`admitAndDispatch`) |

Gate 2's pre-check is deliberately a *duplicate* of the loopback RBAC, not
a replacement: the loopback remains the enforcing spine (ADR-0010); the
pre-check only stops a forbidden caller from minting approval records.

### 3.4 `dangerous` stays independent (MRTR-POL-004)

The confirmation service does not *enforce* `dangerous` — it reads the
flag only to refuse early (below) — and the `dangerous` gate
(`api/tasks/engine.ts:521-528`) never reads the confirmation. For a
destructive plan both must hold: the record is `approved` **and**
`dangerous: true` is in the apply body. The transaction order in §8.3
makes "one satisfies the other" structurally impossible: the confirmation
is *verified* before the `dangerous` gate and *consumed* only after the
task insert, in the same transaction, so a failed `dangerous` gate leaves
the record untouched.

Independence is not indifference: the service refuses a destructive apply
that carries no `dangerous: true` at gate 8 (§3.3), **before** any record
is created, so no operator approval is ever spent on a call the apply
transaction will refuse. The condition is the engine's own gate verbatim
(`risk_level === 'destructive' && dangerous !== true`) and no wider — a
url mode caused only by `rollback_model: unsupported` or `risk_level:
unsupported_rollback` needs no flag, because the engine does not ask for
one either. The engine's check stays exactly where it is: it is the
enforcement point, and this one is a courtesy.

### 3.5 Security boundary (review P0)

What MRTR proves is that **a credential other than the requesting MCP
client's accepted this exact plan**. It cannot prove more than the node's
own trust model allows:

- **A bearer token is, by default, a REST credential as well as an MCP
  one.** `middleware/auth.ts` and `transport.ts` `resolveIdentity()` read
  the same `config.tokens` table, so an agent holding a token with no
  `surface` key (`surface: any`, the default, and what every token minted
  before that key existed means) can send the identical apply to
  `POST /api/v1/…` and get it applied with **no confirmation at all**:
  `client_type` is then `rest`, and the MRTR gate keys on `client_type`
  being `mcp`. MRTR therefore constrains the **path**, not the principal.
  The guarantee below holds for a bearer-only agent **only when its token
  is configured `surface: mcp`** (§13), which makes `/api/v1` refuse it
  with `PERMISSION_DENIED` / `details.reason: 'token_surface'`. Scope
  every agent token that way; the default is left permissive so an
  existing deployment does not break on upgrade, not because it is safe.
- With that scoping in place, the guarantee holds for an agent that
  reaches the node **only through the MCP endpoint** (a `surface: mcp`
  bearer, or `xinas-mcp-stdio` run by an account that is not root and not
  in `xinas-admin`). Such an agent cannot read `config.json`, the key ring
  or the SQLite store, cannot call `xinasctl` over the UDS, and cannot
  approve.
- An agent that holds **root, or membership of `xinas-admin`, on the
  node** is outside the boundary: it can read every bearer token, edit the
  database, the config or the api code, and approve anything. No setting
  in this spec changes that. For such deployments the approval must be
  performed **off the agent-controlled node** — the HTTPS approval page
  opened from another machine with a distinct admin credential — and the
  MCP surface must not be reachable as root.
- UDS peer-trust approval (`xinasctl mcp_confirmations approve …` as root
  or `xinas-admin`) is therefore **break-glass**: disabled by default
  (`allow_uds_approval: false`, §9.2), enabled only deliberately, and
  audited as its own event (`break_glass_used`, §12.1) whenever used.
- A distinct bearer token is a distinct *credential*, not proof of a
  distinct *person* (D-02). Operators who need that assurance keep the
  approving token off the machines the agent can read.

---

## 4. Wire contract (modern era, `tools/call`)

### 4.1 `resultType` on every modern result (requirement §4)

`handleModernRequest` (`api/mcp/modern.ts`) adds `resultType: 'complete'`
to the `tools/list` result and to every `tools/call` result that is a
`CallToolResult` — including tool errors (`isError: true`). An unfinished
MRTR returns `resultType: 'input_required'`. `server/discover` already
carries `complete`. The legacy SDK path is untouched: `listTools()` /
`callTool()` still return the legacy shapes and the modern handler wraps
them.

### 4.2 Initial confirmable call

Identical to today's apply call. The client's `_meta` decides what the
server may ask for (§14.1):

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
      "io.modelcontextprotocol/clientCapabilities": { "elicitation": { "form": {} } }
    }
  }
}
```

The server runs gates 1–8 (§3.3), creates the approval record (§6) — the
**only** write on this path (MRTR-CORE-001) — and answers with an
`InputRequiredResult`. It does not call the loopback, acquire a lease,
touch desired state, or speak to the agent.

### 4.3 Form flow (`mode: form`)

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
          "message": "<generated from the plan document, §10.1>",
          "requestedSchema": {
            "type": "object",
            "properties": {
              "decision": { "type": "string", "enum": ["APPLY"], "title": "Confirm operation" }
            },
            "required": ["decision"]
          }
        }
      }
    },
    "requestState": "xc1.<kid>.<payload>.<mac>"
  }
}
```

Both `inputRequests` and `requestState` are always present (V-44). The
request key is the constant `confirm_apply`.

**Retry.** The client repeats `tools/call` with a **new** JSON-RPC id, the
same tool name, the same arguments, the exact `requestState`, and a bare
`ElicitResult` under `confirm_apply`:

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "tools/call",
  "params": {
    "name": "shares.update",
    "arguments": { "id": "share-a", "mode": "apply", "plan_id": "PLAN_UUID", "expected_revision": 42, "idempotency_key": "CLIENT_GENERATED_KEY" },
    "inputResponses": { "confirm_apply": { "action": "accept", "content": { "decision": "APPLY" } } },
    "requestState": "xc1.<kid>.<payload>.<mac>",
    "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { "elicitation": { "form": {} } } }
  }
}
```

**Acceptance (MRTR-FORM-005)** requires, in order: `requestState` verifies
(§7.4); every binding in the state equals the current request (§7.3);
`inputResponses.confirm_apply` exists, is an object, `action === 'accept'`,
`content` is an object whose only recognised key `decision` is exactly
`"APPLY"` (unknown extra keys are ignored, V-16); the record is `pending`,
unexpired, and its `request_state_nonce_hash` matches. Then the server
forwards the loopback apply with the confirmation header (§8.1) and the
core consumes the record inside the transaction (§8.3). The tool result is
today's apply result (`result` + `next` hint) with `resultType: 'complete'`.

**Decline / cancel (MRTR-FORM-006).** `action: 'decline'` → record
`declined`; `action: 'cancel'` → record `cancelled`; both answer a
`complete` tool error (`CONFIRMATION_DECLINED` / `CONFIRMATION_CANCELLED`,
§11) whose text states the confirmation id and that **no apply task was
created**. A retry whose `inputResponses` lacks `confirm_apply`, or whose
`content` lacks `decision`, or whose `decision` is anything but `APPLY`
(including `"yes"`, `"apply"`, `"APPLY "`) mutates nothing: a *missing*
response re-issues the elicitation (round + 1, §4.6); a *present but wrong*
value is treated as `decline`. Nothing else in the accept path is lenient.

### 4.4 URL flow (`mode: url`)

For a `url` mode (§3.2) the server returns:

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "confirm_apply": {
      "method": "elicitation/create",
      "params": {
        "mode": "url",
        "message": "This destructive xiNAS operation requires independent approval by a xiNAS operator. Open the approval page, review the plan, and approve or decline there.",
        "url": "<approval_url_base>/mcp/approvals/<confirmation_id>"
      }
    }
  },
  "requestState": "xc1.<kid>.<payload>.<mac>"
}
```

The URL carries **only** the confirmation id (128-bit random, §6.1): no
bearer, no loopback token, no plan data, no principal (V-13). The page
itself authenticates the operator (§9.3). If `approval_url_base` is not
configured, or is not `https://` on a non-loopback host, the call fails
closed with `CONFIRMATION_URL_UNAVAILABLE` and no record is created
(D-03).

**Retry.** As in §4.3 but the `ElicitResult` has no `content`:
`{ "action": "accept" }`. Per V-07 this only means the client believes the
browser flow happened. The server then reads the **record**:

| record status | outcome |
|---|---|
| `approved` | consume inside the apply transaction (§8.3) → apply result |
| `pending` | wait up to `url_wait_seconds` (default 25) polling the store every 250 ms; if it becomes `approved`, proceed; if `declined`, `CONFIRMATION_DECLINED`; if still `pending`, re-issue the same URL elicitation with round + 1 (§4.6) |
| `declined` | `CONFIRMATION_DECLINED` |
| `cancelled` | `CONFIRMATION_CANCELLED` |
| `expired` | `CONFIRMATION_EXPIRED` |
| `consumed` | identical request → the existing task (idempotent replay, §8.5); otherwise `CONFIRMATION_ALREADY_CONSUMED` |

`action: 'decline'` / `'cancel'` on a URL retry moves the record to
`declined` / `cancelled` even if an operator had already approved it: the
requester withdrew, and the approval is void.

The wait runs *before* the loopback call and outside any transaction, so it
never holds a DB lock; it is capped like `tasks.wait` (`WAIT_CAPACITY`:
4 waiters per confirmation, 32 per process — over the cap the server
re-issues immediately instead of waiting).

### 4.5 Repeat initial calls

An initial call (no `requestState`) whose bindings (§7.3) match an existing
`pending` or `approved` record for the same principal does **not** create a
second record: it re-issues that record's elicitation with round + 1. This
keeps the per-principal limit meaningful and lets a client that lost the
state recover. A record in any terminal status never matches; a new one is
created.

### 4.6 Rounds (MRTR-COMPAT-004)

`round` starts at 1 on the first `InputRequiredResult` and is incremented
on every re-issue (§4.3 missing response, §4.4 still pending, §4.5
repeat). `requestState` carries the round it was minted for; a retry
presenting a round lower than the record's current round is a replay
(§7.5). When a re-issue would need round 4 the server answers
`CONFIRMATION_ROUND_LIMIT`, marks the record `expired`
(`expired_reason: round_limit`) and mutates nothing. A fresh apply attempt
then creates a fresh record and the human decides again.

### 4.7 Relationship to the MCP Tasks extension

xiNAS's asynchronous apply (`task_id` + `tasks.wait` + the `next` hint,
S8 §3.1) is **not** the MCP Tasks extension and is not advertised as one
(S14 §1). Should the extension be adopted later, the confirmation stays in
the *ephemeral* MRTR workflow that SEP-2322 places **before** a persistent
task exists: the approval is consumed exactly when the apply task row is
inserted (§8.3), so a Tasks-extension `task` would be created at that
same instant. Nothing in this spec assumes the extension.

### 4.8 `_meta` handling

Only `protocolVersion` (era classification, S14 §3) and
`clientCapabilities.elicitation` (§14.1) are read. `clientInfo` and
`serverInfo` are never consulted for anything (MRTR-SEC-004). The
capability object is read **from the current request every time**; it is
not stored on the record and not cached across requests (MRTR-COMPAT-001).

---

## 5. Plan document

### 5.1 What is persisted (MRTR-PLAN-001)

`PlanEngine.plan()` (`api/plan/engine.ts`) builds a `plan_document` and
`TaskStore.createPlanOnly()` stores it in a new nullable column
`tasks.plan_document TEXT` (JSON, migration `006-plan-document.sql`,
additive). The document is:

```jsonc
{
  "schema": 1,
  "plan_id": "<task_id of the plan_only row>",
  "operation_kind": "share.update",
  "resource_ref": { "kind": "Share", "id": "share-a" },   // affected_resources[0]; id null only when a plan pins no resource
  "plan_hash": "<tasks.plan_hash>",
  "state_revision_expected": 42,
  "observed_revision_expected": 17,     // or null
  "observed_at": "2026-09-04T10:00:00Z", // or null
  "affected_resources": [ { "kind": "Share", "id": "share-a" } ],
  "risk_level": "changing_access",
  "client_impact": "Clients of /srv/share-a lose write access …",
  "blockers": [],
  "warnings": [ { "code": "…", "message": "…" } ],
  "diff": { … },
  "rollback_model": "changing_access",
  "created_at": "2026-09-04T10:00:00Z",
  "created_by": { "principal": "admin:demo", "client_type": "mcp" }
}
```

`plan_document_hash = sha256(canonicalize(plan_document))` is stored
beside it (`tasks.plan_document_hash TEXT`).

**Single source.** The `Plan` envelope every client receives is
`publicPlan(plan_document)` — the document minus `schema`, `operation_kind`,
`resource_ref`, `created_at`, `created_by` — rendered in
`routes/apply-helpers.ts` `planMode` and in the bespoke routes. A test pins
`response.result` deep-equal to `publicPlan(stored document)` for every
plan provider (V-52). The document never contains the raw `spec`; the
public plan does not either (`api-v1.yaml` `Plan`).

**Route-computed revision pins (ruling R-3.1).** Four kinds —
`xiraid.array.modify`, `xiraid.array.delete`, the `fs.*` update kinds and
`fs.unmanage` — pin no `state_revision_expected` in their provider result:
the engine's desired-revision freshness check deliberately skips them and
their routes validate the echoed revision against live state at apply
time. Their routes compute the revision they report and hand it to
`PlanEngine.plan()` as `document_overrides` (`state_revision_expected`,
`observed_revision_expected`, `observed_at`), which the engine applies to
the **document only**; the `tasks.state_revision_expected` column keeps
its existing (unpinned) value so the engine's freshness semantics do not
change. The document therefore always says what the client saw, and every
S15 revision comparison reads `document.state_revision_expected`, never
the row column.

Rows created before migration `006` have a null document. A confirmable
call against such a plan answers `PRECONDITION_FAILED`
(`details.reason: plan_predates_confirmation`, remediation: re-plan).
REST/CLI applies of old plans are unaffected.

### 5.2 Redaction (MRTR-PLAN-003)

Before persisting, `diff` and `warnings[].evidence` pass through
`redactPlanDocument()`: any object key matching
`/^(password|passwd|secret|token|api_key|private_key|authorization)$/i`
(case-insensitive, at any depth) is replaced by
`{ "redacted": "sha256", "digest": "<sha256 of canonical value>" }`. The
document cannot carry bearer tokens (the plan engine never sees them), the
loopback token (process memory only), or support-bundle content (a bundle
is a task artifact, not a plan field). The same redacted document feeds
the form message (§10.1) and the approval page (§9.3), so what the human
sees is what was hashed.

### 5.3 Integrity (MRTR-PLAN-002)

At gate 6 (§3.3) the confirmation service verifies, in order:

1. the `plan_only` row exists and `tasks.plan_document` is non-null;
2. `sha256(canonicalize(document)) === tasks.plan_document_hash`;
3. `document.plan_id === tasks.task_id === arguments.plan_id`;
4. `document.plan_hash === tasks.plan_hash`;
5. `catalogEntry.operation_kinds` contains `document.operation_kind` — a
   new catalog field on every `plan_apply` entry listing the engine kinds
   its route can produce (`shares.update` → `['share.update']`;
   `filesystems.update` → `['fs.mount', 'fs.unmount', 'fs.grow',
   'fs.set_quota_mode']`; `arrays.create` → `['xiraid.array.create']` and
   `arrays.import` → `['xiraid.array.import']` although they share a
   route); pinned per entry by the catalog test against the kinds the
   routes actually pass to `planEngine.plan()`;
6. for an entry whose path carries a `{param}`, `document.resource_ref.id`
   equals `arguments[param]`; an entry without a path parameter (a create
   kind) is not id-checked — the kind check and the `plan_id` binding cover
   it (`resource_ref` is derived from `affected_resources[0]`, the S2
   primary-resource contract);
7. **ownership (review P1):** `document.created_by.principal` equals the
   authenticated MCP principal. A plan made over REST or `xinasctl` by the
   *same* principal (the same bearer's principal string) may be applied
   over MCP; one principal can never apply another's `plan_id`. The UDS
   principals differ by transport (`local:uds` on REST, `mcp:local_admin`
   through the stdio adapter — V-39), so a root operator's `xinasctl` plan
   is not applicable through MCP: re-plan through MCP;
8. the caller's role satisfies the entry's `min_role` (gate 2 already did;
   repeated here so the check is local to the service).

Any failure is `PRECONDITION_FAILED` (`details.reason: plan_binding`) with
no record created; the message never names the plan's actual creator.
The apply arguments' `expected_revision` must equal
`document.state_revision_expected` (what the plan response said; R-3.1) —
a mismatch is the existing `PRECONDITION_FAILED` with
`{ expected_revision, plan_revision }`. The stored `plan_hash` is what the apply transaction
already verifies against the plan row (`api/tasks/engine.ts`), so the
document, the row and the transaction agree by construction.

---

## 6. Confirmation record and state machine

### 6.1 Table `mcp_confirmations` (migration `006`)

| column | type | notes |
|---|---|---|
| `confirmation_id` | TEXT PK | 16 random bytes, base64url (22 chars) — the URL path segment |
| `status` | TEXT NOT NULL | `pending \| approved \| declined \| cancelled \| expired \| consumed` (V-46 adds `cancelled`) |
| `mode` | TEXT NOT NULL | `form \| url` |
| `principal`, `role` | TEXT NOT NULL | the MCP-resolved identity (V-39) |
| `tool_name` | TEXT NOT NULL | catalog `name` |
| `operation_kind` | TEXT NOT NULL | from the plan document |
| `arguments_hash` | TEXT NOT NULL | `sha256(canonicalize({ name, arguments }))` over the tool arguments as received |
| `plan_id`, `plan_hash`, `plan_document_hash` | TEXT NOT NULL | copied at creation |
| `idempotency_key` | TEXT NOT NULL | |
| `expected_revision` | INTEGER NOT NULL | |
| `risk_level`, `rollback_model` | TEXT NOT NULL | from the document |
| `request_state_nonce_hash` | TEXT NOT NULL | `sha256(nonce)`; the nonce itself lives only in `requestState` |
| `round` | INTEGER NOT NULL | current round (§4.6) |
| `created_at`, `expires_at` | INTEGER NOT NULL | epoch ms |
| `approved_at`, `approved_by`, `approval_channel` | nullable | the **verified** authentication channel of the deciding request: `mcp_form` (the MCP client's form accept) \| `bearer` (a REST bearer token) \| `uds_break_glass` (UDS peer trust, only with `allow_uds_approval: true`) — derived from the auth middleware, never from a header |
| `approval_interface` | nullable | **untrusted** UI label the deciding request self-reports via `X-Xinas-Approval-Interface`: `web \| rest`; informational only, never used for authorization or as evidence |
| `declined_at`, `declined_by`, `decision_reason` | nullable | operator-supplied text (≤ 512 chars) |
| `consumed_at`, `consumed_task_id` | nullable | set inside the apply transaction |
| `expired_reason` | nullable | `ttl \| round_limit \| plan_stale \| revision_changed \| restart_sweep` |
| `correlation_id`, `request_id` | TEXT NOT NULL | from the initiating MCP request |
| `node_id` | TEXT NOT NULL | `controller_id` — shown on the page and in messages |

Indexes: `(principal, status)`, `(status, expires_at)`,
`UNIQUE(consumed_task_id) WHERE consumed_task_id IS NOT NULL` (a task can
be produced by at most one confirmation, and a confirmation by at most
one task via the single `consumed_task_id`). Timestamps are epoch ms in
the store and ISO strings at every HTTP boundary (house rule).

### 6.2 Transitions

```
pending ──form accept (in apply txn)──────────────▶ consumed
pending ──operator approve (bearer | uds break-glass)─▶ approved ──url accept (in apply txn)──▶ consumed
pending | approved ──client decline───────────────▶ declined
pending | approved ──operator decline─────────────▶ declined
pending | approved ──client cancel────────────────▶ cancelled
pending | approved ──ttl / round limit / plan stale / revision changed / restart sweep──▶ expired
```

Terminal statuses (`declined`, `cancelled`, `expired`, `consumed`) never
change again: every transition is a guarded `UPDATE … WHERE status IN
(…)` and the caller treats `changes() === 0` as "someone else got there
first" and re-reads. In particular no path exists from `consumed` or
`expired` back to `approved` (MRTR-STATE-002/004).

### 6.3 TTL and expiry (MRTR-STATE-002)

`expires_at = created_at + ttl_seconds × 1000`, `ttl_seconds` from
`mcp.confirmation.ttl_seconds` (default 300, validated to 60–900 at
config load, §13). An operator approval does **not** extend the TTL: an
approved-but-unconsumed record still expires at `expires_at`
(MRTR-STATE-004 "MAY still be used until expiry").

A sweep marks `pending`/`approved` rows with `expires_at ≤ now` as
`expired` (`expired_reason: ttl`) and emits the audit event: at api
startup (before the task engine reconciles), and every 30 s on the
existing lease-sweeper timer (`api/lease-sweeper.ts` gains a second
callback; still `unref()`ed). Expiry is *also* checked inline on every
read, so a request racing the sweep gets the same answer.

When the apply transaction fails with `PRECONDITION_FAILED` (revision
drift) or `CONFLICT plan_stale`, the record is moved to `expired`
(`expired_reason: revision_changed | plan_stale`) in a follow-up
statement after the rollback: the plan is no longer valid, so the human's
approval of it is void and re-planning is required (MRTR-STATE-002 last
bullet).

### 6.4 Limits (requirement §15)

| limit | default | config key | on exhaustion |
|---|---|---|---|
| pending + approved records per principal | 5 | `max_pending_per_principal` (1–50) | `CONFIRMATION_LIMIT_EXCEEDED`, no record created |
| pending + approved records per node | 100 | `max_pending_total` (1–1000) | same |
| record creations per principal per minute | 10 | `create_rate_per_minute` (1–600) | `CONFIRMATION_RATE_LIMITED`, no record created |
| rounds per record | 3 | constant | `CONFIRMATION_ROUND_LIMIT`, record expired |
| `requestState` encoded size | 4096 bytes | constant | JSON-RPC `-32602` |
| approval lifetime | 300 s | `ttl_seconds` (60–900) | `CONFIRMATION_EXPIRED` |
| retained terminal records | 30 days | shares `taskRetentionDays` (`state/gc.ts`) | pruned by GC |

Exhaustion never evicts an existing record: a full quota is an error to
the *new* request (fail closed), and an `approved` record can only leave
the quota by being consumed, declined, cancelled or expiring — never by
being reassigned. The rate limiter is an in-memory token bucket per
principal; it resets on restart, which is acceptable because the persisted
quota still holds.

### 6.5 GC and restart (MRTR-STATE-004)

`state/gc.ts` gains `pruneConfirmations(retentionDays)`: terminal rows
older than the retention window are deleted; non-terminal rows are never
touched by GC. On startup the sweep in §6.3 runs first; `consumed` rows
are never altered; `approved` rows within TTL remain usable; nothing
re-opens a terminal row. Restart tests in §15.3 pin each of these.

---

## 7. `requestState`

### 7.1 Format

```
xc1.<kid>.<base64url(payload)>.<base64url(hmac)>
```

`xc1` is the schema version tag (strict allowlist: exactly this prefix).
`kid` is a key id (`[A-Za-z0-9_-]{1,16}`). The MAC is HMAC-SHA-256 over
the ASCII bytes `"xc1." + kid + "." + base64url(payload)`. Maximum encoded
size 4096 bytes; anything longer is rejected before any parsing.

### 7.2 Payload

```jsonc
{
  "v": 1,
  "cid": "<confirmation_id>",
  "sub": "admin:demo",          // principal
  "role": "admin",
  "tool": "shares.update",
  "ah":  "<arguments_hash>",
  "pid": "<plan_id>",
  "ph":  "<plan_hash>",
  "rev": 42,                    // expected_revision
  "ik":  "<idempotency_key>",
  "risk": "changing_access",
  "mode": "form",
  "iat": 1757000000000,
  "exp": 1757000300000,
  "nonce": "<16 random bytes, base64url>",
  "round": 1
}
```

No bearer, no loopback token, no plan content, no secrets
(MRTR-SEC-002). The payload is the canonical JSON of this object
(`canonicalize()`), so re-minting for a re-issue changes only `round`,
`iat`, `exp` (unchanged) and `nonce` — a new nonce per round, and the
record's `request_state_nonce_hash` is updated in the same statement that
bumps `round`.

### 7.3 Bindings verified on every retry

After the MAC verifies, every field is compared against the **current**
request and record, and the first mismatch rejects with JSON-RPC `-32602`
`"invalid request state"` (nothing more specific, MRTR-SEC-004, §11):

`sub`/`role` = resolved identity; `tool` = `params.name`; `ah` =
hash of the current arguments; `pid`/`rev`/`ik` = the current
`arguments.plan_id` / `expected_revision` / `idempotency_key`; `ph` =
the plan row's `plan_hash`; `cid` = an existing record whose columns
equal all of the above; `mode`/`risk` = the record's; `sha256(nonce)` =
the record's `request_state_nonce_hash`; `round` = the record's `round`;
`exp` = the record's `expires_at`. Expiry itself is not a binding failure:
a state whose bindings all hold but whose record is past `expires_at` is
answered from the record as the tool error `CONFIRMATION_EXPIRED` (§11), so
the client learns to start over rather than seeing a generic state error.

The cross-principal case is answered with the same generic error; the
audit event (`replay_rejected`, §12.1) records both principals for the
operator, the client learns nothing (requirement §13).

### 7.4 Verification order (MRTR-SEC-003)

1. size ≤ 4096 bytes; 2. exactly four dot-separated parts, first part
`xc1`; 3. `kid` matches the key-ring; 4. recompute the MAC with that key
and compare with `crypto.timingSafeEqual` (lengths compared first,
constant-time on equal length); 5. only now base64url-decode and
JSON-parse the payload; 6. schema check of every field's type; 7. §7.3
bindings. Steps 1–4 fail with the same `-32602` message as step 7.

### 7.5 Replay

A `requestState` is valid for exactly one successful retry: consumption
(§8.3) moves the record to `consumed`, and a re-presentation fails at the
status check (`CONFIRMATION_ALREADY_CONSUMED`, unless it is the identical
idempotent replay of §8.5). A state carrying a stale `round` or `nonce`
after a re-issue is a replay and fails §7.3. The nonce hash is the
server-side anchor SEP-2322's "single use MUST be enforced server-side"
asks for (V-11).

### 7.6 Key ring (D-04)

Keys live in a JSON file `state.confirmationKeyPath` (default
`<dirname(databasePath)>/mcp-confirmation-keys.json`, mode `0600`, owner
`xinas-api`):

```json
{ "active": "k1", "keys": { "k1": "<32 random bytes, base64>", "k0": "…" } }
```

**Creation and loading are hardened (review P1).** The api never does
"exists, then write":

1. It attempts an **exclusive, no-follow create** (`O_CREAT | O_EXCL |
   O_NOFOLLOW`, mode `0600`) and, on success, writes one random 32-byte
   key `k1` and `fsync`s. `EEXIST` means another actor won the race or the
   ring already exists — fall through to loading; any other error is fatal.
2. Before loading an existing ring it `lstat`s the path and refuses to
   start unless the entry is a **regular file** (never a symlink), owned by
   the api's own uid, with no group or world permission bits (`mode &
   0o077 === 0`). A ring that fails these checks is a configuration error
   reported at startup, not silently replaced.
3. It reads the ring through a descriptor opened with `O_NOFOLLOW`, then
   re-validates the parsed shape (key ids `[A-Za-z0-9_-]{1,16}`, ≥ 32-byte
   keys, `active` listed).

Minting uses `active`; verification accepts any listed key (`kid`
allowlist). Rotation: add a key, point `active` at it, restart; remove the
old key once `ttl_seconds` has passed. A state whose `kid` is not in the
ring fails verification. There is no rotation CLI in this slice.

---

## 8. Core enforcement

### 8.1 Loopback confirmation header (MRTR-CORE-002)

After §4.3/§4.4 acceptance, the dispatcher forwards the loopback apply
request with one additional header:

```
X-Xinas-Confirmation: <confirmation_id>
```

`middleware/auth.ts` copies it into `ctx.mcp_confirmation_id` **only** in
the branch that already honors `X-Xinas-Forwarded-*` — i.e. when the
bearer equals the ephemeral loopback token. From any other caller the
header is ignored and warn-logged exactly like a forged forwarded
principal today (`auth.ts:87-91`). It is never read from the request body,
never echoed in a response, and `api-v1.yaml` documents it beside the
forwarded headers as loopback-only.

### 8.2 Request context

`RequestContext` gains `mcp_confirmation_id?: string`. `ApplyRequest` in
`api/tasks/engine.ts` (the engine's internal type, not the public
schema) gains three fields: `expected_revision?: number` (the integer the
client echoed, which every apply route already parses — the value the
confirmation record is compared against), `confirmation_id?: string`, which
`routes/apply-helpers.ts` and the bespoke apply sites fill from
`ctx.mcp_confirmation_id` — the same way `dangerous` is threaded today,
so every plan/apply `taskEngine.apply()` call site is covered without a
new route parameter (V-28) — and `confirmation_exempt?: true`, which
**only** `routes/support.ts` sets for `support.bundle`. The engine gate
fires for every `client_type: 'mcp'` apply unless the route has
explicitly opted out, so the exemption is route policy (ADR-0010's two
locked entries), never client input, and a new route is confirmed by
default. `tasks.cancel` never reaches `apply()`.

### 8.3 Inside `TaskEngine.apply()` (MRTR-CORE-003)

The transaction body becomes:

1. idempotency SELECT — unchanged; a true replay returns the existing task
   here **only if** the confirmation named in the request is `consumed`
   with `consumed_task_id === existing.task_id` (or no confirmation is
   involved, i.e. non-MCP); an MCP replay naming a different or
   unconsumed confirmation is `CONFLICT` (`idempotency_key_reused`);
2. **confirmation gate (new):** if `applyReq.client_type === 'mcp'`:
   - `config.mcp.allow_apply === true` — else `MCP_APPLY_DISABLED` is
     re-raised as `PRECONDITION_FAILED` (`details.reason:
     mcp_apply_disabled`; belt and braces, MRTR-CORE-004);
   - `applyReq.confirmation_id` present (or `confirmation_exempt` set by
     the support-bundle route) — else `PRECONDITION_FAILED`
     (`details.reason: confirmation_required`). **This is the fail-closed
     rule**: an MCP-typed apply that reaches the engine without trusted
     confirmation context is refused, whoever dispatched it;
   - the record exists, `principal` equals `applyReq.principal`,
     `plan_id`/`plan_hash`/`idempotency_key`/`operation_kind` equal the
     request's, `expected_revision` equals the integer the client echoed in
     the apply body (threaded into the engine's `ApplyRequest` like
     `dangerous` — never the row's `state_revision_expected`, which is
     unpinned for the route-computed kinds, R-3.1), `expires_at > now`, and
     its status is consumable for its mode (`form`: `pending`; `url`:
     `approved`) — else `PRECONDITION_FAILED`
     (`details.reason: confirmation_not_approved`, current status in
     details). **Verification only; no write yet.**
3. `dangerous` gate — unchanged (`dangerous_flag_required`);
4. desired-revision freshness — unchanged (`PRECONDITION_FAILED`, `stale[]`);
5. observed freshness — unchanged (`CONFLICT plan_stale`);
6. desired-KV mutations + rollback capture — unchanged;
7. task INSERT (`queued`) — unchanged;
8. **consume (new):** one guarded statement — `form`: `pending →
   consumed` (sets `approved_at = consumed_at = now`, `approved_by =
   principal`, `approval_channel = 'mcp_form'`, `consumed_task_id =
   task.task_id`); `url`: `approved → consumed`; `changes() === 0` →
   `PRECONDITION_FAILED` (`confirmation_not_approved`) — which rolls the
   INSERT back too;
9. leases — unchanged (`CONFLICT lease_held`).

Because 2 verifies before 3–7 and 8 writes inside the same transaction, a
failure anywhere rolls everything back: the record stays
`pending`/`approved` and the client may retry (after fixing what failed);
a `dangerous` failure at 3 therefore never consumes anything. Because 2
follows 1, an idempotent replay never burns a record. The
`consumed_task_id` is the id the INSERT just produced, so no id is
generated ahead of the transaction; the partial unique index (§6.1) makes
a second task for the same confirmation impossible even under a bug.

Everything in the gate is synchronous SQL on the same `db` handle
(`ConfirmationStore` is built over the store's `db`, like `this.kv`), so it
participates in the transaction (V-28). The engine gets an injected
`now()` (`TaskEngineDeps.clock`, default `Date.now`) so TTL edges are
testable (V-36).

### 8.4 After the transaction

- On success the engine emits the `consumed` and `apply_task_created`
  audit events (§12.1) via `AuditAppender.queue()` **inside** the
  transaction (first in-transaction caller, V-29), and increments the
  metrics.
- On `PRECONDITION_FAILED` (revision) / `CONFLICT plan_stale` the engine
  expires the record (§6.3) in a separate statement and emits `expired`.
- On any other failure the record is untouched.
- If dispatch later fails (`failBeforeChange`, outside the transaction)
  the record **stays consumed**: the task exists, in state `failed
  (FAILED_BEFORE_CHANGE)`, and `consumed_task_id` points at it (V-38). The
  operator re-plans and confirms again. "At most one task per
  confirmation" holds.

### 8.5 Identical retry (MRTR-STATE-003)

A retry that is byte-for-byte the previous accepted retry (same
`requestState`, same arguments, same idempotency key) after consumption
is answered with the **existing task** through the idempotency path
(step 1): the record is `consumed` and its `consumed_task_id` matches. A
retry with any changed binding fails at §7.3 or step 2 — never creates a
second task, never returns a foreign task.

### 8.6 What the gate cannot be bypassed by

A second MCP dispatcher, a direct call to an `/api/v1` apply route with a
forged `X-Xinas-Client-Type: mcp` (ignored without the loopback bearer),
concurrent retries (one guarded UPDATE wins), and a crash between
consumption and insertion (same transaction) are each pinned by a test in
§15.

---

## 9. Out-of-band approval

### 9.1 REST routes (additive, `api-v1.yaml`)

| route | min_role | purpose |
|---|---|---|
| `GET /api/v1/mcp/confirmations` | admin | list; filters `status`, `principal`, `limit` (default 100, cap 1000), newest first |
| `GET /api/v1/mcp/confirmations/{id}` | admin | the record plus the **stored plan document** (public projection, §5.1) and the human-facing summary (§10.2); emits `viewed` |
| `POST /api/v1/mcp/confirmations/{id}/approve` | admin | body `{ "acknowledge": "<phrase>", "reason"?: string }`; §9.2 |
| `POST /api/v1/mcp/confirmations/{id}/decline` | admin | body `{ "reason"?: string }` |

Schema `McpConfirmation` mirrors §6.1 with ISO timestamps and without
`request_state_nonce_hash`. A form-mode record is visible here too (an
operator may decline it pre-emptively), but approving a form-mode record
over REST has no effect on the MRTR — form acceptance comes from the
client — so `approve` on a `form` record answers `CONFLICT`
(`details.reason: form_mode`).

When the confirmation exists but its plan row has been pruned by GC
(§6.5), `GET …/{id}` still answers `404` — there is no plan to show — but
it says which case it is: `details: { reason: 'plan_pruned',
confirmation_id }`, with the remediation "the plan row was pruned by GC;
the confirmation is listed by `mcp_confirmations list` and can still be
declined". An unknown id keeps the plain `NOT_FOUND` with no `details`.

### 9.2 Who may approve (MRTR-OOB-002/005, D-06)

The deciding request's **channel** is derived from the auth middleware's
verdict, never from anything the client sends: a bearer token →
`bearer`; UDS peer trust (`local:uds`) → `uds_break_glass`. The request
may additionally label its UI with `X-Xinas-Approval-Interface: web | rest`;
that label is stored as `approval_interface`, shown to operators, and
**never** consulted by any check.

`mcp.confirmation.approver_policy`:

- `distinct_principal` (**default**): the deciding principal must hold
  role `admin` and must differ from the record's `principal`. The
  requester's own MCP credential can never approve its own request.
  The requester may decline (withdraw) their own record over REST; the
  policy applies to approval only.
- `any_admin`: any `admin` principal, including the requester's own —
  for single-operator labs; the config loader logs a warning at startup.

`mcp.confirmation.allow_uds_approval` (**default `false`**, review P0): a
`uds_break_glass` decision is refused (`CONFLICT`, `details.reason:
approver_policy`, remediation naming the key and the HTTPS page) unless
this is `true`. It exists for the operator standing at the node with no
second credential at hand; enabling it means accepting that anyone with
root or `xinas-admin` on the node — including an agent that has been given
that access — can approve (§3.5). Every decision taken over the UDS while
it is enabled emits `break_glass_used` in addition to `approved` /
`declined` (§12.1), and the config loader logs a warning at startup when
it is on.

For `risk_level: destructive` the `approve` body MUST carry
`"acknowledge": "DATA MAY BE PERMANENTLY LOST"` exactly (case-sensitive);
for `unsupported_rollback` / `rollback_model: unsupported` the phrase is
`"ROLLBACK IS NOT SUPPORTED"`. A wrong or missing phrase is
`INVALID_ARGUMENT` and no transition happens. The transition itself is
the guarded `pending → approved` UPDATE (§6.2) recording `approved_by`,
the derived `approval_channel`, the self-reported `approval_interface`,
and the reason.

### 9.3 Approval page (MRTR-OOB-001/003/004, D-02)

Served by `xinas-api` on every listener:

- `GET /mcp/approvals/{id}` — the HTML shell. It is the same document for
  any `{id}` (no existence leak) and contains no plan data; it embeds the
  id for the page script. Headers: `Content-Security-Policy: default-src
  'none'; script-src 'self'; style-src 'self'; connect-src 'self';
  img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri
  'none'`, `X-Frame-Options: DENY`, `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- `GET /mcp/approvals/assets/app.js`, `app.css` — static, inline strings
  in `api/mcp/confirmation/approval-page.ts` (no build step, no third-party script,
  nothing fetched from anywhere but `'self'`).
- The script asks for an operator token (`<input type="password">`, never
  persisted, held in a closure), then calls `GET /api/v1/mcp/confirmations/{id}`
  with `Authorization: Bearer …` and the informational
  `X-Xinas-Approval-Interface: web` label, and
  renders: node id and hostname, operation (tool name + kind), requesting
  principal, resource ids, risk level, affected resources, warnings, the
  consequences sentence (§10.2), rollback limitation, the diff (as
  preformatted canonical JSON), plan id, full plan hash, expiry (absolute
  time and countdown), and the record status.
- Approve requires: a checkbox "I have reviewed the plan above" **and**,
  for destructive/unsupported-rollback records, typing the acknowledgement
  phrase into a field; the button label is "Approve — data may be
  permanently lost" for data-destroying operations. Decline is always one
  click with an optional reason.
- There are **no cookies**, so there is no ambient credential and CSRF has
  nothing to ride on; as defence in depth the approve/decline handlers
  reject a request that labels itself `web` while carrying an `Origin`
  that differs from the `approval_url_base` origin. The label itself is
  untrusted (§9.2) — it selects nothing and proves nothing.
- The page warns: "Do not paste the token your MCP client uses. Approval
  must come from a different credential — and a different credential is
  not proof of a different person; keep this token off machines the agent
  can read." (`distinct_principal` enforces the first half server-side;
  the rest is the operator's responsibility, §3.5.)
- The request path and query never carry tokens; the api's request log
  logs the path only (`/mcp/approvals/<id>` reveals a random id, nothing
  else).
- Plain `http://` is accepted by the page only when the listener is bound
  to a loopback address (D-03); the config loader refuses an
  `approval_url_base` that is `http://` on any other host.

### 9.4 `xinasctl`

Catalog entries `mcp_confirmations.list | get | approve | decline`
(`min_role: admin`, `mutability: 'direct'`, `requires_mcp_apply: false`)
carry the new catalog field **`mcp_exposed: false`**: `listTools()` skips
them and `callTool()` treats them as unknown (`NOT_FOUND`), while the
`xinasctl` command tree and `matchCatalog` (RBAC) still see them. A model
therefore cannot list, discover or call the approval tools through MCP —
the requirement's "the model must not approve its own request" holds even
when the model holds an admin MCP token. Usage:

```bash
xinasctl mcp_confirmations list --status pending
xinasctl mcp_confirmations get <id>
xinasctl mcp_confirmations approve <id> --acknowledge "DATA MAY BE PERMANENTLY LOST"
xinasctl mcp_confirmations decline <id> --reason "wrong filesystem"
```

Over the UDS the principal is `local:uds` and the channel
`uds_break_glass`; `approve` and `decline` are **refused by default**
(`CONFLICT approver_policy`) and work only with
`mcp.confirmation.allow_uds_approval: true`, each use audited as
`break_glass_used` (§3.5, §9.2). `list` and `get` work over the UDS
unconditionally.

### 9.5 TUI

Deferred (D-09): a Management → "MCP approvals" screen listing pending
records with approve/decline, driven by the same routes through
`control_client.py`. Recorded in `docs/TODO.md` with the done-criteria.

---

## 10. Human-facing text

### 10.1 Form message (MRTR-FORM-003)

Generated by `renderConfirmationMessage(record, plan_document, config)`
from the stored document only — never from client-supplied prose — and
identical for every re-issue of the same record except the countdown:

```
xiNAS node nas-01 (controller 0000…0778)
Operation: shares.update (share.update) on Share "share-a"
Risk: changing_access · Rollback: changing_access
Client impact: Affects NFS share share-a, NFS export rule share-a/10.0.0.0/24 (export /srv/share-a); changed: access_mode, clients. Review the diff for the new access rules.
Affected: Share share-a; ExportRule share-a/10.0.0.0/24
Warnings: (1) NFS_SESSIONS_ACTIVE — 3 active sessions from 10.0.0.12, 10.0.0.15, 10.0.0.31
Diff (concise): access_mode: rw → ro; clients: [10.0.0.0/24] (unchanged)
Plan PLAN_UUID · hash 9f3c1a2b7e4d · expires 2026-09-04T10:05:00Z (in 4m58s)
Choose APPLY to confirm. Any other action leaves xiNAS unchanged.
```

Rules: for a `changing_access` plan, `client_impact` is **derived from the
plan document** by `clientImpact()` (`api/plan/document.ts`), which
`buildPlanDocument` calls once at plan time so the stored document, the
form message and the approval page all show the same sentence:

- the **affected resources by kind and id**, taken from
  `affected_resources` and named with a human label where one exists
  (`Share` → "NFS share", `ExportRule` → "NFS export rule", `Filesystem`,
  `NetworkInterface`, …; an unknown kind is named verbatim). No affected
  resources → "the node configuration". Capped at 5 with a "(+N more)"
  tail.
- the **export path**, when the diff carries one — a `path`,
  `export_path`, `export` or `mountpoint` string at the diff's top level
  or one level down (the NFS provider nests it in `export_entry`) —
  rendered as "(export /srv/nfs/a)". Omitted when the diff names none.
- the **changed top-level field names** of the diff, excluding the
  narrative keys `action` and `summary` and the path key already reported.
  Capped at 8 with a "(+N more fields)" tail; omitted when the diff is not
  an object or has no such keys.
- a closing "Review the diff for the new access rules." — and the **full
  (capped) diff is attached to the message** on its own `Diff (concise):`
  line, so the sentence points at something the operator can actually
  read.

The derivation runs on the REDACTED diff, so a secret-looking field is
still listed as changed while its value never appears. `non_disruptive`
plans read "No impact on NFS clients."; every other risk level reads "May
affect NFS clients; review the diff." and gets its own `consequences`
line on the approval page (§10.2).

The diff itself is rendered by a per-kind summariser with a 600-character
cap and a "… (N more characters; see the plan)" tail; the plan hash is
abbreviated to 12 hex chars; the message is plain text (no markdown, no
URLs — V-13 "SHOULD NOT include URLs intended to be clickable in any
field of a form mode elicitation request").

### 10.2 Approval-page summary

`GET /api/v1/mcp/confirmations/{id}` returns `summary`: the same lines as
§10.1 plus a `consequences` sentence and a `rollback_limitation`
sentence. The page shows both verbatim.

`consequences` is chosen by `risk_level`, in this order:

| `risk_level` | sentence |
|---|---|
| `destructive` | "This operation destroys data on [affected resources]. Data on them may be permanently lost." (no affected resources: "…on the affected resources. Data may be permanently lost.") |
| `unsupported_rollback` | "This operation cannot be rolled back automatically: if it fails or must be undone, manual recovery is required." |
| `changing_access` | "This operation changes client access: [`client_impact`, §10.1]" |
| anything else | "This operation changes the node configuration." |

`unsupported_rollback` is evaluated **before** `changing_access`: it is
the risk level that sent an otherwise ordinary plan to url mode, and it
is what the operator most needs to read.

`rollback_limitation` answers `risk_level === 'unsupported_rollback' ||
rollback_model === 'unsupported'` **first** with "xiNAS cannot roll this
operation back automatically." — the risk level wins over the model,
because a document may carry `unsupported_rollback` with a
`rollback_model` that still reads as recoverable, and promising an
automatic rollback there would be false. Otherwise it follows
`rollback_model`: `destructive` → "Rollback is itself destructive: undoing
this operation cannot restore data."; `changing_access` → "Rollback
restores the previous access rules; clients may see a brief
interruption."; anything else → "Rollback is non-disruptive."

---

## 11. Errors

Three layers, never mixed:

**JSON-RPC errors** (modern era; the HTTP status is set by
`transport.ts` from the code):

| condition | code | HTTP | message / data |
|---|---|---|---|
| client lacks the elicitation mode the record needs | `-32021` | 400 | `"Server requires the elicitation capability for this request"`, `data.requiredCapabilities: { "elicitation": { "form": {} } }` or `{ "url": {} }` |
| malformed `inputResponses` (not an object; entry not an object; unknown `action`; `content` not an object of primitives) | `-32602` | 200 | `"invalid params: inputResponses"` |
| `requestState` fails size, format, key id, MAC, schema or any binding (incl. cross-principal) | `-32602` | 200 | `"invalid request state"` — always this text |

**Tool errors** (`CallToolResult` with `isError: true`, `resultType:
'complete'`, the existing `{ error: { code, message, details } }` text
payload; legacy wire shape on the legacy path):

| code | when | details |
|---|---|---|
| `MCP_APPLY_DISABLED` | existing gate | `config_key` |
| `MCP_CONFIRMATION_UNSUPPORTED` | legacy-era client attempts a confirmable call (V-45) | `required: "MCP 2026-07-28 with elicitation"`, `alternatives: ["REST", "xinasctl", "TUI"]` |
| `CONFIRMATION_URL_UNAVAILABLE` | URL mode needed, `approval_url_base` unset/invalid | `config_key` |
| `CONFIRMATION_LIMIT_EXCEEDED` / `CONFIRMATION_RATE_LIMITED` | §6.4 | the limit and its config key |
| `CONFIRMATION_DECLINED` / `CONFIRMATION_CANCELLED` | §4.3 / §4.4 | `confirmation_id`, `task_created: false` |
| `CONFIRMATION_EXPIRED` | record expired | `confirmation_id`, `expired_reason` |
| `CONFIRMATION_ALREADY_CONSUMED` | record consumed and the request is not the identical replay | `confirmation_id` (never the task id of the other request) |
| `CONFIRMATION_ROUND_LIMIT` | §4.6 | `confirmation_id`, `rounds: 3` |
| `PRECONDITION_FAILED` (`plan_blocked`, `plan_binding`, `plan_predates_confirmation`, `confirmation_required`, `confirmation_not_approved`) | gates 5–7 and §8.3 | as named |
| existing `PRECONDITION_FAILED` (revision), `CONFLICT` (`plan_stale`, `lease_held`, `idempotency_key_reused`), `dangerous_flag_required` | unchanged | unchanged |

Every tool error states explicitly that no apply task was created when
that is the case. Security errors never echo the decoded state, a MAC, a
token, the other principal, or protected plan data.

**REST errors** for §9.1 use the existing `ErrorCode` union only
(`NOT_FOUND`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `CONFLICT` with
`details.reason: not_pending | form_mode | approver_policy`); no new
`ErrorCode` values (S2 §11 rule).

---

## 12. Audit and metrics

### 12.1 Lifecycle events (MRTR-AUD-001/002)

Queued through `AuditAppender.queue()` — inside the apply transaction for
`consumed` / `apply_task_created`, as their own small transactions
otherwise — with `kind: 'mcp.confirmation.<event>'`, `client_type: 'mcp'`
(or the approver's real client type for operator decisions),
`operation_id: confirmation_id`, `task_id` when known, `parameters_hash =
sha256(canonicalize(payload))`, and `payload`:

| event | when |
|---|---|
| `requested` | record created (mode, risk, tool, plan id/hash, expires_at) |
| `reissued` | round bumped (round) |
| `viewed` | page/REST `get` (viewer principal) |
| `approved` | operator approve (approver, channel, reason) |
| `declined` | client or operator decline (who, channel, reason) |
| `break_glass_used` | a `uds_break_glass` decision (approve or decline) — only possible with `allow_uds_approval: true`; emitted in addition to the decision event so break-glass use is greppable on its own |
| `cancelled` | client cancel |
| `expired` | sweep / round limit / plan stale / revision changed (reason) |
| `verification_failed` | requestState rejected (reason class only: size/format/kid/mac/schema/binding) |
| `replay_rejected` | binding mismatch of principal/tool/args/plan/key/nonce/round (both principals when they differ) |
| `capability_missing` | `-32021` returned (required mode) |
| `consumed` | inside the apply transaction (task id) |
| `apply_task_created` | same transaction, mirrors the task row |

Three of these events — `verification_failed`, the early
`replay_rejected` cross-check (§7.3) and `capability_missing` — are
queued **before** any quota, because they fire on calls that never create
a record; an attacker looping forged `requestState`s would otherwise be
an unbounded write amplifier against the audit chain. Each principal
therefore gets an internal budget of **30 record-less audit rows per
minute** (`RECORDLESS_AUDIT_PER_MINUTE`, a leaky bucket separate from
`create_rate_per_minute`, and deliberately **not configurable** — it is a
self-protection floor, not an operator knob). When the budget is spent
the request is refused exactly as before and its own metric still counts,
but the audit row is dropped and
`xinas_mcp_confirmation_audit_suppressed_total{event}` (§12.2) is
incremented — so a silenced trail is visible rather than merely absent,
and that counter next to the refusal counters says "N refusals, M rows".

Each payload carries `confirmation_id`, `plan_id`, `plan_hash`,
`principal`, `approver` (when any), `operation_kind`, `risk_level`,
`correlation_id`, `task_id` (when any) and `reason`. These are security
events with their own kinds; the single operational row for the apply is
still the loopback `http.POST./api/v1/…` row the audit middleware writes
(MRTR-AUD-002) — the parity test asserts exactly one `http.*` row per
tool call *and* the expected `mcp.confirmation.*` rows. `GET /audit`
needs no change (`kind` filter).

### 12.2 Metrics (MRTR-AUD-003, D-05)

A dependency-free registry (`lib/metrics.ts`: counters, one fixed-bucket
histogram) rendered in Prometheus text exposition format at
`GET /api/v1/metrics` (`min_role: viewer`, `text/plain; version=0.0.4`).
Series:

- `xinas_mcp_confirmations_requested_total{risk,mode}`
- `xinas_mcp_confirmations_decided_total{outcome}` — `approved|declined|cancelled|expired|consumed`
- `xinas_mcp_confirmations_capability_failures_total{mode}`
- `xinas_mcp_confirmations_state_validation_failures_total{reason}`
- `xinas_mcp_confirmations_replay_rejected_total`
- `xinas_mcp_confirmations_round_limit_total`
- `xinas_mcp_confirmations_pending` (gauge, `{mode}`) — **computed from
  the store at scrape time** (`pending` + `approved` rows per mode), never
  maintained event-by-event (review P2: an event-driven gauge drifted on
  approve/decline/consume and mixed the modes)
- `xinas_mcp_confirmation_to_apply_seconds` (histogram; requested →
  consumed; buckets 1, 5, 15, 30, 60, 120, 300, 600, 900)
- `xinas_mcp_confirmations_approved_expired_total` — approved but never
  consumed
- `xinas_mcp_confirmation_audit_suppressed_total{event}` — record-less
  audit rows dropped by the per-principal budget (§12.1); `event` is
  `verification_failed` | `replay_rejected` | `capability_missing`

No label ever carries a principal, token, id or `requestState`.

---

## 13. Configuration

`ApiConfig.mcp` gains `confirmation?`; `ApiConfig.state` gains
`confirmationKeyPath?`. Validated at load by `validateMcpSection`
(pattern of `validateTasksSection`, V-35): out-of-range → throw with the
key and the accepted range.

```jsonc
{
  "mcp": {
    "allow_apply": true,
    "confirmation": {
      "ttl_seconds": 300,                 // 60–900
      "url_wait_seconds": 25,             // 1–55
      "max_pending_per_principal": 5,     // 1–50
      "max_pending_total": 100,           // 1–1000
      "create_rate_per_minute": 10,       // 1–600
      "approval_url_base": "https://nas-01.example.com",  // required for url mode
      "approver_policy": "distinct_principal",            // | any_admin
      "allow_uds_approval": false                         // break-glass only; default false (§3.5)
    }
  },
  "state": { "confirmationKeyPath": "/var/lib/xinas/mcp-confirmation-keys.json" },
  "tokens": {
    "<the agent's bearer>": {
      "principal": "mcp:agent",
      "role": "admin",
      "surface": "mcp"                                  // mcp | rest | any (default any)
    }
  }
}
```

`tokens[<token>].surface` scopes a bearer to one endpoint family (§3.5).
It is optional; **the default when the key is absent is `any`**, which is
what every token minted before this key existed keeps meaning.

| value | `/mcp` | `/api/v1` |
|---|---|---|
| `mcp` | accepted | refused: `PERMISSION_DENIED`, message "this token is scoped to the MCP endpoint", `details: { reason: 'token_surface', surface: 'mcp' }`. No fall-through to UDS peer-trust, exactly as for an unknown bearer |
| `rest` | refused: `resolveIdentity()` returns null, so the endpoint answers the **same 401** an unknown bearer gets (a scoped token must not be an oracle for "this token exists, just not here") | accepted |
| `any` (default) | accepted | accepted |

Any other value is fatal at config load (`validateTokensSection`), including
via `internalTokensPath`: `token '<key>': surface "cli" is invalid —
expected one of mcp, rest, any (omit the key for 'any')`. A typo must never
silently widen the token back to both families.

**Give the MCP agent's token `surface: mcp`.** Without it the confirmation
gate can be bypassed by applying over REST with the same token (§3.5). The
loopback dispatcher is unaffected: it authenticates its own replayed call
with a process-ephemeral token that is not in `config.tokens` at all. When
`mcp.allow_apply` is true and any non-agent token is unscoped, the api
logs a warning at startup naming the principals.

There is **no** key that disables confirmation (D-01). The `xinas_api`
role templates the defaults; the TUI MCP screen (S8 §6c) is *not* extended
in this slice (it preserves unknown `mcp.*` keys already). `discover.ts`
`INSTRUCTIONS` is amended to tell the model that `mode: apply` triggers an
interactive confirmation, that destructive operations require an operator
to approve on the node, that a destructive apply must carry
`dangerous: true` in the same arguments it will later confirm (the server
refuses to start a confirmation without it, §3.4) while never inventing
the flag for a non-destructive operation, and that it must never fabricate
an acceptance.

---

## 14. Compatibility

### 14.1 Capability detection (MRTR-COMPAT-001/002)

From `params._meta["io.modelcontextprotocol/clientCapabilities"]` of the
**current** request: `elicitation` absent → no elicitation; `elicitation`
present but `{}` → `form` only (V-05); `form`/`url` keys present →
those modes. A `form` record needs `form`; a `url` record needs `url`. If
the needed mode is missing the server answers `-32021` (§11) with
`data.requiredCapabilities` naming exactly the missing mode, **creates no
record**, mutates nothing, and never substitutes `form` for `url`.

### 14.2 Legacy clients (MRTR-COMPAT-003)

`DispatcherOptions` gains `client: { era: 'legacy' | 'modern';
capabilities?: ClientCapabilities }`. On the legacy path (`buildMcpServer`)
`era` is `legacy`; a confirmable call answers the tool error
`MCP_CONFIRMATION_UNSUPPORTED` (§11) and creates nothing. Reads, `mode:
plan`, `support.bundle`, `tasks.cancel` and `tasks.wait` are byte-for-byte
unchanged on the legacy path (pinned by the existing transport and
SDK-integration tests plus new negative cases). Enforcement is
unconditional (D-01).

### 14.3 stdio adapter

`xinas-mcp-stdio` is a per-message bridge and forwards `inputResponses`,
`requestState` and `_meta` verbatim; the modern handler's HTTP 400 for
`-32021` is invisible to a stdio client (it sees the JSON-RPC error
object), which is the correct stdio behavior. No change to
`src/mcp-stdio.ts`.

### 14.4 Target clients and expected behavior

Nothing below is verified until the runbook step in §15.4 has been run
against the real client; until then these are **targets**, not claims.

- **Claude Code ≥ 2.1.259** (V-19: the installed binary embeds the v2
  modern-era client; UI behavior unverified) — *expected:* declares
  `elicitation: { form, url }`; renders the form dialog with the
  generated message; shows the URL and asks consent before opening it;
  echoes `requestState` byte-exactly; new JSON-RPC id per retry; decline
  and cancel map to the corresponding `ElicitResult` actions.
- **Codex ≥ 0.147** with `protocol_version = "2026-07-28"` (V-20: release
  notes confirm MRTR; the copy installed on the development Mac is
  **0.136.0**, so the manual acceptance requires an upgrade first, V-54) —
  *expected:* the form flow completes; if it does not declare
  `elicitation.url`, a destructive apply gets `-32021` before any mutation
  (§16 #14).
- **Any legacy client**: §14.2 — this one is verified by the existing
  SDK-1.x integration suite.

---

## 15. Tests

### 15.1 Unit

- every modern `tools/list` / `tools/call` / tool-error result carries
  `resultType: 'complete'`; `input_required` results carry both fields;
  every example in this spec validates against the vendored
  `schema/2026-07-28/schema.json` with `ajv` (V-22) — `InputRequiredResult`,
  `ElicitRequest` (form + url), `ElicitResult`,
  `MissingRequiredClientCapabilityError`, `CallToolResult`;
- capability detection matrix (absent / `{}` / form / url / both);
- `arguments_hash` stability under key reordering and instability under
  any value change;
- key ring: exclusive no-follow creation; an existing symlink, a
  group-readable file, a file owned by another uid (skipped when the test
  runs as root) and a truncated ring are each refused at load; a lost
  `EEXIST` race loads the other writer's ring;
- `requestState`: mint → verify round-trip; wrong key, unknown `kid`,
  altered byte (every byte position of a sample state), truncated,
  oversized (4097 bytes), expired, unknown version tag, wrong field type,
  each binding mismatch — all rejected with the same message; constant-time
  compare is used (spy on `timingSafeEqual`);
- action handling: accept / decline / cancel / missing / wrong decision /
  extra keys;
- mode mapping (§3.2) for all risk × rollback combinations;
- round limit and replay-by-stale-round;
- redaction of secrets at depth; the redacted document is what is hashed;
- form message and page summary rendering for each risk level, with the
  `changing_access` client list present;
- config validation ranges and the `http://` non-loopback refusal.

### 15.2 Integration (in-process api, real SQLite)

- plan → form confirmation → apply → task (share update);
- destructive plan → URL elicitation → operator approve via REST → retry →
  task;
- destructive plan with a form-only client → `-32021`, no record, no task;
- no task, no lease, no desired-state change and no agent call exist
  before acceptance (assert store state between rounds);
- declined / cancelled / expired → no task; the record is terminal;
- a different principal presenting the state → `-32602`, audit
  `replay_rejected`, no task;
- changed arguments / revision / idempotency key / plan id → rejected, no
  task;
- a plan with blockers → `PRECONDITION_FAILED plan_blocked`, no record;
- `dangerous: true` without approval fails; approval without
  `dangerous: true` fails (`dangerous_flag_required`) and leaves the record
  approved for a corrected retry;
- an external caller sending `X-Xinas-Confirmation` and
  `X-Xinas-Client-Type: mcp` is ignored (no loopback bearer) and the apply
  is a plain REST apply;
- an MCP-typed apply reaching the engine without confirmation context is
  refused (`confirmation_required`) — driven by calling `taskEngine.apply`
  directly with `client_type: 'mcp'`;
- `mcp.allow_apply: false` → `MCP_APPLY_DISABLED` and **no record**;
- legacy SDK client: reads, plan, `support.bundle`, `tasks.cancel`
  unchanged; apply → `MCP_CONFIRMATION_UNSUPPORTED`;
- plan ownership: a plan created by another principal (REST `admin:two`,
  MCP `admin:test`) → `PRECONDITION_FAILED plan_binding`, no record; the
  same principal's REST plan applies over MCP;
- approver policy: same principal refused under `distinct_principal`,
  accepted under `any_admin`; `local:uds` **refused by default** and
  accepted only with `allow_uds_approval: true`, which also emits
  `break_glass_used`; `approval_channel` is `bearer` for a token request
  whatever `X-Xinas-Approval-Interface` says, and the label lands in
  `approval_interface` only; wrong acknowledgement phrase refused;
- approval page: headers (CSP, frame, cache), the shell is identical for
  unknown ids, approve without the channel header is refused;
- audit parity: exactly one `http.*` row per tool call plus the expected
  `mcp.confirmation.*` rows; metrics counters move.

### 15.3 Concurrency and recovery

- two simultaneous accepted retries (same state) → exactly one task; the
  loser gets the same task (identical replay) — run under the
  reproduction load the e2e harness already needs on this machine;
- identical retry after consumption → same `task_id`;
- retry with a reused idempotency key but a different plan → `CONFLICT`;
- restart with a `pending` record → still pending, usable;
- restart after operator approval, before consumption → consumable until
  expiry;
- restart after consumption → still consumed; replay returns the same
  task; a different request → `CONFIRMATION_ALREADY_CONSUMED`;
- restart past `expires_at` → the startup sweep expires it, audit
  `expired`, retry → `CONFIRMATION_EXPIRED`;
- dispatch failure after consumption → task `failed
  (FAILED_BEFORE_CHANGE)`, record stays consumed.

### 15.4 Client interoperability

- **v2 SDK client** (`@modelcontextprotocol/client` 2.0.0, devDependency,
  D-08): `versionNegotiation: { mode: 'auto' }` selects `2026-07-28`
  without `initialize` (closes S14 AC10); `{ pin: '2026-07-28' }` connects
  (S14 AC11); with `inputRequired` auto-fulfil and an
  `elicitation/create` handler returning `APPLY`, the form flow completes
  end to end and the handler returning `decline` yields
  `CONFIRMATION_DECLINED`; a URL elicitation reaches the handler with the
  approval URL.
- **Claude Code ≥ 2.1.259** — a documented manual runbook step
  (`hardware-smoke-runbook.md` §5b gains "MCP confirmation"): form dialog,
  URL dialog, exact `requestState` echo (checked in the api log), new id,
  decline and cancel. Not automatable in CI; the v2 SDK client is the
  automated stand-in for the same wire format.
- **Codex ≥ 0.147** — same runbook step with `protocol_version =
  "2026-07-28"`: form flow; and the `-32021` outcome when URL mode is not
  declared.
- **Hand-written conformance client** (extends `mcp-discover.test.ts`'s
  raw JSON-RPC client): every hostile case of §15.1 over the wire,
  capability absence, cross-principal replay, wrapped
  `{method, result}` responses (rejected), reused JSON-RPC id (rejected
  as a protocol error).

---

## 16. Acceptance criteria → evidence

| # | criterion | evidence |
|---|---|---|
| 1 | no modern result omits `resultType` | §15.1 first bullet + schema validation |
| 2 | no MCP apply reaches the REST apply handler before confirmation | §15.2 "no task before acceptance" + loopback spy |
| 3 | no destructive op proceeds on form acceptance alone | §15.2 form-only client `-32021`; forged `accept` with `content` on a `url` record ignored |
| 4 | bound to principal, tool, args, plan, revision, key | §15.1 bindings + §15.2 mismatch cases |
| 5 | any tampered byte rejected | §15.1 altered-byte sweep |
| 6 | at most one task per confirmation | §15.3 concurrency + partial unique index |
| 7 | restart never re-arms a consumed approval | §15.3 |
| 8 | `dangerous`, RBAC, freshness, blockers, `allow_apply` independent | §15.2 |
| 9 | legacy reads and plans unchanged | existing tests + §15.2 legacy |
| 10 | legacy apply fails closed | §15.2 legacy |
| 11 | REST/CLI/TUI unchanged | `ApplyRequest` untouched (oasdiff); parity e2e |
| 12 | every decision auditable | §15.2 audit parity |
| 13 | Claude Code end to end | §15.4 runbook |
| 14 | Codex completes or fails before mutation | §15.4 runbook |
| 15 | examples validate against the schema | §15.1 |

---

## 17. Repository guidance and deferrals (SPEC-007)

- `CLAUDE.md` §MCP surface: add this spec to the live-contract list.
- `docs/TODO.md`: **remove** "MCP — the modern-era SDK client tests
  (acceptance criteria 10 and 11) are unwritten" (obsolete, V-21; the
  tests land in §15.4). **Add** "MCP — TUI approvals screen deferred"
  (D-09) with: what is missing (a Management screen listing pending MCP
  confirmations with approve/decline), what exists instead (the web page,
  REST, `xinasctl`), why it was cut (additive surface; three channels
  already cover approval), and done (the screen, driven by
  `control_client.py`, with the acknowledgement phrase for destructive
  records).
- `hardware-smoke-runbook.md` §5b: the manual Claude Code / Codex steps.
- Not in this slice, flagged for the reviewer: the REST-side blocker
  re-check gap (V-26, D-07); the legacy-session observations (V-40).

---

## 18. Risks

- **Client UX in URL mode:** an eager client re-prompting the user up to
  three times while the operator approves. Mitigated by the 25-second
  server-side wait per round (≈ 75 s of grace plus the human's consent
  clicks) and by the page approving *before* the client retries in the
  common case.
- **Operator credential on the page:** pasting an admin bearer into a
  browser is unfamiliar. The page never stores it and the policy refuses
  the requester's own credential; the TUI screen (deferred) is the
  friendlier long-term path.
- **Key file management:** a lost key file invalidates in-flight
  confirmations (they expire naturally; nothing is mutated). Documented in
  the `xinas_api` role README.
- **Migration on a busy node:** `006` is additive (two nullable columns,
  one new table); plans made before it cannot be confirmed over MCP and
  say so.
