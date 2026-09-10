# ADR-0018: MCP prompts and the agentic health check (S19)

**Status:** accepted — **S19a–S19d implemented 2026-09-09** (the prompt
on both eras, `health.context`, the run ledger, the check catalog,
`health.probe.run`, the typed collection status, the `health.baseline`
adapter over the sandboxed Python engine, the report schema,
`health.report.validate`, and the acceptance fixtures with their runner —
the spec's inline "Implemented" notes record where the code deviates
from this design). The manual model/host prompt gate of requirements §10
is a release procedure in `hardware-smoke-runbook.md`, not a code
artifact. Extends ADR-0009 (health profiles and
the `health.probe` RPC), ADR-0010 (the MCP transport and its deferrals),
ADR-0002 (one new enumerated agent method, `health.baseline`, and one
renamed probe method) and the S15 confirmation decision.

## Context

The S19 requirements (`../s19-mcp-health-prompt-requirements.md`, the
translated 2026-09-09 draft) ask for a diagnostic mode in which a
connected AI client runs a server-provided prompt, `xinas_health_check`,
against a node. The client owns the model, its agents and its budget;
xiNAS must own the evidence, the permissions and the verdict.

Facts that shape the decision (requirements §2, §13; re-verified on
`origin/release/3.14` at `f9624a1c`):

- ADR-0010 deferred MCP prompts; S17 and S18 lifted the resources
  deferral. No prompt handler exists on either protocol era, and
  discovery truthfully omits the capability (S14 §4).
- MCP `2026-07-28` deprecates Sampling. A server that wanted to run the
  model itself would have to adopt a deprecated feature or embed an LLM
  client; neither belongs in `xinas-api`.
- The `health.probe` RPC collapses failures into `null` / `[]` / `{}`,
  and the api turns those into `skipped` checks that read like absent
  components; an all-skipped report is `ok` (G-01, G-02). A prompt cannot
  fix a data contract.
- `health.check profile=deep` performs a file write on every managed
  filesystem and a PID1 loopback mount. PR #387 made that value
  operator-rank and `mcp.allow_apply`-gated through a catalog
  `escalation`; the probe artifacts themselves are still a fixed name
  written without exclusive create at a fixed mountpoint (G-04
  remainder).
- The Python engine under `xinas_menu/health/` is a second health
  engine with different profiles, thresholds and coverage; it prints
  JSON with `--json`, writes nothing with `--no-save`, needs root, and
  silently drops an enabled YAML section without a checker (G-03).
- The MCP `disk.health` check reads a block no probe writes; on a real
  node it is always `skipped` (requirements §13).

## Decision

### 1. Lift the prompts deferral for one user-controlled prompt

One `PromptProvider` seam serves `prompts/list` and `prompts/get` on
the modern era (`server/discover`, stateless) and the legacy era (the SDK
`Server` handlers), the way S17/S18 resources are served. The `prompts`
capability is advertised as `{ listChanged: false }` iff the provider is
installed, on both eras. Exactly one prompt exists, `xinas_health_check`;
its eight optional arguments are strings validated by shape only, an
unknown name or argument is `-32602`, and `prompts/get` reads no live
state and mints nothing. The prompt is a `user` text message the client
chooses to use (MCP "user-controlled"); it is never a system prompt and
never a grant of authority. The list is fixed for the process lifetime.

### 2. The server is the evidence and policy authority, not the orchestrator

xiNAS does not run the model, does not spawn agents and does not use
MCP Sampling. It supplies: the prompt; a run context that mints a
`run_id`, states the principal's actual permissions, the topology with
revisions and observation times, the declared-absent components and the
limits; the deterministic reports; the check catalog; the report schema;
and a validator. Budgets the host enforces (analysis time, tool calls,
roles) are recorded and reported, not enforced; the two probe counters
xiNAS can see are enforced.

### 3. Collection status is a typed contract

The `health.probe` result carries, per section, one of `success`,
`error`, `timeout`, `permission_denied`, `not_supported` with its own
`observed_at`. Only `not_supported` (the tool is not installed) may
become a `skipped` check; the other failures become `degraded` checks
with the collection status in their evidence, so they pull `overall`
down instead of vanishing. `HealthReport.overall` keeps its meaning;
`coverage_status` and `collection` are added. A successfully obtained
empty list stays distinguishable from a failed query.

### 4. Active probes are a separate, confirmable tool

`health.probe.run` (`fs_io` on a filesystem, `nfs_loopback` on a share)
is a `direct` catalog entry: operator rank, `requires_mcp_apply`, and the
first user of S15's `confirmation: 'required'` hook — the confirmation
service binds `{ tool, args }` with `risk: non_disruptive`, no
acknowledgement phrase, the usual TTL and single consumption. That
record is the "permission granted beforehand for a scope, usable until
it expires" the requirements ask for; the `probe_policy` prompt argument
is a request the server caps, never a grant. The probe host is rewritten
so every artifact is per run: unique names under a root-owned
`.xinas-health` directory opened with `O_NOFOLLOW` and checked to be on
the same device, `O_CREAT|O_EXCL` files, a per-run loopback mountpoint
serialized by a lock, cleanup failure reported as a finding, and a
timeout enforced on the agent. `health.check profile=deep` keeps the
escalation from PR #387, runs through the same host, and is marked
deprecated in favour of the new tool; its enum value is not removed.
The `fs_io` write runs in a PID1 transient unit with
`ReadWritePaths=<mountpoint>` because the agent's own
`ProtectSystem=strict` namespace mounts every pre-existing filesystem
read-only (2026-09-10 amendment, validation B01); the agent's unit file
is unchanged.

### 5. The Python engine is reached through a read-only agent subprocess

A new enumerated agent method `health.baseline { profile_path,
timeout_s }` runs `python3 -m xinas_menu.health <profile> <log_dir>
--json --no-save` from the TUI's venv, with the profile path
realpath-checked against the profiles directory, a sanitized
environment, captured and capped output, its own process group and
`SIGKILL` at the cap (60/180/300 s for quick/standard/deep). The api
exposes it as the viewer-rank read `health.baseline`, caches the last
successful report per profile in memory with its `collected_at`, and
returns it only when the caller's `max_age_s` allows. The engine gains
a visible `SKIP` row for an enabled section without a checker and a
`--sections` listing, so unsupported coverage is reported, not lost.

### 6. The verdict is computed by xiNAS code; the report is stored by the client

`health.report.validate` validates a report against the shipped JSON
schema, checks every evidence reference, recomputes `health_status` and
`coverage_status` by a fixed algorithm (a confirmed problem outranks
missing data; `ok` requires complete coverage), and compares each raw
report's digest with the digest the api recorded in the run ledger when
it handed that report out. A model that edits a raw `FAIL` or invents a
report gets `integrity: mismatch`; an api restart makes a run
`unverifiable`, never `invalid`. xiNAS stores no agentic report.

### 7. The check catalog is versioned data

`agentic-catalog.json` lists the first-release rows (HC-01..HC-12) with
their real sources, outcome and severity maps, applicability, freshness
policy and side effects. A row with no producer today (`disk.health`
wear over MCP, end-to-end MTU, the client path) says `no_source: true`
so `service_path` coverage is honestly partial and nothing is claimed
measured that is not.

### 8. Configuration cannot loosen enforcement

`mcp.health_prompt` (api) and `health_baseline` (agent) hold the
template override, the policy cap, the limits and the paths. None of
them can lower a rank, bypass `mcp.allow_apply` or confirmation, or
change the validator. Override management with diff and rollback is
deferred.

## Alternatives considered

- **Extend `instructions` instead of adding prompts.** Rejected:
  instructions are always-on guidance for every session; a diagnostic
  run needs user selection, arguments, versions and a parameters block
  (requirements MCP-01..03).
- **An orchestrator inside xiNAS using MCP Sampling.** Rejected:
  Sampling is deprecated in `2026-07-28`, and `xinas-api` would have to
  hold model credentials and budgets it has no business owning
  (ARCH-04).
- **Make `deep` a plan/apply operation.** Rejected: there is no plan
  document and no state transition; #387's escalation plus a dedicated
  confirmable probe tool covers the permission without inventing a
  plan.
- **Role and `mcp.allow_apply` only for `health.probe.run`.** Kept as
  the documented alternative (spec O-2): simpler, but it is a standing
  grant rather than the scoped, expiring permission PROBE-02 describes.
- **Run the baseline as a task envelope.** Kept as an alternative (spec
  O-3): more machinery for a run that, capped, fits inside one call and
  is cached for reuse.
- **Store agentic reports server-side.** Deferred: the requirements
  make the client the store, and model output must never enter observed
  state.

## Consequences

- ADR-0010's prompts deferral is lifted for one prompt; general-purpose
  prompt hosting remains out of scope.
- S14's capability table gains a `prompts` row whose truthfulness is
  pinned by the discovery test on both eras.
- ADR-0002's enumerated method set gains `health.baseline` and
  `health.probe.run`; the probe host loses its fixed-name paths.
- The agent delegates the `fs_io` probe to `systemd-run`;
  `dist/agent/health/fsio-child.js` is a second entry point built by the
  same `tsc` run.
- S15's confirmation service learns a second binding kind (`{ tool,
  args }`) for confirmable direct entries.
- Every code slice is TypeScript under `xiNAS-MCP/src/` plus a Python
  change under `xinas_menu/health/`, so each carries
  `Requires-Rebuild: xinas_node_build`; the Python part is code-only.
- The `docs/TODO.md` entry "Health — the deep-profile probe artifacts
  are not hardened" closes with S19a; new entries record the §17
  deferrals as each slice lands.

## Deferred

HC-11 client-path adapter; server-side report history; override
management (CFG-03); `listChanged` and hot reload; MRTR elicitation of
prompt arguments; argument completion; a `Disk.status.health` collector.
