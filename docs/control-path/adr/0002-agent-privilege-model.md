# ADR-0002: xinas-agent privilege model — separate root executor with typed RPC

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Sergey Platonov
- **Supersedes:** —
- **Depends on:** [ADR-0001](0001-api-surface.md), [ADR-0003](0003-state-store.md)
- **Related requirements:** [phase0-requirements.md](../phase0-requirements.md) §3, §7, §9, §10, §14

## Context

Today, `xinas-mcp` runs as root and calls `xicli`, `exportfs`, `mount`,
`netplan`, and `systemctl` directly. ADR-0001 promotes that codebase to
`xinas-api`, but does not decide whether privileged execution stays in the
API process or moves behind a boundary.

Reqs §3 is explicit:

> The agent must execute only typed operations and must not expose
> arbitrary shell execution to API, CLI, TUI, or MCP clients.

If the API process *is* the executor, the boundary is internal to one
binary and a code bug in the REST parser becomes a privilege escalation.
The requirement is not satisfied; it is renamed.

Reqs §3 also requires:

> Disable `xinas-agent` and attempt mutating API operations. They must
> fail with a clear executor-unavailable error while read-only cached
> state remains available.

This explicitly assumes the agent and API are separable.

## Decision

Phase 0 ships **two separate systemd units** with a sharp privilege
boundary between them, communicating over a local Unix socket with a
typed RPC.

### Units and ownership

| Unit                  | User                  | Owns                                                                          |
|-----------------------|-----------------------|-------------------------------------------------------------------------------|
| `xinas-api.service`   | dedicated `xinas-api` (or systemd dynamic user) | REST + MCP transports, RBAC, audit, plan/apply, task engine, **sole SQLite writer**, outbound gRPC to `xiraid-server` (read-mostly). |
| `xinas-agent.service` | `root`                | Privileged typed execution: storage CLI fallback paths, mount/umount, netplan apply, systemctl reload/restart, fs probes, calls to `xinas-nfs-helper`. **Sole producer of `/xinas/v1/observed/*` content.** |

`xinas-nfs-helper.service` continues to exist as a further-narrowed
sub-executor. The agent (not the API) is the only caller of the helper.

### Boundary table

| From → To                                  | Direction                              | Mechanism                                                                 |
|--------------------------------------------|-----------------------------------------|---------------------------------------------------------------------------|
| `xinas-api` reads observed state           | direct                                  | SQLite SELECT on `/xinas/v1/observed/*`.                                  |
| `xinas-api` issues a typed operation       | API → agent                             | Typed RPC over `/run/xinas/agent.sock` (Unix socket, 0660, root:xinas-api).|
| `xinas-agent` reports observation          | agent → API → SQLite                    | Agent calls a loopback API endpoint (`/internal/v1/observed`); API is the only SQLite writer. |
| `xinas-agent` appends task stage logs      | agent → API → SQLite                    | Same loopback path as observations.                                       |
| `xinas-agent` calls `xiraid-server`        | agent → gRPC                            | Relocated from the API process; same TLS-secured gRPC on `localhost:6066`.|
| `xinas-agent` calls `xinas-nfs-helper`     | agent → helper                          | Existing Unix socket protocol; API can no longer reach the helper directly.|
| Clients (TUI, `xinasctl`, automation)      | client → `xinas-api`                    | Loopback Unix socket (default) or localhost TCP on a high non-privileged port. Never bind to public interfaces by default. |
| Agentic clients                            | MCP client → `xinas-api`                | Existing MCP transport (per ADR-0001), bound per operator config.         |

### Why "single SQLite writer"

Having one writer simplifies WAL semantics, schema migration coordination,
and lock ordering. The agent could in principle write directly to SQLite
under WAL, but the cost (two processes that must agree on schema, migration
locks, retention) outweighs the saving (one RPC hop). Observations flow
agent → API → DB; the API does no policy work on that path — it is a thin
typed pass-through validated by JSON Schema.

### Agent RPC surface (the narrow list)

The agent exposes a fixed, enumerable set of typed methods. There is no
"run-this-shell-command" method. Categories:

- **Observation methods**: `inventory.collect`, `disks.list`, `arrays.list`,
  `filesystems.list`, `mounts.list`, `exports.list`, `network.snapshot`,
  `systemd.units_status`, `managed_files.checksums`. Idempotent; safe to
  call frequently.
- **Storage methods**: `arrays.create`, `arrays.delete`, `arrays.import`,
  `spare.set` (gRPC-backed where possible; CLI fallback inside the agent
  only).
- **Filesystem methods**: `fs.create`, `fs.mount`, `fs.unmount`, `fs.grow`,
  `fs.set_quota_mode`.
- **NFS methods**: export operations are thin pass-throughs to
  `xinas-nfs-helper` (`nfs.exports.add`, `nfs.exports.update`,
  `nfs.exports.remove`, `nfs.sessions.list`). NFS profile operations
  are agent-owned (the agent writes the modular `nfs-utils` files
  directly per ADR-0005, not via the helper) and split into three
  distinct methods: `nfs.profile.render` (compute the effective
  target file contents and diff against current), `nfs.profile.apply`
  (write the rendered files, restart/reload services per the profile's
  `service_policy`), and `nfs.profile.observe` (snapshot current
  effective state into `NfsProfile.status`).

This list is the **single source of truth** for the agent's NFS
surface. ADR-0005 documents the schema and writability matrix; the
method names here must match the methods ADR-0005 references.
- **Network methods**: `network.render_netplan`, `network.flush_managed`,
  `network.apply`.
- **Service methods**: `systemd.reload`, `systemd.restart` — only for an
  allow-listed set of unit names.
- **Lifecycle**: `agent.health`, `agent.version`.

Each method has a JSON Schema for input and output. The agent rejects
unknown methods. There is no method that accepts a raw command string,
shell fragment, or file path outside the allow-listed roots.

### Task execution envelope

The typed methods above are stateless from the agent's point of view, but
mutating operations are durable tasks (ADR-0004). To keep stage logs,
cancellation, and crash recovery coherent across the API/agent boundary,
every privileged call carries a **task execution envelope** with the
following fields:

```
task_id              UUIDv7, set by xinas-api
plan_id              ID of the plan-only task this apply derives from (or null for non-apply work)
stage_index          monotonic per task; identifies which stage this call advances
idempotency_key      passed through from the client request
deadline_ms          absolute wall-clock deadline; agent returns DEADLINE_EXCEEDED past it
correlation_id       request-tracing id from the client request
```

The agent **does not own task state**. It owns *in-flight execution
state* keyed by `task_id`: which stage is running, the live subprocess
or socket handle, partial stdout/stderr buffers, and a cancel flag.

Four envelope methods govern the lifecycle:

| Method                                               | Direction       | Purpose                                                                                                  |
|------------------------------------------------------|-----------------|----------------------------------------------------------------------------------------------------------|
| `task.begin(envelope, kind, input)`                  | API → agent     | Agent acknowledges and starts the stage. Returns either `running` with a stage handle, or a synchronous result for fast operations. |
| `task.stage_report(task_id, stage_index, ...)`       | agent → API     | Agent reports stage status, progress fraction (optional), and an output chunk. API persists into `task_stages` (ADR-0004). |
| `task.cancel(task_id)`                               | API → agent     | API requests cancellation. Agent responds `cancelled`, `cancel_refused` with reason, or `not_found`.     |
| `task.list_inflight()`                               | API → agent     | API calls this on startup. Agent returns `[{task_id, stage_index, started_at, ...}, ...]` for live work. |

#### Startup reconciliation

On `xinas-api` start (per ADR-0004's "API restart finds tasks in
`running`"):

1. API loads all tasks where `state = running` from SQLite.
2. API calls `agent.task.list_inflight()`.
3. For each running task in SQLite:
   - If the agent reports it in-flight: API resumes consuming
     `stage_report` callbacks; task continues normally.
   - If the agent does **not** report it in-flight: API transitions the
     task to `requires_manual_recovery` with
     `error_code = FAILED_STATE_DESYNC` (per ADR-0004's failure recovery
     states). Locks held by the task are released on the normal stale-lock
     sweep.
4. For each agent in-flight task **not** in SQLite (rare; should only
   happen if SQLite was restored from backup): agent receives a
   `task.cancel` with reason `unknown_task`.

This protocol is what makes ADR-0004's "API restart finds tasks in
`running`, pings the agent for each, and either resumes or transitions
to `requires_manual_recovery`" actually implementable.

#### Cancellation checkpoints

The agent honors `task.cancel` at safe checkpoints inside each method.
For multi-step methods (e.g. `network.apply` which performs flush →
render → generate → apply), the agent checks the cancel flag between
steps. For single syscalls or single subprocesses that cannot be
interrupted safely (an in-flight `mount`, a `netplan apply` that has
started reconfiguring an interface), the agent returns
`cancel_refused` with a reason that the API records in
`tasks.cancel_refused_reason`.

#### API-driven, not agent-driven

The default model is **API drives, agent executes**: the API issues
discrete `task.begin` calls per stage and the agent does not retain
cross-stage planning. The only state the agent holds across stages of
the same task is what's needed to manage in-flight work (subprocess
handles, partial output buffers). Long-running monitoring operations
(e.g. RAID rebuild progress) are an exception that may use a "watch"
RPC pattern, defined per-operation when implemented; they are not part
of Phase 0's default execution model.

### Hardening

`xinas-api.service` runs with restrictive sandboxing:

```
DynamicUser=yes              (or User=xinas-api with a non-login shell)
NoNewPrivileges=true
CapabilityBoundingSet=        (empty)
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/xinas/state /var/log/xinas
ReadOnlyPaths=/etc/xinas-api
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallFilter=@system-service
```

`xinas-agent.service` runs as root but with a narrow file/path allow-list:

```
User=root
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/run/xinas /var/log/xinas /etc/exports /etc/nfs /etc/netplan /etc/systemd/system
ProtectHome=yes
RestrictNamespaces=yes
SystemCallFilter=@system-service @mount @network-io
LockPersonality=yes
```

Exact unit settings are tuned during WS13 (packaging); the principle is:
**neither service has more rights than its job requires, and the API
service has no root capabilities at all.**

### Agent heartbeat and executor-unavailable behavior

`xinas-api` tracks the agent's last successful `agent.health` response.
States: `healthy`, `degraded` (slow/intermittent), `offline` (socket not
answering or `agent.health` failing for > N seconds).

- **Healthy / degraded**: all operations proceed; degraded surfaces a
  warning in mutating operation responses.
- **Offline**: any plan-or-apply that requires a typed agent method
  returns `EXECUTOR_UNAVAILABLE` (under the `INTERNAL` family with a
  specific code), with `remediation: "restart xinas-agent.service"`.
  Read-only operations against cached SQLite state continue to work and
  the API marks observed-state staleness explicitly:
  `agent_last_heartbeat`, `observation_age_seconds`.

This is precisely the requirement in reqs §3.

### Lifecycle and dependencies

```
[Unit]
After=network-online.target xiraid-server.service
Requires=xinas-api.service

[Service]
# (agent)
```

```
[Unit]
After=network-online.target

[Service]
# (api)
```

The API does **not** require the agent to start (so read-only cached state
remains available); the agent requires the API (because it reports
observations through the API). On boot, the API starts first, the agent
starts after, and the agent's first job is a full observation sweep that
seeds `/xinas/v1/observed/*`.

## Consequences

### Pros

- **Reqs §3 is satisfied for real.** The privilege boundary exists in the
  process topology, not in code comments.
- **Hardening is meaningful.** A compromised REST parser cannot exec a
  shell, write outside `/var/lib/xinas/state`, or escalate to root.
- **Reuses the `xinas-nfs-helper` pattern** at a higher level: typed Unix
  socket RPC, narrow method set, schema-validated inputs.
- **Phase 1 alignment.** Multi-controller HA splits the API (cluster-aware
  control plane) from the agent (per-node executor). Doing the split now
  means the architecture is already correct for Phase 1.
- **Executor-unavailable behavior falls out of the topology** rather than
  being a special case in the API code.

### Cons

- **Two systemd units instead of one.** One more thing to start, one more
  log stream. Acceptable cost for the privilege boundary.
- **One extra hop per mutating call.** API → agent over Unix socket adds
  sub-millisecond latency. Trivial against the cost of the operation
  itself (RAID create, netplan apply, mount).
- **Observation path goes agent → API → DB.** Adds a hop on the way in.
  Mitigated by batching: the agent reports multiple observation deltas in
  one RPC; the API writes them in one SQLite transaction.

### What this ADR does NOT decide

- **Wire format for the agent RPC.** JSON-over-socket is the obvious
  starting point (consistent with `xinas-nfs-helper`); upgrade to
  framed-protobuf or gRPC-over-UDS is a non-breaking future swap if
  performance demands it.
- **Per-method authorization beyond "API can call agent."** Currently the
  socket is the only gate (`0660 root:xinas-api`); methods are not further
  partitioned by role. RBAC enforcement is the API's job, not the
  agent's.
- **Whether the agent runs operations sequentially or with bounded
  concurrency.** Concurrency policy belongs in the task engine
  (ADR-0004).

## Rejected alternatives

### Option A — No separate agent (single root API process)

Rejected: does not satisfy reqs §3. Renames the existing setup. A code bug
in any transport layer becomes a privilege escalation.

### Option C — Per-domain micro-helpers (storage / network / systemd / sysctl)

Rejected for Phase 0: explosion of small daemons with no clear privilege
benefit over the agent-plus-nfs-helper split. The NFS helper exists
because `/etc/exports` has unique concurrency requirements (atomic file
rewrite under a lock); the other domains do not have that property. Sub-
helpers may be added in later phases if a sharp concurrency or privilege
boundary justifies one.

## Implementation notes for downstream workstreams

- **WS3 (xinas-agent):** Implements the typed RPC surface above. The agent
  is structured as a thin dispatcher + per-method modules (no shared
  global state, no shell-out except inside an explicitly tagged "approved
  CLI fallback" module).
- **WS1 (API contracts):** The agent's typed methods are an *internal*
  contract, not part of `/api/v1`. They are versioned independently
  (`/internal/v1/...` in the API server's reverse direction; agent
  methods are versioned via the RPC envelope).
- **WS5 (xiRAID adapter):** The gRPC client moves from the API process to
  the agent process. xiRAID TLS certs at `/etc/xraid/crt/*` are now read
  by the agent only; the API does not need them.
- **WS7 (NFS):** `xinas-nfs-helper` continues running; its socket gains a
  permission tightening — only the agent can connect. The API loses
  direct access.
- **WS13 (Packaging):** New Ansible role `xinas_agent` ships the unit
  file, creates `/run/xinas/`, sets socket permissions, configures
  hardening directives. Existing `xinas_mcp` role becomes `xinas_api`.
  Both roles add `Requires-Rebuild: xinas_api, xinas_agent` to commits
  that change unit files.
