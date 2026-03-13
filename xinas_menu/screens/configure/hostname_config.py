"""HostnameConfigScreen — replaces configure_hostname.sh."""
from __future__ import annotations

import asyncio
import socket
import subprocess

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Button, Input, Label


class HostnameConfigScreen(Screen[bool]):
    """Set system hostname."""

    BINDINGS = [Binding("escape", "cancel", "Cancel", show=True)]

    def compose(self) -> ComposeResult:
        current = socket.gethostname()
        yield Label("  ── Set Hostname ──")
        yield Label(f"  Current hostname: [bold]{current}[/bold]\n")
        yield Input(value=current, placeholder="new-hostname", id="hostname-input")
        yield Button("Set Hostname", id="btn-set", variant="primary")
        yield Button("Cancel", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-set":
            task = asyncio.create_task(self._set_hostname())
            task.add_done_callback(
                lambda t: t.exception() if not t.cancelled() and t.exception() else None
            )
        else:
            self.dismiss(False)

    async def _set_hostname(self) -> None:
        hostname = self.query_one("#hostname-input", Input).value.strip()
        if not hostname:
            return
        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(None, lambda: _apply_hostname(hostname))
        if ok:
            self.app.audit.log("system.hostname", hostname, "OK")
            self.dismiss(True)
        else:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    def action_cancel(self) -> None:
        self.dismiss(False)


def _apply_hostname(hostname: str) -> tuple[bool, str]:
    r = subprocess.run(
        ["hostnamectl", "set-hostname", hostname],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return False, r.stderr.strip()
    # Also update /etc/hosts
    try:
        import re
        with open("/etc/hosts") as f:
            text = f.read()
        text = re.sub(
            r"(127\.0\.1\.1\s+)\S+", f"\\g<1>{hostname}", text
        )
        with open("/etc/hosts", "w") as f:
            f.write(text)
    except Exception:
        pass
    return True, ""
