"""TextAreaDialog — modal multi-line text input dialog."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Label, TextArea


class TextAreaDialog(ModalScreen[str | None]):
    """Modal multi-line text input dialog.

    Returns the entered text, or None if cancelled.

    When ``copy_text`` is set, the dialog also:

    1. Binds Ctrl+Y to copy that value via the app's clipboard helper
       (OSC 52 + ~/.xinas/clipboard.txt recovery file). Use this when
       the prompt displays a value the user typically needs to paste
       elsewhere — e.g. the xiRAID HW key while requesting a license.

       The binding is registered with ``priority=True`` so it overrides
       TextArea's own Ctrl+Y (redo) — accept that trade-off only when
       the to-be-copied value is the dialog's whole purpose.

    2. Releases the terminal's mouse-tracking on mount and restores it
       on unmount, so the prompt text (and the TextArea contents) can
       be drag-selected with the terminal's native selection. The cost:
       mouse-clicking inside the TextArea to position the cursor no
       longer works while the dialog is open — the textarea still
       responds to keyboard navigation and gets auto-focused on mount,
       so paste-and-confirm flows are unaffected.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
        # priority=True needed to shadow TextArea's own ctrl+y (redo).
        # Only fires when self._copy_text is set; otherwise the action is a no-op.
        Binding("ctrl+y", "copy_message", "Copy", show=False, priority=True),
    ]

    def __init__(
        self,
        prompt: str,
        title: str = "Input",
        default: str = "",
        placeholder: str = "",
        language: str | None = None,
        *,
        copy_text: str | None = None,
    ) -> None:
        super().__init__()
        self._prompt = prompt
        self._title = title
        self._default = default
        self._placeholder = placeholder
        self._language = language
        self._copy_text = copy_text

    def compose(self) -> ComposeResult:
        from textual.containers import Horizontal, Vertical

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
        if self._copy_text is not None:
            from xinas_menu.widgets._terminal_io import release_mouse_capture

            release_mouse_capture(self.app)

    def on_unmount(self) -> None:
        if self._copy_text is not None:
            from xinas_menu.widgets._terminal_io import restore_mouse_capture

            restore_mouse_capture(self.app)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            ta = self.query_one("#dialog-textarea", TextArea)
            self.dismiss(ta.text)
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_copy_message(self) -> None:
        if self._copy_text:
            self.app._do_copy(self._copy_text)
