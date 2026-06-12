# ADR-0011: Config-history bridge, audit query, pools (S9)

**Status:** accepted (2026-06-12). Extends ADR-0002 (one new enumerated
agent RPC, three new task kinds), ADR-0004 (executors), ADR-0010 (the
catalog's last `degraded` entries go live; one deprecated gRPC read
retires).

## Context

After S8, three surfaces remain stubbed or deprecated: the
config-history endpoints (warning stubs), `GET /audit` (empty stub),
and `GET /pools` (the read-only in-api gRPC exception). Verified facts
this ADR is designed against:

- `xinas_history` has NO targeted-rollback command — the CLI offers
  `snapshot list/show/create/diff`, `status`, `gc`, and
  `reset-to-baseline` (the one rollback the transactional runner
  implements, with pre-change snapshot + validation + auto-rollback).
- The store (`/var/lib/xinas/config-history`) is root-only (0700/0600)
  — the unprivileged api cannot read it; everything flows through the
  agent.
- **Vocabulary drift is real (review P0):** the public
  `ConfigSnapshot.kind` enum is `baseline | before | after | imported`
  while `xinas_history` `SnapshotType` is
  `baseline | rollback_eligible | ephemeral`, and its `RollbackClass`
  (`destroying_data | changing_access | non_disruptive`) is NOT the
  api's `risk_level` enum (whose dangerous gate fires only on
  `destructive` — review P1).
- `ConfigSnapshot` is in the PUBLIC ResourceRef enum but absent from
  the agent `Kind` union and the api observed-schema registry — the
  observed channel would reject the rows today (review P0).
- `Pool` exists nowhere in the contracts: no schema, no mutating
  routes, not in `ResourceRef.kind` (review P0/P1). The agent's xiRAID
  client already implements all six pool verbs + `poolShow`; the fake
  transport models `{name, drives[], active}`.
- Observed arrays COLLAPSE the raw `sparepool` name into
  `spare_disk_ids` — the pool name is lost, so "is this pool
  referenced?" cannot be answered from KV today (review P1).
- `audit_index` rows are inserted with `durable_file/durable_offset =
  NULL` and backfilled by the drainer — an exact lookup cannot rely on
  offsets alone (review P1). The current `/audit` OpenAPI documents
  only `request_id`, `principal`, `since`.
- Scope locks from the design round: reads + **baseline-only**
  rollback; observed rows + one diff RPC; audit filters + index
  lookups; pools observation AND the six mutations (as three
  operations).

## Decision — config-history reads (observed rows + one RPC)

The agent's `XinasHistoryBridge` grows `snapshotList()`
(`snapshot list --format json`). A `ConfigSnapshotCollector` polls it
(60 s, compare-and-skip) and pushes observed **`ConfigSnapshot`** rows;
`GET /config-history/snapshots` and `/{id}` serve from KV. Both
registries grow: the agent `Kind` union and the api observed-schema
list accept `ConfigSnapshot` (review P0).

**Projection table (review P0)** — public `kind` from history `type`,
with NOTHING lost (the raw fields ride in `status`):

| history `type` | public `kind` |
|---|---|
| `baseline` | `baseline` |
| `rollback_eligible` | `after` |
| `ephemeral` | `before` |
| anything else | `imported` |

`status` carries the raw `type`, `operation`, `rollback_class`
(history vocabulary, clearly named `history_*`), `source`, `user`,
`diff_summary`. T1 VERIFIES this projection against real manifests in
the bridge tests; if pre/post phase turns out to be encoded elsewhere
(e.g. `operation` suffixes), the table is corrected there before the
collector lands.

Diffs are on-demand: ONE enumerated RPC **`config.diff {from, to}`**
wrapping `snapshot diff --format json`; the route calls it with a 5 s
timeout and degrades with `EXECUTOR_UNAVAILABLE`.

## Decision — rollback (baseline-only, destructive)

`POST /config-history/rollback` becomes the real `config.rollback`
plan/apply operation with spec `{to: 'baseline', reason}`. Any other
target → a blocker naming the deferral (targeted rollback needs new
python in the transactional runner — its own slice).
`risk_level: 'destructive'` — the API enum the central dangerous gate
fires on; the history library's `destroying_data` RollbackClass is
reported in the diff/evidence, never used as a risk level (review P1).
Internal lease `ConfigHistory/default` serializes it;
`affected_resources` pins `ConfigSnapshot/baseline`. The executor
calls the new bridge verb `resetToBaseline(reason)`
(`snapshot reset-to-baseline --reason … --yes`); the runner's own
pre-change snapshot + validation + auto-rollback are the host-side
safety. Via MCP it is `plan_apply` + `requires_mcp_apply: true` like
every mutator.

## Decision — audit query (api-side)

`GET /audit` is implemented over the api's OWN data:

- **Tail filters:** `kind`, `principal`, `client_type`, `since`,
  `until`, `limit` (default 100, cap 1000) over a bounded read of the
  audit jsonl (newest-first).
- **Exact lookups:** `request_id`, `operation_id`, `task_id` resolve
  via the sqlite `audit_index`. Because index offsets are NULL until
  the drainer backfills them (review P1), the handler first calls
  `drainer.drainNow()`, then reads offsets; rows STILL pending (e.g.
  drain failure) are served from `audit_outbox` directly — no lookup
  window where a just-written entry is invisible.
- api-v1 `/audit` gains the full parameter set (extending the current
  `request_id`/`principal`/`since`) and an `AuditEntry` response
  schema. Additive.

## Decision — pools (first-class contracts; review P0/P1)

Pools stop being a deprecated read and become a first-class resource:

- **Contracts:** api-v1 gains a `Pool` schema
  (`{name, drives: string[], active: boolean, referenced_by: string[]}`
  — `referenced_by` lists array names whose spare pool is this pool),
  `ResourceRef.kind` gains `Pool`, and three mutating routes are
  contracted: `POST /pools` (create: name + drives, plan/apply),
  `PATCH /pools/{name}` (ONE intent per call:
  `add_drives | remove_drives | active: true|false`),
  `DELETE /pools/{name}`. Both internal registries (agent `Kind`,
  api observed schemas) gain `Pool`.
- **Observation:** `lib/parse/pool.ts` normalizes `poolShow`; a
  `PoolCollector` rides the shared xiRAID client. `GET /pools` serves
  from KV — the in-api gRPC pool read RETIRES (mail/auth-modes remain
  the only deprecated reads).
- **Reference tracking (review P1):** observed `XiraidArray.status`
  gains the raw `spare_pool` NAME (additive — `spare_disk_ids` keeps
  its S4 semantics), and the pool rows' `referenced_by` derives from
  it. `pools.delete` BLOCKS when `active` OR `referenced_by` is
  non-empty; the executor preflight ADDITIONALLY re-checks live
  `raid_show`/`pool_show` before mutating (TOCTOU — observed state may
  lag a just-created array).
- **Executors:** three executors over the existing client verbs
  (create; modify dispatching add/remove/activate/deactivate;
  delete), fake-transport e2e. min_role per the legacy matrix:
  list viewer, modify operator, create/delete admin.

## Decision — clients

Catalog flips: `audit.query`, `config_history.snapshots/show/diff` →
`live`; `config_history.rollback` → live (baseline-only documented);
`pools.list` re-points at the KV-backed route; `pools.create/modify/
delete` appear. MCP + xinasctl inherit everything (generated). TUI:
`spare_pools.py` retargets fully — the view from `GET /pools`, the six
actions onto the three routes via `plan_apply_wait` (delete/create
dangerous-consent dialogs preserved); `raid.py`'s wizard pool lookups
move to `GET /pools`, deleting the TUI's last xiRAID gRPC call site.

## Deferred

Targeted snapshot rollback (python runner work), the dbus systemd
subscription, the netplan-based `ip_pool.py` screen, mail/auth-modes
read promotion to agent-observed data.

## Testing

Bridge: pytest-style fixtures are NOT applicable (TS bridge) — vitest
with a fake subprocess seam pinning the CLI argv + JSON parsing + the
projection table. Collector: compare-and-skip + fixture passthrough.
Routes: KV-served reads; diff RPC degradation; rollback gate matrix
(dangerous flag, MCP gate, lease serialization). Audit: tail filters,
the drain-then-index path, and the outbox fallback (a queued-undrained
entry IS findable). Pools e2e: observe → create → modify (each intent)
→ delete-blocked (active, then referenced) → deactivate+unreference →
delete; TUI client tests against the stub server.
