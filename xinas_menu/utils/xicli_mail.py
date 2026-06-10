"""xiRAID mail notification helpers — async gRPC via XiRAIDClient.

All public functions are async and return the same (ok, data, error) tuples
used elsewhere in xinas_menu.  ``mail_send_test`` is the only CLI fallback
(no gRPC RPC exists for it).
"""

from __future__ import annotations

import logging
from typing import Any

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Shared client instance (lazy)
# ---------------------------------------------------------------------------

_client = None


def _get_client():
    global _client
    if _client is None:
        from xinas_menu.api.grpc_client import XiRAIDClient

        _client = XiRAIDClient()
    return _client


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------


async def grpc_available() -> bool:
    """Return *True* if the xiRAID gRPC daemon is reachable."""
    client = _get_client()
    ok, _data, _err = await client.license_show()
    return ok


# ---------------------------------------------------------------------------
# mail show / add / remove / send
# ---------------------------------------------------------------------------


async def mail_show() -> tuple[bool, list[dict[str, str]], str]:
    """Return the list of notification recipients.

    Returns:
        (ok, receivers, error)  where each receiver is
        ``{"address": str, "level": str}``.
    """
    client = _get_client()
    ok, data, err = await client.mail_show()
    if not ok:
        return False, [], err
    receivers = _extract_receivers(data)
    return True, receivers, ""


async def mail_add(address: str, level: str) -> tuple[bool, str]:
    """Add *address* with notification *level* (info/warning/error)."""
    client = _get_client()
    ok, _data, err = await client.mail_add(address, level)
    return ok, err


async def mail_remove(address: str) -> tuple[bool, str]:
    """Remove *address* from the notification list."""
    client = _get_client()
    ok, _data, err = await client.mail_remove(address)
    return ok, err


async def mail_send_test() -> tuple[bool, str]:
    """Send a test notification email via xiRAID.

    No gRPC RPC exists for this — falls back to ``xicli mail send``.
    """
    import asyncio

    from xinas_menu.utils.subprocess_utils import run_cmd

    loop = asyncio.get_running_loop()
    ok, _out, err = await loop.run_in_executor(
        None,
        lambda: run_cmd("xicli", "mail", "send"),
    )
    return ok, err


# ---------------------------------------------------------------------------
# settings mail show / modify
# ---------------------------------------------------------------------------


async def settings_mail_show() -> tuple[bool, dict[str, Any], str]:
    """Return mail polling settings.

    Returns:
        (ok, settings_dict, error)  where *settings_dict* has
        ``polling_interval`` (seconds) and ``progress_polling_interval``
        (minutes).
    """
    client = _get_client()
    ok, data, err = await client.settings_mail_show()
    if not ok:
        return False, {}, err
    settings = _extract_settings(data)
    return True, settings, ""


async def settings_mail_modify(
    polling_interval: int | None = None,
    progress_polling_interval: int | None = None,
) -> tuple[bool, str]:
    """Modify mail polling intervals."""
    client = _get_client()
    ok, _data, err = await client.settings_mail_modify(
        polling_interval=polling_interval,
        progress_polling_interval=progress_polling_interval,
    )
    return ok, err


# ---------------------------------------------------------------------------
# Response extractors
# ---------------------------------------------------------------------------


def _extract_receivers(data: Any) -> list[dict[str, str]]:
    """Extract receivers from gRPC ResponseMessage JSON payload."""
    if data is None:
        return []
    if isinstance(data, list):
        return [
            {"address": r.get("address", r.get("email", "")), "level": r.get("level", "unknown")}
            for r in data
            if isinstance(r, dict)
        ]
    if isinstance(data, dict):
        for key in ("receivers", "data", "result"):
            if isinstance(data.get(key), list):
                return _extract_receivers(data[key])
        # Map of address → level
        if all(isinstance(v, str) for v in data.values()):
            return [{"address": k, "level": v} for k, v in data.items()]
    return []


def _extract_settings(data: Any) -> dict[str, Any]:
    """Extract polling settings from gRPC ResponseMessage JSON payload."""
    if not isinstance(data, dict):
        return {}
    result: dict[str, Any] = {}
    for key in ("polling_interval", "pollingInterval", "pi"):
        if key in data:
            result["polling_interval"] = int(data[key])
    for key in ("progress_polling_interval", "progressPollingInterval", "ppi"):
        if key in data:
            result["progress_polling_interval"] = int(data[key])
    if result:
        return result
    for wrap_key in ("data", "result", "settings"):
        if isinstance(data.get(wrap_key), dict):
            return _extract_settings(data[wrap_key])
    return {}
