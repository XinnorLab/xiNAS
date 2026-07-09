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

import contextlib
import http.client
import json
import socket
import time
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

DEFAULT_SOCKET = "/run/xinas/api.sock"
TERMINAL_STATES = {"success", "failed", "cancelled", "requires_manual_recovery"}


def quote_id(ident: Any) -> str:
    """Percent-encode a resource id for use as a single URL path segment.

    A Share id mirrors ``encExportId(path)`` — the exported directory with its
    leading slash stripped (``/mnt/data`` → ``mnt/data``) — so it can contain
    internal ``/`` characters. The api's mutating routes match a single,
    non-slash segment (``/shares/:id``); interpolating a raw ``mnt/data`` yields
    ``/api/v1/shares/mnt/data``, which no route matches, and the request fails
    with ``NOT_FOUND: no such API route`` (the raid-teardown "Delete Array"
    404). Encoding it to ``mnt%2Fdata`` makes the route match; the server
    decodes ``req.params.id`` back to ``mnt/data`` and resolves the share.

    ``safe=""`` encodes every reserved char, so slash-free ids (UUIDs, systemd
    mount-unit filesystem ids like ``mnt-data.mount``, array / pool names) pass
    through byte-for-byte — wrapping any id segment is always safe.
    """
    return quote(str(ident), safe="")


class ControlPathError(Exception):
    """Base for all control-path client failures."""


class TransportError(ControlPathError):
    """The api socket is unreachable or the response was not JSON."""


class ApiError(ControlPathError):
    """A non-2xx envelope. Carries the first error's code/message/details.

    ``details`` is the structured payload the api attaches to some errors
    (e.g. a ``CONFLICT`` from a held lease carries ``{reason, holder_task_id}``).
    ``reason`` / ``holder_task_id`` are convenience views so screens can tell a
    transient lock apart from a hard failure without re-parsing.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details: dict[str, Any] = details or {}

    @property
    def reason(self) -> str | None:
        reason = self.details.get("reason")
        return reason if isinstance(reason, str) else None

    @property
    def holder_task_id(self) -> str | None:
        holder = self.details.get("holder_task_id")
        return holder if isinstance(holder, str) else None


class PlanBlocked(ControlPathError):
    """plan returned blockers — the operation cannot proceed as specced."""

    def __init__(self, blockers: list[dict[str, Any]]) -> None:
        summary = "; ".join(str(b.get("message", b.get("code", "?"))) for b in blockers)
        super().__init__(f"plan blocked: {summary}")
        self.blockers = blockers


class TaskFailed(ControlPathError):
    """The apply task ended in a non-success terminal state.

    ``error_message`` is the best human-readable cause pulled from the
    final task record (see :func:`_failure_detail`); ``str(exc)`` includes
    it, so screens that render ``Failed: {exc}`` surface the failing
    stage's message without any change.
    """

    def __init__(
        self,
        task_id: str,
        state: str,
        error_code: str | None,
        error_message: str | None = None,
    ) -> None:
        text = f"task {task_id} ended {state} ({error_code or 'no error code'})"
        if error_message:
            text = f"{text}: {error_message}"
        super().__init__(text)
        self.task_id = task_id
        self.state = state
        self.error_code = error_code
        self.error_message = error_message


class TaskCancelled(TaskFailed):
    """The apply task ended ``cancelled`` (S10, ADR-0012) — partial work was
    rolled back. Subclass of TaskFailed so existing handlers keep working;
    screens catch it FIRST to message "operation cancelled" instead of a
    failure."""


def lease_conflict_message(exc: ControlPathError) -> str | None:
    """Friendly text for a *transient lock* conflict, else ``None``.

    A mutating apply returns ``CONFLICT`` with ``details.reason ==
    "lease_held"`` when another task holds the resource's lease — the normal
    case being a concurrent operation on the same resource, or a briefly-leaked
    lease the periodic sweep will reclaim (s2-task-envelope-spec §9). Screens
    render this as a calm "busy, retry" message rather than the raw
    ``Failed: CONFLICT: resource is locked by another task``. Any other error
    (including other ``CONFLICT`` reasons like ``fsid_in_use``) returns ``None``
    so the caller keeps its default rendering.
    """
    if not isinstance(exc, ApiError):
        return None
    if exc.code != "CONFLICT" or exc.reason != "lease_held":
        return None
    holder = exc.holder_task_id
    who = f" (task {holder})" if holder else ""
    return (
        f"This resource is temporarily locked by another operation{who}.\n"
        "Wait a few seconds and try again."
    )


def _failure_detail(task: dict[str, Any]) -> str | None:
    """Best human-readable failure cause from a terminal task record.

    The task row's ``error_message`` is set on FAILED_BEFORE_CHANGE /
    FAILED_MANUAL_RECOVERY_REQUIRED terminals; on the common stage-failure
    path (FAILED_PARTIAL_ROLLED_BACK) the agent's terminal event carries no
    message and the detail lives only on the failed stage row
    (s2-task-envelope-spec §6). Preference: task row → first failed
    non-rollback stage → failed rollback stage. The stage name is prefixed
    when the message doesn't already carry it.
    """
    message = task.get("error_message")
    if isinstance(message, str) and message:
        return message
    stages = task.get("stages")
    if not isinstance(stages, list):
        return None
    failed = [
        s
        for s in stages
        if isinstance(s, dict)
        and s.get("status") == "failed"
        and isinstance(s.get("error_message"), str)
        and s.get("error_message")
    ]
    ordered = [s for s in failed if s.get("name") != "rollback"] or failed
    if not ordered:
        return None
    stage = ordered[0]
    text = str(stage["error_message"])
    name = stage.get("name")
    if isinstance(name, str) and name and not text.startswith(name):
        return f"{name}: {text}"
    return text


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
            details = first.get("details")
            raise ApiError(
                status,
                str(first.get("code", f"HTTP_{status}")),
                str(first.get("message", "request failed")),
                details if isinstance(details, dict) else None,
            )
        return envelope

    def get(self, path: str) -> dict[str, Any]:
        return self.request("GET", path)

    def result(self, path: str) -> Any:
        """GET → the envelope's result field."""
        return self.get(path).get("result")

    def cancel_task(self, task_id: str) -> dict[str, Any]:
        """POST /tasks/{id}/cancel (S10) → the task row from the envelope."""
        envelope = self.request("POST", f"/api/v1/tasks/{task_id}/cancel")
        result = envelope.get("result")
        return result if isinstance(result, dict) else {}

    # -- plan/apply --------------------------------------------------------

    def plan(
        self,
        method: str,
        path: str,
        spec: dict[str, Any],
        *,
        dangerous: bool = False,
    ) -> dict[str, Any]:
        """mode=plan; raises PlanBlocked when the plan carries blockers.

        ``dangerous=True`` filters the engine-owned advisory
        ``dangerous_flag_required`` blocker (always present on destructive
        plans) before the check — the caller's consent rides to apply as
        ``dangerous: true``, mirroring the server's own apply-time re-check
        filter. Any OTHER blocker still raises.
        """
        envelope = self.request(method, path, {"mode": "plan", "spec": spec})
        result = envelope.get("result") or {}
        blockers = result.get("blockers") or []
        if dangerous:
            blockers = [b for b in blockers if str(b.get("code")) != "dangerous_flag_required"]
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
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """plan → apply → poll the task to terminal. Returns the final task
        result; raises PlanBlocked / TaskFailed / TaskCancelled / ApiError.

        ``cancel_check`` (S10): polled each loop; on its first True the
        client sends ONE ``POST /tasks/{id}/cancel`` and keeps polling to
        the terminal state. A ``cancelled`` terminal raises
        :class:`TaskCancelled` (whether or not this caller requested it)."""
        plan_result = self.plan(method, path, spec, dangerous=dangerous)
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
        cancel_sent = False
        while True:
            current = self.result(f"/api/v1/tasks/{task_id}") or {}
            state = str(current.get("state", "unknown"))
            if state != last_state:
                if on_progress is not None:
                    on_progress(state)
                last_state = state
            if state in TERMINAL_STATES:
                if state == "cancelled":
                    raise TaskCancelled(
                        task_id, state, current.get("error_code"), _failure_detail(current)
                    )
                if state != "success":
                    raise TaskFailed(
                        task_id, state, current.get("error_code"), _failure_detail(current)
                    )
                return current
            if cancel_check is not None and not cancel_sent and cancel_check():
                cancel_sent = True
                # not_cancellable / agent_not_found etc. — the poll loop
                # reads the actual terminal either way.
                with contextlib.suppress(ApiError):
                    self.cancel_task(task_id)
            if time.monotonic() > deadline:
                raise TaskFailed(task_id, f"timeout after {timeout_s}s (last: {state})", None)
            time.sleep(poll_s)
