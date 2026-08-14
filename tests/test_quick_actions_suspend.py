"""btop must run inside App.suspend(), not alongside a live Textual app.

btop drives the alternate screen buffer and raw stdin — the same terminal
resources Textual holds. Running it in an executor thread while the app keeps
rendering makes the two interleave on one tty and leaves the terminal in
btop's state on exit. `App.suspend()` is the supported handover.
"""

from __future__ import annotations

import inspect

from xinas_menu.screens.quick_actions import QuickActionsScreen


def _src() -> str:
    return inspect.getsource(QuickActionsScreen._system_monitor)


def test_btop_runs_inside_app_suspend():
    assert "suspend()" in _src()


def test_btop_is_not_launched_from_an_executor():
    src = _src()
    assert "run_in_executor" not in src, (
        "btop must run synchronously inside the suspend block — a suspended "
        "app is not rendering, so blocking the loop is correct here"
    )


def test_suspend_not_supported_is_handled():
    assert "SuspendNotSupported" in _src()


def test_missing_btop_still_reports_the_install_hint():
    assert "not installed" in _src()
