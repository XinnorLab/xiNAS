"""InputDialog must survive duplicated dismiss-triggering events.

Same double-dismiss crash as SelectDialog (see ``tests/dialog_harness.py``):
double Enter in the input field queues a second ``Input.Submitted`` whose
``dismiss()`` pops the wrong screen or raises ``ScreenStackError``.
"""

from __future__ import annotations

from textual.widgets import Input

from tests.dialog_harness import run_double_dismiss
from xinas_menu.widgets.input_dialog import InputDialog


def test_double_submit_dismisses_once():
    dialog = InputDialog("Hostname:", "Input", default="nas01")

    def post_twice(dlg):
        inp = dlg.query_one("#dialog-input", Input)
        for _ in range(2):
            dlg.post_message(Input.Submitted(inp, inp.value))

    results = run_double_dismiss(dialog, post_twice)
    assert results == ["nas01"]
