"""InstallScreen — preset selection + Ansible playbook execution."""
from __future__ import annotations

import asyncio
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_REPO_ROOT_CANDIDATES = [
    Path("/opt/xiNAS"),
    Path("/home/xinnor/xiNAS"),
]


def _repo_root() -> Path:
    for p in _REPO_ROOT_CANDIDATES:
        if p.exists():
            return p
    return _REPO_ROOT_CANDIDATES[0]


def _preset_items() -> tuple[list[MenuItem], list[str]]:
    presets_dir = _repo_root() / "presets"
    presets = [p.name for p in sorted(presets_dir.iterdir()) if p.is_dir()] if presets_dir.exists() else ["default"]
    items = [MenuItem(str(i + 1), p) for i, p in enumerate(presets)]
    items.append(MenuItem("0", "Back"))
    return items, presets


class InstallScreen(Screen):
    """Multi-step install: preset → confirm → run playbook."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=False),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._preset_menu_items, self._presets = _preset_items()

    def compose(self) -> ComposeResult:
        yield Label("  ── Install — Select Preset ──")
        yield NavigableMenu(self._preset_menu_items, id="install-nav")
        yield ScrollableTextView(
            "  Select a preset to begin installation.", id="install-content"
        )

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
            return
        try:
            idx = int(event.key) - 1
            if 0 <= idx < len(self._presets):
                asyncio.create_task(self._confirm_and_run(self._presets[idx]))
        except ValueError:
            pass

    async def _confirm_and_run(self, preset: str) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Install using preset '{preset}'?\n\n"
                "This will run ansible-playbook site.yml.\n"
                "Existing data will NOT be wiped unless xfs_force_mkfs is set.",
                "Confirm Installation",
            )
        )
        if not confirmed:
            return

        # Check license
        if not (Path("/tmp/license").exists()):
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "No license found at /tmp/license.\n"
                    "Please enter your license first.",
                    "License Required",
                )
            )
            return

        from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen
        repo = _repo_root()
        cmd = [
            "ansible-playbook",
            str(repo / "presets" / preset / "playbook.yml"),
            "-i", str(repo / "inventories" / "hosts"),
            "--extra-vars", f"preset={preset}",
        ]
        exit_code = await self.app.push_screen_wait(
            PlaybookRunScreen(cmd=cmd, title=f"Installing — {preset}", workdir=repo)
        )
        if exit_code == 0:
            await self.app.push_screen_wait(
                ConfirmDialog("Installation completed successfully!", "Success")
            )
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Installation failed (exit {exit_code}).\nCheck the log above.",
                    "Failed",
                )
            )
