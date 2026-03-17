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
    MenuItem("2", "Update License"),
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
            view.set_content(_format_license(data))
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
                "Update License",
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


# ── Formatting helper ─────────────────────────────────────────────────────

_BLD = "\033[1m"
_DIM = "\033[2m"
_GRN = "\033[32m"
_CYN = "\033[36m"
_YLW = "\033[33m"
_RED = "\033[31m"
_NC = "\033[0m"

# Display labels and grouping order for license fields
_LICENSE_FIELDS = [
    # (key, label, group)
    ("status", "Status", "status"),
    ("expired", "Expires", "status"),
    ("created", "Created", "status"),
    ("accepted", "Accepted", "status"),
    ("version", "Version", "details"),
    ("crypto_version", "Crypto version", "details"),
    ("Kernel version", "Kernel", "details"),
    ("type", "Type", "capacity"),
    ("disks", "Disks (max)", "capacity"),
    ("disks_in_use", "Disks in use", "capacity"),
    ("levels", "RAID levels", "capacity"),
]


def _format_license(data) -> str:
    """Format license data into a structured, readable view."""
    if not isinstance(data, dict):
        return f"  {data}"

    lines: list[str] = []
    sep = f"  {_DIM}{'─' * 50}{_NC}"

    # Title
    lines.append(f"  {_BLD}{_CYN}License Information{_NC}")
    lines.append(sep)

    # Status badge
    status = str(data.get("status", "unknown")).lower()
    if status == "valid":
        badge = f"{_GRN}● VALID{_NC}"
    elif status in ("expired", "invalid"):
        badge = f"{_RED}● {status.upper()}{_NC}"
    else:
        badge = f"{_YLW}● {status.upper()}{_NC}"
    lines.append(f"  {badge}")
    lines.append("")

    # Collect known fields by group, track what we've shown
    shown: set[str] = set()
    groups: dict[str, list[tuple[str, str]]] = {}
    for key, label, group in _LICENSE_FIELDS:
        if key in data and key != "status":
            val = data[key]
            groups.setdefault(group, []).append((label, str(val)))
            shown.add(key)

    # Render groups
    group_titles = {
        "status": "Validity",
        "details": "Details",
        "capacity": "Capacity",
    }
    for gid in ("status", "details", "capacity"):
        items = groups.get(gid)
        if not items:
            continue
        lines.append(f"  {_BLD}{group_titles[gid]}{_NC}")
        for label, val in items:
            lines.append(f"    {_DIM}{label + ':':<20}{_NC} {val}")
        lines.append("")

    # Any remaining fields (except sensitive keys)
    hidden_keys = {"hwkey", "license_key", "status"}
    extra = {k: v for k, v in data.items() if k not in shown and k not in hidden_keys}
    if extra:
        lines.append(f"  {_BLD}Other{_NC}")
        for k, v in extra.items():
            lines.append(f"    {_DIM}{k + ':':<20}{_NC} {v}")
        lines.append("")

    lines.append(sep)

    return "\n".join(lines)
