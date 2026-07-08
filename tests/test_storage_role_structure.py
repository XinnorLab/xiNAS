"""Structural regression guards for small storage-role residuals (WS1-R1..R4).

These pin narrow fixes over the raid_fs and nvme_namespace roles:

- raid_fs must not carry the dead "Find active MD RAID arrays" task (it used
  ``ansible.builtin.command`` with a shell pipe, which the command module
  never interprets — it always errored and its result was never consumed).
- inventories/lab.ini must not pin the deprecated/disarmed
  ``xfs_force_mkfs`` knob at the inventory level.
- nvme_namespace's "Track failed namespace deletions" task must always
  record a delete failure in ``nvme_failed_devices``, regardless of
  ``nvme_skip_failed_devices`` — otherwise "skip failed devices" mode never
  populates the list the downstream create/attach/wait tasks gate on.
- nvme_namespace's partition-table wipe must operate on resolved *block*
  devices guarded by the boundary-safe ``is_data_member`` helper — never on
  the raw ``nvme_data_drives`` entries, which in the default NVMe mode are
  controller char devices (``/dev/nvme0``) on which ``wipefs``/``dd``/
  ``partprobe`` silently no-op.
- nvme_namespace's existing-namespace detection must not silently reinterpret
  an n1-only (single-namespace) layout as "data" — that fallback was dead
  (the downstream RAID-config gate requires both n1 and n2+ anyway) and it
  masked the real cause of the later generic failure. It must fail explicitly
  and name the remedies (WS1-R4).
- nvme_namespace's cleanup sweeps must fail loudly-but-safely (not with a
  command-not-found cascade) when the staged ``xinas_disk_match.sh`` helper
  is missing, and the wipe-scope disclosure must also reach the always-shown
  banner, not just the confirmation prompt that unattended runs skip.

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
NVME_NAMESPACE_TASKS_DIR = REPO / "collection/roles/nvme_namespace/tasks"
LAB_INVENTORY = REPO / "inventories/lab.ini"
REBUILD_NAMESPACES = NVME_NAMESPACE_TASKS_DIR / "rebuild_namespaces.yml"
CLEANUP_STORAGE = NVME_NAMESPACE_TASKS_DIR / "cleanup_storage.yml"
DETECT_EXISTING_NAMESPACES = NVME_NAMESPACE_TASKS_DIR / "detect_existing_namespaces.yml"


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


def test_storage_command_tasks_never_pipe_shell_syntax_to_command_module():
    """`ansible.builtin.command` never interprets `|`; only shell tasks may pipe.

    Jinja expressions legitimately use `|` for filters (e.g. `{{ x | bool }}`),
    so those are stripped before checking for a literal shell pipe. Covers both
    storage roles' task dirs (raid_fs and nvme_namespace).
    """
    paths = sorted(RAID_FS_TASKS_DIR.glob("*.yml")) + sorted(NVME_NAMESPACE_TASKS_DIR.glob("*.yml"))
    for path in paths:
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


def _shell_text(task: dict) -> str:
    shell = task.get("ansible.builtin.shell")
    if shell is None:
        return ""
    return shell if isinstance(shell, str) else str(shell.get("cmd", ""))


def test_wipe_partition_tables_resolves_block_devices_via_is_data_member():
    """The wipe must resolve real block devices through the boundary-safe helper.

    In the default NVMe mode ``nvme_data_drives`` holds controller char devices
    (``/dev/nvme0``); wiping ``{{ item }}`` directly is a silent no-op there.
    The enumeration itself is pinned too: iterating ``$DATA_DRIVES`` directly
    would pass the is_data_member assertions (the helper accepts raw controller
    entries by identity) yet reintroduce the char-device no-op — targets must
    come from an lsblk enumeration and each be verified a block device.
    """
    tasks = yaml.safe_load(CLEANUP_STORAGE.read_text())
    wipe = _find_by_name(tasks, "Wipe partition tables on data drives")
    assert wipe is not None, "wipe task missing from cleanup_storage.yml"
    shell = _shell_text(wipe)
    assert "wipefs" in shell
    assert "/tmp/xinas_disk_match.sh" in shell, "wipe must source the disk-match helper"
    assert "is_data_member" in shell, "wipe must gate targets through is_data_member"
    assert "{{ item }}" not in shell, (
        "wipe must not operate on the bare loop item (a controller char device "
        "in NVMe mode) — it must enumerate resolved block devices"
    )
    assert "lsblk" in shell, "wipe targets must be enumerated via lsblk, not $DATA_DRIVES"
    assert '[ -b "$dev" ]' in shell, "each wipe target must be verified a block device"


def test_wipe_last_mb_size_computation_is_per_device_safe():
    """One flaky device must not abort the wipe for the remaining drives.

    An inline ``seek=$(($(blockdev --getsz "$dev") / 2048 - 1))`` is a FATAL
    bash arithmetic error when blockdev emits nothing (device vanished after
    the ``[ -b ]`` check): the whole while-loop dies, remaining drives get no
    wipe/partprobe, and failed_when:false masks it. The size must be captured
    into a validated variable first, with the last-MB dd guarded on it.
    """
    tasks = yaml.safe_load(CLEANUP_STORAGE.read_text())
    wipe = _find_by_name(tasks, "Wipe partition tables on data drives")
    assert wipe is not None, "wipe task missing from cleanup_storage.yml"
    shell = _shell_text(wipe)
    assert "seek=$(($(blockdev" not in shell, (
        "inline blockdev substitution inside arithmetic is a fatal shell error "
        "on empty output — it aborts the whole wipe loop, not just this device"
    )
    assert 'sz=$(blockdev --getsz "$dev" 2>/dev/null || echo 0)' in shell, (
        "device size must be captured defensively into a variable"
    )
    assert "sz=0" in shell, "empty/non-numeric size must be normalized to 0"
    assert '[ "$sz" -gt 2048 ]' in shell, "the last-MB dd must be guarded on a sane device size"


def test_zfs_detection_resolves_vdevs_via_full_paths():
    """ZFS vdev matching must not depend on device-name prefixes.

    ``grep -E '^\\s+(nvme|sd)'`` over plain ``zpool status`` is blind to pools
    on /dev/vdX (the xinnorVM device type) or by-id vdevs: the pool goes
    undetected, the box classifies EMPTY, and raid_fs later consumes the pool
    disks with no prompt. Vdevs must be resolved to real full paths
    (``zpool status -LP``) and each filtered through is_data_member.
    """
    tasks = yaml.safe_load(CLEANUP_STORAGE.read_text())
    zfs = _find_by_name(tasks, "Check for ZFS pools using data drives")
    assert zfs is not None, "ZFS detection task missing from cleanup_storage.yml"
    shell = _shell_text(zfs)
    assert "-LP" in shell, (
        "zpool status must resolve vdevs to full real paths (-L follows "
        "symlinks, -P prints full paths)"
    )
    assert "is_data_member" in shell, "each vdev must be filtered through is_data_member"
    assert "(nvme|sd)" not in shell, (
        "device-name-prefix matching misses vd*/by-id vdevs — match on resolved /dev/ paths instead"
    )


def test_partprobe_runs_on_resolved_devices_not_raw_entries():
    """partprobe on a raw controller entry (/dev/nvme0) is a masked no-op.

    Asserted against the resolved wipe task's shell text specifically (not the
    raw file text), so a mention of "partprobe" in a comment elsewhere in the
    file can't satisfy this.
    """
    tasks = yaml.safe_load(CLEANUP_STORAGE.read_text())
    wipe = _find_by_name(tasks, "Wipe partition tables on data drives")
    assert wipe is not None, "wipe task missing from cleanup_storage.yml"
    shell = _shell_text(wipe)
    assert "partprobe" in shell, "kernel partition-table re-read must still happen"
    assert "partprobe {{ item }}" not in shell, (
        "partprobe must target resolved block devices, not raw nvme_data_drives entries"
    )


def test_cleanup_confirmation_banner_discloses_partition_wipe():
    tasks = yaml.safe_load(CLEANUP_STORAGE.read_text())
    prompt_task = _find_by_name(tasks, "Prompt for cleanup confirmation")
    assert prompt_task is not None
    pause = prompt_task.get("ansible.builtin.pause") or {}
    prompt = str(pause.get("prompt", ""))
    assert "nvme_data_drives" in prompt and "wiped" in prompt.lower(), (
        "the YES-confirmation banner must disclose that partition signatures on "
        "all data drives get wiped"
    )


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


# ── WS1-R4: dead single-namespace fallback replaced by an explicit fail ──────


def test_no_dead_single_namespace_fallback():
    """The old fallback silently emptied nvme_small_ns_devices and reassigned
    it to nvme_large_ns_devices. It never actually reached a working converge
    (the downstream RAID-config gate requires both lists non-empty), so it
    only masked the real cause of a later generic failure.
    """
    tasks = yaml.safe_load(DETECT_EXISTING_NAMESPACES.read_text())
    assert _find_by_name(tasks, "Use n1 namespaces for data if no n2 found") is None, (
        "detect_existing_namespaces.yml still carries the dead single-namespace "
        "fallback that silently reassigns nvme_large_ns_devices"
    )


def test_single_namespace_layout_fails_explicitly():
    tasks = yaml.safe_load(DETECT_EXISTING_NAMESPACES.read_text())
    fail_tasks = [t for t in _iter_tasks(tasks) if t.get("ansible.builtin.fail")]
    assert fail_tasks, (
        "detect_existing_namespaces.yml must fail explicitly on a single-namespace layout"
    )
    matches = [
        t
        for t in fail_tasks
        if "nvme_large_ns_devices | length == 0" in _when_text(t)
        and "nvme_small_ns_devices | length > 0" in _when_text(t)
    ]
    assert matches, (
        "no fail task guards on (no n2+ found, some n1 found) — a single-namespace "
        "layout must fail loudly instead of silently reassigning facts"
    )
    msg = str(matches[0]["ansible.builtin.fail"].get("msg", ""))
    assert "xinas_storage_reset" in msg, (
        "failure message should name the remedy (xinas_storage_reset=true)"
    )


# ── Code-review follow-ups on cleanup_storage.yml ────────────────────────────


def test_cleanup_sweeps_guard_missing_disk_match_helper():
    """Every is_data_member sweep must fail loud-but-safe if the helper is missing.

    A bare `source /tmp/xinas_disk_match.sh` on a missing file would cascade
    into a wall of "command not found" errors for is_data_member instead of a
    single clear message, while still silently no-op'ing (failed_when: false).

    The guard message must go to STDERR: the detection sweeps register stdout
    and parse stdout_lines into nvme_found_* facts, so a guard echo on stdout
    would be misread as a found PV/array/pool — fabricating a finding and
    flipping nvme_cleanup_required to true.
    """
    tasks = yaml.safe_load(CLEANUP_STORAGE.read_text())
    sweep_tasks = [t for t in _iter_tasks(tasks) if "is_data_member" in _shell_text(t)]
    assert sweep_tasks, "expected at least one is_data_member sweep task in cleanup_storage.yml"
    for t in sweep_tasks:
        shell = _shell_text(t)
        assert "helper missing" in shell, (
            f"{t.get('name')!r} sources xinas_disk_match.sh without a helper-missing guard"
        )
        for line in (ln for ln in shell.splitlines() if "helper missing" in ln):
            assert ">&2" in line, (
                f"{t.get('name')!r}: guard echo must redirect to stderr — on stdout "
                "it pollutes the registered detection output and fabricates findings"
            )


def test_display_findings_banner_discloses_partition_wipe_for_unattended_runs():
    """The always-shown banner must carry the wipe-scope disclosure too.

    The YES-confirmation pause (and its disclosure) is skipped entirely when
    nvme_skip_cleanup_confirmation=true, so unattended/automation logs only
    ever see the unconditional "Display detected storage configurations"
    banner — it must carry the same information.
    """
    tasks = yaml.safe_load(CLEANUP_STORAGE.read_text())
    banner = _find_by_name(tasks, "Display detected storage configurations")
    assert banner is not None
    msg = str((banner.get("ansible.builtin.debug") or {}).get("msg", ""))
    assert "nvme_data_drives" in msg and "wiped" in msg.lower(), (
        "the always-shown banner must disclose that partition signatures on all "
        "data drives get wiped, since the YES-prompt version of this disclosure "
        "is skipped when nvme_skip_cleanup_confirmation=true"
    )
