"""TaskWaitDialog — modal progress display for a plan/apply task with a
cooperative Cancel button (S10, ADR-0012 §16.5).

The screen pushes the dialog, runs ``plan_apply_wait`` in a worker
thread with ``cancel_check=dialog.cancel_requested`` and
``on_progress`` updating the state line via ``call_from_thread``, then
dismisses the dialog when the call returns. Pressing **Cancel** (or
``c``/``escape``) only flips a flag — the client sends ONE cancel
request and keeps polling; the task may still finish ``success`` if it
already passed its last stage (late cancel is ignored server-side).
"""

from __future__ import annotations

import threading
from collections.abc import Callable

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import ModalScreen
from textual.widgets import Button, Label


class TaskWaitDialog(ModalScreen[None]):
    """Modal "operation in progress" dialog with a cooperative Cancel.

    Usage (from a screen, UI thread)::

        dialog = TaskWaitDialog("Creating array data1…")
        self.app.push_screen(dialog)
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait, "POST", "/api/v1/arrays",
                spec,
                on_progress=dialog.progress_from_thread(self.app),
                cancel_check=dialog.cancel_requested,
            )
        finally:
            dialog.dismiss(None)
    """

    BINDINGS = [
        Binding("escape", "request_cancel", "Cancel", show=False),
        Binding("c", "request_cancel", "Cancel", show=False),
    ]

    def __init__(self, message: str, title: str = "Working") -> None:
        super().__init__()
        self._message = message
        self._title = title
        # Read from the plan_apply_wait worker thread via cancel_requested().
        self._cancel_event = threading.Event()

    # -- worker-thread surface ------------------------------------------

    def cancel_requested(self) -> bool:
        """``cancel_check`` for ``plan_apply_wait`` (thread-safe)."""
        return self._cancel_event.is_set()

    def progress_from_thread(self, app) -> Callable[[str], None]:
        """An ``on_progress`` callback that hops to the UI thread."""

        def _cb(state: str) -> None:
            app.call_from_thread(self.update_state, state)

        return _cb

    # -- UI ---------------------------------------------------------------

    def compose(self) -> ComposeResult:
        from textual.containers import Horizontal, Vertical

        with Vertical(id="dialog-container"):
            yield Label(self._title, id="dialog-title")
            yield Label(self._message, id="dialog-body", markup=False)
            yield Label("state: starting…", id="task-wait-state", markup=False)
            with Horizontal(id="dialog-buttons"):
                yield Button("Cancel [c]", variant="error", id="btn-cancel", classes="dialog-btn")

    def update_state(self, state: str) -> None:
        suffix = " — cancel requested" if self._cancel_event.is_set() else ""
        self.query_one("#task-wait-state", Label).update(f"state: {state}{suffix}")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-cancel":
            self.action_request_cancel()

    def action_request_cancel(self) -> None:
        if self._cancel_event.is_set():
            return
        self._cancel_event.set()
        self.query_one("#btn-cancel", Button).label = "Cancelling…"
        self.query_one("#btn-cancel", Button).disabled = True
