"""Spare Pools' empty-drives dialogs must carry the same degraded-backend
banner as the RAID Create wizard (docs/Storage/raid-management-spec.md §4/§7).

`_get_free_nvme_drives()` used to read disk rows through the banner-less
`_list_api_disks()` wrapper, so a degraded Disk collector made Create Pool
report "All drives are assigned to RAID arrays or other pools" — a false,
specific claim — instead of naming the collector as the reason nothing came
back. Add Drives had the shorter variant of the same gap.
"""

from __future__ import annotations

import asyncio
import uuid

from xinas_menu.screens.spare_pools import SparePoolScreen, _get_free_nvme_drives


class _StubControl:
    """Minimal ControlClient stand-in: `get` returns envelopes, `result` unwraps."""

    def __init__(self, envelopes: dict[str, dict]) -> None:
        self._envelopes = envelopes
        self._get_calls: dict[str, int] = {}

    def get(self, path: str) -> dict:
        self._get_calls[path] = self._get_calls.get(path, 0) + 1
        return self._envelopes[path]

    def result(self, path: str):
        return self._envelopes[path].get("result")


def _degraded_with_one_pool(message: str) -> _StubControl:
    return _StubControl(
        {
            "/api/v1/disks": {
                "result": [],
                "warnings": [{"code": "DEGRADED_BACKEND_UNAVAILABLE", "message": message}],
            },
            "/api/v1/arrays": {"result": []},
            "/api/v1/pools": {"result": [{"name": "spare0", "drives": []}]},
        }
    )


def test_get_free_nvme_drives_returns_the_degraded_banner():
    token = f"collector unavailable {uuid.uuid4().hex}"
    rows, banner = asyncio.run(_get_free_nvme_drives(_degraded_with_one_pool(token)))
    assert rows == []
    assert banner and token in banner


class _StubApp:
    def __init__(self, control, replies):
        self.control = control
        self.captured = []
        self._replies = list(replies)

    async def push_screen_wait(self, dialog):
        self.captured.append(dialog)
        return self._replies.pop(0) if self._replies else None


class _StubScreen:
    def __init__(self, control, replies):
        self.app = _StubApp(control, replies)

    async def _pool_names_or_dialog(self):
        # Plain instance method (not a @work worker); safe to drive directly
        # off this stub, since it only touches self.app.
        return await SparePoolScreen._pool_names_or_dialog(self)


def test_create_pool_empty_drives_dialog_carries_the_fetched_banner():
    """The banner text is generated at run time, so it can't be hardcoded, and
    the wizard is allowed exactly one fetch of `/api/v1/disks` per run.
    """
    for _ in range(2):
        token = f"collector unavailable {uuid.uuid4().hex}"
        control = _degraded_with_one_pool(token)
        screen = _StubScreen(control, replies=["spare0"])
        asyncio.run(SparePoolScreen._create_pool.__wrapped__(screen))

        captured = screen.app.captured
        assert len(captured) == 2, "expected the name prompt then the empty-drives dialog"
        message = captured[1]._message
        assert "No available drives found." in message
        assert token in message, "the fetched banner never reached the dialog"
        assert control._get_calls["/api/v1/disks"] == 1


def test_add_drives_empty_drives_dialog_carries_the_fetched_banner():
    for _ in range(2):
        token = f"collector unavailable {uuid.uuid4().hex}"
        control = _degraded_with_one_pool(token)
        screen = _StubScreen(control, replies=["spare0"])
        asyncio.run(SparePoolScreen._add_drives.__wrapped__(screen))

        captured = screen.app.captured
        assert len(captured) == 2, "expected the pool-select prompt then the empty-drives dialog"
        message = captured[1]._message
        assert "No available drives found." in message
        assert token in message, "the fetched banner never reached the dialog"
        assert control._get_calls["/api/v1/disks"] == 1
