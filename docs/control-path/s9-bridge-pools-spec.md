# xiNAS S9 — config-history bridge, audit query, pools (design spec)

**Status:** design (2026-06-12; conforms to **ADR-0011**). Brings the
catalog's last `degraded` entries live and retires the in-api gRPC
pool read. Implementation plan:
`docs/plans/2026-06-12-s9-bridge-pools-plan.md` (to be written via
writing-plans after this spec is approved).

**Goal.** Config-history snapshots/show/diff live via observed rows +
one diff RPC; `POST /config-history/rollback` real for the
baseline-only case as a destructive plan/apply task; `GET /audit`
queries the api's own audit data (filters + exact index lookups);
pools become a first-class resource (observe + create/modify/delete)
across REST/MCP/CLI/TUI.

**Verified integration facts (truth-checked this round).**

- `xinas_history` CLI: `snapshot list/show/create/diff` (+ `--format
  json`), `status`, `gc`, `reset-to-baseline --reason … --yes`; NO
  targeted rollback (`runner.py` implements only reset-to-baseline
  with pre-snapshot/validation/auto-rollback). Store root-only
  0700/0600 → all reads go through the agent.
- **Vocabulary drift (review P0):** public `ConfigSnapshot.kind`
  `[baseline, before, after, imported]` vs history `SnapshotType`
  `[baseline, rollback_eligible, ephemeral]`
  (`xinas_history/models.py:52`); history `RollbackClass`
  (`destroying_data|changing_access|non_disruptive`,
  `models.py:14`) is NOT the api `risk_level` enum — the dangerous
  gate fires on `destructive` only (`tasks/engine.ts`).
- `ConfigSnapshot` is public but missing from the agent `Kind` union
  (`collectors/base.ts`) and `OBSERVED_KINDS`
  (`api/observed-schemas.ts`) — the observed channel would reject it
  (review P0). Same for `Pool`.
- The agent xiRAID client already has `poolCreate/Delete/Add/Remove/
  Activate/Deactivate/poolShow` (`agent/xiraid/client.ts`); the fake
  transport models `{name, drives[], active}` and rejects deleting an
  ACTIVE pool.
- Observed arrays collapse the raw `sparepool` NAME into
  `spare_disk_ids` (`lib/parse/raid.ts:84`) — pool references are
  unanswerable from KV today (review P1).
- `audit_index` rows start with `durable_file/durable_offset = NULL`
  (backfilled by the drainer — `state/audit.ts:53`,
  `audit-drainer.ts:172`); the OpenAPI `/audit` documents only
  `request_id`/`principal`/`since` (review P1).
- The S8 catalog/dispatcher/CLI generate from one table — S9 only
  edits catalog entries and adds routes; MCP/xinasctl pick everything
  up without client work.

---

## 1. Scope

### In scope — config-history (T0–T5)

- **T0 contracts:** ADR-0011 (this commit); api-v1: `/audit`
  parameter set + `AuditEntry` schema, `Pool` schema +
  `POST /pools` + `PATCH /pools/{name}` + `DELETE /pools/{name}`,
  `ResourceRef.kind` += `Pool`, `XiraidArray.status.spare_pool`
  additive field; agent `Kind` union + `OBSERVED_KINDS` +=
  `ConfigSnapshot`, `Pool`; s0s1 RPC table += `config.diff` (Real).
- **T1 bridge verbs:** `snapshotList()`, `snapshotDiff(from, to)`,
  `resetToBaseline(reason)` on `XinasHistoryBridge` — argv + JSON
  parsing pinned by tests with a fake subprocess seam; the
  **projection table is verified here** against real manifest shapes
  (baseline→baseline, rollback_eligible→after, ephemeral→before,
  else→imported; raw `type`/`operation`/`rollback_class` ride in
  `status.history_*`).
- **T2 ConfigSnapshot collector:** 60 s poll, compare-and-skip,
  fixture passthrough (`config-snapshots.json`).
- **T3 `config.diff` RPC:** enumerated; level-validated params; the
  api route calls it with 5 s timeout → `EXECUTOR_UNAVAILABLE`
  degradation.
- **T4 routes live:** `GET /config-history/snapshots` + `/{id}` from
  KV (projection already applied agent-side); `GET
  /config-history/diff` via the RPC; the `CONFIG_HISTORY_NOT_
  INTEGRATED` warning DIES on these routes (drift untouched).
- **T5 rollback:** `config.rollback` provider (spec `{to: 'baseline',
  reason}`; `to !== 'baseline'` → blocker naming the deferral;
  `risk_level: 'destructive'`; lease `ConfigHistory/default`;
  affected `ConfigSnapshot/baseline`) + executor over
  `resetToBaseline` + route wiring replacing the stub.

### In scope — audit query (T6)

- `lib/audit-query.ts`: bounded newest-first jsonl scan with
  `kind/principal/client_type/since/until/limit` (default 100, cap
  1000); exact `request_id/operation_id/task_id` via
  `drainer.drainNow()` → `audit_index` offsets → file read, with an
  `audit_outbox` fallback for rows whose offsets are still NULL
  (review P1 — no invisibility window). Route + catalog flip.

### In scope — pools (T7–T10)

- **T7 observe:** `lib/parse/pool.ts` (normalize `poolShow` rows →
  `{name, drives, active}`); `parse/raid.ts` additionally passes the
  raw `sparepool` name through as `status.spare_pool` (review P1;
  `spare_disk_ids` unchanged); `PoolCollector` (shared xiRAID client;
  `referenced_by` computed by joining observed arrays' `spare_pool`);
  `GET /pools` re-points at KV and the gRPC pool seam is DELETED from
  read-seams (mail/auth-modes remain).
- **T8 providers:** `pool.create` (name+drives; blockers: duplicate
  name, unknown/unsafe drives), `pool.modify` (ONE intent:
  `add_drives|remove_drives|active`), `pool.delete` (blockers:
  `active`, non-empty `referenced_by`); per-resource revision pins;
  min_role: create/delete admin, modify operator.
- **T9 executors:** three executors over the existing client verbs;
  the DELETE executor preflight re-checks live `pool_show` +
  `raid_show` (active/referenced — TOCTOU vs observed lag); fake
  transport grows deterministic failure hooks where missing.
- **T10 catalog + clients:** entries flip/appear (audit.query,
  config_history.* live; pools.create/modify/delete new); MCP +
  xinasctl inherit; api-v1 description cleanups.

### In scope — TUI + e2e (T11–T12)

- **T11 TUI:** `spare_pools.py` — view from `GET /pools`
  (`referenced_by`/active columns), six actions onto the three routes
  via `plan_apply_wait` (delete keeps the consent dialog →
  `dangerous` only if the route requires; create/add/remove/activate/
  deactivate map to create/modify); `raid.py` wizard pool lookups →
  `GET /pools` (the TUI's last xiRAID gRPC call site dies).
- **T12 e2e + full gate:** scenarios §7; runbook §5c.

### Out of scope (ADR-0011 deferrals)

Targeted snapshot rollback, dbus systemd subscription, `ip_pool.py`
(netplan-based), mail/auth-modes promotion.

---

## 2. Projection (review P0 lock)

| history `type` | public `kind` | notes |
|---|---|---|
| `baseline` | `baseline` | one per store |
| `rollback_eligible` | `after` | durable post-change snapshots |
| `ephemeral` | `before` | pre-change/working captures |
| (unknown) | `imported` | forward-compat |

`status` carries `history_type`, `history_rollback_class`,
`operation`, `source`, `user`, `diff_summary` verbatim. T1's bridge
tests assert the projection against representative manifests; any
phase-encoding surprise is fixed THERE before the collector lands.

## 3. Rollback contract (T5)

```
POST /config-history/rollback
  mode=plan  spec={ to: 'baseline', reason: string }
  → blockers: to!=='baseline' (NOT_IMPLEMENTED pointer),
              baseline snapshot absent;
  risk_level: 'destructive'  (API enum — review P1; the history
  RollbackClass appears only in diff/evidence as history_rollback_class)
  lease: ConfigHistory/default (internal)
  affected: [ConfigSnapshot/baseline]
  mode=apply + dangerous=true → task → executor resetToBaseline(reason)
```

## 4. Audit query contract (T6)

`GET /audit?kind=&principal=&client_type=&since=&until=&limit=` and
`GET /audit?request_id=|operation_id=|task_id=` (exact). Exact path:
`drainNow()` → index offsets → jsonl read; NULL offsets → serve from
`audit_outbox` (review P1). Result: `AuditEntry[]` newest-first.

## 5. Pool contracts (T7–T9; review P0/P1 locks)

```
Pool: { name, drives: string[], active: boolean,
        referenced_by: string[] }   // array names via observed spare_pool
POST   /pools          {name, drives}                 plan/apply, admin
PATCH  /pools/{name}   {add_drives|remove_drives|active}  one intent, operator
DELETE /pools/{name}   blockers: active, referenced_by≠[]  admin
```

Executor delete preflight re-checks LIVE `pool_show` (active) and
`raid_show` (sparepool references) before mutating.

## 6. Component map

```
 xinas_history (python, root store)        xiraid daemon (gRPC)
        ▲ subprocess (bridge)                     ▲ shared client
 ┌──────┴──────────────── xinas-agent ────────────┴──────────────┐
 │ XinasHistoryBridge: list/diff/resetToBaseline                 │
 │ ConfigSnapshotCollector → observed ConfigSnapshot rows        │
 │ PoolCollector → observed Pool rows (referenced_by join)       │
 │ rpc config.diff   task executors: config.rollback, pool.*     │
 └──────────────▲───────────────────────────▲────────────────────┘
        observed│ push                 task │ dispatch
 ┌──────────────┴───────── xinas-api ───────┴────────────────────┐
 │ /config-history/{snapshots,diff,rollback}  /audit  /pools     │
 │ lib/audit-query (jsonl tail + index + outbox fallback)        │
 └───────────────────────────────────────────────────────────────┘
```

## 7. e2e scenarios (T12)

1. Snapshots appear as observed rows (fixture
   `config-snapshots.json`); list/show serve with the projected
   `kind` + raw `history_*` fields; diff round-trips the RPC; agent
   down → diff degrades, list/show still answer.
2. Rollback: plan with `to: 'other-id'` → blocked; `to: 'baseline'`
   plan→apply without `dangerous` → dangerous gate; with it → task
   success (fixture bridge); via MCP → `MCP_APPLY_DISABLED` by
   default.
3. Audit: recent rows filterable by kind/principal/client_type/time;
   `task_id` exact lookup finds the rollback task's rows INCLUDING a
   not-yet-drained entry (outbox fallback pin).
4. Pools: fixture pool observed → create a second pool (plan/apply)
   → modify each intent → delete blocked while active → blocked while
   referenced (array fixture with `sparepool`) → deactivate +
   unreference → delete succeeds; `GET /pools` reflects every step.
5. Clients: `xinasctl pools list/create/modify/delete` + MCP
   `pools.*` parity (same plan_hash for the same create spec);
   `config_history.snapshots` via MCP returns rows with NO warning.

## 8. Risks

- **Projection drift** if real manifests encode phase differently —
  contained at T1 (bridge tests see real shapes first).
- **referenced_by staleness** between sweeps — mitigated by the
  executor's live preflight (the blocker is best-effort UX; the
  preflight is the guarantee).
- **Audit jsonl growth**: the tail scan is bounded (read window cap);
  full-history queries are explicitly out of scope.
- **oasdiff** on the `ResourceRef.kind` + `/pools` changes — additive
  enum value + new routes should pass the additive gate; verified at
  T0 before anything else builds on it.
