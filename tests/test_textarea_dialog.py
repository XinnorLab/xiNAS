"""TextAreaDialog must survive duplicated dismiss-triggering events.

Same double-dismiss crash as SelectDialog (see ``tests/dialog_harness.py``):
a double-click on OK queues a second ``Button.Pressed`` whose ``dismiss()``
pops the wrong screen or raises ``ScreenStackError``.
"""

from __future__ import annotations

from textual.widgets import Button

from tests.dialog_harness import run_double_dismiss
from xinas_menu.widgets.textarea_dialog import TextAreaDialog


def test_double_ok_press_dismisses_once():
    dialog = TextAreaDialog("Notes:", "Input", default="line one")

    def post_twice(dlg):
        button = dlg.query_one("#btn-ok", Button)
        for _ in range(2):
            dlg.post_message(Button.Pressed(button))

    results = run_double_dismiss(dialog, post_twice)
    assert results == ["line one"]
