"""InputDialog — modal text/password input dialog."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label


class InputDialog(ModalScreen[str | None]):
    """Modal text (or password) input dialog.

    Returns the entered string, or None if cancelled.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
    ]

    def __init__(
        self,
        prompt: str,
        title: str = "Input",
        default: str = "",
        password: bool = False,
        placeholder: str = "",
    ) -> None:
        super().__init__()
        self._prompt = prompt
        self._title = title
        self._default = default
        self._password = password
        self._placeholder = placeholder

    def compose(self) -> ComposeResult:
        from textual.containers import Vertical, Horizontal
        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            yield Label(self._prompt, id="dialog-body")
            yield Input(
                value=self._default,
                placeholder=self._placeholder,
                password=self._password,
                id="dialog-input",
            )
            with Horizontal(id="dialog-buttons"):
                yield Button("OK [Enter]", variant="primary", id="btn-ok")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            inp = self.query_one("#dialog-input", Input)
            self.dismiss(inp.value)
        else:
            self.dismiss(None)

    def on_input_submitted(self, _event: Input.Submitted) -> None:
        inp = self.query_one("#dialog-input", Input)
        self.dismiss(inp.value)

    def action_cancel(self) -> None:
        self.dismiss(None)
