# ADR-0003: State store — embedded SQLite KV for live state; xinas_history keeps the change log

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Sergey Platonov
- **Supersedes:** —
- **Depends on:** [ADR-0001](0001-api-surface.md)
- **Related requirements:** [phase0-requirements.md](../phase0-requirements.md) §2, §11

## Context

The Phase 0 plan ([docs/plans/2026-05-26-phase0-control-path-plan.md](../../plans/2026-05-26-phase0-control-path-plan.md))
calls for a local state store under `/xinas/v1/...` exposing
`get/put/patch/delete/list/watch/CAS/transaction`, with a desired/observed
split and atomic per-operation updates.

The existing [xinas_history](../../../xinas_history/) library already provides:

- A `Manifest` model (preset + playbook + extra_vars + checksums of rendered
  configs) — overlapping with "desired state."
- Drift detection comparing managed files to last-snapshot checksums.
- A transactional runner (lock → preflight → snapshot → execute → validate →
  mark → auto-rollback → release).
- Atomic-write store at `/var/lib/xinas/config-history/` (baseline + snapshots).
- A CLI (`python3 -m xinas_history`) and existing consumers in `xinas_menu`
  and the MCP server (now `xinas-api` per ADR-0001).

Without a clear decision, two natural temptations create problems:

1. **Conflate them.** Extend `xinas_history` to hold live, mutable state.
   Tempting because the on-disk layout is proven and the library ships
   today. But `xinas_history` is **snapshot-first** by design — its
   Manifest is a frozen record of a change. Retrofitting CRUD + revisioning +
   CAS + watch on top is more code than starting clean for the live path,
   and it muddles "what is true now" with "what changed and when."

2. **Build two parallel desired-state representations.** The new store
   holds `/xinas/v1/desired/<kind>/<id>` and `xinas_history` keeps writing
   Manifests of the same data. Then drift checks have two sources of truth
   and divergence is a matter of time.

## Decision

Phase 0 introduces a **new embedded KV state store** for **live state**, and
**`xinas_history` keeps its existing scope** — the change log, snapshots,
diffs, rollback classification, and drift-checksum bookkeeping. The two
stores own different problems and are kept distinct by responsibility, not
by file layout.

### Responsibility split

| Concern                                            | Owner                                                | Why                                                                                                       |
|----------------------------------------------------|------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Desired, observed, tasks, leases, events           | **New SQLite KV store** at `/var/lib/xinas/state/xinas.db` | Current, mutable; needs revisions, CAS, watch, list-by-prefix.                                            |
| Snapshots, diffs, rollback classification, drift checksums | **`xinas_history`** (unchanged on disk: `/var/lib/xinas/config-history/`) | Append-only change log; snapshot-first model already shipping.                                            |
| Audit                                              | **JSONL file** + index rows in the KV store          | Append-only + tamper-evident doesn't fit KV semantics. JSONL matches existing `mcp-audit.jsonl` format.   |

### Backend choice — SQLite

The new state store uses **SQLite in WAL mode** as the embedded backend.

- Already a system dependency on Ubuntu 22.04/24.04.
- Transactional CAS via `UPDATE ... WHERE revision = ?`.
- WAL mode allows concurrent reads while one writer (`xinas-api`) holds the
  write path.
- Single file: trivial to back up, ships in the support bundle, debuggable
  with the `sqlite3` CLI.
- Schema migrations are well-understood.

The store is wrapped by a **KV interface** that exposes
`get/put/patch/delete/list/watch/CAS/transaction`. This interface — not the
SQLite schema — is what other components depend on.

### Key layout (locked)

The `v1` prefix is the **data-layout version**, not the deployment phase.
A breaking schema change is a `v2` migration; the layout below is intended
to be the permanent shape across Phase 0 → Phase 2 (clustered) and is
deliberately shaped to match the cluster terminology in the architecture
proposal (`Cluster`, `Node`, `ExportGroup`, `ServiceIP`, `Lease`) so
Phase 2 does **not** require a semantic migration of existing keys.

```
/xinas/v1/cluster                              Singleton: mode (single_node|active_passive|...),
                                                capability flags, member-node hash. Phase 0 sets
                                                mode=single_node and capabilities.ha=not_enabled.

/xinas/v1/nodes/<node_id>                      Per-node record. Replaces the older
                                                /xinas/v1/controllers/<controller_id> shape;
                                                node_id = the persisted controller_id from ADR-0001.
                                                In Phase 0 there is exactly one node row.

/xinas/v1/desired/<kind>/<id>                  Phase-0 kinds: Filesystem, Share, NfsProfile,
                                                ExportGroup (singleton "default" in Phase 0),
                                                NetworkInterface, ServiceIP (placeholder; not
                                                migrating in Phase 0), XiraidArray, Disk.

/xinas/v1/observed/<kind>/<id>                 Mirror of /desired/<kind>/<id>, written exclusively
                                                by xinas-agent through the API (per ADR-0002).

/xinas/v1/observed/managed_files/<path>        File checksums (drift input). The agent posts these;
                                                xinas_history compares against last snapshot.

/xinas/v1/tasks/<task_id>                      Durable task records (ADR-0004).
/xinas/v1/events/<rfc3339_ts>/<event_id>       Time-ordered events.

/xinas/v1/leases/<resource_kind>/<resource_id> Resource locks (TTL + heartbeat backed). Named
                                                "leases" rather than "locks" to match cluster
                                                terminology; semantically identical in Phase 0,
                                                but Phase 2 will treat them as etcd leases.

/xinas/v1/audit_index/<request_id>             Pointers into the audit JSONL (see "Audit semantics").
```

Placeholder kinds in Phase 0:

- **Cluster** — singleton; writable fields are minimal in Phase 0
  (display name, locality tag). HA-shaped fields (`mode`, `quorum`,
  `witness`) are read-only and return `single_node` / `not_enabled`.
- **ExportGroup** — singleton `default` in Phase 0. Every share belongs
  to the default group. Phase 1+ HA splits shares across groups that
  fail over together.
- **ServiceIP** — represented as a kind so Phase 0 can already plan IP
  pool entries (the existing IP-pool work) without changing the schema.
  Phase 0 may not implement service-IP migration logic; the placeholder
  ensures Phase 1 doesn't move keys.
- **Lease** — Phase 0's resource lock layer (ADR-0004's `locks` table)
  writes through this prefix in the KV abstraction. Phase 2's etcd
  swap maps it onto native etcd leases without key renaming.

Renames from the original draft of this ADR:

- `controllers/<controller_id>` → `nodes/<node_id>`
- `locks/...` → `leases/...`

`xinas_history` continues writing under `/var/lib/xinas/config-history/` in
its existing layout. The state store **references** snapshots by snapshot ID
in task and event records; it does not duplicate snapshot content.

### Object revisioning

Every object in the KV store carries:

- `revision` (monotonic per key, incremented on every put/patch)
- `created_at`, `modified_at` (RFC 3339 UTC)
- `owner` and `source` metadata (which task/principal wrote the value)
- `validation_status` (per [reqs §2](../phase0-requirements.md#2-local-desireddobserved-state-store))

CAS is enforced by `UPDATE ... WHERE revision = expected_revision`. Stale
writes return `PRECONDITION_FAILED` per the error model.

### Drift detection rewire

Today, [xinas_history/drift.py](../../../xinas_history/drift.py) reads
managed files directly and compares to last-snapshot checksums.

After this ADR: `xinas-agent` is the only producer of file checksums; it
writes them to `/xinas/v1/observed/managed_files/<path>`. Drift compares
these observed checksums to the last snapshot's checksums. The
`xinas_history.drift` API surface is unchanged for consumers; only the
input pipe moves. Existing drift policies (`ADOPT`, `BLOCK`, `OVERWRITE`,
`WARN_AND_CONFIRM`) stay where they are.

### Cluster compatibility (Phase 2 forward-look)

The KV interface (`get/put/patch/delete/list/watch/CAS/transaction`) maps
cleanly onto both SQLite and etcd. Phase 0 commits to the **interface and
the key layout**; the backend is a replaceable implementation detail.

When Phase 2 introduces a clustered control plane, the backend swaps from
SQLite to multi-member etcd. Object schemas, key prefixes, and revision
semantics remain identical. Watch semantics will sharpen (etcd push vs.
SQLite poll/fsnotify) but Phase 0 watchers are limited (TUI screen
refreshes, drift detector) and tolerate either model.

### Retention and on-disk bound (per reqs §15)

The state store has a documented retention policy:

- **Tasks:** keep terminal-state tasks for 30 days (configurable); older
  tasks moved to a compressed archive under `state/archive/tasks-YYYYMM.jsonl.gz`
  and pruned from the active table.
- **Events:** ring-buffered at 100k entries (configurable); overflow rolls
  into the archive on the same schedule as tasks.
- **Audit index:** retained for the lifetime of the underlying audit JSONL
  (separate retention, see ADR-0002 / audit consolidation work).
- **Leases:** TTL-bound; an `xinas-api` startup sweep clears expired leases (the rows under `/xinas/v1/leases/*`, backed by the `leases` SQLite table in ADR-0004).

The bound is enforced by a periodic GC job inside `xinas-api`. The support
bundle includes the active store file, the most recent archive, and the
GC log.

### Audit storage and semantics

Audit is **not** in the KV store. It is a single canonical JSONL file at
`/var/log/xinas/audit.jsonl` with hash-chained entries (extending the
existing `mcp-audit.jsonl` format). The KV store holds `audit_index` rows
mapping `request_id` / `operation_id` / `task_id` to byte offsets in the
JSONL, so queries are fast and the JSONL itself stays append-only.

The current implementation in `xiNAS-MCP/src/middleware/audit.ts` has two
behaviors that Phase 0 must change: hash chaining resets to zeros on
process start, and write failures are swallowed. The accepted semantics
for Phase 0 are:

#### Hash chain

Each entry includes:

```
prev_hash    sha256 of the previous entry's serialized form (or the genesis hash)
hash         sha256 of (prev_hash || canonical(this_entry_without_hash_field))
```

The chain links every entry to its predecessor and forms a tamper-evident
sequence. The hash function and canonicalization rules are fixed at
`v1` (sha256 + JCS-style canonical JSON) and documented in
`docs/control-path/audit-format.md` (to be written alongside the
implementation).

#### Tail-hash recovery on start

On `xinas-api` start:

1. If `/var/log/xinas/audit.jsonl` exists and is non-empty, read its last
   complete line, validate the JSON, extract `hash`, and use that as
   `prev_hash` for the next write. Truncated or invalid trailing lines
   are rejected: the API refuses to start and emits a structured error
   pointing the operator at the audit log for manual inspection. This
   refuses to write into a corrupt chain rather than silently restarting
   it.
2. If the file does not exist, the next entry's `prev_hash` is the
   genesis hash, defined as `sha256("xinas-audit-genesis-v1-" || node_id)`
   where `node_id` is the persisted controller identity.

The behavior of resetting to zero on every start is **not acceptable**:
it severs the chain and makes tamper evidence meaningless across
restarts.

#### Rotation and compression

Rotation triggers (whichever comes first):

- **Size**: 256 MiB (configurable, lower bound enforced).
- **Time**: daily at 00:00 UTC.

Rotation procedure:

1. The current `audit.jsonl` is closed. Its final line's `hash` is
   captured as `tail_hash`.
2. The file is renamed to `audit.jsonl.YYYYMMDD-N` and compressed with
   Zstandard to `audit.jsonl.YYYYMMDD-N.zst` (lossless). Compression is
   performed atomically; the uncompressed file is removed only after the
   compressed file is verified.
3. A new `audit.jsonl` is created. Its first line is a `kind: rotation`
   entry with:
   - `prev_file: audit.jsonl.YYYYMMDD-N.zst`
   - `prev_file_tail_hash: <tail_hash>`
   - `genesis_hash: sha256("xinas-audit-rotation-v1-" || prev_file_tail_hash)`
   This entry's own `hash` becomes the `prev_hash` for the next regular
   entry. The chain is preserved across the file boundary.
4. The `audit_index` rows for entries in the rotated file are updated
   with a `file` pointer naming the rotated archive; queries spanning a
   rotation read both files.

Rotated archives are retained per the support-bundle policy (default 90
days; configurable; aged-out archives moved to long-term storage per
operator policy).

#### Atomic audit via outbox pattern

A file append + `fsync()` cannot participate in a SQLite transaction.
An earlier draft of this ADR said the API "writes audit in the same
SQLite transaction that flips the task terminal." That is impossible;
the two I/O paths cannot be made atomic from the application's point of
view. This section specifies the correct mechanism.

Phase 0 uses the **transactional outbox pattern**. Audit entries land
atomically in a SQLite table; a single-threaded drainer copies them to
the JSONL file with `fsync()` and only then marks them durable.

##### `audit_outbox` table (lives in `xinas.db`)

```
audit_seq            INTEGER PRIMARY KEY AUTOINCREMENT   -- ordering within the chain
entry_json           BLOB    NOT NULL                    -- the canonicalized audit entry
prev_hash            BLOB    NOT NULL                    -- the chain's prev_hash at write time
hash                 BLOB    NOT NULL                    -- the entry's own hash
queued_at            INTEGER NOT NULL                    -- epoch ms when written into outbox
drain_state          TEXT    NOT NULL DEFAULT 'pending'  -- pending | durable
durable_at           INTEGER                              -- epoch ms when JSONL fsync returned
durable_file         TEXT                                 -- audit.jsonl or audit.jsonl.YYYYMMDD-N.zst
durable_offset       INTEGER                              -- byte offset within the durable file
```

##### Write path (mutating operation)

In **one SQLite transaction** that commits the task's terminal state:

1. Insert the audit entry into `audit_outbox` with `drain_state='pending'`.
   Compute `hash` from `prev_hash || canonical(entry_json)` where
   `prev_hash` is the highest `hash` currently in the outbox (or the
   tail-hash of the durable JSONL on cold start). The insertion is
   ordered by `audit_seq`.
2. Update the task row to its terminal state.
3. Insert the matching `audit_index` row with `audit_seq` as the index
   and `drain_state='pending'` reflected.

The transaction either commits both the task terminal state and the
queued audit entry, or it rolls back both — atomically, at the SQLite
level. The client may now be told "success."

##### Drain path (background worker)

A single-threaded drainer inside `xinas-api`:

1. Reads pending rows ordered by `audit_seq`.
2. Appends each entry to `/var/log/xinas/audit.jsonl` (or the active
   rotated file).
3. Calls `fsync()` on the JSONL file descriptor.
4. In one SQLite transaction: sets `drain_state='durable'`, `durable_at`,
   `durable_file`, `durable_offset` for that row, and updates the
   matching `audit_index` row.
5. Optionally prunes the `audit_outbox` row once a configurable retention
   has elapsed (e.g. 24 hours of durable rows) — the durable copy in
   JSONL is authoritative; the outbox row exists for crash recovery.

The drainer runs continuously with a short idle sleep. It also drains
**before serving any read traffic on startup** (see "Crash recovery"
below) and **synchronously upon a terminal-state commit** so an
operator polling the task sees `drain_state='durable'` quickly.

##### Crash recovery

On `xinas-api` start:

1. The drainer runs to completion against any `audit_outbox` rows still
   in `drain_state='pending'`. These are entries that were committed to
   SQLite before crash but never made it to the JSONL.
2. The tail-hash on the JSONL after recovery becomes the `prev_hash` for
   any subsequent regular entries.
3. Only after the outbox is drained does `xinas-api` begin accepting
   requests. This guarantees no chain forks: when clients see "success,"
   the durable JSONL reflects that success.

If the JSONL is unwritable on startup (disk full, permission error), the
API refuses to start and emits a structured error. This is consistent
with the tail-hash-recovery rule above.

##### Write-failure behavior at request time

- **Mutating operations**: the request's audit entry is queued into the
  outbox in the same transaction as the task terminal state. If the
  transaction itself fails (constraint violation, disk full inside the
  SQLite WAL), the API returns `INTERNAL` with code
  `AUDIT_QUEUE_FAILED` and the task transitions to
  `requires_manual_recovery` with `error_code = FAILED_STATE_DESYNC`
  (per ADR-0004). The action is **not** claimed as successful.
- **JSONL drain failures** (later, asynchronously): the drainer logs to
  the journal, surfaces a `Warning` on subsequent responses
  (`audit_drain_degraded`), and emits a health-check failure. Mutating
  requests continue to be queued — the outbox is the durable buffer —
  but operators are alerted that the JSONL is not catching up.
- **Read-only operations**: audit queue is best-effort. A failure
  surfaces a `Warning` on the response; reads are not denied. Failures
  are themselves audited (best effort) into the journal.

Swallowing write failures, as in the current implementation, is
**explicitly disallowed**.

## Consequences

### Pros

- **Clear separation of "now" and "what changed."** No conflation of live
  CRUD with the change log; no duplication of desired state.
- **Phase 0 ships a single backend** the team can operate (SQLite is
  already a known quantity).
- **Cluster path stays open.** Swapping to etcd in Phase 2 changes the
  backend, not the keys, schemas, or APIs.
- **`xinas_history` keeps doing what it does well** — snapshots, diffs,
  rollback classification, drift policies — without being warped into a
  live store.
- **Audit stays in a format support already knows** and can be tamper-evidenced
  independently.

### Cons

- **Two stores on disk** (`xinas.db` + `config-history/`) — but this is the
  reality today (config-history + `/var/log/xinas/*audit*`) and the
  responsibility split is clean.
- **Drift detection wire change.** Existing direct-read in `xinas_history.drift`
  becomes a KV-fed pipeline. Must be done atomically with the cutover so we
  don't lose drift coverage mid-migration.
- **Watch semantics weaker than etcd.** SQLite needs polling or fsnotify; for
  Phase 0 this is sufficient but is a known limitation when Phase 2 adds
  many watchers.

### What this ADR does NOT decide

- **xinas-agent privilege model and IPC.** How the agent writes to
  `/xinas/v1/observed/*` (direct SQLite access vs. through `xinas-api` over
  a Unix socket) — see ADR-0002.
- **Task engine internals.** What columns the `tasks` table has, how stage
  logs are persisted, how plan/apply binding is enforced at the SQL layer —
  see ADR-0004.
- **Audit consolidation timeline.** Renaming and unifying the two existing
  audit sinks happens as a tracked work item; this ADR fixes only the
  end-state shape.

## Rejected alternatives

### Option B — Extend `xinas_history` to be the live state store

Rejected: the library was designed snapshot-first. Adding CRUD + revisioning +
CAS + watch is more code than starting clean for the live path, and it
muddles two distinct responsibilities. The duplication-risk critique stays
unresolved.

### Option C — Single-member etcd from day one

Rejected: etcd's value is quorum; a single-member cluster on a storage
controller carries operational and binary-footprint cost for zero Phase 0
benefit. The future-cluster-compat goal is satisfied by interface
commitment, not by running etcd locally now.

### Option D — Two stores, no separation rule

Rejected: this is effectively what the original plan implied. It is the
worst of all worlds — duplicated desired state, two drift paths, no clear
owner.

## Implementation notes for downstream workstreams

- **WS1 (API contracts):** Object schemas and the KV interface from this ADR
  drive the OpenAPI v1 shapes. Watch semantics are exposed as
  `GET /api/v1/<resource>?watch=true` with long-poll or SSE — backend-agnostic.
- **WS2 (Local state store):** Implements the KV interface against SQLite,
  the key layout above, and the retention/GC policy.
- **WS3 (xinas-agent):** Writes observed state via the API (not directly to
  SQLite); exact transport in ADR-0002. The agent is the only producer of
  `/xinas/v1/observed/*` keys.
- **WS9 (Config history, rollback, drift):** Existing `xinas_history` API
  surface unchanged for consumers; drift input pipe moves from direct file
  read to KV observed state. Snapshot creation hooks tie to task IDs once
  ADR-0004 lands.
- **WS13 (Packaging):** New systemd unit dependencies — `xinas-api.service`
  requires `/var/lib/xinas/state/` to exist; Ansible role for `xinas-api`
  creates the directory with correct ownership/permissions.
