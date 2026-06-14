# ADR-0017: Tombstone absent-file restore + adopt removed-domain closure

- **Status:** accepted
- **Date:** 2026-06-14
- **Stream:** S13 (S11 + S12 follow-on)
- **Supersedes / amends:** completes the tombstone-based absence restore deferred
  in ADR-0013 §Consequences; closes the "removed domain" case ADR-0015 §3 left in
  adopt's per-domain gating. Adds one manifest field; does not change baseline
  reset or the S11 write path.

## Context

S11 (ADR-0013) restore writes a snapshot's captured config-file bytes but never
DELETES a managed file that was absent at capture yet exists now — restoring to a
state where, e.g., NFS was off leaves `/etc/exports` in place. S12 (ADR-0015)
adoption's per-domain gate skips a domain whose captured primary kind is empty,
explicitly deferring the "snapshot removed a whole domain" case to tombstones.
This ADR adds absence restore and closes that adopt coupling, so S12's durability
claim ("the next apply reinforces the restore") becomes true for removed domains.

Four facts, each **verified against the code**:

1. **Capture omits absent files.** `ConfigCollector.collect_system_files()` skips
   files it can't read (no `system/` entry). `Checksums` (`models.py`) is a
   CLOSED 8-field dataclass; an absent file's field is `""`, `to_dict()` omits
   empties, `from_dict()` re-defaults missing keys to `""`.

2. **The read-time inference trap (THE HINGE).** Because `to_dict()` omits
   empties, a *missing checksum key at read time* is AMBIGUOUS: it can mean "the
   file was absent at capture" OR "the snapshot predates that tracked field"
   (the `Checksums` fields carry an explicit "snapshot predates these fields"
   caveat). Inferring tombstones from missing keys would, for an old snapshot,
   wrongly DELETE live files. So tombstones MUST be derived from **explicit S13
   metadata recorded at snapshot creation**, never inferred from historical
   absence. This is the design hinge.

3. **The delete is mechanically safe.** The restore set today is files in the
   `system/` payload where current≠target — absent-at-target files aren't in the
   payload, so they're never considered. The pre-change ephemeral captures every
   *live* file's bytes (so a file we delete is recoverable), and
   `_reconverge_commands` is file-name driven (`exportfs -ra` / `netplan apply`
   handle a removed file).

4. **S12 adopt's per-domain gate** (`adoptOverlay`, `config-rollback.ts`) skips a
   domain whose captured primary kind is empty — the documented deferral point.

## Decision

### 1. Explicit tombstone metadata — `absent_files` (THE HINGE)

A new `Manifest.absent_files: list[str]` (logical names from `CHECKSUM_TARGETS`)
records which managed files were ABSENT at snapshot creation, derived at create
time from the then-known managed set (`collect_system_files` already detects
absences — the files it skips). It is persisted in the manifest and projected to
the observed `ConfigSnapshot`. **Tombstones are derived ONLY from this explicit
field, never from a missing checksum key at read.** Pre-S13 snapshots have no
`absent_files` → no tombstones → they restore exactly as S11. This removes the
absent-vs-predates ambiguity entirely.

### 2. Restore — `write_set` + `delete_set`

`execute_restore_snapshot` computes two sets:

- **write_set** = captured `system/` files where current≠target checksum (S11,
  unchanged).
- **delete_set** = files in the target's `absent_files` that EXIST now (current
  present). (delete_set only ever contains files present now, which is why
  rollback can recreate them — §3.)

It deletes the delete_set files, then reconverges over the **union** of
write_set ∪ delete_set logical names (the existing `_reconverge_commands` mapping
handles a deletion the same as a rewrite). An empty union is a successful no-op.

**Restorable guard:** the current `captured = list_system_files(id); if not
captured → no_restorable_payload` widens to account for tombstones — a snapshot
is restorable if it has captured bytes OR a non-empty `absent_files`.

### 3. File-level rollback for deletes

The pre-change ephemeral is created BEFORE any change and captures every live
file's bytes. Because delete_set ⊆ files-present-now, the ephemeral holds the
bytes of everything we delete. `_restore_rollback` extends to **recreate** the
delete_set files (write the ephemeral's captured bytes back) in addition to
restoring the write_set, then reconverges the same union.

### 4. Absence projection (Python → TS)

`snapshot list/show --format json` exposes `absent_files`; the bridge's
`projectSnapshot` carries it onto the observed `ConfigSnapshot` row; `restorable`
becomes `(system_files non-empty) OR (absent_files non-empty)`.

### 5. Adopt removed-domain closure (TS provider)

`adoptOverlay`'s per-domain gate relaxes: when a domain's captured primary kind
is empty AND the domain's backing **logical file** is in the snapshot's
`absent_files`, DELETE the domain's current **primary-kind** desired rows (the
tombstone restore removes the live file, so deleting the rows that would
re-render it is consistent → drift clean). The gate is per-LOGICAL-FILE
(`etc_exports`, `netplan` — never raw paths), and the delete is **primary-kind
only**:

- `Share` (primary) → gated on `etc_exports` ∈ `absent_files`; delete current
  `Share` rows.
- `NetworkInterface` (primary) → gated on `netplan` ∈ `absent_files`; delete
  current `NetworkInterface` rows.
- **The singleton kinds `ExportGroup` and `NfsProfile` are NEVER
  tombstone-deleted.** They don't render export entries into the absent file
  (`ExportGroup/default` and the default `NfsProfile` persist with zero exports,
  and shares reference `export_group_id: "default"`), so deleting them would
  break, not clean. They keep their NORMAL captured-row adoption (S12); only the
  per-resource primary kind is tombstone-deletable.
- "Zero captured `Share` rows but `etc_exports` present (NOT in `absent_files`)"
  still skips (no spurious drift) — only explicit file-absence triggers deletes.

### 6. Clients / contracts

- **api-v1:** `ConfigSnapshot` gains `absent_files: string[]`.
- **catalog:** rollback description unchanged (adopt already documented in S12).
- **TUI:** no new action — the existing restore + adopt now handle removed
  domains transparently; the snapshot detail may surface `absent_files`.

## Alternatives considered

- **Infer tombstones from missing checksum keys at read time** — REJECTED (the
  hinge): ambiguous for old snapshots (absent vs predates-tracking) → would
  wrongly delete files. Explicit creation-time metadata is the only safe basis.
- **Per-coarse-domain absence** — rejected: NFS spans multiple files; `nfs.conf`
  (NfsProfile) can persist while `etc_exports` is removed. Per-logical-file is
  precise.
- **Tombstone `NfsProfile`** — rejected: singleton default, never "removed."
- **Capture the full managed set as explicit `""` checksums** — rejected as a
  larger change; a dedicated `absent_files` list is the minimal explicit signal
  and reads cleanly through the projection.

## Consequences

- New `Manifest.absent_files`; pre-S13 snapshots have none → S11 behavior (no
  tombstones), an honest gate like S11's `restorable` / S12's `adoptable`.
- A targeted restore now removes managed files absent at capture, and a removed
  domain's desired rows are deleted on adopt → drift fully clean. **S12's
  durability claim becomes true for removed domains.**
- Destructive deletes ride the existing `dangerous` gate. Plan-time visibility is
  scoped to what the provider can actually derive: the snapshot's `absent_files`
  (tombstone CANDIDATES) and, under adopt, the desired-row deletes (known from
  KV). The realized file `delete_set` depends on live filesystem presence and is
  computed by the Python runner at restore time — it is reported in the task
  execution OUTPUT, not the plan. (The plan never claims the realized file
  delete_set.)
- Storage topology stays out of scope; `NfsProfile` is never tombstone-deleted.
- The pre-change ephemeral, the `ConfigHistory/default` lease, and the
  local-runner connectivity argument all carry over from S11/S12 unchanged.
