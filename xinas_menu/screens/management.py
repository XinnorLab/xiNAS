"""ManagementScreen — Management submenu (Settings, Integrations, Updates)."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_MENU = [
    MenuItem("1", "Settings"),
    MenuItem("2", "Integrations"),
    MenuItem("3", "Check for Updates"),
    MenuItem("0", "Back"),
]


class ManagementScreen(Screen):
    """Management submenu — routes to management-related screens."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Management", id="main-prompt")
        yield NavigableMenu(_MENU, id="mgmt-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_menu.screens.settings import SettingsScreen
            self.app.push_screen(SettingsScreen())
        elif key == "2":
            from xinas_menu.screens.integrations import IntegrationsScreen
            self.app.push_screen(IntegrationsScreen())
        elif key == "3":
            self._do_update_check()

    @work(exclusive=True)
    async def _do_update_check(self) -> None:
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
            self.app.notify("xiNAS is up to date.", severity="information")
