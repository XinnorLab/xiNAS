"""MainMenuScreen — top-level navigation (4 groups + Exit)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_ITEMS = [
    MenuItem("1", "System"),
    MenuItem("2", "Storage"),
    MenuItem("3", "Network"),
    MenuItem("4", "Management"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Exit"),
]


class MainMenuScreen(Screen):
    """Root navigation screen — routes to group submenus."""

    BINDINGS = [
        Binding("escape", "app.quit", "Quit", show=True, key_display="0/Esc"),
        Binding("0", "exit_app", "Exit", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  xiNAS Management Console", id="main-prompt")
        yield NavigableMenu(_ITEMS, id="main-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.exit()
        elif key == "1":
            from xinas_menu.screens.system import SystemScreen
            self.app.push_screen(SystemScreen())
        elif key == "2":
            from xinas_menu.screens.storage import StorageScreen
            self.app.push_screen(StorageScreen())
        elif key == "3":
            from xinas_menu.screens.network import NetworkScreen
            self.app.push_screen(NetworkScreen())
        elif key == "4":
            from xinas_menu.screens.management import ManagementScreen
            self.app.push_screen(ManagementScreen())

    def action_exit_app(self) -> None:
        self.app.exit()
