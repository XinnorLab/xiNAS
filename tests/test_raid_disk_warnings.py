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

    `get` also counts calls per path and raises past the first one. The real
    wizard fetches each envelope exactly once; a "fetch it again to derive the
    banner" implementation would read `/api/v1/disks` a second time from a
    fresh (possibly changed) state, decoupling the banner it displays from the
    fetch that decided there were zero drives. A pure-function stub can't see
    that inconsistency — only call accounting can.
    """

    def __init__(self, envelopes: dict[str, dict]) -> None:
        self._envelopes = envelopes
        self._get_calls: dict[str, int] = {}

    def get(self, path: str) -> dict:
        self._get_calls[path] = self._get_calls.get(path, 0) + 1
        if self._get_calls[path] > 1:
            raise AssertionError(f"get({path!r}) called more than once")
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

    async def push_screen_wait(self, dialog):
        self.captured.append(dialog)
        return None


class _StubScreen:
    """Wires a fresh `_StubApp` (with its own capture list) to a control stub."""

    def __init__(self, control):
        self.app = _StubApp(control)
        self.app.captured = []


def _run_wizard_and_capture_message(control: _StubControl) -> str:
    screen = _StubScreen(control)
    asyncio.run(RAIDScreen._create_array_wizard.__wrapped__(screen))
    captured = screen.app.captured
    assert captured, "the wizard showed no dialog"
    return captured[0]._message


def test_wizard_renders_the_fetched_banner_in_its_abort_dialog():
    """The banner the wizard *fetched* must be the one it renders, on the one
    fetch it is allowed to make.

    The text is generated per run and appears nowhere in this file, so an
    implementation that hardcodes or table-looks-up the expected message
    cannot pass. `_StubControl.get` also raises past its first call per path,
    so an implementation that derives the banner from a *second*, independent
    fetch of `/api/v1/disks` cannot pass either — that second fetch would
    read a state the "zero drives" decision was never made against.

    Five earlier versions of this test were each defeated by a
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
    5. A run-time token defeated hardcoding and lookup tables, but a second,
       independent `control.get("/api/v1/disks")` call inside the abort
       branch could still derive a banner that happened to match — the stub
       had no way to tell "the one fetch" from "a second fetch of the same
       path".

    Every fixture value up to attempt 4 was visible in the test source, so
    any finite set of them could be hardcoded or tabulated. A value generated
    at run time and never written to disk closes that class of attack
    outright. The call-count guard on `_StubControl.get` closes the
    re-fetch class: the wizard gets exactly one look at `/api/v1/disks`, so
    whatever banner it shows has to come from that look.
    """
    token = f"collector unavailable {uuid.uuid4().hex}"
    message = _run_wizard_and_capture_message(_degraded(token))
    assert "No available NVMe drives found." in message
    assert token in message, "the fetched banner never reached the dialog"


def test_wizard_renders_a_fresh_banner_on_each_invocation():
    """Two separate invocations must each render their own fetched banner.

    A module-level (or otherwise process-wide) "first banner wins, reuse it
    forever" cache would pass a test that invokes the wizard only once — the
    single call and the cached value are indistinguishable. Calling the
    wizard twice, with two independently generated tokens and a fresh stub
    per call, makes that distinguishable: the second dialog has to carry the
    second token, not an echo of the first.
    """
    token_a = f"collector unavailable {uuid.uuid4().hex}"
    token_b = f"collector unavailable {uuid.uuid4().hex}"
    assert token_a != token_b

    message_a = _run_wizard_and_capture_message(_degraded(token_a))
    message_b = _run_wizard_and_capture_message(_degraded(token_b))

    assert token_a in message_a, "the first invocation's banner never reached its dialog"
    assert token_b in message_b, "the second invocation's banner never reached its dialog"
    assert token_a not in message_b, "the second dialog echoed the first invocation's banner"
    assert token_b not in message_a, "the first dialog echoed the second invocation's banner"
