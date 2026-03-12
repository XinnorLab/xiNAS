"""ScrollableTextView — read-only info panel."""
from __future__ import annotations

from textual.widget import Widget
from textual.widgets import RichLog


class ScrollableTextView(Widget):
    """A scrollable read-only text panel that accepts ANSI / rich markup."""

    DEFAULT_CSS = """
    ScrollableTextView {
        height: 1fr;
        overflow-y: auto;
    }
    """

    def __init__(self, content: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self._initial_content = content

    def compose(self):
        log = RichLog(highlight=True, markup=True, id="text-view-log")
        yield log

    def on_mount(self) -> None:
        if self._initial_content:
            self.set_content(self._initial_content)

    def set_content(self, text: str) -> None:
        """Replace all content."""
        try:
            log = self.query_one("#text-view-log", RichLog)
            log.clear()
            log.write(text)
        except Exception:
            pass

    def append(self, text: str) -> None:
        """Append a line to the view."""
        try:
            log = self.query_one("#text-view-log", RichLog)
            log.write(text)
        except Exception:
            pass
