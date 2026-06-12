"""Control-path API client (S8 T11, ADR-0010).

The TUI's path onto the xinas-api REST surface: stdlib HTTP over the
api's UNIX socket (peer trust — the TUI runs as root) with optional
bearer token, envelope parsing, and the ``plan_apply_wait`` helper the
retargeted screens drive mutations through (plan → apply → poll the
task to a terminal state, surfacing stage progress).

No third-party dependencies. Synchronous by design: screens call it
via ``asyncio.to_thread`` (the same pattern as the gRPC client's
subprocess fallbacks).
"""

from __future__ import annotations

import http.client
import json
import socket
import time
import uuid
from collections.abc import Callable
from typing import Any

DEFAULT_SOCKET = "/run/xinas/api.sock"
TERMINAL_STATES = {"success", "failed", "cancelled", "requires_manual_recovery"}


class ControlPathError(Exception):
    """Base for all control-path client failures."""


class TransportError(ControlPathError):
    """The api socket is unreachable or the response was not JSON."""


class ApiError(ControlPathError):
    """A non-2xx envelope. Carries the first error's code/message."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message


class PlanBlocked(ControlPathError):
    """plan returned blockers — the operation cannot proceed as specced."""

    def __init__(self, blockers: list[dict[str, Any]]) -> None:
        summary = "; ".join(str(b.get("message", b.get("code", "?"))) for b in blockers)
        super().__init__(f"plan blocked: {summary}")
        self.blockers = blockers


class TaskFailed(ControlPathError):
    """The apply task ended in a non-success terminal state."""

    def __init__(self, task_id: str, state: str, error_code: str | None) -> None:
        super().__init__(f"task {task_id} ended {state} ({error_code or 'no error code'})")
        self.task_id = task_id
        self.state = state
        self.error_code = error_code


class _UDSConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:  # pragma: no cover - exercised via the stub server
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


class ControlClient:
    """One client per app instance; one connection per request (simple,
    robust against api restarts)."""

    def __init__(
        self,
        socket_path: str = DEFAULT_SOCKET,
        token: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.socket_path = socket_path
        self.token = token
        self.timeout = timeout

    # -- low level ---------------------------------------------------------

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """One request → the parsed envelope. Raises ApiError on a non-2xx
        envelope, TransportError when the socket/JSON layer fails."""
        payload = None if body is None else json.dumps(body)
        headers = {"Accept": "application/json"}
        if self.token is not None:
            headers["Authorization"] = f"Bearer {self.token}"
        if payload is not None:
            headers["Content-Type"] = "application/json"

        conn = _UDSConnection(self.socket_path, self.timeout)
        try:
            conn.request(method, path, body=payload, headers=headers)
            response = conn.getresponse()
            raw = response.read()
            status = response.status
        except (OSError, http.client.HTTPException) as exc:
            raise TransportError(f"xinas-api unreachable at {self.socket_path}: {exc}") from exc
        finally:
            conn.close()

        try:
            envelope: dict[str, Any] = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise TransportError(f"non-JSON response (HTTP {status})") from exc

        if status >= 400:
            errors = envelope.get("errors") or [{}]
            first = errors[0] if isinstance(errors, list) and errors else {}
            raise ApiError(
                status,
                str(first.get("code", f"HTTP_{status}")),
                str(first.get("message", "request failed")),
            )
        return envelope

    def get(self, path: str) -> dict[str, Any]:
        return self.request("GET", path)

    def result(self, path: str) -> Any:
        """GET → the envelope's result field."""
        return self.get(path).get("result")

    # -- plan/apply --------------------------------------------------------

    def plan(self, method: str, path: str, spec: dict[str, Any]) -> dict[str, Any]:
        """mode=plan; raises PlanBlocked when the plan carries blockers."""
        envelope = self.request(method, path, {"mode": "plan", "spec": spec})
        result = envelope.get("result") or {}
        blockers = result.get("blockers") or []
        if blockers:
            raise PlanBlocked(blockers)
        return result

    def plan_apply_wait(
        self,
        method: str,
        path: str,
        spec: dict[str, Any],
        *,
        dangerous: bool = False,
        on_progress: Callable[[str], None] | None = None,
        poll_s: float = 0.5,
        timeout_s: float = 600.0,
    ) -> dict[str, Any]:
        """plan → apply → poll the task to terminal. Returns the final task
        result; raises PlanBlocked / TaskFailed / ApiError."""
        plan_result = self.plan(method, path, spec)
        plan_id = plan_result.get("plan_id")
        if not isinstance(plan_id, str):
            raise TransportError("plan response carried no plan_id")

        apply_body: dict[str, Any] = {
            "mode": "apply",
            "plan_id": plan_id,
            # ApplyRequest contract (routes/apply-helpers.ts): applyMode
            # hard-requires a fresh idempotency_key and the plan's
            # state_revision_expected echoed back as expected_revision.
            "idempotency_key": str(uuid.uuid4()),
            "expected_revision": int(plan_result.get("state_revision_expected") or 0),
        }
        if dangerous:
            apply_body["dangerous"] = True
        apply_envelope = self.request(method, path, apply_body)
        task = apply_envelope.get("result") or {}
        task_id = task.get("task_id")
        if not isinstance(task_id, str):
            raise TransportError("apply response carried no task_id")

        deadline = time.monotonic() + timeout_s
        last_state = ""
        while True:
            current = self.result(f"/api/v1/tasks/{task_id}") or {}
            state = str(current.get("state", "unknown"))
            if state != last_state:
                if on_progress is not None:
                    on_progress(state)
                last_state = state
            if state in TERMINAL_STATES:
                if state != "success":
                    raise TaskFailed(task_id, state, current.get("error_code"))
                return current
            if time.monotonic() > deadline:
                raise TaskFailed(task_id, f"timeout after {timeout_s}s (last: {state})", None)
            time.sleep(poll_s)
