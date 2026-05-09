"""TextAreaDialog — modal multi-line text input dialog."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Label, TextArea


class TextAreaDialog(ModalScreen[str | None]):
    """Modal multi-line text input dialog.

    Returns the entered text, or None if cancelled.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
    ]

    def __init__(
        self,
        prompt: str,
        title: str = "Input",
        default: str = "",
        placeholder: str = "",
        language: str | None = None,
    ) -> None:
        super().__init__()
        self._prompt = prompt
        self._title = title
        self._default = default
        self._placeholder = placeholder
        self._language = language

    def compose(self) -> ComposeResult:
        from textual.containers import Vertical, Horizontal
        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            yield Label(self._prompt, id="dialog-body")
            yield TextArea(
                self._default,
                language=self._language,
                id="dialog-textarea",
            )
            with Horizontal(id="dialog-buttons"):
                yield Button("OK", variant="primary", id="btn-ok")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_mount(self) -> None:
        ta = self.query_one("#dialog-textarea", TextArea)
        ta.focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            ta = self.query_one("#dialog-textarea", TextArea)
            self.dismiss(ta.text)
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)
