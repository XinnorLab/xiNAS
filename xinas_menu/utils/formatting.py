"""formatting.py — shared display helpers."""
from __future__ import annotations

import re

__all__ = ["grpc_short_error"]


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
