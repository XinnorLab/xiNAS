"""MainMenuScreen — top-level navigation (11 items)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_ITEMS = [
    MenuItem("1", "System Status"),
    MenuItem("2", "RAID Management"),
    MenuItem("3", "Network Settings"),
    MenuItem("4", "NFS Access Rights"),
    MenuItem("5", "User Management"),
    MenuItem("", "", separator=True),
    MenuItem("6", "xiRAID Exporter"),
    MenuItem("7", "Quick Actions"),
    MenuItem("8", "Health Check"),
    MenuItem("9", "Check for Updates"),
    MenuItem("", "", separator=True),
    MenuItem("A", "MCP Server"),
    MenuItem("0", "Exit"),
]

_SCREEN_MAP = {
    "1": "xinas_menu.screens.quick_actions",   # will be replaced by actual imports
    "2": "raid",
    "3": "network",
    "4": "nfs",
    "5": "users",
    "6": "exporter",
    "7": "quick_actions",
    "8": "health",
    "9": "update",
    "A": "mcp",
    "0": None,
}


class MainMenuScreen(Screen):
    """Root navigation screen."""

    BINDINGS = [
        Binding("escape", "app.quit", "Quit", show=False),
        Binding("0", "exit_app", "Exit", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Select an option:", id="main-prompt")
        yield NavigableMenu(_ITEMS, id="main-nav")

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        self._handle(event.key)

    def _handle(self, key: str) -> None:
        key = key.upper()
        if key == "0":
            self.app.exit()
        elif key == "1":
            from xinas_menu.screens.quick_actions import QuickActionsScreen
            self.app.push_screen(QuickActionsScreen(show_status=True))
        elif key == "2":
            from xinas_menu.screens.raid import RAIDScreen
            self.app.push_screen(RAIDScreen())
        elif key == "3":
            from xinas_menu.screens.network import NetworkScreen
            self.app.push_screen(NetworkScreen())
        elif key == "4":
            from xinas_menu.screens.nfs import NFSScreen
            self.app.push_screen(NFSScreen())
        elif key == "5":
            from xinas_menu.screens.users import UsersScreen
            self.app.push_screen(UsersScreen())
        elif key == "6":
            from xinas_menu.screens.exporter import ExporterScreen
            self.app.push_screen(ExporterScreen())
        elif key == "7":
            from xinas_menu.screens.quick_actions import QuickActionsScreen
            self.app.push_screen(QuickActionsScreen())
        elif key == "8":
            from xinas_menu.screens.health import HealthScreen
            self.app.push_screen(HealthScreen())
        elif key == "9":
            self._do_update_check()
        elif key == "A":
            from xinas_menu.screens.mcp import MCPScreen
            self.app.push_screen(MCPScreen())

    def _do_update_check(self) -> None:
        import asyncio
        asyncio.create_task(self._async_update_check())

    async def _async_update_check(self) -> None:
        available = await self.app._update_checker.check()
        if available:
            self.app.update_available = True
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog("An update is available. Apply now?", "Update Available")
            )
            if confirmed:
                await self.app._apply_update()
        else:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            await self.app.push_screen_wait(
                ConfirmDialog("xiNAS is up to date.", "Updates")
            )

    def action_exit_app(self) -> None:
        self.app.exit()
