"""The Create Array wizard must not report a degraded collector as "no drives".

`GET /api/v1/disks` answers a degraded Disk collector with an empty result and
a DEGRADED_BACKEND_UNAVAILABLE warning. Reading only the result payload turns
"nothing could be observed" into "there is no hardware" — the operator is sent
to look for missing drives instead of a broken collector.
"""

from __future__ import annotations

import asyncio
import uuid

from xinas_menu.screens.raid import (
    RAIDScreen,
    _list_api_disks,
    _list_api_disks_with_banner,
    _no_drives_message,
)


class _StubControl:
    """Minimal ControlClient stand-in: `get` returns envelopes, `result` unwraps.

    `get` also counts calls per path so a test can assert the wizard fetched
    it exactly once, rather than relying on a raise buried inside the stub.
    """

    def __init__(self, envelopes: dict[str, dict]) -> None:
        self._envelopes = envelopes
        self._get_calls: dict[str, int] = {}

    def get(self, path: str) -> dict:
        self._get_calls[path] = self._get_calls.get(path, 0) + 1
        return self._envelopes[path]

    def result(self, path: str):
        return self._envelopes[path].get("result")


def _degraded(message: str = "disk collector errored") -> _StubControl:
    return _StubControl(
        {
            "/api/v1/disks": {
                "result": [],
                "warnings": [{"code": "DEGRADED_BACKEND_UNAVAILABLE", "message": message}],
            },
            "/api/v1/arrays": {"result": []},
        }
    )


def test_degraded_disk_collector_yields_a_banner():
    rows, banner = asyncio.run(_list_api_disks_with_banner(_degraded()))
    assert rows == []
    assert banner, "a degraded disk collector must produce a banner"


def test_healthy_empty_list_yields_no_banner():
    control = _StubControl({"/api/v1/disks": {"result": []}, "/api/v1/arrays": {"result": []}})
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


class _StubApp:
    def __init__(self, control):
        self.control = control
        self.captured = []

    async def push_screen_wait(self, dialog):
        self.captured.append(dialog)
        return None


class _StubScreen:
    """Wires a `_StubApp` to a control stub."""

    def __init__(self, control):
        self.app = _StubApp(control)


def _run_wizard_and_capture_message(control: _StubControl) -> str:
    screen = _StubScreen(control)
    asyncio.run(RAIDScreen._create_array_wizard.__wrapped__(screen))
    captured = screen.app.captured
    assert captured, "the wizard showed no dialog"
    return captured[0]._message


def test_wizard_renders_the_fetched_banner_from_a_single_fetch():
    """The banner text is generated at run time, so it can't be hardcoded or
    tabulated. The wizard is allowed exactly one fetch of `/api/v1/disks`, so
    the rendered banner must come from the fetch that decided there were zero
    drives.
    """
    for _ in range(2):
        token = f"collector unavailable {uuid.uuid4().hex}"
        control = _degraded(token)
        message = _run_wizard_and_capture_message(control)
        assert "No available NVMe drives found." in message
        assert token in message, "the fetched banner never reached the dialog"
        assert control._get_calls["/api/v1/disks"] == 1, (
            "the wizard must decide and render from one fetch"
        )
