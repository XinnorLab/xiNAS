"""ServiceBadge — colored active/inactive pill label."""
from __future__ import annotations

from textual.widgets import Label


class ServiceBadge(Label):
    """A label showing service active state with appropriate color class."""

    _STATE_LABELS = {
        "active": "● active",
        "inactive": "○ inactive",
        "failed": "✗ failed",
        "unknown": "? unknown",
    }

    def __init__(self, state: str = "unknown", **kwargs) -> None:
        text = self._STATE_LABELS.get(state, f"? {state}")
        super().__init__(text, classes=f"service-badge {state}", **kwargs)
        self._state = state

    def update_state(self, state: str) -> None:
        self._state = state
        for cls in ("active", "inactive", "failed", "unknown"):
            self.remove_class(cls)
        self.add_class(state)
        self.update(self._STATE_LABELS.get(state, f"? {state}"))
