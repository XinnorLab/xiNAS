"""LicenseScreen — show and set xiRAID license."""
from __future__ import annotations

import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Show License"),
    MenuItem("2", "Set License"),
    MenuItem("0", "Back"),
]


class LicenseScreen(Screen):
    """License management screen."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  License Management", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="license-nav")
            yield ScrollableTextView(id="license-content")
        yield Footer()

    def on_mount(self) -> None:
        self._show_license()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
        elif event.key == "1":
            self._show_license()
        elif event.key == "2":
            self._set_license()

    @work(exclusive=True)
    async def _show_license(self) -> None:
        view = self.query_one("#license-content", ScrollableTextView)
        view.set_content("  Loading license info...")
        ok, data, err = await self.app.grpc.license_show()
        if ok:
            GRN, BLD, DIM, NC = "\033[32m", "\033[1m", "\033[2m", "\033[0m"
            lines = [f"{BLD}License Information{NC}", ""]
            if isinstance(data, dict):
                for k, v in data.items():
                    lines.append(f"  {DIM}{k}:{NC}  {GRN}{v}{NC}")
            else:
                lines.append(f"  {data}")
            view.set_content("\n".join(lines))
        else:
            view.set_content(f"\033[31m  Error: {grpc_short_error(err)}\033[0m")

    @work(exclusive=True)
    async def _set_license(self) -> None:
        path = await self.app.push_screen_wait(
            InputDialog(
                "Enter path to license file:",
                "Set License",
                default="/tmp/license",
                placeholder="/tmp/license",
            )
        )
        if not path:
            return

        ok, data, err = await self.app.grpc.set_license(path)
        if ok:
            self.app.audit.log("license.set", path, "OK")
            self.app.notify("License set successfully", severity="information")
            self._show_license()
        else:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed to set license.\n{grpc_short_error(err)}", "Error")
            )
