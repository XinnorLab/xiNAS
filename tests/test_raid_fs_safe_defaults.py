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


DETECT = REPO / "collection/roles/nvme_namespace/tasks/detect_storage_state.yml"


def test_detection_sets_state_fact():
    text = DETECT.read_text()
    assert "xinas_storage_state" in text
    for state in ("MATCH", "EMPTY", "FOREIGN"):
        assert state in text, f"detection never yields {state}"
    # Detection must be read-only: no destructive verbs.
    for verb in ("delete-ns", "mkfs", "drive clean", "wipefs", "zero-superblock"):
        assert verb not in text, f"detection must not run {verb!r}"
    # It must parse into a native list, not a stringified one.
    tasks = yaml.safe_load(text)
    assert isinstance(tasks, list) and tasks, "detection file must be a task list"


CONFIRM = REPO / "collection/roles/nvme_namespace/tasks/storage_reset_confirm.yml"


def test_confirm_is_fact_guarded_and_bypassable():
    text = CONFIRM.read_text()
    yaml.safe_load(text)  # must parse
    # A pause task requires typing YES.
    assert "ansible.builtin.pause" in text, "no confirmation pause task"
    assert "YES" in text
    # The gate is guarded by the reset flag and the confirmed fact, and bypassable.
    assert "xinas_storage_reset" in text
    assert "xinas_storage_reset_confirmed" in text
    assert "nvme_skip_cleanup_confirmation" in text


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
    assert _find_include(tasks, "detect_storage_state.yml") is not None
    assert any(
        "FOREIGN" in str(t.get("name", "")) or "FOREIGN" in str(t.get("fail", ""))
        for t in _iter(tasks)
    ), "no FOREIGN fail-fast task"
    reb = _find_include(tasks, "rebuild_namespaces.yml")
    assert reb is not None
    when = " ".join(str(w) for w in (reb.get("when") or []))
    assert "xinas_storage_state" in when and "xinas_storage_reset" in when
    cleanups = _all_includes(tasks, "cleanup_storage.yml")
    assert cleanups, "no cleanup_storage include found"
    for cl in cleanups:
        clwhen = " ".join(str(w) for w in (cl.get("when") or []))
        assert "xinas_storage_reset" in clwhen and "EMPTY" in clwhen, clwhen
        assert "!= 'MATCH'" not in clwhen and "!= \"MATCH\"" not in clwhen


RAID_MAIN = REPO / "collection/roles/raid_fs/tasks/main.yml"


def _find_by_name(path, name):
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
    # drive clean is gated on state.
    dc = _find_by_name(RAID_MAIN, "Clean xiRAID drives")
    assert dc is not None
    # `when` may be a folded string (single OR-expression) or a list — str() covers both.
    assert "xinas_storage_state" in str(dc.get("when"))


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
    assert "_do_mkfs" in str(mkfs.get("when"))
