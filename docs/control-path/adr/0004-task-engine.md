# ADR-0004: Task engine persistence — SQLite-backed, in-process, hybrid stage logs

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Sergey Platonov
- **Supersedes:** —
- **Depends on:** [ADR-0001](0001-api-surface.md), [ADR-0002](0002-agent-privilege-model.md), [ADR-0003](0003-state-store.md)
- **Related requirements:** [phase0-requirements.md](../phase0-requirements.md) §1, §4, §11

## Context

Reqs §4 mandates that all mutating operations execute as durable tasks
with stage logs, plan/apply binding, per-resource locks, idempotency, and
deterministic cancellation. Reqs §1 requires `plan`/`apply` semantics
with `expected_revision`, `idempotency_key`, and structured errors.

The three prior ADRs constrain the design space:

- ADR-0001: business logic lives in the `xinas-api` core; transports are REST and MCP.
- ADR-0002: `xinas-api` is the sole SQLite writer; `xinas-agent` executes typed methods.
- ADR-0003: live state lives in SQLite at `/var/lib/xinas/state/xinas.db` under `/xinas/v1/...`.

Given those constraints, the task engine is not a separable service — it
is a module inside `xinas-api` that persists to the same SQLite database
under `/xinas/v1/tasks/*` and `/xinas/v1/leases/*` (per the ADR-0003
rename — "leases" is the cluster-aligned name for what some systems call
"locks").

The one design question with real implementation impact is **how stage
logs are stored** when they may be small (a netplan reload, a systemctl
restart — tens of bytes) or large (RAID rebuild progress over hours —
megabytes).

## Decision

The task engine is implemented as an **in-process module of `xinas-api`**,
persisting to the same SQLite database that holds the rest of the state
store, with **hybrid stage-log storage**: small outputs inline in the
database, large outputs spilled to a per-task directory on disk.

### Persistence layout

Three new tables in `xinas.db`:

- `tasks` — one row per task (see schema below).
- `task_stages` — one row per stage of each task; stage logs inline when
  small.
- `leases` — one row per held resource lease (lock).

Plus on-disk overflow:

- `/var/log/xinas/tasks/<task_id>/stage-<n>.log.zst` — Zstandard-compressed
  stage output when it exceeds the inline cutoff.

### `tasks` table

```
task_id                     TEXT PRIMARY KEY     -- UUIDv7 (time-ordered)
kind                        TEXT NOT NULL        -- e.g. "share.create", "raid.delete"
state                       TEXT NOT NULL        -- queued|running|success|failed|cancelled|requires_manual_recovery|plan_only|imported
plan_id                     TEXT                 -- set on apply tasks; references the plan_only task this came from
idempotency_key             TEXT                 -- client-provided
principal                   TEXT NOT NULL        -- e.g. "admin:platonovsm"
client_type                 TEXT NOT NULL        -- "rest"|"mcp"|"tui"|"cli"|"automation"|"system"
request_id                  TEXT NOT NULL
correlation_id              TEXT NOT NULL
input_hash                  TEXT NOT NULL        -- sha256 of canonicalized input
plan_hash                   TEXT                 -- sha256 of the produced plan (plan-only and apply tasks)
result_hash                 TEXT                 -- sha256 of the result (success only)
state_revision_expected     INTEGER              -- highest expected revision across affected resources
state_revision_at_apply     INTEGER              -- actual revision at the moment apply started
risk_level                  TEXT NOT NULL        -- "non_disruptive"|"changing_access"|"destructive"|"unsupported_rollback"
affected_resources          TEXT NOT NULL        -- JSON array of {kind,id,revision}
snapshot_before             TEXT                 -- xinas_history snapshot id
snapshot_after              TEXT                 -- xinas_history snapshot id
cancel_requested_at         INTEGER              -- epoch ms when client asked to cancel
cancel_refused_reason       TEXT                 -- if cancellation was refused
error_code                  TEXT                 -- machine code; see "Failure recovery states" below
error_message               TEXT
remediation_hint            TEXT
created_at                  INTEGER NOT NULL
updated_at                  INTEGER NOT NULL
terminal_at                 INTEGER              -- when state became terminal
UNIQUE(idempotency_key, principal)               -- enforces idempotency
INDEX(state, kind)
INDEX(plan_id)
INDEX(created_at)
```

### `task_stages` table

```
stage_id                    INTEGER PRIMARY KEY AUTOINCREMENT
task_id                     TEXT NOT NULL REFERENCES tasks(task_id)
stage_index                 INTEGER NOT NULL
name                        TEXT NOT NULL        -- e.g. "preflight", "snapshot_before", "agent.exec", "validate"
status                      TEXT NOT NULL        -- pending|running|success|failed|skipped
started_at                  INTEGER
ended_at                    INTEGER
output_inline               BLOB                 -- present when output size <= INLINE_CUTOFF
output_path                 TEXT                 -- present when spilled; relative to /var/log/xinas/tasks/
output_size_bytes           INTEGER NOT NULL
error_code                  TEXT
error_message               TEXT
INDEX(task_id, stage_index)
```

**Inline cutoff:** 64 KiB per stage. Anything larger spills to
`/var/log/xinas/tasks/<task_id>/stage-<stage_index>.log.zst`. Empirical
tuning may revise the cutoff; it is a runtime configuration value.

### `leases` table

Backs the `/xinas/v1/leases/<resource_kind>/<resource_id>` key prefix from
ADR-0003. Phase 0 semantics are identical to plain locks; the name aligns
with Phase 2's etcd-lease mapping.

```
lease_id                    TEXT PRIMARY KEY     -- UUIDv7
resource_kind               TEXT NOT NULL        -- "disk"|"array"|"filesystem"|"share"|"nfs_profile"|"network_interface"|"service_ip"|"export_group"
resource_id                 TEXT NOT NULL
task_id                     TEXT NOT NULL REFERENCES tasks(task_id)
acquired_at                 INTEGER NOT NULL
ttl_seconds                 INTEGER NOT NULL
heartbeat_at                INTEGER NOT NULL
UNIQUE(resource_kind, resource_id)               -- one holder per resource
INDEX(task_id)
```

Lease acquisition is a single `INSERT ... ON CONFLICT DO NOTHING`. Failure
returns `CONFLICT` with the holding `task_id`.

Stale lease recovery: on `xinas-api` startup and on a periodic sweep,
leases where `heartbeat_at + ttl_seconds < now()` are deleted. The task
that held them is moved to `requires_manual_recovery` if it was still
running, since the API process restart means in-flight tasks have lost
their executor handle on the agent (per ADR-0002 startup reconciliation).

### Plan/apply binding

- **`plan`** call: produces a row with `state=plan_only`, populates
  `plan_hash`, `affected_resources`, `state_revision_expected`,
  `risk_level`, but executes no privileged work. Stages for a plan-only
  task are limited to `preflight` and `plan_render`.
- **`apply`** call: requires a `plan_id`. The engine looks up the
  plan-only task, recomputes the input hash, and verifies:
  1. The plan exists and is not terminal.
  2. The caller's `input_hash` matches the plan's `input_hash`.
  3. For each affected resource, current revision == the plan's
     `state_revision_expected`. Any mismatch yields
     `PRECONDITION_FAILED` with the stale resources listed in the
     error details.
- A successful apply creates a new task row referencing the plan via
  `plan_id`, transitions to `running`, and acquires the necessary leases
  *atomically with the revision check* inside a SQLite transaction.

### Idempotency

The `UNIQUE(idempotency_key, principal)` index makes retries a no-op:
the second insert fails with a unique-constraint violation, the engine
returns the original row, the client sees the same `task_id` and
result.

### Cancellation

- Clients set `cancel_requested_at` via a dedicated endpoint.
- The agent polls `cancel_requested_at` between stages (or at named
  checkpoints inside long-running operations).
- Non-interruptible stages (mid-RAID-create, netplan apply mid-flight)
  set `cancel_refused_reason` and continue. The task ends in its
  natural terminal state; the cancel request is recorded in the audit
  trail.

### Failure recovery states

Four distinct error codes under `state=failed`, each with a
documented remediation:

| `error_code`                       | Meaning                                                                                | Remediation hint                                                                       |
|------------------------------------|----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| `FAILED_BEFORE_CHANGE`             | Preflight failed; no system mutation occurred.                                         | Fix the input or environment and retry.                                                |
| `FAILED_PARTIAL_ROLLED_BACK`       | Partial change occurred but was reverted automatically.                                | Inspect stage logs; system is back to pre-task state.                                  |
| `FAILED_MANUAL_RECOVERY_REQUIRED`  | Partial change occurred; automatic rollback impossible or unsafe.                       | Use the named playbook in `remediation_hint`; do not retry without manual cleanup.     |
| `FAILED_STATE_DESYNC`              | System change succeeded but the post-write to the state store failed.                  | Re-run observation via agent; state store will be reconciled by the next drift sweep.  |

These are emitted as the task's `error_code`. The transport layer maps
them to API responses with the matching code under the `INTERNAL` family
unless a more specific family fits.

### "Imported" task type

Snapshots created by `xinas_history` before the task engine existed
need a `task_id` to reference. On state import, the engine creates a
synthetic task per existing snapshot with:

- `state = imported`
- `principal = "system:import"`
- `client_type = "system"`
- `kind = "import.config_history"`
- Plan/result hashes set to the snapshot's stored checksum.
- No stage rows.

This resolves the gap identified during the critique (existing snapshots
have no task ID) without inventing a "null" foreign key.

### Concurrency model

The engine processes tasks with a bounded worker pool (default 4
concurrent tasks; configurable). Within a single task, stages run
sequentially. The `leases` table is what prevents conflicting concurrent
work — two tasks targeting the same array cannot both hold the array
lease, so the worker pool serializes them on contention.

The state revision check inside the apply transaction is what prevents
TOCTOU races between plan and apply, even when the worker pool admits
many tasks in parallel.

## Consequences

### Pros

- **One database file** for state, tasks, and leases — atomic transactions
  across all of them; no two-store coordination problem.
- **Cheap reads**, expensive writes batched. Most task data (rows + small
  stage logs) lives in WAL, so observers see a consistent snapshot
  without blocking the writer.
- **Stage logs are queryable when small** (the common case) and bounded
  on disk when large (the unusual case). DB stays compact; long outputs
  stream to compressed files.
- **Plan/apply, idempotency, leases, and cancellation are all enforced by
  primary-key or unique-index constraints**, not by application-level
  bookkeeping that can drift.
- **Crash recovery is mechanical**: API restart finds tasks in `running`,
  pings the agent for each, and either resumes (agent reports task still
  in flight) or transitions to `requires_manual_recovery` (agent has no
  record).

### Cons

- **Tasks share a database with state.** A pathological task burst could
  pressure WAL; mitigated by retention/GC (ADR-0003) and by the bounded
  worker pool.
- **Stage-log retention is a separate policy** from the SQLite GC. On-disk
  spill files outlive the inline rows they were spawned by until the GC
  policy retires both.
- **No multi-process task workers in Phase 0.** The bounded pool runs
  inside `xinas-api`. If a heavy operation blocks the pool, other
  applies queue. In practice, almost all heavy work is asynchronous
  inside the agent; the API thread is just waiting on the RPC.

### What this ADR does NOT decide

- **Exact worker-pool size and per-kind quotas.** Defaults are 4
  concurrent tasks; production tuning happens during lab validation.
- **Stage-log compression algorithm.** Zstandard is the default; ADR
  may revise if a different codec wins on the storage controllers.
- **Tamper evidence for tasks.** Hash-chained audit (reqs §14) lives in
  the audit JSONL, not in the task rows; tasks reference audit entries
  by ID but are not themselves cryptographically anchored.

## Rejected alternatives

### Stage logs always on disk

Rejected: every stage read becomes a file open + decompress, including
the common case of "what was the last error message?" — a single string
that easily fits in a row. Hybrid is strictly better.

### Stage logs always inline

Rejected: a multi-hour RAID rebuild's progress stream is megabytes of
text. Stuffing that into a SQLite BLOB column inflates the database and
slows full-table operations (vacuum, backups). Spill to disk for the
unusual case keeps the DB compact.

### Task engine as a separate process

Rejected: it would need its own SQLite handle (two writers — bad), or
its own database (state and tasks now in different files — bad), or
RPC to the API for every state read (slow and pointless). The task
engine is fundamentally an in-process module that uses the same DB.

### Use a queue system (e.g., NATS JetStream, Redis)

Rejected for Phase 0: out of proportion to the actual task volume on a
storage controller. Phase 2's distributed control plane mentions NATS
JetStream as a deliverable; that's where it belongs.

## Implementation notes for downstream workstreams

- **WS4 (Task engine):** Implements this ADR. The schema above is the
  starting point; minor column additions during implementation are
  expected.
- **WS9 (Config history):** Snapshot creation hooks call into the task
  engine using the current task's ID. The `imported` task type provides
  the back-reference for snapshots created before this ADR.
- **WS13 (Packaging):** New `/var/log/xinas/tasks/` directory created by
  the `xinas_api` Ansible role; logrotate config retires spill files
  alongside the SQLite GC sweep.
- **WS14 (Test automation):** Failure-injection tests cover all four
  failure recovery states; cancellation tests cover preflight,
  reversible-stage, and non-interruptible stages.
