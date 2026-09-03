"""Behavioral + structural guards for NSID-based namespace device resolution.

The ``Y`` in ``nvmeXnY`` is the kernel's per-subsystem namespace-head
*instance* (``ida_alloc_min(&subsys->ns_ida, 1, ...)`` in
drivers/nvme/host/core.c), not the NSID. After the rebuild's
delete-ns/create-ns cycle the old head can still hold instance 1 when the new
NSID 1 is scanned, so it comes up as ``nvme10n2`` and the large NSID 2 as
``nvme10n3`` — observed on every data controller of xinas-box on 2026-09-03
(raid-spec §4.5). The role therefore resolves block devices the way xiRAID
identifies drives: controller serial + NSID, read from sysfs.

The behavioral tests run the real ``nvme_ns_device.sh`` against a fake sysfs /
dev tree (``SYSFS_ROOT`` / ``DEV_ROOT``). The structural tests pin the role
YAML to that resolver — the repo has no molecule/behavioral Ansible harness
(see tests/test_storage_role_structure.py).
"""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
ROLE = REPO / "collection/roles/nvme_namespace"
HELPER = ROLE / "files/nvme_ns_device.sh"
REBUILD = ROLE / "tasks/rebuild_namespaces.yml"
DETECT_EXISTING = ROLE / "tasks/detect_existing_namespaces.yml"
COLLECT_TOPOLOGY = ROLE / "tasks/collect_topology.yml"
STAGED = "/tmp/xinas_nvme_ns_device.sh"

# sysfs pads the serial attribute to the NVMe field width (20 bytes).
SERIAL_PAD = 20
KIOXIA = "6030A005TMYR"


def build_tree(tmp_path, *, controllers, devices, subsystems=None):
    """Create a fake sysfs + dev tree and return (sysfs_root, dev_root).

    controllers: {"nvme10": "<serial>"}   -> /sys/class/nvme/<ctrl>/serial
    subsystems:  {"nvme-subsys10": "<serial>"} (kernel-multipath heads hang off these)
    devices:     {"nvme10n2": {"parent": "nvme10", "nsid": 1, "hidden": False, "node": True}}
                 -> /sys/block/<dev>/{nsid,hidden,device->parent} and /dev/<dev>
    """
    sysfs = tmp_path / "sys"
    dev_root = tmp_path / "dev"
    dev_root.mkdir()
    parents: dict[str, Path] = {}
    for name, serial in controllers.items():
        d = sysfs / "class" / "nvme" / name
        d.mkdir(parents=True)
        (d / "serial").write_text(serial.ljust(SERIAL_PAD) + "\n")
        parents[name] = d
    for name, serial in (subsystems or {}).items():
        d = sysfs / "class" / "nvme-subsystem" / name
        d.mkdir(parents=True)
        (d / "serial").write_text(serial.ljust(SERIAL_PAD) + "\n")
        parents[name] = d
    for name, spec in devices.items():
        d = sysfs / "block" / name
        d.mkdir(parents=True)
        if spec.get("nsid") is not None:
            (d / "nsid").write_text(f"{spec['nsid']}\n")
        (d / "hidden").write_text("1\n" if spec.get("hidden") else "0\n")
        if spec.get("parent"):
            (d / "device").symlink_to(parents[spec["parent"]])
        if spec.get("node", True):
            (dev_root / name).write_text("")
    return sysfs, dev_root


def run(sysfs, dev_root, *args):
    return subprocess.run(
        ["bash", str(HELPER), *args],
        env={"PATH": "/usr/bin:/bin", "SYSFS_ROOT": str(sysfs), "DEV_ROOT": str(dev_root)},
        capture_output=True,
        text=True,
    )


def resolve(sysfs, dev_root, ctrl, nsid):
    proc = run(sysfs, dev_root, "resolve", ctrl, str(nsid))
    return proc.returncode, proc.stdout.strip()


def _dev(dev_root, name):
    return f"{dev_root}/{name}"


# ── The resolver itself ──────────────────────────────────────────────────────


def test_helper_exists():
    assert HELPER.exists(), "nvme_ns_device.sh helper must exist"


def test_resolves_by_nsid_when_names_line_up(tmp_path):
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme1": "SER1"},
        devices={
            "nvme1n1": {"parent": "nvme1", "nsid": 1},
            "nvme1n2": {"parent": "nvme1", "nsid": 2},
        },
    )
    assert resolve(sysfs, dev, "/dev/nvme1", 1) == (0, _dev(dev, "nvme1n1"))
    assert resolve(sysfs, dev, "/dev/nvme1", 2) == (0, _dev(dev, "nvme1n2"))


def test_resolves_shifted_head_instances_without_multipath(tmp_path):
    """The xinas-box case with nvme_core.multipath=N: n2 is NSID 1, n3 is NSID 2."""
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme10": KIOXIA},
        devices={
            "nvme10n2": {"parent": "nvme10", "nsid": 1},
            "nvme10n3": {"parent": "nvme10", "nsid": 2},
        },
    )
    assert resolve(sysfs, dev, "/dev/nvme10", 1) == (0, _dev(dev, "nvme10n2"))
    assert resolve(sysfs, dev, "/dev/nvme10", 2) == (0, _dev(dev, "nvme10n3"))
    # There is no NSID 3 — the *name* nvme10n3 must not be mistaken for one.
    rc, out = resolve(sysfs, dev, "/dev/nvme10", 3)
    assert (rc, out) == (1, "")


def test_resolves_shifted_head_instances_with_kernel_multipath(tmp_path):
    """The layout actually observed on xinas-box (nvme_core.multipath=Y).

    Head devices hang off nvme-subsys10 and carry the /dev node; the
    per-controller path devices nvme10c10n2 / nvme10c10n3 sit under the
    controller, share serial + nsid, but are hidden and have no /dev node.
    """
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme10": KIOXIA},
        subsystems={"nvme-subsys10": KIOXIA},
        devices={
            "nvme10n2": {"parent": "nvme-subsys10", "nsid": 1},
            "nvme10n3": {"parent": "nvme-subsys10", "nsid": 2},
            "nvme10c10n2": {"parent": "nvme10", "nsid": 1, "hidden": True, "node": False},
            "nvme10c10n3": {"parent": "nvme10", "nsid": 2, "hidden": True, "node": False},
        },
    )
    assert resolve(sysfs, dev, "/dev/nvme10", 1) == (0, _dev(dev, "nvme10n2"))
    assert resolve(sysfs, dev, "/dev/nvme10", 2) == (0, _dev(dev, "nvme10n3"))
    listing = run(sysfs, dev, "list", "/dev/nvme10").stdout.splitlines()
    assert listing == [
        f"1 {_dev(dev, 'nvme10n2')} {KIOXIA}_1",
        f"2 {_dev(dev, 'nvme10n3')} {KIOXIA}_2",
    ]


def test_list_is_ordered_by_nsid_not_by_name_and_carries_xiraid_identity(tmp_path):
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme10": KIOXIA},
        devices={
            "nvme10n3": {"parent": "nvme10", "nsid": 1},
            "nvme10n2": {"parent": "nvme10", "nsid": 2},
        },
    )
    proc = run(sysfs, dev, "list", "nvme10")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines() == [
        f"1 {_dev(dev, 'nvme10n3')} {KIOXIA}_1",
        f"2 {_dev(dev, 'nvme10n2')} {KIOXIA}_2",
    ]


def test_lookup_never_crosses_into_another_controller(tmp_path):
    # nvme1 must not pick up nvme10's namespaces (string-prefix trap) nor
    # any device carrying a different serial.
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme1": "SER-A", "nvme10": "SER-B"},
        devices={
            "nvme10n1": {"parent": "nvme10", "nsid": 1},
            "nvme1n1": {"parent": "nvme1", "nsid": 1},
        },
    )
    assert resolve(sysfs, dev, "/dev/nvme1", 1) == (0, _dev(dev, "nvme1n1"))
    assert resolve(sysfs, dev, "/dev/nvme10", 1) == (0, _dev(dev, "nvme10n1"))
    assert run(sysfs, dev, "list", "nvme1").stdout.splitlines() == [
        f"1 {_dev(dev, 'nvme1n1')} SER-A_1"
    ]


def test_dual_port_same_serial_prefers_the_requested_controller(tmp_path):
    # Two controllers of one drive with multipath off: both expose NSID 1 with
    # the same serial. Each controller resolves to its own node, once.
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme10": KIOXIA, "nvme11": KIOXIA},
        devices={
            "nvme10n1": {"parent": "nvme10", "nsid": 1},
            "nvme11n1": {"parent": "nvme11", "nsid": 1},
        },
    )
    assert resolve(sysfs, dev, "/dev/nvme10", 1) == (0, _dev(dev, "nvme10n1"))
    assert resolve(sysfs, dev, "/dev/nvme11", 1) == (0, _dev(dev, "nvme11n1"))
    assert run(sysfs, dev, "list", "nvme11").stdout.splitlines() == [
        f"1 {_dev(dev, 'nvme11n1')} {KIOXIA}_1"
    ]


def test_entries_without_nsid_or_serial_or_dev_node_are_skipped(tmp_path):
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme10": KIOXIA},
        devices={
            "nvme10n1": {"parent": "nvme10"},  # no nsid attribute (vanishing entry)
            "nvme10n2": {"parent": "nvme10", "nsid": "garbage"},
            "nvme10n3": {"nsid": 1},  # no device link → no serial
            "nvme10n4": {"parent": "nvme10", "nsid": 1, "node": False},  # not in /dev yet
            "nvme10n5": {"parent": "nvme10", "nsid": 2},
        },
    )
    assert resolve(sysfs, dev, "/dev/nvme10", 1) == (1, "")
    assert resolve(sysfs, dev, "/dev/nvme10", 2) == (0, _dev(dev, "nvme10n5"))
    assert run(sysfs, dev, "list", "nvme10").stdout.splitlines() == [
        f"2 {_dev(dev, 'nvme10n5')} {KIOXIA}_2"
    ]


def test_unknown_controller_exits_2(tmp_path):
    sysfs, dev = build_tree(tmp_path, controllers={"nvme10": KIOXIA}, devices={})
    for args in (
        ("list", "/dev/nvme99"),
        ("resolve", "/dev/nvme99", "1"),
        ("wait", "nvme99", "1", "1"),
    ):
        proc = run(sysfs, dev, *args)
        assert proc.returncode == 2, args
        assert proc.stdout == ""
        assert "nvme99" in proc.stderr


def test_malformed_arguments_exit_2(tmp_path):
    sysfs, dev = build_tree(tmp_path, controllers={"nvme10": KIOXIA}, devices={})
    for args in (
        (),
        ("list",),
        ("resolve", "nvme10"),
        ("resolve", "nvme10", "x"),
        ("wait", "nvme10", "1", "x"),
    ):
        assert run(sysfs, dev, *args).returncode == 2, args


def test_wait_times_out_then_returns_once_the_device_appears(tmp_path):
    sysfs, dev = build_tree(
        tmp_path,
        controllers={"nvme10": KIOXIA},
        devices={"nvme10n2": {"parent": "nvme10", "nsid": 1}},
    )
    started = time.monotonic()
    proc = run(sysfs, dev, "wait", "/dev/nvme10", "2", "1")
    elapsed = time.monotonic() - started
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "NSID 2" in proc.stderr and KIOXIA in proc.stderr
    assert elapsed < 8, f"wait with timeout=1 took {elapsed:.1f}s"

    (sysfs / "block" / "nvme10n3").mkdir()
    (sysfs / "block" / "nvme10n3" / "nsid").write_text("2\n")
    (sysfs / "block" / "nvme10n3" / "hidden").write_text("0\n")
    (sysfs / "block" / "nvme10n3" / "device").symlink_to(sysfs / "class" / "nvme" / "nvme10")
    (dev / "nvme10n3").write_text("")
    proc = run(sysfs, dev, "wait", "/dev/nvme10", "2", "1")
    assert (proc.returncode, proc.stdout.strip()) == (0, _dev(dev, "nvme10n3"))


# ── The role must go through the resolver ────────────────────────────────────


def _iter_tasks(tasks):
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        yield t
        for key in ("block", "rescue", "always"):
            if isinstance(t.get(key), list):
                yield from _iter_tasks(t[key])


def _find_by_name(tasks, name):
    for t in _iter_tasks(tasks):
        if t.get("name") == name:
            return t
    return None


def _when_text(task):
    when = task.get("when")
    if when is None:
        return ""
    return " ".join(str(w) for w in when) if isinstance(when, list) else str(when)


def _shell_text(task):
    shell = task.get("ansible.builtin.shell")
    if shell is None:
        return ""
    return shell if isinstance(shell, str) else str(shell.get("cmd", ""))


def _argv(task):
    cmd = task.get("ansible.builtin.command")
    if isinstance(cmd, dict):
        return [str(a) for a in cmd.get("argv", [])]
    return []


def _code_lines(path: Path):
    """Non-comment lines of a task file (comments legitimately describe the bug)."""
    return [ln for ln in path.read_text().splitlines() if not ln.lstrip().startswith("#")]


@pytest.mark.parametrize("path", [REBUILD, DETECT_EXISTING, COLLECT_TOPOLOGY])
def test_no_task_constructs_a_namespace_device_from_the_name_suffix(path):
    """`{{ ctrl }}n1`, `$(basename ...)n*` and friends are the bug."""
    suffix = re.compile(r"\}\}n[0-9*]|\)n[0-9*]|/nvme\[0-9\]\+n1\$")
    offenders = [ln for ln in _code_lines(path) if suffix.search(ln)]
    assert not offenders, f"{path.name} still derives a device from its name suffix:\n" + "\n".join(
        offenders
    )
    assert not any("wait_for" in ln for ln in _code_lines(path)), (
        f"{path.name} still waits on a name-derived path with wait_for"
    )


@pytest.mark.parametrize("path", [REBUILD, DETECT_EXISTING])
def test_resolver_is_staged_where_it_is_used(path):
    tasks = yaml.safe_load(path.read_text())
    copies = [
        t
        for t in _iter_tasks(tasks)
        if isinstance(t.get("ansible.builtin.copy"), dict)
        and t["ansible.builtin.copy"].get("src") == "nvme_ns_device.sh"
    ]
    assert copies, f"{path.name} does not stage nvme_ns_device.sh"
    copy = copies[0]["ansible.builtin.copy"]
    assert copy.get("dest") == STAGED
    assert str(copy.get("mode")) == "0755"


def test_create_tasks_export_the_nsid_they_created():
    tasks = yaml.safe_load(REBUILD.read_text())
    for name in (
        "Create small namespace, size MB {{ nvme_small_ns_size_mb }}",
        "Create large namespace (remaining capacity)",
    ):
        task = _find_by_name(tasks, name)
        assert task is not None, name
        assert 'echo "created_nsid=$nsid"' in _shell_text(task), (
            f"{name!r} must print the created NSID for the wait step"
        )
    for tier in ("small", "large"):
        rec = _find_by_name(tasks, f"Record the NSID each {tier} namespace was created with")
        assert rec is not None, tier
        assert f"nvme_{tier}_ns_ids" in str(rec.get("ansible.builtin.set_fact"))
        assert "created_nsid=" in str(rec.get("ansible.builtin.set_fact"))


@pytest.mark.parametrize("tier", ["small", "large"])
def test_rebuild_waits_for_the_created_nsid_through_the_resolver(tier):
    tasks = yaml.safe_load(REBUILD.read_text())
    wait = _find_by_name(tasks, f"Wait for the {tier} namespace block devices (by NSID)")
    assert wait is not None
    argv = _argv(wait)
    assert STAGED in argv and "wait" in argv, argv
    assert any(f"nvme_{tier}_ns_ids[item.controller]" in a for a in argv), argv
    when = _when_text(wait)
    assert "not in nvme_failed_devices" in when
    assert f"in nvme_{tier}_ns_ids" in when
    assert wait.get("failed_when") is False, "wait failures are tracked, not fatal per item"

    track = _find_by_name(tasks, f"Track controllers whose {tier} namespace never came up")
    assert track is not None
    assert "nvme_skip_failed_devices" not in _when_text(track), (
        "a missing device must always be recorded, regardless of the skip flag"
    )

    build = _find_by_name(tasks, f"Build {tier} namespace device list")
    assert build is not None
    assert f"{tier}_ns_wait.results" in str(build.get("ansible.builtin.set_fact"))


def test_missing_devices_fail_the_play_only_in_fail_fast_mode():
    tasks = yaml.safe_load(REBUILD.read_text())
    fail = _find_by_name(tasks, "Fail on namespace devices that never came up")
    assert fail is not None
    assert "not nvme_skip_failed_devices" in _when_text(fail)
    assert "nvme_failed_devices | length > 0" in _when_text(fail)


def test_rebuild_fails_loudly_when_no_usable_device_set_remains():
    """Previously an empty list silently skipped generate_raid_config.yml and
    raid_fs aborted three roles later with "xiraid_arrays is not defined"."""
    tasks = yaml.safe_load(REBUILD.read_text())
    fail = _find_by_name(tasks, "Fail when the rebuild produced no usable namespace devices")
    assert fail is not None
    when = _when_text(fail)
    assert "nvme_small_ns_devices | length == 0" in when
    assert "nvme_large_ns_devices | length == 0" in when
    assert "nvme_skip_failed_devices" not in when, (
        "an empty device set is not an individual-device failure — never skip-gated"
    )
    msg = str(fail["ansible.builtin.fail"].get("msg", ""))
    assert "xiraid_arrays" in msg and "nsid" in msg.lower()
    names = [t.get("name") for t in tasks if isinstance(t, dict)]
    banner = "Display namespace rebuild results"
    assert names.index(banner) < names.index(fail["name"]), (
        "the results banner must print before the empty-set fail"
    )


def test_converge_path_classifies_existing_namespaces_by_nsid():
    tasks = yaml.safe_load(DETECT_EXISTING.read_text())
    detect = _find_by_name(tasks, "Detect existing namespaces on data drives (by NSID)")
    assert detect is not None
    argv = _argv(detect)
    assert STAGED in argv and "list" in argv, argv

    build = _find_by_name(tasks, "Build namespace device lists from existing namespaces")
    assert build is not None
    facts = build["ansible.builtin.set_fact"]
    assert "'^1 /dev/'" in str(facts["nvme_small_ns_devices"]), "NSID 1 → small (log)"
    assert "'^([2-9]|[1-9][0-9]+) /dev/'" in str(facts["nvme_large_ns_devices"]), (
        "NSID ≥ 2 → large (data)"
    )


def test_topology_reads_lba_size_through_the_controller():
    tasks = yaml.safe_load(COLLECT_TOPOLOGY.read_text())
    lba = _find_by_name(tasks, "Get LBA format size per controller")
    assert lba is not None
    shell = _shell_text(lba)
    assert 'nvme id-ns "$controller" -n "$nsid"' in shell, (
        "lba_size must be queried by NSID through the controller, not via a named block device"
    )
    assert lba.get("loop") == "{{ nvme_existing_ns.results }}", (
        "the NSID comes from the list-ns pass, so the task must iterate its results"
    )
