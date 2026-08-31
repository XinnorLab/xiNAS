# Arrays attach an existing spare pool by name

**Date:** 2026-08-29
**Status:** approved design, not yet implemented
**Supersedes:** ADR-0006 §Spare pools (executor-owned `xnsp_<array>` pools),
`s4-xiraid-array-mutations-spec.md` §`apply_spares`

## 1. Problem

Attaching a spare pool to an existing array fails on a real node:

```
task 266636c2-… ended failed (FAILED_PARTIAL_ROLLED_BACK): apply_spares:
13 INTERNAL: Drive '/dev/nvme5n2' is already a part of the 'sp01' spare pool.
Drive '/dev/nvme6n2' is already a part of the 'sp01' spare pool.
```

Two contracts disagree.

- **S4** gave the array executors their own pool: the write spec carries
  `spare_disk_ids` (Disk ids), and the executor provisions
  `xnsp_<array>` from those drives (`pool_create` + `pool_activate`
  before `raid_create`, or inside `apply_spares` on modify). Pools with
  any other name are "foreign" and refused.
- **S9** made pools first-class operator objects: `SparePoolScreen`
  creates, fills and activates pools with operator-chosen names, and
  the RAID screens offer those pools in a picker.

The TUI picker resolves the chosen pool down to its member disks and
sends them as `spare_disk_ids`; the executor then tries to build
`xnsp_<array>` out of drives that already belong to `sp01`, and the
daemon refuses. The rollback is correct — no state is damaged — but the
operation can never succeed. Every operator-created pool is
unattachable, in both the create wizard and Edit Array.

The `spare_disk_ids` write contract is the defect. Pool lifecycle
belongs to one owner, and S9 already made that owner the Spare Pools
screen.

## 2. Decision

**The array executors no longer own a spare pool.** An array references
an existing pool by name; nothing in the array path creates, fills,
empties or deletes a pool. Pools are created only through the pool
surface (`POST /api/v1/pools`, Spare Pools → Create Pool). When no pool
exists, the operator is told to go and create one.

Consequences accepted deliberately:

- `xnsp_<array>` naming disappears. Pools that name-collide with it on
  deployed hosts are just ordinary pools from now on.
- Day-1 Ansible pools become attachable from the TUI — the foreign-pool
  guard that refused them is deleted, not reworked.
- One pool may back several arrays. `Pool.referenced_by` is already a
  list, and xiRAID supports it; the previous one-pool-per-array
  restriction was an artifact of executor ownership.

### 2.1 Activation

An inactive pool never arms auto-replace (xiraid-analysis
`api_behavior_doc.md` §3.8), so an attach to an inactive pool would be
linkage without function. The executor therefore calls `pool_activate`
when the target pool is inactive, and its rollback restores the pool's
prior `active` flag. Activation is the one pool-state change the array
path makes; it creates and destroys nothing, so pool ownership stays
with the pool surface.

Detach never deactivates. The pool outlives the array's reference to
it, and other arrays may share it.

## 3. API contract

`XiraidArray.spec` in [api-v1.yaml](../../control-path/api-v1.yaml) is
one schema shared by observed rows and write bodies, so the retired
field cannot simply be deleted from it.

| Field | Before | After |
|-------|--------|-------|
| `spec.spare_pool` | — | **New.** `[string, "null"]`. The name of an existing pool. Writable on POST `/api/v1/arrays` and PATCH `/api/v1/arrays/{id}`; `null` on PATCH detaches. Also emitted by the collector so a GET → PATCH round-trip is closed. |
| `spec.spare_disk_ids` | Write + observed | **Observed only.** Still populated from `raid_show` (the pool's drives joined to Disk ids); rejected on write. |
| `status.spare_pool` | Observed | Unchanged — `Pool.referenced_by` is computed from it. |

Rejection of `spare_disk_ids` on write:

- PATCH — `rejectTopologyKeys()` in
  [routes/arrays.ts](../../../xiNAS-MCP/src/api/routes/arrays.ts) gains
  the key, giving the same per-field `422 UNSUPPORTED` shape used for
  topology keys, with `reason: 'observed_only'`.
- POST — `parseCreateSpec()` rejects it with `INVALID_ARGUMENT`.

Both carry the remediation *"spare_disk_ids is observed-only; create the
pool via POST /api/v1/pools, then send spec.spare_pool with its name"*.

**Constraint:** the rejection must not fire on the api's own
`enriched_spec` when apply re-parses it (S4 spec §8). The enriched spec
never carries `spare_disk_ids` after this change, and the parsers stay
tolerant of the enrichment keys they already ignore.

`api-v1.yaml` changes are additive plus description edits, so `oasdiff`
sees no breaking change.

## 4. Executors

[xiraid-array-executor.ts](../../../xiNAS-MCP/src/agent/task/xiraid-array-executor.ts)

### 4.1 `xiraid.array.create`

`create` stage: the `pool_create` + `pool_activate` block is removed.
When `spare_pool` is set, the stage issues `pool_activate` only if the
pool reads inactive, then `raid_create { …, sparepool }`.
`toRaidCreateRequest()` passes `spec.spare_pool` straight through
instead of deriving a name from `spare_disk_ids`.

`preflight`: the pool exists on the daemon and is non-empty; its live
`active` flag is stashed.

`rollback`: destroys the array as today; the pool-cleanup block is
deleted. If this run activated the pool, it is deactivated again.

### 4.2 `xiraid.array.modify`

`preflight`: the foreign-pool guard is deleted outright. When
`spare_pool` is present and non-null, the named pool must exist and be
non-empty. Pre-state captured: the array's current sparepool name and
the target pool's `active` flag.

`apply_spares`:

| Case | Operations |
|------|-----------|
| `spare_pool` absent | `skipped (no spare_pool change)` |
| attach / re-point to `P` | `pool_activate P` (only when inactive) → `raid_modify { sparepool: P }` |
| detach (`null`) | `raid_modify { sparepool: 'null' }` — the `SPAREPOOL_DETACH` sentinel, unchanged |

No `pool_create`, `pool_add`, `pool_remove`, `pool_delete`, and no
`pool_deactivate` on detach.

`verify`: compares the live sparepool name against `spare_pool ?? ''`.

`rollback`: restore the array's previous sparepool name; deactivate the
pool only if this run activated it.

`derivedPoolName()` and `checkDerivedPoolName()` in
[validate.ts](../../../xiNAS-MCP/src/lib/xiraid/validate.ts) are deleted
with their last caller.

## 5. Plan providers and validation

[plan/providers/xiraid-array.ts](../../../xiNAS-MCP/src/api/plan/providers/xiraid-array.ts)

- Spare-disk validation (`checkDisks` over `spare_disk_ids`) is replaced
  by a pool lookup against `/xinas/v1/observed/Pool/<name>`. Blockers:
  `spare_pool_not_found`, `spare_pool_empty` (a pool with no drives
  cannot serve as a spare source).
- **Leases move from `Disk/<id>` to `Pool/<name>`.** This is a
  correctness gain, not just bookkeeping: an array attach and a
  concurrent Spare Pools mutation on the same pool now serialize, which
  they never did under disk leases.
- The array spec's `spare_pool` no longer contributes Disk ids to
  `existingMemberDiskIds`; a disk that is a pool member is already
  excluded from free-drive pickers by the pool surface's own rule
  (`_get_free_nvme_drives`, raid-management-spec §7.2).
- `diff.before`/`diff.after` report `spare_pool` names rather than disk
  id lists.
- `device_by_id` no longer needs spare entries. Members keep theirs.

## 6. TUI

[xinas_menu/screens/raid.py](../../../xinas_menu/screens/raid.py)

**Edit Array → Spare Pool.** The picker offers `(none)` plus the
existing pool names. The chosen value maps directly to
`{"spare_pool": name}` — or `{"spare_pool": None}` for `(none)`. The
`GET /api/v1/disks` lookup that mapped pool drives to disk ids is
deleted. When no pool exists, the current `notify(..., warning)` is
replaced by a modal `ConfirmDialog`: *"No spare pools exist. Create one
in Storage → Spare Pools → Create Pool, then run Edit Array again."*

**Create Array wizard.** The `spare` step loses its
`applies=lambda a: bool(pools)` predicate and is always shown. Its
options are `(none)` plus the pool names; with no pools it shows
`(none)` alone plus a hint line naming Storage → Spare Pools. The spec
built from the answers carries `spare_pool`, not `spare_disk_ids`. A
missing pool never blocks array creation — an array without spares is a
valid configuration.

Read-only surfaces (Quick Overview's Spare Pool row, Extended Details)
already render `status.spare_pool` and do not change.

## 7. Deployed hosts

No migration step. An existing `xnsp_<array>` pool keeps working: it is
listed in Spare Pools, remains attached to its array, and can now be
detached, renamed by delete/recreate, or shared. The name loses its
meaning but nothing reads it after this change.

`POOL_NAME_MAX_LEN` (64) was justified by `len("xnsp_") + 28`; with the
derived name gone that justification disappears. The bound stays at 64
as a deliberate choice — there is no vendor-documented pool-name length
— and raid-management-spec §7.3 is rewritten to say so, since keeping a
rationale that references code we deleted is how stale specs start.

## 8. Documents to update (spec-first, before code)

| Document | Change |
|----------|--------|
| `docs/control-path/adr/0006-xiraid-array.md` | §Spare pools rewritten: reference-by-name, no executor-owned pool; §Rejected alternatives records why `spare_disk_ids` was retired |
| `docs/control-path/s4-xiraid-array-mutations-spec.md` | §`apply_spares` table, foreign-pool guard removal, rollback contract |
| `docs/control-path/s3-xiraid-array-spec.md` | create-path spare handling |
| `docs/control-path/s9-bridge-pools-spec.md` | pools are the single owner of pool lifecycle; arrays only reference |
| `docs/control-path/api-v1.yaml` | `spec.spare_pool` added; `spec.spare_disk_ids` description → observed-only |
| `docs/Storage/raid-management-spec.md` | §4 spare step (always shown), §5.2 (pool name, not disk ids), §7.3 (name-length rationale) |

## 9. Testing

TDD, test first for every behavior below.

**TypeScript** — `xiraid-array-executor.test.ts` (attach to an active
pool issues no `pool_activate`; attach to an inactive pool activates and
rolls back the activation; detach leaves the pool present and active;
no pool op appears in any create/modify path other than
`pool_activate`), `translate.test.ts` (`sparepool` passthrough,
`SPAREPOOL_DETACH` unchanged), `validate.test.ts` (`spare_pool_not_found`
/ `spare_pool_empty`; `spare_disk_ids` rejected on create),
`xiraid-array-provider.test.ts` (Pool lease, diff shape),
`routes-arrays.test.ts` (PATCH `spare_disk_ids` → 422 `observed_only`),
`e2e/xiraid-array-mutations.test.ts` (the reported failure: array with
no sparepool + operator pool `sp01` holding both drives → attach
succeeds).

**Python** — a TUI test that Edit Array with zero pools raises the modal
rather than a notify; a wizard test that the `spare` step renders with
`(none)` when no pools exist. `tests/test_xiraid_name_rules.py:120`
(the `xnsp_` length case) is rewritten against the plain 64-char rule.

Full gate per CLAUDE.md §Verification, both the Python and the
`xiNAS-MCP/` sets.

## 10. Out of scope

- A first-class `SparePool` object in desired state (ADR-0006 already
  lists it as future work).
- Creating a pool implicitly from any array surface — that is exactly
  the coupling this change removes.
- Changing which drives the pool surface offers, or its activation UX.
- Ansible day-1 pool provisioning (`raid_fs`), which is untouched.

## 11. Commit trailer

TypeScript under `xiNAS-MCP/src/` changes, so the landing commits carry
`Requires-Rebuild: xinas_node_build` — `dist/` is not tracked and a
release-tag checkout alone would never deliver this.
