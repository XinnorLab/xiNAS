"""StartupMainScreen — main menu for xinas-setup."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "Collect System Data"),
    MenuItem("2", "Enter License"),
    MenuItem("3", "Install"),
    MenuItem("4", "Advanced Settings"),
    MenuItem("0", "Exit"),
]

_REPO_CANDIDATES = [Path("/opt/xiNAS"), Path("/home/xinnor/xiNAS")]


def _repo() -> Path:
    for p in _REPO_CANDIDATES:
        if p.exists():
            return p
    return _REPO_CANDIDATES[0]


class StartupMainScreen(Screen):
    """Main entry point for the provisioning workflow."""

    BINDINGS = [
        Binding("escape", "app.quit", "Exit", show=False),
        Binding("0", "app.quit", "Exit", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── xiNAS Setup ──")
        yield NavigableMenu(_MENU, id="setup-nav")
        yield ScrollableTextView("  Select an option to begin.", id="setup-content")

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.exit()
        elif key == "1":
            asyncio.create_task(self._collect_data())
        elif key == "2":
            self._enter_license()
        elif key == "3":
            from xinas_menu.screens.startup.install_screen import InstallScreen
            self.app.push_screen(InstallScreen())
        elif key == "4":
            from xinas_menu.screens.startup.advanced_screen import AdvancedScreen
            self.app.push_screen(AdvancedScreen())

    async def _collect_data(self) -> None:
        view = self.query_one("#setup-content", ScrollableTextView)
        view.set_content("[dim]Collecting system data…[/dim]")
        collect_script = _repo() / "collect_data.sh"
        if not collect_script.exists():
            view.set_content("[red]collect_data.sh not found.[/red]")
            return
        loop = asyncio.get_running_loop()
        r = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                [str(collect_script)], capture_output=True, text=True
            )
        )
        if r.returncode == 0:
            view.set_content(f"[green]Done.[/green]\n{r.stdout}")
        else:
            view.set_content(f"[red]Failed:[/red]\n{r.stderr[:500]}")

    def _enter_license(self) -> None:
        from xinas_menu.screens.startup.license_screen import LicenseScreen
        self.app.push_screen(LicenseScreen())
