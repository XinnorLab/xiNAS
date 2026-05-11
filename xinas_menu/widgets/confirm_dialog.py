"""ConfirmDialog — modal yes/no or OK-only dialog."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Label


class ConfirmDialog(ModalScreen[bool]):
    """Modal confirmation or informational dialog.

    When *ok_only* is ``False`` (default) the dialog shows **Yes / No**
    buttons and returns ``True`` or ``False``.

    When *ok_only* is ``True`` the dialog shows a single **OK** button
    and always returns ``True``.  Use this for error messages, success
    notifications, and other informational pop-ups.

    Usage::

        # Confirmation (Yes / No)
        if await self.app.push_screen_wait(ConfirmDialog("Delete share?", "Confirm")):
            ...do it...

        # Informational (OK only)
        await self.app.push_screen_wait(
            ConfirmDialog("Operation complete.", "Done", ok_only=True)
        )
    """

    BINDINGS = [
        Binding("escape", "dismiss_no", "Cancel", show=False),
        Binding("y", "dismiss_yes", "Yes", show=False),
        Binding("n", "dismiss_no", "No", show=False),
        Binding("enter", "dismiss_ok", "OK", show=False),
        Binding("ctrl+y", "copy_message", "Copy", show=False),
    ]

    def __init__(
        self,
        message: str,
        title: str = "Confirm",
        *,
        ok_only: bool = False,
        yes_label: str | None = None,
        no_label: str | None = None,
        copy_text: str | None = None,
    ) -> None:
        super().__init__()
        self._message = message
        self._title = title
        self._ok_only = ok_only
        self._yes_label = yes_label or "Yes [y]"
        self._no_label = no_label or "No [n]"
        self._copy_text = copy_text if copy_text is not None else message

    def compose(self) -> ComposeResult:
        from textual.containers import Vertical, Horizontal
        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            yield Label(self._message, id="dialog-body", markup=False)
            with Horizontal(id="dialog-buttons"):
                if self._ok_only:
                    yield Button("OK", variant="primary", id="btn-ok", classes="dialog-btn")
                else:
                    yield Button(self._yes_label, variant="error", id="btn-yes", classes="dialog-btn")
                    yield Button(self._no_label, variant="primary", id="btn-no", classes="dialog-btn")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-ok":
            self.dismiss(True)
        else:
            self.dismiss(event.button.id == "btn-yes")

    def action_dismiss_yes(self) -> None:
        if not self._ok_only:
            self.dismiss(True)

    def action_dismiss_no(self) -> None:
        if self._ok_only:
            self.dismiss(True)
        else:
            self.dismiss(False)

    def action_dismiss_ok(self) -> None:
        if self._ok_only:
            self.dismiss(True)

    def action_copy_message(self) -> None:
        if self._copy_text:
            self.app._do_copy(self._copy_text)

    # ── Terminal mouse-capture toggle ────────────────────────────────────
    # While this modal is open, release mouse tracking back to the terminal
    # so the user can drag-select the dialog text (token hex, error
    # messages, etc.) with native Terminal/iTerm/Ghostty selection — and
    # copy via the terminal's own Cmd+C — without needing the modifier-drag
    # trick to bypass Textual's mouse handling. Mouse is re-enabled on
    # unmount so the rest of the TUI keeps working.
    #
    # The button still works via keyboard (Enter / y / n / Esc); only
    # mouse-clicking the OK/Yes/No buttons is disabled inside this modal.
    _MOUSE_DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l"
    _MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h"

    def on_mount(self) -> None:
        self._write_term(self._MOUSE_DISABLE)

    def on_unmount(self) -> None:
        self._write_term(self._MOUSE_ENABLE)

    def _write_term(self, sequence: str) -> None:
        """Write a raw escape sequence to the controlling terminal.

        Prefers Textual's driver (so the write is serialized with the
        render stream); falls back to direct stdout if the driver isn't
        exposed in this Textual version.
        """
        driver = getattr(self.app, "_driver", None)
        if driver is not None:
            write = getattr(driver, "write", None)
            if callable(write):
                try:
                    write(sequence)
                    flush = getattr(driver, "flush", None)
                    if callable(flush):
                        flush()
                    return
                except Exception:
                    pass
        import sys
        try:
            sys.stdout.write(sequence)
            sys.stdout.flush()
        except Exception:
            pass
