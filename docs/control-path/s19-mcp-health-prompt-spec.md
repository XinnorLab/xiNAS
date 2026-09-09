# xiNAS S19 — Built-in MCP prompt and agentic health check (design spec)

**Status:** design draft for validation, 2026-09-09. Nothing in this
document is implemented; every "MUST" describes the intended end state
the implementation slices in §1 have to reach. Extends **ADR-0009**
(`health.probe`, the profile engine), **ADR-0010** / `s8-clients-spec.md`
(the catalog, the gate, the `/mcp` transport), **S14**
(`s14-mcp-modern-era-spec.md`, both protocol eras), **S15**
(`s15-mcp-mrtr-confirmation-spec.md`, human confirmation), **S17**
(`s17-mcp-subscriptions-spec.md`, the resource-provider seam and the
event feeds), the **S0/S1 agent** specification and the Python health
engine under `xinas_menu/health/`. Its decisions are recorded in
**ADR-0018** (`adr/0018-mcp-prompts-agentic-health-check.md`).

**Requirements source:**
[`s19-mcp-health-prompt-requirements.md`](s19-mcp-health-prompt-requirements.md)
(the translated draft; its IDs — `ARCH-nn`, `MCP-nn`, `CFG-nn`,
`PROMPT-nn`, `DATA-nn`, `HC-nn`, `CHECK-nn`, `PROBE-nn`, `REPORT-nn`,
`SAFE-nn`, `AC-nn`, `G-nn` — are cited throughout; its §13 landing review
supplies the facts in §2 below). Where this spec deviates from the
requirements it says so inline and names the requirement it deviates from.

**Prompt text:**
[`s19-mcp-health-prompt-template.md`](s19-mcp-health-prompt-template.md)
is the source of the prompt body (§5.5).

**Protocol sources (normative, verified 2026-09-09):** MCP `2026-07-28`
[Prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts),
[Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
(Sampling deprecated; `ttlMs`/`cacheScope` on list results; `-32602` for
an unknown prompt), the released `schema.json` pinned under
`xiNAS-MCP/src/__tests__/contracts/mcp/2026-07-28/` (`Prompt`,
`PromptArgument`, `ListPromptsResult`, `GetPromptResult`, `PromptMessage`,
`Role`), and the legacy SDK 1.30 `ListPromptsRequestSchema` /
`GetPromptRequestSchema`.

**Goal.** A connected AI client can select one server-provided prompt,
`xinas_health_check`, and run an evidence-bound diagnostic session against
a node using only the tools its principal is allowed to call. xiNAS
supplies the prompt, the validated run context, the deterministic reports
with typed collection status, a read-only adapter to the Python baseline
engine, a hardened and separately gated active probe, the versioned check
catalog, the report schema and a validator that computes the verdict.
The client supplies the LLM, the agents (if any), the budget enforcement
and the report storage. Nothing the model writes ever becomes observed
state, and nothing the prompt says ever widens a permission.

---

## 1. Scope

The work is cut into four slices, each a PR into `release/3.14` with its
own tests. Slices a–c ship code and therefore carry
`Requires-Rebuild: xinas_node_build`; the Python change in c is
code-only (no trailer).

### S19a — contracts, typed collection, hardened probes

- **T0 contracts:** this spec; ADR-0018; the S14 §4 capability row, the
  ADR-0010 preamble, the S8 §3 namespace note and the agent RPC table
  amendments; additive `api-v1.yaml` changes (§14).
- **T1 typed collection status** (G-01, G-02, DATA-03): the `health.probe`
  RPC result gains per-section `{status, observed_at, value | error}`;
  the api maps each status to a distinct check outcome; `HealthReport`
  gains `coverage_status` and `collection` (§7).
- **T2 hardened probe host + `health.probe.run`** (G-04 remainder,
  PROBE-01..04): unique per-run artifacts, exclusive create, symlink and
  device checks, per-run loopback mountpoint, serialization, cleanup as a
  finding, agent-side timeout; the new confirmable tool; the legacy
  `health.check profile=deep` path re-pointed at the same implementation
  (§9). Closes the `docs/TODO.md` entry "Health — the deep-profile probe
  artifacts are not hardened".

### S19b — prompt, context, catalog

- **T3 prompt provider** (MCP-01..03): `prompts/list` and `prompts/get`
  on both eras from one provider; the `prompts` capability advertised iff
  the provider is installed; argument validation; template versioning
  (§4, §5).
- **T4 `health.context`** (DATA-02, PROMPT-01/02) and the in-memory run
  ledger (§6).
- **T5 check catalog** as versioned data, `GET /health/catalog` (§10).
- **T6 instructions pointer** (MCP-04) (§4.3).

### S19c — baseline adapter, report contract

- **T7 `health.baseline`** (DATA-01, PROMPT-03): the agent-side
  subprocess adapter around the Python engine, the api route with a
  freshness cache, and the Python-side `not_supported` row for an enabled
  section without a checker (AC-06) (§8).
- **T8 report schema + `health.report.validate`** (REPORT-01..06,
  AC-19): the JSON schema, the deterministic verdict, evidence-reference
  and raw-report integrity checks (§11).

### S19d — acceptance

- **T9** the anonymized incident fixtures, the AC-01..AC-20 matrix run
  through unit, contract and e2e tests, and the hardware smoke rows
  (`hardware-smoke-runbook.md`) (§15, §16).

### Out of scope (deferred; recorded in `docs/TODO.md` when the slice lands)

- An LLM orchestrator inside xiNAS, MCP Sampling, or server-managed
  sub-agents (ARCH-04, ARCH-05). The client runs the model.
- The HC-11 client-path adapter. `service_path` scope is accepted and
  always reports HC-11 as `not_supported` in v1, so its coverage is
  `partial` by construction (CHECK-01).
- Server-side storage of agentic reports (DATA-06 second sentence).
- A managed editor for operator overrides with diff, author, revision and
  rollback (CFG-03). v1 overrides are `config.json` keys (§12).
- `prompts` `listChanged` notifications and hot reload (MCP-03 last
  sentence). The prompt list is fixed for the process lifetime.
- Eliciting missing prompt arguments through an MRTR `InputRequiredResult`
  on `prompts/get` (requirements §13). v1 answers `-32602`.
- Argument completion (`completion/complete`).

## 2. Verified facts this design rests on

Re-verified on `origin/release/3.14` at `f9624a1c` (the tip after #387
and #388). Each fact names the code it was read from.

- **F-01** The modern dispatcher (`api/mcp/modern.ts`) is a method switch
  that answers `-32601` for anything not listed; resources are served
  through the `ResourceProvider` seam (`api/mcp/resources.ts`) installed
  as `DispatcherOptions.resources`. The legacy SDK server
  (`buildMcpServer` in `api/mcp/dispatch.ts`) declares static
  capabilities and registers handlers with `setRequestHandler`. The stdio
  adapter (`src/mcp-stdio.ts`) forwards JSON lines to `POST /mcp` and
  special-cases only `subscriptions/listen` and the task methods.
- **F-02** `buildCapabilities` (`api/mcp/discover.ts`) derives
  capabilities from what is installed and explicitly omits `prompts`;
  `mcp-discover.test.ts` row 7 pins that absence.
- **F-03** `health.probe` (`agent/rpc/methods/health-probe.ts`) catches
  per section and returns `null`, `[]` or `{}`; `lib/health/standard.ts`
  turns those into `skipped` checks whose symptom reads like an absent
  component; `overallOf` (`lib/health/engine.ts`) ignores `skipped`.
- **F-04** After #387 the `health.check` catalog entry carries
  `escalation: { arg: 'profile', value: 'deep', min_role: 'operator',
  requires_mcp_apply: true }`; `rbacMiddleware` and `gateVerdict` read it.
  The probe host (`agent/health/probe-host.ts`) still writes a fixed
  `.xinas-health-probe` with `writeFile`, mounts a fixed
  `/run/xinas/health-probe/mnt`, and swallows cleanup failures.
- **F-05** The Python engine is `xinas_menu/health/engine.py`;
  `python3 -m xinas_menu.health <profile.yml> <log_dir> [--json]
  [--no-save]` prints the JSON report on stdout with `--json`, writes
  nothing with `--no-save`, and iterates a hard-coded `section_map` so an
  enabled YAML section without a checker (`kerberos`) produces no row.
  Profiles are found by `xinas_menu/health/profiles.py` in
  `/opt/xiNAS/healthcheck_profiles`; the TUI's venv is
  `/opt/xiNAS/venv` and the package root `/opt/xiNAS`
  (`collection/roles/xinas_menu/defaults/main.yml`).
- **F-06** The `Disk.status.health` block the MCP `disk.health` check
  reads is written by no probe (`docs/TODO.md`, S17 source-gated
  families), so that check is always `skipped` on a real node.
- **F-07** S15's `CatalogEntry.confirmation: 'required'` is defined and
  honoured by `isConfirmable` but carried by no entry; the confirmation
  record binds a plan document and expires after `ttl_seconds`
  (default 300 s).
- **F-08** The catalog exposes, beyond what the requirements list,
  `system.metrics`, `nfs_sessions.list` and `system.capabilities`; the
  S17 feeds (`xinas://events/<feed>`) are readable resources on the
  modern era.
- **F-09** MCP `2026-07-28`: `ListPromptsResult` requires `resultType`,
  `prompts`, `ttlMs`, `cacheScope`; `GetPromptResult` requires
  `resultType` and `messages`; `PromptMessage.role` is `user` or
  `assistant`; an unknown prompt name or a missing required argument is
  `-32602`; Sampling is deprecated.

## 3. Decisions

The numbered decisions below are the ones ADR-0018 records; each points
at the section that specifies it.

| ID | Decision | Section |
|---|---|---|
| D-01 | One `PromptProvider` seam serves both eras; the `prompts` capability is advertised iff a provider is installed | §4, §5.1 |
| D-02 | Exactly one prompt, `xinas_health_check`, returned as one `user` text message; parameters travel as a delimited JSON block inside it | §5.4 |
| D-03 | The prompt body's source of truth is the docs template; the runtime constant is pinned to it by a test; `prompt_version` + `template_sha256` identify it | §5.5 |
| D-04 | `prompts/get` reads nothing live: availability flags come from installed handlers, argument validation is shape-only, resource existence is resolved by `health.context` | §5.3 |
| D-05 | Collection status is a closed enum per source; `not_supported` is the only status that may become `skipped`; the others become a distinct `degraded` outcome, never `skipped`, never `ok` | §7 |
| D-06 | `HealthReport.overall` keeps its meaning; `coverage_status` and `collection` are additive | §7.3 |
| D-07 | Active probes are a `direct` tool `health.probe.run`: operator rank, `requires_mcp_apply`, S15 confirmation; the legacy deep path keeps the #387 escalation and shares the hardened implementation | §9 |
| D-08 | Probe artifacts are per run: unique names under a dedicated directory, `O_EXCL`, `O_NOFOLLOW`, device check, per-run mountpoint, one probe in flight per node, cleanup failure is a finding | §9.3 |
| D-09 | The baseline adapter is an agent RPC that runs the Python engine as a capped, read-only subprocess (`--json --no-save`); the api caches the last result per profile with its `collected_at` | §8 |
| D-10 | `health.context` mints the `run_id` and records limits; xiNAS enforces only the limits it can see (probes per node and per run); tool-call and time budgets are the host's | §6 |
| D-11 | The check catalog is versioned data shipped with the server and served read-only; a catalog row without a backing source says so (`no_source`) | §10 |
| D-12 | The verdict is computed by `health.report.validate`, never by the model; raw-report digests are checked against the run ledger; the client stores the report | §11 |
| D-13 | Configuration lives under `mcp.health_prompt` (api) and `health_baseline` (agent); text overrides cannot loosen enforcement | §12 |
| D-14 | Four slices; every code slice carries `Requires-Rebuild: xinas_node_build` | §1 |

## 4. Discovery and capability truthfulness

### 4.1 Modern era (`server/discover`)

`buildCapabilities` (S14 §4) gains one rule: `prompts` is present as
`{ "listChanged": false }` iff `DispatcherOptions.prompts` is installed,
and absent otherwise. No other capability changes. `listChanged` is
`false` because the list is fixed for the process lifetime (MCP-03);
advertising `true` without a notification path would violate S14's
"only what is served" rule. `mcp-discover.test.ts` row 7 changes from
"prompts absent" to "prompts present iff the provider is installed, and
`{ listChanged: false }` when present".

### 4.2 Legacy era (`initialize`)

`buildMcpServer` declares `prompts: { listChanged: false }` in the SDK
`Server` capabilities iff the provider is installed, and registers
`ListPromptsRequestSchema` and `GetPromptRequestSchema` handlers that call
the same provider (§5.6). One provider, two eras, one meaning (AC-16).

### 4.3 Instructions (MCP-04)

`INSTRUCTIONS` (`api/mcp/discover.ts`) gains one sentence, kept in step
with the prompt text by the T3 test:

> For a health diagnosis select the `xinas_health_check` prompt: it runs
> the rule-based checks and data-quality reads first, then the agentic
> analysis; active probes need a separate, confirmed permission and are
> never implied by a prompt argument.

The RBAC, plan/apply and confirmation sentences already in
`INSTRUCTIONS` are unchanged.

### 4.4 stdio

`xinas-mcp-stdio` needs no change: `prompts/list` and `prompts/get` are
plain single-response methods and travel like `tools/list`. The T3
contract test drives both methods through the stdio adapter on both eras
(AC-16).

## 5. The prompt provider

### 5.1 Seam (D-01)

```ts
// api/mcp/prompts.ts
export interface PromptProvider {
  list(ctx: ReadCtx): McpPrompt[];                       // static, cheap
  get(name: string, args: Record<string, string>, ctx: ReadCtx): GetPromptBody;
}
export interface PromptsOptions { providers: PromptProvider[] }
```

`DispatcherOptions.prompts?: PromptsOptions` is installed by `app.ts`
when `config.mcp.health_prompt.enabled !== false`. The modern dispatcher
adds two cases:

| Method | Result (modern) |
|---|---|
| `prompts/list` | `{ resultType: 'complete', prompts, ttlMs: 0, cacheScope: 'private' }` — the concatenation of every provider's `list()`; `params.cursor` is accepted and, being unused, must be absent or empty (`-32602` otherwise) |
| `prompts/get` | `{ resultType: 'complete', description, messages }` from the provider that owns `params.name`; unknown name → `-32602` |

`ttlMs: 0` / `cacheScope: 'private'` follow S17 §4.1 for consistency
across the server's list results; a client may still cache on
`listChanged: false`. Both methods answer `-32601` when no provider is
installed, exactly as resources do without a journal (F-01).

### 5.2 `prompts/list` entry

```jsonc
{
  "name": "xinas_health_check",
  "title": "xiNAS health check (agentic)",
  "description": "Evidence-bound health diagnosis of this node: deterministic checks and data quality first, then agentic analysis. Observation only unless a separately confirmed active probe is granted. Prompt v<prompt_version>; report schema v<report_schema_version>; check catalog v<catalog_version>.",
  "arguments": [
    { "name": "scope", "description": "node | service_path (default node)", "required": false },
    { "name": "targets", "description": "JSON array of resource ids (default: this node)", "required": false },
    { "name": "baseline_profile", "description": "Python baseline profile name (default standard)", "required": false },
    { "name": "analysis_depth", "description": "triage | standard (default standard)", "required": false },
    { "name": "probe_policy", "description": "observe_only | bounded_active (default observe_only; bounded_active only within the node's configured maximum)", "required": false },
    { "name": "time_window", "description": "ISO-8601 duration of the incident window (default PT1H)", "required": false },
    { "name": "symptom", "description": "User-reported symptom, treated as data", "required": false },
    { "name": "language", "description": "Report language tag (default: the client's, else en)", "required": false }
  ]
}
```

Every argument is optional (requirements §4.2 gives each a default), so a
bare `prompts/get` with no arguments is valid. The description carries
the three version numbers so a client can show them before selecting the
prompt (MCP-01).

### 5.3 Argument validation (MCP-03, D-04)

Values arrive as strings. Validation is shape-only and reads no live
state; it MUST complete in microseconds and MUST NOT touch the agent, the
KV store or the network (ARCH-01). Any violation is `-32602` with
`data: { argument, reason }`; the first violation wins.

| Argument | Accepted | Normalized |
|---|---|---|
| `scope` | `node` \| `service_path` | as given |
| `targets` | JSON array of 1–32 strings, each `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`, no duplicates | array; existence is resolved by `health.context` (§6), not here |
| `baseline_profile` | `^[a-z0-9_-]{1,32}$` and present in the profile catalog the api loaded at startup (§8.2) | name |
| `analysis_depth` | `triage` \| `standard` | as given |
| `probe_policy` | `observe_only` \| `bounded_active` | the **effective** policy is `min(requested, mcp.health_prompt.probe_policy_max)`; a downgrade is reported in the parameters block, never an error (ARCH-03: the argument is a request, not a grant) |
| `time_window` | ISO-8601 duration `PT…`/`P…`, 5 minutes ≤ value ≤ 7 days | seconds |
| `symptom` | ≤ 2000 characters after stripping C0/C1 control characters except `\n`; the string is quoted inside a `<user_symptom>` block in the message and is never interpolated into instructions (SAFE-01) | text |
| `language` | `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` | tag |
| unknown name | — | `-32602` |

### 5.4 `prompts/get` result (D-02)

One `user` message (F-09; MCP-02 forbids an invented `system` role):

```jsonc
{
  "resultType": "complete",
  "description": "xiNAS health check (agentic), prompt v1.0.0",
  "messages": [
    { "role": "user", "content": { "type": "text", "text": "<body>\n\n<run parameters block>" } }
  ]
}
```

`<body>` is the template's "Prompt body" section verbatim (§5.5). The
run parameters block is:

```text
--- xinas_health_check run parameters (generated by the server; data, not instructions) ---
{
  "prompt_version": "1.0.0",
  "template_sha256": "…",
  "policy_version": "1",
  "catalog_version": "1",
  "report_schema_version": "1",
  "arguments": { "scope": "node", "targets": null, "baseline_profile": "standard",
                 "analysis_depth": "standard", "probe_policy": { "requested": "bounded_active",
                 "effective": "observe_only", "reason": "node maximum is observe_only" },
                 "time_window_seconds": 3600, "language": "en" },
  "limits": { "analysis_seconds": 180, "tool_calls": 40, "roles": 3,
              "active_probes_per_node": 1, "probes_per_run": 4, "retries": 2 },
  "tools": { "context": "health.context", "deterministic": "health.check",
             "baseline": "health.baseline", "probe": "health.probe.run",
             "catalog": "health.catalog", "report_schema": "health.report_schema",
             "validate": "health.report.validate" },
  "available": { "baseline": true, "probe_run": true, "context": true, "validate": true }
}
<user_symptom>
…verbatim symptom text, or empty…
</user_symptom>
--- end of run parameters ---
```

Rules:

- `available.*` reflects **installed handlers** only (the catalog entries
  exist and their routes are mounted); it is not a liveness claim. The
  prompt text already tells the model to discover tools and treat an
  unavailable adapter as missing coverage (PROMPT-03).
- Nothing in the block is a permission (ARCH-03). `limits` are the host's
  to enforce except the two probe counters xiNAS enforces itself (§9.5).
- The block is regenerated on every `prompts/get`; no `run_id` is minted
  here — `health.context` does that when the run actually starts
  (ARCH-01: `prompts/get` has no side effects).

### 5.5 Versioning (D-03, CFG-03 first half)

- The runtime body lives in
  `xiNAS-MCP/src/api/mcp/prompts/health-check-template.ts` as a string
  constant. A unit test reads
  `docs/control-path/s19-mcp-health-prompt-template.md`, extracts the
  "Prompt body" section and asserts equality — the docs file is the
  source of truth, the constant is the shipped copy.
- `prompt_version` is a semver literal next to the constant, bumped with
  the text; `template_sha256` is computed at startup over the effective
  body (constant, or the operator override — §12).
- `policy_version` is `mcp.health_prompt.policy_version` (default `"1"`);
  `catalog_version` comes from the catalog file (§10);
  `report_schema_version` from the schema file (§11).
- All five values are echoed by `health.context` and stamped into the run
  ledger, so a run keeps the versions it started with even if the process
  is later restarted with a new template (AC-17: the ledger entry, not
  the live constant, is what the validator compares against).

### 5.6 Legacy era

The SDK handlers return the legacy shapes (no `resultType`, `ttlMs`,
`cacheScope`) built from the same provider output. Validation errors are
thrown as `McpError(ErrorCode.InvalidParams, …)` so the SDK emits
`-32602`.

### 5.7 Audit

`prompts/list` is not audited (a static read, like `tools/list`).
`prompts/get` writes one audit row `mcp.prompts.get` with the prompt name,
the normalized arguments **except** `symptom` (free text is not audited
verbatim; its length and sha256 are), and the principal.

## 6. Run context — `health.context`

### 6.1 Catalog entry

`read('health.context', 'GET', '/health/context', …)`, `min_role:
viewer`, `mutability: read`. Input: `{ run_id?: string }` — absent
mints a new run; a known, unexpired id returns the same context again
(idempotent re-read within a run). It MUST NOT call the agent: it answers
when the agent is down, and says so.

### 6.2 Response

```jsonc
{
  "run": {
    "run_id": "uuid-v4", "issued_at": "…Z", "expires_at": "…Z",       // issued_at + limits.run_ttl_seconds
    "principal": "op:alice", "role": "operator",
    "versions": { "prompt": "1.0.0", "template_sha256": "…", "policy": "1", "catalog": "1", "report_schema": "1",
                  "server": "<SERVER_INFO.version>" },
    "limits": { … as in §5.4 … },
    "permitted": {
      "deterministic": ["quick", "standard"],                          // 'deep' listed iff the role passes the escalation AND (REST caller | mcp.allow_apply)
      "baseline": true,
      "probe_run": "denied" | "confirmable" | "allowed",               // §9.1
      "apply": false                                                   // always false in this scenario: remediation is a separate workflow (SAFE-03)
    }
  },
  "node": { "hostname": "…", "controller_id": "…", "xinas_version": "…", "kernel": "…" | null,
            "xiraid_version": "…" | null },                             // same sources as system.get; null = not observed
  "topology": {
    "arrays": [ { "id": "…", "state": "…", "revision": 12, "observed_at": "…Z", "member_disk_ids": [ … ] } ],
    "filesystems": [ { "id": "…", "array_id": "…" | null, "mountpoint": "…", "mounted": true, "revision": 9, "observed_at": "…Z" } ],
    "shares": [ { "id": "…", "path": "…", "filesystem_id": "…" | null } ],
    "interfaces": [ { "id": "…", "rdma_capable": true, "rdma_link_state": "up", "observed_at": "…Z" } ],
    "declared_absent": [ "nfs" | "raid" | … ]                          // components the inventory proves absent (AC-04)
  },
  "collectors": {
    "heartbeat": "healthy" | "degraded" | "offline",
    "last_probe": { "collected_at": "…Z", "collectors": { "…": "running" } } | null   // the api's cached last standard probe, if any
  },
  "freshness": { "XiraidArray": { "newest_observed_at": "…Z", "oldest_observed_at": "…Z", "rows": 2 }, "…": { … } },
  "baselines": [ { "name": "standard", "path": "/opt/xiNAS/healthcheck_profiles/standard.yml", "sha256": "…",
                   "timeout_seconds": 300, "sections_enabled": [ … ], "sections_without_checker": [ ] } ],
  "catalog": { "version": "1", "tool": "health.catalog" },
  "tools": [ { "name": "arrays.list", "min_role": "viewer" }, { "name": "health.check", "min_role": "viewer",
              "escalation": { "arg": "profile", "value": "deep", "min_role": "operator", "requires_mcp_apply": true } }, … ],
  "targets": { "resolved": [ … ], "unknown": [ … ] }                  // from the prompt's `targets`, if the caller passes them
}
```

- `declared_absent` is derived from inventory, never from an empty
  observation after a failed query (PROMPT-02, AC-04): `nfs` is declared
  absent iff there are no desired shares **and** the observed
  `nfs-server.service` row says the unit is not installed; `raid` iff the
  observed `XiraidArray` collector reports `running` **and** zero rows.
  When the collector is not `running`, the component is `unknown`, not
  absent.
- `freshness` is per observed kind from the KV rows' `observed_at`
  (DATA-05: no universal TTL; the client compares against the catalog's
  per-source freshness policy).
- `topology.links` are the KV cross-references that exist today
  (`member_disk_ids`, `array_id`, `filesystem_id`); a missing link is
  `null`, not inferred.

### 6.3 Run ledger (D-10)

In-memory, per api process: `run_id → { issued_at, expires_at, principal,
versions, limits, probes_started, reports: [{ tool, args_digest,
report_digest, collected_at }] }`. Entries expire at `expires_at` and are
swept with the S15 confirmation sweep. `health.check`, `health.baseline`
and `health.probe.run` accept an optional `run_id`; when present and
valid they append their report digest (sha256 over the canonical JSON of
the returned `result`) to the ledger. That digest is what
`health.report.validate` compares raw reports against (§11.4). An
unknown or expired `run_id` is accepted with `warnings:
[RUN_UNKNOWN]` — a run must not fail because the api restarted (SAFE-04).

## 7. Typed collection status

### 7.1 `health.probe` RPC, schema 2 (T1)

```ts
type CollectionStatus = 'success' | 'error' | 'timeout' | 'permission_denied' | 'not_supported';
interface Section<T> { status: CollectionStatus; observed_at: string; value?: T; error?: { code?: string; message: string } }
interface HealthProbeResultV2 {
  schema: 2;
  sections: {
    license: Section<ParsedLicense | null>;          // value null + success = xiRAID installed, no license record
    rdma_links: Section<ProbeRdmaLink[]>;            // value [] + success = the tool ran and reported no links
    collectors: Section<Record<string, string>>;
    nfs_profile_render: Section<Record<string, string> | null>;
    probes?: Section<DeepProbeResults>;              // level=deep only
  };
}
```

Status assignment on the agent:

| Situation | `status` | `error.code` |
|---|---|---|
| Tool binary absent (`ENOENT` on `xicli`, `rdma`, …) | `not_supported` | `TOOL_ABSENT` |
| Helper unreachable (nfs dry render) | `error` | `HELPER_UNREACHABLE` (the nfs-helper spec §4 code) |
| `EACCES`/`EPERM` | `permission_denied` | `EACCES` |
| Subprocess exceeded its bound | `timeout` | `TIMEOUT` |
| Non-zero exit, parse failure, thrown error | `error` | the parser's or `errno` code |
| Ran to completion | `success` | — |

`observed_at` is the agent's clock at the end of the section's
collection, never the api's request time (PROMPT-02). The api and the
agent are rebuilt and restarted together by `xinas_node_build`; a v1
result (no `schema`) is mapped to every section `status: 'error',
code: 'LEGACY_AGENT'` so the mismatch is visible, not silent.

### 7.2 Mapping to checks (D-05)

`lib/health/standard.ts` builders take a `Section<T>`:

| Section status | Check `status` | `symptom` | `evidence.collection` |
|---|---|---|---|
| `not_supported` | `skipped` | "`<tool>` not installed" | `{ status: 'not_supported', code, observed_at }` |
| `error` / `timeout` / `permission_denied` | `degraded` | "collection failed: `<code>`" | `{ status, code, message, observed_at }` |
| `success` | the existing logic over `value` | existing | `{ status: 'success', observed_at }` |

Only `not_supported` may produce `skipped` (G-01 fixed: a failed query
never looks like an absent component). The existing "empty value"
branches (`no RDMA links reported`, `no mounted managed filesystems to
probe`) stay `skipped` but now carry `collection.status: 'success'`, so
a client can tell "asked and found none" from "could not ask" (DATA-03).
`probeUnavailable` (agent did not answer) keeps `degraded` +
`EXECUTOR_UNAVAILABLE` and adds `collection: { status: 'error', code:
'EXECUTOR_UNAVAILABLE' }`. The quick (KV-derived) checks add
`collection: { status: 'success', observed_at: <row observed_at> | null }`
per fact they consumed.

### 7.3 `HealthReport` additions (D-06)

```jsonc
{
  "profile": "standard", "started_at": "…", "completed_at": "…",
  "overall": "ok",                                        // UNCHANGED semantics (REPORT-01)
  "coverage_status": "complete" | "partial",              // NEW
  "collection": {                                         // NEW
    "agent": "answered" | "unavailable" | "not_needed",   // not_needed on quick
    "sources": { "license": "success", "rdma_links": "not_supported", "…": "…" }
  },
  "checks": [ … each with evidence.collection … ]
}
```

`coverage_status` is `partial` iff `collection.agent === 'unavailable'`
on standard/deep, or any section is `error`/`timeout`/`permission_denied`;
otherwise `complete`. `overall` is still `overallOf(checks)`; because
collection failures are now `degraded`, a probe that could not run pulls
`overall` to `degraded` (G-02 fixed at the source, AC-02). Both fields
are additive in `api-v1.yaml` (§14).

## 8. Baseline adapter — `health.baseline`

### 8.1 Catalog entry

`read('health.baseline', 'GET', '/health/baseline', …)`, `min_role:
viewer`, input `{ profile: string (default 'standard'), max_age_s?:
integer 0..3600 (default 0), run_id?: string }`. The Python engine
mutates nothing when run with `--no-save` (F-05), reads SMART and sysfs,
and needs root — which the agent has — so viewer rank is correct and no
escalation applies. The description states the cap (§8.3) and that the
profile's own `timeout_seconds` may be truncated by it.

### 8.2 Profile catalog

At startup the api lists `mcp.health_prompt.baseline.profiles_dir`
(default `/opt/xiNAS/healthcheck_profiles`, F-05): every `*.yml` whose
name matches `^[a-z0-9_-]{1,32}$` becomes a catalog row `{ name, path,
sha256, timeout_seconds, sections_enabled, sections_without_checker }`.
`sections_without_checker` is computed against the engine's checker list
published by the Python side (§8.5). The list is fixed for the process
lifetime (MCP-03); `health.context` returns it. An unknown `profile` is
`INVALID_ARGUMENT` (400) naming the known profiles.

### 8.3 Agent RPC `health.baseline` (D-09)

Joins the enumerated ADR-0002 method set (agent spec RPC table). Params
`{ profile_path, timeout_s }`; `profile_path` MUST be inside the
configured profiles dir (realpath check) — the agent never runs an
arbitrary file. The agent runs

```text
<health_baseline.python> -m xinas_menu.health <profile_path> <health_baseline.log_dir> --json --no-save
```

with `cwd = health_baseline.module_root`, `PYTHONPATH` set to it, a
sanitized environment (`PATH`, `LANG=C.UTF-8`, nothing else), stdin
closed, stdout captured (≤ 4 MiB), stderr captured (≤ 64 KiB, kept in
the result), in its own process group, killed with `SIGKILL` at
`timeout_s`. One baseline subprocess at a time per agent: a second call
while one is running waits for it (up to its own `timeout_s`) and
receives the same result — the engine is not re-run for a concurrent
caller (SAFE-04 "duplicate requests are merged").

Result:

```jsonc
{
  "status": "success" | "error" | "timeout" | "not_supported",   // not_supported: interpreter or module missing
  "collected_at": "…Z", "duration_ms": 1234,
  "engine": { "module": "xinas_menu.health.engine", "version": "<XINAS_MENU_VERSION>" | null },
  "report": { …the engine's JSON verbatim… } | null,
  "stderr_tail": "…",
  "error": { "code": "TIMEOUT" | "EXIT_<n>" | "PARSE" | "ENOENT", "message": "…" }
}
```

Timeouts (`mcp.health_prompt.baseline.timeout_s`): `quick` 60 s,
`standard` 180 s, `deep` 300 s; the api passes
`min(profile.timeout_seconds, cap)`. A truncated run is `timeout`; the
api never presents a partial engine report as complete.

### 8.4 Api route and cache

`GET /health/baseline` returns

```jsonc
{
  "profile": { "name": "standard", "sha256": "…", "timeout_seconds": 300, "sections_without_checker": [ ] },
  "collection": { "status": "success", "collected_at": "…Z", "duration_ms": 1234, "from_cache": false, "age_s": 0 },
  "engine": { … }, "report": { … } | null, "error": { … } | null
}
```

The api keeps the last **successful** result per profile in memory. With
`max_age_s > 0` and a cached result younger than that, it returns the
cached result with `from_cache: true` and the original `collected_at`
(DATA-05: freshness is stated, never implied). `max_age_s: 0` always
runs. The cache is not written to KV (DATA-06) and does not survive a
restart.

### 8.5 Python-side changes (AC-06, G-03)

- `engine.main()` appends, for every YAML section that is enabled but
  absent from `section_map`, a row `CheckResult(section, "checker",
  "SKIP", "not supported by this engine", "N/A", evidence="section has
  no checker")`, so `kerberos` becomes visible in the report instead of
  vanishing. The TUI shows it as SKIP like any other.
- `xinas_menu.health.engine` exports `SUPPORTED_SECTIONS` (the
  `section_map` keys) and `python3 -m xinas_menu.health --sections`
  prints them as JSON; the api reads that once at startup to fill
  `sections_without_checker` (§8.2). Code-only Python change: no rebuild
  trailer.

## 9. Active probes — `health.probe.run`

### 9.1 Catalog entry (D-07)

```ts
{
  name: 'health.probe.run', method: 'POST', path: '/health/probe',
  mutability: 'direct', requires_mcp_apply: true, min_role: 'operator',
  confirmation: 'required',                       // S15 hook, first user
  input_schema: { probe: 'fs_io' | 'nfs_loopback', target: string, run_id?: string, timeout_s?: 1..60 },
}
```

Gate matrix for the three entry paths (PROBE-01: the permission holds on
every path):

| Path | Rank | `mcp.allow_apply` | Confirmation |
|---|---|---|---|
| REST / `xinasctl health probe run` | operator | n/a | none — a REST operator credential is the standing grant, as for every direct tool |
| MCP, modern client with elicitation | operator | required | S15 human confirmation (URL or form), TTL `ttl_seconds` |
| MCP, legacy client | operator | required | `MCP_CONFIRMATION_UNSUPPORTED` — route to REST/xinasctl (S15 §3) |

`health.context.run.permitted.probe_run` is `denied` (rank or
`allow_apply` fails), `confirmable` (MCP, passes both, needs
confirmation) or `allowed` (REST operator).

**S15 extension for a confirmable direct entry.** The confirmation
service today binds a plan document. For `confirmation: 'required'`
entries it binds instead `{ tool_name, args_sha256 }` with `risk:
non_disruptive`, `rollback: not_applicable`, no acknowledgement phrase,
and the same TTL, single-consumption and audit rows as an apply
confirmation. The approval page shows the probe kind, the target and
the side effects sentence from the catalog description. This is the
"permission granted beforehand for a specific scope, usable until it
expires" of PROBE-02; the `probe_policy` prompt argument is not it
(ARCH-03).

### 9.2 Request and response

Body: `{ probe, target, run_id?, timeout_s? }`. `target` is a
`Filesystem` id for `fs_io` (the probe runs at its observed mountpoint)
or a `Share` id for `nfs_loopback` (the probe mounts that export's
path). An unknown id is `NOT_FOUND`; a filesystem that is not observed
mounted is `PRECONDITION_FAILED` (`not_mounted`).

```jsonc
{
  "probe": "fs_io", "target": "fs-data", "run_id": "…" | null,
  "started_at": "…Z", "completed_at": "…Z", "ok": true,
  "operation": { "kind": "write_read_unlink", "bytes": 4096, "fsync": true, "path": "<mountpoint>/.xinas-health/probe-<run>-<rand>" },
  "error": null | { "code": "…", "message": "…", "stage": "open" | "write" | "fsync" | "read" | "unlink" | "mount" | "readdir" | "umount" },
  "cleanup": { "status": "clean" | "failed", "detail": "…" | null },     // failed is a finding, never swallowed (PROBE-03)
  "proves": "a 4 KiB write, fsync, read-back and unlink succeeded on this mountpoint from the node itself; not client connectivity, not RDMA, not durability beyond fsync"   // PROBE-04, fixed text per probe kind
}
```

### 9.3 Hardened probe host (D-08, PROBE-03)

`agent/health/probe-host.ts` is rewritten; the old fixed-name paths are
removed, not kept as a fallback.

**`fs_io`**

1. Resolve the mountpoint from the observed row; `open(mountpoint,
   O_DIRECTORY | O_NOFOLLOW)`; `fstat` and record `st_dev`.
2. `mkdirat(dirfd, '.xinas-health', 0700)` unless it exists;
   `openat(dirfd, '.xinas-health', O_DIRECTORY | O_NOFOLLOW)`; `fstat`
   MUST report the same `st_dev` and a directory owned by root, else
   `PRECONDITION_FAILED` (`probe_dir_untrusted`) — a symlink or a
   foreign mount under that name never receives the probe.
3. `openat(probedirfd, 'probe-<run_id|none>-<16 hex random>',
   O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600)`; `EEXIST` retries the
   random part twice, then fails.
4. Write 4 KiB (`PROBE_PAYLOAD` repeated), `fsync`, close; open the same
   name with `O_RDONLY | O_NOFOLLOW` and compare; `unlinkat`.
5. Every step is bounded by `timeout_s` (default 20 s); on expiry the
   step's promise is abandoned, `unlinkat` is still attempted, and the
   result is `error: TIMEOUT` with `cleanup` reflecting what the unlink
   returned.
6. Only the file this run created is ever unlinked; the directory is
   left in place.

**`nfs_loopback`**

1. `flock` on `/run/xinas/health-probe/.lock` (non-blocking); a held
   lock is `CONFLICT` (`PROBE_IN_PROGRESS`) — loopback probes are
   serialized per node.
2. Mountpoint `/run/xinas/health-probe/<run_id|none>-<random>/mnt`,
   created 0700; `systemd-mount --collect localhost:<export> <mnt>`
   bounded by `timeout_s`; `readdir`; `systemd-umount <mnt>`; the
   directory is removed after a successful umount.
3. A failed umount leaves the directory, reports `cleanup.status:
   failed` with the unit name, and the next probe uses a new directory —
   nothing is ever retried onto a busy mountpoint.
4. The agent kills the `systemd-mount` subprocess at `timeout_s`; the
   api's own timeout is `timeout_s + 5 s` so the agent, not the api wait,
   is what stops the work.

The same host serves the legacy `health.check profile=deep` path (§9.4).

### 9.4 The legacy deep path

`health.check profile=deep` keeps the #387 escalation and its
`filesystem.io` / `nfs.loopback` checks, now executed through the
hardened host with `run_id: none`. Its `tools/list` description gains
"prefer `health.probe.run` for a single confirmed probe" and the
`api-v1.yaml` description says the same; the parameter is not removed
(oasdiff, REST compatibility). Under `probe_policy: observe_only` the
prompt text already forbids it.

### 9.5 Limits xiNAS enforces (CFG-05, D-10)

- `active_probes_per_node` (default 1): one probe in flight per agent,
  any kind; a second concurrent request is `CONFLICT`
  (`PROBE_IN_PROGRESS`).
- `probes_per_run` (default 4): counted in the run ledger per `run_id`;
  exceeded → `PRECONDITION_FAILED` (`probe_budget_exhausted`).
- Everything else in `limits` (analysis time, tool calls, roles,
  retries) is recorded and reported, not enforced: xiNAS cannot see the
  host's tool-call loop.

## 10. Check catalog

### 10.1 Data and route

`xiNAS-MCP/src/lib/health/agentic-catalog.json` (version `"1"`), served
verbatim by `read('health.catalog', 'GET', '/health/catalog', …)`,
viewer rank. Each row:

```jsonc
{
  "id": "HC-03.arrays", "version": 1, "area": "HC-03", "goal": "…",
  "applicability": { "requires": ["arrays"] },                       // keys of health.context.topology; absent component → not_applicable
  "mandatory_for": ["node", "service_path"],
  "expected_source": ["local_override", "desired", "vendor"],       // CFG-02 order
  "inputs": [ { "source": "mcp:health.check", "check_id": "xiraid.arrays", "freshness": "per_call" },
              { "source": "baseline", "section": "storage", "check": "raid_status", "freshness": "per_call" },
              { "source": "read:arrays.list", "freshness": "observed_at" } ],
  "procedure": "…", "criterion": "…",
  "outcome_map": { "mcp:ok": "pass", "mcp:warning": "warn", "mcp:degraded": "fail", "mcp:critical": "fail",
                   "baseline:PASS": "pass", "baseline:WARN": "warn", "baseline:FAIL": "fail", "baseline:SKIP": "unknown" },
  "severity_map": { "mcp:degraded": "degraded", "mcp:critical": "critical", "baseline:FAIL": "critical", "baseline:WARN": "warning", "mcp:warning": "warning" },
  "side_effects": "none", "cost": { "timeout_s": 5 },
  "next_check": "…",
  "no_source": false                                                  // true = listed for honesty, no producer today (HC-04 wear over MCP)
}
```

### 10.2 First-release rows (CHECK-01)

| Area | Rows and their sources today | Coverage note |
|---|---|---|
| HC-01 trustworthiness | `agent.connectivity`, `agent.collectors` (mcp); `health.context.collectors`, `freshness` | complete |
| HC-02 baseline / drift | `drift.nfs-exports`, `drift.netplan`, `drift.nfs-conf` (mcp); every baseline section vs `expectations`; `config_history.diff` for "changed since snapshot" | complete; provenance from `expected_source` |
| HC-03 RAID | `xiraid.arrays`, `xiraid.license`, `xiraid.service` (mcp); baseline `storage.raid_status`, `raid_devices`; `arrays.get` progress; S17 `xinas://events/raid/progress` for a second time point | "stalled" needs two points (AC-09): the row's procedure says to read the progress feed, and reports `unknown` with one sample |
| HC-04 drives / PCIe | baseline `nvme_health.*`, `network.pcie_link`; `disks.list` | `mcp:disk.health` row is `no_source: true` (F-06) until a collector exists |
| HC-05 filesystem | `filesystem.mounts` (mcp); baseline `filesystem.*`; `filesystems.get`, `quotas.list`; write availability only via HC-12 | complete for reads |
| HC-06 NFS server | `nfs.server`, `nfs.exports` (mcp); baseline `nfs.*`; `nfs_sessions.list`, `nfs_profiles.get`; `system.logs` for RPC errors | "service active", "export declared", "client works" are three separate rows |
| HC-07 network / RDMA | `network.duplicate-netplan`, `network.rdma-readiness`, `network.rdma-live` (mcp); baseline `network.*`, `rdma.*`; `network.interfaces.list` | end-to-end MTU and switch path: `no_source` rows |
| HC-08 host / services | `systemd.units`, `tuning.sysctl` (mcp); baseline `services`, `cpu`, `kernel`, `vm`, `perf_tuning`; `system.logs` | complete |
| HC-09 performance | `system.performance` (exporter text), `system.metrics` | single-sample rows; trend rows say `unknown` unless the client supplies two samples within the window (AC-09) |
| HC-10 causes of change | `audit.query`, `config_history.snapshots/diff`, `tasks.list`, S17 feeds | correlation rows produce `hypothesis` findings only (AC-10) |
| HC-11 client path | — | one row, `no_source: true`, `mandatory_for: ["service_path"]` → `service_path` coverage is `partial` in v1 |
| HC-12 active probe | `health.probe.run` (`fs_io`, `nfs_loopback`) | applies only when `permitted.probe_run !== 'denied'` and the effective policy is `bounded_active` |

CHECK-02/03 are catalog data: `expected_source` order and the vendor
citations live in each row's `procedure`/`criterion` text and are
validated by the T5 test to point at documented profile keys, not at
loose numbers.

## 11. Report contract and validator

### 11.1 Schema

`xiNAS-MCP/src/lib/health/agentic-report.schema.json` (JSON Schema
2020-12, `report_schema_version` `"1"`), served by
`read('health.report_schema', 'GET', '/health/report-schema', …)`. Top
level (REPORT-01, REPORT-06):

```jsonc
{
  "report_schema_version": "1",
  "run": { "run_id", "started_at", "completed_at", "principal", "node": { "hostname", "controller_id", "xinas_version" },
           "versions": { "prompt", "template_sha256", "policy", "catalog", "report_schema" },
           "execution": { "mode": "sequential" | "subagents", "roles_ran": [ … ], "model": { "provider", "name" } | null,
                          "budget": { "tool_calls", "elapsed_seconds" }, "errors": [ … ] } },
  "scope": { "kind": "node" | "service_path", "targets": [ … ], "client_path_in_scope": false, "time_window": { "requested_seconds", "covered": { "from", "to" } } },
  "run_status": "completed" | "partial" | "failed" | "cancelled",
  "health_status": "ok" | "warning" | "degraded" | "critical" | "unknown",   // MUST equal the validator's computed value
  "coverage_status": "complete" | "partial" | "none",                          // same
  "raw_reports": [ { "tool", "args", "collected_at", "digest", "report" } ],  // verbatim, statuses untouched
  "checks": [ { "id", "outcome": "pass" | "warn" | "fail" | "unknown" | "not_applicable", "severity": "warning" | "degraded" | "critical" | null,
                "reason", "mandatory": true, "evidence_refs": [ … ] } ],
  "findings": [ { "id", "kind": "observation" | "hypothesis" | "data_gap" | "conflict", "severity", "check_ids", "resource_ids",
                  "symptom", "impact", "evidence_refs", "confidence": { "level": "high" | "medium" | "low", "basis" },
                  "alternatives", "next_check", "proposed_action" } ],
  "evidence_manifest": [ { "id", "source", "args", "request_id", "observed_at", "collected_at", "revision", "units", "value", "excerpt", "stale": false } ],
  "not_checked": [ { "check_id", "reason" } ],
  "human_readable": "…"                                                       // REPORT-05 order is a prompt rule, checked by fixtures
}
```

### 11.2 `health.report.validate`

`{ name: 'health.report.validate', method: 'POST', path:
'/health/report/validate', mutability: 'direct', requires_mcp_apply:
false, min_role: 'viewer' }` — a pure computation with no side effects,
like `support.bundle` it is `direct` because it is a POST. Body: the
report. Response:

```jsonc
{
  "valid": false,
  "schema_errors": [ { "path": "/checks/3/outcome", "message": "…" } ],
  "reference_errors": [ { "path": "/findings/0/evidence_refs/1", "ref": "ev-17", "message": "unknown evidence id" } ],
  "integrity": { "status": "verified" | "mismatch" | "unverifiable", "mismatches": [ { "raw_report_index": 1, "expected_digest": "…", "actual_digest": "…" } ] },
  "computed": { "health_status": "degraded", "coverage_status": "partial" },
  "status_errors": [ "health_status 'ok' does not match computed 'degraded'" ]
}
```

`valid` is true iff there are no schema, reference or status errors and
`integrity.status !== 'mismatch'`. `unverifiable` (unknown or expired
`run_id`) does not invalidate — it is reported (SAFE-04, AC-18).

### 11.3 Deterministic verdict (REPORT-03, D-12)

Over `checks[]`, mandatory rows for the declared scope (from the
catalog, not from the report's own `mandatory` flag, which must agree):

1. `coverage_status`: `complete` iff every mandatory row has outcome in
   `{pass, warn, fail, not_applicable}`; `none` iff no mandatory row
   does; else `partial`.
2. `health_status`: `critical` if any `fail` with severity `critical`;
   else `degraded` if any `fail`; else `warning` if any `warn`; else `ok`
   iff `coverage_status === 'complete'`; else `unknown`.
3. A `not_applicable` outcome MUST cite a `declared_absent` component or
   a scope exclusion in `reason`; otherwise it is rewritten to `unknown`
   before step 1 (REPORT-02).
4. `run_status` `failed` or `cancelled` cannot coexist with
   `health_status: ok` (the client must have completed the mandatory
   set): a status error.

### 11.4 Integrity (AC-19)

For every `raw_reports[i]` with a `run_id` known to the ledger (§6.3):
`digest` MUST equal the ledger's digest for that `tool` and `args`
digest; `report` re-hashed MUST equal `digest`. A model that edits a raw
FAIL, or invents a report, produces `mismatch`. Reports from tools that
do not write the ledger (`arrays.list`, `system.logs`, …) are
`unverifiable` individually and do not affect `valid`.

### 11.5 Storage

xiNAS stores nothing (DATA-06): the client keeps the report and the
manifest. The validator's audit row records `run_id`, `valid`, the two
computed statuses and the report's sha256 — enough to prove later what
was validated without keeping the text.

## 12. Configuration

### 12.1 `mcp.health_prompt` (api `config.json`)

| Key | Default | Validation | Effect |
|---|---|---|---|
| `enabled` | `true` | boolean | installs the prompt provider; `false` → `prompts` capability absent, both methods `-32601`, `health.context` still served (the tools are independent of the prompt, ARCH-02) |
| `template_path` | unset | readable file, UTF-8, ≤ 64 KiB, no NUL, must contain the marker line `## Prompt body` | replaces the body; `template_sha256` reflects it; the constant's `prompt_version` gains `+local` |
| `policy_version` | `"1"` | `^[A-Za-z0-9.+-]{1,32}$` | echoed |
| `probe_policy_max` | `observe_only` | enum | caps the effective `probe_policy` (§5.3); does **not** grant anything — the gate matrix (§9.1) still applies |
| `limits.analysis_seconds` | 180 | 30–3600 | recorded |
| `limits.tool_calls` | 40 | 5–500 | recorded |
| `limits.roles` | 3 | 1–8 | recorded |
| `limits.active_probes_per_node` | 1 | 1 | enforced (§9.5) |
| `limits.probes_per_run` | 4 | 0–16 | enforced (§9.5); 0 disables probes for prompt runs |
| `limits.retries` | 2 | 0–5 | recorded |
| `limits.run_ttl_seconds` | 900 | 300–7200 | ledger and `run.expires_at` |
| `baseline.profiles_dir` | `/opt/xiNAS/healthcheck_profiles` | absolute path | §8.2 |
| `baseline.timeout_s.{quick,standard,deep}` | 60 / 180 / 300 | 10–900 | §8.3 |

Startup validation follows `config.ts` conventions: a bad value is fatal
with the key named. CFG-04 by construction: none of these keys can lower
a `min_role`, bypass `mcp.allow_apply`, skip confirmation, or change the
validator's algorithm; `template_path` changes text only.

### 12.2 `health_baseline` (agent config)

| Key | Default |
|---|---|
| `python` | `/opt/xiNAS/venv/bin/python3` |
| `module_root` | `/opt/xiNAS` |
| `log_dir` | `/var/log/xinas/healthcheck` (passed to the engine, unused with `--no-save`) |
| `profiles_dir` | `/opt/xiNAS/healthcheck_profiles` (the realpath allow-list, §8.3) |

### 12.3 Deferred (CFG-03)

Diff, author, revision and rollback for overrides are not built in v1;
`config.json` edits are operator actions outside the control path. The
TUI MCP Server screen (S8 §6c) may later gain toggles for `enabled` and
`probe_policy_max`; recorded in `docs/TODO.md` when S19b lands.

## 13. Authorization, safety, audit

| Entry | Method / path | Mutability | Rank | MCP gate | Confirmation |
|---|---|---|---|---|---|
| `health.context` | `GET /health/context` | read | viewer | allow | — |
| `health.catalog` | `GET /health/catalog` | read | viewer | allow | — |
| `health.report_schema` | `GET /health/report-schema` | read | viewer | allow | — |
| `health.baseline` | `GET /health/baseline` | read | viewer | allow | — |
| `health.report.validate` | `POST /health/report/validate` | direct | viewer | allow (`requires_mcp_apply: false`) | — |
| `health.probe.run` | `POST /health/probe` | direct | operator | `mcp.allow_apply` | S15 (modern) |
| `health.check` (existing) | `GET /health` | read | viewer; `profile=deep` escalates to operator | escalated: `mcp.allow_apply` | — |

- **SAFE-01** Log lines, resource names, events and the `symptom` text
  reach the model as data; the server never interpolates them into the
  instruction part of the prompt (§5.4). No S19 tool accepts a command,
  a path outside the allow-lists, or a report destination.
- **SAFE-02** `health.context` and `health.baseline` carry no license
  material (the parsed struct only, as `health.probe` already does), no
  user file contents and no bundle; `system.logs` stays bounded by
  `MAX_LOG_LINES`.
- **SAFE-03** No S19 tool mutates node state beyond the probe artifacts
  it removes; remediation stays plan/apply with confirmation.
- **SAFE-04** Every S19 read answers when the agent is down, with the
  collection status saying so; a probe timeout is enforced on the agent
  (§9.3). Duplicate baseline runs are merged (§8.3).
- **Audit** One row per call as for every catalog entry; S19 rows add
  `run_id` when supplied. `prompts/get` audits arguments minus the
  symptom text (§5.7).

## 14. REST projection and `api-v1.yaml`

Additive only (oasdiff must stay green):

- New paths `/health/context`, `/health/catalog`,
  `/health/report-schema`, `/health/baseline`, `/health/probe`,
  `/health/report/validate` with the schemas above.
- `HealthReport` gains optional `coverage_status` and `collection`;
  `HealthCheck.evidence` is unchanged (already free-form) — the
  `collection` object inside it is documented in the description.
- `/health` description: the deep-path deprecation sentence (§9.4).
- New error codes in the `details.code` vocabulary:
  `PROBE_IN_PROGRESS`, `probe_budget_exhausted`, `probe_dir_untrusted`,
  `not_mounted`, `RUN_UNKNOWN` (warning).

`xinasctl` gains the generated commands (`health context`, `health
baseline --profile`, `health probe run --probe --target`, `health report
validate --file`) from the catalog without CLI code.

## 15. Tests

| Layer | What is pinned |
|---|---|
| Unit — `prompts.test.ts` | argument table of §5.3 (every row accepted, every violation `-32602` with `data.argument`); the parameters block is valid JSON; the symptom is only inside `<user_symptom>`; the runtime constant equals the docs template body; `prompt_version`/sha256 stability |
| Unit — `discover` | `prompts` present iff the provider is installed, `{ listChanged: false }`; absent with `enabled: false` (AC-12, AC-16) |
| Unit — `standard.ts` | every `CollectionStatus` maps per §7.2; `not_supported` is the only `skipped`; `success` + empty keeps the old symptom with `collection.status: success` (AC-03) |
| Unit — `routes-health` | `coverage_status` and `collection` per §7.3; a v1-shaped probe result maps to `LEGACY_AGENT`; `overall` semantics unchanged (REPORT-01) |
| Unit — `probe-host` (fake fs via the existing file-backed fakes plus a real `tmpdir` case) | unique names, `EEXIST` retry, symlinked `.xinas-health` refused, foreign-device refused, cleanup failure surfaced, timeout stops the step, two concurrent loopbacks → one `PROBE_IN_PROGRESS` (AC-15) |
| Unit — `health-baseline` (agent) | command line, env sanitization, realpath allow-list, `--sections` parsing, SIGKILL at timeout, concurrent callers share one run, stdout cap |
| Unit — `report-validate` | the verdict table of §11.3 on fixtures (AC-01, AC-02, AC-19 edited FAIL → `mismatch`), reference errors, `unverifiable` on unknown run |
| Contract — `mcp-schema.test.ts` | `prompts/list` and `prompts/get` responses validate against the pinned `2026-07-28` schema on the modern era; legacy shapes against the SDK zod schemas; both through HTTP and the stdio adapter (AC-16) |
| Integration — `rbac.test.ts`, `mcp-dispatch.test.ts`, `mcp-integration.test.ts` | the §13 matrix per entry; viewer `health.probe.run` denied on REST and MCP; operator with `allow_apply` on a legacy client → `MCP_CONFIRMATION_UNSUPPORTED`; modern → confirmation flow, consumed once (AC-14) |
| e2e — `health-support.test.ts` extension | deep through the hardened host: artifact names differ per call, none left behind; `health.baseline` against a fixture engine (`python3` stub printing a canned report) with `not_supported` for a missing interpreter; `health.context` while the agent is stopped answers with `heartbeat: offline` (AC-18) |
| Fixtures — `src/__tests__/fixtures/agentic/` | the anonymized incident set of requirements §10 (one directory per AC with the raw reports, the expected outcomes and the forbidden calls); a fixture runner asserts validator results, not prompt text |
| Python — `tests/test_health_engine_sections.py` | `kerberos` enabled → a SKIP `checker` row; `--sections` prints the map |

## 16. Acceptance criteria coverage

| AC | Where |
|---|---|
| AC-01 | §11.3 step 2 (a `fail` outranks everything), fixture `ac01` |
| AC-02 | §7.3 (`coverage_status: partial`), §11.3 step 1 |
| AC-03 | §7.1/§7.2 status enum and mapping |
| AC-04 | §6.2 `declared_absent` derivation, §11.3 step 3 |
| AC-05 | §8 (baseline profiles) vs §9 (probes) are different tools; the prompt forbids deep under observe_only; `health.context.permitted` lists `deep` only when reachable |
| AC-06 | §8.5 |
| AC-07 | §10 `expected_source` order; overrides live in `config.json` (survive updates) — provenance in `evidence_manifest.source` |
| AC-08 | §9.2 `proves` text; HC-11 `no_source` row keeps `service_path` partial |
| AC-09 | HC-03/HC-09 rows in §10.2 |
| AC-10 | HC-10 rows produce `hypothesis` findings; the schema requires `alternatives` and `next_check` on a hypothesis |
| AC-11 | schema `findings.kind: conflict`; `run.execution.roles_ran`; the validator never drops findings |
| AC-12 | §4 (capability iff installed), §5.1 (`-32601` without a provider), prompt text §3 (sequential roles) |
| AC-13 | §5.3/§5.4 (symptom as data), §13 SAFE-01; fixture `ac13` asserts no `health.probe.run`/apply call in the tool log |
| AC-14 | §9.1 gate matrix on REST, MCP and the legacy deep path |
| AC-15 | §9.3, unit rows in §15 |
| AC-16 | §4, §5.6, §4.4, contract tests |
| AC-17 | §5.5 (ledger keeps the run's versions), §6.3 |
| AC-18 | §8.4 cache + §11.2 `unverifiable`; the prompt's stop rule |
| AC-19 | §11.4 |
| AC-20 | §11.5 (nothing overwritten server-side); a new run gets a new `run_id` and fresh digests |

## 17. Deferred (to `docs/TODO.md` when each slice lands)

- HC-11 client-path adapter (`service_path` stays partial).
- Server-side report history.
- CFG-03 override management with diff/author/revision/rollback; TUI
  toggles.
- `prompts` `listChanged` + hot reload; MRTR elicitation of missing
  arguments; `completion/complete`.
- A periodic collector for `Disk.status.health` so the MCP `disk.health`
  row stops being `no_source` (already tracked under the S17 families).
- Two-sample trend rows for HC-03/HC-09 computed server-side (v1 relies
  on the client taking the second sample).

## 18. Open points for validation

Defaults chosen here; say which to change.

- **O-1** `health.probe.run` is operator rank (not admin), matching the
  #387 escalation.
- **O-2** Over MCP the probe requires an S15 human confirmation (first
  use of `confirmation: 'required'`, extending the service to bind
  `{ tool, args }` instead of a plan). Alternative: role +
  `mcp.allow_apply` only, as #387 does for deep.
- **O-3** `health.baseline` is synchronous with per-profile caps
  (60/180/300 s) and an in-memory freshness cache. Alternative: a task
  (`returns_async_task`) followed with `tasks.wait`.
- **O-4** The run ledger is in-memory with a 15-minute TTL; an api
  restart makes integrity `unverifiable`, never `invalid`.
- **O-5** `prompts/get` returns one `user` message with the parameters
  as a delimited JSON block; no second message, no `_meta`.
- **O-6** `prompts/list` uses `ttlMs: 0` / `cacheScope: private` like
  every other list result; a longer TTL would be schema-valid.
- **O-7** `health.context` is viewer rank although it lists the
  principal's own permissions and the topology (all of which the
  viewer's reads already expose).
- **O-8** `health.check profile=deep` stays, deprecated in text, rather
  than being removed from the enum.
