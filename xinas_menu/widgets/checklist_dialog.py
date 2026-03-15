"""ChecklistDialog — modal multi-select checklist dialog."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Label, SelectionList
from textual.widgets.selection_list import Selection


class ChecklistDialog(ModalScreen[list[str] | None]):
    """Modal multi-select checklist dialog.

    Returns a list of selected values, or None if cancelled.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
    ]

    def __init__(
        self,
        items: list[tuple[str, str, bool]],
        title: str = "Select",
        prompt: str = "",
    ) -> None:
        """Create a checklist dialog.

        Args:
            items: List of (label, value, pre_selected) tuples.
            title: Dialog title.
            prompt: Optional prompt text above the list.
        """
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
            yield SelectionList[str](
                *[Selection(label, value, selected) for label, value, selected in self._items],
                id="dialog-checklist",
            )
            with Horizontal(id="dialog-buttons"):
                yield Button("OK [Enter]", variant="primary", id="btn-ok")
                yield Button("Cancel [Esc]", variant="default", id="btn-cancel")

    def on_mount(self) -> None:
        self.query_one("#dialog-checklist", SelectionList).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            sl = self.query_one("#dialog-checklist", SelectionList)
            self.dismiss(list(sl.selected))
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)
