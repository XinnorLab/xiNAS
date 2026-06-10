"""StatusFooter — compact bottom bar showing critical system issues."""

from __future__ import annotations

import logging

from textual.app import ComposeResult
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Static

_log = logging.getLogger(__name__)

__all__ = ["StatusFooter"]


class StatusFooter(Widget):
    """App-level one-line bar docked at the bottom.  Hidden when no issues."""

    DEFAULT_CSS = """
    StatusFooter {
        height: 1;
        dock: bottom;
        display: none;
    }
    StatusFooter.has-issues {
        display: block;
    }
    """

    # Each entry: (key, message)  e.g. ("license", "License expired")
    issues: reactive[list[tuple[str, str]]] = reactive(list, always_update=True)

    def compose(self) -> ComposeResult:
        yield Static("", id="status-footer-content")

    def watch_issues(self, issues: list[tuple[str, str]]) -> None:
        try:
            content = self.query_one("#status-footer-content", Static)
        except Exception:
            return
        if not issues:
            self.remove_class("has-issues")
            content.update("")
            return
        self.add_class("has-issues")
        parts = [f"  \u2716  {msg}" for _key, msg in issues]
        content.update("  |  ".join(parts))

    # ── Public API ────────────────────────────────────────────────

    def set_issue(self, key: str, message: str) -> None:
        """Add or replace an issue by *key*."""
        current = [(k, m) for k, m in self.issues if k != key]
        current.append((key, message))
        self.issues = current

    def clear_issue(self, key: str) -> None:
        """Remove an issue by *key* (no-op if absent)."""
        filtered = [(k, m) for k, m in self.issues if k != key]
        if len(filtered) != len(self.issues):
            self.issues = filtered
