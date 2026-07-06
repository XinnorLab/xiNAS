"""Regression guard for OS-disk protection during drive detection.

A guided-LVM / dm-crypt / MD-root Ubuntu install exposes `/` as
`/dev/mapper/…` or `/dev/mdX`. The old detection stripped a partition suffix
off the raw `findmnt` output, which left the mapper string intact: it passed
the `^/dev/` filter (so the "abort if no system drive" guard never fired) yet
resolved to no physical NVMe controller, so the OS controller was classified as
a *data* drive and wiped by the cleanup pass (`vgremove -f`, `wipefs`, `dd`).

The fix resolves every OS mount down to its physical disk(s) via
`lsblk --inverse`, shared by both detection modes, and never runs cleanup before
the safety abort. These are structural assertions over the parsed task YAML —
the repo has no molecule/behavioral Ansible harness (see CLAUDE.md), so we pin
the contract the same way tests/test_nvme_namespace_fallback.py does.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
ROLE = REPO / "collection/roles/nvme_namespace/tasks"
FILES = REPO / "collection/roles/nvme_namespace/files"
RESOLVE = ROLE / "resolve_system_disks.yml"
RESOLVE_SH = FILES / "resolve_system_disks.sh"
DETECT_NVME = ROLE / "detect_drives.yml"
DETECT_ALL = ROLE / "detect_all_drives.yml"
MAIN = ROLE / "main.yml"

NVME_BLOCK_NAME = "Run NVMe namespace management"


def _load(path: Path) -> list:
    return yaml.safe_load(path.read_text())


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


# ── The shared resolver ────────────────────────────────────────────────────


def test_resolver_file_exists():
    assert RESOLVE.exists(), "expected shared resolve_system_disks.yml to exist"


def test_resolver_walks_inverse_device_tree():
    # The whole point: trace /dev/mapper, /dev/mdX back to physical disks.
    text = RESOLVE_SH.read_text()
    assert "lsblk -s" in text or "lsblk --inverse" in text, (
        "resolver must walk the inverse block-device tree to reach physical disks"
    )


def test_resolver_publishes_system_facts():
    setfacts = [
        sf for t in _iter_tasks(_load(RESOLVE)) if (sf := t.get("ansible.builtin.set_fact"))
    ]
    keys = " ".join(k for sf in setfacts for k in sf)
    assert "nvme_system_drives" in keys, "resolver must publish nvme_system_drives"
    assert "nvme_system_root_resolved" in keys, (
        "resolver must publish nvme_system_root_resolved for the fail-closed guard"
    )


def test_resolver_task_runs_the_shared_script():
    scripts = [t.get("ansible.builtin.script") for t in _iter_tasks(_load(RESOLVE))]
    joined = " ".join(str(s) for s in scripts if s)
    assert "resolve_system_disks.sh" in joined, (
        "resolver task must run the shared resolve_system_disks.sh"
    )


# ── Both detection modes use the shared resolver, not the fragile strip ─────


def _includes(path: Path):
    return [t.get("ansible.builtin.include_tasks") for t in _iter_tasks(_load(path))]


def test_nvme_detection_uses_shared_resolver():
    assert "resolve_system_disks.yml" in _includes(DETECT_NVME)


def test_all_detection_uses_shared_resolver():
    assert "resolve_system_disks.yml" in _includes(DETECT_ALL)


def test_detection_files_drop_fragile_partition_strip():
    # The bug lived in `sed -E 's/p?[0-9]+$//'` applied to raw findmnt output.
    for path in (DETECT_NVME, DETECT_ALL):
        assert "s/p?[0-9]+$//" not in path.read_text(), (
            f"{path.name} still hand-rolls the fail-open partition strip"
        )


# ── Defense-in-depth asserts: no protected disk leaks into data drives ──────


def _assert_thats(path: Path) -> str:
    out = []
    for t in _iter_tasks(_load(path)):
        a = t.get("ansible.builtin.assert")
        if isinstance(a, dict):
            that = a.get("that")
            out.append(" ".join(that) if isinstance(that, list) else str(that))
    return " ".join(out)


def test_nvme_detection_asserts_no_system_controller_in_data():
    thats = _assert_thats(DETECT_NVME)
    assert "nvme_data_drives" in thats and "nvme_system_controllers" in thats, (
        "nvme detection must assert data drives exclude system controllers"
    )


def test_all_detection_asserts_no_system_disk_in_data():
    thats = _assert_thats(DETECT_ALL)
    assert "nvme_data_drives" in thats and "nvme_system_drives" in thats, (
        "all detection must assert data drives exclude system disks"
    )


# ── Ordering: never wipe before the safety abort (nvme mode) ────────────────


def test_nvme_mode_aborts_before_cleanup():
    block = _find_by_name(_load(MAIN), NVME_BLOCK_NAME)
    assert block is not None, f"missing block {NVME_BLOCK_NAME!r}"
    children = block["block"]

    def index_where(pred):
        return next((i for i, t in enumerate(children) if pred(t)), None)

    abort_i = index_where(
        lambda t: (
            t.get("ansible.builtin.fail")
            and "system drive not found" in (t.get("name") or "").lower()
        )
    )
    cleanup_i = index_where(
        lambda t: t.get("ansible.builtin.include_tasks") == "cleanup_storage.yml"
    )
    assert abort_i is not None, "nvme block must have the abort-if-no-system-drive fail"
    assert cleanup_i is not None, "nvme block must include cleanup_storage.yml"
    assert abort_i < cleanup_i, "safety abort must run BEFORE cleanup wipes any drive"


# ── Fail-closed: abort guards must honour root-resolution, not just non-empty ─


def test_all_abort_guards_check_root_resolved():
    # Every "system drive not found" abort must also fire when the OS root did
    # not resolve to a physical disk (ZFS/iSCSI roots), even if an ESP populated
    # nvme_system_drives.
    aborts = [
        t
        for t in _iter_tasks(_load(MAIN))
        if t.get("ansible.builtin.fail")
        and "system drive not found" in (t.get("name") or "").lower()
    ]
    assert aborts, "expected at least one abort-if-no-system-drive task"
    for t in aborts:
        when = " ".join(str(w) for w in (t.get("when") or []))
        assert "nvme_system_root_resolved" in when, (
            f"abort {t.get('name')!r} must also fire when root did not resolve"
        )


# ── Cleanup must use boundary-safe matching, not string prefixes ─────────────


def test_cleanup_drops_string_prefix_matching():
    text = (ROLE / "cleanup_storage.yml").read_text()
    assert '"${drive}"*' not in text, (
        "cleanup still uses prefix `${drive}*` matching (nvme1 swallows nvme10)"
    )
    assert "${drive}p*" not in text, "cleanup still uses the ${drive}p* glob loop"


def test_cleanup_uses_boundary_safe_helper():
    text = (ROLE / "cleanup_storage.yml").read_text()
    assert "is_data_member" in text or "disk_match.sh" in text, (
        "cleanup must select targets via the boundary-safe disk_match helper"
    )
