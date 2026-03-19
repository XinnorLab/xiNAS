"""AlertBar — persistent notification strip for critical system alerts."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from textual.app import ComposeResult
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Static

_log = logging.getLogger(__name__)

__all__ = ["AlertBar"]


@dataclass(slots=True)
class Alert:
    """Single alert item."""

    severity: str  # "error" | "warning"
    message: str
    key: str  # dedup key, e.g. "license"


class AlertBar(Widget):
    """App-level strip showing critical alerts.  Hidden when empty."""

    DEFAULT_CSS = """
    AlertBar {
        height: auto;
        dock: top;
        display: none;
    }
    AlertBar.has-alerts {
        display: block;
    }
    """

    alerts: reactive[list[Alert]] = reactive(list, always_update=True)

    def compose(self) -> ComposeResult:
        yield Static("", id="alert-content")

    def watch_alerts(self, alerts: list[Alert]) -> None:
        try:
            container = self.query_one("#alert-content", Static)
        except Exception:
            return
        if not alerts:
            self.remove_class("has-alerts")
            container.update("")
            return
        self.add_class("has-alerts")
        lines: list[str] = []
        for a in alerts:
            icon = "\u26a0" if a.severity == "warning" else "\u2716"
            lines.append(f"  {icon}  {a.message}")
        container.update("\n".join(lines))

    # ── Public API ────────────────────────────────────────────────

    def set_alert(self, key: str, severity: str, message: str) -> None:
        """Add or replace an alert by *key*."""
        current = [a for a in self.alerts if a.key != key]
        current.append(Alert(severity=severity, message=message, key=key))
        self.alerts = current

    def clear_alert(self, key: str) -> None:
        """Remove an alert by *key* (no-op if absent)."""
        filtered = [a for a in self.alerts if a.key != key]
        if len(filtered) != len(self.alerts):
            self.alerts = filtered
