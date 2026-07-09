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
    lease_conflict_message,
    quote_id,
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


def test_api_error_captures_details_and_holder(stub_socket):
    # A lease-conflict apply returns 409 CONFLICT with details naming the
    # holding task — the client must surface those, not drop them.
    ROUTES[("DELETE", "/api/v1/shares/s1")] = (
        409,
        {
            "errors": [
                {
                    "code": "CONFLICT",
                    "message": "resource is locked by another task",
                    "details": {"reason": "lease_held", "holder_task_id": "task-0042"},
                }
            ]
        },
    )
    with pytest.raises(ApiError) as err:
        client(stub_socket).request("DELETE", "/api/v1/shares/s1", {})
    assert err.value.code == "CONFLICT"
    assert err.value.reason == "lease_held"
    assert err.value.holder_task_id == "task-0042"
    assert err.value.details["reason"] == "lease_held"


def test_lease_conflict_message_friendly_for_lease_held():
    exc = ApiError(
        409,
        "CONFLICT",
        "resource is locked by another task",
        details={"reason": "lease_held", "holder_task_id": "task-0042"},
    )
    msg = lease_conflict_message(exc)
    assert msg is not None
    assert "task-0042" in msg
    # Friendly, not the raw code, and hints at the retry.
    assert "CONFLICT" not in msg
    assert "try again" in msg.lower() or "retry" in msg.lower()


def test_lease_conflict_message_none_for_other_errors():
    # Not a lease conflict → no special message (caller falls back to Failed: …).
    assert lease_conflict_message(ApiError(404, "NOT_FOUND", "no such share")) is None
    assert lease_conflict_message(TransportError("socket gone")) is None
    assert (
        lease_conflict_message(
            ApiError(409, "CONFLICT", "fsid in use", details={"reason": "fsid_in_use"})
        )
        is None
    )


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


# -- S10 (ADR-0012 §16.5): cancel_task + cancel_check + TaskCancelled --------


def test_cancel_task_posts_the_cancel_route(stub_socket):
    ROUTES[("POST", "/api/v1/tasks/t9/cancel")] = (
        200,
        {"result": {"task_id": "t9", "state": "cancelled"}},
    )
    result = client(stub_socket).cancel_task("t9")
    assert result["state"] == "cancelled"


def test_plan_apply_wait_cancel_check_sends_once_and_raises_task_cancelled(stub_socket):
    from xinas_menu.api.control_client import TaskCancelled

    states = iter(["queued", "running", "running", "cancelled"])
    posts = {"plan": 0, "cancels": 0}

    def share_post():
        posts["plan"] += 1
        if posts["plan"] == 1:
            return (
                200,
                {"result": {"plan_id": "p1", "state_revision_expected": 1, "blockers": []}},
            )
        return (202, {"result": {"task_id": "t1", "state": "queued"}})

    def task_get():
        return (200, {"result": {"task_id": "t1", "state": next(states, "cancelled")}})

    def cancel_post():
        posts["cancels"] += 1
        return (200, {"result": {"task_id": "t1", "state": "running"}})

    ROUTES[("POST", "/api/v1/shares")] = share_post
    ROUTES[("GET", "/api/v1/tasks/t1")] = task_get
    ROUTES[("POST", "/api/v1/tasks/t1/cancel")] = cancel_post

    with pytest.raises(TaskCancelled) as exc:
        client(stub_socket).plan_apply_wait(
            "POST",
            "/api/v1/shares",
            {"path": "/mnt/a"},
            poll_s=0.01,
            cancel_check=lambda: True,
        )
    assert exc.value.task_id == "t1"
    assert exc.value.state == "cancelled"
    # Sent exactly ONCE despite multiple poll iterations.
    assert posts["cancels"] == 1


# -- id path-segment encoding (share ids can contain '/') --------------------


def test_quote_id_percent_encodes_a_slash_share_id():
    """A share whose id mirrors encExportId(path) (e.g. '/mnt/data' → 'mnt/data')
    carries an internal '/'. It MUST be percent-encoded so the api's single
    -segment '/shares/:id' route matches instead of 404-ing 'no such API route'."""
    assert quote_id("mnt/data") == "mnt%2Fdata"
    assert quote_id("srv/nfs/share01") == "srv%2Fnfs%2Fshare01"


def test_quote_id_is_a_noop_for_slash_free_ids():
    """UUID share ids, systemd mount-unit filesystem ids ('mnt-data.mount'),
    array names, and pool names contain only unreserved chars — encoding leaves
    them byte-for-byte identical, so wrapping every id segment is always safe."""
    for ident in ("1234-abcd-5678", "mnt-data.mount", "data", "default"):
        assert quote_id(ident) == ident


def test_quote_id_coerces_non_str():
    assert quote_id(42) == "42"


def test_encoded_share_id_travels_the_wire_unmangled(stub_socket):
    """End-to-end: DELETE /shares/mnt%2Fdata must reach the server at that exact
    encoded path (Python's http.client does not touch it), so the server sees a
    single segment it can decode back to 'mnt/data'. This is the transport half
    of the raid-teardown fix (screens build the path with quote_id)."""
    posts = {"n": 0}

    def share_delete():
        posts["n"] += 1
        if posts["n"] == 1:
            return (
                200,
                {"result": {"plan_id": "p1", "state_revision_expected": 1, "blockers": []}},
            )
        return (202, {"result": {"task_id": "t1", "state": "queued"}})

    wire_path = f"/api/v1/shares/{quote_id('mnt/data')}"
    assert wire_path == "/api/v1/shares/mnt%2Fdata"
    ROUTES[("DELETE", wire_path)] = share_delete
    ROUTES[("GET", "/api/v1/tasks/t1")] = (200, {"result": {"task_id": "t1", "state": "success"}})

    result = client(stub_socket).plan_apply_wait("DELETE", wire_path, {}, poll_s=0.01)
    assert result["state"] == "success"
    # The stub records the raw request path — it must be the encoded form.
    assert any(m == "DELETE" and p == "/api/v1/shares/mnt%2Fdata" for (m, p, _) in BODIES)


def test_id_in_path_call_sites_encode_the_id():
    """Regression guard for the raid-teardown 404: no screen may interpolate a
    raw resource id into an '/api/v1/<kind>/{...}' path — every such site must
    wrap it in quote_id (a Share id can contain '/'). Fails on the pre-fix raw
    f-strings."""
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parent.parent / "xinas_menu" / "screens"
    # Matches an f-string URL f"/api/v1/<kind>/{ ... }" whose first interpolation
    # is a raw id (not already wrapped in quote_id). Anchored on f" so prose /
    # docstrings that merely mention a route path are not flagged.
    site = re.compile(r'f"/api/v1/[a-z-]+/\{(?!quote_id\()')
    offenders: list[str] = []
    for src in root.rglob("*.py"):
        for lineno, line in enumerate(src.read_text().splitlines(), 1):
            if site.search(line):
                offenders.append(f"{src.name}:{lineno}: {line.strip()}")
    assert not offenders, "raw (un-encoded) resource id in URL path:\n" + "\n".join(offenders)


def test_plan_apply_wait_without_cancel_check_unchanged(stub_socket):
    from xinas_menu.api.control_client import TaskCancelled, TaskFailed

    states = iter(["running", "cancelled"])

    def share_post():
        if not BODIES or BODIES[-1][2].get("mode") == "plan":
            pass
        return (202, {"result": {"task_id": "t1", "state": "queued"}})

    posts = {"n": 0}

    def post():
        posts["n"] += 1
        if posts["n"] == 1:
            return (
                200,
                {"result": {"plan_id": "p1", "state_revision_expected": 1, "blockers": []}},
            )
        return (202, {"result": {"task_id": "t1", "state": "queued"}})

    ROUTES[("POST", "/api/v1/shares")] = post
    ROUTES[("GET", "/api/v1/tasks/t1")] = lambda: (
        200,
        {"result": {"task_id": "t1", "state": next(states, "cancelled")}},
    )

    # An EXTERNAL cancel (no cancel_check) still surfaces as TaskCancelled —
    # a subclass of TaskFailed, so existing handlers keep working.
    with pytest.raises(TaskFailed) as exc:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/shares", {}, poll_s=0.01)
    assert isinstance(exc.value, TaskCancelled)


# -- TaskFailed failure detail (s8-clients-spec "Task-failure detail") --------


def _failed_task_routes(task_payload: dict) -> None:
    posts = {"n": 0}

    def fs_post():
        posts["n"] += 1
        if posts["n"] == 1:
            return (200, {"result": {"plan_id": "p1", "blockers": []}})
        return (202, {"result": {"task_id": "t3", "state": "queued"}})

    ROUTES[("POST", "/api/v1/filesystems")] = fs_post
    ROUTES[("GET", "/api/v1/tasks/t3")] = (200, {"result": task_payload})


def test_task_failed_carries_failing_stage_detail(stub_socket):
    """FAILED_PARTIAL_ROLLED_BACK terminals carry no task-level
    error_message; the detail lives on the failed stage row."""
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "failed",
            "error_code": "FAILED_PARTIAL_ROLLED_BACK",
            "stages": [
                {"name": "snapshot_before", "status": "success"},
                {
                    "name": "preflight",
                    "status": "failed",
                    "error_message": "preflight: /mnt/data is already a live mountpoint (/dev/sda1)",
                },
                {"name": "rollback", "status": "success"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == (
        "preflight: /mnt/data is already a live mountpoint (/dev/sda1)"
    )
    assert "already a live mountpoint" in str(err.value)
    assert "FAILED_PARTIAL_ROLLED_BACK" in str(err.value)


def test_task_failed_prefers_task_level_error_message(stub_socket):
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "failed",
            "error_code": "FAILED_BEFORE_CHANGE",
            "error_message": "executor rejected the spec",
            "stages": [
                {"name": "preflight", "status": "failed", "error_message": "stage detail"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == "executor rejected the spec"


def test_task_failed_stage_detail_gets_stage_name_prefix(stub_socket):
    """A stage message that doesn't already start with the stage name is
    prefixed with it, so bare executor errors keep their context."""
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "failed",
            "error_code": "FAILED_PARTIAL_ROLLED_BACK",
            "stages": [
                {"name": "mount", "status": "failed", "error_message": "unit failed to start"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == "mount: unit failed to start"


def test_task_failed_falls_back_to_rollback_stage_detail(stub_socket):
    _failed_task_routes(
        {
            "task_id": "t3",
            "state": "requires_manual_recovery",
            "error_code": "FAILED_MANUAL_RECOVERY_REQUIRED",
            "stages": [
                {"name": "rollback", "status": "failed", "error_message": "rollback: umount busy"},
            ],
        }
    )
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message == "rollback: umount busy"


def test_task_failed_without_detail_keeps_legacy_message(stub_socket):
    _failed_task_routes({"task_id": "t3", "state": "failed", "error_code": "BOOM"})
    with pytest.raises(TaskFailed) as err:
        client(stub_socket).plan_apply_wait("POST", "/api/v1/filesystems", {}, poll_s=0.01)
    assert err.value.error_message is None
    assert str(err.value) == "task t3 ended failed (BOOM)"
