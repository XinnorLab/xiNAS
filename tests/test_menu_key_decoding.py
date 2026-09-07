"""Arrow keys must navigate the bash menus in every encoding a terminal sends.

`lib/menu_lib.sh`'s `_menu_read_key` is the one place every bash dialog
(`menu_select`, `yes_no`, `input_box`, `checklist`) turns raw terminal bytes
into a key name. A cursor key reaches it as an escape sequence, and a terminal
picks the encoding per session, not per keyboard: normal mode sends CSI
(`ESC [ B` for Down), application cursor-key mode -- DECCKM, `ESC [ ? 1 h`,
which any full-screen program or multiplexer may leave switched on -- sends
SS3 (`ESC O B`). Both are the same Down key.

The reader used to take exactly two bytes after the ESC and match only the
CSI form; everything else fell into a catch-all that answered `ESC`. Every
dialog treats `ESC` as Cancel, and at the top-level setup menu Cancel is
`exit 2`, so one Down keypress from an SS3 terminal -- or a PgDn, Home, End,
F-key or Ctrl-arrow anywhere -- ended the installer with the "Setup exited"
notice and no clue why.

These tests drive the REAL library through a pty (the reader opens /dev/tty
itself) and assert the top-level `menu_select` contract per byte sequence:
arrows navigate in both encodings, other complete sequences are ignored, and
only a bare Esc cancels. The client package carries its own copy of the
library, so both are covered.

Contract: docs/Installer/spec.md 2.6.
"""

from __future__ import annotations

import contextlib
import os
import pty
import re
import select
import shutil
import subprocess
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
LIBS = ("lib/menu_lib.sh", "client_repo/lib/menu_lib.sh")


def _find_bash4() -> str | None:
    """`read -t 0.1` needs bash >= 4; macOS ships 3.2, CI runs Ubuntu's 5.x."""
    candidates = [
        shutil.which("bash"),
        "/opt/homebrew/bin/bash",
        "/usr/local/bin/bash",
    ]
    for cand in candidates:
        if not cand or not os.access(cand, os.X_OK):
            continue
        proc = subprocess.run(
            [cand, "-c", "echo ${BASH_VERSINFO[0]}"], capture_output=True, text=True
        )
        major = proc.stdout.strip()
        if proc.returncode == 0 and major.isdigit() and int(major) >= 4:
            return cand
    return None


BASH4 = _find_bash4()

pytestmark = pytest.mark.skipif(
    BASH4 is None,
    reason="lib/menu_lib.sh's key reader needs bash >= 4 (fractional read -t)",
)

# The same shape simple_menu.sh / startup_menu.sh use for their top-level
# menu: a cancelled menu_select is `exit 2`, a choice is echoed back.
SCRIPT = (
    "set -euo pipefail; source {lib}; "
    'choice=$(menu_select "T" "P" 1 one 2 two 0 exit) '
    '|| {{ echo "MENU_CANCELLED"; exit 2; }}; '
    'echo "CHOICE=$choice"'
)

FOOTER = b"Esc Cancel"


def _drive(lib: str, keys: bytes) -> tuple[str, int]:
    """Render the menu, send `keys`, then Enter; return (transcript, status)."""
    assert BASH4 is not None
    pid, fd = pty.fork()
    if pid == 0:  # pragma: no cover - child
        os.chdir(REPO)
        os.execvp(BASH4, [BASH4, "-c", SCRIPT.format(lib=lib)])

    out = bytearray()

    def pump(until: float, stop_when=None) -> None:
        deadline = time.monotonic() + until
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if not ready:
                if stop_when is not None and stop_when():
                    return
                continue
            try:
                chunk = os.read(fd, 4096)
            except OSError:  # EIO once the child has exited
                return
            if not chunk:
                return
            out.extend(chunk)
            if stop_when is not None and stop_when():
                return

    def write(data: bytes) -> None:
        # EIO here means the child already exited (a cancel): nothing to send.
        with contextlib.suppress(OSError):
            os.write(fd, data)

    pump(5.0, stop_when=lambda: out.count(FOOTER) >= 1)
    assert out.count(FOOTER) >= 1, "menu never rendered"
    renders = out.count(FOOTER)
    write(keys)
    # A navigating key re-renders; an ignored one does not. Either way move on.
    pump(0.6, stop_when=lambda: out.count(FOOTER) > renders)
    write(b"\r")
    pump(5.0)
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    return out.decode("utf-8", "replace"), os.WEXITSTATUS(status)


def _choice(transcript: str) -> str | None:
    # The cursor-show sequence (`ESC [ ? 25 h`) lands on the same line, ahead
    # of the marker, so match anywhere in the transcript rather than at a
    # line start.
    match = re.search(r"CHOICE=(\S*)", transcript)
    return match.group(1) if match else None


NAVIGATES = [
    pytest.param(b"\x1b[B", "2", id="csi-down"),
    pytest.param(b"\x1bOB", "2", id="ss3-down-application-cursor-mode"),
    pytest.param(b"\x1b[A", "0", id="csi-up-wraps"),
    pytest.param(b"\x1bOA", "0", id="ss3-up-wraps"),
    pytest.param(b"\x1b[B\x1b[B", "0", id="two-downs-one-write"),
]

IGNORED = [
    pytest.param(b"\x1b[6~", id="page-down"),
    pytest.param(b"\x1b[H", id="home"),
    pytest.param(b"\x1b[1;5B", id="ctrl-down"),
    pytest.param(b"\x1bOP", id="f1-ss3"),
    pytest.param(b"\x1bx", id="alt-x"),
]


@pytest.mark.parametrize("lib", LIBS)
@pytest.mark.parametrize(("keys", "expected"), NAVIGATES)
def test_arrow_keys_navigate_in_both_encodings(lib: str, keys: bytes, expected: str):
    transcript, status = _drive(lib, keys)
    assert "MENU_CANCELLED" not in transcript, (
        f"{keys!r} was read as Esc and cancelled the menu:\n{transcript[-400:]}"
    )
    assert status == 0
    assert _choice(transcript) == expected


@pytest.mark.parametrize("lib", LIBS)
@pytest.mark.parametrize("keys", IGNORED)
def test_other_escape_sequences_are_not_cancel(lib: str, keys: bytes):
    transcript, status = _drive(lib, keys)
    assert "MENU_CANCELLED" not in transcript, (
        f"{keys!r} was read as Esc and cancelled the menu:\n{transcript[-400:]}"
    )
    assert status == 0
    assert _choice(transcript) == "1", "an unmapped key must leave the cursor alone"


@pytest.mark.parametrize("lib", LIBS)
def test_bare_esc_still_cancels(lib: str):
    transcript, status = _drive(lib, b"\x1b")
    assert "MENU_CANCELLED" in transcript
    assert status == 2
