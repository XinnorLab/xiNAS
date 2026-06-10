"""Clipboard copy with a recovery file — shared by every Textual app.

Hoisted out of ``XiNASApp._do_copy`` so the copy keybinding works in ANY of
the package's apps (XiNASApp and the installer-phase StartupApp both push
the Confirm/TextArea dialogs, whose copy action previously crashed under
StartupApp with AttributeError because only XiNASApp defined ``_do_copy``).
The logic is app-generic: it uses Textual's own ``App.copy_to_clipboard``
(OSC 52) plus a plain-file fallback, and ``App.notify`` for feedback.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from textual.app import App

_log = logging.getLogger(__name__)


def copy_with_recovery(app: App, text: str) -> None:
    """Send *text* to the user's clipboard, with a recovery file.

    Two paths run unconditionally:

    1. OSC 52 escape via Textual — interpreted by the user's terminal
       emulator on their workstation, so it works through SSH. Honored
       by iTerm2 (with "Applications may access clipboard" enabled),
       Ghostty, WezTerm, kitty, gnome-terminal, Windows Terminal,
       Alacritty, etc. Silently dropped by Apple Terminal.app — which
       has no setting to enable it, hence the second path.

    2. A 0600 recovery file at ~/.xinas/clipboard.txt (the home of
       whichever user runs xinas-menu). Users on terminals that don't
       honor OSC 52 can always `cat` the file to retrieve the value.
    """
    save_path = save_recovery_file(text)

    osc52_ok = False
    copy_to_clipboard = getattr(app, "copy_to_clipboard", None)
    if callable(copy_to_clipboard):
        try:
            copy_to_clipboard(text)
            osc52_ok = True
        except Exception:
            _log.debug("OSC 52 copy_to_clipboard failed", exc_info=True)

    if osc52_ok and save_path:
        msg = f"Copied to clipboard (OSC 52). If paste fails, see {save_path}"
    elif osc52_ok:
        msg = "Copied to clipboard (OSC 52)."
    elif save_path:
        msg = f"Terminal doesn't accept clipboard escapes. Saved to {save_path} — cat the file to retrieve."
    else:
        msg = "Copy failed — clipboard and recovery file both unavailable."
    app.notify(msg, timeout=8)


def save_recovery_file(text: str) -> str | None:
    """Write *text* to ~/.xinas/clipboard.txt with mode 0600.

    Returns the path on success, None on failure. Atomically replaces
    any previous content so only the most recent copy is retained.
    """
    try:
        home = Path(os.path.expanduser("~"))
        d = home / ".xinas"
        d.mkdir(mode=0o700, exist_ok=True)
        path = d / "clipboard.txt"
        tmp = path.with_suffix(".tmp")
        fd = os.open(
            str(tmp),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, text.encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(tmp, path)
        return str(path)
    except Exception:
        _log.debug("recovery file save failed", exc_info=True)
        return None
