"""Low-level terminal escape-sequence helpers used by modal widgets.

Only depends on a Textual ``App`` and ``sys.stdout``. Lets modal screens
release mouse-tracking back to the terminal so the user can drag-select
dialog contents with the terminal's native selection (and copy via the
terminal's own Cmd+C / Ctrl+Shift+C), then restore Textual's normal
mouse handling on unmount.

These helpers poke the terminal directly with the same DECSET/DECRST
sequences that Textual uses internally. Not a documented Textual API,
but stable in practice. If a future Textual upgrade changes its mouse
init handshake, the on-unmount restore call may need a matching tweak.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from textual.app import App


# DEC private mode 1000=basic mouse, 1002=button-event, 1003=any-event,
# 1006=SGR extended encoding. Disable all four to fully release mouse
# tracking; re-enable the same set on restore.
_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l"
_MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h"


def release_mouse_capture(app: App) -> None:
    """Tell the terminal to stop forwarding mouse events to the app."""
    _write(app, _MOUSE_DISABLE)


def restore_mouse_capture(app: App) -> None:
    """Re-enable Textual's normal mouse tracking."""
    _write(app, _MOUSE_ENABLE)


def _write(app: App, sequence: str) -> None:
    driver = getattr(app, "_driver", None)
    if driver is not None:
        write = getattr(driver, "write", None)
        if callable(write):
            try:
                write(sequence)
                flush = getattr(driver, "flush", None)
                if callable(flush):
                    flush()
                return
            except Exception:
                pass
    try:
        sys.stdout.write(sequence)
        sys.stdout.flush()
    except Exception:
        pass
