"""Shared harness for modal-dialog double-dismiss regression tests.

Duplicated terminal input events (double Enter, double-click) can queue a
second dismiss-triggering message on a modal dialog before the first
``dismiss()`` pops it. textual 8.2.8's ``Screen.dismiss`` unconditionally
invokes the result callback and calls ``App.pop_screen()``, so the duplicate
pops the wrong screen — or raises ``ScreenStackError`` when only the base
screen remains.

Each ``tests/test_*_dialog*.py`` regression test builds a dialog, posts two
dismiss-triggering messages back-to-back via :func:`run_double_dismiss`, and
asserts the dialog resolved exactly once with the app still alive.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from textual.app import App
from textual.screen import ModalScreen


class DialogHostApp(App[None]):
    """Minimal app hosting a single modal dialog under test."""

    def __init__(self, dialog: ModalScreen) -> None:
        super().__init__()
        self.dialog = dialog
        self.results: list[Any] = []

    def on_mount(self) -> None:
        self.push_screen(self.dialog, callback=self.results.append)


def run_double_dismiss(
    dialog: ModalScreen,
    post_twice: Callable[[ModalScreen], None],
) -> list[Any]:
    """Run *dialog*, fire a duplicated dismiss trigger, return the results.

    ``post_twice`` must post two dismiss-triggering messages to the dialog
    back-to-back, simulating a duplicated input event. Returns the list of
    dismissal results collected by the ``push_screen`` callback — callers
    assert it holds exactly one entry. An unguarded double dismiss surfaces
    here as ``ScreenStackError`` (or a second result) instead.
    """

    async def scenario() -> list[Any]:
        app = DialogHostApp(dialog)
        async with app.run_test() as pilot:
            await pilot.pause()
            assert app.screen is dialog, "dialog under test should be on top"
            post_twice(dialog)
            await pilot.pause()
            await pilot.pause()
            assert app.screen is not dialog, "dialog should have been dismissed"
        return app.results

    return asyncio.run(scenario())
