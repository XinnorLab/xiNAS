"""WS2.3: RAID teardown must only touch xiNAS-managed names + never the OS disk."""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
TEARDOWN = REPO / "collection/roles/xinas_uninstall/tasks/30_teardown_raid.yml"
SRC = TEARDOWN.read_text()


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


def _load_tasks():
    return yaml.safe_load(TEARDOWN.read_text())


def test_array_names_filtered_to_managed():
    assert "_xinas_managed_array_names" in SRC or "select('match'" in SRC, (
        "array names from xicli must be filtered to xiNAS-managed names "
        "(baseline or data/log/*_spare_pool match) before destroy (WS2.3)"
    )


def test_drive_clean_excludes_system_disks():
    assert "nvme_system_drives" in SRC or "resolve_system_disks" in SRC, (
        "drive clean must exclude the resolved OS disk set (WS2.3)"
    )


def test_destroy_tasks_loop_over_managed_names_not_raw():
    """Substring checks alone would pass even if the destroy loops still
    iterated the raw parsed vars (_xinas_array_names/_xinas_pool_names)
    instead of the managed-name-filtered vars. Assert the actual `loop:`
    value on each destroy task."""
    tasks = _load_tasks()

    array_destroy = _find_by_name(tasks, "RAID | delete xiNAS-managed arrays")
    assert array_destroy is not None, "missing the array-destroy task"
    array_loop = array_destroy.get("loop", "")
    assert "_xinas_managed_array_names" in array_loop, (
        f"array destroy must loop over _xinas_managed_array_names, got: {array_loop!r}"
    )
    assert "_xinas_array_names" not in array_loop.replace("_xinas_managed_array_names", ""), (
        f"array destroy must not loop over the raw _xinas_array_names, got: {array_loop!r}"
    )

    pool_destroy = _find_by_name(tasks, "RAID | delete xiNAS-managed spare pools")
    assert pool_destroy is not None, "missing the pool-destroy task"
    pool_loop = pool_destroy.get("loop", "")
    assert "_xinas_managed_pool_names" in pool_loop, (
        f"pool destroy must loop over _xinas_managed_pool_names, got: {pool_loop!r}"
    )
    assert "_xinas_pool_names" not in pool_loop.replace("_xinas_managed_pool_names", ""), (
        f"pool destroy must not loop over the raw _xinas_pool_names, got: {pool_loop!r}"
    )


def test_abort_if_os_disk_unresolved_before_drive_clean():
    """Fail-closed guard: if the OS disk cannot be resolved, teardown must
    abort before `xicli drive clean` ever runs, mirroring the safety abort
    in nvme_namespace/tasks/main.yml (which `tasks_from: resolve_system_disks`
    does NOT pull in on its own)."""
    tasks = list(_iter_tasks(_load_tasks()))

    abort_task = None
    for t in tasks:
        fail = t.get("ansible.builtin.fail")
        when = t.get("when")
        when_str = " ".join(when) if isinstance(when, list) else str(when or "")
        if fail is not None and "nvme_system_drives" in when_str and "length == 0" in when_str:
            abort_task = t
            break

    assert abort_task is not None, (
        "missing a fail-closed abort task (ansible.builtin.fail) guarding on "
        "nvme_system_drives being empty before drive clean runs"
    )

    names = [t.get("name") for t in tasks]
    resolve_i = names.index("RAID | resolve OS disks to exclude from drive clean")
    abort_i = names.index(abort_task["name"])
    clean_i = names.index("RAID | clean every non-OS NVMe device once arrays are gone")
    assert resolve_i < abort_i < clean_i, (
        "abort task must run after OS-disk resolution and before drive clean"
    )
