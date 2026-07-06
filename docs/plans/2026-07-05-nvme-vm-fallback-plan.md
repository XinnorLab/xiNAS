# NVMe VM-Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commits:** This repo's owner requires **explicit approval before any commit**. Treat every `git commit` step below as "stage the change and request approval," not "commit automatically."

**Goal:** Stop the mid-pipeline abort when an unattended default-preset install runs on a KVM/virtio VM, by making the `nvme_namespace` role VM-aware when NVMe detection finds zero data drives.

**Architecture:** Add one fallback block to `collection/roles/nvme_namespace/tasks/main.yml` that fires only when `nvme` detection returns no data drives. It re-probes all block devices; on a VM it auto-continues in whole-disk mode (forcing a RAID1 log to match `xinnorVM`); on bare metal or with no disks it fails with an actionable message. No preset, `autoinstall.sh`, or menu changes.

**Tech Stack:** Ansible (role task YAML), pytest (structural YAML assertions, matching `tests/test_preset_playbooks.py`), ansible-lint (basic profile) + yamllint gates.

**Design doc:** [docs/plans/2026-07-05-nvme-vm-fallback-design.md](2026-07-05-nvme-vm-fallback-design.md)
**Owning spec:** [docs/Installer/raid-spec.md](../Installer/raid-spec.md)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| [collection/roles/nvme_namespace/tasks/main.yml](../../collection/roles/nvme_namespace/tasks/main.yml) | Phase orchestrator for drive detection | **Modify** — append the fallback block after the `nvme`-mode block (currently ends at line 169) |
| [docs/Installer/raid-spec.md](../Installer/raid-spec.md) | Durable install-storage contract | **Modify** — new §1 subsection + §9 failure-mode row |
| `tests/test_nvme_namespace_fallback.py` | Structural regression guard for the fallback | **Create** |

The fallback reuses existing, unchanged includes: `detect_all_drives.yml` (re-probe + system/data split), `cleanup_storage.yml`, and `generate_raid_config.yml` (which already fails clearly on insufficient devices).

---

## Task 1: Update the spec (spec-first)

**Files:**
- Modify: `docs/Installer/raid-spec.md` (§1, §9)

- [ ] **Step 1: Add the empty-NVMe fallback subsection to §1**

In `docs/Installer/raid-spec.md`, immediately after the §1 table (the `| Mode | Used by preset | ... |` table, before the `If nvme_auto_namespace: false` line), insert:

```markdown
### 1.1 Empty-NVMe fallback (VM safety net)

`nvme` mode assumes real NVMe controllers exist. On a virtio/SCSI VM there are
none, so `nvme_data_drives` comes back empty. Rather than silently skip RAID
generation (which made `raid_fs` abort several roles later with an undefined
`xiraid_arrays`), the role runs a fallback whenever **`nvme_detect_mode == 'nvme'`
and zero data drives were found**:

1. Re-probe every block device via `detect_all_drives.yml` (§5).
2. **No non-OS disks at all** → fail: *"No data drives found … Attach data disks."*
3. **`systemd-detect-virt` reports a VM** (output not `none`/empty) → auto-continue
   in whole-disk mode: force `nvme_raid_log_level: 1` (RAID1 log, matching the
   `xinnorVM` geometry), run cleanup (§3) and `generate_raid_config.yml` (§6). A
   warning is logged that VM detection was auto-selected and that **all** non-OS
   disks will be consumed.
4. **Bare metal with non-NVMe disks present** → fail-fast: *"Detected N non-NVMe
   disk(s) … not virtualized. Re-run with the `xinnorVM` preset or set
   `nvme_detect_mode: all` …"* — the role will not silently RAID over SATA disks
   the operator didn't mean to consume.

Effective minimum for the VM auto-path is **5 non-OS disks** (2 log + 3 data for
RAID5); fewer disks fail with the clear "insufficient devices" message from §6,
identical to how the `xinnorVM` preset fails today. The fallback changes only the
`default`-preset path; `autoinstall.sh`, the presets, and the menus are untouched.
```

- [ ] **Step 2: Add a §9 failure-mode row**

In the §9 table ("Failure modes the install guards against"), add a row after the "OS drive detected as a data drive" row:

```markdown
| Unattended default-preset install on a virtio/SCSI VM (0 NVMe controllers) | `nvme_namespace` generated no facts → `raid_fs` aborted with "xiraid_arrays undefined" | Empty-NVMe fallback (§1.1): re-probe all disks; auto-continue in whole-disk mode on VMs, fail-fast with a remedy on bare metal |
```

- [ ] **Step 3: Stage + request commit approval**

```bash
git add docs/Installer/raid-spec.md
# Request approval before: git commit -m "docs(raid-spec): document empty-NVMe VM fallback"
```

---

## Task 2: Write the failing structural test

**Files:**
- Create: `tests/test_nvme_namespace_fallback.py`

- [ ] **Step 1: Write the test file**

```python
"""Regression guard for the empty-NVMe VM fallback.

When `nvme` detection finds zero data drives on a VM, the role must NOT fall
through to a silent skip (which made `raid_fs` abort with an undefined
`xiraid_arrays`). It must re-probe all disks and either auto-continue in
whole-disk mode (VMs) or fail with an actionable message.

These are structural assertions over the parsed task YAML — the repo has no
molecule/behavioral Ansible harness (see CLAUDE.md), so we pin the contract the
same way tests/test_preset_playbooks.py pins preset structure.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
MAIN = REPO / "collection/roles/nvme_namespace/tasks/main.yml"
FALLBACK_NAME = "Fallback when NVMe detection found no data drives"


def _load_tasks() -> list:
    return yaml.safe_load(MAIN.read_text())


def _iter_tasks(tasks):
    """Yield every task dict, recursing into `block:` lists."""
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        yield t
        if isinstance(t.get("block"), list):
            yield from _iter_tasks(t["block"])


def _find_by_name(tasks, name):
    for t in _iter_tasks(tasks):
        if t.get("name") == name:
            return t
    return None


def _fallback_tasks():
    fb = _find_by_name(_load_tasks(), FALLBACK_NAME)
    assert fb is not None, f"missing fallback block named {FALLBACK_NAME!r}"
    return list(_iter_tasks(fb["block"]))


def test_fallback_block_exists_and_is_guarded():
    fb = _find_by_name(_load_tasks(), FALLBACK_NAME)
    assert fb is not None, "fallback block missing from main.yml"
    assert isinstance(fb.get("block"), list) and fb["block"], "fallback has no body"
    when = fb.get("when")
    assert isinstance(when, list), "fallback must be guarded by a when: list"
    joined = " ".join(str(w) for w in when)
    assert "nvme_detect_mode" in joined and "'nvme'" in joined, joined
    assert "nvme_data_drives" in joined and "== 0" in joined, joined


def test_fallback_reprobes_and_generates_config():
    includes = [
        t.get("ansible.builtin.include_tasks") for t in _fallback_tasks()
    ]
    assert "detect_all_drives.yml" in includes, "fallback must re-probe all disks"
    assert "generate_raid_config.yml" in includes, "fallback must build RAID config"


def test_fallback_detects_virtualization():
    cmds = [t.get("ansible.builtin.command") for t in _fallback_tasks()]
    assert any(c == "systemd-detect-virt" for c in cmds), "fallback must detect virt"


def test_fallback_forces_raid1_log():
    setfacts = [
        t.get("ansible.builtin.set_fact")
        for t in _fallback_tasks()
        if t.get("ansible.builtin.set_fact")
    ]
    assert any(
        str(sf.get("nvme_raid_log_level")) == "1" for sf in setfacts
    ), "VM fallback must force nvme_raid_log_level: 1"


def test_fallback_messages_are_actionable():
    fails = [
        t.get("ansible.builtin.fail")
        for t in _fallback_tasks()
        if t.get("ansible.builtin.fail")
    ]
    msgs = " ".join(f.get("msg", "") for f in fails)
    assert "xinnorVM" in msgs, "bare-metal failure must name the xinnorVM remedy"
    assert "Attach data disks" in msgs, "no-disks failure message missing"


def test_default_preset_left_unchanged():
    # The fix lives in the role, NOT the preset — guard that decision.
    assert not (REPO / "presets/default/nvme_namespace.yml").exists()
    rf = yaml.safe_load((REPO / "presets/default/raid_fs.yml").read_text())
    assert rf["nvme_raid_log_level"] == 10
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS
pytest tests/test_nvme_namespace_fallback.py -v
```

Expected: the four `test_fallback_*` tests **FAIL** with `AssertionError: missing fallback block named 'Fallback when NVMe detection found no data drives'`. `test_default_preset_left_unchanged` should already PASS.

- [ ] **Step 3: Stage + request commit approval**

```bash
git add tests/test_nvme_namespace_fallback.py
# Request approval before: git commit -m "test(nvme_namespace): pin empty-NVMe VM fallback contract"
```

---

## Task 3: Implement the fallback block

**Files:**
- Modify: `collection/roles/nvme_namespace/tasks/main.yml` (append after line 169)

- [ ] **Step 1: Append the fallback block**

Add the following at the end of `collection/roles/nvme_namespace/tasks/main.yml`, after the `Display final summary` task (line 169) that closes the `nvme`-mode block. Keep it at the same top indentation level as the two existing `- name: Run …` blocks (a sibling play task):

```yaml

# ═══════════════════════════════════════════════════════════════════════════════
# Fallback: "nvme" mode found no data drives.
# Either a VM (virtio/SCSI, no NVMe controllers) or a misconfigured bare-metal
# host. Re-probe all block devices, then auto-continue in whole-disk mode on a
# VM or fail with an actionable message.
# ═══════════════════════════════════════════════════════════════════════════════

- name: Fallback when NVMe detection found no data drives
  when:
    - nvme_auto_namespace | bool
    - nvme_detect_mode | default('nvme') == 'nvme'
    - nvme_data_drives | default([]) | length == 0
  block:
    - name: Re-probe all block devices for non-NVMe candidates
      ansible.builtin.include_tasks: detect_all_drives.yml

    - name: Abort if system drive not found (fallback)
      ansible.builtin.fail:
        msg: |
          CRITICAL: Could not detect system drive during VM fallback.
          Aborting to prevent accidental data loss on the OS drive.
          If this is intentional, set nvme_abort_if_no_system_drive: false
      when:
        - nvme_abort_if_no_system_drive | bool
        - nvme_system_drives is not defined or nvme_system_drives | length == 0

    - name: Fail when no data drives exist at all
      ansible.builtin.fail:
        msg: |
          No data drives found (no NVMe namespaces and no non-OS block devices).
          Attach data disks before deploying.
      when: nvme_data_drives | default([]) | length == 0

    - name: Detect virtualization
      ansible.builtin.command: systemd-detect-virt
      register: nvme_virt_check
      changed_when: false
      failed_when: false

    - name: Fail-fast on bare metal with non-NVMe disks present
      ansible.builtin.fail:
        msg: |
          Detected {{ nvme_data_drives | length }} non-NVMe disk(s)
          ({{ nvme_data_drives | join(', ') }}) but 0 NVMe data drives, and this
          host is not virtualized.

          If these are your intended data drives, re-run with the xinnorVM preset
          or set nvme_detect_mode: all.
          If you expected NVMe drives, verify the NVMe controllers are present and
          not held by the OS.
      when: (nvme_virt_check.stdout | default('') | trim) in ['', 'none']

    - name: Auto-continue in whole-disk mode (VM detected)
      when: (nvme_virt_check.stdout | default('') | trim) not in ['', 'none']
      block:
        - name: Announce VM auto-fallback
          ansible.builtin.debug:
            msg: |
              WARNING: No NVMe data drives found, but virtualization was detected
              ({{ nvme_virt_check.stdout | trim }}). Auto-selecting whole-disk (VM)
              detection — all {{ nvme_data_drives | length }} non-OS block
              device(s) will be consumed for RAID, exactly as the xinnorVM preset
              would. Re-run with an explicit preset to override.

        - name: Force RAID1 log level for the VM fallback
          ansible.builtin.set_fact:
            nvme_raid_log_level: 1

        - name: Cleanup existing storage configurations (fallback)
          ansible.builtin.include_tasks: cleanup_storage.yml
          when:
            - nvme_data_drives | length > 0
            - nvme_cleanup_existing_storage | default(true) | bool

        - name: Generate RAID configuration (fallback)
          ansible.builtin.include_tasks: generate_raid_config.yml
          when: nvme_data_drives | length > 0
```

Note: `generate_raid_config.yml` is intentionally gated only on `nvme_data_drives | length > 0` (not on `nvme_large_ns_devices | length > 0` like the other call sites). This guarantees that a too-small VM (2–4 disks) reaches `generate_raid_config.yml`'s own "insufficient devices" `fail` and gets a clear message, instead of falling through to the cryptic `raid_fs` abort.

- [ ] **Step 2: Run the structural tests to verify they pass**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS
pytest tests/test_nvme_namespace_fallback.py -v
```

Expected: all tests **PASS**.

- [ ] **Step 3: Lint the role (must match CI)**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS
ansible-lint collection/roles/nvme_namespace/
yamllint -c .yamllint.yml collection/roles/nvme_namespace/tasks/main.yml
```

Expected: ansible-lint reports **0 failures** (basic profile); yamllint reports no errors (line-length is a warning-only rule at 200). If `ansible-lint` is missing, install with `pip install ansible-lint && ansible-galaxy collection install community.general ansible.posix`.

- [ ] **Step 4: Stage + request commit approval**

```bash
git add collection/roles/nvme_namespace/tasks/main.yml
# Request approval before: git commit -m "fix(nvme_namespace): VM-aware fallback when NVMe detection finds no data drives"
```

Note: **no `Requires-Rebuild:` trailer.** `nvme_namespace` is fresh-install-only; re-running it on a live host rebuilds namespaces/arrays destructively, so the update flow must never auto-run it.

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole Python suite + linters (CI parity)**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS
pytest -q
ansible-lint collection/roles/
yamllint -c .yamllint.yml .
```

Expected: pytest all-pass (existing suite + the new file); ansible-lint 0 failures; yamllint clean.

- [ ] **Step 2: Ansible syntax sanity on the full site playbook**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS
ansible-playbook playbooks/site.yml --syntax-check
```

Expected: `playbook: playbooks/site.yml` with no parse/module errors. (Requires the `community.general` + `ansible.posix` collections; skip if not installed locally — CI's `ansible-lint` job is the authoritative gate.)

- [ ] **Step 3: Manual VM acceptance (documented, not automated)**

The repo has no molecule harness, so true behavioral validation is a manual run. On a KVM/virtio VM with ≥5 non-OS virtio disks and no license concerns:

```bash
# From a clean VM, unattended default-preset path:
sudo XINAS_PRESET=default ./autoinstall.sh    # (or the equivalent unattended entrypoint)
# Expect: nvme_namespace logs "Auto-selecting whole-disk (VM) detection",
#         generate_raid_config emits a RAID1 log + RAID5 data layout,
#         raid_fs creates /dev/xi_data + /dev/xi_log, install completes.
```

Also confirm the two failure branches by hand where feasible:
- 2–4-disk VM → "insufficient devices" from `generate_raid_config.yml` (clear, not the `raid_fs` undefined-fact abort).
- Bare-metal-like host with `systemd-detect-virt` → `none` and a spare disk → the fail-fast message naming `xinnorVM`.

- [ ] **Step 4: Final commit approval**

```bash
# Request approval before committing any remaining staged changes.
git status
```

---

## Self-Review

- **Spec coverage:** design doc §"Control flow", §"error messages", §"scope boundary", §"non-goals" → Task 3 (fallback block, both fails, forced RAID1 log, `generate_raid_config` gating) + Task 1 (spec §1.1/§9). ✎ Covered.
- **Placeholder scan:** no TBD/TODO in implementation steps; the only deferral is the manual VM run, which is inherent to the repo's no-molecule reality and is spelled out concretely.
- **Type/name consistency:** `FALLBACK_NAME` in the test exactly matches the task `name:` in Task 3 ("Fallback when NVMe detection found no data drives"). Include targets (`detect_all_drives.yml`, `generate_raid_config.yml`, `cleanup_storage.yml`) match existing filenames. `nvme_raid_log_level: 1` asserted in Task 2, set in Task 3.
