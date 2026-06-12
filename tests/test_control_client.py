"""Tests for the TUI control-path client (S8 T11, ADR-0010).

A stub HTTP server on a real UNIX socket serves canned envelopes so the
client's transport, error mapping, and plan_apply_wait state machine
are exercised end to end without an api process.
"""

import json
import os
import socketserver
import tempfile
import threading
from http.server import BaseHTTPRequestHandler

import pytest

from xinas_menu.api.control_client import (
    ApiError,
    ControlClient,
    PlanBlocked,
    TaskFailed,
    TransportError,
)

# Route table the stub serves: (method, path) -> (status, envelope) or a
# callable returning one (for stateful task polling).
ROUTES: dict[tuple[str, str], object] = {}

# Captured request bodies: (method, path, parsed_json) per non-GET request,
# so tests can pin the ApplyRequest contract (idempotency_key etc.).
BODIES: list[tuple[str, str, dict]] = []


class _Handler(BaseHTTPRequestHandler):
    def _serve(self, method: str) -> None:
        entry = ROUTES.get((method, self.path))
        if entry is None:
            self._reply(404, {"errors": [{"code": "NOT_FOUND", "message": self.path}]})
            return
        if callable(entry):
            status, envelope = entry()
        else:
            status, envelope = entry  # type: ignore[misc]
        self._reply(status, envelope)

    def _reply(self, status: int, envelope: dict) -> None:
        body = json.dumps(envelope).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        self._serve("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._capture_and_serve("POST")

    def do_PATCH(self) -> None:  # noqa: N802
        self._capture_and_serve("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self._capture_and_serve("DELETE")

    def _capture_and_serve(self, method: str) -> None:
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        try:
            BODIES.append((method, self.path, json.loads(raw) if raw else {}))
        except ValueError:
            BODIES.append((method, self.path, {}))
        self._serve(method)

    def log_message(self, *_args: object) -> None:
        pass


class _UDSServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    # http.server expects a client_address tuple; UDS gives a string.
    def get_request(self):  # type: ignore[override]
        request, _ = super().get_request()
        return request, ("uds", 0)


@pytest.fixture
def stub_socket():
    ROUTES.clear()
    BODIES.clear()
    tmp = tempfile.mkdtemp(prefix="xinas-ctl-test-")
    path = os.path.join(tmp, "api.sock")
    server = _UDSServer(path, _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield path
    server.shutdown()
    server.server_close()


def client(path: str) -> ControlClient:
    return ControlClient(socket_path=path, timeout=5.0)


def test_get_returns_envelope_and_result(stub_socket):
    ROUTES[("GET", "/api/v1/arrays")] = (200, {"result": [{"id": "a1"}], "warnings": []})
    c = client(stub_socket)
    assert c.result("/api/v1/arrays") == [{"id": "a1"}]


def test_api_error_maps_code_and_message(stub_socket):
    ROUTES[("GET", "/api/v1/arrays/x")] = (
        404,
        {"errors": [{"code": "NOT_FOUND", "message": "no such array"}]},
    )
    with pytest.raises(ApiError) as err:
        client(stub_socket).get("/api/v1/arrays/x")
    assert err.value.code == "NOT_FOUND"
    assert err.value.status == 404


def test_transport_error_when_socket_absent(tmp_path):
    c = ControlClient(socket_path=str(tmp_path / "nope.sock"), timeout=1.0)
    with pytest.raises(TransportError):
        c.get("/api/v1/arrays")


def test_plan_blocked_raises_with_blockers(stub_socket):
    ROUTES[("POST", "/api/v1/shares")] = (
        200,
        {"result": {"plan_id": "p1", "blockers": [{"code": "X", "message": "path not mounted"}]}},
    )
    with pytest.raises(PlanBlocked) as err:
        client(stub_socket).plan("POST", "/api/v1/shares", {"path": "/mnt/a"})
    assert "path not mounted" in str(err.value)


def test_plan_apply_wait_happy_path_reports_progress(stub_socket):
    states = iter(["queued", "running", "success"])

    posts = {"n": 0}

    def share_post():
        posts["n"] += 1
        if posts["n"] == 1:
            return (
                200,
                {"result": {"plan_id": "p1", "state_revision_expected": 7, "blockers": []}},
            )
        return (202, {"result": {"task_id": "t1", "state": "queued"}})

    def task_get():
        state = next(states, "success")
        return (200, {"result": {"task_id": "t1", "state": state}})

    ROUTES[("POST", "/api/v1/shares")] = share_post
    ROUTES[("GET", "/api/v1/tasks/t1")] = task_get

    seen: list[str] = []
    result = client(stub_socket).plan_apply_wait(
        "POST",
        "/api/v1/shares",
        {"path": "/mnt/a"},
        on_progress=seen.append,
        poll_s=0.01,
    )
    assert result["state"] == "success"
    assert seen[0] == "queued"
    assert "success" in seen

    # The apply body must satisfy the ApplyRequest contract: echo the plan's
    # state_revision_expected and carry a fresh non-empty idempotency_key.
    apply_bodies = [b for (_, _, b) in BODIES if b.get("mode") == "apply"]
    assert len(apply_bodies) == 1
    assert apply_bodies[0]["plan_id"] == "p1"
    assert apply_bodies[0]["expected_revision"] == 7
    assert isinstance(apply_bodies[0]["idempotency_key"], str)
    assert apply_bodies[0]["idempotency_key"]


def test_plan_apply_wait_dangerous_filters_advisory_blocker(stub_socket):
    """dangerous=True mirrors the server's apply re-check (S8 T13): the
    engine-owned dangerous_flag_required advisory blocker — always present
    on destructive plans like arrays.delete — does not abort the flow, and
    the apply body carries dangerous: true."""
    posts = {"n": 0}

    def array_delete():
        posts["n"] += 1
        if posts["n"] == 1:
            return (
                200,
                {
                    "result": {
                        "plan_id": "p9",
                        "state_revision_expected": 3,
                        "blockers": [
                            {"code": "dangerous_flag_required", "message": "irreversible"}
                        ],
                    }
                },
            )
        return (202, {"result": {"task_id": "t9", "state": "queued"}})

    ROUTES[("DELETE", "/api/v1/arrays/a1")] = array_delete
    ROUTES[("GET", "/api/v1/tasks/t9")] = (200, {"result": {"task_id": "t9", "state": "success"}})

    result = client(stub_socket).plan_apply_wait(
        "DELETE", "/api/v1/arrays/a1", {}, dangerous=True, poll_s=0.01
    )
    assert result["state"] == "success"
    apply_bodies = [b for (m, _, b) in BODIES if m == "DELETE" and b.get("mode") == "apply"]
    assert len(apply_bodies) == 1
    assert apply_bodies[0]["dangerous"] is True
    assert apply_bodies[0]["expected_revision"] == 3


def test_plan_dangerous_blocker_still_blocks_without_flag(stub_socket):
    ROUTES[("DELETE", "/api/v1/arrays/a1")] = (
        200,
        {
            "result": {
                "plan_id": "p9",
                "blockers": [{"code": "dangerous_flag_required", "message": "irreversible"}],
            }
        },
    )
    with pytest.raises(PlanBlocked):
        client(stub_socket).plan("DELETE", "/api/v1/arrays/a1", {})


def test_plan_dangerous_keeps_real_blockers(stub_socket):
    """dangerous=True filters ONLY the advisory code; dependency blockers
    (mounted filesystems, active sessions) still raise PlanBlocked."""
    ROUTES[("DELETE", "/api/v1/arrays/a1")] = (
        200,
        {
            "result": {
                "plan_id": "p9",
                "blockers": [
                    {"code": "dangerous_flag_required", "message": "irreversible"},
                    {"code": "dependent_filesystem_mounted", "message": "fs mounted"},
                ],
            }
        },
    )
    with pytest.raises(PlanBlocked) as err:
        client(stub_socket).plan("DELETE", "/api/v1/arrays/a1", {}, dangerous=True)
    assert "fs mounted" in str(err.value)


def test_plan_apply_wait_failed_task_raises(stub_socket):
    posts = {"n": 0}

    def share_post():
        posts["n"] += 1
        if posts["n"] == 1:
            return (200, {"result": {"plan_id": "p1", "blockers": []}})
        return (202, {"result": {"task_id": "t2", "state": "queued"}})

    ROUTES[("POST", "/api/v1/shares")] = share_post
    ROUTES[("GET", "/api/v1/tasks/t2")] = (
        200,
        {"result": {"task_id": "t2", "state": "failed", "error_code": "BOOM"}},
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/shares", {}, poll_s=0.01)
    assert err.value.error_code == "BOOM"
