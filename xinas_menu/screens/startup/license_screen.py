"""LicenseScreen — enter or display the xiRAID license."""
from __future__ import annotations

import asyncio
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Button, Input, Label

_LICENSE_PATH = Path("/tmp/license")


class LicenseScreen(Screen[bool]):
    """Modal-like screen for entering the xiRAID license key.

    Returns True if a license was saved, False otherwise.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=True),
    ]

    def compose(self) -> ComposeResult:
        existing = _LICENSE_PATH.read_text().strip() if _LICENSE_PATH.exists() else ""
        yield Label("  ── Enter xiRAID License ──")
        yield Label(
            "  Paste your license key below. The license is stored at /tmp/license\n"
            "  and cleared on reboot. Re-enter after each reboot.\n"
        )
        if existing:
            yield Label(f"  Current license: {existing[:20]}…" if len(existing) > 20
                        else f"  Current license: {existing}")
        yield Input(placeholder="Paste license key here…", id="license-input",
                    value=existing)
        yield Button("Save", id="btn-save", variant="primary")
        yield Button("Cancel", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            key = self.query_one("#license-input", Input).value.strip()
            if key:
                _LICENSE_PATH.write_text(key + "\n")
                self.dismiss(True)
            else:
                self.dismiss(False)
        else:
            self.dismiss(False)

    def action_cancel(self) -> None:
        self.dismiss(False)
