"""ConfirmDialog must survive duplicated dismiss-triggering events.

Same double-dismiss crash as SelectDialog (see ``tests/dialog_harness.py``):
a double-click on Yes queues a second ``Button.Pressed`` whose ``dismiss()``
pops the wrong screen or raises ``ScreenStackError``.
"""

from __future__ import annotations

from textual.widgets import Button

from tests.dialog_harness import run_double_dismiss
from xinas_menu.widgets.confirm_dialog import ConfirmDialog


def test_double_yes_press_dismisses_once():
    dialog = ConfirmDialog("Delete share?", "Confirm")

    def post_twice(dlg):
        button = dlg.query_one("#btn-yes", Button)
        for _ in range(2):
            dlg.post_message(Button.Pressed(button))

    results = run_double_dismiss(dialog, post_twice)
    assert results == [True]
