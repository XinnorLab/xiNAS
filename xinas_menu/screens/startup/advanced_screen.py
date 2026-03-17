"""AdvancedScreen — pre-install configuration menu."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "Configure Network"),
    MenuItem("2", "Set Hostname"),
    MenuItem("3", "Configure RAID"),
    MenuItem("4", "Edit NFS Exports"),
    MenuItem("5", "Load / Save Preset"),
    MenuItem("6", "Git Repository Config"),
    MenuItem("7", "Check for Updates"),
    MenuItem("0", "Back"),
]

_REPO_ROOT = Path("/opt/xiNAS")


class AdvancedScreen(Screen):
    """Advanced settings for pre-deployment configuration."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=False),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── Advanced Settings ──")
        yield NavigableMenu(_MENU, id="adv-nav")
        yield ScrollableTextView(id="adv-content")

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self.app.push_screen(
                _SubprocessScreen("configure_network.sh", "Configure Network")
            )
        elif key == "2":
            self.app.push_screen(
                _SubprocessScreen("configure_hostname.sh", "Set Hostname")
            )
        elif key == "3":
            self.app.push_screen(
                _SubprocessScreen("configure_raid.sh", "Configure RAID")
            )
        elif key == "4":
            self.app.push_screen(
                _SubprocessScreen("configure_nfs_exports.sh", "Edit NFS Exports")
            )
        elif key == "5":
            asyncio.create_task(self._preset_menu())
        elif key == "6":
            asyncio.create_task(self._git_config())
        elif key == "7":
            asyncio.create_task(self._check_updates())

    async def _preset_menu(self) -> None:
        from xinas_menu.screens.configure.raid_config import list_presets
        presets = list_presets()
        preset = await self.app.push_screen_wait(
            InputDialog(
                f"Available presets: {', '.join(presets)}\nPreset name:",
                "Load Preset",
            )
        )
        if not preset:
            return
        view = self.query_one("#adv-content", ScrollableTextView)
        view.set_content(f"[dim]Preset '{preset}' selected (configure via yq/editor)[/dim]")

    async def _git_config(self) -> None:
        url = await self.app.push_screen_wait(
            InputDialog("Git remote URL (blank to show current):", "Git Config")
        )
        if not url:
            loop = asyncio.get_running_loop()
            out = await loop.run_in_executor(
                None,
                lambda: subprocess.run(
                    ["git", "-C", str(_REPO_ROOT), "remote", "-v"],
                    capture_output=True, text=True,
                ).stdout
            )
            view = self.query_one("#adv-content", ScrollableTextView)
            view.set_content(out or "[dim]No remotes.[/dim]")
        else:
            loop = asyncio.get_running_loop()
            r = await loop.run_in_executor(
                None,
                lambda: subprocess.run(
                    ["git", "-C", str(_REPO_ROOT), "remote", "set-url", "origin", url],
                    capture_output=True, text=True,
                )
            )
            if r.returncode == 0:
                await self.app.push_screen_wait(ConfirmDialog("Remote URL updated.", "Done", ok_only=True))
            else:
                await self.app.push_screen_wait(ConfirmDialog(r.stderr[:200], "Error", ok_only=True))

    async def _check_updates(self) -> None:
        view = self.query_one("#adv-content", ScrollableTextView)
        view.set_content("[dim]Checking…[/dim]")
        available = await self.app._update_checker.check()
        if available:
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog("Update available. Apply?", "Update")
            )
            if confirmed:
                await self.app._apply_update()
        else:
            view.set_content("[green]Repository is up to date.[/green]")


class _SubprocessScreen(Screen):
    """Dummy placeholder — the configure scripts are whiptail-based.

    In production these will be replaced by the configure/ screens.
    For now, shows a message directing the user to use the configure screens.
    """

    BINDINGS = [Binding("escape", "app.pop_screen", "Back", show=True)]

    def __init__(self, script: str, title: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self._script = script
        self._title = title

    def compose(self) -> ComposeResult:
        yield Label(f"  ── {self._title} ──")
        yield Label(
            f"\n  This will launch the configuration editor.\n"
            f"  Script: {self._script}\n\n"
            f"  Press [Esc] to return or use the Configure sub-menu.",
        )
