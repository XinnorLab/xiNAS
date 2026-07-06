# Storage-Reset Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `site.yml` re-run non-destructive by default — an existing healthy xiNAS array converges silently; wipes happen only on a genuinely fresh box or under an explicit, confirmed `xinas_storage_reset`.

**Architecture:** A single read-only detection routine classifies the target as `xinas_storage_state` ∈ {MATCH, EMPTY, FOREIGN}. Every destructive op (cleanup_storage wipe, namespace rebuild, MD sweep, `drive clean`, `mkfs -f`) is gated on `state != MATCH` or the `xinas_storage_reset` flag. Destruction is gated behind a fact-guarded YES confirmation enforced in **both** `nvme_namespace` and `raid_fs` so `--tags raid_fs` cannot bypass it. FOREIGN state fails fast before any wipe.

**Tech Stack:** Ansible roles (`nvme_namespace`, `raid_fs`), YAML presets, pytest + PyYAML structural guards (no molecule/behavioral harness).

**Source spec:** [docs/superpowers/specs/2026-07-06-storage-reset-safety-design.md](../specs/2026-07-06-storage-reset-safety-design.md)

---

## ⚠️ Execution preconditions (read first)

1. **The concurrent system-drive work has landed** — commits `691ef7d`
   (`fix(nvme_namespace): protect the OS disk on LVM/ZFS/MD roots and in cleanup`) and
   `00d9361` (`fix(xinas_history): auto-rollback restores files instead of re-running
   site.yml`) now sit on `main` above the design/plan commits. Branch the execution
   worktree (`superpowers:using-git-worktrees`) from current `main` HEAD — it already
   contains that work, so there is a clean base. **Line numbers below are indicative and
   have drifted** (691ef7d rewrote `nvme_namespace/tasks/main.yml` and
   `cleanup_storage.yml`); re-anchor by task name before editing. Task 7's
   `raid-spec.md` edits (§4/§7.6/§9) land on top of 691ef7d's §2/§3.1/§9 changes — no
   git conflict, but reconcile adjacent §9 rows by hand. A separate uncommitted
   `CLAUDE.md` "Language" section may exist in the main working tree; Task 7 edits a
   different section ("Important Notes"), so the two merge cleanly.
2. **No behavioral Ansible harness exists.** "Tests" are structural PyYAML assertions
   over parsed task/preset YAML, matching `tests/test_nvme_namespace_fallback.py` and
   `tests/test_preset_playbooks.py`. Behavioral confirmation is the manual matrix in
   Task 9, run once on hardware/VM during implementation.
3. Run `pytest`, `ruff check`, `ruff format --check` before the final commit
   (project release checklist).

---

## File structure

**New files:**
- `collection/roles/nvme_namespace/tasks/detect_storage_state.yml` — read-only
  detection, sets `xinas_storage_state`. Shared: `raid_fs` reuses it via `include_role`.
- `collection/roles/nvme_namespace/tasks/storage_reset_confirm.yml` — banner + pause +
  verify, sets `xinas_storage_reset_confirmed`. Shared the same way.
- `tests/test_raid_fs_safe_defaults.py` — structural safety guards.

**Modified files:**
- `collection/roles/nvme_namespace/defaults/main.yml` — add `xinas_storage_reset`,
  deprecate `nvme_use_existing_namespaces`.
- `collection/roles/raid_fs/defaults/main.yml` — flip `xfs_force_mkfs: false`, add
  `xinas_storage_reset`.
- `collection/roles/nvme_namespace/tasks/main.yml` — detection early; state-driven
  rebuild/reuse; gate cleanup; confirm before destructive.
- `collection/roles/raid_fs/tasks/main.yml` — detection reuse; gate `drive clean` + MD
  sweep; confirm + fail-if-unconfirmed.
- `collection/roles/raid_fs/tasks/create_fs.yml` — mkfs decision → converge/fail-fast/reset.
- `presets/default/raid_fs.yml`, `presets/xinnorVM/raid_fs.yml` — remove the disarmed knobs.
- `docs/Installer/raid-spec.md`, `CLAUDE.md`, both role `README.md` — doc sync.

**Naming contract (used across tasks):**
- `xinas_storage_reset` (bool, default `false`) — operator control.
- `xinas_storage_state` (string: `MATCH` | `EMPTY` | `FOREIGN`) — detection result.
- `xinas_storage_reset_confirmed` (bool) — set true once the confirm gate passes.
- `xfs_label_wanted` (string) — the configured XFS label detection compares against
  (`nfsdata` in both presets); derived from `xfs_filesystems[0].label`.

---

## Task 1: Disarm legacy knobs (defaults + presets)

**Files:**
- Modify: `collection/roles/raid_fs/defaults/main.yml:16`
- Modify: `collection/roles/nvme_namespace/defaults/main.yml` (the
  `nvme_use_existing_namespaces` block, ~line 20)
- Modify: `presets/default/raid_fs.yml:16,24`
- Modify: `presets/xinnorVM/raid_fs.yml:11`
- Test: `tests/test_raid_fs_safe_defaults.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_raid_fs_safe_defaults.py`:

```python
"""Regression guard for finding C1 (destructive site.yml re-run).

No shipping preset may set xfs_force_mkfs or nvme_use_existing_namespaces to a
destructive value, and the role default of xfs_force_mkfs must be false. These are
structural assertions over parsed YAML — the repo has no molecule harness (see
tests/test_nvme_namespace_fallback.py).
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
RAID_FS_DEFAULTS = REPO / "collection/roles/raid_fs/defaults/main.yml"
NVME_DEFAULTS = REPO / "collection/roles/nvme_namespace/defaults/main.yml"
PRESET_RAID_FS = [
    REPO / "presets/default/raid_fs.yml",
    REPO / "presets/xinnorVM/raid_fs.yml",
]


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {}


def test_role_default_xfs_force_mkfs_is_false():
    assert _load(RAID_FS_DEFAULTS).get("xfs_force_mkfs") is False


def test_role_default_declares_storage_reset_false():
    assert _load(RAID_FS_DEFAULTS).get("xinas_storage_reset") is False
    assert _load(NVME_DEFAULTS).get("xinas_storage_reset") is False


def test_no_preset_sets_destructive_knobs():
    for preset in PRESET_RAID_FS:
        data = _load(preset)
        assert "xfs_force_mkfs" not in data, f"{preset} still sets xfs_force_mkfs"
        assert "nvme_use_existing_namespaces" not in data, (
            f"{preset} still sets nvme_use_existing_namespaces"
        )


def test_update_flow_never_injects_storage_reset():
    """The TUI update runs a bare site.yml — it must never set xinas_storage_reset
    (design §7: an unattended update converges, it never wipes)."""
    from xinas_menu.utils.update_check import build_rebuild_cmd

    for tags in [("all",), ("raid_fs",), ("nvme_namespace", "raid_fs")]:
        cmd = build_rebuild_cmd(tags)
        assert not any("xinas_storage_reset" in part for part in cmd), cmd
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_raid_fs_safe_defaults.py -v`
Expected: FAIL — `xfs_force_mkfs` is currently `True` in the role default and present in presets; `xinas_storage_reset` not yet defined.

- [ ] **Step 3: Flip the raid_fs role default and add the reset knob**

In `collection/roles/raid_fs/defaults/main.yml`, replace the `xfs_force_mkfs` block:

```yaml
# DEPRECATED / internal — do NOT use to reformat. The supported control is
# `xinas_storage_reset`. Kept only so older inventories don't error; pinned to the
# safe side. `xfs_force_mkfs: true` set alone no longer reformats a healthy array.
xfs_force_mkfs: false

# Operator control for destroying and rebuilding storage. Default false = converge
# (a re-run never touches an existing healthy array). Set true (with an interactive
# YES, or nvme_skip_cleanup_confirmation=true for automation) to wipe + rebuild.
xinas_storage_reset: false
```

- [ ] **Step 4: Add the reset knob + deprecate reuse knob in nvme_namespace defaults**

In `collection/roles/nvme_namespace/defaults/main.yml`, replace the
`nvme_use_existing_namespaces` block:

```yaml
# DEPRECATED / internal — namespace reuse vs. rebuild is now decided by
# xinas_storage_state (see tasks/detect_storage_state.yml), NOT by this knob.
# Retained only to avoid "undefined variable" on old inventories.
nvme_use_existing_namespaces: false

# Operator control for destroying and rebuilding storage (mirrors raid_fs default).
xinas_storage_reset: false
```

- [ ] **Step 5: Remove the disarmed knobs from both presets**

In `presets/default/raid_fs.yml` delete the `xfs_force_mkfs: true` line (≈16) and the
`nvme_use_existing_namespaces: false` line (≈24) with its comment block (≈22-24).
In `presets/xinnorVM/raid_fs.yml` delete the `xfs_force_mkfs: true` line (≈11) and its
comment (≈10).

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_raid_fs_safe_defaults.py -v`
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add collection/roles/raid_fs/defaults/main.yml \
        collection/roles/nvme_namespace/defaults/main.yml \
        presets/default/raid_fs.yml presets/xinnorVM/raid_fs.yml \
        tests/test_raid_fs_safe_defaults.py
git commit -m "fix(raid_fs): disarm xfs_force_mkfs / nvme_use_existing_namespaces (C1)"
```

---

## Task 2: Storage-state detection task file

**Files:**
- Create: `collection/roles/nvme_namespace/tasks/detect_storage_state.yml`
- Test: `tests/test_raid_fs_safe_defaults.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_raid_fs_safe_defaults.py`:

```python
DETECT = REPO / "collection/roles/nvme_namespace/tasks/detect_storage_state.yml"


def _task_names(path: Path) -> list[str]:
    return [t.get("name", "") for t in (yaml.safe_load(path.read_text()) or [])]


def test_detection_sets_state_fact():
    text = DETECT.read_text()
    assert "xinas_storage_state" in text
    for state in ("MATCH", "EMPTY", "FOREIGN"):
        assert state in text, f"detection never yields {state}"
    # Detection must be read-only: no destructive verbs.
    for verb in ("delete-ns", "mkfs", "drive clean", "wipefs", "zero-superblock"):
        assert verb not in text, f"detection must not run {verb!r}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_detection_sets_state_fact -v`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create the detection task file**

Create `collection/roles/nvme_namespace/tasks/detect_storage_state.yml`:

```yaml
---
# Read-only storage-identity detection. Sets xinas_storage_state to one of:
#   MATCH   - xiRAID data+log arrays online AND /dev/xi_data is XFS with the wanted label
#   EMPTY   - no xiRAID arrays and no XFS/foreign signature on /dev/xi_data
#   FOREIGN - some xiRAID/fs signature exists but does not match the expected layout
#
# Idempotent and side-effect-free: safe to run before any decision, at either role.
# raid_fs reuses this via include_role (guarded on xinas_storage_state undefined).

- name: Determine the wanted XFS label
  ansible.builtin.set_fact:
    xfs_label_wanted: >-
      {{ (xfs_filesystems | default([{}]) | first).label | default('nfsdata') }}

- name: Probe existing xiRAID arrays (read-only)
  ansible.builtin.command: xicli raid show -f json
  register: _ssd_raid_show
  changed_when: false
  failed_when: false

- name: Parse xiRAID array names
  ansible.builtin.set_fact:
    _ssd_array_names: >-
      {%- set parsed = (_ssd_raid_show.stdout | default('') | from_json)
            if (_ssd_raid_show.rc | default(1)) == 0 and (_ssd_raid_show.stdout | default('') | length > 0)
            else {} -%}
      {%- if parsed is mapping -%}{{ parsed.keys() | list }}
      {%- elif parsed is iterable and parsed is not string -%}{{ parsed | map(attribute='name') | list }}
      {%- else -%}[]{%- endif -%}

- name: Probe filesystem type on /dev/xi_data (read-only)
  ansible.builtin.command: blkid -s TYPE -o value /dev/xi_data
  register: _ssd_fstype
  changed_when: false
  failed_when: false

- name: Probe filesystem label on /dev/xi_data (read-only)
  ansible.builtin.command: blkid -s LABEL -o value /dev/xi_data
  register: _ssd_fslabel
  changed_when: false
  failed_when: false

- name: Classify storage state
  ansible.builtin.set_fact:
    xinas_storage_state: >-
      {%- set arrays_present = ('data' in _ssd_array_names) and ('log' in _ssd_array_names) -%}
      {%- set fstype = _ssd_fstype.stdout | default('') | trim -%}
      {%- set fslabel = _ssd_fslabel.stdout | default('') | trim -%}
      {%- set fs_match = (fstype == 'xfs') and (fslabel == xfs_label_wanted) -%}
      {%- set any_signature = (_ssd_array_names | length > 0) or (fstype | length > 0) -%}
      {%- if arrays_present and fs_match -%}MATCH
      {%- elif not any_signature -%}EMPTY
      {%- else -%}FOREIGN{%- endif -%}

- name: Report storage state
  ansible.builtin.debug:
    msg: >-
      Storage state = {{ xinas_storage_state }}
      (arrays={{ _ssd_array_names }}, fstype='{{ _ssd_fstype.stdout | default('') | trim }}',
      label='{{ _ssd_fslabel.stdout | default('') | trim }}', wanted='{{ xfs_label_wanted }}')
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_detection_sets_state_fact -v`
Expected: PASS.

- [ ] **Step 5: Lint the new YAML**

Run: `ruff check tests/test_raid_fs_safe_defaults.py`
Expected: no errors. (YAML itself isn't linted by ruff; ensure `yaml.safe_load` in the
test succeeds — the test loading the file *is* the syntax check.)

- [ ] **Step 6: Commit**

```bash
git add collection/roles/nvme_namespace/tasks/detect_storage_state.yml \
        tests/test_raid_fs_safe_defaults.py
git commit -m "feat(nvme_namespace): read-only storage-state detection (MATCH/EMPTY/FOREIGN)"
```

---

## Task 3: Shared confirmation include

**Files:**
- Create: `collection/roles/nvme_namespace/tasks/storage_reset_confirm.yml`
- Test: `tests/test_raid_fs_safe_defaults.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_raid_fs_safe_defaults.py`:

```python
CONFIRM = REPO / "collection/roles/nvme_namespace/tasks/storage_reset_confirm.yml"


def test_confirm_is_fact_guarded_and_bypassable():
    text = CONFIRM.read_text()
    tasks = yaml.safe_load(text)
    # A pause exists and requires typing YES.
    assert any("pause" in t for t in tasks), "no confirmation pause task"
    assert "YES" in text
    # The gate is guarded by the reset flag and the confirmed fact, and bypassable.
    assert "xinas_storage_reset" in text
    assert "xinas_storage_reset_confirmed" in text
    assert "nvme_skip_cleanup_confirmation" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_confirm_is_fact_guarded_and_bypassable -v`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create the confirmation include**

Create `collection/roles/nvme_namespace/tasks/storage_reset_confirm.yml`:

```yaml
---
# Shared reset confirmation. Invoked by both nvme_namespace and raid_fs immediately
# before their first destructive step. Idempotent within a play: the first invocation
# prompts and sets xinas_storage_reset_confirmed; later invocations short-circuit.
#
# Fires only when xinas_storage_reset is set and not yet confirmed. Bypassed (auto-
# confirmed) when nvme_skip_cleanup_confirmation is true — the automation escape hatch.

- name: Auto-confirm reset for unattended runs
  ansible.builtin.set_fact:
    xinas_storage_reset_confirmed: true
  when:
    - xinas_storage_reset | default(false) | bool
    - nvme_skip_cleanup_confirmation | default(false) | bool
    - not (xinas_storage_reset_confirmed | default(false) | bool)

- name: Confirm destructive storage reset
  ansible.builtin.pause:
    prompt: |

      ╔══════════════════════════════════════════════════════════════════════╗
      ║  ⚠️  STORAGE RESET — DATA DESTRUCTION                                ║
      ╠══════════════════════════════════════════════════════════════════════╣
      ║  xinas_storage_reset is set. This will DESTROY the existing array and ║
      ║  reformat the filesystem. All data on it will be lost.                ║
      ║    • arrays : {{ (xiraid_arrays | default([]) | map(attribute='name') | list) | join(', ') }}
      ║    • label  : {{ (xfs_filesystems | default([{}]) | first).label | default('nfsdata') }}
      ║    • mount  : {{ (xfs_filesystems | default([{}]) | first).mountpoint | default('/mnt/data') }}
      ╠══════════════════════════════════════════════════════════════════════╣
      ║  Type 'YES' to proceed, or press Ctrl+C to abort.                     ║
      ╚══════════════════════════════════════════════════════════════════════╝

      Confirm destruction (YES/no)
  register: _reset_confirmation
  when:
    - xinas_storage_reset | default(false) | bool
    - not (xinas_storage_reset_confirmed | default(false) | bool)

- name: Abort unless the operator typed YES
  ansible.builtin.fail:
    msg: "Storage reset cancelled by operator. Aborting to protect existing data."
  when:
    - xinas_storage_reset | default(false) | bool
    - not (xinas_storage_reset_confirmed | default(false) | bool)
    - (_reset_confirmation.user_input | default('') | upper) != 'YES'

- name: Mark reset as confirmed for the rest of the play
  ansible.builtin.set_fact:
    xinas_storage_reset_confirmed: true
  when:
    - xinas_storage_reset | default(false) | bool
    - not (xinas_storage_reset_confirmed | default(false) | bool)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_confirm_is_fact_guarded_and_bypassable -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add collection/roles/nvme_namespace/tasks/storage_reset_confirm.yml \
        tests/test_raid_fs_safe_defaults.py
git commit -m "feat(nvme_namespace): shared fact-guarded storage-reset confirmation"
```

---

## Task 4: Wire nvme_namespace — detection, state-driven rebuild, gated cleanup, confirm

**Files:**
- Modify: `collection/roles/nvme_namespace/tasks/main.yml` (the `nvme` mode block:
  cleanup include ~line 94; use-existing branch ~line 119-137)
- Test: `tests/test_raid_fs_safe_defaults.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_raid_fs_safe_defaults.py`:

```python
NVME_MAIN = REPO / "collection/roles/nvme_namespace/tasks/main.yml"


def _iter(tasks):
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        yield t
        if isinstance(t.get("block"), list):
            yield from _iter(t["block"])


def _find_include(tasks, tasks_file):
    for t in _iter(tasks):
        inc = t.get("ansible.builtin.include_tasks") or t.get("include_tasks")
        if inc == tasks_file or (isinstance(inc, dict) and inc.get("file") == tasks_file):
            return t
    return None


def _all_includes(tasks, tasks_file):
    out = []
    for t in _iter(tasks):
        inc = t.get("ansible.builtin.include_tasks") or t.get("include_tasks")
        if inc == tasks_file or (isinstance(inc, dict) and inc.get("file") == tasks_file):
            out.append(t)
    return out


def test_nvme_detects_state_and_gates_rebuild():
    tasks = yaml.safe_load(NVME_MAIN.read_text())
    # Detection runs.
    assert _find_include(tasks, "detect_storage_state.yml") is not None
    # A FOREIGN fail-fast task exists (guards before any wipe).
    assert any(
        "FOREIGN" in str(t.get("name", "")) or "FOREIGN" in str(t.get("fail", ""))
        for t in _iter(tasks)
    ), "no FOREIGN fail-fast task"
    # Rebuild is gated by state EMPTY or reset, not a bare use-existing boolean.
    reb = _find_include(tasks, "rebuild_namespaces.yml")
    assert reb is not None
    when = " ".join(str(w) for w in (reb.get("when") or []))
    assert "xinas_storage_state" in when and "xinas_storage_reset" in when
    # EVERY cleanup_storage include is gated on reset-or-EMPTY (never a bare != MATCH).
    cleanups = _all_includes(tasks, "cleanup_storage.yml")
    assert cleanups, "no cleanup_storage include found"
    for cl in cleanups:
        clwhen = " ".join(str(w) for w in (cl.get("when") or []))
        assert "xinas_storage_reset" in clwhen and "EMPTY" in clwhen, clwhen
        assert "!= 'MATCH'" not in clwhen and "!= \"MATCH\"" not in clwhen
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_nvme_detects_state_and_gates_rebuild -v`
Expected: FAIL — no detection include; rebuild still gated on `nvme_use_existing_namespaces`.

- [ ] **Step 3: Hoist detection + FOREIGN fail-fast + confirm above BOTH mode blocks**

Detection must run for the `nvme` and `all` modes, and the FOREIGN fail-fast must
precede `cleanup_storage`. In `collection/roles/nvme_namespace/tasks/main.yml`, after
the `Check if automatic namespace management is enabled` debug task and **before** the
`all`-mode block, insert:

```yaml
- name: Storage-state preflight (both modes)
  when: nvme_auto_namespace | bool
  block:
    - name: Detect current storage state
      ansible.builtin.include_tasks: detect_storage_state.yml

    # FOREIGN + no reset never wipes anything — it stops before cleanup_storage.
    - name: Fail fast on unexpected existing storage (FOREIGN)
      ansible.builtin.fail:
        msg: >-
          Existing storage does not match the expected xiNAS layout (state=FOREIGN).
          Refusing to touch it. Set xinas_storage_reset=true to wipe and rebuild, or
          clean the drives manually.
      when:
        - (xinas_storage_state | default('EMPTY')) == 'FOREIGN'
        - not (xinas_storage_reset | default(false) | bool)

    - name: Confirm reset before any destructive operation
      ansible.builtin.include_tasks: storage_reset_confirm.yml
      when: xinas_storage_reset | default(false) | bool
```

- [ ] **Step 4: Gate BOTH cleanup includes on `reset or EMPTY`**

There are two `Cleanup existing storage configurations` includes (one in the `all`
block ≈line 49, one in the `nvme` block ≈line 94). Give **each** this `when:` (keeping
its existing conditions):

```yaml
      when:
        - nvme_data_drives | length > 0
        - nvme_cleanup_existing_storage | default(true) | bool
        - (xinas_storage_reset | default(false) | bool)
          or (xinas_storage_state | default('EMPTY')) == 'EMPTY'
```

> Gate is `reset or EMPTY`, **not** `!= MATCH`: `!= MATCH` would also match FOREIGN and
> wipe it. FOREIGN already bailed in Step 3; this gate keeps the op inert even if
> reached out of order.

- [ ] **Step 5: Replace the use-existing / rebuild branch (nvme mode) with state logic**

Replace the three tasks at ≈line 119-137 (`Use existing namespaces (skip rebuild)`,
`Collect NVMe topology for namespace rebuild`, `Rebuild namespaces on data drives`) with:

```yaml
    # MATCH + no reset → converge: reuse the namespaces already on the drives.
    - name: Use existing namespaces (converge)
      ansible.builtin.include_tasks: detect_existing_namespaces.yml
      when:
        - nvme_data_drives | length > 0
        - (xinas_storage_state | default('EMPTY')) == 'MATCH'
        - not (xinas_storage_reset | default(false) | bool)

    # EMPTY (fresh) or explicit reset → rebuild namespaces from scratch.
    - name: Collect NVMe topology for namespace rebuild
      ansible.builtin.include_tasks: collect_topology.yml
      when:
        - nvme_data_drives | length > 0
        - (xinas_storage_reset | default(false) | bool)
          or (xinas_storage_state | default('EMPTY')) == 'EMPTY'

    - name: Rebuild namespaces on data drives
      ansible.builtin.include_tasks: rebuild_namespaces.yml
      when:
        - nvme_data_drives | length > 0
        - (xinas_storage_reset | default(false) | bool)
          or (xinas_storage_state | default('EMPTY')) == 'EMPTY'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_nvme_detects_state_and_gates_rebuild -v`
Expected: PASS.

- [ ] **Step 7: Sanity-check the whole file still parses**

Run: `python -c "import yaml; yaml.safe_load(open('collection/roles/nvme_namespace/tasks/main.yml'))"`
Expected: no exception.

- [ ] **Step 8: Commit**

```bash
git add collection/roles/nvme_namespace/tasks/main.yml tests/test_raid_fs_safe_defaults.py
git commit -m "feat(nvme_namespace): gate namespace rebuild + cleanup on storage state"
```

---

## Task 5: Wire raid_fs — detection reuse, gated drive-clean + MD sweep, confirm

**Files:**
- Modify: `collection/roles/raid_fs/tasks/main.yml` (drive clean ≈50-56; MD sweep
  ≈117-153)
- Test: `tests/test_raid_fs_safe_defaults.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_raid_fs_safe_defaults.py`:

```python
RAID_MAIN = REPO / "collection/roles/raid_fs/tasks/main.yml"


def _find_by_name(path: Path, name: str):
    for t in _iter(yaml.safe_load(path.read_text())):
        if t.get("name") == name:
            return t
    return None


def test_raid_fs_reuses_state_and_gates_wipes():
    text = RAID_MAIN.read_text()
    # Detection is reused via include_role guarded on the fact being undefined.
    assert "detect_storage_state" in text
    assert "xinas_storage_state is not defined" in text
    # Confirm include is present and raid_fs fails on required-but-unconfirmed reset.
    assert "storage_reset_confirm" in text
    assert "xinas_storage_reset_confirmed" in text
    # drive clean is gated off MATCH.
    dc = _find_by_name(RAID_MAIN, "Clean xiRAID drives")
    assert dc is not None
    assert "xinas_storage_state" in " ".join(str(w) for w in (dc.get("when") or []))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_raid_fs_reuses_state_and_gates_wipes -v`
Expected: FAIL.

- [ ] **Step 3: Add detection reuse + confirm + unconfirmed-guard after the two validation tasks**

In `collection/roles/raid_fs/tasks/main.yml`, immediately after the
`Check if xfs_filesystems is defined` task (≈line 28), insert:

```yaml
- name: Detect current storage state (reuse nvme_namespace's fact if already set)
  ansible.builtin.include_role:
    name: nvme_namespace
    tasks_from: detect_storage_state
    apply:
      tags: [raid_fs, raid, fs]
  when: xinas_storage_state is not defined
  tags: [raid_fs, raid, fs]

- name: Confirm reset before any destructive raid_fs operation
  ansible.builtin.include_role:
    name: nvme_namespace
    tasks_from: storage_reset_confirm
    apply:
      tags: [raid_fs, raid, fs]
  when: xinas_storage_reset | default(false) | bool
  tags: [raid_fs, raid, fs]

- name: Refuse to wipe without confirmation
  ansible.builtin.fail:
    msg: >-
      xinas_storage_reset is set but the reset was not confirmed. Refusing to run any
      destructive step. Run interactively to confirm, or set
      nvme_skip_cleanup_confirmation=true for unattended resets.
  when:
    - xinas_storage_reset | default(false) | bool
    - not (xinas_storage_reset_confirmed | default(false) | bool)
  tags: [raid_fs, raid, fs]

- name: Fail fast on unexpected existing storage (FOREIGN, raid_fs layer)
  ansible.builtin.fail:
    msg: >-
      Existing storage does not match the expected xiNAS layout (state=FOREIGN).
      Refusing to run drive-clean / mkfs. Set xinas_storage_reset=true to wipe and
      rebuild, or clean the drives manually.
  when:
    - (xinas_storage_state | default('EMPTY')) == 'FOREIGN'
    - not (xinas_storage_reset | default(false) | bool)
  tags: [raid_fs, raid, fs]
```

- [ ] **Step 4: Gate `drive clean` on `reset or EMPTY`**

Change the `Clean xiRAID drives` task's loop to run only on a fresh box or reset (the
task currently has no `when:`). Use `reset or EMPTY`, **not** `!= MATCH` — the latter
would also run on FOREIGN:

```yaml
- name: Clean xiRAID drives
  ansible.builtin.command: "xicli drive clean -d {{ item }}"
  loop: "{{ xiraid_device_paths }}"
  register: drive_clean_result
  changed_when: false
  failed_when: false
  when: >-
    (xinas_storage_reset | default(false) | bool)
    or (xinas_storage_state | default('EMPTY')) == 'EMPTY'
  tags: [raid_fs, raid, cleanup]
```

Then guard the follow-on warn task so it survives a skipped clean (on MATCH
`drive_clean_result` has no `.results`). Change its `loop:` to:

```yaml
  loop: "{{ drive_clean_result.results | default([]) }}"
```

- [ ] **Step 5: Gate the MD sweep on `reset or EMPTY`**

Add the same `when:` to the two MD-sweep tasks (`Find active MD RAID arrays` and `Stop
leftover MD RAID arrays on xiRAID devices`, ≈117-153):

```yaml
  when: >-
    (xinas_storage_reset | default(false) | bool)
    or (xinas_storage_state | default('EMPTY')) == 'EMPTY'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_raid_fs_reuses_state_and_gates_wipes -v`
Expected: PASS.

- [ ] **Step 7: Sanity-check parse**

Run: `python -c "import yaml; yaml.safe_load(open('collection/roles/raid_fs/tasks/main.yml'))"`
Expected: no exception.

- [ ] **Step 8: Commit**

```bash
git add collection/roles/raid_fs/tasks/main.yml tests/test_raid_fs_safe_defaults.py
git commit -m "feat(raid_fs): reuse storage state, gate drive-clean + MD sweep, enforce confirm"
```

---

## Task 6: Rewrite the mkfs decision (converge / fail-fast / reset)

**Files:**
- Modify: `collection/roles/raid_fs/tasks/create_fs.yml` (the six mkfs-gate `when:`
  clauses at lines 48, 58, 68, 75, 83, 91)
- Test: `tests/test_raid_fs_safe_defaults.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_raid_fs_safe_defaults.py`:

```python
CREATE_FS = REPO / "collection/roles/raid_fs/tasks/create_fs.yml"


def test_mkfs_is_converge_or_reset_and_foreign_fails():
    text = CREATE_FS.read_text()
    # A single computed _do_mkfs fact drives the gate; the old always-true
    # xfs_force_mkfs-or-label-mismatch expression is gone.
    assert "_do_mkfs" in text
    assert "blkid_label.stdout != item.label" not in text, (
        "label-mismatch must fail-fast, not trigger mkfs"
    )
    # FOREIGN fail-fast task exists.
    assert "FOREIGN" in text
    mkfs = _find_by_name(CREATE_FS, "Make XFS filesystem on {{ item.data_device }}")
    assert mkfs is not None
    assert "_do_mkfs" in " ".join(str(w) for w in (mkfs.get("when") or []))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_mkfs_is_converge_or_reset_and_foreign_fails -v`
Expected: FAIL.

- [ ] **Step 3: Compute `_do_mkfs` once and add FOREIGN fail-fast**

In `collection/roles/raid_fs/tasks/create_fs.yml`, after the two `blkid` probe tasks
(lines 1-11), insert:

```yaml
# Storage-reset-safe mkfs decision (finding C1). mkfs happens only when:
#   - xinas_storage_reset is set (after the confirm gate), OR
#   - the data device has no XFS at all (fresh install; nothing to lose).
# An XFS whose label matches → converge (skip). An XFS with a different label, or a
# non-xfs signature → FOREIGN → fail-fast (never silently reformat).
- name: Classify this filesystem's state
  ansible.builtin.set_fact:
    _fs_present: "{{ blkid_type.stdout == 'xfs' }}"
    _fs_label_match: "{{ blkid_type.stdout == 'xfs' and blkid_label.stdout == item.label }}"
    _fs_foreign: >-
      {{ (blkid_type.stdout | length > 0) and
         not (blkid_type.stdout == 'xfs' and blkid_label.stdout == item.label) }}

- name: Fail fast on unexpected filesystem (FOREIGN)
  ansible.builtin.fail:
    msg: >-
      Existing filesystem '{{ blkid_label.stdout }}' ({{ blkid_type.stdout }}) on
      {{ item.data_device }} does not match the expected label '{{ item.label }}'
      (state=FOREIGN). Set xinas_storage_reset=true to wipe and rebuild, or clean the
      device manually. Refusing to reformat.
  when:
    - _fs_foreign | bool
    - not (xinas_storage_reset | default(false) | bool)
  tags: [raid_fs, fs, mkfs]

- name: Decide whether to (re)create the filesystem
  ansible.builtin.set_fact:
    _do_mkfs: >-
      {{ (xinas_storage_reset | default(false) | bool) or (not (_fs_present | bool)) }}
  tags: [raid_fs, fs, mkfs]
```

- [ ] **Step 4: Replace every mkfs-gate `when:` with `_do_mkfs`**

In the same file, replace each of the six occurrences of:

```yaml
    - (xfs_force_mkfs | default(false) | bool) or blkid_type.stdout != 'xfs' or blkid_label.stdout != item.label
```

and

```yaml
  when: (xfs_force_mkfs | default(false) | bool) or blkid_type.stdout != 'xfs' or blkid_label.stdout != item.label
```

with, respectively:

```yaml
    - _do_mkfs | bool
```

and

```yaml
  when: _do_mkfs | bool
```

(Lines 48, 58, 68 are list items → use the first form; lines 75, 83, 91 are standalone
`when:` → use the second form. The NFS stop/unmount tasks that gated on the old
expression now correctly release the device only when a reformat will actually happen.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_raid_fs_safe_defaults.py::test_mkfs_is_converge_or_reset_and_foreign_fails -v`
Expected: PASS.

- [ ] **Step 6: Sanity-check parse + full test module**

Run: `python -c "import yaml; yaml.safe_load(open('collection/roles/raid_fs/tasks/create_fs.yml'))"`
Then: `pytest tests/test_raid_fs_safe_defaults.py -v`
Expected: no parse exception; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add collection/roles/raid_fs/tasks/create_fs.yml tests/test_raid_fs_safe_defaults.py
git commit -m "fix(raid_fs): converge/fail-fast mkfs decision, drop label-mismatch reformat (C1)"
```

---

## Task 7: Documentation sync (spec-first debt)

**Files:**
- Modify: `docs/Installer/raid-spec.md` (§4.2/§4.3, §7.6, §9)
- Modify: `CLAUDE.md` (the "Roles are idempotent" note)
- Modify: `collection/roles/raid_fs/README.md`, `collection/roles/nvme_namespace/README.md`

- [ ] **Step 1: Update `docs/Installer/raid-spec.md`**

- In **§4.2/§4.3**: replace "Default (`nvme_use_existing_namespaces=false`) falls through
  to §4.3" with the state-driven rule: reuse when `xinas_storage_state == MATCH` and no
  reset; rebuild when EMPTY or reset; FOREIGN without reset fails fast. Note the knob is
  deprecated.
- In **§7.6 step 2 ("Decide")**: replace the always-true gate description with:
  > mkfs runs when `xinas_storage_reset` is set (after the confirm gate) **or** the data
  > device has no XFS (EMPTY). An XFS with the configured label → converge (skip). An XFS
  > with a different label / a non-xfs signature → **FOREIGN → the play fails** rather
  > than reformatting.
- In **§9 table**: change the "Re-run with NFS already serving `/mnt/data`" row from
  "snapshots nfs-server state, stops it, reformats, restarts" to "**converges — mkfs is
  skipped, data preserved, NFS untouched**"; add a row: "Existing storage doesn't match
  expected layout | silent reformat | **FOREIGN fail-fast; requires `xinas_storage_reset`**".
- Add a short section **"Idempotency & the storage-reset contract"** summarizing the
  state machine, the single `xinas_storage_reset` knob, and the both-roles confirm gate.

- [ ] **Step 2: Fix the inverted claim in `CLAUDE.md`**

Find the Important Notes bullet:

```
- **Roles are idempotent** - Safe to re-run, except `xfs_force_mkfs: true` forces filesystem recreation
```

Replace with:

```
- **Roles are idempotent by default** - Re-running `site.yml` over a healthy array
  converges (no reformat, no namespace rebuild). Destroying and rebuilding storage
  requires the explicit `xinas_storage_reset: true` (with an interactive `YES`, or
  `nvme_skip_cleanup_confirmation: true` for automation). The legacy `xfs_force_mkfs` /
  `nvme_use_existing_namespaces` knobs are disarmed and no longer trigger wipes on their
  own. See `docs/Installer/raid-spec.md`.
```

- [ ] **Step 3: Update both role READMEs**

Add a "Storage reset safety" subsection to `collection/roles/raid_fs/README.md` and
`collection/roles/nvme_namespace/README.md` documenting `xinas_storage_reset` (default
false → converge), the MATCH/EMPTY/FOREIGN states, and the confirmation behavior. Note
that `xfs_force_mkfs` / `nvme_use_existing_namespaces` are deprecated no-op-for-destruction.

- [ ] **Step 4: Commit**

```bash
git add docs/Installer/raid-spec.md CLAUDE.md \
        collection/roles/raid_fs/README.md collection/roles/nvme_namespace/README.md
git commit -m "docs(raid_fs): sync raid-spec, CLAUDE.md, READMEs to storage-reset contract"
```

---

## Task 8: Full structural suite + lint gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pytest -q`
Expected: all tests pass, including the existing
`tests/test_nvme_namespace_fallback.py` and `tests/test_preset_playbooks.py` (confirm
the changes didn't break the fallback or preset guards).

- [ ] **Step 2: Lint**

Run: `ruff check` then `ruff format --check`
Expected: clean.

- [ ] **Step 3: Parse every touched YAML**

Run:
```bash
for f in collection/roles/nvme_namespace/tasks/main.yml \
         collection/roles/nvme_namespace/tasks/detect_storage_state.yml \
         collection/roles/nvme_namespace/tasks/storage_reset_confirm.yml \
         collection/roles/raid_fs/tasks/main.yml \
         collection/roles/raid_fs/tasks/create_fs.yml \
         presets/default/raid_fs.yml presets/xinnorVM/raid_fs.yml; do
  python -c "import yaml,sys; yaml.safe_load(open('$f')); print('ok $f')"
done
```
Expected: `ok` for every file.

- [ ] **Step 4: Commit (only if any fixup was needed)**

```bash
git add -A
git commit -m "chore(raid_fs): lint + parse fixups for storage-reset safety"
```

---

## Task 9: Manual behavioral verification (hardware/VM, once)

**Files:** none (record results in the PR description)

No molecule harness exists, so validate the state machine on a real target. For each
scenario, confirm the expected outcome from the design's matrix (§5 / §10).

- [ ] **Fresh box** (`xinnorVM` or NVMe): `ansible-playbook playbooks/site.yml` →
  arrays + XFS created, mounted, exported.
- [ ] **Fresh factory drive with a single full-size `n1`** → detection = EMPTY →
  namespaces rebuilt (`n1`+`n2`), arrays + XFS created (P0 regression: must NOT get
  stuck treating `n1` as log).
- [ ] **Re-run over the healthy array**: write a sentinel file, record its checksum,
  re-run `site.yml`, confirm the checksum is unchanged, NFS never dropped, and both the
  `cleanup_storage` wipe and MD sweep were skipped (grep the play recap / `-v` output).
- [ ] **`ansible-playbook playbooks/site.yml --tags raid_fs -e xinas_storage_reset=true`**
  (no `nvme_namespace`) → the confirmation prompt still appears (or aborts unattended).
  Gate is not bypassed.
- [ ] **`-e xinas_storage_reset=true`** interactive → banner + `YES` required, then wipe
  + rebuild succeeds.
- [ ] **`-e xinas_storage_reset=true -e nvme_skip_cleanup_confirmation=true`** →
  unattended wipe + rebuild, no prompt.
- [ ] **Re-run after relabeling the XFS** (simulate FOREIGN) → play fails fast with the
  §5.1 message, no reformat.

- [ ] **Finalize:** open the PR. Body must state that no `Requires-Rebuild` trailer is
  added (design §7) and summarize the verification results above.
