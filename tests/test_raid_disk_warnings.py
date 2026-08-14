"""The Create Array wizard must not report a degraded collector as "no drives".

`GET /api/v1/disks` answers a degraded Disk collector with an empty result and
a DEGRADED_BACKEND_UNAVAILABLE warning. Reading only the result payload turns
"nothing could be observed" into "there is no hardware" — the operator is sent
to look for missing drives instead of a broken collector.
"""

from __future__ import annotations

import asyncio
import inspect
import re

from xinas_menu.screens.raid import (
    RAIDScreen,
    _list_api_disks,
    _list_api_disks_with_banner,
    _no_drives_message,
)


class _StubControl:
    """Minimal ControlClient stand-in: `get` returns envelopes, `result` unwraps."""

    def __init__(self, envelopes: dict[str, dict]) -> None:
        self._envelopes = envelopes

    def get(self, path: str) -> dict:
        return self._envelopes[path]

    def result(self, path: str):
        return self._envelopes[path].get("result")


def _degraded() -> _StubControl:
    return _StubControl(
        {
            "/api/v1/disks": {
                "result": [],
                "warnings": [
                    {"code": "DEGRADED_BACKEND_UNAVAILABLE", "message": "disk collector errored"}
                ],
            },
            "/api/v1/arrays": {"result": []},
        }
    )


def test_degraded_disk_collector_yields_a_banner():
    rows, banner = asyncio.run(_list_api_disks_with_banner(_degraded()))
    assert rows == []
    assert banner, "a degraded disk collector must produce a banner"


def test_healthy_empty_list_yields_no_banner():
    control = _StubControl(
        {"/api/v1/disks": {"result": []}, "/api/v1/arrays": {"result": []}}
    )
    rows, banner = asyncio.run(_list_api_disks_with_banner(control))
    assert rows == []
    assert banner is None


def test_plain_wrapper_still_returns_rows_only():
    rows = asyncio.run(_list_api_disks(_degraded()))
    assert rows == []


def test_no_drives_message_carries_the_banner():
    out = _no_drives_message("Disk collector unavailable")
    assert "No available NVMe drives found." in out
    assert "Disk collector unavailable" in out


def test_no_drives_message_is_plain_without_a_banner():
    assert _no_drives_message(None) == "No available NVMe drives found."
    assert _no_drives_message("") == "No available NVMe drives found."


def test_wizard_passes_the_fetched_banner_into_the_message():
    """Guards the fetch-and-drop regression: the banner the wizard fetched must
    be the one it renders, not a discarded local."""
    src = inspect.getsource(RAIDScreen._create_array_wizard)
    assert re.search(r"_no_drives_message\(\s*disk_banner\s*\)", src)
