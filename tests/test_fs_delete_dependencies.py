"""Delete Filesystem dependency discovery must fail CLOSED.

Same defect as the Delete Array one fixed in #277, one screen over. The NFS
shares rooted under a filesystem's mountpoint are read from the control path,
and that read's failure was swallowed into an empty list. An empty list is not
"this filesystem has no shares" — it is "nobody knows". The consequences are
visible in the flow that follows it: the second, ABSOLUTELY-sure confirmation
renders only `if affected_shares`, and the share-removal step iterates that
same list. So a control path that is down downgraded the teardown to a single
confirmation, skipped the share removal, and unmounted + unmanaged the
filesystem out from under live NFS exports.

`api/plan/providers/filesystem.ts` carries no share-related blocker, so there
is no server-side backstop for this one.

Storage/fs-shares-management-spec §Delete Filesystem.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from xinas_menu.api.control_client import ControlPathError
from xinas_menu.screens.filesystem import FilesystemScreen

_MOUNTPOINT = "/mnt/data"
_FS_LABEL = "/mnt/data"


def _share(sid: str, path: str) -> dict:
    return {"id": sid, "spec": {"path": path}}


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

    def get(self, path: str) -> Any:
        """Envelope form, as `_list_filesystems_with_status` reads it."""
        value = self.result(path)
        return value if isinstance(value, dict) else {"result": value}


class _FakeScreen:
    """Minimal stand-in for the FilesystemScreen `self` the helpers touch."""

    # Real halt renderer + real list adapter, so both are exercised as shipped.
    _delete_aborted = FilesystemScreen._delete_aborted
    _list_filesystems = FilesystemScreen._list_filesystems
    _list_filesystems_with_status = FilesystemScreen._list_filesystems_with_status

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


def _discover(control: _FakeControl, mountpoint: str = _MOUNTPOINT):
    screen = _FakeScreen(control)
    found = asyncio.run(FilesystemScreen._shares_on_mountpoint(screen, mountpoint, _FS_LABEL))
    return found, screen


# ── the defect ────────────────────────────────────────────────────────────────


def test_share_read_failure_aborts_the_teardown():
    control = _FakeControl({"/api/v1/shares": ControlPathError("503 control path unavailable")})
    found, screen = _discover(control)

    assert found is None, "a failed shares read must abort, not read as 'no shares'"
    assert "503 control path unavailable" in screen.messages
    # The operator has to be told the filesystem survived untouched.
    assert "not" in screen.messages.lower() and "delet" in screen.messages.lower()


def test_abort_names_the_filesystem_and_changes_nothing():
    control = _FakeControl({"/api/v1/shares": ControlPathError("connection refused")})
    found, screen = _discover(control)

    assert found is None
    assert _FS_LABEL in screen.messages
    assert control.reads == ["/api/v1/shares"], "nothing else may be touched after the abort"


# ── the behaviour that must survive the fix ───────────────────────────────────


def test_shares_under_the_mountpoint_are_returned():
    control = _FakeControl(
        {
            "/api/v1/shares": [
                _share("s1", "/mnt/data/share01"),
                _share("s2", "/mnt/data"),
                _share("s3", "/srv/elsewhere"),
            ]
        }
    )
    found, _ = _discover(control)

    assert found is not None
    assert [s["id"] for s in found] == ["s1", "s2"]
    assert [s["path"] for s in found] == ["/mnt/data/share01", "/mnt/data"]


def test_no_shares_is_an_empty_list_not_an_abort():
    control = _FakeControl({"/api/v1/shares": []})
    found, screen = _discover(control)

    assert found == [], "an answered read of zero shares is a real answer"
    assert screen.dialogs == []


def test_unmounted_filesystem_skips_the_read():
    """Nothing can be rooted under a filesystem that is not mounted."""
    control = _FakeControl({"/api/v1/shares": ControlPathError("would not be reached")})
    found, screen = _discover(control, mountpoint="")

    assert found == []
    assert control.reads == []
    assert screen.dialogs == []


def test_malformed_share_rows_are_skipped_not_fatal():
    control = _FakeControl(
        {
            "/api/v1/shares": [
                "junk",
                {"id": "s1"},
                {"spec": {"path": "/mnt/data/x"}},
                _share("s2", "/mnt/data/ok"),
            ]
        }
    )
    found, _ = _discover(control)

    assert found is not None
    assert [s["id"] for s in found] == ["s2"]


# ── the same defect on the create path ────────────────────────────────────────
#
# `_create_filesystem` filters out arrays already backing a filesystem. That
# filter is the only thing keeping an in-use array out of the candidate list;
# swallowing the read into `[]` offered those arrays, and the create then failed
# in the agent's blkid preflight — whose remedy this screen offers as a force
# retry that overwrites the existing filesystem.


def _unused(control: _FakeControl, arr_rows):
    screen = _FakeScreen(control)
    got = asyncio.run(FilesystemScreen._unused_arrays(screen, arr_rows))
    return got, screen


def _array(name: str) -> dict:
    return {
        "id": name,
        "spec": {"name": name, "level": "raid5", "member_disk_ids": []},
        "status": {"state": "optimal", "volume_path": f"/dev/xi_{name}"},
    }


def test_create_aborts_when_the_filesystem_list_is_unreadable():
    control = _FakeControl({"/api/v1/filesystems": ControlPathError("503 unavailable")})
    got, screen = _unused(control, [_array("data"), _array("log")])

    assert got is None, "an unreadable filesystem list must not read as 'no array is in use'"
    assert "503 unavailable" in screen.messages


def test_create_filters_out_arrays_already_carrying_a_filesystem():
    control = _FakeControl(
        {
            "/api/v1/filesystems": {
                "result": [
                    {
                        "id": "mnt-data.mount",
                        "status": {
                            "mountpoint": "/mnt/data",
                            "backing_device": "/dev/xi_data",
                            "mounted": True,
                        },
                    }
                ]
            }
        }
    )
    got, screen = _unused(control, [_array("data"), _array("log")])

    assert got is not None
    assert [a["volume_path"] for a in got] == ["/dev/xi_log"]
    assert screen.dialogs == []
