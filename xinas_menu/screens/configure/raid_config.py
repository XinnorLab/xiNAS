"""RAIDConfigScreen — replaces configure_raid.sh (pyyaml-based editor)."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Button, Label, TextArea

_PRESETS_DIR_CANDIDATES = [
    Path("/opt/xiNAS/presets"),
    Path("/home/xinnor/xiNAS/presets"),
]


def _presets_dir() -> Path | None:
    for p in _PRESETS_DIR_CANDIDATES:
        if p.exists():
            return p
    return None


def list_presets() -> list[str]:
    d = _presets_dir()
    if not d:
        return []
    return [p.name for p in sorted(d.iterdir()) if p.is_dir()]


def _default_raid_file() -> Path | None:
    d = _presets_dir()
    if not d:
        return None
    # Use first preset's raid_fs.yml
    for p in sorted(d.iterdir()):
        r = p / "raid_fs.yml"
        if r.exists():
            return r
    return None


class RAIDConfigScreen(Screen[bool]):
    """Edit the RAID/XFS configuration YAML for the selected preset."""

    BINDINGS = [Binding("escape", "cancel", "Cancel", show=True)]

    def __init__(self, preset: str = "default", **kwargs) -> None:
        super().__init__(**kwargs)
        self._preset = preset
        d = _presets_dir()
        self._cfg_path = (d / preset / "raid_fs.yml") if d else None

    def compose(self) -> ComposeResult:
        title = str(self._cfg_path) if self._cfg_path else "(no RAID config found)"
        yield Label(f"  ── RAID Config — {title} ──")
        content = ""
        if self._cfg_path and self._cfg_path.exists():
            content = self._cfg_path.read_text()
        yield TextArea(content, id="raid-editor", language="yaml")
        yield Button("Save", id="btn-save", variant="primary")
        yield Button("Cancel", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-save":
            task = asyncio.create_task(self._save())
            task.add_done_callback(
                lambda t: t.exception() if not t.cancelled() and t.exception() else None
            )
        else:
            self.dismiss(False)

    async def _save(self) -> None:
        if not self._cfg_path:
            return
        content = self.query_one("#raid-editor", TextArea).text
        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(None, lambda: _write_yaml(self._cfg_path, content))
        if ok:
            self.app.audit.log("raid.config_save", str(self._cfg_path), "OK")
            self.dismiss(True)
        else:
            from xinas_menu.widgets.confirm_dialog import ConfirmDialog
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    def action_cancel(self) -> None:
        self.dismiss(False)


def _write_yaml(path: Path, content: str) -> tuple[bool, str]:
    import os
    import tempfile

    try:
        import yaml
        yaml.safe_load(content)  # validate
    except Exception as exc:
        return False, f"YAML parse error: {exc}"
    try:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(content)
            os.replace(tmp, str(path))
        except Exception:
            os.unlink(tmp)
            raise
        return True, ""
    except Exception as exc:
        return False, str(exc)
