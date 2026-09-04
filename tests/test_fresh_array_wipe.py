"""A freshly created array is not allowed to trip the run's own FOREIGN gate.

`xicli raid create` does not zero the array payload, and `raid_fs` skips TRIM
whenever a member fails the RZAT/discard probes — so on hosts whose drives
report "no RZAT" (every virtio/SCSI bench disk) the head of a brand-new array
can still expose a signature the member disks carried from a previous install.
`blkid` reads it as a real filesystem, and create_fs.yml's FOREIGN gate then
refuses to format an array the same run created seconds earlier:

    Existing filesystem '' (xfs_external_log) on /dev/xi_data does not match the
    expected label 'nfsdata' (state=FOREIGN) ... Refusing to reformat.

The wipe must stay inside the create branch: an array that already existed when
the run started is data, and §11 says nothing may touch it without an explicit,
confirmed reset. It must also run after the device node appears, or it wipes
nothing at all. Both are what this module pins. See raid-spec.md §7.5.
"""

from __future__ import annotations

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

REPO = Path(__file__).resolve().parents[1]
CREATE_ARRAY = REPO / "collection/roles/raid_fs/tasks/create_array.yml"


def _tasks(path: Path) -> list[dict]:
    return [t for t in yaml.safe_load(path.read_text()) or [] if isinstance(t, dict)]


def _body(task: dict) -> str:
    return str(task.get("ansible.builtin.command", task.get("ansible.builtin.shell", "")))


def test_fresh_array_head_is_wiped_inside_the_create_path():
    """A brand-new array can expose stale member signatures when TRIM is off.

    Without this the run that just created the array trips its own FOREIGN
    gate on `xfs_external_log` residue (bench run 2026-09-03).
    """
    tasks = _tasks(CREATE_ARRAY)
    wipes = [t for t in tasks if "wipefs" in _body(t)]
    assert len(wipes) == 1, "expected exactly one wipefs task in create_array.yml"
    assert "/dev/xi_" in _body(wipes[0])

    # It must run after the device shows up, otherwise it wipes nothing.
    names = [t.get("name", "") for t in tasks]
    wait_i = next(i for i, n in enumerate(names) if n.startswith("Wait for xiRAID block device"))
    wipe_i = names.index(wipes[0]["name"])
    assert wipe_i > wait_i


def test_the_wipe_is_reachable_only_when_the_array_is_missing():
    """create_array.yml is the create branch; entering it for an existing array
    would put `wipefs -a` on somebody's live data."""
    main = [
        t
        for t in _tasks(REPO / "collection/roles/raid_fs/tasks/main.yml")
        if t.get("ansible.builtin.include_tasks") == "create_array.yml"
    ]
    assert len(main) == 1
    when = main[0].get("when", "")
    assert "not in existing_array_names" in (" ".join(when) if isinstance(when, list) else when)
