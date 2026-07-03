"""Shared helper: extract a degraded-backend banner from an API envelope.

The observed-read list routes attach a DEGRADED_BACKEND_UNAVAILABLE warning
when their backing collector is errored (s8-clients-spec §5.1). Screens show
the message as a banner instead of a misleading "(no ... configured)".
"""

from __future__ import annotations

from typing import Any

_DEGRADED_CODE = "DEGRADED_BACKEND_UNAVAILABLE"


def degraded_banner(envelope: dict[str, Any]) -> str | None:
    """Return the degraded-backend message from an envelope's warnings, else None."""
    for warning in envelope.get("warnings") or []:
        if isinstance(warning, dict) and warning.get("code") == _DEGRADED_CODE:
            return str(warning.get("message") or "Backend unavailable")
    return None
