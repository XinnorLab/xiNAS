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


def test_confirm_dialog_wraps_long_error_lines():
    """A long single-line error (task id + stage message) must wrap inside
    the dialog container, not render one clipped line (the
    'FAILED_PARTIAL_ROL…' truncation)."""
    import asyncio
    from pathlib import Path

    from textual.app import App

    long_msg = (
        "Filesystem creation failed:\n"
        "task 0b0778a9-1234-5678-9abc-def012345678 ended failed "
        "(FAILED_PARTIAL_ROLLED_BACK): preflight: /mnt/data is already "
        "a live mountpoint (/dev/mapper/something-long)"
    )

    class _Shell(App):
        CSS_PATH = Path(__file__).parent.parent / "xinas_menu" / "styles.tcss"

    async def scenario() -> None:
        app = _Shell()
        async with app.run_test(size=(100, 32)) as pilot:
            dialog = ConfirmDialog(long_msg, "⚠ Create Failed", ok_only=True)
            app.push_screen(dialog)
            await pilot.pause()
            body = dialog.query_one("#dialog-body")
            container = dialog.query_one("#dialog-container")
            # Constrained to the container (not overflowing off-dialog)…
            assert body.region.width <= container.region.width
            # …and the >76-cell line occupies multiple rows, i.e. wrapped.
            assert body.region.height >= 3

    asyncio.run(scenario())
