"""ScrollableTextView — selectable, copyable read-only info panel.

Uses TextArea(read_only=True) so the user can:
  - Navigate with arrow keys / Page Up / Page Down
  - Select text with Shift+arrows or click-drag
  - Copy selection with Ctrl+C

Rich markup tags are stripped before display (TextArea renders plain text).
"""
from __future__ import annotations

import re

from textual.widget import Widget
from textual.widgets import TextArea


def _strip_markup(text: str) -> str:
    """Remove Rich/Textual markup tags like [bold], [red], [/red], [$accent], etc."""
    return re.sub(r'\[/?[^\[\]\n]{1,40}\]', '', text)


class ScrollableTextView(Widget):
    """Selectable, copyable read-only text panel.

    Key bindings (active when the panel has focus):
      Ctrl+C        copy selected text (or all text if nothing selected)
      Arrow keys    move cursor
      Shift+arrows  extend selection
      Page Up/Down  scroll
    """

    DEFAULT_CSS = """
    ScrollableTextView {
        height: 1fr;
        overflow-y: auto;
    }
    ScrollableTextView TextArea {
        height: 1fr;
        border: none;
        padding: 0;
        background: transparent;
    }
    """

    def __init__(self, content: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self._initial_content = content
        self._plain_text = ""

    def compose(self):
        yield TextArea(
            self._strip(self._initial_content),
            read_only=True,
            id="text-view-area",
            show_line_numbers=False,
        )

    def on_mount(self) -> None:
        # Ensure TextArea fills the widget and starts at top
        try:
            ta = self.query_one("#text-view-area", TextArea)
            ta.move_cursor((0, 0))
        except Exception:
            pass

    def set_content(self, text: str) -> None:
        """Replace all content."""
        self._plain_text = self._strip(text)
        try:
            ta = self.query_one("#text-view-area", TextArea)
            ta.load_text(self._plain_text)
            ta.move_cursor((0, 0))
        except Exception:
            pass

    def append(self, text: str) -> None:
        """Append text at the end."""
        addition = self._strip(text)
        self._plain_text = (self._plain_text + "\n" + addition).lstrip("\n")
        try:
            ta = self.query_one("#text-view-area", TextArea)
            ta.load_text(self._plain_text)
        except Exception:
            pass

    @staticmethod
    def _strip(text: str) -> str:
        return _strip_markup(text)
