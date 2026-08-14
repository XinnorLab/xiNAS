"""Delete Array dependency discovery must fail CLOSED.

`_delete_array` destroys the array after the confirmations, so the
dependency reads it bases those confirmations on are safety-critical:
a control-path read that errors out is NOT evidence that the array has
no shares/filesystems on it. Swallowing `ControlPathError` into an empty
list made "the API is down" indistinguishable from "nothing depends on
this array" and let the teardown proceed to raid_destroy.

Storage/raid-management-spec §6.1.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from xinas_menu.api.control_client import ControlPathError
from xinas_menu.screens.raid import RAIDScreen

_ARRAY = "data"
_VOLUME = "/dev/xi_data"


def _share(sid: str, path: str) -> dict:
    return {"id": sid, "spec": {"path": path}}


def _fs(fid: str, mountpoint: str, *, backing: str | None = None, mounted: bool = True) -> dict:
    status: dict[str, Any] = {"mountpoint": mountpoint, "mounted": mounted}
    if backing is not None:
        status["backing_device"] = backing
    return {"id": fid, "status": status}


class _FakeControl:
    """`control.result(path)` stub: canned rows or a raised error per path."""

    def __init__(self, rows: dict[str, Any]) -> None:
        self._rows = rows
        self.reads: list[str] = []

    def result(self, path: str) -> Any:
        self.reads.append(path)
        value = self._rows.get(path, [])
        if isinstance(value, Exception):
            raise value
        return value


class _FakeScreen:
    """Minimal stand-in for the RAIDScreen `self` the helper touches."""

    # Real halt renderer, so the abort text is exercised as shipped.
    _delete_aborted = RAIDScreen._delete_aborted

    def __init__(self, control: _FakeControl) -> None:
        self.app = SimpleNamespace(control=control, push_screen_wait=self._push)
        self.dialogs: list[Any] = []

    async def _push(self, dialog: Any) -> Any:
        self.dialogs.append(dialog)
        return True

    @property
    def messages(self) -> str:
        return "\n".join(getattr(d, "_message", "") for d in self.dialogs)

    @property
    def titles(self) -> str:
        return "\n".join(getattr(d, "_title", "") for d in self.dialogs)


def _discover(control: _FakeControl, mounts: list[dict]) -> tuple[Any, _FakeScreen]:
    screen = _FakeScreen(control)
    found = asyncio.run(RAIDScreen._delete_dependencies(screen, _ARRAY, _VOLUME, mounts))
    return found, screen


_DATA_MOUNT = [{"mountpoint": "/srv/share01", "data_device": _VOLUME, "role": "data"}]


def test_share_read_failure_aborts_the_teardown():
    control = _FakeControl(
        {
            "/api/v1/shares": ControlPathError("503 control path unavailable"),
            "/api/v1/filesystems": [_fs("srv-share01.mount", "/srv/share01", backing=_VOLUME)],
        }
    )
    found, screen = _discover(control, _DATA_MOUNT)

    assert found is None, "a failed shares read must abort, not read as 'no shares'"
    assert "503 control path unavailable" in screen.messages
    assert "not" in screen.messages.lower() and "delete" in screen.messages.lower()


def test_filesystem_read_failure_aborts_the_teardown():
    control = _FakeControl(
        {
            "/api/v1/shares": [],
            "/api/v1/filesystems": ControlPathError("connection refused"),
        }
    )
    found, screen = _discover(control, _DATA_MOUNT)

    assert found is None, "a failed filesystems read must abort, not read as 'no filesystems'"
    assert "connection refused" in screen.messages


def test_successful_reads_return_the_affected_dependencies():
    control = _FakeControl(
        {
            "/api/v1/shares": [
                _share("s1", "/srv/share01/export"),
                _share("s2", "/srv/other/export"),
            ],
            "/api/v1/filesystems": [
                _fs("srv-share01.mount", "/srv/share01", backing=_VOLUME),
                _fs("srv-other.mount", "/srv/other", backing="/dev/xi_other"),
            ],
        }
    )
    found, screen = _discover(control, _DATA_MOUNT)

    assert found is not None
    shares, filesystems = found
    assert [s["path"] for s in shares] == ["/srv/share01/export"]
    assert [f["id"] for f in filesystems] == ["srv-share01.mount"]
    assert screen.dialogs == []


def test_dependent_mount_the_teardown_cannot_unmount_blocks_the_delete():
    # An XFS filesystem that uses the array only as its external log device
    # is not modelled by the API as backed by the volume, so the teardown
    # would never unmount it — and the agent's delete preflight then refuses
    # the destroy. Block up front instead of removing shares first.
    control = _FakeControl({"/api/v1/shares": [], "/api/v1/filesystems": []})
    mounts = [{"mountpoint": "/srv/share01", "log_device": _VOLUME, "role": "log"}]
    found, screen = _discover(control, mounts)

    assert found is None
    assert "/srv/share01" in screen.messages
    assert "log" in screen.messages.lower()


def test_api_managed_dependent_mount_does_not_block():
    control = _FakeControl(
        {
            "/api/v1/shares": [],
            "/api/v1/filesystems": [_fs("srv-share01.mount", "/srv/share01")],
        }
    )
    mounts = [{"mountpoint": "/srv/share01", "log_device": _VOLUME, "role": "log"}]
    found, screen = _discover(control, mounts)

    assert found is not None
    assert [f["id"] for f in found[1]] == ["srv-share01.mount"]
    assert screen.dialogs == []
