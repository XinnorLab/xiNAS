"""SelectDialog — modal list selection dialog."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Label, OptionList
from textual.widgets.option_list import Option


class SelectDialog(ModalScreen[str | None]):
    """Modal dialog that lets the user pick one item from a list.

    Returns the selected string value, or None if cancelled.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
    ]

    def __init__(
        self,
        items: list[str],
        title: str = "Select",
        prompt: str = "",
    ) -> None:
        super().__init__()
        self._items = items
        self._title = title
        self._prompt = prompt

    def compose(self) -> ComposeResult:
        from textual.containers import Vertical, Horizontal
        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            if self._prompt:
                yield Label(self._prompt, id="dialog-body")
            yield OptionList(
                *[Option(item, id=item) for item in self._items],
                id="dialog-select",
            )
            with Horizontal(id="dialog-buttons"):
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(str(event.option.prompt))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)
