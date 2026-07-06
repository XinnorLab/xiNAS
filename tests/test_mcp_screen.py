"""MCPScreen — break-glass control-plane restart helper.

Headless coverage for the pure, injectable orchestration helper
``xinas_menu.screens.mcp._restart_control_plane``: dependency-ordered
restart of ``xinas-api`` then ``xinas-agent`` (see
docs/control-path/s8-clients-spec.md §6b). The Textual worker that wires
the confirm dialog + audit + view around it is not exercised here.
"""

from __future__ import annotations

import xinas_menu.screens.mcp as mcp


def _recording_restart(fail_on=None):
    """restart_fn stub recording the service names it was asked to restart."""
    calls: list[str] = []

    def restart(name: str) -> tuple[bool, str]:
        calls.append(name)
        if fail_on is not None and name == fail_on:
            return False, f"Job for {name}.service failed"
        return True, ""

    return restart, calls


def test_control_plane_services_are_api_then_agent():
    # api must precede agent: agent Requires=/After= api, and restarting
    # api alone leaves agent stopped.
    assert mcp._CONTROL_PLANE_SERVICES == ("xinas-api", "xinas-agent")


def test_restart_control_plane_restarts_api_before_agent():
    restart, calls = _recording_restart()
    all_ok, results = mcp._restart_control_plane(restart)
    assert calls == ["xinas-api", "xinas-agent"]
    assert all_ok is True
    assert [svc for svc, _ok, _err in results] == ["xinas-api", "xinas-agent"]
    assert all(ok for _svc, ok, _err in results)


def test_restart_control_plane_reports_per_service_failure():
    # api restart fails; agent is still attempted (honest per-service report),
    # and the aggregate result is not-ok.
    restart, calls = _recording_restart(fail_on="xinas-api")
    all_ok, results = mcp._restart_control_plane(restart)
    assert calls == ["xinas-api", "xinas-agent"]
    assert all_ok is False
    by_svc = {svc: (ok, err) for svc, ok, err in results}
    assert by_svc["xinas-api"][0] is False
    assert "failed" in by_svc["xinas-api"][1]
    assert by_svc["xinas-agent"][0] is True


def test_restart_control_plane_agent_failure_marks_not_ok():
    restart, _calls = _recording_restart(fail_on="xinas-agent")
    all_ok, results = mcp._restart_control_plane(restart)
    assert all_ok is False
    by_svc = {svc: ok for svc, ok, _err in results}
    assert by_svc["xinas-api"] is True
    assert by_svc["xinas-agent"] is False
