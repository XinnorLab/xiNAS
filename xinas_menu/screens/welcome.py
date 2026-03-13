"""WelcomeScreen — splash screen shown at startup."""
from __future__ import annotations

import asyncio
import logging

_log = logging.getLogger(__name__)

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer, Rule

from xinas_menu.version import XINAS_MENU_VERSION

_ART = r"""
        _ _  _   _   ___
  __ __(_) \| | /_\ / __|
  \ \ /| | .` |/ _ \\__ \
  /_\_\|_|_|\_/_/ \_\___/
"""


class WelcomeScreen(Screen):
    """Shows ASCII art + system status, then auto-advances to MainMenuScreen."""

    BINDINGS = [
        Binding("enter", "proceed", "Continue", show=True),
        Binding("space", "proceed", "Continue", show=False),
        Binding("escape", "proceed", "Continue", show=False),
    ]

    def compose(self) -> ComposeResult:
        from textual.containers import Vertical
        with Vertical(id="welcome-box"):
            yield Label(_ART, id="welcome-art")
            yield Rule(id="welcome-rule")
            yield Label(
                f"v{XINAS_MENU_VERSION}  \u2502  High-Performance NAS Storage",
                id="welcome-subtitle",
            )
            yield Label("  Probing services \u2026", id="welcome-status")
            yield Label("\u23ce  Press Enter to continue", id="welcome-hint")
        yield Footer()

    async def on_mount(self) -> None:
        def _log_exc(t: asyncio.Task) -> None:
            if not t.cancelled() and t.exception():
                import logging
                logging.getLogger("xinas").debug("Task failed: %s", t.exception())

        asyncio.create_task(self._probe_services()).add_done_callback(_log_exc)
        asyncio.create_task(self._auto_proceed()).add_done_callback(_log_exc)

    async def _probe_services(self) -> None:
        app = self.app
        status_lines = []

        ok, _data, err = await app.grpc.get_server_info()
        if ok:
            status_lines.append("  \u25cf xiRAID gRPC \u2014 connected")
        else:
            status_lines.append(f"  \u25cb xiRAID gRPC \u2014 {err[:60]}")

        loop = asyncio.get_running_loop()
        nfs_ok, _, nfs_err = await loop.run_in_executor(None, app.nfs.list_exports)
        if nfs_ok:
            status_lines.append("  \u25cf NFS helper  \u2014 connected")
        else:
            status_lines.append(f"  \u25cb NFS helper  \u2014 {nfs_err[:60]}")

        try:
            lbl = self.query_one("#welcome-status", Label)
            lbl.update("\n".join(status_lines))
        except Exception:
            _log.debug("could not update welcome status label", exc_info=True)

    async def _auto_proceed(self) -> None:
        await asyncio.sleep(2)
        if self.is_current:
            self.action_proceed()

    def action_proceed(self) -> None:
        if not self.is_current:
            return
        from xinas_menu.screens.main_menu import MainMenuScreen
        self.app.switch_screen(MainMenuScreen())
