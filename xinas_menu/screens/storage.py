"""StorageScreen — Storage submenu (RAID, NFS, Physical Drives)."""
from __future__ import annotations

import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "RAID Management"),
    MenuItem("2", "NFS Access Rights"),
    MenuItem("3", "Physical Drives"),
    MenuItem("4", "Filesystem"),
    MenuItem("0", "Back"),
]


class StorageScreen(Screen):
    """Storage submenu — routes to storage-related screens."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Storage", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="storage-nav")
            yield ScrollableTextView(id="storage-content")
        yield Footer()

    def on_mount(self) -> None:
        BLD, DIM, CYN, NC = "\033[1m", "\033[2m", "\033[36m", "\033[0m"
        view = self.query_one("#storage-content", ScrollableTextView)
        view.set_content(
            f"{BLD}{CYN}Storage Management{NC}\n"
            f"\n"
            f"  {BLD}1{NC}  {CYN}RAID Management{NC}    {DIM}Manage xiRAID arrays (create, modify, delete){NC}\n"
            f"  {BLD}2{NC}  {CYN}NFS Access Rights{NC}  {DIM}Configure NFS exports and shares{NC}\n"
            f"  {BLD}3{NC}  {CYN}Physical Drives{NC}    {DIM}View drive inventory and RAID membership{NC}\n"
            f"  {BLD}4{NC}  {CYN}Filesystem{NC}         {DIM}Create and manage XFS filesystems{NC}\n"
        )

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_menu.screens.raid import RAIDScreen
            self.app.push_screen(RAIDScreen())
        elif key == "2":
            from xinas_menu.screens.nfs import NFSScreen
            self.app.push_screen(NFSScreen())
        elif key == "3":
            from xinas_menu.screens.drives import PhysicalDrivesScreen
            self.app.push_screen(PhysicalDrivesScreen())
        elif key == "4":
            from xinas_menu.screens.filesystem import FilesystemScreen
            self.app.push_screen(FilesystemScreen())
