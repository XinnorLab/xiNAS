# ADR-0006: XiraidArray object schema and Phase 0 writability

- **Status:** Accepted
- **Date:** 2026-06-07 (revised 2026-06-10 after implementability review)
- **Deciders:** Sergey Platonov
- **Supersedes:** —
- **Depends on:** [ADR-0001](0001-api-surface.md), [ADR-0002](0002-agent-privilege-model.md), [ADR-0003](0003-state-store.md), [ADR-0004](0004-task-engine.md)
- **Related requirements:** [phase0-requirements.md](../phase0-requirements.md) §14 (dangerous-flag gate); the **WS5 / M5** workstream in [phase0-sequencing.md](../phase0-sequencing.md) (exit: "Arrays visible through API; create/import/delete plan works; unsafe delete blocked with dependencies").

## Context

WS5 makes xiRAID arrays manageable through the control-path API: **visible** (observe), **creatable**, **importable**, and **deletable**, with the dangerous-flag gate (§14) on destruction and dependency-aware blast radius. Today the read-path `XiraidArray` object already exists in `api-v1.yaml`, but the agent collector is **stubbed** (`XiraidArrayStubCollector` → `XIRAID_ADAPTER_DEFERRED`), there is no parser, and the `POST/PATCH/DELETE /arrays` routes are unwired (they answer via the generic `handlers/unsupported.ts` mutating stub). The reserved granular agent RPC stubs `arrays.create/delete/import` and `spare.set` predate the S2 task engine.

The **S2 task engine** (ADR-0004) now provides the durable plan/apply + executor machinery, proven via a built-in reference executor. This ADR defines the **first real operation provider** on that engine. It locks the writable `XiraidArray` schema, the Phase-0 writability matrix, the agent↔xiRAID transport (including the agent sandbox change it requires), the identity + disk-reference model, the spare-pool model, the per-operation plan/apply contracts, and the destructive-delete dependency + dangerous gate — **before implementation**, the same way ADR-0005 locked `NfsProfile`.

Decisions taken during brainstorming (2026-06-07), which this ADR records:

- **Build scope.** The whole array model is designed here. The first implementation plan (S3) builds **observe + create**; **modify / import / delete** are locked in this ADR and built in follow-on plans. This keeps the destructive path as its own reviewable unit.
- **Transport.** The agent **reuses the existing gRPC client** (`xiNAS-MCP/src/grpc/`) to the xiRAID daemon for both observe (`raid_show`) and mutate (`raid_create` / `raid_modify` / `raid_destroy` / `raid_import_*`, pool ops). The agent gains a gRPC connection lifecycle. A `xicli` subprocess transport was considered and rejected for this object (see Rejected alternatives).
- **Writable surface.** The **approved Phase-0 create surface**: every `RaidCreate` parameter is writable at create **except `force`** (deliberately excluded — see *Excluded parameters*).

## Decision

### Identity

Array **`id == spec.name`**. xiRAID array names are unique per node, `Filesystem.spec.backing_device` resolves to `/dev/xi_<name>`, and the installer/Ansible day-1 path already keys on the name — so the name is the natural, stable join key. Names match `^[A-Za-z0-9_-]{1,63}$`. Import surfaces a foreign xiRAID UUID; it is mapped to a control-path id at adopt time via the `new_name` field (see *Import*).

> **Correction (2026-08-14).** The `^[A-Za-z0-9_-]{1,63}$` above was never the engine's rule. xiRAID Classic 4.4 accepts **at most 28 characters of Latin letters, digits and underscore — no hyphens** — and prohibits the names `power` and `uevent` ([command reference](https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html)). The corrected rule, and the reasoning behind tightening the published `api-v1.yaml` pattern to match it, live in [docs/Storage/raid-management-spec.md](../../Storage/raid-management-spec.md) §4 "Step — name". Everything else in this section stands: the identity decision does not depend on the width of the character class.

### Agent sandbox prerequisite (transport)

The gRPC client dials the xiRAID daemon over **TCP with TLS** (`host:port` from `/etc/xraid/net.conf`, default `localhost:6066`). The hardened agent unit currently sets `RestrictAddressFamilies=AF_UNIX AF_NETLINK` (`xinas-agent.service`), which blocks any TCP socket — the collector/executor would fail at `connect()` before any logic runs.

**Decision:** S3 adds `AF_INET AF_INET6` to `RestrictAddressFamilies` in `xinas-agent.service`, as a deliberate, documented widening of the ADR-0002 sandbox: the agent may now open loopback TCP to the xiRAID daemon. The unit file change ships with **`Requires-Rebuild: xinas_agent`** on its commit (the role must re-install the unit). No `IPAddressAllow/Deny` directives exist today; adding an `IPAddressAllow=localhost` + `IPAddressDeny=any` pair alongside is recommended hardening so the new families cannot reach off-host addresses.

### Disk references and resolution

`spec.member_disk_ids` and `spec.spare_disk_ids` are **control-path `Disk` ids**, never `/dev` paths — the object model does not leak kernel device naming, which is unstable across reboots.

**Disk enrichment prerequisite.** Today's live `Disk` observation carries only identity fields (`name`, `model`, `serial`, `transport`, `wwn`, `size_text`); the `safe_for_use` REST filter exists but live observations never emit the field. Array preflight needs more, so S3 **extends the disk parser/probe/collector** to also emit: `device_path` (`/dev/<name>`), `size_bytes`, `system_disk` (any descendant partition mounted at `/`, `/boot`, or `/boot/efi` — the `nvme_namespace` role's detection rule), `mounted` (any descendant mountpoint), and `safe_for_use` (= `!system_disk && !mounted`). Array membership is **not** a collector concern; the plan provider checks it against observed `XiraidArray`s.

**Resolution contract.** The **plan provider** (api side) resolves `Disk.id → device_path` from observed `Disk` state at plan time, validates each disk (exists, `safe_for_use`, not `system_disk`, not already a member of an observed array, not held by an observed spare pool), and **embeds the resolved `device_by_id` map in the operation spec** persisted on the task — the same `spec` the engine forwards to the agent in `task.begin`. The S2 `ExecutorContext` deliberately exposes only `spec` (no KV access), so the map travels in the spec rather than via a new context surface. The **executor preflight** then re-checks under the held leases against live agent-side facts: every resolved `device_path` exists, and none is already a member of an array per a fresh `raid_show`. Disk *safety* (system-disk, mounted) is pinned at plan time and protected by the disk leases; the executor re-verifies *existence and membership*, which is what can change out from under a plan.

### Schema (canonical JSON)

`spec.tuning` groups the performance knobs so the top-level stays legible and a future array-tuning surface has a home.

```json
{
  "kind": "XiraidArray",
  "id": "data",
  "metadata": {
    "revision": 4,
    "created_at": "2026-06-07T16:00:00Z",
    "modified_at": "2026-06-07T16:42:11Z",
    "owner": "system:installer",
    "source": "ansible:raid_fs",
    "validation_status": "valid"
  },
  "spec": {
    "name": "data",
    "level": "raid6",
    "member_disk_ids": ["disk-nvme2", "disk-nvme3", "disk-nvme4", "disk-nvme5"],
    "spare_pool": null,
    "group_size": null,
    "synd_cnt": null,
    "strip_size_kib": 64,
    "block_size": 4096,
    "force_metadata": false,
    "tuning": {
      "init_prio": null,
      "recon_prio": null,
      "restripe_prio": null,
      "resync_enabled": null,
      "sched_enabled": null,
      "merge_read_enabled": null,
      "merge_write_enabled": null,
      "merge_read_max": null,
      "merge_read_wait": null,
      "merge_write_max": null,
      "merge_write_wait": null,
      "memory_limit": null,
      "request_limit": null,
      "memory_prealloc": null,
      "adaptive_merge": null,
      "cpu_allowed": null,
      "max_sectors_kb": null,
      "sdc_prio": null,
      "single_run": null,
      "discard": null,
      "drive_trim": null
    }
  },
  "status": {
    "state": "optimal",
    "volume_path": "/dev/xi_data",
    "chunk_size_kib": 256,
    "rebuild_progress_pct": null,
    "check_progress_pct": null,
    "usable_capacity_bytes": 0,
    "member_states": [],
    "observed_at": "2026-06-07T16:42:11Z"
  }
}
```

- `level` enum: `raid0 | raid1 | raid5 | raid6 | raid7 | raid10 | raid50 | raid60 | raid70 | n+m` (the full xiRAID `RAID_LEVELS` set; `raid7`/`raid70` added to the existing api-v1.yaml enum).
- A `null`/absent `spec.tuning.*` field means "use the xiRAID default" — the translate layer omits it from the gRPC call. On a **desired** object the control-path stores **only operator-set values**, so intent never drifts against xiRAID's evolving defaults.
- *(Amended 2026-07-23.)* On an **observed** object `spec.tuning` carries the daemon's **effective** values, exactly as `spec.strip_size_kib` / `block_size` / `group_size` already do — observation reports what is, not what was asked for. The collector must therefore call `raid_show` with **`extended: true`**; the tuning surface is not in the base payload, and without the flag every observed array reads as "tuning unknown" (which is what shipped: the TUI's Extended Details rendered `-` for every priority). A knob the daemon does not emit stays **absent** rather than defaulting, so clients can tell "not reported" from a real value.
- `status` is server-managed (computed by the agent from `raid_show`). `chunk_size_kib` is **observe-only/derived**; `strip_size_kib` is the writable per-disk knob.

### Excluded parameters

`RaidCreate.force` (and the destroy-side `all`/`config_only` as user inputs) are **deliberately not exposed**: `force` bypasses xiRAID's own safety checks, and the control path owns its safety gates (§14, leases, preflight) — forwarding a user-supplied `force` would create a second, ungoverned bypass. The delete **executor** uses `force`/`config_only` internally where the locked contracts below say so. `force_metadata` *is* exposed (create-only, explicit opt-in to overwrite stale on-disk metadata, matching the Ansible day-1 path).

### Phase 0 writability matrix

| Field | Create | Modify (live) | Notes |
|-------|:------:|:-------------:|-------|
| `spec.name` | ✅ required | ❌ `UNSUPPORTED` | Identity; rename = destroy+recreate. Constrained by xiRAID, not by us: **≤ 28 chars, `[A-Za-z0-9_]` only, and `power`/`uevent` prohibited** ([CR / `xicli raid`](https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html) §*RAID array naming rules*). *(Amended 2026-08-14: `NAME_RE` was `^[A-Za-z0-9_-]{1,63}$` — hyphens allowed and more than twice the length limit.)* |
| `spec.level` | ✅ required | ❌ `UNSUPPORTED` | Topology; immutable after create. |
| `spec.member_disk_ids` | ✅ required | ❌ `UNSUPPORTED` | Topology; reshaping members is not a Phase-0 modify. |
| `spec.group_size` | ✅ (**required** for `raid50/60/70`) | ❌ `UNSUPPORTED` | Drives per group; **`[4,32]`** for `raid50/60` and **`[6,32]`** for `raid70`; member count must divide evenly into ≥ 2 groups. *(Amended 2026-08-14: was `[2,32]`, taken from the internal source-tree analysis. [CR / `xicli raid`](https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html) gives 4–32; [AG / RAIDs explained](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/xiraid_raids_explained.html) raises the floor to 6 for `raid70`, now enforced per level.)* |
| `spec.synd_cnt` | ✅ (**required** for `n+m`) | ❌ `UNSUPPORTED` | Syndrome count (the `m`); `[4,32]`. |
| `spec.strip_size_kib` | ✅ | ❌ `UNSUPPORTED` | From the xiRAID `STRIP_SIZES_KB` set (powers of two; `{16,32,64,128,256}`). |
| `spec.block_size` | ✅ | ❌ `UNSUPPORTED` | `512` or `4096`. |
| `spec.force_metadata` | ✅ | ❌ `UNSUPPORTED` | Create-only override; overwrites stale metadata on members. |
| `spec.spare_pool` | ✅ | ✅ | Name of an existing pool (`POST /api/v1/pools`); `null` on modify detaches without deleting it. Spare pool lifecycle below. |
| `spec.spare_disk_ids` | ❌ `observed_only` | ❌ `observed_only` | Rejected on write — create the pool via `POST /api/v1/pools`, then send `spec.spare_pool`. Populated by the collector from `raid_show` (pool members joined to Disk ids). |
| `spec.tuning.*` (live-writable) | ✅ | ✅ | Priorities `[1,100]`; `memory_limit` `0` or `[1024,1048576]` MiB; merge timings in microseconds; booleans map to xiRAID `0/1`. |
| `spec.tuning.{resync_enabled, discard, drive_trim}` | ✅ | ❌ `UNSUPPORTED` | Create-surface tuning only — the daemon's `RaidModify` message has **no field** for any of them (verified against the running 4.3.1 descriptor). Rejected pre-plan with `reason: create_only_tuning`; forwarding one would be silently dropped by protobuf and report a false success. |
| `status.*` | server-managed | server-managed | Computed by the agent from `raid_show`. |

Writes to a `Modify=UNSUPPORTED` (topology) field on `PATCH /arrays/{id}` fail at validation **before** any plan is produced, with the per-field shape:

```json
{
  "code": "UNSUPPORTED",
  "field": "spec.level",
  "reason": "topology_immutable",
  "remediation": "RAID level/members/strip cannot be changed live. Delete and recreate the array (data is destroyed)."
}
```

The three create-surface tuning keys reject on the same pre-plan path, with `field: "spec.tuning.<key>"` and `reason: "create_only_tuning"`. This is a daemon-capability limit, not a policy choice: `RaidModify` carries no `resync_enabled` / `discard` / `drive_trim` field, so `translate.ts` also drops them from the modify request (belt-and-suspenders — the route rejects first). *(A related latent gap: the running 4.3.1 `RaidCreate` also lacks these three, so they are not writable at create against that daemon either, even though the control-path schema and the hand-maintained `src/grpc/raid.ts` wrapper model them as create knobs. Reconciling the create surface is out of scope here and tracked separately.)*

### Spare pools

xiRAID models spares as **pool objects** with their own lifecycle (`pool_create {name, drives}` / `pool_add` / `pool_remove` / `pool_delete`); `RaidCreate.sparepool` / `RaidModify.sparepool` reference a pool **by name**. Pool CRUD **is** a first-class control-path surface (ADR-0011 / S9: `POST/PATCH/DELETE /api/v1/pools`), and an array never creates, fills, empties or deletes one — it only *references* an existing pool by name, via `spec.spare_pool`. Pool lifecycle belongs entirely to that pool surface.

- Attach (`spare_pool` -> a pool name): `pool_activate` when the named pool is
  inactive (xiRAID arms auto-replace only for activated pools — analyst doc
  §3.8), then `raid_modify { sparepool: "<name>" }`. Rollback restores the
  previous sparepool name and deactivates the pool only if this run activated
  it.
- Detach (`spare_pool: null`): `raid_modify { sparepool: "null" }` — the
  detach sentinel. The pool is left in place and active; it may be referenced
  by other arrays.

  > *(Amended 2026-08-28.)* This line read `sparepool: ""`, and the executor
  > sent that. It does not detach anything. The daemon counts a present-but-empty
  > string as **unsupplied** (`gRPC/validation/helper.py`), so a detach carrying
  > only `name` + `sparepool: ""` is rejected with
  > `INVALID_ARGUMENT: Required arguments are missing: '…, sparepool, …'`; and
  > when it rides along with a tuning batch it silently no-ops, because
  > `raid_modify_handler` gates the linkage update on `if opts.get("sparepool")`.
  > The sentinel is the literal string `null` — `POOL_REMOVE_CMD = "null"` in
  > `spare_pool/constant.py` (xiRAID 4.4.0-15858), which is what the command
  > reference means by *"The null value removes the spare pool from the RAID"*.
  > `translate.toRaidModifyRequest` now normalizes `''` → `'null'`; see
  > [s4-xiraid-array-mutations-spec.md](../s4-xiraid-array-mutations-spec.md)
  > §Modify for the full evidence.
- The control path NEVER creates, fills, empties or deletes a pool from an
  array request. Pool lifecycle belongs to the pool surface (ADR-0011 /
  S9): POST/PATCH/DELETE /api/v1/pools.
- Day-1 Ansible pools are ordinary pools and are attachable like any other.
  The `xnsp_<array>` derived name and the foreign-pool guard are retired.

### Validation and translation (shared module)

A shared **`xiNAS-MCP/src/lib/xiraid/`** module is the single home for array logic, so the API and the agent never duplicate it (the ADR-0005 rule):

- `schema.ts` — the writable spec type + the writability metadata above + the level→constraints table.
- `validate.ts` — the RAID-semantic rules (min drives per level; `group_size`/`synd_cnt` rules; param ranges; name regex).

  > *(Amended 2026-08-14.)* "Per the xiRAID constants" used to mean *per the
  > internal source-tree analysis in `xiraid-analysis/api_behavior_doc.md`*.
  > It now means **per [AG / RAIDs explained](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/xiraid_raids_explained.html)**,
  > which publishes the per-level requirements the analysis never recorded:
  > raid0 ≥ 1, raid1 ≥ 2, **raid5 ≥ 4**, raid6 ≥ 4, **raid7 (7.3) ≥ 6**,
  > raid10 ≥ 2 (even), **raid50 ≥ 8**, raid60 ≥ 8, **raid70 ≥ 12**,
  > **n+m ≥ 8**. `LEVEL_CONSTRAINTS` was below the engine on five of the ten
  > levels (raid5, raid7, raid50, raid70, n+m), so `validateCreateSpec`
  > returned no `min_drives` blocker for specs xiRAID then rejected at
  > `raid_create` — the plan looked clean and the executor failed.
  >
  > *(Amended again 2026-08-14.)* The two AG rules left unenforced by that
  > first pass are now enforced too: **raid10's even-member-count rule**
  > (new blocker code `members_not_even`) and **raid70's group size ≥ 6**
  > (per-level floor rather than the generic `[4,32]`). With those in, every
  > per-level requirement AG states is checked before a plan row is written. **Pure**: disk facts are passed in by the caller, so the same function runs in the api (against observed `Disk`/`XiraidArray` state) and in the executor (against live agent-side facts).
- `translate.ts` — control-path `spec` + the resolved `device_by_id` map → the gRPC `RaidCreateRequest` / `RaidModifyRequest` (`raid6 → "6"`, `n+m → "n+m"` + `synd_cnt`, `strip_size_kib → strip_size`, booleans → `0/1`, `member_disk_ids → drives` via `device_by_id`, `null` tuning omitted). Never emits `force`.

### API endpoints (REST)

```
GET    /api/v1/arrays                list (exists, read-only)
GET    /api/v1/arrays/{id}           current state (exists, read-only)
POST   /api/v1/arrays                create OR import (discriminated by spec shape); mode=plan|apply
PATCH  /api/v1/arrays/{id}           modify spare + tuning; mode=plan|apply
DELETE /api/v1/arrays/{id}           destroy; mode=plan|apply; dangerous=true required
```

Mutating calls follow the standard plan/apply contract (ADR-0004). The apply body is the **full OpenAPI `ApplyRequest`**: `{ mode: "apply", plan_id, expected_revision, idempotency_key, dangerous? }` — including `expected_revision`, which the existing reference route omits (a known S2 gap; the arrays route conforms to the contract and the reference route is normalized alongside, see Implementation notes). For **create**, `expected_revision = 0` by convention: the object must not exist (no current revision) at apply.

### Per-operation contracts

All `risk_level` / `rollback_model` values below use the api-v1.yaml enums (`risk_level ∈ non_disruptive|changing_access|destructive|unsupported_rollback`; `rollback_model ∈ non_disruptive|changing_access|destructive|unsupported`).

**Create** (`xiraid.array.create`, `POST /arrays` with a create-shaped spec).
- `affected_resources = [ XiraidArray#name (primary, first), …member Disks, Pool#spare_pool (when the spec references one) ]`. Spares join as a **`Pool` ref, never as Disks** — the pool's drives belong to the pool, not to the array. The member Disks are leased to serialize concurrent creates competing for the same disks.
- `risk_level: non_disruptive` (consumes free disks; touches no existing data); `rollback_model: non_disruptive` (rollback destroys the just-created, still-empty array).
- **Freshness:** the array does not exist yet, so the plan omits `state_revision_expected` and apply carries `expected_revision: 0`; disk-state TOCTOU is covered by the disk leases + the executor's `preflight` re-check (existence + membership against live `raid_show`).
- Executor stages: `preflight` (re-check `device_by_id` paths exist + not already members, via live `raid_show`) → `create` (`raid_create`; mark created) → `wait_online` (poll `raid_show` until `state ∈ {optimal, rebuilding}` or timeout) → `verify` (`/dev/xi_<name>` present). `rollback`: if created → `raid_destroy(name, force)`, else no-op. `snapshot_before/after` are auto-captured by the runner.

**Modify** (`xiraid.array.modify`, `PATCH /arrays/{id}`).
- Writable: `spare_pool` (pool lifecycle above) + `spec.tuning.*` **except the create-surface trio** (`resync_enabled`/`discard`/`drive_trim`, matrix). `spare_disk_ids` is observed-only and rejected on write. Topology fields and the create-surface tuning keys → `UNSUPPORTED` (matrix). Maps to `raid_modify` (+ `pool_activate` on attach to an inactive pool). `risk_level: non_disruptive`, `rollback_model: non_disruptive` (re-apply prior sparepool name / prior tuning values; deactivate the pool only if this run activated it).

**Import** (`xiraid.array.import`, `POST /arrays` with an import-shaped spec `{ uuid, new_name? }`).
- *(Amended by the S4 spec, 2026-06-10.)* Plan-mode validates what the api can know from KV alone: spec shape, target-name validity + availability. The candidate UUID is validated **at executor preflight** via a live `raid_import_show()` — the privilege split makes a plan-time daemon call impossible (only the agent reaches xiRAID; `PlanContext` is KV-only). A plan-time discovery surface (an observed import-candidates annex or an on-demand agent RPC) is follow-on work; until then clients learn candidate UUIDs from xiRAID tooling. **Adopt:** `mode=apply` → the executor runs `raid_import_apply(uuid, new_name?)`. The apply task terminates `success`; the adopted array surfaces through the normal observe path. `risk_level: non_disruptive`; `rollback_model: non_disruptive` (un-adopt = config-only removal, `raid_destroy { config_only: true }` — data untouched). See `docs/control-path/s4-xiraid-array-mutations-spec.md` §6.

**Delete** (`xiraid.array.delete`, `DELETE /arrays/{id}`).
- **Dangerous gate (§14), enforced in the engine.** The OpenAPI `ApplyRequest` already carries `dangerous` (default `false`). The delete plan extends the S2 `TaskEngine.apply` input with `dangerous` and enforces **centrally in the apply transaction**: `plan.risk_level == 'destructive' && !dangerous` → `PRECONDITION_FAILED { details.reason: "dangerous_flag_required" }`. Plan-mode always lists a `dangerous_flag_required` blocker on destructive plans, advising that apply must carry `dangerous: true` — so every client renders the gate, and the enforcement point is the engine, not a route ("blocked at the same place" for API/CLI/TUI/MCP).
- **Dependency guard + blast radius:** preflight walks dependents — `Filesystem`s whose `backing_device` resolves to `/dev/xi_<name>`, then `Share`s rooted under those filesystems, then active NFS sessions on those shares (observed state). A **mounted** dependent filesystem or a share with **active sessions** is a blocker (tear down first); the full dependent set is reported in the plan `diff` as blast radius **regardless** of whether it blocks.
- `affected_resources = [ XiraidArray#name (primary), …dependent Filesystems, …dependent Shares ]` (dependents leased so a concurrent share/fs op cannot race the delete).
- `risk_level: destructive`, `rollback_model: unsupported` (the `snapshot_before` captures config for audit/diff, but the array's data is gone). Executor: `preflight` (re-check deps under lease) → `destroy` (`raid_destroy(name, force)`) → `verify`. A failed destroy → `requires_manual_recovery` (no rollback for a destructive op).

### Preflight blockers (codes)

Harvested from the xiRAID error taxonomy into `lib/xiraid/validate`: `min_drives` (level minimum not met), `members_not_even` (raid10 — AG: "the number of drives must be even"), `group_size_required` / `group_size_range` / `members_not_divisible_by_group` (raid50/60/70), `synd_cnt_required` / `synd_cnt_range` (n+m), `strip_size_invalid`, `block_size_invalid`, `param_out_of_range` (priorities/memory/timings), `name_invalid` / `name_taken`, `disk_not_found` / `disk_not_safe` / `disk_is_system` / `disk_in_use` / `disk_in_spare_pool` / `disk_is_raid_volume` (per offending disk — `disk_in_use` is membership of another array; `disk_in_spare_pool` is membership of a spare pool, which `safe_for_use` cannot see; `disk_is_raid_volume` is a `/dev/xi_*` device — an array's OWN volume offered back as a member — which `safe_for_use` cannot see either, see §Disk below). Spare-pool references add `spare_pool_not_found` / `spare_pool_empty`. Delete adds `dangerous_flag_required`, `dependent_filesystem_mounted`, `dependent_share_active`.

### Relationship to other objects

- **Dependency chain:** `XiraidArray.status.volume_path` (`/dev/xi_<name>`) ← `Filesystem.spec.backing_device` ← `Share.spec.path` (under the filesystem mountpoint). This is the delete blast-radius graph.
- **Disk:** `member_disk_ids`/`spare_disk_ids` reference `Disk` objects; a disk is consumable only when `safe_for_use`, not already claimed by an observed array, and **not held by an observed spare pool** (`disk_in_spare_pool`).
  A fourth exclusion is **not** derivable from those three: xiRAID's own array
  volumes (`/dev/xi_<name>`) are reported by `lsblk` as `TYPE=disk` and become
  `Disk` rows, and an array volume carrying no mountpoint of its own — the
  canonical case being an XFS **external journal** (`logdev=`), which xiNAS
  provisions as `/dev/xi_log` — reads `system_disk: false`, `mounted: false`,
  therefore `safe_for_use: true`. Consuming one as a member is how a live
  filesystem's journal gets overwritten by `raid_create`. A device path under
  `/dev/xi_` is therefore **never** a consumable drive, on any surface that
  takes drives (`XiraidArray.member_disk_ids`, `Pool.drives`/`add_drives`),
  and is rejected with `disk_is_raid_volume` regardless of `safe_for_use`.
  The rule is structural, not observational: it holds when the owning array
  is missing from observed state, which is exactly when the other three
  exclusions fail open.
- **Cluster.capabilities** continues to advertise the adapter availability; once the collector is real, the `XIRAID_ADAPTER_DEFERRED` deferral marker is removed.

## Consequences

### Pros

- **Schema is locked before code.** Routes, executor, collector, TUI screens, and MCP tools all target one canonical shape.
- **The approved Phase-0 create surface** gives power users every xiRAID create knob through the API at creation time (except the ungoverned `force` bypass), without a second tuning round-trip.
- **Disk-id references (not `/dev` paths)** keep the object model stable across reboots and let preflight enforce disk safety.
- **One transport, one logic module.** Reusing the gRPC client + a shared `lib/xiraid` avoids a parallel CLI parser and duplicated validation.
- **Destructive delete is honest:** dangerous gate enforced in the engine + dependency blockers + blast radius before apply, per §14.

### Cons

- **The agent gains a gRPC dependency + a sandbox widening.** Until now the agent was UDS JSON-RPC + subprocess only; this adds a TLS-TCP client to a localhost daemon (reconnect, timeouts, availability gating) and opens `AF_INET/AF_INET6` in the unit (mitigated by `IPAddressAllow=localhost`).
- **Large writable surface = large validation + contract-test matrix.** Every create param needs a rule + a test; the writability matrix needs per-field `UNSUPPORTED` coverage on modify.
- **Topology is immutable in Phase 0.** Growing/reshaping an array (add disks, change level) is destroy+recreate; online reshape is deferred.
- **`id == name` couples identity to a mutable-looking field.** Mitigated by making rename `UNSUPPORTED` (rename = destroy+recreate).
- **Spares are deferred from the first build slice** (create-with-spares needs the pool lifecycle), so day-2 spare attach arrives only with the modify plan.

### What this ADR does NOT decide

- **Online capacity expansion / reshape** (add members, change level/strip live). Deferred; would extend the modify matrix in a later ADR.
- ~~**Pool objects as first-class control-path resources.** Phase 0 models spares via `spare_disk_ids` + the executor-owned `xnsp_<array>` pool; a first-class `SparePool` object is future work.~~ **Superseded 2026-08-29:** pools are a first-class object (ADR-0011 / S9) and an array references one by name — see §Spare pools.
- **The xiRAID daemon's own auth/transport hardening** (TLS material rotation, UDS vs TCP `:6066`). That is an `xiraid_classic`/packaging concern; this ADR assumes the agent (root) can reach it once the unit change lands.
- **Whether arrays are editable via the TUI in Phase 0** (must be via the API; a dedicated M5 screen is a UI-scoping question, not an ADR question).

## Rejected alternatives

### `xicli` subprocess transport

Rejected (for this object): the operator chose to reuse the existing, typed gRPC client and its sunk work, and to get structured responses without parsing CLI text. The costs — a gRPC dependency in the root agent and the `RestrictAddressFamilies` widening — are accepted and documented above. (The S2 executor's subprocess pattern remains the model for file-based executors like NFS.)

### Synthetic UUID identity

Rejected: xiRAID exposes no array UUID at create time, the name is already the join key for `Filesystem.backing_device`, and a synthetic id would need a separate name↔id map. Import's foreign UUID is handled at adopt time via `new_name`.

### Minimal create surface (defer tuning)

Rejected: the operator chose the full parameter surface so all xiRAID create knobs are available at creation. (ADR-0005's "lock minimal, defer advanced" was the alternative; here the advanced knobs are creation inputs for a performance product, not HA scaffolding.) The one exclusion is `force` (safety bypass).

### Device paths in `member_disk_ids`

Rejected: `/dev/nvme*` names are unstable across reboots and leak kernel naming into the API; preflight could not check disk safety from a raw path as cleanly as from a `Disk` object.

### Thin API validation (validate only in the executor)

Rejected: blockers must surface at **plan** time (§14 "expose blast radius before apply"); validating only in the executor would defer "raid6 needs ≥4 disks" to apply.

### First-class pool objects now

~~Rejected for Phase 0: `spare_disk_ids` + an executor-owned pool covers the single-pool-per-array case; a full pool CRUD surface (shared pools across arrays) is real scope with no Phase-0 requirement behind it.~~ **Superseded 2026-08-29:** the pool CRUD surface landed in S9 (ADR-0011) and shared pools across arrays are now a supported, tested case — see §Spare pools.

### Executor-owned `xnsp_<array>` pools

Rejected, and **retired 2026-08-29** after shipping as the S4 model. It made
every operator-created pool unattachable: the TUI resolved the chosen pool to
its drives, and the executor then tried to build `xnsp_<array>` from drives the
daemon already accounted to that pool, failing with `13 INTERNAL: Drive
'/dev/nvme5n2' is already a part of the 'sp01' spare pool`. Two owners for one
pool lifecycle is the defect; S9 already made the pool surface the owner.

## Implementation notes for downstream workstreams

- **This phase (S3 plan):** the agent unit `RestrictAddressFamilies` widening (+ `Requires-Rebuild: xinas_agent`); the **Disk enrichment** (parser/probe/collector emit `device_path`, `size_bytes`, `system_disk`, `mounted`, `safe_for_use`); shared `lib/xiraid/{schema,validate,translate}.ts` + the pure parser `lib/parse/raid.ts`; a gRPC client adapter `agent/xiraid/client.ts` (wraps `src/grpc/`, injectable transport, shared by collector + executor); the **observe** collector (`agent/collectors/xiraid.ts` via `raid_show`, replacing the stub); the **create** provider (`api/plan/providers/xiraid-array.ts`) + route (`api/routes/arrays.ts`) + executor (`agent/task/xiraid-array-executor.ts`).
- **Stub supersession (S2-T0 pattern):** remove `arrays.create/delete/import` + `spare.set` from `STUB_METHOD_NAMES` (`stubs.ts`) **and** `REQUIRED_STUB_METHODS` (`stubs.test.ts`), and edit the S0/S1 spec's RPC table to mark them *superseded by the task envelope (S3)* — mutations dispatch via `task.begin` + the executor registry, so these names leave the enumerated RPC surface (a later `-32601` for them is then correct, not a contract violation). **Keep** `arrays.list` (deferred on-demand read, WS12 family). Deferred `PATCH`/`DELETE /arrays` keep the existing `handlers/unsupported.ts` semantics (`EXECUTOR_UNSUPPORTED` 422 agent-online / `EXECUTOR_UNAVAILABLE` 503 agent-offline) until their plans land.
- **Contract normalization:** the S2 reference provider emits `rollback_model: "reversible"`, which is outside the api-v1.yaml enum — normalize it to `non_disruptive` when touching the contract in S3 T0. The arrays apply body conforms to the full `ApplyRequest` (incl. `expected_revision`); aligning the reference route is part of the same normalization.
- **Follow-on plans:** `modify` (PATCH + `raid_modify` + the pool lifecycle + spares-at-create un-deferral), `import` (two-phase + `raid_import_*`), `delete` (DELETE + the engine `dangerous` gate + dependency guard + `raid_destroy`).
- **Contract (`api-v1.yaml`):** extend `XiraidArray.spec` to the surface above (incl. `raid7`/`raid70` in the level enum) + the writability/`UNSUPPORTED` family; wire `POST /arrays` to the plan/apply contract; add the `XiraidArray.json` contract fixture.
- **State / drift (WS9):** `status` observations land under `/xinas/v1/observed/XiraidArray/<id>` (ADR-0003); the `raid_fs` Ansible role's day-1 arrays reconcile into desired `XiraidArray` on first `xinas-api` start so the API and installer agree on the baseline.
- **Testing:** unit (`lib/xiraid` validate/translate; disk enrichment; provider preflight; executor with a mock gRPC client incl. create-fail→rollback and daemon-unavailable; collector incl. daemon-down→degraded); contract (`XiraidArray.json` + extended-schema validation); e2e (boot api+agent with an **injected fake xiRAID gRPC transport**, analogous to S2's fake-`python3` shim: plan → apply create → poll task→success → observe shows the array).
