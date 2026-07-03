# tests/test_wizard_dialogs.py
"""Constructor smoke tests: the four wizard dialogs accept allow_back and the
BACK sentinel is a distinct object (headless — no Textual app mounted)."""

from __future__ import annotations

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.drive_picker import DrivePickerScreen
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.wizard import BACK


def test_back_sentinel_is_distinct():
    assert BACK is not None and BACK is not True and BACK is not False and BACK != ""


def test_select_dialog_accepts_allow_back_and_selected():
    d = SelectDialog(["a", "b"], title="t", prompt="p", selected="b", allow_back=True)
    assert d._allow_back is True
    assert d._selected == "b"


def test_input_dialog_accepts_allow_back():
    d = InputDialog("prompt", "title", default="x", allow_back=True)
    assert d._allow_back is True


def test_confirm_dialog_accepts_allow_back():
    d = ConfirmDialog("msg", "title", allow_back=True)
    assert d._allow_back is True


def test_drive_picker_accepts_allow_back():
    d = DrivePickerScreen([], title="t", allow_back=True)
    assert d._allow_back is True
