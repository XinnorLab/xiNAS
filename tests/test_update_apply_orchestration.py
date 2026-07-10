"""WS3 (T13, F11c): shared update-apply orchestration (checkout -> rebuild ->
refresh -> restart), replacing the duplicated _apply_update() bodies in
xinas_menu/app.py (XiNASApp) and xinas_menu/screens/startup/startup_menu.py
(StartupApp). This path had ZERO test coverage before this task.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

from xinas_menu.utils import update_check as uc
from xinas_menu.utils.update_apply import apply_update_flow


class _FakeApp:
    def __init__(self):
        self._update_checker = MagicMock()
        self.audit = MagicMock()
        self.notify = MagicMock()
        self.push_screen_wait = AsyncMock()


def _result(tag="v3.1.1", rebuilds=()):
    return uc.CheckResult(
        True, current_version="3.1.0", latest_version=tag, required_rebuilds=rebuilds
    )


def test_no_rebuild_refreshes_then_restarts(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    refreshed = uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.SUCCESS)
    monkeypatch.setattr(
        "xinas_menu.utils.update_apply.refresh_nfs_helper", lambda repo, tags: refreshed
    )

    asyncio.run(apply_update_flow(app, _result(rebuilds=())))

    app._update_checker.restart_self.assert_called_once()
    app.push_screen_wait.assert_not_called()  # no rebuild -> no PlaybookRunScreen


def test_failed_rebuild_stops_before_refresh_or_restart(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    app.push_screen_wait.return_value = 1  # ansible rc != 0
    called = {"refresh": False}

    def _fake_refresh(repo, tags):
        called["refresh"] = True
        return uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.SUCCESS)

    monkeypatch.setattr("xinas_menu.utils.update_apply.refresh_nfs_helper", _fake_refresh)

    asyncio.run(apply_update_flow(app, _result(rebuilds=("nfs_server",))))

    assert called["refresh"] is False, "refresh must not run after a failed rebuild"
    app._update_checker.restart_self.assert_not_called()
    app.notify.assert_called_once()
    assert "not restarting" in app.notify.call_args.args[0]


def test_successful_rebuild_refreshes_then_restarts(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    app.push_screen_wait.return_value = 0  # ansible rc == 0
    seen = {}

    def _fake_refresh(repo, tags):
        seen["tags"] = tags
        return uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.SUCCESS)

    monkeypatch.setattr("xinas_menu.utils.update_apply.refresh_nfs_helper", _fake_refresh)

    asyncio.run(apply_update_flow(app, _result(rebuilds=("nfs_server",))))

    assert seen["tags"] == ("nfs_server",)
    app._update_checker.restart_self.assert_called_once()


def test_refresh_failure_is_partial_success_not_blocking_restart(monkeypatch):
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (True, "checked out")
    failed = uc.NfsHelperRefreshResult(uc.NfsHelperRefreshOutcome.FAILED_WRAPPER, detail="boom")
    monkeypatch.setattr(
        "xinas_menu.utils.update_apply.refresh_nfs_helper", lambda repo, tags: failed
    )

    asyncio.run(apply_update_flow(app, _result(rebuilds=())))

    app._update_checker.restart_self.assert_called_once()  # still restarts
    warn_call = app.notify.call_args
    assert warn_call.kwargs.get("severity") == "warning"
    assert "sudo /usr/local/sbin/xinas-update-helper-sync" in warn_call.args[0]


def test_checkout_failure_never_reaches_refresh_or_restart():
    app = _FakeApp()
    app._update_checker.apply_update.return_value = (False, "permission denied")

    asyncio.run(apply_update_flow(app, _result()))

    app._update_checker.restart_self.assert_not_called()
    app.push_screen_wait.assert_not_called()
    app.notify.assert_called_once()
    assert "Update failed" in app.notify.call_args.args[0]


def test_app_and_startup_app_delegate_to_shared_flow():
    import inspect

    from xinas_menu.app import XiNASApp
    from xinas_menu.screens.startup.startup_menu import StartupApp

    for cls in (XiNASApp, StartupApp):
        src = inspect.getsource(cls._apply_update)
        assert "apply_update_flow" in src, (
            f"{cls.__name__}._apply_update must delegate to the shared helper"
        )
