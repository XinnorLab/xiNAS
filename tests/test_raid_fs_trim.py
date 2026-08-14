"""TRIM/discard is decided per array, from probes, and never breaks an old xicli.

`--discard 1` is what the installer sets (raid-spec §7.5). Per the xiRAID Classic
4.4 command reference it defaults to `0`, and enabling it requires every member to
support Deterministic Read Zero after TRIM (RZAT) — a stronger property than plain
discard support, so both are probed.

`--drive_trim` is deliberately NOT forced: it TRIMs the disks before creation and
xiRAID already enables it by default when RZAT holds *and no disk carries metadata*.
Forcing `1` overrides that second condition, which is the check that keeps a TRIM
from destroying recoverable data on a disk that still has metadata on it.

The decision expression is rendered from the role's real Jinja, the same way
tests/test_storage_state_fail_closed.py replays a set_fact chain.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

import jinja2
import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
ROLE_DEFAULTS = REPO / "collection/roles/raid_fs/defaults/main.yml"
CREATE_ARRAY = REPO / "collection/roles/raid_fs/tasks/create_array.yml"
RAID_FS_MAIN = REPO / "collection/roles/raid_fs/tasks/main.yml"
PRESETS = [
    REPO / "presets/default/raid_fs.yml",
    REPO / "presets/xinnorVM/raid_fs.yml",
]

SET_FACT_KEYS = ("set_fact", "ansible.builtin.set_fact")
ITEM = {
    "name": "data",
    "level": 5,
    "strip_size_kb": 128,
    "parity_disks": 1,
    "devices": ["/dev/nvme1n2", "/dev/nvme2n2", "/dev/nvme3n2"],
}


def _load(path: Path) -> Any:
    return yaml.safe_load(path.read_text())


def _ansible_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("yes", "on", "true", "1")
    return bool(value)


def _render(expr: Any, variables: dict) -> Any:
    if not isinstance(expr, str):
        return expr
    env = jinja2.Environment(undefined=jinja2.StrictUndefined)
    env.filters["bool"] = _ansible_bool
    rendered = env.from_string(expr).render(**variables).strip()
    try:
        return ast.literal_eval(rendered)
    except (ValueError, SyntaxError):
        return rendered


def _decide_trim(*, mode: str = "auto", unsupported: list[str] | None = None, cli: bool = True):
    """Replay create_array.yml's set_fact chain and return the TRIM decision."""
    variables: dict[str, Any] = {
        "item": ITEM,
        "xiraid_trim_mode": mode,
        "xiraid_trim_create_args": "--discard 1",
        "xiraid_force_metadata": True,
        "_xicli_trim_supported": cli,
        "_trim_probe": {"stdout_lines": unsupported or []},
    }
    decided: Any = None
    for task in _load(CREATE_ARRAY) or []:
        if not isinstance(task, dict):
            continue
        for key in SET_FACT_KEYS:
            facts = task.get(key)
            if isinstance(facts, dict):
                for name, expr in facts.items():
                    variables[name] = _render(expr, variables)
                    if name.endswith("_trim"):
                        decided = variables[name]
    assert decided is not None, "create_array.yml computes no TRIM decision fact"
    return decided


# ── The decision ──────────────────────────────────────────────────────────────


def test_auto_enables_trim_when_every_member_supports_discard():
    assert _decide_trim(mode="auto", unsupported=[]) is True


def test_auto_disables_trim_when_any_member_lacks_discard():
    assert _decide_trim(mode="auto", unsupported=["/dev/nvme2n2"]) is False


def test_off_never_enables_trim():
    assert _decide_trim(mode="off", unsupported=[]) is False


def test_on_forces_trim_past_the_probe():
    assert _decide_trim(mode="on", unsupported=["/dev/nvme2n2"]) is True


@pytest.mark.parametrize("mode", ["auto", "on"])
def test_unsupported_xicli_never_gets_the_flags(mode):
    """An older xicli rejects unknown arguments — that would fail every create."""
    assert _decide_trim(mode=mode, unsupported=[], cli=False) is False


# ── Wiring ────────────────────────────────────────────────────────────────────


def test_probe_reads_discard_max_bytes_per_member():
    text = CREATE_ARRAY.read_text()
    assert "discard_max_bytes" in text, "no per-member discard probe"
    assert "/sys/block/" in text


def test_probe_also_checks_rzat():
    """`--discard 1` needs Deterministic Read Zero after TRIM on every member.

    Plain discard support does not imply RZAT. On NVMe it is the DLFEAT field of
    the namespace (low 3 bits == 1 means deallocated blocks read back as zeroes);
    the kernel's old `discard_zeroes_data` sysfs attribute was removed in 4.12 and
    does not exist on the supported Ubuntu kernels.
    """
    text = CREATE_ARRAY.read_text()
    assert "dlfeat" in text.lower(), "no RZAT probe — --discard 1 may be rejected or unsafe"


def test_create_command_appends_the_trim_args_conditionally():
    tasks = _load(CREATE_ARRAY)
    create = next(
        (
            t
            for t in tasks
            if isinstance(t, dict) and str(t.get("name", "")).startswith("Create array")
        ),
        None,
    )
    assert create is not None, "no 'Create array' task"
    cmd = str(create.get("ansible.builtin.command") or create.get("command"))
    assert "xiraid_trim_create_args" in cmd, "create command never appends the TRIM flags"
    # The flags must sit behind the decision, not be pasted in unconditionally.
    decision_refs = [seg for seg in cmd.split("{%") if "xiraid_trim_create_args" in seg]
    assert decision_refs, "TRIM args are not inside a Jinja conditional"
    assert any("_trim" in seg for seg in decision_refs), (
        "TRIM args are not guarded by the per-array decision"
    )


def test_cli_support_is_probed_once_outside_the_per_array_loop():
    """`xicli raid create --help` is a node-level fact, not a per-array one."""
    text = RAID_FS_MAIN.read_text()
    assert "_xicli_trim_supported" in text, "CLI support is not established in main.yml"
    assert "--help" in text


def _cli_supported(*, args: str, help_stdout: str, rc: int = 0, mode: str = "auto"):
    """Replay main.yml's help-probe facts."""
    variables: dict[str, Any] = {
        "xiraid_trim_mode": mode,
        "xiraid_trim_create_args": args,
        "_xicli_create_help": {"rc": rc, "stdout": help_stdout},
    }
    for task in _load(RAID_FS_MAIN) or []:
        if not isinstance(task, dict):
            continue
        for key in SET_FACT_KEYS:
            facts = task.get(key)
            if isinstance(facts, dict) and any("trim" in name for name in facts):
                for name, expr in facts.items():
                    variables[name] = _render(expr, variables)
    return variables["_xicli_trim_supported"]


HELP_44 = "  --discard {0,1}   Enable discarding of unused blocks\n  --drive_trim {0,1}\n"


def test_help_probe_accepts_a_cli_that_advertises_the_flag():
    assert _cli_supported(args="--discard 1", help_stdout=HELP_44) is True


def test_help_probe_rejects_a_cli_missing_any_flag_in_the_args():
    """An override naming a flag this xicli lacks must disable TRIM, not fail the create."""
    assert _cli_supported(args="--discard 1 --nonesuch 1", help_stdout=HELP_44) is False


def test_help_probe_rejects_a_failed_help_call():
    assert _cli_supported(args="--discard 1", help_stdout="", rc=2) is False


# ── Defaults must survive preset-apply ────────────────────────────────────────


def _assert_trim_args(args: str, where: str) -> None:
    assert "--discard" in args, f"{where} does not enable discard: {args!r}"
    # xiRAID enables drive_trim itself only when RZAT holds AND no disk carries
    # metadata. Forcing it past that second condition TRIMs a disk whose data is
    # still recoverable (xiRAID Classic 4.4 command reference, --drive_trim).
    assert "--drive_trim" not in args, (
        f"{where} forces --drive_trim, overriding xiRAID's own metadata safety check: {args!r}"
    )


def test_role_defaults_declare_trim_knobs():
    data = _load(ROLE_DEFAULTS)
    assert data.get("xiraid_trim_mode") == "auto"
    _assert_trim_args(str(data.get("xiraid_trim_create_args", "")), "role default")


@pytest.mark.parametrize("preset", PRESETS, ids=lambda p: p.parent.name)
def test_presets_mirror_the_trim_knobs(preset):
    """A preset replaces the role's defaults wholesale — an unmirrored default is lost."""
    data = _load(preset)
    assert data.get("xiraid_trim_mode") == "auto", f"{preset} does not set xiraid_trim_mode"
    _assert_trim_args(str(data.get("xiraid_trim_create_args", "")), str(preset))
