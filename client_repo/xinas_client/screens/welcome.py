"""WelcomeScreen -- splash screen shown at startup."""
from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path

_log = logging.getLogger(__name__)

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer, Rule

from xinas_client.version import CLIENT_VERSION

_ART = r"""
        _ _  _   _   ___    ___ _ _         _
  __ __(_) \| | /_\ / __|  / __| (_)___ _ _| |_
  \ \ /| | .` |/ _ \\__ \ | (__| | / -_) ' \  _|
  /_\_\|_|_|\_/_/ \_\___/  \___|_|_\___|_||_\__|
"""


class WelcomeScreen(Screen):
    """Shows ASCII art + service probes, then auto-advances to ClientMainMenuScreen."""

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
                f"v{CLIENT_VERSION}  \u2502  High-Performance NFS Client",
                id="welcome-subtitle",
            )
            yield Label("  Probing services \u2026", id="welcome-status")
            yield Label("\u23ce  Press Enter to continue", id="welcome-hint")
        yield Footer()

    async def on_mount(self) -> None:
        def _log_exc(t: asyncio.Task) -> None:
            if not t.cancelled() and t.exception():
                _log.debug("Task failed: %s", t.exception())

        asyncio.create_task(self._probe_services()).add_done_callback(_log_exc)
        asyncio.create_task(self._auto_proceed()).add_done_callback(_log_exc)

    async def _probe_services(self) -> None:
        """Check NFS tools and RDMA availability."""
        loop = asyncio.get_running_loop()
        status_lines: list[str] = []

        # NFS tools check
        nfs_found = await loop.run_in_executor(
            None, lambda: shutil.which("mount.nfs4") is not None
        )
        if nfs_found:
            status_lines.append("  \u25cf NFS tools   \u2014 installed")
        else:
            status_lines.append("  \u25cb NFS tools   \u2014 not available")

        # RDMA availability check
        rdma_found = await loop.run_in_executor(
            None, lambda: Path("/sys/class/infiniband").exists()
        )
        if rdma_found:
            status_lines.append("  \u25cf RDMA        \u2014 available")
        else:
            status_lines.append("  \u25cb RDMA        \u2014 not available")

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
        from xinas_client.screens.main_menu import ClientMainMenuScreen

        self.app.switch_screen(ClientMainMenuScreen())
