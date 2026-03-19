"""IntegrationsScreen — Integrations submenu (MCP Server, xiRAID Exporter)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_MENU = [
    MenuItem("1", "MCP Server"),
    MenuItem("2", "xiRAID Exporter"),
    MenuItem("0", "Back"),
]


class IntegrationsScreen(Screen):
    """Integrations submenu — external integration components."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Integrations", id="main-prompt")
        yield NavigableMenu(_MENU, id="integrations-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_menu.screens.mcp import MCPScreen
            self.app.push_screen(MCPScreen())
        elif key == "2":
            from xinas_menu.screens.exporter import ExporterScreen
            self.app.push_screen(ExporterScreen())
