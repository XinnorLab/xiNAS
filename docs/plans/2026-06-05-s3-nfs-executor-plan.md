# S3 — Real NFS executor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **The authoritative contract is `docs/control-path/s3-nfs-executor-spec.md`** — read the cited spec section for each task; this plan sequences the work and pins file paths/tests, the spec carries the detailed behavior.

**Goal:** Make the NFS desired-state surface (shares + idmapd, then nfs-profile) real through the S2 task engine, via imperative per-verb PlanProvider+Executor pairs that drive the existing `xinas-nfs-helper`.

**Architecture:** First land a generic **engine foundation** (N0/N0b): durable plan-binding, an explicit desired-mutation contract with Model-R revert, a freshness/lease contract split, public-column stripping, and the ExportRule observed-id repair. Then build the NFS-specific compile lib (N1), helper ops (N2), executors (N3), providers (N4), routes (N5), e2e (N6), and finally the ADR-0005 nfs-profile renderer (N7).

**Tech Stack:** TypeScript (`module:Node16`, `exactOptionalPropertyTypes`), Express 5, better-sqlite3, vitest + supertest, biome 1.9.4; Python 3 (nfs-helper, pytest); all under `xiNAS-MCP/` + `xinas_history/` + `docs/`.

**Conventions (every task):** TDD (failing test first). ESM `.js` imports. Conditional-spread for optional fields. Inject clocks/ids for determinism. Run from `xiNAS-MCP/`: `npx tsc --noEmit`, the task's vitest file, `npm run lint`, `npm run format:check`; `npm run test:contracts` whenever api-v1.yaml changes. HEREDOC commits ending `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Stage only the task's files (never `git add -A`). **No `Requires-Rebuild` trailer anywhere in S3** (spec §6 — helper is MCP Python the update flow restarts). The known-flaky `subprocess-monitor.test.ts` is the only acceptable full-suite failure (re-run isolated to confirm).

---

## File structure (locked)

| File | Responsibility | Phase |
|---|---|---|
| `xiNAS-MCP/src/state/migrations/004-task-plan-binding.sql` | add `tasks.plan_binding TEXT` + `tasks.desired_rollback TEXT` | N0 |
| `xiNAS-MCP/src/api/tasks/types.ts` (mod) | `Task.plan_binding?`, `Task.desired_rollback?`, `DesiredMutation` | N0 |
| `xiNAS-MCP/src/api/tasks/store.ts` (mod) | persist/read the two columns | N0 |
| `xiNAS-MCP/src/api/plan/engine.ts` (mod) | `PlanResult` new fields; write `plan_binding`; fold into `plan_hash` | N0 |
| `xiNAS-MCP/src/api/tasks/engine.ts` (mod) | `ApplyPlan` new fields; apply `desired_mutations`+capture `desired_rollback`; freshness/lease split; revert | N0 |
| `xiNAS-MCP/src/api/tasks/progress.ts` (mod) | terminal-failed → revert `desired_rollback` | N0 |
| `xiNAS-MCP/src/api/routes/tasks.ts` (mod) | strip `spec`+`plan_binding`+`desired_rollback` (REST + SSE) | N0 |
| `xiNAS-MCP/src/api/routes/reference.ts` (mod) | `toApplyPlan` reconstructs from `plan_binding` | N0 |
| `xiNAS-MCP/src/lib/nfs-export-id.ts` | `encExportId(path)` / `decExportId(id)` (canonicalize-then-strip) | N0b |
| `xiNAS-MCP/src/agent/collectors/nfs.ts` (mod) | emit `ExportRule` id = `encExportId(path)` | N0b |
| `xiNAS-MCP/src/api/routes/nfs.ts` (mod) | Share→ExportRule join keys on `encExportId(path)` | N0b |
| `xiNAS-MCP/src/lib/nfs-exports.ts` | `compileShareToExportEntry(share)` (options[]-based) | N1 |
| `xiNAS-MCP/nfs-helper/nfs_idmap.py` | `set_idmapd_domain` op | N2 |
| `xiNAS-MCP/nfs-helper/nfs_helper.py` (mod) | dispatch `set_idmapd_domain` | N2 |
| `xinas_history/collector.py` (mod) | add `/etc/idmapd.conf` to `CHECKSUM_TARGETS` | N2 |
| `xiNAS-MCP/src/agent/task/nfs-helper-client.ts` | typed write wrappers over the helper UDS | N3 |
| `xiNAS-MCP/src/agent/task/nfs-executor.ts` | `share.*` + `nfs-idmap.set` executors | N3 |
| `xiNAS-MCP/src/agent/task/wiring.ts` (mod) | register NFS executors | N3 |
| `xiNAS-MCP/src/api/plan/providers/nfs.ts` | `share.*` + `nfs-idmap.set` providers | N4 |
| `xiNAS-MCP/src/api/routes/nfs-mutate.ts` | the mutating routes | N5 |
| `docs/control-path/api-v1.yaml` (mod) | add `PATCH /nfs-idmap` | N5 |
| `xiNAS-MCP/src/__tests__/e2e/nfs-roundtrip.test.ts` | e2e with stub helper | N6 |
| `xiNAS-MCP/nfs-helper/nfs_profile.py` + executor/provider/route (N7) | ADR-0005 renderer | N7 |

---

## Phase N0 — engine foundation (spec §5)

> The largest phase; every future real executor depends on it. Reference/S2 tasks must stay green throughout (new fields default to null/absent).

### Task N0.1 — migration 004 + store columns
**Files:** Create `xiNAS-MCP/src/state/migrations/004-task-plan-binding.sql`; Modify `xiNAS-MCP/src/api/tasks/types.ts`, `xiNAS-MCP/src/api/tasks/store.ts`; Test `xiNAS-MCP/src/__tests__/api/tasks/store.test.ts`.

- [ ] **Step 1 — failing test:** in `store.test.ts`, create an apply task with `plan_binding: { observed_freshness_ref: { kind:'ExportRule', id:'mnt/data', revision:3 } }` and `desired_rollback: [{ key:'/xinas/v1/desired/Share/s1', prior_value:null }]`; `store.get(id)` → assert both round-trip (deep-equal); a task without them → both `undefined`.
- [ ] **Step 2 — run, fail** (`npx vitest run src/__tests__/api/tasks/store.test.ts`).
- [ ] **Step 3 — migration:** SQL mirrors `002`'s header + `ALTER TABLE tasks ADD COLUMN plan_binding TEXT;` and `ALTER TABLE tasks ADD COLUMN desired_rollback TEXT;` (additive, version-gated).
- [ ] **Step 4 — store:** add `plan_binding?: unknown` + `desired_rollback?: unknown` to `Task` (types.ts) and `export interface DesiredMutation` (`{ key:string; value:unknown } | { key:string; delete:true }`); add `spec`-style JSON columns to `INSERT_TASK_SQL`, `TaskRow`, `insertTask` (serialize `!== undefined ? JSON.stringify : null`), `rowToTask` (conditional-spread `JSON.parse`), and `TaskPatch` (so `transition` can write them).
- [ ] **Step 5 — run, pass.** **Commit:** `feat(api): N0.1 — migration 004 (plan_binding + desired_rollback) + store`.

### Task N0.2 — PlanResult/ApplyPlan fields + persist plan_binding + plan_hash
**Files:** Modify `xiNAS-MCP/src/api/plan/engine.ts`, `xiNAS-MCP/src/api/tasks/engine.ts`; Test `xiNAS-MCP/src/__tests__/api/plan/engine.test.ts`.

- [ ] **Step 1 — failing test:** a fake provider returning `observed_freshness_ref`/`lease_resources`/`desired_mutations` → `plan()` writes a `plan_only` task whose `plan_binding` carries all three; two plans differing only in `observed_freshness_ref` get **different `plan_hash`**.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement:** add the three optional fields to `PlanResult` (engine.ts plan) and `ApplyPlan` (tasks/engine.ts). In `PlanEngine.plan`, assemble `plan_binding = { observed_freshness_ref?, lease_resources?, desired_mutations? }`, pass it to `store.createPlanOnly({ …, plan_binding })` (conditional-spread), and **add it to the `plan_hash` `stableStringify` inputs**.
- [ ] **Step 4 — run, pass.** **Commit:** `feat(api): N0.2 — PlanResult/ApplyPlan binding fields + plan_hash coverage`.

### Task N0.3 — apply txn: desired_mutations + freshness/lease split + reconstruct
**Files:** Modify `xiNAS-MCP/src/api/tasks/engine.ts`, `xiNAS-MCP/src/api/routes/reference.ts`; Test `xiNAS-MCP/src/__tests__/api/tasks/apply.test.ts`.

- [ ] **Step 1 — failing tests:** (a) apply with `desired_mutations=[{key:K, value:V}]` → after apply, `kv.get(K).value === V` **and** `task.desired_rollback === [{key:K, prior_value:null}]`; with a pre-existing K, `prior_value` = the old value. (b) `observed_freshness_ref` whose observed row drifted → `CONFLICT(plan_stale)`; un-drifted → ok. (c) `lease_resources` present → leases those, not `affected_resources`.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** in the `apply()` `db.transaction`: after the idempotency/freshness checks, **apply `plan.desired_mutations`** to `this.kv` (put/delete), capturing each key's prior value into a `desired_rollback` array written onto the task row; replace the observed-freshness check to prefer `plan.observed_freshness_ref` (read `/xinas/v1/observed/<kind>/<id>`) over the legacy `observed_revision_expected`+`affected_resources[0]`; lease `plan.lease_resources ?? plan.affected_resources`. Update `reference.ts` `toApplyPlan` to reconstruct the three fields from `planTask.plan_binding`.
- [ ] **Step 4 — run, pass** (+ `apply.test.ts` + `routes-reference.test.ts` stay green). **Commit:** `feat(api): N0.3 — apply desired_mutations + freshness/lease split + plan_binding reconstruct`.

### Task N0.4 — Model R revert on failure
**Files:** Modify `xiNAS-MCP/src/api/tasks/engine.ts` (`failBeforeChange`), `xiNAS-MCP/src/api/tasks/progress.ts` (terminal); Test `xiNAS-MCP/src/__tests__/api/tasks/apply.test.ts`, `xiNAS-MCP/src/__tests__/api/internal-task-progress.test.ts`.

- [ ] **Step 1 — failing tests:** (a) a dispatch that fails-before-change on a task with `desired_rollback=[{key:K, prior_value:null}]` → `kv.get(K)` is gone (reverted). (b) a `terminal(failed)` progress event on such a task → K reverted; `terminal(success)` → K kept.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** a shared `revertDesired(task)` (reads `task.desired_rollback`, re-puts prior or deletes); call it in `failBeforeChange` and in `progress.ts` terminal handling when `finalState !== 'success'`.
- [ ] **Step 4 — run, pass.** **Commit:** `feat(api): N0.4 — Model R desired-state revert on failure`.

### Task N0.5 — strip internal columns from REST + SSE
**Files:** Modify `xiNAS-MCP/src/api/routes/tasks.ts`; Test `xiNAS-MCP/src/__tests__/api/tasks-watch.test.ts`.

- [ ] **Step 1 — failing test:** seed a task with `plan_binding` + `desired_rollback` set; `GET /tasks/{id}`, `GET /tasks`, and the SSE snapshot frame → none expose `spec`, `plan_binding`, or `desired_rollback` (extend the existing spec-leak test).
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement:** in `renderTask` add `delete out.plan_binding; delete out.desired_rollback;` (next to the existing `delete out.spec`); in the SSE snapshot strip, drop the same three.
- [ ] **Step 4 — run, pass** (full suite green). **Commit:** `feat(api): N0.5 — keep plan_binding/desired_rollback internal (REST + SSE strip)`.

---

## Phase N0b — ExportRule observed-id repair (spec §3 encoding, fixes latent S0/S1 bug)

### Task N0b.1 — `lib/nfs-export-id.ts`
**Files:** Create `xiNAS-MCP/src/lib/nfs-export-id.ts`; Test `xiNAS-MCP/src/__tests__/lib/nfs-export-id.test.ts`.

- [ ] **Step 1 — failing test:** `encExportId('/mnt/data')==='mnt/data'`; `'/mnt//data/'==='mnt/data'`; `'/a/./b'==='a/b'`; throws on `..`; throws on bare `/`; `decExportId('mnt/data')==='/mnt/data'`; round-trip for canonical paths; **every `encExportId` output passes the same predicate as `isValidObservedId`** (no leading/trailing `/`, no `//`, no `.`/`..` segment).
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** `encExportId` (canonicalize: split on `/`, drop empty + `.` segments, reject `..`, rejoin; reject empty result) → strip leading slash by construction; `decExportId = '/' + id`.
- [ ] **Step 4 — run, pass.** **Commit:** `feat(lib): N0b.1 — ExportRule observed-id encode/decode`.

### Task N0b.2 — collector + join use the encoded id
**Files:** Modify `xiNAS-MCP/src/agent/collectors/nfs.ts`, `xiNAS-MCP/src/api/routes/nfs.ts`; Test `xiNAS-MCP/src/__tests__/agent/collectors/nfs.test.ts`, `xiNAS-MCP/src/__tests__/api/routes-nfs.test.ts`.

- [ ] **Step 1 — failing tests:** collector emits an `ExportRule` delta with `id === encExportId(export_path)` and `value.spec.export_path === <abs path>`, and **the id passes `isValidObservedId`**; the `Share`→`ExportRule` join matches a seeded observed row keyed by `encExportId(path)` and populates `status.exports[]`.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement:** in `collectors/nfs.ts` ExportRule fold-in, set `id: encExportId(exportPath)` (keep `value.spec.export_path`); in `routes/nfs.ts` join, look up `/xinas/v1/observed/ExportRule/${encExportId(share.spec.path)}` (or compare `spec.export_path === path`, now that the row actually lands).
- [ ] **Step 4 — run, pass.** **Commit:** `fix(observed): N0b.2 — ExportRule uses encoded id so upserts pass validation`.

---

## Phase N1 — Share→export compile lib (spec §4)

### Task N1.1 — `lib/nfs-exports.ts`
**Files:** Create `xiNAS-MCP/src/lib/nfs-exports.ts`; Test `xiNAS-MCP/src/__tests__/lib/nfs-exports.test.ts`.

- [ ] **Step 1 — failing tests:** from a `Share` with `clients:[{pattern:'10.0.0.0/24', options:['rw']}]`, `sync:'sync'`, `security_mode:'krb5'` → entry client options (deterministic order) include `rw`, `sync`, `no_subtree_check`, `sec=krb5`; `security_mode:'sys'` → no `sec=`; a client that already lists `async` is not given `sync`; output is stable across repeated calls; `path` carried through.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** `compileShareToExportEntry(share)` per spec §4 (client `options[]` authoritative; fold Share-level `sync`/`security_mode` only when absent; force `no_subtree_check`; `stableOrder(dedupe(...))`).
- [ ] **Step 4 — run, pass.** **Commit:** `feat(lib): N1.1 — Share→/etc/exports compile (options[]-based, deterministic)`.

---

## Phase N2 — helper `set_idmapd_domain` + config-history (spec §6.1, §7)

### Task N2.1 — `set_idmapd_domain` op + dispatch + pytest
**Files:** Create `xiNAS-MCP/nfs-helper/nfs_idmap.py`; Modify `xiNAS-MCP/nfs-helper/nfs_helper.py`; Test `tests/test_set_idmapd_domain.py` (pytest).

- [ ] **Step 1 — failing pytest:** point the module at a temp `idmapd.conf`; `set_idmapd_domain('example.com')` rewrites/creates the `Domain=` line under `[General]`, atomically; rejects a domain with no `.` (`INVALID_ARGUMENT`); inserts `[General]` + `Domain` when the file/section is absent; preserves other lines.
- [ ] **Step 2 — run, fail** (`pytest tests/test_set_idmapd_domain.py -v`).
- [ ] **Step 3 — implement** mirroring `nfs_conf.py` (lock `/run/xinas-nfs-idmap.lock`, read, regex-replace `^\s*Domain\s*=.*$` under `[General]`, atomic `mkstemp`+`os.replace`, no restart); wire `op == 'set_idmapd_domain'` into `nfs_helper.py`'s dispatch.
- [ ] **Step 4 — run, pass.** **Commit:** `feat(nfs-helper): N2.1 — set_idmapd_domain op (atomic, locked)`.

### Task N2.2 — config-history idmapd target + helper spec doc
**Files:** Modify `xinas_history/collector.py`, `docs/MCP/spec-nfs-helper.md`; Test `tests/test_config_collector.py` (or the existing collector test).

- [ ] **Step 1 — failing test:** `CHECKSUM_TARGETS` includes `"idmapd_conf": "/etc/idmapd.conf"`.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement:** add the entry; document the `set_idmapd_domain` op in `spec-nfs-helper.md` (request/response/errors, matching the others).
- [ ] **Step 4 — run, pass.** **Commit:** `feat(config-history): N2.2 — track /etc/idmapd.conf; document set_idmapd_domain`.

---

## Phase N3 — agent NFS executors (spec §3.1–3.3, §3.5)

### Task N3.1 — `nfs-helper-client.ts` write wrappers
**Files:** Create `xiNAS-MCP/src/agent/task/nfs-helper-client.ts`; Test `xiNAS-MCP/src/__tests__/agent/task/nfs-helper-client.test.ts`.

- [ ] **Step 1 — failing test:** with an injected UDS round-trip fn, `addExport`/`removeExport`/`updateExport`/`setIdmapDomain`/`listExports` send the right `{op, ...}` and parse `{ok, result}`; an `{ok:false, code}` maps to a typed error carrying the code.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** thin typed wrappers reusing the collector's UDS client pattern (inject the connector for tests).
- [ ] **Step 4 — run, pass.** **Commit:** `feat(agent): N3.1 — typed nfs-helper write client`.

### Task N3.2 — `nfs-executor.ts` (share.create/update/delete + nfs-idmap.set)
**Files:** Create `xiNAS-MCP/src/agent/task/nfs-executor.ts`; Modify `xiNAS-MCP/src/agent/task/wiring.ts`; Test `xiNAS-MCP/src/__tests__/agent/task/nfs-executor.test.ts`.

- [ ] **Step 1 — failing tests** (fake helper client): `share.create` apply → `addExport(compile(spec))`; rollback → `removeExport(path)`. `share.update` → `updateExport`; rollback → `updateExport(prior captured at preflight)`. `share.delete` → `removeExport`; rollback → `addExport(prior)`. `nfs-idmap.set` → `setIdmapDomain(domain)`; rollback → `setIdmapDomain(prior)`. Preflight maps helper-unreachable → throw before apply; preflight captures prior state via `listExports`.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** four `Executor`s (stages `snapshot_before`→`preflight`→`apply`→`verify`→`snapshot_after`; `rollback()` issues the inverse from captured prior), recompiling via `lib/nfs-exports.ts`; register them in `buildTaskSubsystem` (wiring.ts) alongside `reference.echo`.
- [ ] **Step 4 — run, pass.** **Commit:** `feat(agent): N3.2 — NFS executors (share.* + nfs-idmap.set)`.

---

## Phase N4 — api PlanProviders (spec §3.1–3.3, §3.5)

### Task N4.1 — `plan/providers/nfs.ts`
**Files:** Create `xiNAS-MCP/src/api/plan/providers/nfs.ts`; Modify the PlanEngine wiring (`tasks/build.ts`); Test `xiNAS-MCP/src/__tests__/api/plan/providers-nfs.test.ts`.

- [ ] **Step 1 — failing tests** (fake `KvStore`): `share.create` → `affected_resources=[Share/{id}]`, `observed_freshness_ref={ExportRule, encExportId(path), rev}`, `desired_mutations=[{key:/xinas/v1/desired/Share/{id}, value:spec}]`, blocker `EXPORT_PATH_IN_USE` when the observed row exists, risk `non_disruptive`. `share.delete` → `desired_mutations=[{key, delete:true}]`, warning `ACTIVE_NFS_SESSIONS` when sessions exist. `nfs-idmap.set` → `affected_resources=[]`, `lease_resources=[{NfsIdmap,snapshot}]`, `observed_freshness_ref={nfs_idmap,snapshot,rev}`, `desired_mutations=[]`, plan revision = observed idmap revision.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** the four providers per spec §3; register on the `PlanEngine` in `build.ts`.
- [ ] **Step 4 — run, pass.** **Commit:** `feat(api): N4.1 — NFS plan providers (share.* + nfs-idmap.set)`.

---

## Phase N5 — mutating routes + OpenAPI (spec §7)

### Task N5.1 — api-v1.yaml `PATCH /nfs-idmap`
**Files:** Modify `docs/control-path/api-v1.yaml`; Test `npm run test:contracts`.

- [ ] **Step 1:** add `patch:` under `/nfs-idmap` (body `{ mode, plan_id?, idempotency_key?, expected_revision, domain }`, `ApplyRequest`-consistent), 202/4xx responses mirroring other mutating ops.
- [ ] **Step 2:** `npm run test:contracts` green; `openapi` lint clean. **Commit:** `feat(api-contract): N5.1 — PATCH /nfs-idmap`.

### Task N5.2 — `routes/nfs-mutate.ts` (shares + idmap)
**Files:** Create `xiNAS-MCP/src/api/routes/nfs-mutate.ts`; Modify `xiNAS-MCP/src/api/app.ts` (mount); Test `xiNAS-MCP/src/__tests__/api/routes-nfs-mutate.test.ts`.

- [ ] **Step 1 — failing tests** (supertest + mock agent): `POST /shares` plan→apply → 202 running task; same key + different spec → 409 `CONFLICT(idempotency_key_reused)`; stale observed → 412/`plan_stale`; `PATCH /nfs-idmap` apply → 202. Modeled on `routes-reference.test.ts`.
- [ ] **Step 2 — run, fail.**
- [ ] **Step 3 — implement** the routes (plan→apply→dispatch, mirroring `reference.ts`; `share.create` assigns/validates `id`+`fsid`); mount under `/api/v1`.
- [ ] **Step 4 — run, pass** (+ contracts). **Commit:** `feat(api): N5.2 — NFS mutating routes (shares + idmap)`.

---

## Phase N6 — e2e (spec §9)

### Task N6.1 — `nfs-roundtrip.test.ts` with a stub helper
**Files:** Create `xiNAS-MCP/src/__tests__/e2e/nfs-roundtrip.test.ts`; Test `npm run test:e2e`.

- [ ] **Step 1 — implement** (model on `task-engine-roundtrip.test.ts`): real api + agent over UDS, plus a **stub nfs-helper** socket the agent points at (a small JS UDS server answering `list_exports`/`add_export`/`remove_export`/`update_export`/`set_idmapd_domain`, with a forced-failure mode). Assert: `share.create` → `add_export` called → task `success`, desired Share present; forced `INTERNAL` on apply → rollback (`remove_export`) → `FAILED_PARTIAL_ROLLED_BACK`, desired reverted; `nfs-idmap.set` → `set_idmapd_domain` called → success.
- [ ] **Step 2 — run** `npm run build && npm run test:e2e` green. **Commit:** `test(e2e): N6.1 — NFS round-trip (create · rollback · idmap) via stub helper`.

---

## Phase N7 — nfs-profile.update (ADR-0005 renderer) — splittable, last (spec §3.4, §6.2)

### Task N7.1 — helper `render_nfs_profile` (four ADR-0005 files)
**Files:** Create `xiNAS-MCP/nfs-helper/nfs_profile.py`; Modify `nfs_helper.py`; Test `tests/test_render_nfs_profile.py`.

- [ ] **Step 1 — failing pytest:** from a profile spec, renders `/etc/nfs/nfsd.conf`, `/etc/default/nfs-kernel-server`, `/etc/modprobe.d/lockd.conf`, `/etc/default/nfs-common` (temp-dir roots), each atomic; returns per-file sha256; honors `restart` (mock `systemctl`). Maps to ADR-0005 §"Effective-config rendering".
- [ ] **Step 2 — run, fail.** **Step 3 — implement.** **Step 4 — run, pass.** **Commit:** `feat(nfs-helper): N7.1 — render_nfs_profile (ADR-0005 effective files)`.

### Task N7.2 — `status.effective_files` producer
**Files:** per the N7 decision (spec §3.4): either a new observed `NfsProfile` collector (`src/agent/collectors/nfs-profile.ts` + add `NfsProfile` to the `Kind` union) **or** wire the helper-returned checksums through a progress/observed push; Test accordingly.

- [ ] **Step 1–4 — TDD** the chosen producer so `GET /nfs-profiles/default` `status.effective_files` reflects the rendered checksums. **Commit:** `feat(agent): N7.2 — NfsProfile effective_files producer`.

### Task N7.3 — provider + executor + route
**Files:** Modify `plan/providers/nfs.ts`, `agent/task/nfs-executor.ts`, `agent/task/nfs-helper-client.ts` (add `renderNfsProfile`), `routes/nfs-mutate.ts` (the existing `PATCH/PUT /nfs-profiles/default`); Tests alongside.

- [ ] **Step 1–4 — TDD** `nfs-profile.update`: provider (desired-revision pin, restart derivation per §3.4), executor (`renderNfsProfile`; rollback `renderNfsProfile(prior)`), route. **Commit:** `feat(api+agent): N7.3 — nfs-profile.update end-to-end`.

### Task N7.4 — e2e extension
- [ ] Extend `nfs-roundtrip.test.ts` (stub helper answers `render_nfs_profile`): `nfs-profile.update` with `threads.count` change → renders → success. **Commit:** `test(e2e): N7.4 — nfs-profile.update round-trip`.

---

## Final

- [ ] Dispatch a final whole-branch code review (cross-task seams, esp. N0 engine contract).
- [ ] `superpowers:finishing-a-development-branch` — push `claude/s3-nfs-executor`, open a **draft, operator-gated** PR (per Sergey's rule; never auto-merge). Consider landing **N0+N0b as their own PR first** (the engine foundation is independent of NFS and reusable).

---

## Self-review notes
- **Spec coverage:** §3.1–3.5 → N3/N4/N5/N7; §4 → N1; §5.1–5.4 → N0.1–N0.5; §6.1 → N2.1; §6.2 → N7.1; §7 → N2.2/N5.1; §3 encoding → N0b; §8 error model → exercised in N3/N5/N6; §9 testing → per-task + N6. ExportGroup intentionally absent (YAGNI, spec §1).
- **Type consistency:** `encExportId`/`decExportId` (N0b) used identically in collector + join + providers; `DesiredMutation` (N0.1) shape used in N0.3 + N4; `compileShareToExportEntry` (N1) consumed by N3 executors + N4 providers (preview).
- **No `Requires-Rebuild`** anywhere (spec §6).
