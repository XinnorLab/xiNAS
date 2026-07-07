"""Structural regression guards for small storage-role residuals (WS1-R1/R2).

These pin three narrow fixes over the raid_fs and nvme_namespace roles:

- raid_fs must not carry the dead "Find active MD RAID arrays" task (it used
  ``ansible.builtin.command`` with a shell pipe, which the command module
  never interprets — it always errored and its result was never consumed).
- inventories/lab.ini must not pin the deprecated/disarmed
  ``xfs_force_mkfs`` knob at the inventory level.
- nvme_namespace's "Track failed namespace deletions" task must always
  record a delete failure in ``nvme_failed_devices``, regardless of
  ``nvme_skip_failed_devices`` — otherwise "skip failed devices" mode never
  populates the list the downstream create/attach/wait tasks gate on.

These are structural assertions over parsed YAML — the repo has no
molecule/behavioral Ansible harness (see tests/test_raid_fs_safe_defaults.py).
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

_JINJA_EXPR_RE = re.compile(r"\{\{.*?\}\}|\{%.*?%\}", re.DOTALL)

REPO = Path(__file__).resolve().parents[1]
RAID_FS_TASKS_DIR = REPO / "collection/roles/raid_fs/tasks"
LAB_INVENTORY = REPO / "inventories/lab.ini"
REBUILD_NAMESPACES = REPO / "collection/roles/nvme_namespace/tasks/rebuild_namespaces.yml"


def _iter_tasks(tasks):
    """Yield every task dict, recursing into `block:` lists."""
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        yield t
        if isinstance(t.get("block"), list):
            yield from _iter_tasks(t["block"])
        if isinstance(t.get("rescue"), list):
            yield from _iter_tasks(t["rescue"])
        if isinstance(t.get("always"), list):
            yield from _iter_tasks(t["always"])


def _when_text(task: dict) -> str:
    """Flatten a `when:` clause (string or list) into one searchable string."""
    when = task.get("when")
    if when is None:
        return ""
    if isinstance(when, list):
        return " ".join(str(w) for w in when)
    return str(when)


def _find_by_name(tasks, name: str) -> dict | None:
    for t in _iter_tasks(tasks):
        if t.get("name") == name:
            return t
    return None


def test_raid_fs_has_no_dead_mdraid_scan_task():
    for path in sorted(RAID_FS_TASKS_DIR.glob("*.yml")):
        tasks = yaml.safe_load(path.read_text())
        assert _find_by_name(tasks, "Find active MD RAID arrays") is None, (
            f"{path} still defines the dead MD-scan task"
        )


def test_raid_fs_command_tasks_never_pipe_shell_syntax_to_command_module():
    """`ansible.builtin.command` never interprets `|`; only shell tasks may pipe.

    Jinja expressions legitimately use `|` for filters (e.g. `{{ x | bool }}`),
    so those are stripped before checking for a literal shell pipe.
    """
    for path in sorted(RAID_FS_TASKS_DIR.glob("*.yml")):
        tasks = yaml.safe_load(path.read_text())
        for t in _iter_tasks(tasks):
            cmd = t.get("ansible.builtin.command")
            if cmd is None:
                continue
            cmd_str = cmd if isinstance(cmd, str) else cmd.get("cmd", "")
            literal = _JINJA_EXPR_RE.sub("", cmd_str)
            assert "|" not in literal, (
                f"{path}: task {t.get('name')!r} pipes into ansible.builtin.command, "
                "which does not interpret shell pipes"
            )


def test_lab_inventory_does_not_pin_disarmed_xfs_force_mkfs():
    text = LAB_INVENTORY.read_text()
    assert "xfs_force_mkfs" not in text, (
        "lab.ini still pins the deprecated/disarmed xfs_force_mkfs knob"
    )


def test_track_failed_deletions_is_unconditional_on_skip_flag():
    tasks = yaml.safe_load(REBUILD_NAMESPACES.read_text())
    track = _find_by_name(tasks, "Track failed namespace deletions")
    assert track is not None
    assert "nvme_skip_failed_devices" not in _when_text(track), (
        "delete-ns failures must always populate nvme_failed_devices, not just in fail-fast mode"
    )


def test_fail_on_deletion_errors_still_gated_by_skip_flag():
    """The fail-fast task is unaffected by R2 — it must remain skip-gated."""
    tasks = yaml.safe_load(REBUILD_NAMESPACES.read_text())
    fail_task = _find_by_name(tasks, "Fail on namespace deletion errors")
    assert fail_task is not None
    assert "not nvme_skip_failed_devices" in _when_text(fail_task)


def test_namespace_create_tasks_still_skip_failed_devices():
    tasks = yaml.safe_load(REBUILD_NAMESPACES.read_text())
    for name in (
        "Create small namespace, size MB {{ nvme_small_ns_size_mb }}",
        "Create large namespace (remaining capacity)",
    ):
        task = _find_by_name(tasks, name)
        assert task is not None, f"task {name!r} not found"
        assert "not in nvme_failed_devices" in _when_text(task), (
            f"task {name!r} must still gate on nvme_failed_devices"
        )
