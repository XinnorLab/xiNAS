"""`xinas_fs_force_format` exempts exactly one gate (raid-spec.md §11).

The wizard's force answer has to reach the roles, and the roles have to honour
it *narrowly*. The failure mode this pins is a force switch that quietly grows
into a second `xinas_storage_reset`: if it also suppressed the `UNKNOWN` gate
or the unhealthy-array gate, an operator who confirmed "reformat the filesystem
on the arrays I just picked" would instead authorise wiping a degraded array,
or one whose state nobody could read.

The invariant here *is* the `when:` list of each fail task, so these are
structural assertions over the task YAML. The classification logic behind
`xinas_storage_state` is covered separately by
tests/test_storage_state_fail_closed.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

REPO = Path(__file__).resolve().parents[1]
RAID_FS = REPO / "collection/roles/raid_fs/tasks"
NVME = REPO / "collection/roles/nvme_namespace/tasks"

FORCE = "xinas_fs_force_format"


def _tasks(path: Path) -> list[dict]:
    return [t for t in yaml.safe_load(path.read_text()) or [] if isinstance(t, dict)]


def _when(task: dict) -> str:
    w = task.get("when", [])
    return " ".join(w) if isinstance(w, list) else str(w)


def _fail_tasks(path: Path) -> list[dict]:
    return [t for t in _tasks(path) if "ansible.builtin.fail" in t]


def _blocked_fail_tasks(path: Path) -> list[dict]:
    """fail tasks at the top level plus those nested one block deep."""
    out = _fail_tasks(path)
    for t in _tasks(path):
        for nested in t.get("block", []) or []:
            if isinstance(nested, dict) and "ansible.builtin.fail" in nested:
                out.append(nested)
    return out


def _by_msg(tasks: list[dict], needle: str) -> dict:
    hits = [t for t in tasks if needle in str(t.get("ansible.builtin.fail", {}).get("msg", ""))]
    assert len(hits) == 1, f"expected exactly one fail task matching {needle!r}, got {len(hits)}"
    return hits[0]


def test_force_flag_defaults_to_false():
    defaults = yaml.safe_load((REPO / "collection/roles/raid_fs/defaults/main.yml").read_text())
    assert defaults[FORCE] is False


@pytest.mark.parametrize(
    "path",
    [RAID_FS / "main.yml", NVME / "main.yml"],
    ids=["raid_fs", "nvme_namespace"],
)
def test_generic_foreign_gate_honours_the_force_flag(path):
    """The gate the wizard's force answer is meant to open."""
    task = _by_msg(_blocked_fail_tasks(path), "does not match the expected xiNAS layout")
    assert FORCE in _when(task)


@pytest.mark.parametrize(
    "path",
    [RAID_FS / "main.yml", NVME / "main.yml"],
    ids=["raid_fs", "nvme_namespace"],
)
def test_unknown_gate_ignores_the_force_flag(path):
    """A layout nobody could read is not one the operator was shown."""
    task = _by_msg(_blocked_fail_tasks(path), "state=UNKNOWN")
    assert FORCE not in _when(task)


@pytest.mark.parametrize(
    "path",
    [RAID_FS / "main.yml", NVME / "main.yml"],
    ids=["raid_fs", "nvme_namespace"],
)
def test_unhealthy_array_gate_ignores_the_force_flag(path):
    """A degraded or rebuilding array is recoverable: repair it, don't format it."""
    task = _by_msg(_blocked_fail_tasks(path), "are not online")
    assert FORCE not in _when(task)


def test_per_device_foreign_gate_honours_the_force_flag():
    task = _by_msg(_fail_tasks(RAID_FS / "create_fs.yml"), "Refusing to reformat")
    assert FORCE in _when(task)


def test_force_flag_drives_mkfs():
    tasks = _tasks(RAID_FS / "create_fs.yml")
    decide = [t for t in tasks if "_do_mkfs" in str(t.get("ansible.builtin.set_fact", {}))]
    assert len(decide) == 1
    assert FORCE in str(decide[0]["ansible.builtin.set_fact"]["_do_mkfs"])


def test_force_flag_does_not_authorise_destruction_beyond_mkfs():
    """drive clean / MD sweep stay gated on storage_reset OR EMPTY."""
    for task in _tasks(RAID_FS / "main.yml"):
        name = task.get("name", "")
        if "Clean xiRAID drives" in name or "Stop leftover MD RAID" in name:
            assert FORCE not in _when(task), name
