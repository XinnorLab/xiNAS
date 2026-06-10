# xinas-agent S0 + S1 — Phase 0 spec

> **Status:** Draft, brainstorm-approved 2026-05-28.
> **Workstream:** WS3 (xinas-agent), first sub-project (S0 — skeleton & boundary, S1 — observation).
>
> **S↔WS notation.** S0–S7 are sub-projects **inside WS3**, not equivalents of WS4-WS8. Where the spec writes `S<n> / WS<m>` (e.g., "S3 / WS5") it means "the `S<n>` sub-project inside WS3 unblocks the `WS<m>` downstream workstream"; the numbers are NOT interchangeable. Per `docs/control-path/phase0-sequencing.md:226`, WS5/WS6/WS7 start *after* WS3 completes (including S2's task envelope, which is itself a WS3 sub-project but corresponds to WS4-engine integration work).
> **Depends on:** [ADR-0001](adr/0001-api-surface.md), [ADR-0002](adr/0002-agent-privilege-model.md), [ADR-0003](adr/0003-state-store.md), [phase0-requirements.md](phase0-requirements.md) §3.
> **Companion plan:** `docs/plans/2026-05-28-xinas-agent-s0s1-plan.md` (to be written via `superpowers:writing-plans` after this spec is approved).

## Goal

Land the privileged half of the Phase 0 control path: a new `xinas-agent` system service that owns the privilege boundary per ADR-0002, plus enough observation coverage that the existing `xinas-api` (PR #201) GET endpoints stop returning empty arrays and start serving live data.

After this PR, the topology is:

- **`xinas-api.service`** — unprivileged REST + audit + state store. Same process as PR #201, with foundation changes (new dedicated group, internal token store, agent-state warnings, internal route family, controller-id shared file).
- **`xinas-agent.service`** — new root daemon. Listens on `/run/xinas/agent.sock` for typed RPCs; pushes observation deltas to the api over a dedicated `/internal/v1/observed` route family.
- **`xinas-nfs-helper.service`** — unchanged; now has a new caller (the agent) alongside its existing one (legacy MCP).
- **Legacy `xinas-mcp.service`** — unchanged; per ADR-0001 §Migration scope, MCP retirement is WS12.

## Scope

### In scope

#### Process and packaging

- New `xinas-agent.service` systemd unit (source-tree owned at `xiNAS-MCP/xinas-agent.service`).
- New `xinas_agent` Ansible role mirroring `xinas_api`'s shape (defaults, handlers, tasks, templates, README). Opt-in only; no `playbooks/site.yml` change.
- Foundation refactor to `xinas_api` role + `xinas-api.service` to provision the new `xinas-api` group, internal token store, and shared controller-id file. Lands as the first commits of the PR.

#### Code structure (`xiNAS-MCP/src/`)

- New `src/agent/` subtree: process entry point (`agent-server.ts`), RPC dispatcher, observation collectors, system probes, observation publisher.
- New `src/lib/parse/` shared library: pure parsing/normalization helpers, imported by `src/agent/`, `src/api/`, and (in a follow-up) the legacy `src/tools/`. No system calls; no privilege escalation.
- New `src/api/internal/` sub-router with strict role-based auth (`requireInternalAgent` middleware):
  - `POST /internal/v1/observed` — observation push (Flow A).
  - `POST /internal/v1/agent_started` — one-shot startup signal from the agent (Flow C step 2). Body is `{ controller_id }`; clears the heartbeat tracker's startup grace timer so the api doesn't sit in `offline` waiting for the first heartbeat tick. Returns `204 No Content`.
- New `src/api/heartbeat.ts`: in-memory `HeartbeatTracker` singleton driving `agent_state`.
- New `src/api/middleware/system-warnings.ts`: central injector for `EXECUTOR_DEGRADED` warnings into every envelope.
- Extension to `src/api/routes/system.ts`: agent state surfaced via `/api/v1/system` response.
- Schema extension to `docs/control-path/api-v1.yaml`: new public resources `User`, `Group`, `NfsSession`, `NfsIdmap`; additive fields on `Filesystem.status`.

#### Observation coverage (S1)

Twelve observation kinds. Ten are real implementations; two are stubs with explicit deferral codes.

| # | Kind | Path | Status | Source |
|---|---|---|---|---|
| 1 | `Disk` | `/xinas/v1/observed/Disk/<id>` | Real | `lsblk --json`, `nvme list`, `/sys/block/*` |
| 2 | `NetworkInterface` | `/xinas/v1/observed/NetworkInterface/<id>` | Real | `ip -j monitor link addr` subprocess for live events, periodic `ibstat` snapshot for IB-specific fields, `/sys/class/net/*` for static facts |
| 3 | `Filesystem` (with mount-state fold-in) | `/xinas/v1/observed/Filesystem/<id>` | Real | scan `/etc/systemd/system/*.mount` + cross-reference `/proc/self/mountinfo` |
| 4 | `XiraidArray` | `/xinas/v1/observed/XiraidArray/<id>` | **Stub** (`XIRAID_ADAPTER_DEFERRED`) | xiRAID gRPC client move from API → agent lands in S3 / WS5 |
| 5 | NFS exports — internal observed kind `ExportRule` (no public REST endpoint); joined into `Share.status.exports[]` at read time | `/xinas/v1/observed/ExportRule/<export_path>` | Real | xinas-nfs-helper `list_exports` op |
| 6 | `NfsSession` | `/xinas/v1/observed/NfsSession/<id>` | Real | xinas-nfs-helper `list_sessions` op |
| 7 | `NfsIdmap` | `/xinas/v1/observed/nfs_idmap/snapshot` (singleton) | Real | `/etc/idmapd.conf` + `systemctl is-active nfs-idmapd.service` |
| 8 | `SystemdUnit` | `/xinas/v1/observed/SystemdUnit/<unit-name>` | Real | dbus subscription + `systemctl show` for an allow-listed set of units. Public schema added to api-v1.yaml. |
| 9 | `managed_files` | `/xinas/v1/observed/managed_files/<path>` | **Stub** (`DRIFT_FRAMEWORK_DEFERRED`) | Drift framework lands in WS9. Path conforms to ADR-0003 line 101's locked layout (snake_case singular noun, used by `xinas_history.drift`). |
| 10 | Inventory (lowercase singleton, preserves PR #201 shape) | `/xinas/v1/observed/inventory/snapshot` | Real | uname, hostname, `/proc/cpuinfo`, `/proc/meminfo` |
| 11 | `User` | `/xinas/v1/observed/User/<uid>` | Real | `getent passwd` (local + NSS-resolved) |
| 12 | `Group` | `/xinas/v1/observed/Group/<gid>` | Real | `getent group` |

The xinas-nfs-helper socket permission tightening that ADR-0002 line 331-333 prescribes ("only the agent can connect") is **not** in scope here. The permission tightening is **WS7 work** per ADR-0002 and `docs/control-path/phase0-sequencing.md:228` (which lists it as a WS7 entry condition). It cannot land before WS12 retires the legacy MCP's helper access path, because PR #199-#203 left `xinas-mcp.service` running and still calling `/run/xinas-nfs-helper.sock` directly. For S0+S1 the helper accepts both callers (legacy MCP + new agent); the tightening is gated on MCP retirement, not on WS7 scheduling.

#### Public REST contract growth

- `/api/v1/users` (list) + `/api/v1/users/{uid}` (get).
- `/api/v1/groups` + `/api/v1/groups/{gid}`.
- `/api/v1/nfs-idmap` (singleton).
- `/api/v1/shares/{id}/sessions` becomes non-empty (the endpoint already exists in PR #201; this PR populates it).
- `/api/v1/system` response gains an `agent` field carrying `state` + `last_heartbeat_at` + `last_observed_push_at` + `collectors` map.

Integration test (the one introduced by PR #201 task API-21) grows from 30 public GETs to **35** — the 30 from PR #201 plus 5 new (`/users`, `/users/{uid}`, `/groups`, `/groups/{gid}`, `/nfs-idmap`). `Share.status.exports[]` and the `Node.status.agent` sub-object are additive fields on existing resources, not new endpoints.

### Out of scope

- xiRAID adapter migration (gRPC client move from API → agent). Stays in S3 / WS5.
- Storage / filesystem / NFS / network mutating typed methods. Stay in S3–S6.
- Task execution envelope (`task.begin`, `task.stage_report`, `task.cancel`, `task.list_inflight`). The agent's RPC dispatcher leaves stub handlers that return `EXECUTOR_UNSUPPORTED`. Real implementation lands in S2.
- xinas-nfs-helper socket permission tightening (assigned to WS7 per ADR-0002/sequencing.md; cannot land before WS12 retires legacy MCP's helper access path).
- Drift / managed-file checksum framework (WS9). This deferral also defers **netplan-file configuration observation** (per phase0-requirements §3) — netplan-file drift rides the managed-files framework; live interface state is covered by the NetworkInterface collector.
- **NfsProfile effective-state observation** (`nfs.profile.observe`) is enumerated as a mutating-bucket stub returning `EXECUTOR_UNSUPPORTED` in S0+S1; lands in S5/WS7. This is a partial deferral of phase0-requirements §3's "NFS server state" item — NFS server systemd-unit state IS observed via the SystemdUnit collector and the helper's `fix_nfs_conf` reads `/etc/nfs.conf`, but the canonical NfsProfile effective-state (the full §1 NfsProfile schema) is not yet computed.
- Enterprise identity (AD, Kerberos, SSSD-backed bulk enumeration). NSS-resolved local cache is observed; bulk-fetching directory-server users is deferred.
- Metrics / Prometheus exporter (WS10).
- TCP exposure of the agent socket. UDS only, always.
- TUI / MCP / CLI integration with the new public resources. The data is in the state store; UI lands in WS12.
- Coverage thresholds in CI. Coverage tooling lands; threshold enforcement is a later opt-in.

## Architecture

### Process topology

```
                                              (operators, demo MCP, automation)
                                                            │
                                                            ▼
        ┌──────────────────────┐   /api/v1/* (UDS, bearer or UDS-trust)
        │  xinas-api.service   │ ◀─────────────────────────────
        │  User=xinas-api      │
        │  Group=xinas-admin   │   /internal/v1/observed (UDS, agent bearer only)
        │  SupplementaryGroups │ ◀───────────────────────────
        │    =xinas-api        │   (membership in xinas-api grants connect to agent.sock)
        └──────┬───────────────┘
               │ agent.health, future task.* methods
               │ (UDS at /run/xinas/agent.sock, JSON-RPC 2.0)
               ▼
        ┌──────────────────────┐   /var/lib/xinas/controller-id (read)
        │  xinas-agent.service │ ◀───────────────────────────
        │  User=root           │
        └──────┬───────────────┘
               │ list_exports, list_sessions, fix_nfs_conf
               │ (UDS at /run/xinas-nfs-helper.sock)
               ▼
        ┌──────────────────────┐
        │ xinas-nfs-helper.svc │
        └──────────────────────┘
```

### Foundation: ripple back into the `xinas_api` role

PR #203 landed the xinas-api user with primary group `xinas-admin` and gave the api's writable directories mode `0750 xinas-api:xinas-admin` so operators in the admin group can read state files the api creates. The agent socket (`root:xinas-api 0660` per ADR-0002 line 55) needs a dedicated group named `xinas-api` that the api process belongs to — but **as a supplementary group, not the primary group**.

A naive "flip primary to `xinas-api`" would silently break operator readability: with `Group=xinas-api` the api's effective gid at runtime becomes `xinas-api`, and every newly-created file (xinas.db, WAL, audit JSONL rotations, archive segments, the SQLite DB itself on fresh install) would be group-owned by `xinas-api` — a group with no human members. Operators in `xinas-admin` would lose group-read on those new files, defeating the very rationale PR #203's role-spec documents. Supplementary group membership satisfies the `0660 root:xinas-api` socket gate (group membership is what matters for connect) AND keeps the api's primary-egid as `xinas-admin` so files default to operator-readable.

Concrete changes to PR #203's role + unit:

| Resource | PR #203 state | This PR state |
|---|---|---|
| `xinas-api` system user | exists, primary group `xinas-admin` | unchanged |
| `xinas-api` system group | n/a | **new** (no human members; used only for the agent socket gate) |
| `xinas-api` user supplementary groups | (none) | **`xinas-api`** (NEW dedicated group) |
| `xinas-api.service` `User=` | `xinas-api` | unchanged |
| `xinas-api.service` `Group=` | `xinas-admin` | unchanged (egid stays admin so new files default to operator-readable) |
| `xinas-api.service` `SupplementaryGroups=` | (none) | **`xinas-api`** (NEW — grants agent-socket connect) |
| `/etc/xinas-api/config.json` | `root:xinas-admin 0640` | unchanged |
| `/etc/xinas-api/admin-token` | `root:xinas-admin 0640` | unchanged |
| `/etc/xinas-api/internal-tokens.json` | n/a | **new, `root:xinas-api 0640`** (only api via supplementary group + root can read) |
| `/etc/xinas-agent/agent-token` | n/a | **new, `root:root 0400`** |
| `/var/lib/xinas/controller-id` | n/a (api derives via `ansible_machine_id \| to_uuid`) | **new shared file, `root:root 0644`, generated by uuidgen on first install. Lives under `/var/lib/xinas/` so identity travels with state across OS reinstall on the same data disk.** |
| `/run/xinas/agent.sock` | n/a | **new, `root:xinas-api 0660` (chowned by agent after bind; api connects via supplementary group membership)** |
| `/run/xinas/api.sock` | `xinas-api:xinas-admin 0660` | unchanged |
| `/var/lib/xinas/state/`, `/var/log/xinas/` | `xinas-api:xinas-admin 0750` | unchanged |

### Foundation: shared controller_id file

Per phase0-requirements §3 ("`controller_id` is unchanged and matches API, audit, task, and support-bundle records"), this PR introduces `/var/lib/xinas/controller-id` as the single source of truth.

- File mode `0644 root:root`; world-readable because controller_id is not a secret.
- Generated by the `xinas_api` role's bootstrap step (`command: uuidgen` guarded by `creates: /var/lib/xinas/controller-id`, then a `copy:` of the captured stdout — a `creates:`-guarded `command` rather than a `shell:` redirect so it stays ansible-lint clean and idempotent). Re-runs preserve the value. Preserved across reboot + upgrade.
- **Co-located with state and audit JSONL under `/var/lib/xinas/`** so identity travels with the data disk. OS reinstall preserving the data disk preserves controller_id AND the audit chain. Fresh data disk → new controller-id → new audit genesis (the correct semantic: this is a new node identity).
- The schema and config shape are unchanged: `config.json` still carries `controller_id: "<uuid>"` as a string UUID; `ApiConfig.controller_id` is still a string UUID. What changes is the **role's templating pattern**: instead of computing the value via `ansible_machine_id | to_uuid`, the role slurps `/var/lib/xinas/controller-id` into a set_fact and substitutes the resulting UUID into the config template. The variable `xinas_api_controller_id` keeps its value-semantics; its default changes from `"{{ ansible_machine_id | to_uuid }}"` to `""` (an empty placeholder). The role then `slurp`s `/var/lib/xinas/controller-id` **from the managed host** and `set_fact`s `xinas_api_controller_id` from the decoded blob, guarded by `when: xinas_api_controller_id | length == 0` so an explicit operator override still wins. The default is deliberately **not** `"{{ lookup('file', '/var/lib/xinas/controller-id') | trim }}"`: Ansible `lookup('file', …)` executes on the **control node**, not the managed host, so it would read the controller's filesystem (wrong id, or a hard error when the path is absent there).
- The agent reads the same file at startup. `controller_id` mismatches between push body and the api's loaded value cause the api to reject the observation push with `INVALID_ARGUMENT`.
- Audit genesis hash (per ADR-0003) keys on this value. Same identity ⇒ same audit chain across api/agent restarts.
- **PR #203's role-spec rationale needs updating in the same change.** That spec justified the original machine-id derivation as "stable per node without an extra on-disk file" — that argument no longer applies. New rationale: "stable per node via a persistent file under `/var/lib/xinas/`; generated once on first install; survives OS reinstall as long as the data disk persists."

### Foundation: split-secret token store

Operator-readable and agent-readable tokens cannot share a file. The api process reads BOTH at startup; tokens conflict on key → startup rejects with a clear error.

- `/etc/xinas-api/admin-token` — `0640 root:xinas-admin`. Unchanged from PR #203. Operator-readable mirror of the admin bootstrap token in `config.json`.
- `/etc/xinas-api/internal-tokens.json` — `0640 root:xinas-api`. NEW. Shape: `{ "<agent-token>": { "principal": "agent:root", "role": "internal_agent" } }`. Only the api process (via supplementary group `xinas-api`) and root can read.
- `/etc/xinas-agent/agent-token` — `0400 root:root`. NEW. The agent reads it at startup.
- The api's `loadConfig()` grows: also reads `internal-tokens.json` if present; merges into the `tokens` map; key collision is a startup fatal.
- The `xinas_api` role's token bootstrap (PR #203's part B) grows: generates the admin token AND a second random token; writes the admin token to `admin-token` + `config.json`; writes the agent token to `internal-tokens.json` + `/etc/xinas-agent/agent-token`.

### Code layout — pure vs. probe boundary

```
xiNAS-MCP/src/
├── lib/parse/                     ← pure (no syscalls, no fs of system paths)
│   ├── disk.ts                    ← lsblk JSON → Disk
│   ├── network.ts                 ← `ip -j monitor` stdout parser + ibstat output → NetworkInterface
│   ├── filesystem.ts              ← parsed systemd .mount unit → Filesystem
│   ├── systemd-unit.ts            ← INI-like systemd unit parser
│   ├── mountinfo.ts               ← /proc/self/mountinfo parser
│   ├── nfs.ts                     ← helper's list_exports / list_sessions output → ExportRule / NfsSession
│   ├── idmap.ts                   ← /etc/idmapd.conf parser
│   ├── passwd.ts                  ← /etc/passwd line parser
│   ├── group.ts                   ← /etc/group line parser
│   └── inventory.ts               ← uname + /proc/cpuinfo + /proc/meminfo parsers
├── api/                           ← (existing) the API process
│   ├── internal/observed.ts       ← NEW: /internal/v1/observed POST handler
│   ├── middleware/system-warnings.ts ← NEW: injects EXECUTOR_DEGRADED warnings
│   ├── middleware/require-internal-agent.ts ← NEW: role gate on /internal/v1/*
│   ├── heartbeat.ts               ← NEW: in-memory HeartbeatTracker
│   └── ...                        ← (existing routes/middleware unchanged except system.ts)
├── agent/                         ← NEW agent process (Node 20 / TS)
│   ├── agent-server.ts            ← process entry point
│   ├── config.ts                  ← AgentConfig + loadConfig (controller-id, token, api UDS path)
│   ├── rpc/
│   │   ├── server.ts              ← UDS listener; JSON-RPC 2.0 over NDJSON; binds /run/xinas/agent.sock; chowns root:xinas-api 0660
│   │   ├── dispatch.ts            ← method router; rejects unknown methods with -32601
│   │   └── methods/               ← typed method handlers
│   │       ├── agent-health.ts    ← agent.health
│   │       ├── agent-version.ts   ← agent.version
│   │       └── stubs.ts           ← every other ADR-0002 method returns EXECUTOR_UNSUPPORTED
│   ├── probe/                     ← AGENT-ONLY: actual syscalls, subprocesses, sockets
│   │   ├── disk.ts                ← child_process.spawn('lsblk', ...) + udevadm-monitor subprocess
│   │   ├── network.ts             ← child_process.spawn('ip', '-j', 'monitor', ...) + ibstat
│   │   ├── filesystem.ts          ← readdir /etc/systemd/system + spawn systemctl is-enabled
│   │   ├── nfs.ts                 ← unix socket client to /run/xinas-nfs-helper.sock
│   │   ├── systemd.ts             ← dbus client for unit state
│   │   ├── users.ts               ← spawn getent passwd / getent group
│   │   ├── idmap.ts               ← readFile /etc/idmapd.conf + spawn systemctl is-active
│   │   └── inventory.ts           ← readFile /proc/cpuinfo, /proc/meminfo
│   ├── collectors/                ← one per observation kind; orchestrates probe + parse + delta-emit
│   │   ├── base.ts                ← Collector<K> interface (initialSweep, start, stop, pollInterval?)
│   │   ├── disk.ts
│   │   ├── network.ts
│   │   ├── filesystem.ts
│   │   ├── nfs.ts                 ← emits NfsSession deltas + Share.status.exports updates
│   │   ├── nfs-idmap.ts
│   │   ├── systemd.ts
│   │   ├── users.ts               ← emits User + Group deltas
│   │   ├── inventory.ts
│   │   ├── xiraid-stub.ts
│   │   └── managed-files-stub.ts
│   └── publisher.ts               ← debounced batcher; POSTs to /internal/v1/observed; retries 5xx; tracks pending-reconcile set
└── tools/                         ← (existing legacy MCP) untouched in this PR
```

Architecture rules:

1. `src/agent/probe/` is the only place that does subprocess/syscall/socket I/O for system observation. Nothing outside `src/agent/` may import from `src/agent/probe/`. Enforcement: a focused biome `noRestrictedImports` rule (or a small custom AST check if biome's rule lacks path-pattern support) added in `biome.json` rejects any import of `*/agent/probe/*` from files outside `src/agent/`. CI's existing `typescript-lint` job catches violations. Build-target separation via tsconfig `paths` was considered but is unnecessary infrastructure for what is fundamentally a lint rule.
2. `src/lib/parse/` is pure. Functions take raw inputs (strings, buffers, parsed JSON) and return typed objects. No `fs.readFile`, no `child_process`, no sockets. Safe to import from any process.
3. Legacy `src/tools/` (existing MCP) is not refactored in this PR. It keeps its own privileged calls. Convergence is WS12.

### Agent's RPC surface in S0+S1

| Method | Status | Returns |
|---|---|---|
| `agent.health` | Real | `{ status, version, uptime_seconds, controller_id, in_flight_tasks: 0, collectors: { <name>: 'running' \| 'stubbed' \| 'error: <reason>' } }` |
| `agent.version` | Real | `{ version, git_sha, build_date }` |
| `inventory.collect`, `disks.list`, `filesystems.list`, `mounts.list`, `network.snapshot`, `systemd.units_status`, `exports.list`, `nfs.sessions.list` | Stub (deferred to WS12 convergence) | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'`. **The LIVE data path in S0/S1 is the push model (Flow A)** — collectors push the same data asynchronously to `/internal/v1/observed`, which the api serves from its KV store; no S0/S1 caller uses the on-demand pull. These on-demand read methods are enumerated-but-stubbed now (so they return `EXECUTOR_UNSUPPORTED`, not an unknown `-32601`) and are wired to the collectors' last-computed snapshots in WS12. |
| `arrays.list`, `managed_files.checksums` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'` |
| `arrays.create`, `arrays.delete`, `arrays.import`, `spare.set` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'` |
| `fs.create`, `fs.mount`, `fs.unmount`, `fs.grow`, `fs.set_quota_mode` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'` |
| `nfs.exports.add`, `nfs.exports.update`, `nfs.exports.remove` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'` |
| `nfs.profile.render`, `nfs.profile.apply`, `nfs.profile.observe` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'` |
| `network.render_netplan`, `network.flush_managed`, `network.apply` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'` |
| `systemd.reload`, `systemd.restart` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'` |
| `task.begin`, `task.stage_report`, `task.cancel`, `task.list_inflight` | Stub | JSON-RPC error -32000 with `data.code: 'EXECUTOR_UNSUPPORTED'`; reserved for S2 |

The dispatcher enumerates the full ADR-0002 method set explicitly. Anything outside the enumerated set returns `-32601 Method not found` (unknown method), not `EXECUTOR_UNSUPPORTED` (enumerated but stubbed). This distinction matters: `-32601` is a contract violation (the caller asked for something not in the surface); `EXECUTOR_UNSUPPORTED` is a build-version notice (the surface exists but this build doesn't implement it yet).

## Data flow

### Flow A — Observation push (agent → api)

The publisher batches `ObservationDelta` emissions from collectors (~50-100ms debounce; flush early at 256 entries or 1 MB) and POSTs:

```
POST /internal/v1/observed
Authorization: Bearer <agent-token>
Content-Type: application/json

{
  "observed_at": "2026-05-28T18:00:00.123Z",
  "controller_id": "<uuid from /var/lib/xinas/controller-id>",
  "deltas": [
    { "kind": "Disk", "id": "nvme0n1", "op": "upsert", "value": { ... } },
    { "kind": "NetworkInterface", "id": "ibp0s4", "op": "upsert", "value": { ... } },
    { "kind": "NfsSession", "id": "10.1.2.3:/srv/share01", "op": "delete" }
  ],
  "complete_snapshots": ["Disk"]
}
```

**API processing:**

1. `requireInternalAgent` middleware: rejects unless `req.context.role === 'internal_agent'`. UDS-trust admin promotion does NOT satisfy.
2. Body validation: `controller_id` matches the api's loaded value (rejects with `INVALID_ARGUMENT` on mismatch, including a clear message naming both ids). Each delta validates against its kind's JSON Schema (api-v1.yaml fragments — every observation kind is a public schema after A3's fix, including `SystemdUnit` and `managed_files`). Batch-reject on any failure with the failing delta's index and reason.
3. **Single SQLite transaction** opens. For each delta: `tx.put` (upsert) or `tx.delete` (delete). For each kind in `complete_snapshots`: after applying its deltas, `tx.list({ prefix: '/xinas/v1/observed/<Kind>/' })` to enumerate current keys at the transaction's snapshot, compute the set difference (current − batch-upserts), and `tx.delete` each leftover.

   **Note: `KvTransaction.list()` is a new additive method on the state-store interface in this PR.** The current `KvTransaction` in `store.ts:57` exposes `get`/`put`/`delete` only; the outer `KvStore.list()` exists but lists committed state outside the transaction and so can't be used atomically with the deletes. Adding `list<T>(opts?: ListOptions): RevisionedValue<T>[]` to `KvTransaction` (mirroring the outer interface) is backward-compatible: existing call sites don't pass a transaction object, and the SQLite backend already has the underlying prepared statements. Lands as a small state-store extension in this PR's foundation tasks.
4. Per-key revisions bump per the existing KV semantics (`backend-sqlite.ts:58`). Response `state_revision` is `Math.max(...revisions)` across all keys touched (matches the existing `reads.ts:12` envelope shape).
5. `heartbeat.notifyObservationPush(now)` — updates `agent_last_observed_push`. Does **not** touch `agent_last_heartbeat` (per ADR-0002 line 221: executor availability is the API → agent direction).
6. Response: `200 OK` with envelope body `{ accepted: N, deleted_by_reconcile: M, state_revision: R }`.

**Audit:** the request goes through the existing audit middleware (`res.on('finish')` queues an entry via `state.audit.queue()`). Principal is `agent:root`; kind is `http.POST./internal/v1/observed`; `parameters_hash` is over the entire delta batch. Best-effort middleware audit, same window as every other API request. Bulletproof transactional audit (queueing inside the batch transaction) is a future enhancement.

### Flow B — Heartbeat (api → agent)

A `HeartbeatTracker` singleton in the api process ticks every `agent_heartbeat_interval_ms` (default 5000). Each tick:

1. Connect to `/run/xinas/agent.sock` (with a 1s connect timeout).
2. Send `{ "jsonrpc": "2.0", "id": <n>, "method": "agent.health", "params": {} }` + newline.
3. Read one line response (with a 2s read timeout).
4. On success: `agent_last_heartbeat = now`; transition tracker state per the table below.
5. On any failure: do NOT update `agent_last_heartbeat`; transition tracker state.

**Tracker state table** (computed on every tick AND on every observation POST):

| Time since `agent_last_heartbeat` | Tracker state |
|---|---|
| ≤ 2 × interval | `healthy` |
| > 2 × interval AND ≤ 6 × interval | `degraded` |
| > 6 × interval OR most recent connect refused | `offline` |

State transitions emit an event at `/xinas/v1/events/<rfc3339_ts>/<event_id>`:

```json
{
  "kind": "agent_state_changed",
  "controller_id": "<uuid>",
  "from": "healthy",
  "to": "degraded",
  "reason": "heartbeat_timeout",
  "last_successful_heartbeat_at": "2026-05-28T17:59:30.000Z"
}
```

**Mutating-route gate:** the existing `executorUnavailable` stub (PR #201) now consults the tracker. When `agent_state === 'offline'`, returns `INTERNAL` / `EXECUTOR_UNAVAILABLE`. When `degraded`, the agent's stub still returns `UNSUPPORTED` for unimplemented methods, but the **mutating-route envelope's** `warnings[]` includes `EXECUTOR_DEGRADED` (per ADR-0002 line 225-226 — read endpoints don't carry the warning). When `healthy`, mutating endpoints continue to return `UNSUPPORTED` (no mutating methods implemented in S0+S1) but without the degraded warning.

### Flow C — Startup sequence

```
[boot]
   ↓
1. xinas-api.service starts (After=network-online.target).
   - Reads /var/lib/xinas/controller-id (fatal if absent).
   - Reads /etc/xinas-api/config.json + /etc/xinas-api/internal-tokens.json
     (fatal on key collision).
   - Opens SQLite + runs recovery + starts audit drainer.
   - Binds /run/xinas/api.sock 0660 xinas-api:xinas-admin.
   - HeartbeatTracker starts in "offline" state.
   - Read-only GET endpoints serve cached state (initially empty on
     fresh install).
   ↓
2. xinas-agent.service starts (Requires=xinas-api.service,
                              After=xinas-api.service).
   - Reads its config + /etc/xinas-agent/agent-token + /var/lib/xinas/controller-id.
   - Binds /run/xinas/agent.sock, then chowns to root:xinas-api 0660.
   - Sends one-shot POST /internal/v1/agent_started { controller_id }
     to the api. The api clears its heartbeat-tracker startup grace
     timer so subsequent mutating calls don't sit in offline waiting
     for the first heartbeat tick.
   ↓
3. Agent runs initial full sweep:
   - Every collector emits initialSweep() → ObservationDelta[].
   - Publisher batches per kind; each batch carries
     complete_snapshots: [<kind>] so the api can reconcile.
   - Stubs (XiraidArray, ManagedFile) emit a "snapshot is empty +
     stubbed" marker delta so the kind's path is populated with a
     status row indicating the deferral.
   ↓
4. Agent enters steady-state:
   - Each collector's event subscription drives incremental deltas.
   - Poll-fallback ticks (per-collector) catch sources without events.
   - 5-minute backstop full-reconcile on event-only collectors (Mount,
     ExportRule) to guarantee no permanent stale data.
   ↓
5. API's heartbeat tracker transitions to "healthy" on first
   successful agent.health response. Subsequent mutating-endpoint
   calls return UNSUPPORTED (no methods implemented yet) without
   EXECUTOR_UNAVAILABLE.
```

### Flow D — Event-driven refresh with poll fallback

Each collector implements:

```ts
interface Collector<K extends Kind> {
  kind: K;
  initialSweep(): Promise<ObservationDelta[]>;     // full state; emitted with complete_snapshots: [kind]
  start(emit: (delta: ObservationDelta) => void): Promise<void>;
  stop(): Promise<void>;
  pollIntervalMs?: number;                          // if set, poll runs as fallback / backstop
}
```

**Event sources** (final table after the systemd-unit revision and the F1 backstop addition):

| Collector | Event source | Poll fallback / backstop |
|---|---|---|
| Disk | long-lived subprocess `udevadm monitor --udev --subsystem-match=block --property` (one event per blank-line-terminated record on stdout) | 60s |
| NetworkInterface | long-lived subprocess `ip -j monitor link addr` (or `ip monitor` if `-j` JSON unavailable on the target kernel) on stdout; periodic `ibstat` snapshot for IB-specific fields | 30s |
| Filesystem | inotify on `/etc/systemd/system/` (filter `*.mount`) + dbus on `.mount` units | 60s |
| Mount-state (folded into Filesystem) | dbus PropertiesChanged on `.mount` units + inotify on `/proc/self/mountinfo` | 30s |
| NFS (sessions + exports) | helper polling (no events from helper today) | 30s |
| NfsIdmap | inotify on `/etc/idmapd.conf` + dbus on `nfs-idmapd.service` | 60s |
| SystemdUnit | dbus PropertiesChanged on the allow-listed units | 30s |
| XiraidArray (stub) | n/a | n/a |
| ManagedFile (stub) | n/a | n/a |
| Inventory | n/a | 300s |
| User | inotify on `/etc/passwd`, `/etc/group`, `/etc/nsswitch.conf`, `/etc/sssd/` | 300s |
| Group | same as User | 300s |
| ExportRule (folded into Share.status.exports) | inotify on `/etc/exports.d/` + helper poll | **5 min backstop reconcile** (F1) |
| Mount (folded into Filesystem.status) | (same as Filesystem events) | **5 min backstop reconcile** (F1) |

**Pending-reconcile set** (per F1): if a publisher batch drops after 5 retries, the publisher records the kinds it contained in `pendingReconcile: Set<Kind>`. On the next collector tick of any kind in that set, the collector runs `initialSweep()` again (full-snapshot reconcile) instead of an incremental delta. On successful POST, the affected kinds are removed from the set.

**No native compiled bindings.** udev events come from a `udevadm monitor` subprocess (the kernel-level event source itself; the subprocess is just our reader). rtnetlink-equivalent events come from an `ip monitor` subprocess. dbus uses `dbus-native` (pure JS). inotify uses Node's built-in `fs.watch` (uses inotify on Linux). The agent supervises these subprocess monitors: SIGCHLD handler restarts them on death, with a 1s/2s/5s backoff and a structured-log entry per restart. Keeps the CI build simple and avoids node-gyp.

## API contract additions (api-v1.yaml)

Additive to PR #201's api-v1.yaml:

### `User` resource

```yaml
User:
  type: object
  required: [kind, id, metadata, spec, status]
  properties:
    kind: { type: string, const: User }
    id: { type: string, description: "Decimal uid as string." }
    metadata: { $ref: '#/components/schemas/Metadata' }
    spec:
      type: object
      required: [name, uid, gid]
      properties:
        name: { type: string }
        uid: { type: integer }
        gid: { type: integer }
        gecos: { type: string }
        home: { type: string }
        shell: { type: string }
    status:
      type: object
      required: [resolvable, source]
      properties:
        resolvable: { type: boolean }
        source: { type: string, enum: [local, nss] }
```

Paths:

```yaml
/users:
  get:
    operationId: listUsers
    parameters:
      - name: source
        in: query
        schema: { type: string, enum: [local, nss, all], default: all }
      - $ref: '#/components/parameters/QueryLimit'
    responses: { '200': { ... envelope wrapping array of User ... } }

/users/{uid}:
  get:
    operationId: getUser
    parameters:
      - name: uid
        in: path
        required: true
        schema: { type: integer }
    responses: { '200': { ... envelope wrapping User ... } }
```

### `Group` resource

Same shape as `User`; `gid` instead of `uid`; spec carries `members: string[]`.

Paths: `/groups`, `/groups/{gid}`.

### `NfsSession` resource

```yaml
NfsSession:
  type: object
  required: [kind, id, metadata, spec, status]
  properties:
    kind: { type: string, const: NfsSession }
    id: { type: string, description: "Composite: <client_addr>:<export_path>." }
    metadata: { $ref: '#/components/schemas/Metadata' }
    spec:
      type: object
      required: [client_addr, export_path]
      properties:
        client_addr: { type: string }
        client_hostname: { type: string }
        export_path: { type: string }
    status:
      type: object
      required: [proto_version, locked_files, observed_at]
      properties:
        proto_version: { type: string, enum: [v3, v4, v4.1, v4.2] }
        locked_files: { type: integer }
        observed_at: { type: string, format: date-time }
```

Surfaced via the existing `/api/v1/shares/{share_id}/sessions` endpoint (which became non-empty for the first time).

### `NfsIdmap` resource (singleton)

```yaml
NfsIdmap:
  type: object
  required: [kind, metadata, status]
  properties:
    kind: { type: string, const: NfsIdmap }
    metadata: { $ref: '#/components/schemas/Metadata' }
    status:
      type: object
      required: [conf_present, idmapd_active, method]
      properties:
        conf_present: { type: boolean }
        domain: { type: string }
        local_realms: { type: array, items: { type: string } }
        method: { type: string, enum: [nsswitch, static, umich_ldap, unknown] }
        idmapd_active: { type: boolean }
        idmapd_unit_state: { type: string }
```

Path: `/api/v1/nfs-idmap` (singleton).

### `Filesystem.status` additive fields

Adds without removing:

```yaml
status:
  properties:
    currently_mounted: { type: boolean }
    mount_options: { type: array, items: { type: string } }
    mount_unit_name: { type: string, description: "Name of the .mount unit, e.g. srv-share01.mount" }
    mount_unit_state: { type: string, description: "active | inactive | failed | activating | deactivating" }
    owner_uid: { type: integer }
    owner_gid: { type: integer }
    owner_user_name: { type: [string, "null"] }
    owner_group_name: { type: [string, "null"] }
```

### `Node.status` agent-state addition

The existing `Node` resource's `status` block (api-v1.yaml line 1086+) gains an `agent` sub-object. `/api/v1/system` already returns `{ cluster, node }` per the current `system.ts` handler; agent state is per-node, not per-cluster, so it lands inside `result.node.status`:

```yaml
# Additive on the existing Node.status:
status:
  properties:
    # ... existing fields preserved (agent_state, etc.)
    agent:
      type: object
      required: [state, version]
      properties:
        state: { type: string, enum: [healthy, degraded, offline] }
        last_heartbeat_at: { type: [string, "null"], format: date-time }
        last_observed_push_at: { type: [string, "null"], format: date-time }
        version: { type: string }
        collectors:
          type: object
          additionalProperties: { type: string }
          description: "Per-collector state: running | stubbed | error: <reason>"
```

### `ExportRule` schema + `Share.status.exports[]` additive field

The current `Share.status` (api-v1.yaml line 614) has `exported`, `client_mount_profile`, `sessions`, `effective_options` — no `exports[]`. This PR adds `exports: ExportRule[]` to `Share.status` and defines the `ExportRule` schema:

```yaml
# Additive on the existing Share.status:
status:
  properties:
    # ... existing fields preserved (exported, client_mount_profile, sessions, effective_options)
    exports:
      type: array
      items:
        $ref: '#/components/schemas/ExportRule'
      description: "Per-host export entries observed from /etc/exports.d/ or helper output."

# New top-level schema:
ExportRule:
  type: object
  required: [host_pattern, options]
  properties:
    host_pattern:
      type: string
      description: "Matches /etc/exports host field (CIDR, hostname, wildcard, netgroup)."
    options:
      type: array
      items: { type: string }
    squash_mode:
      type: string
      enum: [root_squash, no_root_squash, all_squash]
    anon_uid: { type: integer }
    anon_gid: { type: integer }
```

The existing `/api/v1/export-groups` endpoint stays as-is (still returns `[]` in S0+S1); ExportRule entries surface inside `Share.status.exports[]` where they naturally belong. No new public GET endpoint for ExportRule.

**Join key (read time):** the fold-in matches `desired Share.spec.path` against the observed `ExportRule.spec.export_path` (and, for `/shares/{id}/sessions`, against `NfsSession.spec.export_path`). The Share has **no** `export_path` field — its `spec.path` IS the exported directory the agent stamps onto the observed rows. Keying the Share side off a non-existent `export_path` silently returns `[]` for every real Share.

### `SystemdUnit` resource (new public kind)

```yaml
SystemdUnit:
  type: object
  required: [kind, id, metadata, status]
  properties:
    kind: { type: string, const: SystemdUnit }
    id: { type: string, description: "Unit name including suffix, e.g. nfs-server.service or srv-share01.mount." }
    metadata: { $ref: '#/components/schemas/Metadata' }
    status:
      type: object
      required: [load_state, active_state, sub_state, observed_at]
      properties:
        load_state: { type: string, description: "loaded | not-found | error | masked" }
        active_state: { type: string, description: "active | reloading | inactive | failed | activating | deactivating" }
        sub_state: { type: string }
        unit_file_state: { type: string, description: "enabled | disabled | static | masked | ..." }
        observed_at: { type: string, format: date-time }
```

Allow-listed units only (defined in the spec's `Open questions` — the list is enumerable; observed units outside the allow-list are not emitted). No new GET endpoint in this PR; the resources sit in the state store at `/xinas/v1/observed/SystemdUnit/<unit-name>` for future health-check consumers.

### `status.observed_at` on every observed kind

Each observed resource's `status` block gains an `observed_at` field (additive, non-breaking). The agent stamps it at probe-time; the api computes `observation_age_seconds = now - status.observed_at` on read and surfaces it inline:

```yaml
# Pattern applied to every kind: Disk, NetworkInterface, Filesystem, NfsSession,
# NfsIdmap, User, Group, SystemdUnit, Inventory, and the stubs.
status:
  properties:
    # ... kind-specific fields ...
    observed_at:
      type: string
      format: date-time
      description: "When the agent's collector observed this entity. Used to compute observation_age_seconds."
```

This is the bridge for per-kind freshness — the KV's out-of-band `metadata.modified_at` is internal; `status.observed_at` is the operationally-meaningful timestamp the agent controls and clients see.

## Errors

### Agent-side JSON-RPC envelope

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32000,
    "message": "method not implemented in this build",
    "data": { "code": "EXECUTOR_UNSUPPORTED", "method": "arrays.list" }
  }
}
```

### Standard JSON-RPC numeric codes the agent emits

| Numeric | Meaning |
|---|---|
| `-32600` | Invalid Request (malformed envelope) |
| `-32601` | Method not found (method outside ADR-0002's enumerated set) |
| `-32602` | Invalid params (schema failure) |
| `-32603` | Internal error (collector crash, OS error) |
| `-32000` (custom) | See `error.data.code` |

### Custom `error.data.code` values

| `error.data.code` | Meaning | API maps to envelope code |
|---|---|---|
| `EXECUTOR_UNSUPPORTED` | Method enumerated but not yet implemented in this build | `UNSUPPORTED` |
| `DEADLINE_EXCEEDED` | Reserved for S2; agent doesn't emit it yet in S0+S1 but the mapping is reserved | `TIMEOUT` (existing envelope code) |
| Anything else (or absent) | Generic agent failure | `INTERNAL` |

### Collector failure isolation

Each collector under `src/agent/collectors/` runs inside a try/catch wrapper. On exception:

1. Structured log to stderr (`level: error`, `subsystem: <collector name>`, `error: <message + stack>`).
2. Collector's in-memory state flips to `error: <short reason>`.
3. Other collectors keep running. Process stays up.
4. `agent.health` response's `collectors` map carries the error state.
5. Next poll-fallback tick attempts a restart; transient causes self-recover.

The api's `HeartbeatTracker` interprets `agent.health` with any collector in `error` as `degraded` (executor reachable, some data stale), not `offline`.

### Publisher retry policy and pending-reconcile

Per-batch policy: 5 retries, exponential backoff `250ms × 2ⁿ` capped at 30s. 4xx responses do NOT retry (the agent's payload is structurally wrong; retrying won't fix it). 5xx responses retry.

On retry exhaustion: drop the batch; add affected kinds to `pendingReconcile: Set<Kind>`; log structured error; surface in next `agent.health` as `last_publish_error: { dropped_at, http_status, kinds }`. Next collector tick of any affected kind reconciles fully (combined with the 5-minute backstop poll for event-only collectors, no kind goes more than 5 minutes without a full-reconcile attempt during sustained API trouble).

### API-side validation failures

- Bearer wrong / missing / role mismatch → 401 `PERMISSION_DENIED` (positive test: UDS-without-bearer is rejected with the same code at `/internal/v1/observed`; UDS-trust admin promotion is irrelevant on internal routes).
- `controller_id` mismatch → 400 `INVALID_ARGUMENT` with message naming both ids.
- Any delta fails its JSON Schema → 400 `INVALID_ARGUMENT` with failing delta's index + reason. Batch reject (no partial accept).
- State store error → 500 `INTERNAL`.

## Observability

### Agent logs

Agent emits structured JSON log lines (one event per line) to stderr. systemd-journald captures each line into the `MESSAGE` field. Operators query with:

```bash
journalctl -u xinas-agent.service -o cat | jq
```

Native journald-field promotion (via `sd_journal_send`) is **not** in scope for S0+S1.

Standard fields in every log line: `time` (rfc3339), `level` (`debug` / `info` / `warn` / `error`), `subsystem` (collector name, or `core`, `rpc`, `publisher`), `event` (short event name), `request_id` (for RPC-related events), `error` (when applicable).

### API surfaces agent state

Two paths exposed to clients:

- **`/api/v1/system` response gains the `agent` field** (schema above). One curl gives operators the full executor picture.
- **`EXECUTOR_DEGRADED` warning injected into mutating-route envelopes** when `agent_state === 'degraded'`. ADR-0002 line 225-226 scopes this warning to mutating operation responses; the spec respects that scope. (Read endpoints don't carry the warning; operators get the full picture from `/api/v1/system`'s `result.node.status.agent`.)

  Implementation note: per-envelope warnings plumbing is **net-new infrastructure**. Today `RequestContext` has no `warnings` field, `sendOk()` always emits `warnings: []`, and there's no shared merge helper. This PR adds:

  - `system_warnings: Warning[]` field on `RequestContext`.
  - `systemWarningsMiddleware()` that populates it from `HeartbeatTracker.currentWarnings()` (returns the appropriate warning array based on tracker state and route classification).
  - `mergeWarnings(handlerWarnings, systemWarnings)` helper called by both `sendOk()` and `errorMiddleware()` to combine into the final envelope `warnings[]`.

### Per-kind freshness

Each observed resource's value body carries a `status.observed_at` timestamp the agent stamps at probe-time. The api computes `observation_age_seconds = now - status.observed_at` on read and surfaces it inline in the resource's `status` (additive; non-breaking).

The KV's out-of-band `metadata.modified_at` (per `types.ts:12` `RevisionedValue<T>`) is **not** what we use here: it's stored on the KV row, not inside the JSON value body, and `sendOk()` returns only `row.value`. The agent doesn't see KV metadata. Putting `observed_at` inside the value body lets the agent control the timestamp and clients see it without the api needing a metadata-merge layer.

### Audit

Observation POSTs are audited via the same best-effort middleware path as all other API requests (PR #201 CR2's `auditMiddleware`). Per-request audit rows include:

- `principal: "agent:root"`
- `client_type: "rest"`
- `kind: "http.POST./internal/v1/observed"`
- `parameters_hash: sha256(canonical(delta batch))`
- `result_hash: sha256(String(status_code))`
- `controller_id` (the api's own controller_id, which matched the agent's)
- `request_id` from `X-Request-ID` header or generated by the request-id middleware

Operators have a per-request audit trail of what was pushed when. They do NOT have a guarantee that audit and state can never disagree (the audit row queues via `res.on('finish')`, after the batch transaction commits). If bulletproof per-batch transactional audit is later required, the observation handler can queue the audit row inline inside its batch transaction; that's an additive enhancement, not in scope for S0+S1.

**One sub-gap relative to ADR-0003 line 364's read-path semantics:** ADR-0003 specifies that on read paths, audit-queue failures surface as a warning on the response itself. Observation POST cannot match this because middleware audit runs in `res.on('finish')` — by the time it fires, the response body is already on the wire. Operators discover queue failures via the agent's `agent.health` `last_publish_error` field and the api's journald, not via a warning on the failing response. Acknowledged asymmetry; not a fix.

### No metrics in S0+S1

Prometheus exporter / OpenTelemetry signals are WS10 territory; not introduced here.

## Testing

Three layers, no new CI infrastructure (beyond the coverage tooling deliverable).

### Layer 1 — Pure unit tests on `src/lib/parse/`

vitest, no system access. Each parse module has a sibling test file with fixture inputs and asserted typed outputs.

Critical fixtures to include:

- `lsblk --json` output: clean controller (4 NVMe), mixed NVMe + SATA, controller with a degraded disk, system-disk-only controller.
- `systemd .mount` units: real output from both `xfs_helpers.py:generate_mount_unit` and `raid_fs/templates/mount.unit.j2`. Round-trip parse-and-re-render must be byte-for-byte identical so the agent's observation can never disagree with a unit produced by either path.
- `/proc/self/mountinfo` lines for a typical xiNAS controller.
- `getent passwd` output covering local-only, sssd-extended, and broken (no NSS resolver) cases.
- `getent group` analogous.
- `/etc/idmapd.conf` covering Domain, Local-Realms, and Method=nsswitch.
- xinas-nfs-helper `list_exports` response JSON (from real helper output).
- xinas-nfs-helper `list_sessions` response JSON.

Target ~80% of total agent test count to live in this layer. They're fast, reliable, and pin the parse contract.

### Layer 2 — API-side tests with a mock agent

vitest + supertest, no agent process. Extend PR #201's `src/__tests__/api/_helpers.ts` with `buildTestAppWithMockAgent(scenario)`:

```ts
const setup = await buildTestAppWithMockAgent();
setup.mockAgent.respondToHealth({ status: 'healthy', collectors: { disk: 'running' } });
await setup.mockAgent.postObservation({
  deltas: [{ kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {...} }],
  complete_snapshots: ['Disk'],
});
// exercise GET endpoints; assert correct shape, audit entries, envelope warnings
```

Covers:

- `requireInternalAgent` middleware: UDS-no-bearer → 401; UDS-admin-bearer → 401; agent-bearer → 200.
- `controller_id` mismatch → 400.
- Schema validation failure → 400 with delta index.
- `complete_snapshots` reconcile: pre-existing keys not in batch get deleted; deltas in batch upserted.
- Heartbeat state transitions: simulate sequential `agent.health` calls succeeding / timing out; assert tracker state transitions and event-row emission at `/xinas/v1/events/<rfc3339_ts>/<event_id>`.
- `EXECUTOR_UNAVAILABLE` behavior on mutating routes when offline; `EXECUTOR_DEGRADED` warning injection on every envelope when degraded.
- New public routes (`/api/v1/users`, `/api/v1/groups`, `/api/v1/nfs-idmap`) return the correct envelope shapes against seeded observed state.
- `/api/v1/system` response's `agent` field reflects the tracker's current state.

### Layer 3 — End-to-end with real processes but mocked probes

A small set (~5 tests) that boot:

- A real `xinas-api` process on an ephemeral UDS.
- A real `xinas-agent` process pointing at a probe-mock module: env var `XINAS_AGENT_PROBE_MODE=fixture:/path/to/fixtures` makes `src/agent/probe/*` modules return canned data instead of running real probes.

Verifies the full data flow: agent reads fixture → emits deltas → POSTs to api → api stores → GET endpoint returns expected shape. Catches integration bugs the mock-agent layer misses (JSON-RPC framing, retry on 5xx, real socket-permission setup, controller-id-file parsing).

### Layer 4 — Manual verification on a real controller

Not in CI. Operator runs on the demo controller after install:

```bash
sudo systemctl status xinas-api xinas-agent
# Both should be active.

curl --unix-socket /run/xinas/api.sock http://localhost/api/v1/system | jq .result.node.status.agent
# Should show state: healthy, last_heartbeat_at recent, collectors all running or explicit stubs.

curl --unix-socket /run/xinas/api.sock http://localhost/api/v1/disks | jq '.result | length'
# Should match the controller's NVMe / block-device count (cross-check with lsblk).

curl --unix-socket /run/xinas/api.sock http://localhost/api/v1/network/interfaces | jq '.result[] | .id'
# Cross-check with `ip link`.

# Equivalent cross-checks per phase0-requirements §3 against xicli, NVMe tools,
# findmnt, exportfs, systemctl, ip addr, rdma link, netplan output.
```

### Coverage tooling deliverable

Per F2, no coverage tooling exists today. S0+S1 lands:

- New devDep: `@vitest/coverage-v8` compatible with the project's `vitest@^2.1.0` range (target version `^2.1.0` so the constraint floors at the same minor).
- New `package.json` script: `"test:coverage": "vitest run --coverage"`.
- `vitest.config.ts` grows:
  ```ts
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
    },
  },
  ```
- No CI thresholds. Coverage report is generated; threshold enforcement is a later opt-in once we have a baseline.

## Open questions deferred past this PR

- **xinas-nfs-helper socket permission tightening** ("only agent can connect" per ADR-0002 line 332) blocked by legacy MCP retirement (WS12).
- **Native journald structured fields** via `sd_journal_send`. Out of scope; `MESSAGE`-field JSON is sufficient for S0+S1.
- **Coverage thresholds in CI**. Tooling lands; threshold enforcement waits for a baseline.
- **Bulletproof transactional observation audit** (audit row inside batch transaction instead of best-effort middleware). Future enhancement; current middleware-driven audit is the same window every other request has.
- **Per-method authorization on the agent RPC surface**. ADR-0002 §"What this ADR does NOT decide" defers per-method auth; the socket mode + role-based api auth is the gate today.
- **Bounded concurrency in the agent's RPC dispatcher**. ADR-0002 defers concurrency policy to the task engine (S2 / WS4). S0+S1 runs RPC requests sequentially.
- **Bulk-enumeration of directory-server users** (AD / LDAP / SSSD). NSS-resolved local cache is observed; bulk-fetching is deferred to an enterprise-identity workstream.

## Related specs and ADRs

- [ADR-0001](adr/0001-api-surface.md) §Migration scope after ADR-0002 — the adapter-extraction requirement that motivates the `src/lib/parse/` vs `src/agent/probe/` split.
- [ADR-0002](adr/0002-agent-privilege-model.md) — the canonical agent design. This spec is the first concrete implementation of S0 + S1 from its Tasks list.
- [ADR-0003](adr/0003-state-store.md) §Audit semantics + §Event semantics — the canonical paths the agent's observation pushes write to, and the event-path shape (`/xinas/v1/events/<rfc3339_ts>/<event_id>`).
- [phase0-requirements.md](phase0-requirements.md) §3 — the requirement set this spec implements.
- [docs/control-path/api-v1.yaml](api-v1.yaml) — the REST contract; this PR extends it with `User`, `Group`, `NfsSession`, `NfsIdmap`, additive `Filesystem.status` fields, additive `Share.status.exports[]` (with the `ExportRule` type), `SystemdUnit` resource, `status.observed_at` on every observed kind, and the `agent` sub-object on `Node.status`.
- [docs/Installer/xinas-api-role-spec.md](../Installer/xinas-api-role-spec.md) — the existing `xinas_api` role; this PR modifies it (new dedicated group, internal-tokens.json, controller-id file).
- PR #199 (CI bootstrap), PR #200 (state store), PR #201 (api skeleton), PR #202 (biome cleanup), PR #203 (xinas_api role) — the merged foundation this PR builds on.
