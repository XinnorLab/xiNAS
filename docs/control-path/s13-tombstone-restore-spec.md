# xiNAS S13 — Tombstone absent-file restore + adopt removed-domain closure (design spec)

**Status:** design (2026-06-14). Implements ADR-0017. Completes the tombstone
follow-on ADR-0013 deferred and closes the removed-domain case ADR-0015 §3 left
in adopt's per-domain gate. Companion plan (written after spec approval):
`docs/plans/2026-06-14-s13-tombstone-restore-plan.md`.

**Goal.** A targeted `config.rollback` restores the ABSENCE of a managed file —
deleting files that exist now but were absent at snapshot time — and, under
`adopt`, also deletes the corresponding desired rows for a removed domain, so
drift goes fully clean. Default (no `adopt`) restore gains the file deletes;
adopt gains the removed-domain closure.

**The hinge (ADR-0017 §1):** tombstones come from an EXPLICIT `absent_files`
manifest field derived at snapshot creation, NEVER inferred from a missing
checksum key at read (which can't distinguish "absent" from "predates the tracked
field"). Pre-S13 snapshots have no `absent_files` → no tombstones → exact S11
behavior.

---

## 1. Scope

### In scope
- **Capture:** an explicit `Manifest.absent_files` list of logical names absent
  at creation (from the then-known `CHECKSUM_TARGETS`).
- **Restore:** a `delete_set` alongside the S11 `write_set`; delete absent-target
  files that exist now, reconverge the union; widen the restorable guard.
- **Rollback:** recreate deleted files from the pre-change ephemeral.
- **Projection:** carry `absent_files` Python→TS onto the observed
  `ConfigSnapshot`; widen `restorable`.
- **Adopt:** relax the per-domain gate to delete a removed domain's desired rows,
  gated on the kind's backing logical file ∈ `absent_files`.
- **Clients:** api-v1 `ConfigSnapshot.absent_files`.

### Out of scope
- **Storage topology** (RAID/Pool/Filesystem) — never tombstoned.
- **`NfsProfile` tombstone-delete** — singleton default; keeps normal
  captured-row adoption but is never deleted by a tombstone.
- **Pre-S13 snapshots** — no `absent_files` → no tombstones (S11 behavior).
- **Inferring absence from missing checksum keys** — explicitly rejected (the
  hinge).

## 2. Component map

```
 create_snapshot ─► collector reports absences ─► Manifest.absent_files ─► store
 execute_restore_snapshot:
   write_set  = captured system/ files, current≠target (S11)
   delete_set = absent_files ∩ files-present-now            (S13)
   delete delete_set → reconverge(write_set ∪ delete_set) → validate
   on fail: _restore_rollback recreates write_set ∪ delete_set from pre-change ephemeral
 snapshot list/show --format json → absent_files
   → bridge projectSnapshot → observed ConfigSnapshot {absent_files, restorable=sys||absent}
 adoptOverlay: primary kind empty AND backing logical file ∈ absent_files
   → delete the PRIMARY kind's current desired rows (Share↔etc_exports,
     NetworkInterface↔netplan; ExportGroup + NfsProfile never tombstone-deleted)
```

## 3. Part 1 — explicit absence metadata

### 3.1 Collector
`collect_system_files()` already detects absences (the files it skips). Add a
sibling that returns the absent logical names, e.g.
`collect_absent_system_files() -> list[str]` = `[name for name, path in
SYSTEM_FILE_PATHS.items() if not Path(path).exists()]` (or reuse the same OSError
walk). The managed set is the then-known `SYSTEM_FILE_PATHS` keys.

### 3.2 Manifest + store
`Manifest` gains `absent_files: list[str] = field(default_factory=list)` with
`to_dict`/`from_dict` (omit when empty, mirror `files_changed`). No new store
payload — it rides the manifest JSON.

### 3.3 create_snapshot
`engine.create_snapshot` sets `manifest.absent_files = collector absent list`
(computed from the same collection pass as `system_files`). Every S13+ snapshot
records it; baseline/ephemeral too (consistent).

## 4. Part 2 — restore (write_set + delete_set)

### 4.1 `execute_restore_snapshot`
- `write_set` (unchanged S11): captured `system/` names where
  `current_checksums.get(n) != target_checksums.get(n)`.
- `delete_set` (NEW): `[n for n in target.absent_files if current file n EXISTS]`
  — compare against the current live state (the same `_collect_current_checksums`
  / path existence the runner already uses). A name absent in the target AND
  absent now contributes nothing.
- Apply: write the write_set bytes (S11), then DELETE the delete_set files
  (`_delete_system_file(name)` — unlink the live path, tolerate already-absent).
- Reconverge over `write_set ∪ delete_set` logical names (existing
  `_reconverge_commands`; deleting `/etc/exports` → `exportfs -ra`, deleting
  `netplan` → the flush + `netplan apply` sequence).
- **Restorable guard:** the existing `if not captured → no_restorable_payload`
  becomes `if not captured and not target.absent_files → no_restorable_payload`.
  An empty `write_set ∪ delete_set` (already at target) is a successful no-op
  (runner-reported, not a plan block — consistent with S11).

### 4.2 Validate
`_validate_restore` runs after the union apply (link/service/exports state), same
as S11.

## 5. Part 3 — file-level rollback for deletes

The pre-change ephemeral (created before any change) captures every live file's
bytes; since `delete_set ⊆ files-present-now`, it holds the bytes of everything
deleted. `_restore_rollback(pre_change_id, restore_set)` widens to take the
union: for each name in `write_set ∪ delete_set`, write the ephemeral's captured
bytes back (a deleted file is recreated; `read_system_file` returns its
pre-change bytes), then reconverge the union. A name the ephemeral didn't capture
(genuinely absent pre-change) is skipped — it stays absent, which is correct.

## 6. Part 4 — absence projection (Python → TS)

The bridge's observed projection consumes **`snapshot list --format json`** (the
S9 ConfigSnapshot collector path), so that is the command S13 must extend:

- **`snapshot list`** (`__main__.py`, the path that today injects the derived
  `restorable` per row): add `absent_files` to each per-snapshot dict AND widen
  the injected `restorable` to `system_files-present OR absent_files non-empty`.
  This is the command the bridge reads.
- **`snapshot show`** returns `manifest.to_dict()`, so it exposes `absent_files`
  **for free** once the manifest field lands (T2) — but it does NOT compute the
  derived `restorable` today, and the bridge does not use `show` for the observed
  projection, so S13 does NOT add `restorable` to `show` (keep that surface
  unchanged; only `list` carries the derived `restorable`).
- **Bridge** (`xinas-history-bridge.ts`): `ProjectedSnapshot`/`HistoryManifest`
  gain `absent_files: string[]`; `projectSnapshot` carries it; `restorable` (from
  `list`) is already the widened value.
- **Observed `ConfigSnapshot`:** the projected row's `status` carries
  `absent_files` (+ the widened `restorable`).

## 7. Part 5 — adopt removed-domain closure (provider)

`adoptOverlay` (`config-rollback.ts`) reads the target's `absent_files` from the
observed `ConfigSnapshot` row (already in scope — the provider reads observed
rows). The per-domain gate relaxes:

```
for { primary, kinds } of ADOPT_DOMAINS:
  captured = payload[primary] ?? []
  if captured.length > 0:        # S12 path — put captured + delete orphans
    ...unchanged...
  else:                          # S13 — domain not in payload
    backing = DOMAIN_FILE[primary]              # Share→'etc_exports', NetworkInterface→'netplan'
    if backing && absentFiles.includes(backing):
      delete EVERY current desired row of the PRIMARY kind only
      (revision-pinned, like S12 orphan deletes)
    # else: skip (no spurious drift) — S12 behavior
```

- `DOMAIN_FILE = { Share: 'etc_exports', NetworkInterface: 'netplan' }` — logical
  names, not raw paths.
- **Primary-kind only.** The tombstone-delete removes only the per-resource
  primary kind (`Share` / `NetworkInterface`) — the rows that re-render the absent
  file. The singleton kinds `ExportGroup` and `NfsProfile` are NEVER
  tombstone-deleted: `ExportGroup/default` and the default `NfsProfile` persist
  with zero exports (shares reference `export_group_id: "default"`), so deleting
  them would break, not clean. Their `kinds` membership stays for the S12
  captured-row path only.
- Revision pins + `dangerous` + the diff listing the deletes carry over from S12.
- `not_adoptable` (S12) is unchanged — it fires only when there is no
  `snapshot-desired` payload at all; tombstone deletes augment an
  otherwise-adoptable plan (a payload present but empty for the removed domain).

## 8. Contracts (api-v1.yaml)
`ConfigSnapshot` schema: add `absent_files: { type: array, items: { type:
string }, description: "Managed logical files absent at capture (S13 tombstone
set)." }`.

## 9. Testing strategy
- **Collector (py unit):** `collect_absent_system_files` returns exactly the
  absent managed names for a fixture tree.
- **Manifest (py unit):** `absent_files` round-trips through to_dict/from_dict;
  empty omitted.
- **create_snapshot (py unit):** a snapshot taken with `/etc/exports` absent has
  `absent_files == ['etc_exports']`.
- **Restore delete (py unit):** target `absent_files=['etc_exports']`, current
  `/etc/exports` present → restore DELETES it + reconverges (`exportfs -ra`); an
  already-absent file is a no-op; restorable guard true on absent_files-only.
- **Rollback (py unit):** delete + validation-fail → the deleted file is RECREATED
  from the pre-change ephemeral bytes.
- **Projection (TS unit):** `projectSnapshot` carries `absent_files`; `restorable`
  true when only `absent_files` is non-empty.
- **Provider (TS unit):** primary kind empty + `etc_exports` ∈ absent_files →
  deletes current `Share` desired ONLY (NOT `ExportGroup`, NOT `NfsProfile`),
  revision-pinned; primary empty + file NOT in absent_files → skips (no deletes);
  `NetworkInterface` symmetric on `netplan`. Also assert a captured-row adopt with
  an `ExportGroup` row still adopts it (S12 path unaffected by the tombstone
  exclusion).
- **e2e:** real api+agent — (1) restore a snapshot whose `etc_exports` was absent
  while a live `/etc/exports` exists → task success, file gone; (2) adopt that
  snapshot → desired Share rows deleted, drift clean; (3) pre-S13 snapshot (no
  `absent_files`) → no deletes (S11 behavior).
- **Runbook §5g:** on-node absence-restore + removed-domain adopt smoke.

## 10. Decomposition (T0–T9)
- **T0 Contracts:** api-v1 `ConfigSnapshot.absent_files`; ADR/spec cross-refs.
- **T1 Collector:** `collect_absent_system_files`; py unit.
- **T2 Manifest + create_snapshot:** `absent_files` field + round-trip + wired at
  create; py unit.
- **T3 Restore delete_set:** `delete_set`, `_delete_system_file`, reconverge
  union, restorable guard; py unit.
- **T4 Rollback union:** `_restore_rollback` recreates deletes; py unit.
- **T5 CLI + bridge projection:** `absent_files` through list/show JSON →
  `projectSnapshot` → observed row; widened `restorable`; TS + py unit.
- **T6 Provider gate relaxation:** `adoptOverlay` tombstone deletes (DOMAIN_FILE,
  NfsProfile exclusion, revision pins); TS unit.
- **T7 Apply/restore wiring check:** the adopt tombstone deletes flow through
  apply (revert on failure); TS unit (mirrors S12 T5).
- **T8 Clients surface:** TUI snapshot detail shows `absent_files` (read-only); py
  unit (light).
- **T9 e2e + runbook §5g + full gate.**

## 11. Open risks
- **Mass deletion.** A snapshot with many `absent_files` deletes many live files
  on restore. Bounded by: the managed set is 8 files; the `dangerous` gate; and
  plan-time visibility of the snapshot's `absent_files` (tombstone CANDIDATES).
  Pre-S13 snapshots can't tombstone at all.
- **Plan-time vs execute-time delete visibility (review P1).** The actual file
  `delete_set` depends on LIVE filesystem presence and is computed inside the
  Python runner at restore time — the TS provider cannot derive it at plan time
  (it has only observed metadata + `absent_files`). So: the **plan** surfaces the
  snapshot's `absent_files` (tombstone candidates) and, under adopt, the
  plan-time desired-row deletes (which the provider DOES know from KV); the
  **task execution output** reports the actual file `delete_set` the runner
  applied. The docs/tests must not claim the plan lists the realized file
  `delete_set`.
- **`exportfs -ra` with `/etc/exports` removed.** Confirm the reconverge tolerates
  a missing `/etc/exports` (clears kernel exports) rather than erroring; if it
  errors, the runner treats reconverge failure as a validation failure →
  file-level rollback (safe). Verify in T3.
- **Projection lag.** `absent_files` rides the same observed `ConfigSnapshot`
  projection as `restorable`/`adoptable`; no new freshness concern beyond S11/S12.
- **NfsProfile coupling.** Excluding NfsProfile from tombstone-delete means a
  snapshot that removed NFS exports but kept the profile adopts cleanly (exports
  deleted, profile kept) — the intended behavior; documented so a future reader
  doesn't "fix" it.
