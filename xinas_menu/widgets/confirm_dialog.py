"""ConfirmDialog — modal yes/no dialog."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Label


class ConfirmDialog(ModalScreen[bool]):
    """Modal yes/no dialog.

    Usage::

        if await self.app.push_screen_wait(ConfirmDialog("Delete share?", "Confirm")):
            ...do it...
    """

    BINDINGS = [
        Binding("escape", "dismiss_no", "Cancel", show=False),
        Binding("y", "dismiss_yes", "Yes", show=False),
        Binding("n", "dismiss_no", "No", show=False),
    ]

    def __init__(self, message: str, title: str = "Confirm") -> None:
        super().__init__()
        self._message = message
        self._title = title

    def compose(self) -> ComposeResult:
        with self.app.compose_context():
            pass
        from textual.containers import Vertical, Horizontal
        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            yield Label(self._message, id="dialog-body")
            with Horizontal(id="dialog-buttons"):
                yield Button("Yes [y]", variant="error", id="btn-yes")
                yield Button("No [n]", variant="primary", id="btn-no", classes="dialog-btn")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "btn-yes")

    def action_dismiss_yes(self) -> None:
        self.dismiss(True)

    def action_dismiss_no(self) -> None:
        self.dismiss(False)
