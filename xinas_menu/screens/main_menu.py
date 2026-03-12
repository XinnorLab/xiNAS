"""MainMenuScreen — top-level navigation (11 items)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

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


class MainMenuScreen(Screen):
    """Root navigation screen with cached sub-screens."""

    BINDINGS = [
        Binding("escape", "app.quit", "Quit", show=True, key_display="0/Esc"),
        Binding("0", "exit_app", "Exit", show=False),
    ]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._screen_cache: dict[str, Screen] = {}

    def compose(self) -> ComposeResult:
        yield Label("  xiNAS Management Console", id="main-prompt")
        yield NavigableMenu(_ITEMS, id="main-nav")
        yield Footer()

    def _get_screen(self, key: str) -> Screen | None:
        """Return a cached screen instance, creating it on first access."""
        if key in self._screen_cache:
            return self._screen_cache[key]

        screen = None
        if key == "1":
            from xinas_menu.screens.quick_actions import QuickActionsScreen
            screen = QuickActionsScreen(show_status=True)
        elif key == "2":
            from xinas_menu.screens.raid import RAIDScreen
            screen = RAIDScreen()
        elif key == "3":
            from xinas_menu.screens.network import NetworkScreen
            screen = NetworkScreen()
        elif key == "4":
            from xinas_menu.screens.nfs import NFSScreen
            screen = NFSScreen()
        elif key == "5":
            from xinas_menu.screens.users import UsersScreen
            screen = UsersScreen()
        elif key == "6":
            from xinas_menu.screens.exporter import ExporterScreen
            screen = ExporterScreen()
        elif key == "7":
            from xinas_menu.screens.quick_actions import QuickActionsScreen
            screen = QuickActionsScreen()
        elif key == "8":
            from xinas_menu.screens.health import HealthScreen
            screen = HealthScreen()
        elif key == "A":
            from xinas_menu.screens.mcp import MCPScreen
            screen = MCPScreen()

        if screen is not None:
            self._screen_cache[key] = screen
        return screen

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        self._handle(event.key)

    def _handle(self, key: str) -> None:
        key = key.upper()
        if key == "0":
            self.app.exit()
        elif key == "9":
            self._do_update_check()
        else:
            screen = self._get_screen(key)
            if screen is not None:
                self.app.push_screen(screen)

    def _do_update_check(self) -> None:
        self._async_update_check()

    @work(exclusive=True)
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
