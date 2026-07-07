# Storage-Reset Safety — On-NAS Behavioral Validation Scenarios (finding C1)

**Target:** a live xiNAS storage node (bare metal with NVMe, or the `xinnorVM` whole-disk
VM profile).
**Executor:** an agent (or operator) running **on the NAS** — via shell (`xicli`,
`ansible-playbook`, `blkid`, `findmnt`), and/or the xiNAS MCP tools (`raid.list`,
`health.run_check`, `share.*`).
**What this validates:** the storage-reset contract in
[docs/Installer/raid-spec.md §11](../../Installer/raid-spec.md) and the design in
[../specs/2026-07-06-storage-reset-safety-design.md](../specs/2026-07-06-storage-reset-safety-design.md).
The structural pytest guards in `tests/test_raid_fs_safe_defaults.py` prove the task
*wiring* is present; they do **not** exercise real xiRAID/XFS. These scenarios close that
gap on live hardware.

## Why this exists

Before the C1 fix, any `site.yml` re-run reformatted the live array. The fix makes a
re-run **converge** (no data loss) and gates all destruction behind an explicit
`xinas_storage_reset` + a `YES` confirmation. None of that can be proven without running
the roles against real drives — hence the scenarios below.

## Status legend

| Status | Meaning |
|---|---|
| 🟡 **Need to be validated** | Written, not yet executed on hardware. **All scenarios below start here.** |
| 🟢 Validated | Ran on real hardware/VM; actual == expected. Record date, host, and evidence. |
| 🔴 Failed | Ran; actual ≠ expected. File a bug and link it. |

When a scenario is validated, change its status line and append an **Evidence** block
(command output, checksums, `xicli raid show -f json`, timestamps).

## Conventions used by every scenario

- **Sentinel file:** `/mnt/data/.c1-sentinel` with known content; its SHA-256 is the
  data-loss oracle. `sha256sum /mnt/data/.c1-sentinel` before and after must match for any
  converge scenario, and must differ (file gone) for any reset scenario.
- **State probe:** `xicli raid show -f json` (arrays `data`+`log` online) and
  `blkid -s TYPE -o value /dev/xi_data` / `blkid -s LABEL -o value /dev/xi_data`
  (`xfs` / `nfsdata`) — the same signals `detect_storage_state.yml` reads.
- **NFS liveness:** `systemctl is-active nfs-server` sampled during the run; for converge
  scenarios it must never leave `active`.
- **Playbook:** `ansible-playbook playbooks/site.yml` (add `--tags` / `-e` as noted).

---

## Scenario S1 — Fresh install provisions cleanly (baseline) — 🟡 Need to be validated

**Goal:** the happy path is unaffected by the C1 changes.

**Preconditions**
- A node with no xiRAID arrays and no XFS on the data devices (state = EMPTY).

**Steps**
1. `ansible-playbook playbooks/site.yml`

**Expected**
- Arrays `data` + `log` created and online (`xicli raid show`).
- `/dev/xi_data` is XFS, label `nfsdata`, mounted at `/mnt/data`.
- `exportfs -v` shows `/mnt/data`.

**Evidence to capture:** `xicli raid show -f json`, `xfs_info /mnt/data`, `mount | grep /mnt/data`.

---

## Scenario S2 — Factory single-`n1` drive → EMPTY → rebuild (P0 regression) — 🟡 Need to be validated

**Goal:** the original P0 hole — flipping the reuse default would misread a factory drive
as "reuse" and fail. Detection must classify it EMPTY and rebuild.

**Preconditions**
- Data NVMe drives each carry a single factory namespace `n1` spanning the whole device
  (no `n2`), no xiRAID metadata.

**Steps**
1. `ansible-playbook playbooks/site.yml`

**Expected**
- `detect_storage_state` → **EMPTY** (not FOREIGN).
- Namespaces rebuilt to `n1` (~500 MB) + `n2` (rest) per data drive (`nvme list`).
- Arrays + XFS created; the run does **not** get stuck treating `n1` as the log device.

**Evidence:** `nvme list` before/after, `xicli raid show -f json`.

---

## Scenario S3 — Converge re-run over a healthy array (the core fix) — 🟡 Need to be validated

**Goal:** a routine re-run must preserve data and never touch the array.

**Preconditions**
- S1 (or S2) completed: healthy `data`+`log`, XFS `nfsdata` mounted, NFS active.
- Create the sentinel: `echo c1-$(date +%s) > /mnt/data/.c1-sentinel; sha256sum /mnt/data/.c1-sentinel` → record hash H0.

**Steps**
1. Start sampling `systemctl is-active nfs-server` every 1 s in the background.
2. `ansible-playbook playbooks/site.yml`
3. `sha256sum /mnt/data/.c1-sentinel` → H1.

**Expected**
- `detect_storage_state` → **MATCH**; run completes green.
- **H1 == H0** (data untouched).
- NFS sampling never showed anything but `active` (NFS was not stopped).
- The `mkfs.xfs -f`, `nvme delete-ns`, `xicli drive clean`, MD-superblock sweep, and all
  three `cleanup_storage` `wipefs`/`dd` tasks were **skipped** (grep the play recap, or run
  with `-v` and confirm those tasks are `skipping`).

**Evidence:** H0/H1, the NFS-liveness sample, the play recap showing the destructive tasks skipped.

---

## Scenario S4 — Converge under `--tags raid_fs` only — 🟡 Need to be validated

**Goal:** a tags-scoped run (which does **not** run `nvme_namespace`) still converges and
still preserves data. `raid_fs` must compute the state itself.

**Preconditions:** S3 state; sentinel hash H0.

**Steps**
1. `ansible-playbook playbooks/site.yml --tags raid_fs`
2. `sha256sum /mnt/data/.c1-sentinel` → H1.

**Expected**
- `raid_fs` runs its own `detect_storage_state` (fact not pre-set) → MATCH → mkfs and
  `drive clean` skipped. **H1 == H0.** NFS stays active.

---

## Scenario S5 — Update flow (`Requires-Rebuild: all`) preserves data — 🟡 Need to be validated

**Goal:** the in-TUI update running a bare `site.yml` must converge, not wipe — even when
a release opts into a full Ansible re-run.

**Preconditions:** S3 state; sentinel H0. A test update path whose release notes carry
`Requires-Rebuild: all` (or invoke the TUI update flow that runs `site.yml` unattended).

**Steps**
1. Trigger the update / rebuild path as the TUI would (bare `ansible-playbook
   playbooks/site.yml`, no `xinas_storage_reset`).
2. `sha256sum /mnt/data/.c1-sentinel` → H1.

**Expected**
- Resolves to MATCH → converge. **H1 == H0.** No prompt appeared (unattended), and no
  destruction happened.

---

## Scenario S6 — Explicit reset, interactive `YES` gate — 🟡 Need to be validated

**Goal:** an intentional wipe requires typing `YES`, then rebuilds.

**Preconditions:** S3 state; sentinel H0 (this file is expected to be destroyed).

**Steps**
1. `ansible-playbook playbooks/site.yml -e xinas_storage_reset=true` on an interactive TTY.
2. At the banner, type `YES`.

**Expected**
- The `storage_reset_confirm` banner appears (names arrays/label/mount) and **blocks** for input.
- After `YES`: namespaces rebuilt, arrays recreated, XFS reformatted.
- `/mnt/data/.c1-sentinel` is **gone** (data destroyed, as intended).

**Also test the abort:** re-run and type `no` (or anything ≠ `YES`) → the play **aborts**
with "Storage reset cancelled" and **nothing is wiped** (verify the array + sentinel still
present if you abort against a healthy array — use a fresh sentinel first).

---

## Scenario S7 — Explicit reset, unattended bypass — 🟡 Need to be validated

**Goal:** automation can reset without a TTY using the documented bypass.

**Preconditions:** any provisioned state; sentinel present.

**Steps**
1. `ansible-playbook playbooks/site.yml -e xinas_storage_reset=true -e nvme_skip_cleanup_confirmation=true` (no TTY).

**Expected**
- No prompt; the run auto-confirms, wipes, and rebuilds. Sentinel gone.

---

## Scenario S8 — Reset requested but NOT confirmed is refused (gate can't be bypassed) — 🟡 Need to be validated

**Goal:** `--tags raid_fs` cannot sneak past the confirmation. This is the key
cross-role-enforcement check.

**Preconditions:** S3 state; sentinel H0.

**Steps**
1. Non-interactively (no TTY, e.g. output piped) run:
   `ansible-playbook playbooks/site.yml --tags raid_fs -e xinas_storage_reset=true`
   **without** `nvme_skip_cleanup_confirmation`.

**Expected**
- `raid_fs` reaches the confirmation include; with no TTY and no bypass it does **not**
  silently proceed. The play **fails** on "Refuse to wipe without confirmation" (or blocks
  on the pause if a TTY is attached) — **before** `drive clean` / `mkfs`.
- **H1 == H0** — nothing was wiped.

---

## Scenario S9 — FOREIGN: mismatched XFS label → fail-fast, no reformat — 🟡 Need to be validated

**Goal:** an unexpected/foreign filesystem must halt the play instead of being silently
reformatted (the old label-mismatch hole).

**Preconditions**
- A provisioned box, then simulate drift: relabel the XFS to something other than
  `nfsdata` (e.g. `xfs_admin -L wronglbl /dev/xi_data` while unmounted), or present a
  data device carrying a non-xiNAS XFS. Put a sentinel on it; record H0.

**Steps**
1. `ansible-playbook playbooks/site.yml` (no reset).

**Expected**
- `detect_storage_state` → **FOREIGN**; the play **fails fast** with the §5.1 message
  ("does not match the expected label … Set xinas_storage_reset=true …") **before** any
  wipe (namespace, drive clean, or mkfs).
- **H1 == H0** — the foreign data is intact.
- Re-running **with** `-e xinas_storage_reset=true` (+ `YES`) then proceeds to wipe.

---

## Scenario S10 — FOREIGN: degraded / partial array → fail-fast — 🟡 Need to be validated

**Goal:** a half-present or degraded xiRAID layout (arrays present but not the expected
healthy `data`+`log`) must not be treated as EMPTY and reprovisioned over.

**Preconditions**
- Induce a mismatch: e.g. `log` array present but `data` missing, or an array in a
  degraded/rebuilding state.

**Steps**
1. `ansible-playbook playbooks/site.yml` (no reset).

**Expected**
- Classified **FOREIGN** (not MATCH, not EMPTY) → fail-fast before any destructive op.
  Remediation requires explicit `xinas_storage_reset` or manual cleanup.

---

## Scenario S11 — Legacy knob is disarmed — 🟡 Need to be validated

**Goal:** setting the old `xfs_force_mkfs: true` alone must **not** reformat a healthy
array (the knob is disarmed; only `xinas_storage_reset` destroys).

**Preconditions:** S3 state; sentinel H0.

**Steps**
1. `ansible-playbook playbooks/site.yml -e xfs_force_mkfs=true` (no `xinas_storage_reset`).
2. `sha256sum /mnt/data/.c1-sentinel` → H1.

**Expected**
- MATCH → converge; `xfs_force_mkfs=true` is ignored for the destruction decision.
  **H1 == H0.** (Repeat with `-e nvme_use_existing_namespaces=false` → still no rebuild.)

---

## Coverage map (scenario → contract clause)

| Contract clause (raid-spec §11) | Scenarios |
|---|---|
| MATCH → converge, no destruction | S3, S4, S5, S11 |
| EMPTY → provision (incl. factory `n1`) | S1, S2 |
| FOREIGN → fail-fast before any wipe | S9, S10 |
| Reset gated by `YES`, enforced in both roles | S6, S7, S8 |
| `--tags raid_fs` cannot bypass the gate | S4, S8 |
| Update flow is safe | S5 |
| Legacy knobs disarmed | S11 |

## Sign-off

Record here when the suite has been run end-to-end on a real target:

| Host / profile | Date | Runner | Result | Notes |
|---|---|---|---|---|
| _(pending)_ | | | 🟡 not yet run | All scenarios still **Need to be validated** |
