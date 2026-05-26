# Phase 0 Sequencing — calendar-weighted milestones, role dependency map, rollback story

- **Status:** Living document (updated as workstreams complete)
- **Created:** 2026-05-26
- **Owner:** xiNAS Engineering
- **Related:** [phase0-requirements.md](phase0-requirements.md), the ADRs under `adr/`, [api-v1.yaml](api-v1.yaml), and the historical plan at [docs/plans/2026-05-26-phase0-control-path-plan.md](../plans/2026-05-26-phase0-control-path-plan.md)

The original plan (in `docs/plans/`) is an append-only artifact of intent
on the date it landed. This document is the **live** sequencing reference
for Phase 0 work — calendar weights, role dependencies, and rollback
behavior of the Control Path itself.

## 1. Calendar-weighted milestones

The original plan's seven milestones imply roughly equal weight. Reality is
heavily front-loaded. The table below assigns weights as a fraction of
total Phase 0 effort, so resource allocation reflects how the work actually
distributes.

| Milestone                                         | Weight | Notes                                                                                              |
|---------------------------------------------------|--------|----------------------------------------------------------------------------------------------------|
| M1 — Foundation skeleton                          | ~22%   | Largest single chunk. OpenAPI v1, state store impl, agent skeleton, task model skeleton, CI bootstrap, hardened systemd units, MCP→core extraction (per ADR-0001 migration scope). |
| M2 — Import & observe existing xiNAS state        | ~12%   | Read-path completeness. Mostly observation adapters + drift wiring through KV store. Needs M1 done. |
| M3 — Durable tasks & plan/apply                   | ~16%   | Task engine (ADR-0004) including stage logs, leases, idempotency, cancellation, startup reconciliation (ADR-0002 envelope). |
| M4 — NFS & network day-2 operations               | ~14%   | Smallest milestone in pure code, but blocked by all of M1+M2+M3. Highest end-user visibility per unit work. |
| M5 — Storage & filesystem operations              | ~14%   | Dependency-guard heavy. Storage operations also require the dangerous-flag gate (reqs §14) which lands here. |
| M6 — UI / CLI / MCP convergence                   | ~12%   | TUI migration off direct gRPC; `xinasctl` MVP; MCP transport-gate enforcement; client consistency tests. |
| M7 — Hardening, upgrade, RC                       | ~10%   | Upgrade path (most engineering), support bundle polish, RBAC enforcement audit, docs. |

The total is intentionally 100% — these are share-of-effort, not
calendar weeks. Apply to whatever calendar the team commits to in
planning.

### Sequencing observations

- **M1 alone is roughly the size of M4 + M5 combined.** Treat it as a
  full quarter, not a sprint.
- **M2 cannot complete without M1's state store and agent observation
  methods.** Sequence as M1 → M2, not parallel.
- **M3 can begin once M1 ships the state store and agent RPC envelope.**
  M2 and M3 can overlap in calendar terms because they touch different
  layers (M2: observation adapters; M3: task engine + plan/apply).
- **M4 is the first milestone that produces a user-visible day-2
  feature.** Communicate that the "no visible progress" period covers
  most of M1.

## 2. Role dependency map

The Ansible inventory has 17 roles today under
[collection/roles/](../../collection/roles/). Phase 0 adds two services
(`xinas-api`, `xinas-agent`); existing roles gain dependencies on those
services. The table below names the changes per role.

| Role                  | Changes for Phase 0                                                                                                                          |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `common`              | Adds `/etc/xinas-api/`, `/var/lib/xinas/state/`, `/var/log/xinas/audit.jsonl`, `/run/xinas/` directories with correct ownership.            |
| `doca_ofed`           | No change; runs before any Control Path service.                                                                                             |
| `xiraid_classic`      | No change to installation. Adds an `xinas-agent` dependency hook so the agent is restarted after a xiRAID upgrade.                          |
| `nvme_namespace`      | No change.                                                                                                                                   |
| `net_controllers`     | Continues to render `/etc/netplan/99-xinas.yaml`. After Phase 0, ownership of this file moves to `xinas-agent` during day-2 operations; `net_controllers` writes the initial baseline only. |
| `raid_fs`             | Initial RAID + XFS creation only. Day-2 ops move to API. Role publishes initial desired state into the KV store via a post-task action.     |
| `exports`             | Initial `/etc/exports` only. Day-2 export changes move to API → agent → `xinas-nfs-helper`. Role publishes baseline shares to desired state.|
| `nfs_server`          | Renders `/etc/nfs/nfsd.conf` and `/etc/default/nfs-kernel-server` per ADR-0005 schema. Publishes baseline `NfsProfile` to desired state.    |
| `perf_tuning`         | Continues to apply sysctl / cgroup tuning. Day-2 tuning out of Phase 0 scope.                                                                |
| `xiraid_exporter`     | Already runs as its own service. `xinas-api` consumes its metrics surface; no dependency reversal.                                           |
| `xinas_history`       | Continues writing under `/var/lib/xinas/config-history/`. Drift detection input pipe changes from direct file read to KV observed state.    |
| **`xinas_api` (NEW)** | Installs `xinas-api.service`, creates state directory, runs initial state import on first start, configures hardening directives.            |
| **`xinas_agent` (NEW)**| Installs `xinas-agent.service`, creates `/run/xinas/agent.sock`, sets root + hardened systemd config. Depends on `xinas_api`.               |
| `xinas_mcp`           | Renamed to a thin "transport configuration" role; the MCP transport now lives inside `xinas-api`. Migrates `/etc/xinas-mcp/config.json` → `/etc/xinas-api/config.json` with a symlink for one release. |
| `xinas_menu`          | TUI install only. The screens that today call gRPC directly are retargeted to the API — that's a code change, not a role change. The role gains a runtime dependency on `xinas-api.service` being healthy before launch. |
| (NFS helper)          | `xinas-nfs-helper` continues to ship. Socket permissions tighten so only `xinas-agent` may connect.                                          |

### Site.yml execution order change

The current order:

```
common → doca_ofed → net_controllers → xiraid_classic → nvme_namespace →
raid_fs → exports → nfs_server → perf_tuning
```

Phase 0 inserts Control Path services after the data plane is up but
before the TUI/MCP roles, so first-start state import sees real arrays
and filesystems:

```
common → doca_ofed → net_controllers → xiraid_classic → nvme_namespace →
raid_fs → exports → nfs_server → perf_tuning →
xinas_history → xinas_api → xinas_agent →
xinas_menu → xinas_mcp (transport configuration only)
```

`xinas_history` runs before `xinas_api` so its baseline snapshot exists
when the API starts and imports state. `xinas_api` runs before
`xinas_agent` because the agent depends on the API being up to report
observations. `xinas_menu` and `xinas_mcp` come last because they are
clients.

### `Requires-Rebuild:` trailer use

Per CLAUDE.md, commits that need an Ansible role to re-run on the host
add a `Requires-Rebuild:` trailer. Common cases in Phase 0:

| Commit touches…                                          | Trailer                                |
|----------------------------------------------------------|----------------------------------------|
| `xinas-api.service` unit, config defaults                | `Requires-Rebuild: xinas_api`          |
| `xinas-agent.service` unit, hardening directives         | `Requires-Rebuild: xinas_agent`        |
| Agent RPC method allow-list (Ansible-managed config)     | `Requires-Rebuild: xinas_agent`        |
| `nfs_server` role templates (per ADR-0005 file targets)  | `Requires-Rebuild: nfs_server`         |
| `net_controllers` baseline render                        | `Requires-Rebuild: net_controllers`    |
| MCP transport config rename                              | `Requires-Rebuild: xinas_api`          |
| Multi-role default overhaul                              | `Requires-Rebuild: all`                |

Code-only changes inside the TypeScript core or the Python TUI **do not**
add the trailer; the standard `git pull` + service restart that the
update flow does anyway is sufficient.

## 3. Control Path rollback / downgrade

The original plan covers data-path rollback (uninstall preserves arrays,
filesystems, shares). It does not cover what happens when a `xinas-api`
upgrade itself misbehaves — particularly when desired state has advanced
beyond the schema the older API understands.

Phase 0 commits to the following Control Path rollback contract.

### 3.1 Forward schema compatibility

Every release of `xinas-api` declares the **set of schema versions it
can read** and the **schema version it writes**:

```yaml
# /etc/xinas-api/version.yaml (managed; do not hand-edit)
write_schema: v1
read_schemas: [v1]
```

A `v1` API reading `v1` data is the normal case in Phase 0. The
machinery exists so that when a `v2` schema is introduced later, the
upgrade can be staged.

### 3.2 Downgrade refusal under schema drift

If a previous API version is reinstalled and finds data in the state
store at a `write_schema` newer than its own `read_schemas`, it
**refuses to start** rather than truncating or interpreting fields it
does not understand. Behavior:

1. The older `xinas-api` logs a structured error naming the offending
   schema version and the actions the operator must take.
2. The systemd unit fails (does not enter `active`); `xinas-agent`
   sees the API offline and goes into `executor-unavailable` mode.
3. The data path is unaffected: NFS clients, xiRAID, kernel mounts
   continue serving I/O.
4. The operator's options are: roll the API back forward to a
   compatible version, or run the **state export / reset** procedure
   below.

### 3.3 State export and reset (last-resort recovery)

For the rare case where the operator must abandon the current state
store (corruption, irreconcilable schema drift, lost passphrase), Phase
0 ships a documented procedure that:

1. Snapshots `/var/lib/xinas/state/xinas.db` and
   `/var/log/xinas/audit.jsonl` to a timestamped archive under
   `/var/lib/xinas/state/quarantine/`.
2. Stops `xinas-api.service` and `xinas-agent.service`.
3. Moves the database to the quarantine directory.
4. Restarts `xinas-api`; the API detects no state, treats the node as
   a fresh import target, runs the initial observation sweep, and
   regenerates desired state from the current system configuration —
   the same flow as the existing-node upgrade path (WS13.4).

The data path is untouched throughout. The cost is loss of task
history, audit history beyond what was archived, and any
operator-edited descriptive metadata that was not also present in
managed files.

### 3.4 Upgrade safety checks

The Control Path upgrade flow (via the TUI updater or Ansible) runs
these checks before swapping binaries:

- The current state-store DB is **backed up** to
  `/var/lib/xinas/state/backups/xinas.db.<ts>` before upgrade.
- The new API's `read_schemas` is compared against the current
  `write_schema`. Mismatch aborts the upgrade with a clear error.
- The audit JSONL's last entry hash is recorded before upgrade;
  post-upgrade, the API confirms the chain continues correctly. A
  mismatch fails the upgrade and rolls back the binary.

This is enforceable in Ansible by adding a pre-task and a post-task
to the `xinas_api` role; both gates can also be exposed as
`xinasctl upgrade-check` for use by the in-TUI updater.

## 4. Open items from the original critique

These five items remained open after the foundation ADRs landed. This
document closes some and tracks the rest.

| # | Item                                          | Status after this doc                                                                                  |
|---|-----------------------------------------------|--------------------------------------------------------------------------------------------------------|
| 4 | No CI exists                                  | **Still open.** Needs its own short workstream (TypeScript lint+test, Python lint+test, Ansible-lint, contract-test scaffold) before WS1's "contract tests run in CI" gate is meaningful. |
| 5 | Milestones not equal weight                   | **Closed** by §1 above.                                                                                |
| 14| Role dependency map                           | **Closed** by §2 above.                                                                                |
| 15| Rollback the API itself                       | **Closed** by §3 above.                                                                                |
| — | Audit format spec referenced by ADR-0003      | **Open.** ADR-0003's "Audit storage and semantics" defines the contract; the
detailed JCS canonicalization rules + worked example belong in
`docs/control-path/audit-format.md`, to be written alongside implementation. |

## 5. Workstream-level entry/exit gates

To make "WS1 is done" measurable, each workstream from the original plan
gets one explicit entry condition and one explicit exit condition.
These supplement, not replace, the per-workstream exit criteria in
the original plan.

| Workstream                                | Entry condition                                                                                  | Exit condition                                                                                              |
|-------------------------------------------|--------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| WS0 — Architecture freeze                 | (none)                                                                                           | All five ADRs accepted; `api-v1.yaml` first draft committed; this sequencing doc committed.                 |
| WS1 — API contracts                       | WS0 done; CI bootstrap done.                                                                     | OpenAPI v1 schema validates; mock server returns conformant envelopes for every path; contract tests in CI. |
| WS2 — State store                         | WS1 done.                                                                                        | KV interface implemented over SQLite; key layout per ADR-0003; CAS/revision tests pass; backup/restore works. |
| WS3 — xinas-agent                         | WS1 done; ADR-0002 method allow-list locked.                                                     | Agent reports complete observed state; task envelope live; executor-unavailable behavior verified.          |
| WS4 — Task engine                         | WS2 done; ADR-0004 schema in code.                                                               | Task survives API restart; duplicate apply blocked; failed task carries actionable diagnostics.             |
| WS5 — xiRAID adapter                      | WS3 done.                                                                                        | Arrays visible through API; create/import/delete plan works; unsafe delete blocked with dependencies.       |
| WS6 — Filesystem adapter                  | WS5 done.                                                                                        | Filesystems visible through API; active-share blockers on unmount; drift reported.                          |
| WS7 — NFS / share                         | WS3 done; helper socket permissions tightened.                                                   | Share ops through API only; `/etc/exports` changes go only through helper; share delete preserves data.     |
| WS8 — Network / RDMA                      | WS3 done.                                                                                        | Network state visible through API; `99-xinas.yaml` canonical; duplicate netplan blocker fires.              |
| WS9 — Config history / drift              | WS2 done; ADR-0003 audit semantics in code.                                                      | Every mutating apply creates before/after snapshots; drift visible in health and API.                       |
| WS10 — Health / support bundle            | WS9 done.                                                                                        | Health profiles return deterministic results; support bundle reproducible and redacted.                     |
| WS11 — RBAC / audit                       | ADR-0003 audit semantics in code; audit consolidation done.                                      | RBAC enforced across all transports; dangerous-flag gate verified; tamper-evident chain survives restart.   |
| WS12 — CLI / TUI / MCP                    | WS1 done; OpenAPI mock available.                                                                | Same operation through CLI/TUI/MCP produces same plan and task; MCP cannot apply by default.                |
| WS13 — Installer / packaging              | All adapters reach their MVP.                                                                    | Clean install starts everything; existing-node upgrade preserves data; uninstall non-destructive by default.|
| WS14 — Test automation                    | CI bootstrap done.                                                                               | Unit + contract tests in CI gate; nightly lab E2E green; destructive-blocker tests in RC gate.              |
