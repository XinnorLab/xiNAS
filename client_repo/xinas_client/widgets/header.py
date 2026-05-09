"""XiNASHeader — ASCII banner with optional update badge."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Label

from xinas_client.version import CLIENT_VERSION

_BANNER = r"""
        _ _  _   _   ___    ___ _ _         _
  __ __(_) \| | /_\ / __|  / __| (_)___ _ _| |_
  \ \ /| | .` |/ _ \\__ \ | (__| | / -_) ' \  _|
  /_\_\|_|_|\_/_/ \_\___/  \___|_|_\___|_||_\__|"""


class XiNASHeader(Widget):
    """Fixed header: ASCII art + version + optional update badge."""

    DEFAULT_CSS = """
    XiNASHeader {
        height: auto;
        dock: top;
    }
    """

    update_available: reactive[bool] = reactive(False)

    def compose(self) -> ComposeResult:
        yield Label(_BANNER, id="header-banner")
        yield Label(
            f"  xiNAS Client Console  v{CLIENT_VERSION}",
            id="header-subtitle",
        )
        yield Label("  ★ Update available — press U to update", id="update-badge")

    def watch_update_available(self, value: bool) -> None:
        badge = self.query_one("#update-badge", Label)
        if value:
            badge.add_class("visible")
        else:
            badge.remove_class("visible")
