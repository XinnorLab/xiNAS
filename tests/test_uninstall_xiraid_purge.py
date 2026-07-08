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


def test_purge_task_allows_removing_held_packages():
    """The kmod/appimage packages are held by xiRAID; the purge must be able to
    change held packages or apt aborts with 'Held packages were changed'."""
    text = OPTIONAL_XIRAID.read_text()
    assert "allow_change_held_packages: true" in text
