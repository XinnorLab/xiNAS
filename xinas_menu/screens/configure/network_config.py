"""NetworkConfigScreen — replaces configure_network.sh (netplan YAML editor)."""
from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Button, Label, TextArea

_NETPLAN_DIR = Path("/etc/netplan")


def _find_netplan_file() -> Path | None:
    files = sorted(_NETPLAN_DIR.glob("*.yaml")) + sorted(_NETPLAN_DIR.glob("*.yml"))
    return files[0] if files else None


class NetworkConfigScreen(Screen[bool]):
    """Edit netplan YAML configuration."""

    BINDINGS = [Binding("escape", "cancel", "Cancel", show=True)]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._cfg_path = _find_netplan_file()

    def compose(self) -> ComposeResult:
        title = str(self._cfg_path) if self._cfg_path else "(no netplan file found)"
        yield Label(f"  ── Network Config — {title} ──")
        content = ""
        if self._cfg_path and self._cfg_path.exists():
            content = self._cfg_path.read_text()
        yield TextArea(content, id="netplan-editor", language="yaml")
        yield Button("Save & Apply", id="btn-save", variant="primary")
        yield Button("Validate Only", id="btn-validate")
        yield Button("Cancel", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            asyncio.create_task(self._save_and_apply())
        elif event.button.id == "btn-validate":
            asyncio.create_task(self._validate())
        else:
            self.dismiss(False)

    async def _save_and_apply(self) -> None:
        if not self._cfg_path:
            return
        content = self.query_one("#netplan-editor", TextArea).text
        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _save_netplan(self._cfg_path, content, apply=True)
        )
        if ok:
            self.app.audit.log("network.netplan_save", str(self._cfg_path), "OK")
            await self.app.snapshots.record(
                "network_modify",
                diff_summary=f"Saved and applied netplan config {self._cfg_path}",
            )
            self.dismiss(True)
        else:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error", ok_only=True))

    async def _validate(self) -> None:
        if not self._cfg_path:
            return
        content = self.query_one("#netplan-editor", TextArea).text
        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _save_netplan(self._cfg_path, content, apply=False)
        )
        from xinas_menu.widgets.confirm_dialog import ConfirmDialog
        if ok:
            await self.app.push_screen_wait(ConfirmDialog("Netplan config is valid.", "OK", ok_only=True))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Validation failed:\n{err}", "Error", ok_only=True))

    def action_cancel(self) -> None:
        self.dismiss(False)


def _save_netplan(path: Path, content: str, apply: bool) -> tuple[bool, str]:
    # Validate YAML first
    try:
        import yaml
        yaml.safe_load(content)
    except Exception as exc:
        return False, f"YAML parse error: {exc}"

    # Write to temp then move
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(content)
        shutil.move(str(tmp), str(path))
    except Exception as exc:
        return False, str(exc)

    if apply:
        r = subprocess.run(["netplan", "apply"], capture_output=True, text=True)
        if r.returncode != 0:
            return False, r.stderr[:300]
    else:
        r = subprocess.run(["netplan", "try", "--timeout=0"],
                           capture_output=True, text=True)
        if r.returncode not in (0, 1):
            return False, r.stderr[:300]
    return True, ""
