"""LicenseScreen — show and set xiRAID license."""
from __future__ import annotations

import logging
import os
import shutil
import tempfile

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.utils.formatting import grpc_short_error
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView
from xinas_menu.widgets.textarea_dialog import TextAreaDialog

_log = logging.getLogger(__name__)

_LICENSE_PATH = "/tmp/license"
_LICENSE_BACKUP = "/tmp/license.bak"

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
        # Read existing license text for pre-fill (if any)
        existing = ""
        try:
            if os.path.isfile(_LICENSE_PATH):
                with open(_LICENSE_PATH) as f:
                    existing = f.read()
        except Exception:
            _log.debug("Could not read existing license", exc_info=True)

        # Show multi-line text area for license input
        license_text = await self.app.push_screen_wait(
            TextAreaDialog(
                "Paste the license text below:",
                "Set License",
                default=existing,
            )
        )
        if not license_text or not license_text.strip():
            return

        # Backup existing license file (if present)
        backed_up = False
        try:
            if os.path.isfile(_LICENSE_PATH):
                shutil.copy2(_LICENSE_PATH, _LICENSE_BACKUP)
                backed_up = True
        except Exception:
            _log.debug("Could not backup license file", exc_info=True)

        # Write new license to /tmp/license atomically
        try:
            fd, tmp = tempfile.mkstemp(dir="/tmp", prefix="license_", suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as f:
                    f.write(license_text)
                os.replace(tmp, _LICENSE_PATH)
            except Exception:
                os.unlink(tmp)
                raise
        except Exception as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Failed to write license file.\n{exc}",
                    "Error",
                )
            )
            return

        # Apply via gRPC
        ok, data, err = await self.app.grpc.set_license(_LICENSE_PATH)
        if ok:
            self.app.audit.log("license.set", "applied", "OK")
            self.app.notify("License applied successfully", severity="information")
            # Clean up backup on success
            try:
                if backed_up and os.path.isfile(_LICENSE_BACKUP):
                    os.unlink(_LICENSE_BACKUP)
            except Exception:
                pass
            self._show_license()
        else:
            # Revert to backed-up license
            reverted = False
            if backed_up and os.path.isfile(_LICENSE_BACKUP):
                try:
                    shutil.copy2(_LICENSE_BACKUP, _LICENSE_PATH)
                    reverted = True
                except Exception:
                    _log.debug("Could not revert license", exc_info=True)

            err_msg = f"Failed to apply license.\n{grpc_short_error(err)}"
            if reverted:
                err_msg += "\n\nPrevious license has been restored."
            await self.app.push_screen_wait(ConfirmDialog(err_msg, "Error"))
