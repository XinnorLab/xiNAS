"""SelectDialog must survive duplicated dismiss-triggering events.

Field crash: double Enter (or double-click) on the option list queued a
second ``OptionSelected`` message; the second ``dismiss()`` popped the wrong
screen or raised ``ScreenStackError``. See ``tests/dialog_harness.py``.
"""

from __future__ import annotations

from textual.widgets import OptionList

from tests.dialog_harness import run_double_dismiss
from xinas_menu.widgets.select_dialog import SelectDialog


def test_double_option_selected_dismisses_once():
    dialog = SelectDialog(["alpha", "beta"], title="Pick one")

    def post_twice(dlg):
        option_list = dlg.query_one(OptionList)
        option = option_list.get_option_at_index(0)
        for _ in range(2):
            dlg.post_message(OptionList.OptionSelected(option_list, option, 0))

    results = run_double_dismiss(dialog, post_twice)
    assert results == ["alpha"]
