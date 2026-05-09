"""XiNASClientApp — root Textual application for xinas-client."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import ClassVar

_log = logging.getLogger(__name__)

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.reactive import reactive
from textual import work

from xinas_client.utils.update_check import UpdateChecker
from xinas_client.widgets.alert_bar import AlertBar
from xinas_client.widgets.header import XiNASClientHeader

__all__ = ["XiNASClientApp"]


class XiNASClientApp(App):
    """NFS client management application."""

    CSS_PATH: ClassVar[Path] = Path(__file__).parent / "styles.tcss"

    BINDINGS: ClassVar[list[Binding]] = [
        Binding("ctrl+c", "quit", "Quit", show=False, priority=True),
        Binding("ctrl+y", "copy_content", "Copy output", show=True),
        Binding("u", "check_update", "Check updates", show=True),
        Binding("?", "help", "Help", show=True),
        Binding("pageup", "scroll_up", "Scroll", show=True, key_display="PgUp/Dn"),
        Binding("pagedown", "scroll_down", "Scroll", show=False),
    ]

    update_available: reactive[bool] = reactive(False)

    def __init__(
        self,
        no_welcome: bool = False,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._no_welcome = no_welcome
        self._update_checker = UpdateChecker()

    def compose(self) -> ComposeResult:
        yield XiNASClientHeader()
        yield AlertBar()

    async def on_mount(self) -> None:
        from xinas_client.screens.welcome import WelcomeScreen
        from xinas_client.screens.main_menu import ClientMainMenuScreen

        if self._no_welcome:
            await self.push_screen(ClientMainMenuScreen())
        else:
            await self.push_screen(WelcomeScreen())

        # Background update check
        task = asyncio.create_task(self._bg_update_check())
        task.add_done_callback(
            lambda t: t.exception() if not t.cancelled() and t.exception() else None
        )

        # Check root privilege
        self._check_root()

    def _check_root(self) -> None:
        """Warn via AlertBar if not running as root."""
        import os

        if os.geteuid() != 0:
            alert_bar = self.query_one(AlertBar)
            alert_bar.set_alert(
                "root",
                "warning",
                "Not running as root — some operations will fail",
            )

    async def _bg_update_check(self) -> None:
        try:
            available = await self._update_checker.check()
            if available:
                self.update_available = True
                header = self.query_one(XiNASClientHeader)
                header.update_available = True
        except Exception:
            _log.debug("background update check failed", exc_info=True)

    def watch_update_available(self, value: bool) -> None:
        try:
            header = self.query_one(XiNASClientHeader)
            header.update_available = value
        except Exception:
            _log.debug("could not update header badge", exc_info=True)

    @work(exclusive=True)
    async def action_check_update(self) -> None:
        if self.update_available:
            from xinas_client.widgets.confirm_dialog import ConfirmDialog

            confirmed = await self.push_screen_wait(
                ConfirmDialog(
                    "An update is available. Apply now and restart?",
                    "Update Available",
                )
            )
            if confirmed:
                await self._apply_update()

    async def _apply_update(self) -> None:
        loop = asyncio.get_running_loop()
        ok, msg = await loop.run_in_executor(
            None, self._update_checker.apply_update
        )
        if ok:
            self._update_checker.restart_self()
        else:
            self.notify(f"Update failed: {msg}", severity="error")

    def action_copy_content(self) -> None:
        """Copy the visible content panel text to clipboard (Ctrl+Y)."""
        from xinas_client.widgets.text_view import ScrollableTextView

        try:
            view = self.screen.query_one(ScrollableTextView)
            text = view.get_text()
            if text:
                self._do_copy(text)
        except Exception:
            _log.debug("copy content failed (no text view on screen?)", exc_info=True)

    @work(exclusive=True, thread=True)
    def _do_copy(self, text: str) -> None:
        msg = _copy_text(text)
        self.call_from_thread(self.notify, msg, timeout=3)

    def action_scroll_up(self) -> None:
        from xinas_client.widgets.text_view import ScrollableTextView

        try:
            view = self.screen.query_one(ScrollableTextView)
            log = view.query_one("#text-view-area")
            log.scroll_page_up()
        except Exception:
            _log.debug("scroll up failed", exc_info=True)

    def action_scroll_down(self) -> None:
        from xinas_client.widgets.text_view import ScrollableTextView

        try:
            view = self.screen.query_one(ScrollableTextView)
            log = view.query_one("#text-view-area")
            log.scroll_page_down()
        except Exception:
            _log.debug("scroll down failed", exc_info=True)

    def action_help(self) -> None:
        from xinas_client.widgets.confirm_dialog import ConfirmDialog

        self.push_screen(
            ConfirmDialog(
                "xiNAS Client Console\n\n"
                "Arrow keys / number keys — navigate\n"
                "Enter — select\n"
                "0 or Esc — back\n"
                "PgUp / PgDn — scroll output panel\n"
                "U — check for updates\n"
                "Ctrl+Y — copy output to clipboard\n"
                "Ctrl+C — quit",
                "Help",
                ok_only=True,
            )
        )


def _copy_text(text: str) -> str:
    """Copy text to clipboard using the best available method."""
    import os
    import subprocess

    data = text.encode()

    # tmux
    if os.environ.get("TMUX"):
        try:
            r = subprocess.run(
                ["tmux", "set-buffer", "--", text],
                capture_output=True,
                timeout=5,
            )
            if r.returncode == 0:
                return "Copied to tmux buffer  (paste with prefix + ])"
        except Exception:
            pass
        try:
            r = subprocess.run(
                ["tmux", "load-buffer", "-"],
                input=data,
                capture_output=True,
                timeout=5,
            )
            if r.returncode == 0:
                return "Copied to tmux buffer  (paste with prefix + ])"
        except Exception:
            pass

    # xclip
    try:
        r = subprocess.run(
            ["xclip", "-selection", "clipboard"],
            input=data,
            capture_output=True,
            timeout=5,
        )
        if r.returncode == 0:
            return "Copied to clipboard (xclip)"
    except FileNotFoundError:
        pass

    # xsel
    try:
        r = subprocess.run(
            ["xsel", "--clipboard", "--input"],
            input=data,
            capture_output=True,
            timeout=5,
        )
        if r.returncode == 0:
            return "Copied to clipboard (xsel)"
    except FileNotFoundError:
        pass

    # wl-copy (Wayland)
    try:
        r = subprocess.run(
            ["wl-copy"],
            input=data,
            capture_output=True,
            timeout=5,
        )
        if r.returncode == 0:
            return "Copied to clipboard (wl-copy)"
    except FileNotFoundError:
        pass

    # last resort
    try:
        path = "/tmp/xinas_copy.txt"
        with open(path, "w") as f:
            f.write(text)
        return f"Saved to {path}  (cat {path} | xclip)"
    except Exception:
        pass

    return "Copy failed — no clipboard tool available"
