"""The TUI's nfs-helper client names the unit and the fix when it is down.

Same contract as the agent transport
(docs/control-path/nfs-helper-service-spec.md §4): a caller who sees
"socket not found" learns nothing actionable — the message must name the
systemd unit and the command that brings it back. The two connect-time
failures that mean "the daemon is not there" are an absent socket file
(``FileNotFoundError``) and a stale socket file with no listener
(``ConnectionRefusedError``).
"""

from __future__ import annotations

import socket
import tempfile
from pathlib import Path

import pytest

from xinas_menu.api.nfs_client import NFSHelperClient


@pytest.fixture
def sock_dir():
    """A short-enough directory for AF_UNIX.

    ``tmp_path`` on macOS lands under /private/var/folders/… and blows the
    104-byte ``sun_path`` limit (Linux allows 108) — every connect would fail
    with "AF_UNIX path too long" instead of the error under test.
    """
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        yield Path(d)


def test_absent_socket_error_names_the_unit_and_the_command(sock_dir):
    client = NFSHelperClient(socket_path=str(sock_dir / "absent.sock"))

    ok, result, err = client._request("list_exports")

    assert ok is False
    assert result is None
    assert "xinas-nfs-helper.service is not running" in err
    assert "systemctl start xinas-nfs-helper" in err


def test_stale_socket_error_names_the_unit_and_the_command(sock_dir):
    """A socket file left behind by a killed daemon: connect() is refused."""
    path = sock_dir / "stale.sock"
    # Bind without listen() so connect() is refused rather than accepted.
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(path))
    try:
        client = NFSHelperClient(socket_path=str(path))

        ok, _, err = client._request("list_exports")

        assert ok is False
        assert "xinas-nfs-helper.service is not running" in err
        assert "systemctl start xinas-nfs-helper" in err
    finally:
        sock.close()
