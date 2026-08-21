"""Regression guard: the optional xiRAID removal must purge every package
xiRAID lays down, not just the metapackage.

xiRAID 4.3 (multi-pack, kver.6.8) installs `xiraid-appimage` (provides
`xicli`) and `xiraid-kmod` (the prebuilt kernel module) as dependencies of
the `xiraid-core` metapackage. Both are `apt-mark hold`'d by xiRAID's own
version-lock service, and the purge task runs with `autoremove: false`, so
naming only `xiraid-core`/`xiraid-exporter` leaves them installed. These are
structural assertions over parsed YAML — the repo has no molecule harness
(see tests/test_raid_fs_safe_defaults.py).
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
UNINSTALL_DEFAULTS = REPO / "collection/roles/xinas_uninstall/defaults/main.yml"
OPTIONAL_XIRAID = REPO / "collection/roles/xinas_uninstall/tasks/91_optional_xiraid.yml"

# Everything xiRAID puts on the host that xiNAS opted the user into removing.
EXPECTED_XIRAID_PURGE = {
    "xiraid-core",
    "xiraid-exporter",
    "xiraid-appimage",
    "xiraid-kmod",
}


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {}


def test_purge_list_covers_all_xiraid_packages():
    purge = _load(UNINSTALL_DEFAULTS).get("xinas_xiraid_apt_purge") or []
    missing = EXPECTED_XIRAID_PURGE - set(purge)
    assert not missing, f"xinas_xiraid_apt_purge is missing {sorted(missing)}"


def _tasks() -> list[dict]:
    return yaml.safe_load(OPTIONAL_XIRAID.read_text()) or []


def _index_of(tasks: list[dict], predicate) -> int:
    for i, task in enumerate(tasks):
        if predicate(task):
            return i
    return -1


def test_held_packages_are_unheld_before_the_purge():
    """The kmod/appimage packages are held by xiRAID's version-lock service and
    apt refuses to remove a held package. The hold must be cleared first, and
    the unhold must come before the purge or the purge still aborts with
    'Held packages were changed'."""
    tasks = _tasks()

    unhold = _index_of(
        tasks,
        lambda t: "apt-mark unhold" in str(t.get("ansible.builtin.command", "")),
    )
    assert unhold >= 0, "no `apt-mark unhold` task in the optional xiRAID phase"

    purge = _index_of(tasks, lambda t: "ansible.builtin.apt" in t)
    assert purge >= 0, "no apt purge task in the optional xiRAID phase"

    assert unhold < purge, "the unhold must run before the purge"


def test_unhold_only_touches_packages_that_are_actually_held():
    """`apt-mark unhold` on the full purge list would be reported as changed on
    every run. The task must intersect the list with `apt-mark showhold`."""
    tasks = _tasks()

    showhold = _index_of(
        tasks,
        lambda t: "apt-mark showhold" in str(t.get("ansible.builtin.command", "")),
    )
    assert showhold >= 0, "the role must read `apt-mark showhold` before unholding"

    text = OPTIONAL_XIRAID.read_text()
    assert "intersect(" in text, "unhold must be scoped to the held packages"


def test_purge_avoids_allow_change_held_packages():
    """`allow_change_held_packages` was added in ansible-core 2.13 and only
    reached the removal path in 2.15. Ubuntu 22.04 ships ansible 2.10.8 — which
    `prepare_system.sh` installs — where the parameter is a fatal
    'Unsupported parameters for (ansible.builtin.apt) module' and aborts the
    teardown at its last stage."""
    tasks = _tasks()
    apt_tasks = [t["ansible.builtin.apt"] for t in tasks if "ansible.builtin.apt" in t]
    assert apt_tasks, "no apt task in the optional xiRAID phase"
    for args in apt_tasks:
        assert "allow_change_held_packages" not in args
