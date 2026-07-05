"""View Audit Log merge helper — unify local audit.log with control-path GET /audit.

See docs/Management/audit-log-spec.md.
"""

from __future__ import annotations

import time

from xinas_menu.utils.audit_view import format_control_row, merge_audit


def _epoch_ms(local_str: str) -> int:
    """Local-time 'YYYY-MM-DD HH:MM:SS' → epoch milliseconds (TZ-agnostic test aid)."""
    return int(time.mktime(time.strptime(local_str, "%Y-%m-%d %H:%M:%S")) * 1000)


def _expected_ts(epoch_ms: int) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch_ms / 1000))


def test_format_control_row_maps_share_create_to_display_line():
    ms = _epoch_ms("2026-07-05 14:15:00")
    row = {
        "kind": "share.create",
        "timestamp": ms,
        "principal": "root",
        "client_type": "mcp",
        "result_hash": "abc123",
    }
    line = format_control_row(row)
    assert line == f"{_expected_ts(ms)} | root | share.create | OK | mcp"


def test_format_control_row_empty_result_hash_is_fail():
    ms = _epoch_ms("2026-07-05 14:15:00")
    row = {
        "kind": "share.create",
        "timestamp": ms,
        "principal": "root",
        "client_type": "rest",
        "result_hash": "",
    }
    assert " | FAIL | " in format_control_row(row)


def test_format_control_row_missing_principal_falls_back_to_unknown():
    ms = _epoch_ms("2026-07-05 14:15:00")
    line = format_control_row({"kind": "share.delete", "timestamp": ms})
    assert line.split(" | ")[1] == "unknown"


def test_format_control_row_accepts_iso_timestamp():
    row = {"kind": "share.create", "timestamp": "2026-07-05T14:15:00Z", "principal": "root"}
    line = format_control_row(row)
    # Renders a concrete local datetime, not the raw ISO string.
    assert line.startswith("2026-07-05 ") or line.startswith("2026-07-0")
    assert "T" not in line.split(" | ")[0]


def test_merge_interleaves_by_timestamp_ascending():
    local = [
        "2026-07-05 11:39:11 | root | user.create | OK | rufat",
        "2026-07-05 14:20:00 | root | user.delete | OK | bobr",
    ]
    control = [
        {
            "kind": "share.create",
            "timestamp": _epoch_ms("2026-07-05 13:00:00"),
            "principal": "root",
            "client_type": "mcp",
            "result_hash": "h",
        }
    ]
    merged = merge_audit(local, control, limit=200)
    actions = [seg[2] for seg in (line.split(" | ") for line in merged)]
    assert actions == ["user.create", "share.create", "user.delete"]


def test_merge_keeps_only_most_recent_when_over_limit():
    local = [
        "2026-07-05 10:00:00 | root | user.create | OK | a",
        "2026-07-05 11:00:00 | root | user.create | OK | b",
    ]
    control = [
        {
            "kind": "share.create",
            "timestamp": _epoch_ms("2026-07-05 12:00:00"),
            "principal": "root",
            "client_type": "mcp",
            "result_hash": "h",
        }
    ]
    merged = merge_audit(local, control, limit=2)
    assert len(merged) == 2
    # newest two survive: 11:00 user.create + 12:00 share.create
    assert [line.split(" | ")[2] for line in merged] == ["user.create", "share.create"]


def test_merge_empty_control_returns_local_only():
    local = ["2026-07-05 11:39:11 | root | user.create | OK | rufat"]
    assert merge_audit(local, [], limit=200) == local


def test_merge_empty_local_returns_control_lines():
    control = [
        {
            "kind": "share.create",
            "timestamp": _epoch_ms("2026-07-05 13:00:00"),
            "principal": "root",
            "client_type": "mcp",
            "result_hash": "h",
        }
    ]
    merged = merge_audit([], control, limit=200)
    assert len(merged) == 1
    assert merged[0].split(" | ")[2] == "share.create"


def test_merge_preserves_unparseable_local_line_at_end():
    local = [
        "2026-07-05 11:00:00 | root | user.create | OK | a",
        "### corrupt line no timestamp ###",
    ]
    control = [
        {
            "kind": "share.create",
            "timestamp": _epoch_ms("2026-07-05 12:00:00"),
            "principal": "root",
            "client_type": "mcp",
            "result_hash": "h",
        }
    ]
    merged = merge_audit(local, control, limit=200)
    assert "### corrupt line no timestamp ###" in merged
    # corrupt (unparseable) line sinks to the end, real entries stay ordered
    assert merged[-1] == "### corrupt line no timestamp ###"
    assert [line.split(" | ")[2] for line in merged[:2]] == ["user.create", "share.create"]
