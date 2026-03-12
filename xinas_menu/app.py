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
        Binding("u", "check_update", "Update", show=False),
        Binding("?", "help", "Help", show=False),
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
        # Screens are pushed imperatively; nothing else at root level
        from textual.widgets import Footer
        yield Footer()

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
