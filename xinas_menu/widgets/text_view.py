"""ScrollableTextView — read-only info panel with clipboard copy.

The content area never steals keyboard focus from NavigableMenu.
Text is rendered via a non-focusable RichLog, so arrow-key
navigation in NavigableMenu always works.  Rich markup and ANSI
color codes are rendered as colored text.

To copy content:
  Ctrl+Y (or 'Y' from the menu)   — copies the full panel text to clipboard
  Terminal Shift+drag              — standard terminal selection still works
"""
from __future__ import annotations

import re

from rich.text import Text
from textual.widget import Widget
from textual.widgets import RichLog

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _strip_for_clipboard(text: str) -> str:
    """Remove ANSI escape codes and Rich markup tags for plain-text clipboard copy."""
    text = _ANSI_RE.sub("", text)
    text = re.sub(r'\[/?[^\[\]\n]{1,40}\]', '', text)
    return text


class _DisplayLog(RichLog, can_focus=False):
    """RichLog that never takes keyboard focus.

    Prevents the content panel from stealing focus away from NavigableMenu.
    Terminal-level Shift+drag text selection still works normally.
    """


class ScrollableTextView(Widget):
    """Read-only text panel with Rich markup and ANSI color support.

    Use set_content() / append() to update.
    Call get_text() to retrieve plain text for clipboard operations.
    """

    DEFAULT_CSS = """
    ScrollableTextView {
        height: 1fr;
        overflow-y: auto;
    }
    ScrollableTextView _DisplayLog {
        height: 1fr;
        border: none;
        padding: 0 1;
        background: transparent;
    }
    """

    def __init__(self, content: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self._initial_content = content
        self._raw_text = content
        self._plain_text = _strip_for_clipboard(content)

    def compose(self):
        yield _DisplayLog(
            highlight=False,
            markup=True,
            id="text-view-area",
        )

    def on_mount(self) -> None:
        if self._initial_content:
            self._write_content(self._initial_content)

    def _write_content(self, text: str) -> None:
        """Write text to the RichLog, handling ANSI codes if present."""
        try:
            log = self.query_one("#text-view-area", _DisplayLog)
            log.clear()
            if "\x1b[" in text:
                log.write(Text.from_ansi(text))
            else:
                log.write(text)
        except Exception:
            pass

    def set_content(self, text: str) -> None:
        """Replace all content."""
        self._raw_text = text
        self._plain_text = _strip_for_clipboard(text)
        self._write_content(text)

    def append(self, text: str) -> None:
        """Append text at the end."""
        self._raw_text = (self._raw_text + "\n" + text).lstrip("\n")
        self._plain_text = _strip_for_clipboard(self._raw_text)
        try:
            log = self.query_one("#text-view-area", _DisplayLog)
            if "\x1b[" in text:
                log.write(Text.from_ansi(text))
            else:
                log.write(text)
        except Exception:
            pass

    def get_text(self) -> str:
        """Return plain text content (for clipboard operations)."""
        return self._plain_text
