"""ScrollableTextView — read-only info panel with clipboard copy.

The content area never steals keyboard focus from NavigableMenu.
Text is rendered via a non-focusable TextArea subclass, so arrow-key
navigation in NavigableMenu always works.

To copy content:
  Ctrl+Y (or 'Y' from the menu)   — copies the full panel text to clipboard
  Terminal Shift+drag              — standard terminal selection still works
"""
from __future__ import annotations

import re

from textual.widget import Widget
from textual.widgets import TextArea


def _strip_markup(text: str) -> str:
    """Remove Rich/Textual markup tags like [bold], [red], [/red], [$accent]."""
    return re.sub(r'\[/?[^\[\]\n]{1,40}\]', '', text)


class _DisplayTextArea(TextArea, can_focus=False):
    """TextArea that never takes keyboard focus.

    Prevents the content panel from stealing focus away from NavigableMenu.
    Terminal-level Shift+drag text selection still works normally.
    """


class ScrollableTextView(Widget):
    """Read-only text panel. Content is never empty; markup is stripped.

    Use set_content() / append() to update.
    Call get_text() to retrieve plain text for clipboard operations.
    """

    DEFAULT_CSS = """
    ScrollableTextView {
        height: 1fr;
        overflow-y: auto;
    }
    ScrollableTextView _DisplayTextArea {
        height: 1fr;
        border: none;
        padding: 0 1;
        background: transparent;
    }
    """

    def __init__(self, content: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self._initial_content = content
        self._plain_text = _strip_markup(content)

    def compose(self):
        yield _DisplayTextArea(
            self._plain_text,
            read_only=True,
            id="text-view-area",
            show_line_numbers=False,
        )

    def on_mount(self) -> None:
        try:
            ta = self.query_one("#text-view-area", _DisplayTextArea)
            ta.move_cursor((0, 0))
        except Exception:
            pass

    def set_content(self, text: str) -> None:
        """Replace all content."""
        self._plain_text = _strip_markup(text)
        try:
            ta = self.query_one("#text-view-area", _DisplayTextArea)
            ta.load_text(self._plain_text)
            ta.move_cursor((0, 0))
        except Exception:
            pass

    def append(self, text: str) -> None:
        """Append text at the end."""
        addition = _strip_markup(text)
        self._plain_text = (self._plain_text + "\n" + addition).lstrip("\n")
        try:
            ta = self.query_one("#text-view-area", _DisplayTextArea)
            ta.load_text(self._plain_text)
        except Exception:
            pass

    def get_text(self) -> str:
        """Return plain text content (for clipboard operations)."""
        return self._plain_text
