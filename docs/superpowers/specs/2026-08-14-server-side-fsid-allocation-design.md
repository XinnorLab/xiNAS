# Design: server-side `fsid` allocation for NFS shares

**Date:** 2026-08-14
**Status:** Approved (design) — pending implementation plan
**Area owner specs:** [docs/Storage/fs-shares-management-spec.md](../../Storage/fs-shares-management-spec.md) §4.5, [docs/control-path/api-v1.yaml](../../control-path/api-v1.yaml)
**Fixes:** the client-side `fsid` allocation documented as a known gap in [PR #283](https://github.com/XinnorLab/xiNAS/pull/283)

---

## 1. Problem

`Share.spec.fsid` is required by the API ([api-v1.yaml:791](../../control-path/api-v1.yaml)),
and nothing assigns it on create. Every client therefore has to allocate one
itself. The TUI does:

```python
used = {row["fsid"] for row in await self._get_exports()}
spec = {"path": path, "fsid": max(used, default=0) + 1, ...}
```

([screens/nfs.py:552](../../../xinas_menu/screens/nfs.py))

Two operators adding a share at the same time read the same share list, compute
the same number, and both applies succeed — their plans pin the `Share` id, which
differs, not the `fsid`, which does not. An `fsid` collision silently breaks
NFSv4 client mounts: two exports claiming the same filesystem id make the client's
view of the namespace ambiguous, and the failure appears on the client, long after
the create that caused it.

The same hole is open to every other client of the API — `xinasctl`, the MCP tool
surface, anything written against the contract — because the contract makes `fsid`
the caller's problem without giving callers any way to allocate one safely.

### What is already correct (no change needed)

- **The adoption path allocates.** `seed-shares.ts` assigns
  `Math.max(0, ...usedFsids) + 1` when a manifest entry carries no `fsid` or a
  duplicate one ([seed-shares.ts:99](../../../xiNAS-MCP/src/api/seed-shares.ts)).
  The create path simply never got the same treatment.
- **The work is already tracked.** `s3-nfs-executor-spec.md` carries it as deferred
  item **N5** — *"Share `id`/`fsid` assignment on `POST /shares`"*
  ([:462](../../control-path/s3-nfs-executor-spec.md)). This design closes N5's
  `fsid` half; server-assigned `id` stays deferred.
- **The absence-pin machinery exists.** `share.create` already pins
  `{kind: 'Share', id, revision: 0}` to reject a duplicate id that appeared
  between plan and apply ([providers/nfs.ts:224](../../../xiNAS-MCP/src/api/plan/providers/nfs.ts)),
  and the task engine enforces it ([tasks/engine.ts:397](../../../xiNAS-MCP/src/api/tasks/engine.ts)).
  This design reuses that mechanism rather than adding one.

## 2. Invariant

> No two live shares hold the same `fsid`. A client may omit `fsid` and get a free
> one, or supply one and be told plainly if it is taken — but it can never end up
> with a number that silently belongs to another share.

## 3. The contract does not need loosening

The obvious reading of "make `fsid` optional in `api-v1.yaml`" is to drop it from
`Share.spec.required`. That is both unnecessary and wrong.

**Unnecessary.** `POST /shares` takes `requestBodies/Mutating` →
`MutatingRequest` → `PlanRequest`, whose `spec` is deliberately untyped
(`description: Object spec under change (kind-specific)`,
[api-v1.yaml:206](../../control-path/api-v1.yaml)). The schema never constrained
create requests at all. What rejects an omitted `fsid` today is
`validateShareSpec` in the plan provider
([providers/nfs.ts:125](../../../xiNAS-MCP/src/api/plan/providers/nfs.ts)), not the contract.

**Wrong.** `Share` is referenced only from the `listShares` and `getShare`
**responses** ([api-v1.yaml:1925](../../control-path/api-v1.yaml),
[:1957](../../control-path/api-v1.yaml)). Removing a property from a response's
`required` set is a breaking change for readers, and `oasdiff --fail-on ERR`
gates exactly that on every PR (`.github/workflows/ci.yml`, job `openapi-compat`).
It would also misdescribe the system: once the server allocates, every response
carries an `fsid`.

**So the contract change is prose only** — on the `POST /shares` operation:

> `spec.fsid` may be omitted; the server assigns the next integer above the
> highest currently in use. Supplying an `fsid` already held by another share is
> an `FSID_IN_USE` plan blocker.

Spectral-clean (added `description` text), oasdiff-clean (no schema narrowing).

## 4. Allocation

`validateShareSpec` stops requiring `fsid` for `share.create`. It stays required
for `share.update`, where the value already exists on the desired doc and an
absent one would mean "erase it".

The allocator is `max(0, ...used) + 1` over the `fsid`s on the desired `Share`
rows — **the next integer above the highest in use, not the lowest free one**. On
`{0, 1, 4}` it yields `5`, not `2`. That is deliberate: it matches
`seed-shares.ts` exactly, and filling gaps would mean reusing a number a deleted
share once held (§12). It is extracted into a single helper shared by the create
provider and `seed-shares.ts` so the two cannot drift.

`0` stays reserved — the installer writes `fsid=0` for the root export, and
`max(0, ...)` never returns it.

## 5. Closing the race: per-number marker rows

Allocating in the provider narrows the collision window from "between the client's
read and its apply" to "between plan and apply", but does not close it: two plans
computed against the same desired state produce the same number, and each apply's
preconditions are satisfied.

Each create therefore writes a marker row at `/xinas/v1/desired/ShareFsid/{n}`
through `desired_mutations`, and pins it absent in `affected_resources`:

```
affected_resources: [
  { kind: 'Share',     id: <share id>, revision: 0 },
  { kind: 'ShareFsid', id: String(n),  revision: 0 },
]
desired_mutations: [
  { key: '/xinas/v1/desired/Share/<id>',   value: <share doc> },
  { key: '/xinas/v1/desired/ShareFsid/<n>', value: { share_id: <id> } },
]
```

The engine resolves a pin to `/xinas/v1/{space}/{kind}/{id}`
([tasks/engine.ts:962](../../../xiNAS-MCP/src/api/tasks/engine.ts)) and reads an
absent row as revision 0, so two applies that both allocated `4` behave like this:
the first writes `ShareFsid/4` (revision 1) inside its transaction; the second
re-reads it as 1, mismatches its pinned 0, and fails `PRECONDITION_FAILED` with
the existing remediation — *"Re-run plan to capture the current revision, then
apply against the fresh plan."* The re-plan sees `4` taken and allocates `5`.

Three properties make this cheap:

- **No plan/apply contract change.** `desired_mutations` and absence pins are both
  existing S3 "Model R" machinery; the marker is just another mutation.
- **Rollback is already handled.** The engine captures each mutated key's prior
  value into `desiredRollback` before writing
  ([tasks/engine.ts:470](../../../xiNAS-MCP/src/api/tasks/engine.ts)), so a failed
  task reverts the marker with the share doc, atomically.
- **No new list surface.** `/xinas/v1/desired/ShareFsid/` does not match the
  `/xinas/v1/desired/Share/` list prefix (the trailing slash separates them), so
  `GET /shares` is unaffected. The `/support` dump enumerates the desired space
  generically ([routes/support.ts:49](../../../xiNAS-MCP/src/api/routes/support.ts))
  and picks the rows up for free.

**The pin applies to explicitly-supplied `fsid`s as well as allocated ones.** This
is load-bearing, not symmetry for its own sake: an explicit `fsid=5` racing an
allocation that computes `5` would otherwise slip through, because only the
allocating side would have pinned anything.

### Alternative considered: a single allocator sentinel

One `ShareFsidAllocator/default` row that every create bumps would need no
per-number rows, no delete bookkeeping, and no backfill. Rejected: because the
allocator is `max+1`, it conflicts *any* two concurrent creates — including two
that supplied distinct explicit `fsid`s and could never have collided. Per-number
markers conflict only on a real collision, which keeps `PRECONDITION_FAILED` a
signal the operator should act on rather than routine noise.

### Alternative considered: allocate inside the apply transaction

Extending `DesiredMutation` with a compute-at-apply variant would be
collision-free with no retry at all. Rejected as disproportionate: it changes the
plan/apply contract shared by every provider, and it breaks the property that a
plan is fully determined when it is returned — which is what makes a plan
reviewable before it is applied.

## 6. Explicit `fsid` collisions are a blocker

An explicit `fsid` already held by another share produces a plan blocker:

```
code:    FSID_IN_USE
message: fsid <n> is already held by share <path>; omit spec.fsid to allocate a free one
```

Not a silent reallocation. `seed-shares.ts` does silently reallocate on collision,
and that is right for adoption — it is reconciling a file it did not write, with
no caller to tell. A create has a caller who named a number, and `fsid` is exactly
the field where quietly substituting a different value produces a share that works
in the UI and breaks on the client. Omitting `fsid` remains the way to say "pick
one for me".

Consistent with the existing `EXPORT_PATH_IN_USE` treatment, this is a **blocker on
the returned plan**, not a thrown `INVALID_ARGUMENT` — the plan still renders so
the operator can see the whole picture.

## 7. Lifecycle

**Delete.** `share.delete` adds `{key: '…/ShareFsid/{n}', delete: true}` to its
mutations, reading `n` from the desired doc it already fetches
([providers/nfs.ts:292](../../../xiNAS-MCP/src/api/plan/providers/nfs.ts)). A
desired doc with no `fsid` (not reachable through the API, but possible on a
hand-edited store) simply skips the marker mutation rather than failing the delete.

**Existing installs.** Shares created before this change have no markers. Rather
than a one-shot migration, an idempotent backfill runs at api boot next to
`seedShares` ([server.ts:48](../../../xiNAS-MCP/src/api/server.ts)): read the
desired `Share` rows, ensure a `ShareFsid/{n}` exists for each `fsid` found. Every
boot, not once — so it also self-heals a marker lost to a rolled-back task or a
restored snapshot. It writes only missing rows, so it is a no-op on a healthy
store.

**Adoption.** `seed-shares.ts` writes a marker for each share it seeds, in the same
pass that assigns the `fsid`.

## 8. TUI

`_add_share_wizard` stops computing `fsid` and stops calling `_get_exports()` for
it. That removes the fail-closed read and its *"Could not read existing shares"*
dialog — both introduced in PR #283 as the best available client-side mitigation,
and both unnecessary once the server allocates.

`_get_exports()` keeps propagating `ControlPathError`; Edit and Remove still need
to tell an unreadable list from an empty one.

An `FSID_IN_USE` blocker reaches the operator through the existing
`_show_control_error` path with no new handling — it is a plan blocker like any
other.

## 9. Testing

**Vitest — provider:**

- allocates `1` against an empty desired space; `max+1` against a gapped set
  (`{0, 1, 4}` → `5`, not `2` — §4, and the reason gap reuse is out of scope)
- never allocates `0`
- explicit `fsid` is accepted and passes through unchanged
- explicit `fsid` already held → `FSID_IN_USE` blocker, plan still returned
- allocated and explicit creates both emit the marker mutation and the absence pin
- `share.update` still requires `fsid`; `share.create` no longer does

**Vitest — engine (the race):** build two `share.create` plans against the same
state so both allocate the same number; apply both; assert the first succeeds and
the second fails `PRECONDITION_FAILED`, and that a re-plan after the first apply
allocates the next number. This is the test the whole design exists for — it must
drive the real task engine, not a stub.

**Vitest — lifecycle:** delete removes the marker; boot backfill creates missing
markers, is a no-op on a healthy store, and leaves unrelated rows alone.

**Pytest — TUI:** the create spec carries no `fsid` key, and Add no longer reads
the share list.

## 10. Files

| File | Change |
|---|---|
| `docs/control-path/api-v1.yaml` | `POST /shares` description: `fsid` optional, `FSID_IN_USE` blocker |
| `xiNAS-MCP/src/api/plan/providers/nfs.ts` | allocation, marker mutation + pin, `FSID_IN_USE`, delete cleanup |
| `xiNAS-MCP/src/api/seed-shares.ts` | use the shared allocator; write markers |
| `xiNAS-MCP/src/api/server.ts` | boot backfill |
| `xinas_menu/screens/nfs.py` | stop allocating client-side |
| `docs/Storage/fs-shares-management-spec.md` | §4.5 submission, §7 failure rows |
| `docs/control-path/s3-nfs-executor-spec.md` | the allocation contract; close N5's `fsid` half (§11, §12); **fix §4's line 247** |

That last one is a correction, not just an addition. `s3-nfs-executor-spec.md:247`
states that `fsid` is *"validated (integer) and uniqueness-enforced at plan time"*.
The uniqueness half is not true today — `validateShareSpec` checks
`Number.isInteger` and nothing else
([providers/nfs.ts:125](../../../xiNAS-MCP/src/api/plan/providers/nfs.ts)), which
is the same gap §1 describes from the client side. This design is what makes the
sentence accurate; it must not be left standing as a description of the old code.

TypeScript under `xiNAS-MCP/src/` must carry `Requires-Rebuild: xinas_node_build`
— `xinas-api` runs compiled JS from an untracked `dist/`, so without it the change
never reaches the host.

## 11. Sequencing

This lands on top of [PR #283](https://github.com/XinnorLab/xiNAS/pull/283), which
documents client-side allocation as current behavior and adds the fail-closed
mitigation. This work replaces both. Branch: `feat/server-side-fsid-allocation`,
cut from that branch, updating those spec paragraphs as part of the change rather
than leaving #283 describing a scheme we removed.

## 12. Out of scope

- **`fsid` reuse after delete.** The allocator stays `max+1`, so deleting share `4`
  of `{0,1,4}` leaves the next allocation at `5`, not `4`. Reuse would need the
  marker rows to become the authoritative free-list; the numbers are 32-bit and
  a NAS node's share count is small, so exhaustion is not a real concern.
- **Backfilling `fsid` onto exports the control path does not manage.** Out of
  band by definition.
- **Changing how `fsid` is rendered into `/etc/exports`.** The compile deliberately
  does not emit `fsid=N` today ([lib/health/drift.ts:35](../../../xiNAS-MCP/src/lib/health/drift.ts));
  that is a separate, tracked question and this design does not touch it.
