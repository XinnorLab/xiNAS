"""Minimum RAID member counts must agree across every surface.

xiRAID Classic enforces stricter minimums than textbook RAID math (RAID 5 needs
4 members, RAID 50/60 need 8). Three places encode that table independently —
the TUI Create Array wizard, the control-path constraint table, and the
installer's auto-generated arrays — and they disagreed until review finding #4:
the installer and the control path both allowed a 3-drive RAID 5 that the engine
rejects at `xicli raid create`, i.e. after the namespaces had been rebuilt.

`docs/Storage/raid-management-spec.md` §4 owns the numbers. These tests pin every
surface to that table so a future edit cannot silently re-diverge.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
SCHEMA_TS = REPO / "xiNAS-MCP/src/lib/xiraid/schema.ts"
ROLE = REPO / "collection/roles/nvme_namespace"
DEFAULTS = ROLE / "defaults/main.yml"
GENERATE = ROLE / "tasks/generate_raid_config.yml"
VM_PRESET = REPO / "presets/xinnorVM/nvme_namespace.yml"
STORAGE_SPEC = REPO / "docs/Storage/raid-management-spec.md"

# The engine-enforced table, keyed by bare level number. This literal is the
# test's own copy on purpose: if someone relaxes a minimum they must edit this
# file too, which makes the change visible in review.
STRICT_MINIMUMS = {"0": 2, "1": 2, "5": 4, "6": 4, "10": 4, "50": 8, "60": 8}

# Levels the strict table shares with the control path's wider level list
# (which also carries raid7/raid70/n+m, outside the TUI + installer surface).
TS_LEVEL_NAMES = {f"raid{level}": level for level in STRICT_MINIMUMS}


def _ts_min_drives() -> dict[str, int]:
    """Parse `LEVEL_CONSTRAINTS` minDrives out of schema.ts."""
    text = SCHEMA_TS.read_text()
    table = re.search(
        r"LEVEL_CONSTRAINTS:\s*Record<Level,\s*LevelConstraints>\s*=\s*\{(.*?)\n\};",
        text,
        re.DOTALL,
    )
    assert table, "LEVEL_CONSTRAINTS table not found in schema.ts"
    found = dict(
        re.findall(r"'?([\w+]+)'?:\s*\{\s*minDrives:\s*(\d+)", table.group(1)),
    )
    assert found, "no minDrives entries parsed from LEVEL_CONSTRAINTS"
    return {name: int(value) for name, value in found.items()}


def _role_defaults() -> dict:
    return yaml.safe_load(DEFAULTS.read_text())


def _generate_tasks() -> list:
    return yaml.safe_load(GENERATE.read_text())


def _iter_tasks(tasks):
    for task in tasks or []:
        if not isinstance(task, dict):
            continue
        yield task
        if isinstance(task.get("block"), list):
            yield from _iter_tasks(task["block"])


# ── TUI Create Array wizard ──────────────────────────────────────────────────


def test_tui_table_matches_the_strict_minimums():
    from xinas_menu.screens.raid import _RAID_LEVELS, _RAID_MIN_DRIVES

    assert _RAID_MIN_DRIVES == STRICT_MINIMUMS
    # Every level the wizard offers must have an entry, or the operator gets no
    # pre-validation at all for that level.
    assert set(_RAID_LEVELS) <= set(_RAID_MIN_DRIVES)


def test_tui_rejects_under_count_and_accepts_the_minimum():
    from xinas_menu.screens.raid import _min_drives_error

    for level, minimum in STRICT_MINIMUMS.items():
        assert _min_drives_error(level, minimum) is None, level
        assert _min_drives_error(level, minimum + 1) is None, level
        message = _min_drives_error(level, minimum - 1)
        assert message is not None, f"RAID {level} accepted {minimum - 1} drives"
        # The message has to be actionable: name the level, the floor, and the
        # count actually selected.
        assert f"RAID {level}" in message
        assert str(minimum) in message
        assert str(minimum - 1) in message


def test_tui_rejects_the_textbook_raid5_and_raid50_counts():
    """The exact layouts that used to sail through to the engine."""
    from xinas_menu.screens.raid import _min_drives_error

    assert _min_drives_error("5", 3) is not None
    assert _min_drives_error("50", 6) is not None


def test_tui_never_blocks_a_level_it_cannot_reason_about():
    from xinas_menu.screens.raid import _min_drives_error

    # Unknown level → fall back to 2 and leave the engine as the backstop,
    # rather than blocking a layout the wizard has no opinion on.
    assert _min_drives_error("70", 2) is None
    assert _min_drives_error("70", 1) is not None


# ── Control path ─────────────────────────────────────────────────────────────


def test_control_path_table_matches_the_strict_minimums():
    ts = _ts_min_drives()
    for ts_name, level in TS_LEVEL_NAMES.items():
        assert ts_name in ts, f"{ts_name} missing from LEVEL_CONSTRAINTS"
        assert ts[ts_name] == STRICT_MINIMUMS[level], (
            f"{ts_name} minDrives={ts[ts_name]}, strict table says {STRICT_MINIMUMS[level]}"
        )


# ── Installer ────────────────────────────────────────────────────────────────


def test_role_defaults_carry_the_strict_table():
    table = _role_defaults().get("nvme_raid_min_devices")
    assert isinstance(table, dict), "nvme_raid_min_devices must be a level→count mapping"
    # YAML keys parse as ints; compare on a normalised form.
    assert {str(k): int(v) for k, v in table.items()} == STRICT_MINIMUMS


def test_removed_scalar_knobs_are_gone_from_defaults_and_presets():
    """The per-level scalars are what let the two surfaces drift apart."""
    defaults = _role_defaults()
    for removed in ("nvme_min_devices_for_raid5", "nvme_min_devices_for_raid10"):
        assert removed not in defaults, f"{removed} still defined in role defaults"
        assert removed not in VM_PRESET.read_text(), f"{removed} still set in the xinnorVM preset"


def test_generate_raid_config_validates_from_the_table():
    assert "nvme_raid_min_devices" in GENERATE.read_text()

    tasks = list(_iter_tasks(_generate_tasks()))
    facts = [t for t in tasks if "ansible.builtin.set_fact" in t]

    # The removed scalars may only survive inside the deprecation guard (asserted
    # separately below) — never in a fact expression or a `when:`.
    live = yaml.safe_dump([t for t in tasks if "ansible.builtin.assert" not in t])
    for removed in ("nvme_min_devices_for_raid5", "nvme_min_devices_for_raid10"):
        assert removed not in live, f"{removed} still drives logic in generate_raid_config.yml"

    def _sets(var: str) -> list[dict]:
        return [t for t in facts if var in (t["ansible.builtin.set_fact"] or {})]

    for min_var, level_var in (
        ("_data_min_devices", "nvme_raid_data_level"),
        ("_log_min_devices", "nvme_raid_log_level"),
    ):
        setters = _sets(min_var)
        assert len(setters) == 1, f"{min_var} is set by {len(setters)} tasks; expected one"
        expr = str(setters[0]["ansible.builtin.set_fact"][min_var])
        assert "nvme_raid_min_devices" in expr, expr
        assert level_var in expr, expr
        assert "nvme_raid_min_devices_default" in expr, f"{min_var} has no fallback: {expr}"
        assert "when" not in setters[0], f"the {min_var} lookup must not be level-gated"

    for var, count_var, min_var in (
        ("nvme_can_create_data_raid", "nvme_large_ns_count", "_data_min_devices"),
        ("nvme_can_create_log_raid", "nvme_small_ns_count", "_log_min_devices"),
    ):
        setters = _sets(var)
        assert setters, f"nothing sets {var}"
        # Exactly one unconditional comparison — the old code had a per-level
        # cascade of `when:`-guarded branches with a >= 2 fallback for anything
        # it did not recognise, which is how RAID 50/60 got a 2-drive floor.
        assert len(setters) == 1, f"{var} is set by {len(setters)} tasks; expected a single check"
        expr = str(setters[0]["ansible.builtin.set_fact"][var])
        assert min_var in expr, expr
        assert count_var in expr, expr
        assert "when" not in setters[0], f"the {var} check must not be level-gated"

    # The play must still hard-fail (not just warn) when a check comes up short.
    fails = [t for t in tasks if "ansible.builtin.fail" in t]
    assert fails, "generate_raid_config.yml no longer fails on insufficient devices"


def test_removed_knobs_fail_loudly_if_an_old_inventory_still_sets_them():
    """A silently ignored override is the same class of bug as the drift itself."""
    tasks = list(_iter_tasks(_generate_tasks()))
    asserts = [t for t in tasks if "ansible.builtin.assert" in t]
    assert asserts, "no deprecation guard for the removed nvme_min_devices_for_* knobs"
    joined = yaml.safe_dump(asserts)
    assert "nvme_min_devices_for_raid5" in joined
    assert "nvme_min_devices_for_raid10" in joined


# ── Spec ─────────────────────────────────────────────────────────────────────


def test_spec_table_matches_the_code():
    """docs/Storage/raid-management-spec.md §4 owns these numbers."""
    text = STORAGE_SPEC.read_text()
    section = text.split("Engine-enforced minimum drive counts", 1)
    assert len(section) == 2, "the minimum-drive-counts section is missing"
    body = section[1]

    documented: dict[str, int] = {}
    for row in re.finditer(r"^\|\s*([\d,\s]+?)\s*\|[^|]*\|\s*\**(\d+)\**\s*\|", body, re.MULTILINE):
        for level in row.group(1).split(","):
            documented[level.strip()] = int(row.group(2))
    assert documented == STRICT_MINIMUMS, documented

    # The provenance note is load-bearing: these numbers came from the engine's
    # rejection messages on a specific xiRAID version, not from its --help.
    assert "xiRAID-version-specific" in body
    assert "rejection messages" in body
    assert "xicli raid create --help" in body
