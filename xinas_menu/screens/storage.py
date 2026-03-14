"""StorageScreen — Storage submenu (RAID, NFS, Physical Drives)."""
from __future__ import annotations

import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "RAID Management"),
    MenuItem("2", "NFS Access Rights"),
    MenuItem("3", "Physical Drives"),
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
            self._show_drives()

    @work(exclusive=True)
    async def _show_drives(self) -> None:
        """Show physical drives — logic extracted from QuickActionsScreen."""
        view = self.query_one("#storage-content", ScrollableTextView)
        view.set_content("  Scanning drives...")
        ok, data, err = await self.app.grpc.disk_list()
        if not ok:
            view.set_content(f"\033[31m  Error: {grpc_short_error(err)}\033[0m")
            return

        GRN, YLW, RED, CYN, BLD, DIM, NC = (
            "\033[32m", "\033[33m", "\033[31m", "\033[36m",
            "\033[1m", "\033[2m", "\033[0m",
        )
        lines = [f"{BLD}{CYN}Physical Drives{NC}\n"]
        try:
            disks = data if isinstance(data, list) else []
            if not disks:
                lines.append(f"  {DIM}(no drives found){NC}")
            for d in disks:
                name = d.get("name", "?") if isinstance(d, dict) else str(d)
                model = (d.get("model", "") if isinstance(d, dict) else "").strip()
                size = d.get("size", "?") if isinstance(d, dict) else "?"
                raid_name = d.get("raid_name", "") if isinstance(d, dict) else ""
                member_state = d.get("member_state", "") if isinstance(d, dict) else ""
                transport = d.get("transport", "") if isinstance(d, dict) else ""
                ms = member_state.lower()
                if ms == "online":
                    sc = GRN
                elif ms in ("degraded", "rebuilding"):
                    sc = YLW
                elif ms in ("offline", "failed"):
                    sc = RED
                else:
                    sc = ""
                role = (
                    f"({raid_name}) {sc}{member_state}{NC}"
                    if raid_name
                    else f"{DIM}unassigned{NC}"
                )
                lines.append(f"  {GRN}{name}{NC}  {model}  {size}  {transport}  {role}")
        except Exception as exc:
            lines.append(f"  {RED}(parse error: {exc}){NC}")
        view.set_content("\n".join(lines))
