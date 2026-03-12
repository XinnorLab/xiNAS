"""XiNASProgressBar — RAID init / job progress display."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Label, ProgressBar


class XiNASProgressBar(Widget):
    """Labeled progress bar for long-running operations."""

    DEFAULT_CSS = """
    XiNASProgressBar {
        height: 4;
        margin: 0 0 1 0;
    }
    """

    progress: reactive[float] = reactive(0.0)  # 0.0 – 1.0
    label: reactive[str] = reactive("")

    def __init__(self, label: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self.label = label

    def compose(self) -> ComposeResult:
        yield Label(self.label, id="prog-label")
        yield ProgressBar(total=100, show_eta=False, id="prog-bar")

    def watch_progress(self, value: float) -> None:
        try:
            bar = self.query_one("#prog-bar", ProgressBar)
            bar.progress = int(value * 100)
        except Exception:
            pass

    def watch_label(self, value: str) -> None:
        try:
            lbl = self.query_one("#prog-label", Label)
            lbl.update(value)
        except Exception:
            pass

    def set_progress(self, value: float, label: str = "") -> None:
        self.progress = max(0.0, min(1.0, value))
        if label:
            self.label = label
