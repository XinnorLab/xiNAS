"""StartupApp — provisioning/Ansible menu (replaces startup_menu.sh)."""
from __future__ import annotations

from pathlib import Path
from typing import ClassVar

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Footer

from xinas_menu.api.grpc_client import XiRAIDClient
from xinas_menu.api.nfs_client import NFSHelperClient
from xinas_menu.utils.audit import AuditLogger
from xinas_menu.utils.update_check import UpdateChecker
from xinas_menu.widgets.header import XiNASHeader

_MENU_ITEMS_MAIN = [
    ("1", "Collect System Data"),
    ("2", "Enter License"),
    ("3", "Install"),
    ("4", "Advanced Settings"),
    ("0", "Exit"),
]


class StartupApp(App):
    """Provisioning app (xinas-setup / startup_menu.sh replacement)."""

    CSS_PATH: ClassVar[Path] = Path(__file__).parent.parent.parent / "styles.tcss"

    BINDINGS: ClassVar[list[Binding]] = [
        Binding("ctrl+c", "quit", "Quit", show=False, priority=True),
    ]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.grpc = XiRAIDClient()
        self.nfs = NFSHelperClient()
        self.audit = AuditLogger()
        self._update_checker = UpdateChecker()

    def compose(self) -> ComposeResult:
        yield XiNASHeader()
        yield Footer()

    async def on_mount(self) -> None:
        from xinas_menu.screens.startup._startup_main import StartupMainScreen
        await self.push_screen(StartupMainScreen())

    async def _apply_update(self) -> None:
        import asyncio
        loop = asyncio.get_running_loop()
        ok, msg = await loop.run_in_executor(None, self._update_checker.apply_update)
        if ok:
            self.audit.log("system.update", "git pull succeeded — restarting")
            self._update_checker.restart_self()
        else:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            await self.push_screen_wait(ConfirmDialog(f"Update failed: {msg}", "Error"))

    async def on_unmount(self) -> None:
        self.grpc.close()
