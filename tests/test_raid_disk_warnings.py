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
    """Minimal ControlClient stand-in: `get` returns envelopes, `result` unwraps."""

    def __init__(self, envelopes: dict[str, dict]) -> None:
        self._envelopes = envelopes

    def get(self, path: str) -> dict:
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


def test_wizard_renders_the_fetched_banner_in_its_abort_dialog():
    """The banner the wizard *fetched* must be the one it renders.

    The text is generated per run and appears nowhere in this file, so an
    implementation that hardcodes or table-looks-up the expected message
    cannot pass. Four earlier versions of this test were each defeated by a
    reviewer-constructed passing-but-wrong implementation:

    1. A substring check on the wizard's source (`"banner" in src`) was
       satisfied by the variable name `disk_banner` alone.
    2. A regex on the source for `_no_drives_message(disk_banner)` was
       satisfied by a body that called the helper and discarded the result.
    3. A behavioral test driving the real no-drives path with a single fixed
       banner string was satisfied by a wizard that ignored the fetched
       banner and printed a matching constant.
    4. Parametrizing over two fixed banner strings raised the bar from one
       hardcoded constant to a two-entry lookup table keyed on exactly those
       strings, still bypassing `_no_drives_message` entirely.

    Every one of those fixtures was visible in the test source, so any finite
    set of them could be hardcoded or tabulated. A value generated at run
    time and never written to disk closes that class of attack outright: no
    lookup table can contain a token it has never seen.
    """
    token = f"collector unavailable {uuid.uuid4().hex}"
    captured: list = []

    class _StubApp:
        def __init__(self, control):
            self.control = control

        async def push_screen_wait(self, dialog):
            captured.append(dialog)
            return None

    class _StubScreen:
        def __init__(self, control):
            self.app = _StubApp(control)

    asyncio.run(RAIDScreen._create_array_wizard.__wrapped__(_StubScreen(_degraded(token))))

    assert captured, "the wizard showed no dialog"
    message = captured[0]._message
    assert "No available NVMe drives found." in message
    assert token in message, "the fetched banner never reached the dialog"
