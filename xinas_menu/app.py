"""XiNASApp — root Textual application for xinas-menu."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import ClassVar

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.reactive import reactive

from xinas_menu.api.grpc_client import XiRAIDClient
from xinas_menu.api.nfs_client import NFSHelperClient
from xinas_menu.utils.audit import AuditLogger
from xinas_menu.utils.update_check import UpdateChecker
from xinas_menu.widgets.header import XiNASHeader


class XiNASApp(App):
    """Main management application (post-deploy xinas-menu)."""

    CSS_PATH: ClassVar[Path] = Path(__file__).parent / "styles.tcss"

    BINDINGS: ClassVar[list[Binding]] = [
        Binding("ctrl+c", "quit", "Quit", show=False, priority=True),
        Binding("ctrl+y", "copy_content", "Copy output", show=True),
        Binding("u", "check_update", "Check updates", show=True),
        Binding("?", "help", "Help", show=True),
    ]

    update_available: reactive[bool] = reactive(False)

    def __init__(
        self,
        no_welcome: bool = False,
        grpc_address: str = "localhost:6066",
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._no_welcome = no_welcome
        self.grpc = XiRAIDClient(grpc_address)
        self.nfs = NFSHelperClient()
        self.audit = AuditLogger()
        self._update_checker = UpdateChecker()

    def compose(self) -> ComposeResult:
        yield XiNASHeader()

    async def on_mount(self) -> None:
        from xinas_menu.screens.welcome import WelcomeScreen
        from xinas_menu.screens.main_menu import MainMenuScreen

        if self._no_welcome:
            await self.push_screen(MainMenuScreen())
        else:
            await self.push_screen(WelcomeScreen())

        # Background update check
        asyncio.create_task(self._bg_update_check())

    async def _bg_update_check(self) -> None:
        try:
            available = await self._update_checker.check()
            if available:
                self.update_available = True
                header = self.query_one(XiNASHeader)
                header.update_available = True
        except Exception:
            pass

    def watch_update_available(self, value: bool) -> None:
        try:
            header = self.query_one(XiNASHeader)
            header.update_available = value
        except Exception:
            pass

    async def action_check_update(self) -> None:
        if self.update_available:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            confirmed = await self.push_screen_wait(
                ConfirmDialog("An update is available. Apply now and restart?", "Update Available")
            )
            if confirmed:
                await self._apply_update()

    async def _apply_update(self) -> None:
        loop = asyncio.get_event_loop()
        ok, msg = await loop.run_in_executor(None, self._update_checker.apply_update)
        if ok:
            self.audit.log("system.update", "git pull succeeded — restarting")
            self._update_checker.restart_self()
        else:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            await self.push_screen_wait(
                ConfirmDialog(f"Update failed: {msg}", "Update Error")
            )

    def action_copy_content(self) -> None:
        """Copy the visible content panel text to clipboard (Ctrl+Y)."""
        from xinas_menu.widgets.text_view import ScrollableTextView
        try:
            screen = self.screen
            view = screen.query_one(ScrollableTextView)
            text = view.get_text()
            if text:
                msg = _copy_text(text)
                self.notify(msg, timeout=3)
        except Exception:
            pass

    def action_help(self) -> None:
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog
        self.push_screen(
            ConfirmDialog(
                "xiNAS Management Console\n\n"
                "Arrow keys / number keys — navigate\n"
                "Enter — select\n"
                "0 or Esc — back\n"
                "U — check for updates\n"
                "Ctrl+C — quit",
                "Help",
            )
        )

    async def on_unmount(self) -> None:
        self.grpc.close()


def _copy_text(text: str) -> str:
    """Copy text to clipboard using the best available method.

    Priority:
      1. tmux set-buffer  (inside tmux — no extra config needed)
      2. xclip -selection clipboard
      3. xsel --clipboard --input
      4. wl-copy  (Wayland)
      5. write to /tmp/xinas_copy.txt as last resort
    Returns a short status string for the notification.
    """
    import os
    import subprocess
    import tempfile

    data = text.encode()

    # ── tmux ──────────────────────────────────────────────────────────────
    if os.environ.get("TMUX"):
        # set-buffer passes text as argument — works on all tmux versions
        try:
            r = subprocess.run(
                ["tmux", "set-buffer", "--", text],
                capture_output=True, timeout=5,
            )
            if r.returncode == 0:
                return "Copied to tmux buffer  (paste with prefix + ])"
        except Exception:
            pass
        # fallback: load-buffer via stdin (tmux ≥ 2.0)
        try:
            r = subprocess.run(
                ["tmux", "load-buffer", "-"],
                input=data, capture_output=True, timeout=5,
            )
            if r.returncode == 0:
                return "Copied to tmux buffer  (paste with prefix + ])"
        except Exception:
            pass

    # ── xclip ─────────────────────────────────────────────────────────────
    try:
        r = subprocess.run(
            ["xclip", "-selection", "clipboard"],
            input=data, capture_output=True, timeout=5,
        )
        if r.returncode == 0:
            return "Copied to clipboard (xclip)"
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # ── xsel ──────────────────────────────────────────────────────────────
    try:
        r = subprocess.run(
            ["xsel", "--clipboard", "--input"],
            input=data, capture_output=True, timeout=5,
        )
        if r.returncode == 0:
            return "Copied to clipboard (xsel)"
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # ── wl-copy (Wayland) ─────────────────────────────────────────────────
    try:
        r = subprocess.run(
            ["wl-copy"], input=data, capture_output=True, timeout=5,
        )
        if r.returncode == 0:
            return "Copied to clipboard (wl-copy)"
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # ── last resort: write to temp file ───────────────────────────────────
    try:
        path = "/tmp/xinas_copy.txt"
        with open(path, "w") as f:
            f.write(text)
        return f"Saved to {path}  (cat {path} | xclip)"
    except Exception:
        pass

    return "Copy failed — no clipboard tool available"
