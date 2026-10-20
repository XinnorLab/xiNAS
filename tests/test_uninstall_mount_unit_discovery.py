"""The uninstaller must find every .mount unit xiNAS writes, and nothing else.

Three writers create units in /etc/systemd/system under two Description=
prefixes. The day-1 raid_fs template and the TUI write "xiRAID Classic <leaf>".
The control path's fs.create writes "xiNAS <leaf>". The uninstaller used to
match only the first prefix. Phase C therefore destroyed arrays under mounted
control-path filesystems, and Phase D left their unit files on disk.

These tests run the role's real discovery shell (find_mount_units.yml,
rendered with the role defaults) over unit files produced by each writer and
over look-alikes that must stay untouched.

Spec: docs/Installer/uninstall-spec.md §4.3 step 2 and §4.4.1.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

from xinas_menu.utils.xfs_helpers import generate_mount_unit

jinja2 = pytest.importorskip("jinja2")

REPO = Path(__file__).resolve().parents[1]
ROLE = REPO / "collection/roles/xinas_uninstall"
DEFAULTS = ROLE / "defaults/main.yml"
FIND = ROLE / "tasks/find_mount_units.yml"
TEARDOWN = ROLE / "tasks/30_teardown_raid.yml"
MOUNTS = ROLE / "tasks/40_remove_mounts.yml"
DAY1_TEMPLATE = REPO / "collection/roles/raid_fs/templates/mount.unit.j2"
CP_UNIT_TS = REPO / "xiNAS-MCP/src/lib/fs/unit.ts"
CP_RAID_PARSE_TS = REPO / "xiNAS-MCP/src/lib/parse/raid.ts"

FIND_TASK = "Mounts | find xiNAS-generated mount units"
SHARED_FILE = "find_mount_units.yml"

BASH = shutil.which("bash")
needs_bash = pytest.mark.skipif(BASH is None, reason="the discovery task is a bash script")


# --- the role's discovery shell, run for real -------------------------------


def _discovery_script(unit_dir: Path) -> str:
    tasks = yaml.safe_load(FIND.read_text())
    task = next(t for t in tasks if t.get("name") == FIND_TASK)
    defaults = yaml.safe_load(DEFAULTS.read_text())
    # Ansible's Templar renders with trim_blocks=True.
    env = jinja2.Environment(trim_blocks=True, undefined=jinja2.StrictUndefined)
    template = env.from_string(task["ansible.builtin.shell"])
    return template.render(**{**defaults, "xinas_mount_unit_dir": str(unit_dir)})


def _discover(unit_dir: Path) -> list[str]:
    assert BASH is not None
    proc = subprocess.run(
        [BASH, "-c", _discovery_script(unit_dir)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"discovery failed: {proc.stderr}"
    return sorted(line for line in proc.stdout.splitlines() if line)


# --- unit text from each writer ---------------------------------------------


def _device_unit(path: str) -> str:
    return path.lstrip("/").replace("/", "-") + ".device"


def _render_day1(mountpoint: str, data_device: str, log_device: str) -> str:
    """raid_fs/templates/mount.unit.j2, fed the facts create_fs.yml computes."""
    env = jinja2.Environment()
    env.filters["regex_replace"] = lambda s, pattern, repl: re.sub(pattern, repl, s)
    return env.from_string(DAY1_TEMPLATE.read_text()).render(
        item={"mountpoint": mountpoint, "data_device": data_device, "log_device": log_device},
        block_device_unit=_device_unit(data_device),
        log_device_unit=_device_unit(log_device),
        unit_opts="defaults,noatime",
    )


def _control_path_prefix() -> str:
    """The Description= prefix renderMountUnit writes, read from its source."""
    match = re.search(r"`Description=([^`$]*)\$\{leaf\}`", CP_UNIT_TS.read_text())
    assert match, f"{CP_UNIT_TS.relative_to(REPO)}: no `Description=<prefix>${{leaf}}` line"
    return match.group(1)


def _render_control_path(mountpoint: str, what: str) -> str:
    """The shape renderMountUnit (xiNAS-MCP/src/lib/fs/unit.ts) emits."""
    leaf = mountpoint.rstrip("/").rsplit("/", 1)[-1]
    return "\n".join(
        [
            "[Unit]",
            f"Description={_control_path_prefix()}{leaf}",
            f"Requires={_device_unit(what)}",
            f"After={_device_unit(what)}",
            "Before=umount.target",
            "Conflicts=umount.target",
            "",
            "[Mount]",
            f"What={what}",
            f"Where={mountpoint}",
            "Options=defaults",
            "Type=xfs",
            "",
            "[Install]",
            "WantedBy=local-fs.target",
            "",
        ]
    )


def _unit(description: str | None, what: str | None) -> str:
    lines = ["[Unit]"]
    if description is not None:
        lines.append(f"Description={description}")
    lines += ["", "[Mount]"]
    if what is not None:
        lines.append(f"What={what}")
    lines += ["Where=/srv/x", "Type=xfs", ""]
    return "\n".join(lines)


# --- behaviour ---------------------------------------------------------------


@needs_bash
def test_finds_the_units_of_all_three_writers(tmp_path: Path):
    (tmp_path / "mnt-data.mount").write_text(
        _render_day1("/mnt/data", "/dev/xi_data", "/dev/xi_log")
    )
    (tmp_path / "mnt-tui.mount").write_text(
        generate_mount_unit("/mnt/tui", "/dev/xi_tui", "/dev/xi_tuilog", "noatime")
    )
    (tmp_path / "mnt-cp.mount").write_text(_render_control_path("/mnt/cp", "/dev/xi_cp"))

    assert _discover(tmp_path) == ["mnt-cp.mount", "mnt-data.mount", "mnt-tui.mount"]


@needs_bash
def test_the_xiraid_classic_rule_does_not_check_what(tmp_path: Path):
    """The shipped rule stays as it was: a day-1 unit over any data_device matches."""
    (tmp_path / "mnt-data.mount").write_text(
        _render_day1("/mnt/data", "/dev/nvme1n1", "/dev/nvme2n1")
    )

    assert _discover(tmp_path) == ["mnt-data.mount"]


LOOK_ALIKES: list[tuple[str, str]] = [
    ("xinas-prefix-other-device.mount", _unit("xiNAS backup", "/dev/sdb1")),
    ("xinas-prefix-no-what.mount", _unit("xiNAS backup", None)),
    ("xinas-no-space.mount", _unit("xiNASbackup", "/dev/xi_data")),
    ("foreign-desc-xi-device.mount", _unit("Site scratch", "/dev/xi_data")),
    ("no-description.mount", _unit(None, "/dev/xi_data")),
    ("xinas-api.service", _unit("xiNAS API", "/dev/xi_data")),
]


@needs_bash
def test_leaves_look_alikes_untouched(tmp_path: Path):
    for name, text in LOOK_ALIKES:
        (tmp_path / name).write_text(text)
    (tmp_path / "mnt-cp.mount").write_text(_render_control_path("/mnt/cp", "/dev/xi_cp"))

    assert _discover(tmp_path) == ["mnt-cp.mount"]


@needs_bash
def test_an_empty_unit_dir_yields_nothing(tmp_path: Path):
    assert _discover(tmp_path) == []


# --- the writers still produce what the rule expects ------------------------


def _signatures() -> list[dict[str, Any]]:
    return yaml.safe_load(DEFAULTS.read_text())["xinas_mount_unit_signatures"]


def test_control_path_prefix_is_covered_only_with_a_xiraid_what_guard():
    prefix = _control_path_prefix()
    covering = [s for s in _signatures() if prefix.startswith(s["description"])]
    assert covering, f"no signature covers the control path prefix {prefix!r}"
    assert all(s.get("what") == "/dev/xi_" for s in covering), (
        f"{prefix!r} is generic; every signature covering it must require What=/dev/xi_"
    )


def test_control_path_writes_the_array_volume_as_what():
    """The What= guard holds only while fs.create formats xiRAID volumes."""
    assert "`What=${input.what}`" in CP_UNIT_TS.read_text()
    assert "volume_path: `/dev/xi_${name}`" in CP_RAID_PARSE_TS.read_text()


# --- both phases act on the same discovered set -----------------------------


def _imports_shared_discovery(task: dict) -> bool:
    return task.get("ansible.builtin.import_tasks") == SHARED_FILE


def test_phase_c_stops_discovered_units_before_destroying_arrays():
    tasks = yaml.safe_load(TEARDOWN.read_text())
    block = next(t["block"] for t in tasks if "block" in t)
    names = [t.get("name") for t in block]

    discover = next(i for i, t in enumerate(block) if _imports_shared_discovery(t))
    stop = names.index("RAID | stop systemd mount units before raid delete")
    destroy = names.index("RAID | delete xiNAS-managed arrays")
    assert discover < stop < destroy
    assert block[stop]["loop"] == "{{ _xinas_mount_units }}"


def test_phase_d_removes_the_discovered_units():
    tasks = yaml.safe_load(MOUNTS.read_text())
    assert _imports_shared_discovery(tasks[0])
    by_name = {t.get("name"): t for t in tasks}
    for name in ("Mounts | stop xiNAS mount units", "Mounts | delete unit files"):
        assert by_name[name]["loop"] == "{{ _xinas_mount_units }}"


def test_the_retired_single_signature_has_no_consumer():
    offenders = [
        str(path.relative_to(REPO))
        for path in ROLE.rglob("*.yml")
        if re.search(r"\bxinas_mount_unit_signature\b", path.read_text())
    ]
    assert not offenders, f"still reads the retired variable: {offenders}"
