"""TaskWaitDialog must survive duplicated dismiss calls.

Same double-dismiss crash as the other dialogs (see
``tests/dialog_harness.py``), but triggered from code rather than input:
the screen that pushed the dialog dismisses it when the plan/apply
worker returns, and a Cancel handled just as the task completes can
queue a second ``dismiss()`` behind the first — popping the wrong
screen or raising ``ScreenStackError``.
"""

from __future__ import annotations

from tests.dialog_harness import run_double_dismiss
from xinas_menu.widgets.task_wait_dialog import TaskWaitDialog


def test_double_dismiss_resolves_once():
    dialog = TaskWaitDialog("Creating array data1…")

    def post_twice(dlg):
        dlg.dismiss(None)
        dlg.dismiss(None)

    results = run_double_dismiss(dialog, post_twice)
    assert results == [None]
