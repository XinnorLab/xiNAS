# xiNAS S4 — xiRAID array mutations: modify + import + delete (design spec)

**Status:** design (2026-06-10; conforms to **ADR-0006**, with one documented conformance amendment — §7 import discovery). Completes WS5 on top of the landed S3 observe+create adapter. Implementation plan: `docs/plans/2026-06-10-s4-xiraid-array-mutations-plan.md`.

**Goal.** Finish the xiRAID array surface: **modify** (live tuning + the spare-pool lifecycle, which also un-defers create-with-spares), **import** (adopt a foreign array by UUID), and **delete** (the §14 dangerous-flag gate enforced centrally in the task engine + the dependency guard with blast radius) — all on the S2 plan/apply engine, e2e-proven against the fake xiRAID transport. WS5 exit criteria after S4: *"Arrays visible through API; create/import/delete plan works; unsafe delete blocked with dependencies"* — all met.

**Authoritative prior art (this spec conforms to it).**
- **ADR-0006** — writability matrix (topology immutable; spares + tuning live), spare-pool lifecycle (`xnsp_<array>`, executor-owned), per-operation contracts, the engine-enforced dangerous gate, `rollback_model` enums.
- **S2 engine + S3 adapter (landed)** — `PlanEngine` (+`enriched_spec`), `TaskEngine.apply` (idempotency + freshness + leases, one txn), the shared `lib/xiraid`, `agent/xiraid/client.ts` (+fake transport), `routes/arrays.ts`, the create executor, the observe collector.
- Verified integration facts this spec is written against: `ApplyPlan.observed_revision_expected` exists and the engine enforces `CONFLICT(plan_stale)` against `affected_resources[0]` — but it is **not persisted** on the plan row; `src/grpc/` already exports `raidModify`, `raidImportShow`, `raidImportApply`, and the full `pool*` verb set (incl. `poolActivate`/`poolDeactivate`); observed `Filesystem` rows have **no `spec`** — the collector emits `{ kind, id, status }` with `backing_device`, `mountpoint`, `mounted` all under **`status`** (`collectors/filesystem.ts` `_fsToUpsert`); `Share`s live in **desired** state (`spec.path` is the export path); `NfsSession`s are observed with `spec.export_path`; `lib/parse/mountinfo.ts` provides `parseMountinfo` for host-level mount checks; the xiRAID pool lifecycle is `create → activate → [auto-replace armed]` / `deactivate → delete` (analyst doc §3.8 — an unactivated pool does NOT auto-replace).

**This spec does NOT** add error codes, new top-level objects, or a desired-state projection for arrays. It extends the S2 `ApplyRequest` with the contract-locked `dangerous` field and adds three operation kinds to the existing registries.

---

## 1. Scope

### In scope (S4)
- **Engine dangerous gate (§3):** `TaskEngine.apply` enforces `risk_level == 'destructive' && dangerous !== true` → `PRECONDITION_FAILED { reason: 'dangerous_flag_required' }` — one gate for every client (REST/CLI/TUI/MCP), per reqs §14.
- **Modify** (`xiraid.array.modify`, `PATCH /arrays/{id}`): `spec.tuning.*` + `spec.spare_disk_ids` writable; topology fields → per-field `UNSUPPORTED` before any plan. Spare changes drive the executor-owned pool lifecycle.
- **Create-with-spares un-deferral:** the S3 `spare_pool_deferred` blocker is removed; create validates/leases/resolves spare disks and the create executor provisions the pool before `raid_create`.
- **Import** (`xiraid.array.import`, `POST /arrays` import-shaped spec `{ uuid, new_name? }`): adopt a foreign array; executor-side validation via `raid_import_show` (§7).
- **Delete** (`xiraid.array.delete`, `DELETE /arrays/{id}`): dependency guard + blast radius + the dangerous gate; `raid_destroy`; failed destroy → `requires_manual_recovery`.
- **Client adapter + fake transport extensions:** `raidModify`, `poolCreate/Delete/Add/Remove`, `raidImportShow/Apply`; fake pool + import-candidate state; deterministic failure hooks.
- **Contract revisions (T0):** wire `PATCH`/`DELETE /arrays/{id}` to real handlers (drop them from the stub loop); ADR-0006 §Import amendment; strike `spare_pool_deferred` from ADR/S3 spec; document the new blocker codes.

### Out of scope (unchanged ADR-0006 deferrals)
- Online reshape / capacity expansion; first-class `SparePool` objects; shared pools across arrays (one `xnsp_<array>` pool per array).
- A plan-time import-candidates discovery surface (an observed kind or on-demand RPC) — see §7; follow-on work.
- Day-1 Ansible↔desired-state reconcile (WS13).

---

## 2. Component map (additions over S3)

```
   api (unprivileged)                                  agent (root)
   ┌────────────────────────────────────────┐          ┌──────────────────────────────────┐
   │ tasks/engine.ts  + dangerous gate (§3)  │          │ task/xiraid-array-executor.ts    │
   │ plan/providers/xiraid-array.ts          │          │   create: + pool provisioning    │
   │   + modify / import / delete providers  │ task.begin│ task/xiraid-array-modify-exec…  │
   │ routes/arrays.ts                        │ ────────▶│ task/xiraid-array-import-exec…   │
   │   + PATCH /arrays/:id, DELETE /arrays/:id│          │ task/xiraid-array-delete-exec…   │
   │   (removed from the stub loop)          │          │ xiraid/client.ts (+modify, pool*,│
   └────────────────────────────────────────┘          │   import*) + fake-transport      │
                       shared: lib/xiraid/{schema,validate,translate} (+modify rules)
```

One provider/executor file pair per operation kind, mirroring S3's create pair. The shared `XiraidClient` gains the new verbs; collector unchanged.

---

## 3. Engine dangerous gate (reqs §14, ADR-0006 §Delete)

`TaskEngine.apply`'s `ApplyRequest` gains `dangerous?: boolean` (default absent ≡ `false` — matching the OpenAPI `ApplyRequest.dangerous` default). Inside the existing apply transaction, **before** lease acquisition:

```
plan.risk_level === 'destructive' && applyReq.dangerous !== true
  → PRECONDITION_FAILED { reason: 'dangerous_flag_required' }   (nothing written)
```

- Enforced **in the engine**, not per-route: every transport that reaches `apply` hits the same gate ("blocked at the same place" — §14's verification clause).
- Plan-mode for destructive kinds always lists the advisory blocker `dangerous_flag_required` ("apply must carry dangerous: true"). The **apply-time blocker re-check filters this one code out** — the engine owns its enforcement; re-checking it as a plan blocker would 412 every apply (§8).
- Routes pass the body's `dangerous` through to `applyReq` verbatim; non-destructive kinds ignore it.

## 4. Freshness binding (`expected_revision` per operation)

The OpenAPI `ApplyRequest` requires `expected_revision`. The plan row does not persist `observed_revision_expected` (S2 fact, above), so S4 binds freshness **at the route**, uniformly:

| Operation | plan returns | apply must send | route check at apply |
|-----------|--------------|-----------------|----------------------|
| create | `state_revision_expected: 0` (array absent) | `expected_revision: 0` | `=== 0` (S3, unchanged) |
| modify / delete | `observed_revision_expected` = the observed `XiraidArray` row revision at plan time | that same value | `===` the **current** observed row revision; drift → `PRECONDITION_FAILED { reason: 'observed_revision_stale', expected, current }` |
| import | `state_revision_expected: 0` (the control-path id must not exist) | `expected_revision: 0` | `=== 0` + `name_taken` re-check |

A future migration may persist the observed pin and let the engine's `plan_stale` path take over; until then the route check is the single freshness gate for arrays, and providers do **not** set `observed_revision_expected` in their `PlanResult` (it would be checked at plan-task-build time against `affected_resources[0]` and then lost — setting it without persistence buys nothing and risks confusion).

## 5. Modify (`xiraid.array.modify`, `PATCH /arrays/{id}`)

**Request shape.** `{ mode, spec: { spare_disk_ids?, tuning? } }` (+ `plan_id`/`expected_revision`/`idempotency_key` on apply). The array id comes from the path; `spec.name` is not accepted.

**Writability enforcement (pre-plan).** Any topology field present in the PATCH spec (`name`, `level`, `member_disk_ids`, `group_size`, `synd_cnt`, `strip_size_kib`, `block_size`, `force_metadata`) → `UNSUPPORTED` (422) with the ADR-0006 per-field shape (`reason: 'topology_immutable'`) **before** any plan row is written.

**Provider preflight.**
1. The array must exist in observed state (else `NOT_FOUND`); read its observed `spec` as the *before*.
2. `validateModifySpec`: tuning ranges (reusing the create rules); spare disks resolved + checked exactly like create members (`disk_not_found`/`disk_not_safe`/`disk_is_system`/`disk_in_use` — a disk spared to **this** array's current pool is not "in use").
3. `affected_resources = [ XiraidArray#id (primary, first), …added/removed spare Disks ]`.
4. `risk_level: non_disruptive`, `rollback_model: non_disruptive`.
5. `diff = { before: { spare_disk_ids, tuning? }, after: { spare_disk_ids, tuning }, raid_modify_request, pool_ops: [...] }`.
6. **`enriched_spec`** embeds: `{ id, spare_disk_ids?, tuning?, device_by_id }`. *(Implementation refinement over the first draft: the executor captures the pool pre-state — live sparepool linkage, pool existence/membership/activation — at its own `preflight` via `raid_show` + `pool_show` under the held leases, keyed per-run on the spec object. That is strictly fresher than plan-time observed state, so the api does NOT ship `current_*` fields.)*

**Executor (`xiraid.array.modify`).** Stages ordered so the non-restorable part goes **last**:

| Stage | Action |
|-------|--------|
| `preflight` | Array exists in live `raid_show`; spare device paths exist and are not members of another array. |
| `apply_spares` | Pool lifecycle (only when `spare_disk_ids` changed): attach (∅→S): `pool_create { name: "xnsp_<array>", drives }` → **`pool_activate`** (analyst §3.8 — without activation auto-replace never arms) → `raid_modify { sparepool }`; membership change: `pool_add`/`pool_remove` deltas (pool stays active); detach (S→∅): `raid_modify { sparepool: '' }` → **`pool_deactivate`** → `pool_delete`. Pools named other than `xnsp_<array>` (day-1 Ansible pools) are never touched: a modify on an array with a foreign sparepool gets a `preflight` failure (`foreign sparepool '<name>' is not managed by the control path`). |
| `apply_tuning` | One tuning-only `raid_modify` (only when `tuning` present). Last: if it throws, the single call did not apply, and the pool rollback below restores structure. |
| `verify` | `raid_show` reflects the expected sparepool linkage. |

`rollback`: inverse **pool ops only** (incl. the activation state), computed from `enriched_spec.current_*` vs live `raid_show`/pool state (re-attach the prior pool, undo `pool_add`/`pool_remove`, re-create+activate or deactivate+delete `xnsp_<array>` as needed). Tuning needs no rollback by construction (it is the last stage and atomic). A rollback failure → `requires_manual_recovery` (S2 runner).

**Apply-time re-check compatibility.** The route's §8 re-check runs the provider preflight on the **persisted (enriched) spec**, so `parseModifySpec` is **tolerant**: it narrows `spare_disk_ids`/`tuning` and *ignores* unknown keys (`id`, `device_by_id`, `current_*` — the enrichment) rather than whitelisting. The **route** owns topology rejection, checking the **raw PATCH body** for topology keys before any plan (the parser never sees a raw body with topology keys on the plan path, and the enriched spec never contains them). Provider preflight is idempotent over its own enriched output: re-enrichment simply recomputes `device_by_id`/`current_*` fresh.

**Create-with-spares un-deferral.** `validateCreateSpec` drops `spare_pool_deferred`; spare disks get the same disk checks as members; the create provider leases spares + resolves them into `device_by_id`; `translate.toRaidCreateRequest` gains `sparepool: "xnsp_<name>"` when spares are present; the **create executor** gains a pool step inside `create` (`pool_create` → **`pool_activate`** before `raid_create`) and its `rollback` deactivates + deletes `xnsp_<name>` if present (after the array destroy).

## 6. Import (`xiraid.array.import`, `POST /arrays` import-shaped spec)

**Request shape.** `{ mode, spec: { uuid, new_name? } }`. The S3 route's import-shape rejection is replaced by real handling; create vs import discrimination stays "has `uuid`".

**Provider preflight (api-side, KV only).** `uuid` non-empty string; target control-path id = `new_name ?? uuid` must satisfy `NAME_RE` (`name_invalid`) and be free (`name_taken` vs observed arrays). `affected_resources = [ XiraidArray#<target-name> ]` (no disk leases — the foreign array's disks are by definition not free disks; the array-name lease serializes). `risk_level: non_disruptive`, `rollback_model: non_disruptive`. `diff = { adopt: { uuid, as: targetName }, validated_at: 'apply (agent raid_import_show)' }`. `enriched_spec = { uuid, new_name: targetName }`.

**Executor (`xiraid.array.import`).** `preflight` (live `raid_import_show()` → the `uuid` must be among the candidates and recoverable; the target name free in `raid_show`) → `adopt` (`raid_import_apply { uuid, new_name }`) → `verify` (`raid_show` lists the target name). `rollback`: if the target name appeared → **config-only un-adopt** `raid_destroy { name, config_only: true }` (data untouched), else no-op. The apply task terminates `success`; the adopted array then surfaces through the normal observe path in whatever state `raid_show` reports. (ADR-0004's `imported` *task* state remains the WS9 synthetic-provenance concept — not used here.)

### ADR-0006 conformance amendment (locked by this spec, T0 edits the ADR)

ADR-0006 §Import sketched *"Discovery: `mode=plan` calls `raid_import_show(drives)`"*. That is **not implementable under the privilege split**: only the agent (root) talks to the xiRAID daemon; the api-side `PlanProvider` has KV access only (`PlanContext = { kv }`). S4 therefore validates the UUID **at executor preflight** (apply time), and plan-mode validates what the api can know (shape, target-name availability). A plan-time discovery surface (an observed `import-candidates` annex published by the collector, or a real on-demand agent RPC) is follow-on work; until then clients learn candidate UUIDs from xiRAID tooling. T0 amends the ADR's Import paragraph accordingly.

## 7. Delete (`xiraid.array.delete`, `DELETE /arrays/{id}`)

**Request shape.** `{ mode }` for plan; `{ mode, plan_id, expected_revision, idempotency_key, dangerous }` for apply. No spec — the id comes from the path.

**Provider preflight.**
1. Array exists in observed state (else `NOT_FOUND`); capture observed `spec` + revision.
2. **Dependency walk** (observed/desired state — field locations per the verified collector shapes, NOT the public read schema):
   - `Filesystem`s (observed) with **`status.backing_device`** `== /dev/xi_<id>` → each with **`status.mounted`** `== true` → blocker `dependent_filesystem_mounted`. (Observed Filesystem rows carry no `spec`; the collector emits everything under `status`.)
   - `Share`s (desired, `spec.path` under a dependent filesystem's **`status.mountpoint`**) → listed in blast radius; each with an observed `NfsSession` whose `spec.export_path` is at/under the share path → blocker `dependent_share_active`.
3. **Always** the advisory blocker `dangerous_flag_required` (§3).
4. `affected_resources = [ XiraidArray#id (primary, first), …dependent Filesystems, …dependent Shares ]` — dependents leased so a concurrent fs/share op cannot race the delete.
5. `risk_level: 'destructive'`, `rollback_model: 'unsupported'`.
6. `diff` carries the full blast radius regardless of blockers: `{ destroys: { array, volume_path, member_disk_ids }, dependent_filesystems: [...], dependent_shares: [...], active_sessions: [...] }`.

**Route apply.** Re-runs preflight against current state and rejects on any blocker **except `dangerous_flag_required`** (the engine owns that one, §3); binds `expected_revision` per §4; passes `dangerous` into `applyReq`.

**Executor (`xiraid.array.delete`).**
- `preflight` — two live host-level guards, closing the route-recheck→destroy TOCTOU window the api cannot close (the executor has only `spec`, no KV — but it runs as root on the host):
  1. the array exists in live `raid_show` (vanished → fail before change);
  2. **the volume is not mounted**: an injected `readMounts()` (real impl: read `/proc/self/mountinfo` + the existing `lib/parse/mountinfo.ts`) must show no mount whose source device is `/dev/xi_<name>` — a mount that appeared after the route re-check fails the preflight here. Active NFS sessions on a dependent share require that share's filesystem to be mounted, so the mount guard subsumes the session race for data safety; the api-side blockers remain the richer, user-facing signal.
- `destroy` — `raid_destroy { name, force: true }`; if the array had an `xnsp_<id>` pool, `pool_deactivate` + `pool_delete` it after.
- `verify` — gone from `raid_show`.

**`rollback()` is live-state decided** (NOT an unconditional throw): if the array **still exists** in `raid_show`, nothing destructive happened (a `preflight` failure — busy volume, vanished-then-reappeared race) → rollback is a **no-op** → terminal `failed (FAILED_PARTIAL_ROLLED_BACK)`, a clean retryable failure. If the array is **gone or `raid_show` is unreachable**, the destroy started and its effects are unknowable → **throw** (`'destructive operation: rollback unsupported'`) → `rollback_failed` → terminal `requires_manual_recovery (FAILED_MANUAL_RECOVERY_REQUIRED)` — ADR-0006's "no rollback for a destructive op" applies to *attempted destruction*, not to a preflight that touched nothing.

## 8. Apply-time blocker re-check (generalized from S3 T8)

The S3 route re-runs the create provider's preflight at apply. S4 generalizes: each arrays route handler re-runs **its own** provider preflight against current state and rejects `PRECONDITION_FAILED { blockers }` when any blocker **other than `dangerous_flag_required`** remains. This catches drift since plan time (a disk claimed meanwhile, a session opened on a dependent share). The sequence is: route re-check (fresh blockers) → engine apply txn (idempotency + dangerous gate + freshness + leases) → dispatch. The residual TOCTOU window between the re-check and lease acquisition is closed by the executor's own preflight against live daemon state, exactly as in S3.

## 9. Client adapter + fake transport extensions

`agent/xiraid/client.ts` (+ availability tracking, unchanged pattern) gains:
`raidModify(req)`, `poolCreate({name, drives})`, `poolDelete({name})`, `poolAdd({name, drives})`, `poolRemove({name, drives})`, `poolActivate({name})`, `poolDeactivate({name})`, `poolShow()`, `raidImportShow()`, `raidImportApply({uuid, new_name?})` — thin delegations to the existing `src/grpc/` wrappers.

`fake-transport.ts` state file gains `pools: [{name, drives, active}]`, `import_candidates: [{uuid, name, level, devices, recoverable}]`, and `tombstones: [{name, data_wiped}]` (seedable by the e2e):
- `raidModify` updates the named array's `sparepool`/tuning echo; `pool*` mutate `pools` (duplicate name / missing pool → reject; `pool_delete` of an **active** pool → reject, forcing the deactivate-first order; activate/deactivate flip `active`).
- `raidImportShow` returns `import_candidates`; `raidImportApply` moves a candidate into `arrays` (state `['online']`) under `new_name ?? name`; unknown uuid → reject.
- `raidDestroy` appends a tombstone: `data_wiped: true` for a plain destroy, and removal **without** a wipe marker for `{ config_only: true }` (the e2e asserts un-adopt ≠ data wipe).
- Failure hooks stay name-deterministic: any mutating verb against a name ending `-fail` rejects (the S3 `roll-fail` pattern, extended to every new verb); additionally a `raidModify` carrying **tuning keys** (any field beyond `name`/`sparepool`) against a name ending `-fail-tuning` rejects — this targets the tuning stage specifically while pool ops on `xnsp_<name>-…` still succeed (a plain `-fail` name would trip the pool ops first).

## 10. Error model — reuse existing codes (no additions)

New **blocker codes** (plan `blockers[]`, not `ErrorCode`s): `dangerous_flag_required`, `dependent_filesystem_mounted`, `dependent_share_active`, `uuid_invalid`, `foreign sparepool` surfaces as an executor failure (not a plan blocker — the api cannot see pool ownership). New `details.reason` discriminators on `PRECONDITION_FAILED`: `dangerous_flag_required` (engine), `observed_revision_stale` (route). Topology writes on PATCH → `UNSUPPORTED` (422). Everything else unchanged from S3/S2.

## 11. Contract revisions (T0)

1. **ADR-0006 edits:** §Import — the discovery amendment (§6 above); §Spare pools — strike the `spare_pool_deferred` deferral sentence (un-deferred by S4); §Preflight blockers — drop `spare_pool_deferred`, the delete codes already listed stay.
2. **S3 spec edits:** mark the deferred-ops section + `spare_pool_deferred` blocker as superseded by this spec (one-line pointers; the S3 doc stays the observe+create contract).
3. **api-v1.yaml:** document the `PRECONDITION_FAILED` `details.reason ∈ dangerous_flag_required | observed_revision_stale | create_expects_revision_zero` discriminators in the error description (no new top-level codes); the `PATCH`/`DELETE /arrays/{id}` operations are already specified — no path changes.
4. **No migration.** `dangerous` rides the existing OpenAPI `ApplyRequest`; no new columns.

## 12. Testing strategy

- **Unit:** engine dangerous gate (destructive+flag absent → 412 `dangerous_flag_required`, nothing written; flag true → proceeds; non-destructive ignores); `validateModifySpec` (topology rejection is route-level — validator covers tuning ranges + spare disk rules incl. own-pool exemption; the parser tolerates enrichment keys so the apply re-check accepts its own plan); modify/import/delete providers (blockers, `affected_resources` ordering + dependent leasing, enriched_spec contents incl. `current_*` capture, the **status-shaped** Filesystem dep walk); the three executors over the in-memory fake (modify: attach-with-activation/changemembers/detach-with-deactivation + tuning-last ordering + pool rollback inverse; import: adopt/unknown-uuid/un-adopt rollback; delete: destroy + pool cleanup / **mounted-volume preflight guard** / vanished-array → clean `failed` via no-op rollback / destroy-failure → rollback-throws → `requires_manual_recovery`); create-with-spares (pool_create→pool_activate before raid_create; rollback deactivates+deletes the pool); fake-transport pool-activation/import/`config_only`/`-fail-tuning` behaviors.
- **Route:** PATCH topology field → 422 per-field; PATCH/DELETE plan+apply happy paths; `expected_revision` binding (`observed_revision_stale`); delete apply without `dangerous` → 412 `dangerous_flag_required` (the engine, through the route); blocker re-check filters `dangerous_flag_required` but enforces the rest; import-shaped POST now plans instead of 422.
- **e2e** (extends the S3 suite's fixture pattern): **modify** — attach spares to the created array + set tuning → success → observed `spec.spare_disk_ids` updated; **import** — seed an `import_candidate`, plan+apply adopt → success → array observable; **delete** — apply without `dangerous` → 412; with a seeded dependent mounted filesystem → 412 `dependent_filesystem_mounted`; clean array + `dangerous: true` → success → gone from `GET /arrays`; `-fail` hooks exercise one rollback path.
- **Gate:** `npm test` · `npm run test:e2e` · `npm run test:contracts` · `npx tsc --noEmit` · `npm run lint` all green.

## 13. Decomposition (T0–T11)

| # | Task |
|---|------|
| **T0** | Contract revisions per §11 (ADR-0006 import amendment + spare un-deferral; S3 spec pointers; api-v1.yaml reason discriminators). `npm run test:contracts`. |
| **T1** | Engine dangerous gate: `ApplyRequest.dangerous` + the txn check + tests; routes pass `dangerous` through (reference route ignores it — non-destructive). |
| **T2** | Client adapter + fake transport: `raidModify`/`pool*`/`raidImport*`, pools + import_candidates state, `config_only`, `-fail` hooks. TDD. |
| **T3** | `lib/xiraid`: `validateModifySpec` + spare-rule reuse; drop `spare_pool_deferred`; `translate` gains `sparepool` render + `toRaidModifyRequest`. TDD. |
| **T4** | Create-with-spares un-deferral: create provider (lease+resolve spares) + create executor pool step + rollback pool cleanup. TDD. |
| **T5** | Modify provider (+`enriched_spec` `current_*` capture) + `PATCH /arrays/:id` route (topology 422 pre-plan; §4 binding; §8 re-check). TDD. |
| **T6** | Modify executor (pool lifecycle stages, tuning last, inverse-pool rollback, foreign-pool guard). TDD. |
| **T7** | Import provider + POST route import-shape handling (replaces the 422 rejection). TDD. |
| **T8** | Import executor (`raid_import_show` preflight, adopt, config-only un-adopt rollback). TDD. |
| **T9** | Delete provider (dep walk + blast radius + advisory blocker) + `DELETE /arrays/:id` route (dangerous passthrough; filtered re-check). TDD. |
| **T10** | Delete executor (destroy + pool cleanup + rollback-throws → manual recovery). TDD. |
| **T11** | e2e per §12 + the full verification gate. |

## 14. Open questions / risks

- **`raid_import_show` candidate shape** — pin the field names (uuid/name/recoverability) against `proto/xraid` + the analyst doc in T2 before the fake transport mimics them (the S3 "confirm-first" pattern).
- **Pool/array name collision space** — `xnsp_<array>` assumes pool and array names don't share a namespace constraint tighter than `NAME_RE` length 63 (`xnsp_` + 63 may overflow a daemon limit); cap the derived pool name or validate combined length in T3.
- **Tuning observe gap** — modify's `before` diff for tuning is only what observed state knows (nothing today). The diff shows `before.tuning: null` honestly; a later parse/raid extension can enrich it.
- **Observed-vs-public Filesystem shape divergence** — observed rows are status-only while the api-v1.yaml `Filesystem` schema has `spec.backing_device`; the dep walk reads the live observed shape (§7). The read-path projection (or a collector reshape) reconciling the two is pre-existing WS6 territory, not S4's.
- **`/proc/self/mountinfo` field for the mount guard** — implement the device match against `lib/parse/mountinfo.ts`'s `MountEntry` source-device field (confirm the exact field name in T10 when wiring `readMounts()`).
