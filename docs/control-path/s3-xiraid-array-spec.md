# xiNAS S3 — xiRAID array adapter: observe + create (design spec)

**Status:** design (brainstormed 2026-06-07; revised 2026-06-10 after implementability review — agent sandbox, disk enrichment, spare deferral, contract-enum alignment). First *real* operation provider on the S2 task engine. Implementation plan: `docs/plans/2026-06-10-s3-xiraid-array-observe-create-plan.md`.

**Goal.** Make xiRAID arrays **visible** and **creatable** through the control-path API: replace the stubbed `XiraidArray` collector with a real one (arrays observable), and add a `create` plan/apply provider + executor on the S2 task engine — proven end-to-end through an injected fake xiRAID gRPC transport. **Modify / import / delete** are designed in ADR-0006 and built in follow-on plans; this spec scopes **observe + create only**.

**Authoritative prior art (this spec conforms to it).**
- **ADR-0006** (XiraidArray schema + Phase-0 writability, **Accepted**, revised 2026-06-10) — the canonical schema, writability matrix, identity (`id == spec.name`), disk-reference + resolution model, spare-pool model, transport + agent-sandbox prerequisite, and per-operation contracts. This spec does not re-decide them.
- **ADR-0004** + the **S2 task engine** (landed) — `PlanProvider`/`Executor` registries, `tasks`/`task_stages`/`leases`, `LeaseManager`, the apply transaction + dispatch + reconcile, the progress push + SSE watch. The create provider/executor plug into this engine unchanged.
- The read-path `XiraidArray` schema + `GET /arrays[/:id]` routes already in `api-v1.yaml` / `src/api/routes/storage.ts`.

**This spec does NOT** invent a new task store, a new error code, a CLI parser, or a second validation home. It reuses the S2 engine, the existing gRPC client, and a single shared `lib/xiraid` module (ADR-0005's no-duplication rule).

---

## 1. Scope

### In scope (S3)
- **Agent sandbox prerequisite:** `xinas-agent.service` gains `AF_INET AF_INET6` in `RestrictAddressFamilies` (+ `IPAddressAllow=localhost` / `IPAddressDeny=any` hardening) so the agent can dial the xiRAID daemon's TLS-TCP endpoint. Ships with **`Requires-Rebuild: xinas_agent`** (ADR-0006 §Agent sandbox prerequisite).
- **Disk enrichment:** the disk parser/probe/collector additionally emit `device_path`, `size_bytes`, `system_disk`, `mounted`, `safe_for_use` (ADR-0006 §Disk references) — prerequisites for array preflight; also makes the existing `GET /disks?safe_for_use=` filter real on live data.
- A real **observe** collector (`agent/collectors/xiraid.ts`) over the gRPC `raid_show`, replacing `XiraidArrayStubCollector`; arrays appear in `/xinas/v1/observed/XiraidArray/<id>` and through `GET /arrays`.
- The shared **`src/lib/xiraid/`** module: `schema.ts`, `validate.ts`, `translate.ts` (per ADR-0006 §Validation and translation).
- The **create** path: `xiraid.array.create` `PlanProvider` (`api/plan/providers/xiraid-array.ts`), the `POST /api/v1/arrays` route (`api/routes/arrays.ts`, create-shaped spec), and the `xiraid.array.create` `Executor` (`agent/task/xiraid-array-executor.ts`).
- A small **gRPC client adapter** (`agent/xiraid/client.ts`) wrapping `src/grpc/` with an **injectable transport** so the collector + executor share one client and tests/e2e can inject a fake xiRAID.
- **Contract revisions (T0):** extend `XiraidArray.spec` in `api-v1.yaml` (incl. `raid7`/`raid70`); wire `POST /arrays` to the plan/apply contract; add the `XiraidArray.json` fixture; stub supersession (S2-T0 pattern, §10); normalize the reference provider's off-enum `rollback_model`.

### Out of scope (deferred — designed in ADR-0006, built later)
- **Modify**, **import**, **delete** — *superseded (2026-06-10): built by the **S4 spec** (`s4-xiraid-array-mutations-spec.md`).*
- **Create-with-spares:** non-empty `spare_disk_ids` on create → plan blocker `spare_pool_deferred` — *superseded: the S4 spec removes the blocker (create provisions + activates the pool).*
- **Online reshape / capacity expansion**, **first-class pool objects** (ADR-0006 *does NOT decide*).
- **xiRAID daemon transport hardening** (`xiraid_classic`/packaging concern).

### Deferred-route behavior while deferred
*(Historical — S4 replaces the PATCH/DELETE stubs with real routes.)* `PATCH /arrays/{id}` and `DELETE /arrays/{id}` keep the **existing** `handlers/unsupported.ts` mutating-stub semantics until their plans land: `UNSUPPORTED`/`EXECUTOR_UNSUPPORTED` (422) while the agent is online, `INTERNAL`/`EXECUTOR_UNAVAILABLE` (503) while it is offline. S3 replaces only the `POST /arrays` stub with the real route.

---

## 2. Privilege split & component map

The S0/S1/S2 boundary holds: **api (unprivileged)** owns the DB + plan/apply; **agent (root)** owns privileged execution and now also the **gRPC client to the xiRAID daemon** (TLS-TCP `localhost:6066` from `/etc/xraid/net.conf`; permitted by the S3 unit change).

```
            REST (POST /arrays plan/apply, GET /arrays)
                              │
   api (unprivileged)         ▼                          agent (root)
   ┌──────────────────────────────────────┐    UDS      ┌────────────────────────────────┐
   │ plan/providers/xiraid-array.ts        │  api→agent  │ task/xiraid-array-executor.ts  │
   │   (preflight: validate + disk checks  │ ─task.begin→│   preflight/create/wait/verify │
   │    + device_by_id resolution)         │             │   + rollback (raid_destroy)    │
   │ routes/arrays.ts (plan/apply, create) │             │ collectors/xiraid.ts (raid_show)│
   │ tasks/engine.ts (S2, unchanged)       │ ←progress── │ collectors/disk.ts (enriched)  │
   │ state/leases.ts  LeaseManager (S2)    │  agent→api  │ xiraid/client.ts (gRPC adapter) │
   └───────────────────┬──────────────────┘             └───────────────┬────────────────┘
                       │ shared (compiled into both)                     │ gRPC (TLS, localhost:6066)
                       ▼                                                  ▼
            src/lib/xiraid/{schema,validate,translate}.ts        xiRAID daemon (src/grpc/)
```

- **api side:** `plan/providers/xiraid-array.ts`, `routes/arrays.ts`. Reuses S2's `plan/engine.ts`, `tasks/engine.ts`, `tasks/store.ts`, `state/leases.ts`, `agent-client.ts`.
- **agent side:** `collectors/xiraid.ts` (replaces the stub), the **enriched** `collectors/disk.ts` + `lib/parse/disk.ts`, `task/xiraid-array-executor.ts` (registered in the S2 `ExecutorRegistry`), `xiraid/client.ts` (one injectable gRPC client shared by collector + executor).
- **shared:** `src/lib/xiraid/` — imported by the api provider (validate) and the agent executor (validate subset + translate); `src/lib/parse/raid.ts` (pure `raid_show` → schema mapping).
- **unit:** `xinas-agent.service` — `RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6` + `IPAddressAllow=localhost` / `IPAddressDeny=any`.

---

## 3. Shared `lib/xiraid` (the single logic home)

Per ADR-0006 / ADR-0005: API validation and agent rendering must not diverge.

- **`schema.ts`** — the `XiraidArraySpec` type (ADR-0006 schema incl. the full `tuning` block), the `level` enum (`raid0…raid70`, `n+m`), the writable-field metadata, and the level→constraints table (min drives per the xiRAID constants, whether `group_size`/`synd_cnt` is required).
- **`validate.ts`** — `validateCreateSpec(spec, facts): Blocker[]`. Rules (codes per ADR-0006 §Preflight blockers): min drives per level (per [AG / RAIDs explained](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/xiraid_raids_explained.html) — see the ADR-0006 amendment of 2026-08-14); even member count for `raid10`; `group_size ∈ [4,32]` for `raid50/60` and `[6,32]` for `raid70` (**corrected 2026-08-14** from a flat `[2,32]`; [CR / `xicli raid`](https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html) plus AG's per-level floor) & `member_count % group_size == 0` into ≥ 2 groups for `raid50/60/70`; `synd_cnt ∈ [4,32]` for `n+m`; `strip_size_kib` in the `STRIP_SIZES_KB` set; `block_size ∈ {512,4096}`; `tuning` priorities `[1,100]`, `memory_limit` `0`|`[1024,1048576]`, timings ≥ 0; `name` regex; **`spare_pool_deferred`** when `spare_disk_ids` is non-empty (S3). **Pure:** disk/array facts are passed in (`facts = { disks: ResolvedDisk[], existingArrayNames: string[] }`), so the same function runs in the api (observed state) and the executor re-runs its freshness subset (live `raid_show`).
- **`translate.ts`** — `toRaidCreateRequest(spec, deviceById): RaidCreateRequest`. Maps `level` (`raid6 → "6"`, `n+m` + `synd_cnt`), `member_disk_ids → drives` (via `deviceById`), `strip_size_kib → strip_size`, booleans → `0/1`, drops `null` tuning fields (→ xiRAID defaults). **Never emits `force`** (ADR-0006 §Excluded parameters). No sparepool rendering in S3 (deferred with spares).

---

## 4. Disk enrichment & resolution contract

**Enrichment (prerequisite).** `lib/parse/disk.ts` + the disk probe/collector extend the observed `Disk.status` with: `device_path` (`/dev/<name>`), `size_bytes` (lsblk `-b`), `system_disk` (any descendant partition mounted at `/`, `/boot`, `/boot/efi` — the `nvme_namespace` detection rule), `mounted` (any descendant mountpoint), `safe_for_use` (= `!system_disk && !mounted`). Existing fields are unchanged; the `GET /disks?safe_for_use=` filter becomes real on live data. Array **membership is not a collector concern** — the plan provider checks it against observed `XiraidArray`s.

**Resolution (plan time, api).** The provider resolves `member_disk_ids → device_path` from observed `Disk` state, validates each disk (exists / `safe_for_use` / not `system_disk` / not member|spare of an observed array → blockers `disk_not_found`/`disk_not_safe`/`disk_is_system`/`disk_in_use`), and **embeds the resolved `device_by_id` map in the operation spec** persisted on the plan task — the same `spec` the engine forwards in `task.begin`.

**Re-check (apply time, agent).** The S2 `ExecutorContext` exposes only `spec` (no KV) — deliberate; the map travels in the spec. The executor `preflight` re-checks under the held leases: every `device_by_id` path exists on the host, and none is already a member per a fresh `raid_show`. Disk *safety* is pinned at plan time and protected by the disk leases; the executor re-verifies *existence and membership* (what can actually change under a plan).

---

## 5. Observe path (collector)

`XiraidArrayCollector` replaces `XiraidArrayStubCollector`:

1. Each collection cycle, call `client.raidShow()` via the shared gRPC adapter. The real transport sends **`{ units: 'g', extended: true }`**: `extended` is what makes the daemon emit the tuning surface (priorities, memory/request limits, CPU affinity, scheduler + merge knobs) at all — without it `spec.tuning` can only ever be empty, and every client reads the array's tuning as unknown. (`units: 'g'` is separately required — an unset unit crashes the daemon's formatter, finding #17.)
2. Map each array → an `XiraidArray` observed object via the pure `lib/parse/raid.ts` (`spec` from config incl. current sparepool→disk-ids **and `tuning` from the extended payload**; `status` = `{ state, volume_path: /dev/xi_<name>, chunk_size_kib, rebuild/check_progress_pct, usable_capacity_bytes, memory_usage_mb, member_states, observed_at }`), unit-testable without a daemon.
   - **Tuning is observation, not desired state.** The daemon reports *effective* values, including its own defaults; the parser records what it read. Only keys the daemon actually emits are set — an absent knob stays absent rather than becoming a fabricated default, so a client can distinguish "not configured / not reported" from a real value. `spec.tuning` is omitted entirely when nothing was observed.
   - **Daemon → control-path names.** The daemon suffixes units (`memory_limit_mb`, `memory_prealloc_mb`, `merge_read_max_usecs`, …) where ADR-0006 `spec.tuning` does not. The parser renames, and accepts the unsuffixed spelling as an alias (that is the gRPC *request* spelling, and what the fake transport writes back on `raidModify`). Numeric strings coerce to numbers; xiRAID's `0`/`1` flags coerce to booleans. An empty `cpu_allowed` is an observed value ("all"), not an absent one.
   - **The discard surface is spelled `discard_allowed` / `discard_active`, and there is no `drive_trim`.** The `--discard` / `--drive_trim` spellings belong to `raid create`; `raid_show --extended` does not use them. Verified on a live node (`xicli 4.4.0`, driver `4.4.0-43861`): the payload's discard keys are `discard_allowed` (configured to accept discards), `discard_active` (processing them right now), `discard_ignore`, `discard_verify`, plus `drive_write_through`. The parser aliases **`discard_allowed` → `spec.tuning.discard`** — config, and the same knob `raid create --discard` sets — and lifts **`discard_active` → `status.discard_active`**, because whether discards are *in effect* is observation with no write surface, the same split as `memory_usage_mb` vs `spec.tuning.memory_limit`. The two genuinely diverge: on the reference node `log` reads `allowed=1 active=1` while the still-initializing `data` reads `allowed=1 active=0`. **`drive_trim` is not read at all** — it is a create-time action (TRIM the disks *before* the array exists), not array state, so no `raid_show` will ever report it, and a `tuning.drive_trim` sourced from it could only ever be absent. `discard_ignore` / `discard_verify` are deliberately not observed yet ([docs/TODO.md](../TODO.md)): both are `raid modify` knobs, so observing them without also plumbing a PATCH rejection would offer a write path the vendored `RaidModify` descriptor cannot carry.
   - **`cpu_allowed` is an ARRAY on the wire, a STRING in the model.** The real daemon reports the affinity as a JSON array of core ids (`[5, 6, 7]`); only the fake transport writes back the string. `api-v1.yaml` types `spec.tuning.cpu_allowed` as a string and the TUI validates it against `^\d+(-\d+)?(,\d+(-\d+)?)*$`, so the parser renders the array into that spelling, **range-compressed** the way `/sys/devices/system/node/nodeN/cpulist` and xicli write a CPU list: `[5,6,7]` → `"5-7"`, `[0,2,4,5,6]` → `"0,2,4-6"`. Ids are sorted and de-duplicated first; an empty array renders `""`, the same observed "all" as the empty string. Accepting only the string shape is how a pinned array read as `unknown` in every client while it really was pinned — the same fake-transport assumption that hid `usable_capacity_bytes` until the `size` string was handled. A **bare** number (`cpu_allowed: 7`) stays unreadable on purpose: it is ambiguous between core 7 and a bitmask, and guessing misreports which cores the array is pinned to.
3. Member device paths map **back** to `Disk` ids via observed `Disk` state so `member_disk_ids` is in control-path identity.
4. Publish deltas via the existing push model (Flow A).
5. **Daemon unavailable** (connect refused / timeout / TLS failure): the collector reports `error` with reason `XIRAID_DAEMON_UNAVAILABLE` → the node honestly reads `degraded` (the systemd-collector precedent), never fabricated or stale-as-fresh data.

The collector shares the **one** injected `XiraidGrpcClient` with the executor and observes its availability state.

### 5.1 `size` → `usable_capacity_bytes`

The daemon renders an array's size **with the unit it was asked for**, and the
adapter always calls `raid_show` with `units:'g'` (a missing unit makes the
daemon's formatter throw — #17). A live array therefore reports `size` as a
formatted **string** (`"1.2T"`, `"163.727G"`, `"163.727"`), not a byte count —
see the `raid_show` response in
[config-history/grpc-api-reference.md](../config-history/grpc-api-reference.md).
Sibling fields do not share that shape: `strip_size` arrives as a plain number.

`lib/parse/raid.ts` converts, and `status.usable_capacity_bytes` is always an
integer count of bytes (the api-v1 schema types it `integer`):

| `size` as reported | → `usable_capacity_bytes` |
|---|---|
| `"1.2T"` / `"1.2 TiB"` / `"1.2TB"` | `1.2 × 1024⁴`, rounded |
| `"500M"`, `"163.727G"`, `"12K"`, `"1024B"` | binary multiplier for `k/m/g/t/p/e`, optional `i`/`B` |
| `"163.727"` (no unit) | GiB — the unit the adapter requested |
| `15360000000000` (JSON number) | bytes, verbatim (the fake transport / contract-fixture shape) |
| anything else (`""`, `"n/a"`, absent) | field omitted — clients render `N/A` |

Accepting only JSON numbers is what shipped capacity as `N/A` for every array
on a real node while every other field rendered.

### 5.2 `devices` → `status.member_states`

The daemon's `raid_show` reports each member in the array's `devices` list.
The parser reads the member out of all three shapes it can arrive in and
records the per-member state on `status.member_states`, one object per member:

| `devices` entry as reported | shape | → member |
|---|---|---|
| `"/dev/nvme1n1"` | bare string (fake transport / xicli) | `{ index: <position>, device, states: [] }` |
| `[0, "/dev/nvme1n1", ["online"]]` | `[index, path, [states]]` tuple (real xiRAID 4.3.x) | `{ index: 0, device, states: ["online"] }` |
| `{ path\|device\|device_path\|name, state\|states, index? }` | per-device object (gRPC reference shape) | `{ index, device, states }` |

- `device` is the member's path mapped **back** to its control-path `Disk`
  id via the same `diskIdByPath` lookup as `member_disk_ids` (an unknown
  path falls back to the raw path), so `member_states[i].device` matches
  `member_disk_ids[i]` and a client can correlate the two by identity.
- `index` is the member index the daemon reports (tuple position `[0]` /
  object `index`), else the entry's position in the list.
- `states` are the lower-cased state words, using the same `normalizeStates`
  reader as the array-level state; a member the daemon reports no state for
  (the bare-string shape) carries `states: []`.
- Entries with **no readable path** are dropped, so `member_states` stays
  index-aligned with `member_disk_ids` (both derive from the same filtered
  member list).

This is what lets a client render the array's device breakdown as
`N total | k online | j degraded | i offline` instead of a bare total: the
member states were being parsed and **discarded** (the parser hardcoded
`member_states: []`), so every member read as `unknown` and the breakdown
collapsed to the total. Observation, not intent — a member state the daemon
did not report stays absent rather than defaulting to `online`.

---

## 6. Create — plan / apply flow

### 6.1 Plan (`mode=plan`)
`xiraid.array.create` `PlanProvider.preflight(ctx, spec)`:
1. Resolve disks + gather facts from observed state (§4).
2. `validate.validateCreateSpec(spec, facts)` → structural + RAID-semantic + disk + `name_taken` + `spare_pool_deferred` blockers.
3. `affected_resources = [ {kind:'XiraidArray', id:name} (first), …member Disk refs ]`.
4. `risk_level: 'non_disruptive'`, `rollback_model: 'non_disruptive'` (api-v1.yaml enums); `state_revision_expected` **omitted** (array does not exist); `diff` = the rendered `RaidCreateRequest` preview + `"creates /dev/xi_<name>, consumes [device paths]"`.
5. The spec persisted on the `plan_only` task **includes `device_by_id`** (§4).

The S2 `PlanEngine` writes the `plan_only` task (with `plan_hash` + the raw spec) and returns it.

### 6.2 Apply (`mode=apply`)
The apply body is the **full OpenAPI `ApplyRequest`**: `{ mode:"apply", plan_id, expected_revision, idempotency_key }` (+ `dangerous` for destructive kinds — not create). For create, **`expected_revision = 0`** by ADR-0006 convention (object must not exist). Then the unchanged S2 path: `routes/arrays.ts` looks up the `plan_only` task → `taskEngine.apply` (idempotency + freshness + `LeaseManager.acquire` on the array + member disks, one `db.transaction`) → `taskEngine.dispatch` (`task.begin(task_id, 'xiraid.array.create', spec, plan)`). Accept → `202` + running Task; agent unavailable → `failed (FAILED_BEFORE_CHANGE)` + leases released + `503`. The route mirrors `routes/reference.ts` but conforms to the full `ApplyRequest` (the reference route's missing `expected_revision` is normalized in T0).

---

## 7. Create executor (agent)

`xiraid.array.create` `Executor` registered in the S2 `ExecutorRegistry`. Stages (the runner auto-emits `snapshot_before`/`snapshot_after` around them via the xinas_history bridge):

| Stage | Action |
|-------|--------|
| `preflight` | Re-check under the held leases (§4): every `device_by_id` path exists; none already a member per fresh `raidShow()`; name not taken on the daemon. Throw → fail before any change. |
| `create` | `translate.toRaidCreateRequest(spec, deviceById)`; `client.raidCreate(req)`; on success set the in-executor `created` flag. |
| `wait_online` | Poll `client.raidShow()` until `state ∈ {optimal, rebuilding}` or timeout (initializing arrays count as created; do not wait for full init/rebuild). |
| `verify` | Confirm `/dev/xi_<name>` present + the array in `raidShow()`; emit final output. |

`rollback(ctx)`: if `created` → `client.raidDestroy(name, force)`; else no-op (a `preflight` failure has nothing to undo). A failed `create`/`wait_online` therefore rolls back to "no array"; a failed rollback → `requires_manual_recovery (FAILED_MANUAL_RECOVERY_REQUIRED)` per the S2 runner. Cancellation (`ctx.isCancelRequested()`) is checked between stages.

---

## 8. gRPC client integration & fixture seam

`agent/xiraid/client.ts` wraps `src/grpc/` exposing `raidShow()` / `raidCreate(req)` / `raidDestroy(name, force)` (the only verbs S3 needs). The underlying transport is **injected** (constructor param), defaulting to the real TLS-TCP channel from `/etc/xraid/net.conf`. This is the same dependency-injection seam S2 used for `runSubprocess`/`now()`:

- **Unit tests** inject a fake transport returning canned `raid_show`/`raid_create` results, including failure + unavailable.
- **e2e** injects a **fake xiRAID transport** at the agent boundary (the agent's existing fixture mode, analogous to S2's fake-`python3` shim) that simulates create + show, so the round-trip is real without a xiRAID install.

Connection lifecycle (connect on start, reconnect on drop, availability flag) lives here; the collector + executor read its availability. **Prerequisite:** the unit-file change in §1 — without `AF_INET`, `connect()` fails with `EAFNOSUPPORT` regardless of code.

### Payload shapes — one reader, no local copies

`raid_show` and `pool_show` each return **two shapes in the wild**: a JSON array
of entries (what the fake transport emits) or an **object keyed by name**
(`{"data": {...}, "log": {...}}` — the real xiRAID 4.3.x daemon). Both list
devices either as `["/dev/…"]` or as tuples whose device path is **not at a
fixed index** (`[idx, "/dev/…", [states]]`, `[idx, "/dev/…", "SERIAL"]`); read
the path by scanning the tuple for the `/dev/…` string.

Both also report `state` as a **list of words**, not a bare string — a real pool
reads `{"e": {"devices": [], "name": "e", "serials": [], "sizes": [],
"state": ["active"]}}`. A string-only reader observes every live pool as
INACTIVE, which silently disarms the `pool_active` plan blocker *and* the pool
delete executor's live preflight, so an active pool becomes deletable.

Every consumer — collectors **and** task executors — MUST read these payloads
through `lib/parse/raid.ts` (`parseRaidShow`, `parseRaidShowEntries`) and
`lib/parse/pool.ts` (`parsePoolShow`). A local `Array.isArray(payload)` reader is
a defect: against the real daemon it silently yields an empty list, so every live
array reads as **absent** — preflight refuses to delete or modify a real array,
create skips its name-collision and claimed-device guards, and pool-delete skips
its "still referenced as a spare pool" guard. Unit tests that only exercise the
array-shaped fake transport will not catch it; cover both shapes.

---

## 9. Error model — reuse existing codes (no additions)

- Validation / disk / name / spare-deferral blockers → plan `blockers[]`; unresolved at apply → `PRECONDITION_FAILED`.
- Bad request body → `INVALID_ARGUMENT`.
- Lease contention (array or a member disk) → `CONFLICT { reason: "lease_held", holder_task_id }` (S2).
- xiRAID daemon down at apply → `INTERNAL` / `EXECUTOR_UNAVAILABLE` (503); deferred PATCH/DELETE per §1 *Deferred-route behavior*.
- Topology write on a future `PATCH` → `UNSUPPORTED` (ADR-0006 matrix).

**No new `ErrorCode` values; no `errors.ts` change.** Blocker codes are the ADR-0006 §Preflight set. `risk_level`/`rollback_model` use the api-v1.yaml enums only.

---

## 10. Contract revisions (T0)

1. **`api-v1.yaml`:** extend `XiraidArray.spec` to the ADR-0006 surface (full `tuning`, `group_size`/`synd_cnt`/`block_size`/`force_metadata`, `raid7`+`raid70` in the level enum); wire `POST /arrays` (`createOrImportArray`) request/response to the plan/apply contract (create-shaped spec for S3; import-shaped deferred). No new top-level error codes.
2. **Contract fixture:** add `src/__tests__/contracts/fixtures/XiraidArray.json` matching the extended schema.
3. **Stub supersession (S2-T0 pattern):** remove `arrays.create`/`arrays.delete`/`arrays.import`/`spare.set` from `STUB_METHOD_NAMES` (`stubs.ts`) **and** `REQUIRED_STUB_METHODS` (`stubs.test.ts`); edit the S0/S1 spec's RPC table (`xinas-agent-s0s1-spec.md` §Agent's RPC surface) to mark those four *superseded by the task envelope (S3)* — mutations dispatch via `task.begin`, so the names leave the enumerated surface and a `-32601` for them is correct, not a contract violation. **Keep** `arrays.list` (deferred on-demand read, WS12 family).
4. **Enum normalization:** change the reference provider's `rollback_model: "reversible"` → `"non_disruptive"` (the current value is outside the api-v1.yaml enum); arrays route + reference route both accept the full `ApplyRequest` (incl. `expected_revision`).
5. **This spec + ADR-0006** stay in sync with the contract.

---

## 11. Testing strategy

- **Unit:**
  - `lib/parse/disk` enrichment — `device_path`/`size_bytes`/`system_disk`/`mounted`/`safe_for_use` derivation (system-disk via `/`, `/boot`, `/boot/efi` descendants).
  - `lib/xiraid/validate` — a level→rules table (min drives; `group_size`/`synd_cnt` required & ranges incl. raid70; member divisibility; strip/block sets; tuning ranges; name regex; `spare_pool_deferred`); pure-facts contract.
  - `lib/xiraid/translate` — golden `spec → RaidCreateRequest` (level mapping, `n+m`+`synd_cnt`, boolean→`0/1`, `null` tuning dropped, full-tuning golden incl. `max_sectors_kb`/`sdc_prio`/`discard`/`drive_trim`/`single_run`; asserts `force` never set).
  - `lib/parse/raid` — `raid_show` response → `XiraidArray` (incl. device→`Disk`-id mapping; degraded/rebuild status; sparepool→`spare_disk_ids`).
  - provider `preflight` — blockers, `affected_resources` ordering (array first), disk-safety/membership, `name_taken`, `device_by_id` embedding.
  - executor — success; `create` failure → `rollback` (`raid_destroy`); daemon-unavailable; cancel between stages; preflight re-check failure (mock gRPC transport).
  - collector — `raid_show` → deltas; daemon-down → `error`/degraded.
- **Contract:** `XiraidArray.json` validates against the extended schema; `POST /arrays` plan/apply request/response shapes (incl. `expected_revision`).
- **e2e** (`vitest.e2e.config.ts`, injected fake xiRAID transport): plan → apply `create` → poll `/tasks/{id}` to `success` → `snapshot_before/after` set → `GET /arrays` shows the new array; and the `create`-failure → `rollback` → `failed (FAILED_PARTIAL_ROLLED_BACK)` path.
- **Gate (final task):** `npm test` · `npm run test:e2e` · `npm run test:contracts` · `npx tsc --noEmit` · `npm run lint` all green.

---

## 12. Decomposition (T0–T10)

| # | Task |
|---|------|
| **T0** | Contract revisions per §10: `api-v1.yaml` spec extension (+`raid7`/`raid70`), `POST /arrays` plan/apply wiring, `XiraidArray.json` fixture, stub supersession (stubs.ts + stubs.test.ts + s0s1-spec RPC table), reference-provider `rollback_model` normalization. Validate with `npm run test:contracts`. |
| **T1** | `xinas-agent.service`: `RestrictAddressFamilies` + `AF_INET AF_INET6`, add `IPAddressAllow=localhost`/`IPAddressDeny=any`. Commit with **`Requires-Rebuild: xinas_agent`**. |
| **T2** | Disk enrichment: `lib/parse/disk.ts` (+ probe lsblk args: `-b`, mountpoints, children) + `collectors/disk.ts` passthrough → `device_path`/`size_bytes`/`system_disk`/`mounted`/`safe_for_use`. TDD. |
| **T3** | `src/lib/xiraid/schema.ts` + `validate.ts` (rules incl. `spare_pool_deferred`; pure facts). TDD. |
| **T4** | `src/lib/xiraid/translate.ts` (`spec → RaidCreateRequest`; never `force`). Golden tests. |
| **T5** | `agent/xiraid/client.ts` — gRPC adapter over `src/grpc/` with injectable transport; `raidShow/raidCreate/raidDestroy`; availability state. TDD with fake transport. |
| **T6** | `lib/parse/raid.ts` + `agent/collectors/xiraid.ts` — real observe collector (replaces the stub; device→Disk-id mapping; daemon-down → degraded); wire into the collector registry/convergence. TDD. |
| **T7** | `api/plan/providers/xiraid-array.ts` — create provider (resolution + validate + `device_by_id` embedding + `affected_resources` + diff); register in `PlanEngine`. TDD. |
| **T8** | `api/routes/arrays.ts` — `POST /arrays` `mode=plan\|apply` (full `ApplyRequest`,`expected_revision=0` convention); replace the POST stub in `app.ts` (PATCH/DELETE stay stubbed per §1). Route tests incl. idempotency + agent-unavailable. |
| **T9** | `agent/task/xiraid-array-executor.ts` — stages `preflight/create/wait_online/verify` + `rollback`; register in `ExecutorRegistry`; wire the shared client in `agent-server.ts`. TDD. |
| **T10** | e2e (fake xiRAID transport): create success + create-fail→rollback; run the full verification gate. |

---

## 13. Open questions / risks

- **`raid_show` field mapping** — confirm the exact gRPC response fields for `state` / `usable_capacity_bytes` / progress / member health / sparepool against `proto/xraid/` + the analyst doc when writing `lib/parse/raid.ts`. *(Partly resolved: `size` is a unit-formatted string, not a byte count — see §5.1; the tuning surface needs `extended: true` and a unit-suffix rename — see §5.)*
- **`wait_online` timeout** — pick a bound that tolerates large-array init without hanging the worker (cap=1) too long; initialization continues in the background after the task succeeds.
- **Disk-id stability** — the device→`Disk`-id mapping in observe and the id→device resolution at plan time must use the same `Disk` identity scheme; the parser's id is still the provisional device-name key (see the `PROVISIONAL` note in `lib/parse/disk.ts`) — verify against the collector's stable-key behavior during T2 and align if needed.
- **TLS material** — the adapter reuses `/etc/xraid/net.conf` + the CA cert exactly as `src/grpc/client.ts` does today; if the daemon's cert setup differs on a real node, that surfaces in T5/T10 and is a packaging concern (`xiraid_classic`), not a code one.
