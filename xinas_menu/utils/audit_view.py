"""Merge the local TUI audit.log with the control-path ``GET /audit`` trail.

xiNAS keeps two disjoint audit trails: the plain-text local log written by
``AuditLogger`` (TUI-direct actions) and the hash-chained control-path
trail (all API/MCP/CLI operations, e.g. ``share.create``). The View Audit
Log screen merges both so control-path activity is no longer invisible.

Pure functions, no I/O — the screen stays a thin caller and the merge is
unit-testable. See ``docs/Management/audit-log-spec.md``.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

_LOCAL_TS_FMT = "%Y-%m-%d %H:%M:%S"


def _local_epoch(line: str) -> float | None:
    """Epoch seconds from a local audit.log line's leading timestamp.

    Local lines start with ``YYYY-MM-DD HH:MM:SS`` (local time). Returns
    None when the prefix is not a timestamp (corrupt/torn line).
    """
    try:
        return time.mktime(time.strptime(line[:19], _LOCAL_TS_FMT))
    except (ValueError, OverflowError):
        return None


def _control_epoch(ts: Any) -> float | None:
    """Epoch seconds from a control-path timestamp (epoch ms or ISO-8601)."""
    if isinstance(ts, bool):
        return None
    if isinstance(ts, (int, float)):
        return float(ts) / 1000.0
    if isinstance(ts, str):
        s = ts.strip()
        if s.isdigit():
            return float(s) / 1000.0
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def format_control_row(row: dict[str, Any]) -> str:
    """Render one ``GET /audit`` row as the shared 5-column display line.

    ``YYYY-MM-DD HH:MM:SS | principal | kind | STATUS | client_type``.
    STATUS is ``FAIL`` when ``result_hash`` is present-and-empty (the
    ``AuditEntry`` convention for a failed op), otherwise ``OK``.
    """
    epoch = _control_epoch(row.get("timestamp"))
    ts = (
        time.strftime(_LOCAL_TS_FMT, time.localtime(epoch))
        if epoch is not None
        else "????-??-?? ??:??:??"
    )
    principal = str(row.get("principal") or "unknown")
    action = str(row.get("kind") or "?")
    status = "FAIL" if row.get("result_hash") == "" else "OK"
    detail = str(row.get("client_type") or "")
    line = f"{ts} | {principal} | {action} | {status}"
    if detail:
        line += f" | {detail}"
    return line


def merge_audit(
    local_lines: list[str],
    control_rows: list[dict[str, Any]],
    limit: int = 200,
) -> list[str]:
    """Merge both trails into one chronological (ascending) display list.

    Entries are keyed by epoch seconds. A local line whose timestamp
    cannot be parsed sinks to the end (treated as newest) so nothing is
    hidden. Only the most recent ``limit`` entries are returned.
    """
    keyed: list[tuple[float, int, str]] = []
    for order, line in enumerate(local_lines):
        epoch = _local_epoch(line)
        keyed.append((epoch if epoch is not None else float("inf"), order, line))
    base = len(local_lines)
    for order, row in enumerate(control_rows):
        epoch = _control_epoch(row.get("timestamp"))
        keyed.append(
            (epoch if epoch is not None else float("inf"), base + order, format_control_row(row))
        )
    keyed.sort(key=lambda t: (t[0], t[1]))
    lines = [line for _, _, line in keyed]
    if 0 <= limit < len(lines):
        lines = lines[-limit:]
    return lines
