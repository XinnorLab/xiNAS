# S9 Config-History / Audit / Pools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the config-history/audit `degraded` catalog entries go live (snapshots/show/diff via observed rows + one RPC; baseline-only rollback as a destructive task; audit filters + index lookups on the api's own data) and pools become a first-class resource (observe + create/modify/delete) across REST/MCP/CLI/TUI, retiring the in-api gRPC pool read. Contract: ADR-0011 + `docs/control-path/s9-bridge-pools-spec.md` (review locks: observed-vs-desired freshness via `observed_freshness_ref`, typed top-level ConfigSnapshot fields, S4 imperative pattern for pools, audit outbox fallback, live delete preflight).

**Tech stack:** TS (xiNAS-MCP, vitest), Python TUI (xinas_menu + pytest), api-v1.yaml.

**Conventions (every task):** TDD; `.js` ESM suffixes; conditional spreads; per-task HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; gate per task = named tests + `npx tsc --noEmit`; full gate at T12 (all suites + biome format + markdownlint + spectral + oasdiff-additive + pytest + ruff + pyright(venv) + gitleaks main..HEAD).

---

### T0 — Contracts

- [ ] api-v1.yaml: `/audit` params (`kind,principal,client_type,since,until,limit,request_id,operation_id,task_id`) + `AuditEntry` schema; `Pool` schema `{name, drives[], active, referenced_by[]}`; `POST /pools` + `PATCH /pools/{name}` + `DELETE /pools/{name}` (MutatingRequest pattern); `ResourceRef.kind` += `Pool`; `XiraidArray.status.spare_pool` optional; `ConfigSnapshot` += optional `history_type/operation/source/diff_summary`. Spectral + oasdiff verified HERE (additive enum + routes).
- [ ] Registries: agent `Kind` union + `OBSERVED_KINDS` += `ConfigSnapshot`, `Pool`. s0s1 RPC table += `config.diff` (Real).
- [ ] Commit `feat(control-path): S9 T0 — contracts (Pool first-class, audit params, ConfigSnapshot fields, registries)`.

### T1 — Bridge verbs

- [ ] `XinasHistoryBridge` += `snapshotList()` (`snapshot list --format json`), `snapshotDiff(from,to)`, `resetToBaseline(reason)` (`snapshot reset-to-baseline --reason … --yes --format json`); fake subprocess seam tests pin argv + JSON parsing + error mapping.
- [ ] `lib/parse/config-snapshot.ts` (or bridge-local): manifest → public row projection (baseline→baseline, rollback_eligible→after, ephemeral→before, else→imported; `principal`←user, typed extras) — VERIFY against representative manifest fixtures lifted from `xinas_history/models.py` field set.
- [ ] Commit `feat(agent): S9 T1 — xinas_history bridge verbs (list/diff/reset) + manifest projection`.

### T2 — ConfigSnapshot collector

- [ ] Collector (60 s poll, compare-and-skip) emitting observed `ConfigSnapshot` rows (id = snapshot id; row carries the projected public fields); convergence wiring + fixture passthrough `config-snapshots.json`.
- [ ] Commit `feat(agent): S9 T2 — ConfigSnapshot observation`.

### T3 — config.diff RPC

- [ ] Enumerated handler `config.diff {from,to}` → bridge.snapshotDiff; param validation; dispatcher registration; fixture deps (`config-diff.json` keyed `from..to` or seam).
- [ ] Commit `feat(agent): S9 T3 — config.diff RPC`.

### T4 — Config-history read routes live

- [ ] `GET /config-history/snapshots` + `/{id}` from KV (project row → public shape); `GET /config-history/diff` via agent RPC (5 s timeout → EXECUTOR_UNAVAILABLE degrade); the NOT_INTEGRATED warning dies on these routes (snapshots stub envelope removed); route tests.
- [ ] Commit `feat(api): S9 T4 — config-history reads live (KV rows + diff RPC)`.

### T5 — Baseline rollback

- [ ] Provider `config.rollback`: spec `{to:'baseline', reason}`; blockers (`to!=='baseline'`, baseline row absent); resolves baseline id from observed rows; `risk_level 'destructive'`; affected `[ConfigSnapshot/<id>]` NO revision; `observed_freshness_ref {ConfigSnapshot,<id>,revision}`; lease `ConfigHistory/default`; enriched spec carries reason + snapshot id.
- [ ] Executor over `resetToBaseline`; route wiring replaces the stub (plan/apply + dangerous gate); engine registration; tests incl. gate matrix + MCP gating (catalog already plan_apply).
- [ ] Commit `feat(control-path): S9 T5 — baseline rollback (destructive plan/apply task)`.

### T6 — Audit query

- [ ] `src/api/handlers/audit-query.ts`: bounded newest-first jsonl scan (read-window cap ~8 MB) with kind/principal/client_type/since/until/limit (default 100, cap 1000); exact request_id/operation_id/task_id via `drainer.drainNow()` → `audit_index` offsets → file read, `audit_outbox` fallback for NULL offsets (pin: a queued-undrained row IS found). Route replaces the stub; catalog flips `audit.query` live.
- [ ] Commit `feat(api): S9 T6 — audit query (filters + exact lookups, outbox fallback)`.

### T7 — Pools observation

- [ ] `lib/parse/pool.ts` (poolShow rows → `{name, drives, active}`; tolerant of dict/list shapes); `parse/raid.ts` passes raw `sparepool` through as `status.spare_pool` (additive); `PoolCollector` (shared client; `referenced_by` joined from observed arrays at the COLLECTOR? No — referenced_by computed api-side at read time from observed arrays for freshness; pool rows carry name/drives/active only — decide in-code, document); `GET /pools` serves from KV (+referenced_by join) and the gRPC seams (`grpcPoolShow`) are DELETED from read-seams; catalog `pools.list` re-pointed.
- [ ] Commit `feat(control-path): S9 T7 — Pool observation (KV-backed /pools; gRPC read retired)`.

### T8 — Pool providers

- [ ] `src/api/plan/providers/pool.ts`: `pool.create` / `pool.modify` (one intent) / `pool.delete` (blockers active + referenced_by); S4 imperative freshness (affected no-revision, ONE observed_freshness_ref, lease `[Pool/<name>]`); engine registration; routes `POST /pools`, `PATCH /pools/{name}`, `DELETE /pools/{name}`; provider/route tests.
- [ ] Commit `feat(api): S9 T8 — pool providers + routes (create/modify/delete)`.

### T9 — Pool executors

- [ ] Three executors over client verbs (modify dispatches add/remove/activate/deactivate); DELETE preflight re-checks LIVE pool_show + raid_show; fake transport gains failure hooks where missing; wiring registration; executor tests.
- [ ] Commit `feat(agent): S9 T9 — pool executors (live delete preflight)`.

### T10 — Catalog + clients

- [ ] Catalog: `config_history.snapshots/show/diff` live; `config_history.rollback` live (baseline-only description); `audit.query` live (T6 may have done it — verify); `pools.create/modify/delete` entries (admin/operator/admin; plan_apply); descriptions cleaned. MCP/xinasctl inherit (no client code). api-v1 description cleanups (deprecated wording off /pools).
- [ ] Commit `feat(api): S9 T10 — catalog flips live + pools entries`.

### T11 — TUI

- [ ] `spare_pools.py`: view from `GET /pools` (active + referenced_by columns); create/add/remove/activate/deactivate/delete onto the three routes via `plan_apply_wait` (consent dialogs preserved; delete passes dangerous only if route demands); `raid.py` wizard pool lookups → `GET /pools`. ruff/pyright(venv)/pytest gates.
- [ ] Commit `feat(tui): S9 T11 — spare pools on the control-path API`.

### T12 — e2e + full gate

- [ ] e2e per spec §7 (snapshots observed/projected + diff + degrade; rollback gate matrix + MCP block; audit filters + undrained-row lookup; pools full lifecycle with delete blockers; client parity for pools.create). Runbook §5c. FULL gate.
- [ ] Commit `test(e2e): S9 T12 — config-history/audit/pools end-to-end + runbook`.
