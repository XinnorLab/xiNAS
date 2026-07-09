"""SelectDialog — modal list selection dialog."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.widgets import Button, Label, OptionList
from textual.widgets.option_list import Option

from xinas_menu.widgets._guarded_modal import GuardedModalScreen
from xinas_menu.widgets.wizard import BACK


class SelectDialog(GuardedModalScreen["str | None"]):
    """Modal dialog that lets the user pick one item from a list.

    Returns the selected string value, :data:`BACK` if the user requested
    back-navigation, or None if cancelled.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
        Binding("left", "back", "Back", show=False),
    ]

    def __init__(
        self,
        items: list[str],
        title: str = "Select",
        prompt: str = "",
        *,
        selected: str | None = None,
        allow_back: bool = False,
    ) -> None:
        super().__init__()
        self._items = items
        self._title = title
        self._prompt = prompt
        self._selected = selected
        self._allow_back = allow_back

    def compose(self) -> ComposeResult:
        from textual.containers import Horizontal, Vertical

        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            if self._prompt:
                yield Label(self._prompt, id="dialog-body")
            yield OptionList(
                *[Option(item, id=f"opt-{i}") for i, item in enumerate(self._items)],
                id="dialog-select",
            )
            with Horizontal(id="dialog-buttons"):
                if self._allow_back:
                    yield Button("Back [←]", variant="default", id="btn-back")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_mount(self) -> None:
        if self._selected is not None and self._selected in self._items:
            option_list = self.query_one("#dialog-select", OptionList)
            option_list.highlighted = self._items.index(self._selected)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        self.dismiss(str(event.option.prompt))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-back":
            self.action_back()
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_back(self) -> None:
        if self._allow_back:
            self.dismiss(BACK)  # pyright: ignore[reportArgumentType]
