"""SystemScreen — System submenu (Status, License, Settings, Exporter, Quick Actions)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_MENU = [
    MenuItem("1", "Status"),
    MenuItem("2", "License"),
    MenuItem("3", "Settings"),
    MenuItem("4", "xiRAID Exporter"),
    MenuItem("5", "Quick Actions"),
    MenuItem("0", "Back"),
]


class SystemScreen(Screen):
    """System submenu — routes to system-related screens."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  System", id="main-prompt")
        yield NavigableMenu(_MENU, id="system-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_menu.screens.system_status import SystemStatusScreen
            self.app.push_screen(SystemStatusScreen())
        elif key == "2":
            from xinas_menu.screens.license import LicenseScreen
            self.app.push_screen(LicenseScreen())
        elif key == "3":
            from xinas_menu.screens.settings import SettingsScreen
            self.app.push_screen(SettingsScreen())
        elif key == "4":
            from xinas_menu.screens.exporter import ExporterScreen
            self.app.push_screen(ExporterScreen())
        elif key == "5":
            from xinas_menu.screens.quick_actions import QuickActionsScreen
            self.app.push_screen(QuickActionsScreen())
