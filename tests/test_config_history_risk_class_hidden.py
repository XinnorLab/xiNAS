"""The risk class is classified and stored, but NOT rendered in the TUI.

Every row read `destroying_data` — including a `cpu_allowed` edit — because
two fail-safes fire on ordinary operations (specs.md §10 note, docs/TODO.md).
An all-red column carries no signal and trains the operator to click past the
confirmation it exists to gate, so the display is suppressed until the
classification is fixed.

These tests pin the *absence* of the rendering, not the absence of the data:
`rollback_class` must still reach the screen layer untouched.
"""

from __future__ import annotations

import re

from xinas_menu.screens.config_history import _append_snapshot_row, _format_history

_SNAP = {
    "id": "20260815T192652683277Z-raid-modify",
    "timestamp": "2026-08-15T19:26:52",
    "operation": "raid_modify",
    "status": "applied",
    "rollback_class": "destroying_data",
    "diff_summary": "Modified array 'log': cpu_allowed=0-63",
}


def _plain(text: str) -> str:
    return re.sub(r"\033\[[0-9;]*m", "", text)


def test_row_does_not_render_the_class() -> None:
    lines: list[str] = []
    _append_snapshot_row(lines, 1, _SNAP)
    out = _plain("\n".join(lines))

    assert "destroying_data" not in out
    # The row still carries everything an operator navigates by.
    assert "raid_modify" in out
    assert "applied" in out
    assert "Modified array 'log': cpu_allowed=0-63" in out


def test_no_class_for_any_of_the_three_levels() -> None:
    for cls in ("destroying_data", "changing_access", "non_disruptive"):
        lines: list[str] = []
        _append_snapshot_row(lines, 1, {**_SNAP, "rollback_class": cls})
        assert cls not in _plain("\n".join(lines))


def test_summary_header_has_no_risk_column() -> None:
    out = _plain(
        _format_history(
            {
                "total_count": 1,
                "rollback_eligible_count": 1,
                "baseline": _SNAP,
                "snapshots": [_SNAP],
                "current_effective": _SNAP,
            }
        )
    )

    assert "Risk Class" not in out
    assert "destroying_data" not in out
    # Header columns that stay.
    assert "Timestamp" in out
    assert "Operation" in out
    assert "Status" in out


def test_long_control_path_operation_does_not_collide_with_status() -> None:
    """`xiraid.array.modify` is 19 chars; at the old 18-wide column it ran
    into Status and rendered as "xiraid.array.modifyapplied"."""
    lines: list[str] = []
    _append_snapshot_row(lines, 1, {**_SNAP, "operation": "xiraid.array.modify"})
    out = _plain("\n".join(lines))

    assert "xiraid.array.modifyapplied" not in out
    assert "xiraid.array.modify " in out


def test_over_long_operation_is_truncated_not_wrapped() -> None:
    lines: list[str] = []
    _append_snapshot_row(lines, 1, {**_SNAP, "operation": "x" * 40})
    out = _plain("\n".join(lines))

    assert "x" * 40 not in out
    assert "…" in out
