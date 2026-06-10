"""ManagementScreen — Management submenu (Settings, Integrations, Updates, Uninstall)."""

from __future__ import annotations

import os

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu

_UNINSTALL_SCRIPT = "/opt/xiNAS/uninstall.sh"

_MENU = [
    MenuItem("1", "Settings"),
    MenuItem("2", "Integrations"),
    MenuItem("3", "Check for Updates"),
    MenuItem("4", "Uninstall xiNAS"),
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
        elif key == "4":
            self._trigger_uninstall()

    def _trigger_uninstall(self) -> None:
        """Hand off to /opt/xiNAS/uninstall.sh.

        Uninstall removes /opt/xiNAS while the TUI is still loaded from it,
        so we cannot shell out and resume — we exit the app with a marker
        result. The CLI entry point (xinas_menu.__main__.main) inspects
        the result and execs the uninstall script.
        """
        if not os.path.isfile(_UNINSTALL_SCRIPT):
            self.app.notify(
                f"{_UNINSTALL_SCRIPT} not found. Run `git pull` in /opt/xiNAS first.",
                severity="error",
                timeout=10,
            )
            return
        self.app.exit(result="uninstall")

    @work(exclusive=True)
    async def _do_update_check(self) -> None:
        result = await self.app._update_checker.check()
        if result.error:
            self.app.notify(
                f"Update check failed: {result.error}",
                severity="error",
                timeout=10,
            )
            return
        if result.available:
            self.app._last_check_result = result
            self.app.update_available = True
            await self.app.prompt_and_apply_update(result)
        else:
            self.app.notify("xiNAS is up to date.", severity="information")
