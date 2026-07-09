"""InputDialog — modal text/password input dialog."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.widgets import Button, Input, Label

from xinas_menu.widgets._guarded_modal import GuardedModalScreen
from xinas_menu.widgets.wizard import BACK


class InputDialog(GuardedModalScreen["str | None"]):
    """Modal text (or password) input dialog.

    Returns the entered string, :data:`BACK` if the user requested
    back-navigation, or None if cancelled.
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
        *,
        allow_back: bool = False,
    ) -> None:
        super().__init__()
        self._prompt = prompt
        self._title = title
        self._default = default
        self._password = password
        self._placeholder = placeholder
        self._allow_back = allow_back

    def compose(self) -> ComposeResult:
        from textual.containers import Horizontal, Vertical

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
                if self._allow_back:
                    yield Button("Back", variant="default", id="btn-back")
                yield Button("OK [Enter]", variant="primary", id="btn-ok")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            inp = self.query_one("#dialog-input", Input)
            self.dismiss(inp.value)
        elif event.button.id == "btn-back":
            self._dismiss_back()
        else:
            self.dismiss(None)

    def on_input_submitted(self, _event: Input.Submitted) -> None:
        inp = self.query_one("#dialog-input", Input)
        self.dismiss(inp.value)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _dismiss_back(self) -> None:
        if self._allow_back:
            self.dismiss(BACK)  # pyright: ignore[reportArgumentType]
