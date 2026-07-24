"""formatting.py — shared display helpers."""

from __future__ import annotations

import os
import re
from pathlib import Path

__all__ = ["format_link_speed", "grpc_short_error", "read_link_speed"]

_UNKNOWN_SPEED = "—"


def grpc_short_error(err: str) -> str:
    """Extract a human-readable one-liner from a verbose gRPC error string."""
    if not err:
        return "not connected"
    if "UNAVAILABLE" in err or "Connection refused" in err or "failed to connect" in err.lower():
        return "xiRAID service unavailable"
    if "UNAUTHENTICATED" in err:
        return "authentication failed"
    if "DEADLINE_EXCEEDED" in err or "Deadline" in err:
        return "timed out"
    if "stubs not available" in err:
        return err
    m = re.search(r'details\s*=\s*["\']([^"\']{1,120})', err)
    if m:
        return m.group(1)
    first = err.splitlines()[0] if err else err
    return first[:100]


def format_link_speed(raw: str | int | None, unknown: str = _UNKNOWN_SPEED) -> str:
    """Compact link-speed label ("100G", "1000M") for a sysfs ``speed`` value.

    The kernel reports ``-1`` when the driver cannot tell the link speed, and
    some drivers report ``0``; an interface can be operationally up in that
    state. Anything non-positive or unparseable renders as ``unknown`` rather
    than echoing the sentinel back as a speed.
    """
    try:
        mbit = int(str(raw).strip())
    except (TypeError, ValueError, AttributeError):
        return unknown
    if mbit <= 0:
        return unknown
    return f"{mbit // 1000}G" if mbit >= 1000 else f"{mbit}M"


def read_link_speed(iface_dir: str | os.PathLike, unknown: str = _UNKNOWN_SPEED) -> str:
    """Link-speed label for a ``/sys/class/net/<iface>`` directory.

    Unreadable ``speed`` attributes (absent on InfiniBand and bonded devices,
    ``EINVAL`` while the link is down) render as ``unknown``.
    """
    try:
        raw = (Path(iface_dir) / "speed").read_text().strip()
    except Exception:
        return unknown
    return format_link_speed(raw, unknown)
