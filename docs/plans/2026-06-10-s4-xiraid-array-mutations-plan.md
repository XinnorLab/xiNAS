# S4 xiRAID Array Mutations (modify + import + delete) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish WS5 per `docs/control-path/s4-xiraid-array-mutations-spec.md`: the engine dangerous gate, modify (tuning + spare-pool lifecycle), create-with-spares un-deferral, import (adopt by uuid), and delete (dependency guard + blast radius), e2e-proven against the fake xiRAID transport.

**Architecture:** Three new operation kinds on the S2 engine, mirroring S3's provider/executor pairs; one engine extension (`ApplyRequest.dangerous`, checked in the apply txn); the shared `XiraidClient` gains `raidModify`/`pool*`/`raidImport*`; freshness binds at the route (`expected_revision` vs current observed revision — no migration).

**Tech Stack:** unchanged (TypeScript Node16 + Express 5 + better-sqlite3 + vitest; biome). **No `Requires-Rebuild` trailer on any S4 task** (pure TS/docs — the T1 unit change shipped in S3).

**Conventions:** `.js` ESM imports; conditional spread; inject `now()`; HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; never `git add -A`; TDD per task; full gate at the end.

---

## Reuse-not-rebuild

- `src/api/tasks/engine.ts` — the apply txn (T1 adds ONE check inside it; everything else untouched).
- `src/api/plan/providers/xiraid-array.ts` + `src/agent/task/xiraid-array-executor.ts` — the S3 create pair: the pattern AND the file T4 extends.
- `src/api/handlers/plan-apply.ts` — shared envelope helpers (S3 T8); routes reuse.
- `src/agent/xiraid/{client,fake-transport}.ts` — extend, don't fork.
- `src/grpc/{raid,pool}.ts` — `raidModify`, `raidImportShow`, `raidImportApply`, `poolCreate/Delete/Add/Remove` wrappers all EXIST (verified).
- Dep-walk sources (verified shapes): observed `Filesystem` rows have **no `spec`** — `backing_device`, `mountpoint`, `currently_mounted` all live under **`status`** (`collectors/filesystem.ts` `_fsToUpsert`); desired `Share` (`spec.path`); observed `NfsSession` (`spec.export_path`).
- `lib/parse/mountinfo.ts` (`parseMountinfo`, `MountEntry`) — the delete executor's host-level mount guard reads `/proc/self/mountinfo` through it.
- Pool lifecycle (analyst doc §3.8): `create → activate → [auto-replace armed]`; `deactivate → delete`. `poolActivate`/`poolDeactivate` wrappers exist in `src/grpc/pool.ts`.

## File structure

| File | Responsibility |
|------|----------------|
| `src/api/tasks/engine.ts` (modify) | `ApplyRequest.dangerous` + the destructive gate in the apply txn. |
| `src/lib/xiraid/validate.ts` (modify) | drop `spare_pool_deferred`; spare-disk rules shared with create; `validateModifySpec`. |
| `src/lib/xiraid/translate.ts` (modify) | `sparepool` render on create; `toRaidModifyRequest(spec)`. |
| `src/agent/xiraid/client.ts` / `fake-transport.ts` (modify) | new verbs; pools + import_candidates + `config_only` + `-fail` hooks. |
| `src/api/plan/providers/xiraid-array.ts` (modify) | create-with-spares; + `xiraidArrayModifyProvider`, `xiraidArrayImportProvider`, `xiraidArrayDeleteProvider` (same file — they share the facts/resolution helpers; split only if it grows past ~400 lines). |
| `src/api/routes/arrays.ts` (modify) | PATCH + DELETE handlers; import-shape handling on POST; §4 binding + §8 filtered re-check. |
| `src/agent/task/xiraid-array-executor.ts` (modify) | create pool step; + `makeXiraidArrayModifyExecutor`, `makeXiraidArrayImportExecutor`, `makeXiraidArrayDeleteExecutor` (same file, shared `readShow` helpers). |
| `src/agent/task/wiring.ts` / `src/api/tasks/build.ts` / `src/api/app.ts` (modify) | register the three pairs; drop PATCH/DELETE `/arrays/:id` from the stub loop. |
| Tests | extend the S3 test files per area + `src/__tests__/e2e/xiraid-array-mutations.test.ts`. |

---

## Task T0: Contract revisions (docs)

**Files:** Modify `docs/control-path/adr/0006-xiraid-array.md`, `docs/control-path/s3-xiraid-array-spec.md`, `docs/control-path/api-v1.yaml`.

- [ ] **Step 1: ADR-0006 §Import amendment.** Replace the "Discovery: `mode=plan` calls `raid_import_show(drives)`" sentence with the S4 contract: plan-mode validates shape + target-name availability (api/KV only); the **executor preflight** runs `raid_import_show` (privilege split — the api cannot reach the daemon); plan-time discovery surface = follow-on work. Cross-link `s4-…-spec.md` §6.
- [ ] **Step 2: ADR-0006 spare un-deferral.** In §Spare pools strike "the S3 create build defers it … blocker `spare_pool_deferred`" (replace with "create-with-spares lands in S4"); drop `spare_pool_deferred` from §Preflight blockers; update the matrix row note.
- [ ] **Step 3: S3 spec pointers.** In `s3-xiraid-array-spec.md` §1 mark the deferred ops + `spare_pool_deferred` as superseded by the S4 spec (one-line pointers; do not rewrite history).
- [ ] **Step 4: api-v1.yaml.** In the `PRECONDITION_FAILED` response description document `details.reason ∈ dangerous_flag_required | observed_revision_stale | create_expects_revision_zero`. No path/schema changes.
- [ ] **Step 5: Validate + commit.** `cd xiNAS-MCP && npm run test:contracts` → PASS. Commit: `docs(control-path): T0 — S4 contract revisions (import amendment, spare un-deferral, reason discriminators)`

## Task T1: Engine dangerous gate

**Files:** Modify `xiNAS-MCP/src/api/tasks/engine.ts`, `xiNAS-MCP/src/api/routes/arrays.ts` (passthrough plumbing only), test `xiNAS-MCP/src/__tests__/api/tasks/apply.test.ts` (extend).

- [ ] **Step 1: Failing tests** (extend the existing apply-txn suite's harness):
```ts
it('destructive plan without dangerous → PRECONDITION_FAILED dangerous_flag_required, nothing written', () => {
  const plan = makePlan({ risk_level: 'destructive' });
  expect(() => engine.apply({ plan, applyReq: makeApplyReq() })).toThrowMatching(
    (e) => e instanceof ApiException && e.code === 'PRECONDITION_FAILED'
      && e.details?.reason === 'dangerous_flag_required');
  expect(countTasks()).toBe(planOnlyCount); // no apply row
  expect(countLeases()).toBe(0);
});
it('destructive + dangerous:true → proceeds (queued task)', () => { /* applyReq.dangerous = true */ });
it('non_disruptive ignores dangerous (absent and true both proceed)', () => { /* … */ });
```
(Adapt assertion helpers to the file's existing style — it has `countTasks`-style helpers.)
- [ ] **Step 2: Run — fails.** `npx vitest run src/__tests__/api/tasks/apply.test.ts`
- [ ] **Step 3: Implement.** `ApplyRequest` gains `dangerous?: boolean`. In the apply txn, immediately after the plan lookup/idempotency section and **before** freshness/leases:
```ts
if (plan.risk_level === 'destructive' && applyReq.dangerous !== true) {
  throw new ApiException('PRECONDITION_FAILED', 'destructive operation requires dangerous: true',
    { reason: 'dangerous_flag_required' },
    'Re-send the apply with dangerous: true after reviewing the plan blast radius.');
}
```
- [ ] **Step 4: Run — passes** (+ full `npm test`). **Commit:** `feat(api): T1 — engine dangerous gate (destructive requires dangerous:true)`

## Task T2: Client adapter + fake transport extensions

**Files:** Modify `xiNAS-MCP/src/agent/xiraid/client.ts`, `xiNAS-MCP/src/agent/xiraid/fake-transport.ts`; extend `xiNAS-MCP/src/__tests__/agent/xiraid/client.test.ts`.

- [ ] **Step 1: Pin the import-candidate shape.** `grep -n -A10 "raid_import_show\|RaidImportShow" xiNAS-MCP/proto/xraid/gRPC/protobuf/message_raid.proto xiNAS-MCP/xiraid-analysis/api_behavior_doc.md` — use the doc's field names (expect `uuid`, `name`, `level`, `devices`, recoverability flag); adjust the fake's candidate objects to match before writing tests.
- [ ] **Step 2: Failing tests.** Transport interface additions:
```ts
raidModify(req: RaidModifyRequest): Promise<void>;
poolCreate(req: { name: string; drives: string[] }): Promise<void>;
poolDelete(req: { name: string }): Promise<void>;
poolAdd(req: { name: string; drives: string[] }): Promise<void>;
poolRemove(req: { name: string; drives: string[] }): Promise<void>;
poolActivate(req: { name: string }): Promise<void>;
poolDeactivate(req: { name: string }): Promise<void>;
poolShow(): Promise<unknown>;
raidImportShow(): Promise<unknown>;
raidImportApply(req: { uuid: string; new_name?: string }): Promise<void>;
raidDestroy(req: { name: string; force?: boolean; config_only?: boolean }): Promise<void>;
```
Fake tests: pool create/dup/add/remove/activate/deactivate/delete round-trip persisted (`pools: [{name, drives, active}]`; **deleting an ACTIVE pool rejects** — forces deactivate-first); `raidModify` sets `sparepool` + echoes tuning fields onto the array entry; `raidImportShow` returns seeded `import_candidates`; `raidImportApply` known-uuid moves it into `arrays` under `new_name ?? name` / unknown-uuid rejects; `raidDestroy({config_only:true})` removes the entry WITHOUT a `data_wiped` tombstone (plain destroy records `data_wiped:true` — the e2e asserts un-adopt ≠ wipe); failure hooks: every mutating verb on a name ending `-fail` rejects, AND `raidModify` carrying tuning keys (any field beyond `name`/`sparepool`) on a name ending `-fail-tuning` rejects (targets the tuning stage; pool ops on `xnsp_<name>` still succeed — a plain `-fail` name would trip the pool ops first).
- [ ] **Step 3: Run — fails. Implement** client delegations (same `#track` availability wrapper) + fake state `{ arrays, pools, import_candidates, tombstones }`.
- [ ] **Step 4: Run — passes** (+ `npx tsc --noEmit`). **Commit:** `feat(agent): T2 — xiraid client verbs (modify/pool/import) + fake transport state`

## Task T3: lib/xiraid — modify validation + translate

**Files:** Modify `xiNAS-MCP/src/lib/xiraid/{schema,validate,translate}.ts`; extend the validate/translate tests.

- [ ] **Step 1: Failing tests.**
  - validate: `spare_pool_deferred` is GONE (create spec with spares + valid spare disks → `[]`); spare disks get the member checks (`disk_not_found`/`disk_not_safe`/`disk_is_system`/`disk_in_use`), with `ownSpareDiskIds: Set<string>` in facts exempting this array's current spares from `disk_in_use`; `validateModifySpec({spare_disk_ids?, tuning?}, facts)` reuses the tuning ranges; derived pool name guard: `xnsp_<name>` length > 63 → blocker `name_invalid`.
  - translate: create spec with spares → `sparepool: 'xnsp_<name>'` in the request and spare drives are NOT in `drives`; `toRaidModifyRequest({name, tuning})` golden (boolean→0/1, null dropped, never `force`); `toRaidModifyRequest({name, sparepool})` attach/detach (`''`).
- [ ] **Step 2: Run — fails. Implement.** `parseModifySpec` is **tolerant** (mirrors `parseCreateSpec`): narrows `spare_disk_ids`/`tuning` when present and **ignores unknown keys** — the persisted enriched spec (`id`, `device_by_id`, `current_*`) must re-parse cleanly for the route's apply re-check (§8 of the spec). Topology-key rejection is the ROUTE's job against the raw PATCH body only. Test: `parseModifySpec({spare_disk_ids:['d'], tuning:{}, id:'x', device_by_id:{}, current_sparepool:''})` parses.
- [ ] **Step 3: Run — passes.** **Commit:** `feat(lib): T3 — modify validation + raid_modify/sparepool translation (spare un-deferral)`

## Task T4: Create-with-spares (provider + executor)

**Files:** Modify `xiNAS-MCP/src/api/plan/providers/xiraid-array.ts`, `xiNAS-MCP/src/agent/task/xiraid-array-executor.ts`; extend both test files.

- [ ] **Step 1: Failing tests.** Provider: create spec with `spare_disk_ids` → no blockers (safe spares), `affected_resources` = [array, …members, …spares], `device_by_id` includes spares, diff request carries `sparepool`. Executor (fake transport): create-with-spares → op order is `pool_create('xnsp_data', spareDevices)` → `pool_activate('xnsp_data')` → `raid_create` (fake records op order); the array entry has `sparepool: 'xnsp_data'` and the pool is `active: true`; create failure after pool creation → rollback destroys the array (if present) AND `pool_deactivate` + `pool_delete` `xnsp_data`.
- [ ] **Step 2: Run — fails. Implement.** Provider: spares resolved+leased exactly like members. Executor `create` stage: when spares present → `poolCreate` → `poolActivate` → `raidCreate({..., sparepool})`. `rollback`: after the existing array-destroy logic, read `poolShow()` (added in T2) and, when `xnsp_<name>` is listed, `poolDeactivate` (tolerate already-inactive) + `poolDelete`.
- [ ] **Step 3: Run — passes** (+ S3 e2e still green later in T11). **Commit:** `feat(xiraid): T4 — create-with-spares (pool provisioning + rollback cleanup)`

## Task T5: Modify provider + PATCH route

**Files:** Modify `xiNAS-MCP/src/api/plan/providers/xiraid-array.ts`, `xiNAS-MCP/src/api/routes/arrays.ts`, `xiNAS-MCP/src/api/app.ts` (drop PATCH `/arrays/:id` from the stub loop), `xiNAS-MCP/src/api/tasks/build.ts` (register provider); tests `xiNAS-MCP/src/__tests__/api/plan/xiraid-array-provider.test.ts` + `routes-arrays.test.ts`.

- [ ] **Step 1: Failing tests.**
  - Provider: seeded observed array `data` (members nvme1-4, no spares) + free disks → modify spec `{spare_disk_ids:['nvme5n1'], tuning:{init_prio:10}}` → blockers `[]`; `affected_resources[0]` = array, then the spare disk; `enriched_spec` carries `device_by_id` (spares), `current_sparepool: ''`, `current_spare_disk_ids: []`; diff has before/after. Unknown array id → `NOT_FOUND` ApiException. Spare already in ANOTHER array → `disk_in_use`; spare in THIS array's observed spares → no blocker.
  - Route: `PATCH /api/v1/arrays/data {mode:'plan', spec:{level:'raid5'}}` → **422** `UNSUPPORTED` `details.field === 'spec.level'`, no plan row; plan happy → 200; apply with `expected_revision` ≠ current observed revision → **412** `observed_revision_stale`; correct revision + mock agent accept → 202 running, leases [array + spare disk]; PATCH on an id with no observed row → 404.
- [ ] **Step 2: Run — fails. Implement.** Provider `xiraidArrayModifyProvider` (`operation_kind: 'xiraid.array.modify'`; id arrives inside the spec as `{ id }` injected by the route — the route merges the path id into the spec it sends to `planEngine.plan` so the provider is self-contained). Route handler `PATCH /arrays/:id`: topology-key scan → per-field 422; `mode=plan` → plan; `mode=apply` → §4 revision binding (read current observed row revision) + §8 re-check (filter `dangerous_flag_required` — vacuous for modify) + engine apply/dispatch. Register the provider in `build.ts`; remove the PATCH stub registration for `/arrays/:id` in `app.ts` (keep PUT; keep DELETE until T9).
- [ ] **Step 3: Run — passes** (+ `mutating.test.ts`). **Commit:** `feat(api): T5 — xiraid.array.modify provider + PATCH /arrays/:id route`

## Task T6: Modify executor

**Files:** Modify `xiNAS-MCP/src/agent/task/xiraid-array-executor.ts`, `xiNAS-MCP/src/agent/task/wiring.ts` (register); extend the executor test file.

- [ ] **Step 1: Failing tests** (TaskRunner + fake transport; array `data` pre-seeded):
  - attach: spec `{id:'data', spare_disk_ids:['d5'], device_by_id:{d5:'/dev/nvme5n1'}, current_sparepool:'', current_spare_disk_ids:[]}` → stages `preflight`/`apply_spares`/`verify` (`apply_tuning` emits `skipped`) → success; op order `pool_create` → `pool_activate` → `raid_modify{sparepool}`; fake pools has `xnsp_data` with `active: true` and the array's `sparepool === 'xnsp_data'`.
  - membership change (current ACTIVE pool `xnsp_data` exists): `pool_add`/`pool_remove` deltas only — no re-create, no activation churn.
  - detach: `spare_disk_ids: []` → `raid_modify {sparepool:''}` → `pool_deactivate` → `pool_delete` (the fake rejects deleting an active pool, so wrong ordering fails the test).
  - tuning-only: single `raid_modify`, no pool calls, `apply_spares` emits `skipped`.
  - foreign pool: array's `sparepool` is `legacy0` → `preflight` fails, terminal failed, no pool calls.
  - rollback: seed array **`arr-fail-tuning`** with spec attaching a spare + tuning — pool ops on `xnsp_arr-fail-tuning` succeed (only the `-fail-tuning` + tuning-keys `raidModify` hook rejects), `apply_spares` succeeds (its `raid_modify` carries only `sparepool`), then `apply_tuning`'s tuning-carrying `raid_modify` rejects → rollback deactivates+deletes `xnsp_arr-fail-tuning` + clears `sparepool`; terminal `failed (FAILED_PARTIAL_ROLLED_BACK)`.
- [ ] **Step 2: Run — fails. Implement** `makeXiraidArrayModifyExecutor({client})`: the Executor interface takes a fixed `stages` list, so both `apply_spares` and `apply_tuning` are always present and each no-ops with `skipped (no <key> change)` when its key is absent; attach/detach follow the activation ordering above; rollback computes inverse pool ops (incl. activation state) from `current_*` vs live pool/array state. Register in `wiring.ts`.
- [ ] **Step 3: Run — passes.** **Commit:** `feat(agent): T6 — xiraid.array.modify executor (pool lifecycle, tuning last, inverse rollback)`

## Task T7: Import provider + POST import-shape

**Files:** Modify `xiNAS-MCP/src/api/plan/providers/xiraid-array.ts`, `xiNAS-MCP/src/api/routes/arrays.ts` (replace `rejectImportShaped`), `xiNAS-MCP/src/api/tasks/build.ts`; extend provider + route tests.

- [ ] **Step 1: Failing tests.** Provider: spec `{uuid:'u-1', new_name:'adopted'}` → blockers `[]`, `affected_resources` = `[{kind:'XiraidArray', id:'adopted'}]` only, `risk non_disruptive`, diff `{adopt:{uuid:'u-1', as:'adopted'}}`; `new_name` omitted → target id = uuid (must pass `NAME_RE` else `name_invalid`); name taken (observed array `adopted` exists) → `name_taken`; empty uuid → `INVALID_ARGUMENT`. Route: POST with `{uuid}` now returns a 200 plan (the S3 422 test flips); apply (`expected_revision: 0`) + mock agent → 202 with `kind: 'xiraid.array.import'`.
- [ ] **Step 2: Run — fails. Implement** provider + route discrimination (`'uuid' in spec` → import path), register provider. Update the S3 route test that asserted 422 for import-shaped specs.
- [ ] **Step 3: Run — passes.** **Commit:** `feat(api): T7 — xiraid.array.import provider + POST /arrays import shape`

## Task T8: Import executor

**Files:** Modify `xiNAS-MCP/src/agent/task/xiraid-array-executor.ts`, `wiring.ts`; extend executor tests.

- [ ] **Step 1: Failing tests** (fake seeded with `import_candidates: [{uuid:'u-1', name:'foreign', …}]`):
  - adopt happy: stages `preflight`/`adopt`/`verify` → success; `arrays` has `adopted`; candidate consumed.
  - unknown uuid → `preflight` fails (no change), rollback no-op, terminal failed.
  - adopt succeeded but verify forced to fail (candidate named `verify-fail` adopting AS `verify-fail`… simpler: target name `roll-fail` makes `raidImportApply` reject → preflight passed, adopt failed → rollback: name absent → no-op). For the un-adopt path: make the fake's `raidShow` list the target then `verify` impossible? Keep two covered paths: adopt-reject (rollback no-op) and a DIRECT rollback unit: call `executor.rollback(ctx)` with the target present → `raid_destroy {config_only:true}` recorded, `tombstones` has NO `data_wiped` for it.
- [ ] **Step 2: Run — fails. Implement** `makeXiraidArrayImportExecutor({client})` per spec §6; register.
- [ ] **Step 3: Run — passes.** **Commit:** `feat(agent): T8 — xiraid.array.import executor (raid_import_show preflight, config-only un-adopt)`

## Task T9: Delete provider + DELETE route

**Files:** Modify `xiNAS-MCP/src/api/plan/providers/xiraid-array.ts`, `xiNAS-MCP/src/api/routes/arrays.ts`, `xiNAS-MCP/src/api/app.ts` (drop the DELETE stub), `build.ts`; extend provider + route tests.

- [ ] **Step 1: Failing tests.**
  - Provider (seed observed array `data` w/ volume_path `/dev/xi_data`; observed Filesystem `fs1` in the **live collector shape — status-only, NO spec**: `{kind:'Filesystem', id:'fs1', status:{backing_device:'/dev/xi_data', mountpoint:'/mnt/d', currently_mounted:true, observed_at:…}}`; desired Share `s1 {spec:{path:'/mnt/d/share'}}`; observed NfsSession `{spec:{export_path:'/mnt/d/share'}}`): blockers contain `dangerous_flag_required` + `dependent_filesystem_mounted` + `dependent_share_active`; `affected_resources` = [array, fs1, s1]; `risk_level 'destructive'`, `rollback_model 'unsupported'`; diff blast radius lists all three groups. Clean array (no deps) → blockers = exactly `[dangerous_flag_required]`. Unknown id → NOT_FOUND. (The walk reads `status.backing_device`/`status.mountpoint`/`status.currently_mounted` — observed Filesystem rows carry no `spec`.)
  - Route: plan → 200 with the blockers; apply clean array + `dangerous:false` → **412 `dangerous_flag_required`** (engine); + `dangerous:true` + fresh `expected_revision` + mock accept → 202; with deps present → 412 with `dependent_filesystem_mounted` in `details.blockers` (the re-check filters only the dangerous code); stale revision → 412 `observed_revision_stale`.
- [ ] **Step 2: Run — fails. Implement** delete provider (dep walk per spec §7; KV prefixes `/xinas/v1/observed/Filesystem/`, `/xinas/v1/desired/Share/`, `/xinas/v1/observed/NfsSession/`) + DELETE route (no spec body; route injects `{id}`; passes `dangerous` to applyReq; §8 filtered re-check); drop the DELETE stub for `/arrays/:id`.
- [ ] **Step 3: Run — passes.** **Commit:** `feat(api): T9 — xiraid.array.delete provider (dep walk + blast radius) + DELETE route`

## Task T10: Delete executor

**Files:** Modify `xiNAS-MCP/src/agent/task/xiraid-array-executor.ts`, `wiring.ts`; extend executor tests.

- [ ] **Step 1: Failing tests** (`makeXiraidArrayDeleteExecutor({client, readMounts})` — `readMounts` injected, default impl reads `/proc/self/mountinfo` through `lib/parse/mountinfo.ts`):
  - happy: array `data` (+ ACTIVE pool `xnsp_data`) seeded, `readMounts` → `[]` → stages `preflight`/`destroy`/`verify` → success; array gone, pool deactivated+gone, tombstone `data_wiped: true`.
  - **mount guard:** `readMounts` returns an entry whose source device is `/dev/xi_data` → `preflight` fails; rollback sees the array STILL PRESENT → **no-op** → terminal `failed (FAILED_PARTIAL_ROLLED_BACK)` (clean, retryable — nothing was destroyed); no destroy call recorded.
  - array vanished before begin → `preflight` fails; rollback sees the array GONE → **throws** → `rollback_failed` → terminal `requires_manual_recovery (FAILED_MANUAL_RECOVERY_REQUIRED)` (state unknowable).
  - destroy rejected (array named `del-fail` — the `-fail` hook rejects `raidDestroy`) → `destroy` stage fails; the array still exists → rollback no-op → clean `failed`. Then the inverse: destroy SUCCEEDED but `verify` forced to fail (fake left a ghost? — simulate by making `verify` strict against a tombstone-only state) → array gone → rollback throws → `requires_manual_recovery`.
- [ ] **Step 2: Run — fails. Implement** per spec §7: preflight = exists + not-mounted (match `MountEntry`'s source-device field against `/dev/xi_<name>` — confirm the exact field name in `lib/parse/mountinfo.ts` while wiring); `rollback()` is **live-state decided**: array present → no-op (nothing destroyed), array absent or `raid_show` unreachable → throw. Register in `wiring.ts` with the real `readMounts` built from `node:fs` + `parseMountinfo`.
- [ ] **Step 3: Run — passes** (+ full `npm test`). **Commit:** `feat(agent): T10 — xiraid.array.delete executor (rollback-unsupported → manual recovery)`

## Task T11: e2e + full verification gate

**Files:** Create `xiNAS-MCP/src/__tests__/e2e/xiraid-array-mutations.test.ts` (clone the S3 e2e harness: per-run fixture dir, fake python3, `XINAS_AGENT_XIRAID_POLL_MS=500`). Seed: 1 system disk + 8 free disks; `xiraid-state.json` with `import_candidates: [{uuid:'u-e2e', name:'foreign', level:'5', devices:[…], recoverable:true}]`.

- [ ] **Step 1: create-with-spares.** plan+apply create `data` (4 members, 1 spare) → success → observed `spec.spare_disk_ids` reflects the spare after the next sweep.
- [ ] **Step 2: modify.** PATCH `data`: add a second spare + `tuning.init_prio` → 202 → success → observed spares updated.
- [ ] **Step 3: import.** POST `{uuid:'u-e2e', new_name:'adopted'}` plan → 0 hard blockers → apply (`expected_revision:0`) → success → `GET /arrays` lists `adopted`.
- [ ] **Step 4a: fixture Filesystem support.** A pre-seeded observed Filesystem row would be WIPED by the fixture-mode Filesystem collector's empty complete-snapshot sweep. Extend `src/agent/probe/fixture.ts`'s `createFixtureFilesystemProbe` to read `<dir>/filesystems.json` (same pattern as `disks.json`; entries in the collector's expected probe shape incl. `mountpoint`, `backing_device`, `currently_mounted`) with the empty default when absent — unit-test alongside the other fixture probes. (Small, additive; the other e2e suites have no `filesystems.json`, so their behavior is unchanged.)
- [ ] **Step 4b: delete gates.** DELETE `adopted` apply with `dangerous:false` → 412 `dangerous_flag_required`. With `filesystems.json` carrying a mounted fs backed by `/dev/xi_data` → DELETE `data` apply (`dangerous:true`) → 412 `dependent_filesystem_mounted`.
- [ ] **Step 5: delete success.** DELETE `adopted` with `dangerous:true` + fresh revision → 202 → success → gone from `GET /arrays` (next sweep).
- [ ] **Step 6: Gate.** `npm run build` then: `npm test` · `npm run test:e2e` · `npm run test:contracts` · `npx tsc --noEmit` · `npm run lint` — all green.
- [ ] **Step 7: Commit:** `test(e2e): T11 — xiraid array mutations round-trip (spares, modify, import, delete gates)`

---

## Self-review notes

- **Spec coverage:** §3→T1, §9→T2, §5(validate/translate)→T3, §5(create un-deferral)→T4, §5(modify)→T5/T6, §6→T7/T8, §7→T9/T10, §11→T0, §12→per-task+T11. §4 binding lands in T5 (PATCH) and is reused by T9 (DELETE); §8 filter in T5/T9.
- **Confirm-first steps:** T2 Step 1 pins the `raid_import_show` candidate shape (the one external unknown).
- **Known wrinkle, decided in-plan:** the Executor interface has a fixed `stages` list → modify's conditional stages are present-but-skipping (emit `skipped`), not dynamically composed.
- **Resolved during plan self-review:** T4's pool-existence read → add `poolShow()` to the transport interface in T2; T11's dependent-fs seeding → a KV pre-seed would be wiped by the fixture-mode Filesystem collector's empty complete-snapshot sweep, so T11 Step 4a extends the fixture probe to read `filesystems.json` instead.
- **Resolved by independent review (2026-06-10):** the dep walk + T9 seeds use the LIVE observed Filesystem shape (status-only, no spec); the delete executor gains the injected `readMounts` host guard (closes the route-recheck→destroy TOCTOU) and its rollback is live-state decided (array present → clean `failed`; gone → `requires_manual_recovery`); the pool lifecycle includes `pool_activate`/`pool_deactivate` (analyst §3.8 — unactivated pools never auto-replace; the fake rejects deleting an active pool to force the ordering); `parseModifySpec` tolerates enrichment keys so the apply re-check accepts its own plan; the modify rollback test uses the `-fail-tuning` hook (a plain `-fail` array name would trip the `xnsp_*-fail` pool ops first).
- **No `Requires-Rebuild`** anywhere (pure TS/docs).
