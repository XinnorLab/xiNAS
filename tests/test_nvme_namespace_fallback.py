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
    includes = [t.get("ansible.builtin.include_tasks") for t in _fallback_tasks()]
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
    assert any(str(sf.get("nvme_raid_log_level")) == "1" for sf in setfacts), (
        "VM fallback must force nvme_raid_log_level: 1"
    )


def test_fallback_messages_are_actionable():
    fails = [
        t.get("ansible.builtin.fail") for t in _fallback_tasks() if t.get("ansible.builtin.fail")
    ]
    msgs = " ".join(f.get("msg", "") for f in fails)
    assert "xinnorVM" in msgs, "bare-metal failure must name the xinnorVM remedy"
    assert "Attach data disks" in msgs, "no-disks failure message missing"


def test_default_preset_left_unchanged():
    # The fix lives in the role, NOT the preset — guard that decision.
    assert not (REPO / "presets/default/nvme_namespace.yml").exists()
    rf = yaml.safe_load((REPO / "presets/default/raid_fs.yml").read_text())
    assert rf["nvme_raid_log_level"] == 10
