# Design: Non-destructive `site.yml` re-run (storage-reset safety)

**Date:** 2026-07-06
**Status:** Approved (design) — pending implementation plan
**Area owner spec:** [docs/Installer/raid-spec.md](../../Installer/raid-spec.md)
**Fixes:** Finding C1 — "A routine `site.yml` re-run destroys all NAS data (shipped default)."

---

## 1. Problem

Two roles delete data on **every** full-playbook run, not just first install:

- `raid_fs` ships `xfs_force_mkfs: true` ([defaults/main.yml:16](../../../collection/roles/raid_fs/defaults/main.yml), [presets/default/raid_fs.yml:16](../../../presets/default/raid_fs.yml)), so the mkfs gate in
  [create_fs.yml:91](../../../collection/roles/raid_fs/tasks/create_fs.yml) is always satisfied. Each run stops
  `nfs-server`, unmounts, and runs `mkfs.xfs -f` over the live array, then remounts
  and restarts NFS — the play finishes green while the data is gone.
- `nvme_namespace` ships `nvme_use_existing_namespaces: false`
  ([presets/default/raid_fs.yml:24](../../../presets/default/raid_fs.yml)), routing into
  [rebuild_namespaces.yml](../../../collection/roles/nvme_namespace/tasks/rebuild_namespaces.yml), which
  `nvme detach-ns`/`delete-ns` every namespace on every data controller with no prompt.

These are **two independent destructive paths**. The only interactive gate in the
pipeline, `cleanup_storage.yml`, keys `nvme_cleanup_required` off LVM/MD/ZFS detection
only ([cleanup_storage.yml:102](../../../collection/roles/nvme_namespace/tasks/cleanup_storage.yml)),
so it never fires for xiNAS's own xiRAID/XFS layout.

The blast radius includes the in-TUI update flow: `build_rebuild_cmd(("all",))`
([update_check.py:69](../../../xinas_menu/utils/update_check.py)) produces a bare
`ansible-playbook playbooks/site.yml`, so any release published with
`Requires-Rebuild: all` in its notes would reformat every node when the operator
accepts the update.

### What already is safe (no change needed)

- **Array creation is idempotent.** `create_array.yml` runs only
  `when: item.name not in existing_array_names`
  ([main.yml:187](../../../collection/roles/raid_fs/tasks/main.yml)); xiRAID restores arrays
  on boot, so a re-run does not recreate them.

The namespace rebuild, `mkfs -f`, and `xicli drive clean` on live members are the
direct offenders; the `cleanup_storage` wipe and the MD superblock sweep are inert on a
healthy xiNAS box only by omission (§5) and are gated too, so the safety is intentional.

## 2. Invariant

> A `site.yml` run — tagged or untagged, attended or unattended — never destroys an
> existing, data-bearing xiNAS storage layout unless the operator explicitly
> requested a reset. Formatting happens only on a genuinely fresh target, or under
> an explicit, confirmed reset.

## 3. Operator control: `xinas_storage_reset`

A single new variable, default `false`, read by both roles. Presets do not set it.
Explicit reset is `-e xinas_storage_reset=true` (or inventory).

When `true`, it drives **every** destructive mechanism in the pipeline (§5) — the
`cleanup_storage` wipe, namespace rebuild, MD sweep, `drive clean`, and `mkfs -f` — as a
single unit, so an operator cannot rebuild namespaces without reformatting (or vice
versa) and end up in a half-provisioned state.

### 3.1 Legacy knobs are disarmed (not "advanced overrides")

`xfs_force_mkfs` and `nvme_use_existing_namespaces` are **retired as destructive
triggers**. This resolves the contradiction of "single reset path" vs. "the old knobs
still work": a knob that can independently start a wipe would bypass both the reset
flag and the confirmation gate. So:

- **Neither knob can initiate destruction without `xinas_storage_reset`.** The
  destructive decision is driven **solely** by `xinas_storage_reset` plus the detection
  state (§4/§5). `xfs_force_mkfs: true` set alone (e.g. in a stray preset or `-e`) does
  **not** reformat a MATCH box.
- They are removed from `presets/default/raid_fs.yml` and `presets/xinnorVM/raid_fs.yml`.
  The role `defaults/main.yml` keeps them only as internal, deprecated values pinned to
  the safe side (`xfs_force_mkfs: false`, `nvme_use_existing_namespaces` no longer read
  as a public knob — namespace reuse is decided by state, §4.1), with a comment that
  `xinas_storage_reset` is the supported control.
- A test guard (§10) asserts no shipping preset sets either knob to a destructive value,
  so the footgun cannot silently return.

Precedence: `xinas_storage_reset: true` forces the destructive path (behind the §6
gate). With `xinas_storage_reset: false`, behavior is decided entirely by the detection
state — no knob overrides it.

## 4. Storage-identity detection (read-only preflight)

A single read-only detection routine computes `xinas_storage_state` ∈ {MATCH, EMPTY,
FOREIGN}. Signals:

- `xicli raid show -f json` → arrays `data` and `log` both present and online.
- `blkid -s TYPE -o value /dev/xi_data` == `xfs` **and** `blkid -s LABEL -o value
  /dev/xi_data` == the configured label.

| State | Meaning |
|---|---|
| **MATCH** | Arrays online **and** XFS present with the configured label. The desired end-state already exists. |
| **EMPTY** | No xiRAID arrays and no XFS/foreign signature on the data devices (a fresh box, including a factory drive with a single full-size `n1`). |
| **FOREIGN** | xiRAID metadata or an fs signature exists but does **not** match the expected layout (wrong label, degraded array, non-xfs type). |

### 4.1 Detection runs at BOTH layers — this is load-bearing

The namespace layer **cannot** rely on the reset flag alone. Today the rebuild vs.
reuse choice is `when: not nvme_use_existing_namespaces`
([main.yml:120-137](../../../collection/roles/nvme_namespace/tasks/main.yml)). If we
merely flip that default to reuse-existing, a **fresh** factory NVMe (single full-size
`n1`, no `n2`) is routed into `detect_existing_namespaces`, where `n1` is treated as the
log device, the data list comes back empty, and `generate_raid_config` fails. So the
namespace layer needs the full three-state decision, not a boolean:

**`nvme_namespace` decision (replaces the `nvme_use_existing_namespaces` branch):**

| `xinas_storage_state` | `reset` | Action |
|---|---|---|
| EMPTY | false | **rebuild** namespaces (fresh install — nothing to lose, no prompt) |
| MATCH | false | **use existing** namespaces (converge) |
| FOREIGN | false | **fail-fast** before deleting anything |
| any | true | **rebuild** behind the §6 gate |

**`raid_fs` decision** uses the same state fact for the `mkfs` / `drive clean` / MD-sweep
choices (§5).

**Carrying state across a run.** On a full `site.yml` run `nvme_namespace` computes the
state first (from on-disk reality, before it changes anything) and exports it as a
play-level fact. `raid_fs` reuses that fact if present; on a `--tags raid_fs` (or
manual-mode) run where `nvme_namespace` did not run, `raid_fs` computes the state itself
from disk. Detection is never re-run *after* we have begun mutating namespaces/arrays
within the same play, so an in-flight "provisioning" state is never misread as FOREIGN.

## 5. Decision matrix

Every destructive operation in the pipeline is listed here — nothing wipes outside this
table.

| State | `reset` | `cleanup_storage` wipe¹ | Namespaces | MD sweep² | `drive clean` | mkfs | Result |
|---|---|---|---|---|---|---|---|
| MATCH | false | **skip** | use existing | **skip** | **skip** | **skip** | **converge, silent, data preserved** |
| EMPTY | false | run (own gate³) | rebuild | run | clean | format | first install (unchanged) |
| FOREIGN | false | — | — | — | — | — | **fail-fast before any wipe** (§5.1) |
| any | true | run | rebuild | run | clean | format | destructive, behind the YES-gate (§6) |

¹ `cleanup_storage.yml`'s `wipefs -a` + `dd` on data drives
([cleanup_storage.yml:250-264](../../../collection/roles/nvme_namespace/tasks/cleanup_storage.yml)).
² `raid_fs`'s unconditional `mdadm --stop` + `--zero-superblock` on members overlapping
xiRAID basenames ([main.yml:117-153](../../../collection/roles/raid_fs/tasks/main.yml)).
³ `cleanup_storage` keeps its own LVM/MD/ZFS confirmation for *foreign* storage; that is
orthogonal to the xiNAS reset gate.

**Why they are in the table even though they are inert on MATCH today.** On a healthy
xiNAS box the `cleanup_storage` wipe is skipped (`nvme_cleanup_required` is false — no
LVM/MD/ZFS present) and the MD sweep finds no overlapping MD device, so both no-op *by
omission*. This design makes the safety **intentional**: both are explicitly gated on
`xinas_storage_state != MATCH` (or `reset`), and on FOREIGN the play fails **before**
either can run. Safety must not depend on "a xiNAS box happens to have no MD/LVM/ZFS."

### 5.1 FOREIGN → fail-fast

When storage is FOREIGN and reset is not set, the play halts with an actionable
message rather than reformatting:

> Existing filesystem `'<found-label>'` (`<type>`) on `/dev/xi_data` does not match the
> expected label `'<want-label>'`. Set `xinas_storage_reset=true` to wipe and rebuild,
> or clean the device manually.

This **changes current behavior**: today a label mismatch satisfies the mkfs gate and
silently reformats ([create_fs.yml:91](../../../collection/roles/raid_fs/tasks/create_fs.yml),
the `blkid_label.stdout != item.label` clause). Simply flipping `xfs_force_mkfs` would
leave that hole open, so the mkfs decision is rewritten to:

1. `xinas_storage_reset` → reformat (after the §6 gate).
2. else no XFS present (EMPTY) → format (first install; nothing to lose).
3. else XFS present with matching label (MATCH) → **skip mkfs** (converge).
4. else (FOREIGN) → **fail** with the message above.

`xicli drive clean` ([main.yml:50](../../../collection/roles/raid_fs/tasks/main.yml)) is
gated the same way — it runs only on EMPTY or reset, never on a MATCH re-run.

## 6. Confirmation gate — enforced at the point of destruction

The gate cannot live only in `nvme_namespace`: `ansible-playbook … --tags raid_fs -e
xinas_storage_reset=true` (and manual mode, `nvme_auto_namespace: false`) never runs
`nvme_namespace`, so a gate there would be bypassed while `raid_fs`'s `drive clean`
([main.yml:50](../../../collection/roles/raid_fs/tasks/main.yml)) and `mkfs`
([create_fs.yml:86](../../../collection/roles/raid_fs/tasks/create_fs.yml)) still wipe.
The invariant promises safety for tagged **and** untagged runs, so the gate must be
enforced wherever destruction happens.

**Mechanism — a shared, idempotent confirm include guarded by a fact.** A reusable task
file (banner + `ansible.builtin.pause` + verify, modeled on `cleanup_storage.yml`) is
invoked by **both** roles right before their first destructive step:

- It fires only when `xinas_storage_reset | bool` **and** `not
  xinas_storage_reset_confirmed | default(false)`.
- On success it sets the play-level fact `xinas_storage_reset_confirmed: true`.
- The banner names the array(s), label, capacity, and mountpoint about to be destroyed;
  `pause` requires the operator to type `YES`; any other answer aborts.
- Bypassed only by `nvme_skip_cleanup_confirmation: true` — an unattended intentional
  reset sets both `xinas_storage_reset=true` and `nvme_skip_cleanup_confirmation=true`
  (this also sets the confirmed fact so neither role re-checks).

Result: on a full run `nvme_namespace` prompts once and sets the fact; `raid_fs` sees it
set and does not re-prompt. On a `--tags raid_fs` / manual run, `raid_fs` finds the fact
unset and prompts itself. **No destructive step in either role executes while
`xinas_storage_reset` is set and the confirmed fact is false.** `raid_fs` treats a
required-but-unconfirmed reset as a hard failure (it must not silently proceed to
`mkfs`).

## 7. Update-flow interaction

The TUI update runs a bare `site.yml` unattended. `xinas_storage_reset` defaults to
`false` and the TUI never injects it, so the update path resolves to MATCH → converge
→ data preserved. **`Requires-Rebuild: all` is now safe.** No change to
[update_check.py](../../../xinas_menu/utils/update_check.py); a test guard asserts the
update path never sets the reset flag.

### Requires-Rebuild trailer

**Not added.** This change is role task logic; after a release checkout the new files
are already on disk and take effect on the next `site.yml` run. Per the CLAUDE.md rule,
the trailer is for changes that *require* a role to re-run to take effect — this does
not. Forcing a converge run at update time is unnecessary for correctness.

## 8. Fresh-install path

Unchanged. On a genuinely empty box (no arrays, no XFS) detection returns EMPTY →
format normally, no prompt. First-install UX is identical to today.

## 9. Spec and doc changes (spec-first, same PR as code)

- **[docs/Installer/raid-spec.md](../../Installer/raid-spec.md)** — the durable contract:
  - §4.2/§4.3: reuse-existing-namespaces becomes the default; rebuild is the reset path.
  - §7.6 "Decide": replace the current always-true gate with the converge / fail-fast /
    reset matrix of §5.
  - §9 table: the "Re-run with NFS already serving `/mnt/data`" row changes from
    "stops NFS, reformats, restarts" to "converges, data preserved"; add a row for the
    FOREIGN fail-fast guard.
  - New section: "Idempotency & the storage-reset contract."
- **Role defaults + presets** — remove `xfs_force_mkfs` and
  `nvme_use_existing_namespaces` from `presets/default/raid_fs.yml` and
  `presets/xinnorVM/raid_fs.yml`; in `raid_fs/defaults/main.yml` pin them to the safe
  side as deprecated/internal (§3.1) with a comment pointing to `xinas_storage_reset`.
- **[CLAUDE.md](../../../CLAUDE.md)** — fix the inverted claim ("Roles are idempotent —
  safe to re-run, except `xfs_force_mkfs: true` forces recreation"): re-runs are now
  idempotent by default; document `xinas_storage_reset`.
- **Role READMEs** for `raid_fs` and `nvme_namespace`.

## 10. Testing

Structural pyyaml guards, matching the existing idiom
([test_nvme_namespace_fallback.py](../../../tests/test_nvme_namespace_fallback.py),
[test_preset_playbooks.py](../../../tests/test_preset_playbooks.py)); there is no
molecule/behavioral harness.

New `tests/test_raid_fs_safe_defaults.py`:

- assert **no shipping preset** (`presets/default/`, `presets/xinnorVM/`) sets
  `xfs_force_mkfs` or `nvme_use_existing_namespaces` to a destructive value — ideally
  neither key is present at all (§3.1); assert the role default of `xfs_force_mkfs` is
  `false`;
- assert `xinas_storage_reset` defaults to `false` in the role defaults;
- assert the `nvme_namespace` rebuild-vs-reuse choice is driven by `xinas_storage_state`
  (EMPTY/MATCH), **not** by a bare `nvme_use_existing_namespaces` boolean — the P0
  regression guard: a fresh factory single-`n1` drive must route to *rebuild*;
- assert the `mkfs`, `delete-ns`, `drive clean`, `cleanup_storage` wipe, and MD-sweep
  tasks each carry a `when:` referencing `xinas_storage_state` / `xinas_storage_reset`
  (every destructive op is gated; none is inert only by omission);
- assert both roles invoke the shared confirm include and that `raid_fs` fails when
  `xinas_storage_reset` is set but `xinas_storage_reset_confirmed` is not (the
  `--tags raid_fs` bypass guard);
- assert the confirm task is bypassable by `nvme_skip_cleanup_confirmation`;
- assert the FOREIGN fail-fast task exists.

Manual verification matrix (HW/VM), run once during implementation:

| Scenario | Expected |
|---|---|
| Fresh box, `site.yml` | arrays + XFS created, mounted |
| **Fresh factory drive with a single full-size `n1`** | EMPTY → namespaces rebuilt (`n1`+`n2`), arrays + XFS created (P0 regression) |
| Re-run over healthy array | converge; checksum of a test file before/after identical; NFS stays up; `cleanup_storage` wipe + MD sweep both no-op |
| `--tags raid_fs -e xinas_storage_reset=true` (no `nvme_namespace`) | confirmation still prompts (or aborts unattended) — gate not bypassed |
| `xinas_storage_reset=true`, interactive | banner + `YES` required, then wipe + rebuild |
| `xinas_storage_reset=true` + `nvme_skip_cleanup_confirmation=true` | unattended wipe + rebuild, no prompt |
| Re-run with a mismatched XFS label | fail-fast with the §5.1 message, no reformat |

## 11. Out of scope (YAGNI)

- No TUI "Reset storage" action in this change — full teardown already exists via the
  uninstaller. A guided reset screen can come later if wanted.
- No exact geometry match in detection (level/strip). Presence + online + label is the
  identity; geometry cannot change without a reset anyway.
- No multi-array / multi-filesystem support beyond today's single `data`+`log`.
