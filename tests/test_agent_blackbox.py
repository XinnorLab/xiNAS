"""Black-box regression suite for the xinas-agent process.

These tests boot the *real* compiled agent (`xiNAS-MCP/dist/agent-server.js`) on
an ephemeral Unix-domain socket and drive it over the wire exactly as the
xinas-api would: NDJSON JSON-RPC 2.0, one request per '\\n'-delimited line. They
assert the externally observable contract from
docs/control-path/ (ADR-0002 RPC surface, dispatch.ts §Errors, rpc/server.ts
socket permissions) without importing any TypeScript.

They intentionally COMPLEMENT the TypeScript e2e smoke test
(`xiNAS-MCP/src/__tests__/agent/agent-server.test.ts`), which already covers the
`agent.health` shape and clean SIGTERM. Here we pin the parts that suite does
not: `agent.version`, the JSON-RPC error model (-32601 / -32600 / -32000),
request-id echo, NDJSON pipelining, socket permissions, stale-socket rebind,
`task.list_inflight`, the 1 MB request guard, and fail-fast on missing config.

Requirements: a `node` runtime and a built agent (`npm run build` in
`xiNAS-MCP/`). When either is absent (e.g. the Python-only CI job) the whole
module skips — it is meant to run on a machine that has the agent artifact, such
as a xiNAS node or a CI job that builds `xiNAS-MCP`.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
AGENT_ENTRY = REPO / "xiNAS-MCP" / "dist" / "agent-server.js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None or not AGENT_ENTRY.exists(),
    reason="black-box agent tests need `node` and a built xiNAS-MCP/dist/agent-server.js",
)

CONTROLLER_ID = "00000000-0000-0000-0000-0000000000e2"
SOCKET_WAIT_S = 10.0


def _is_socket(path: str) -> bool:
    try:
        return stat.S_ISSOCK(os.stat(path).st_mode)
    except OSError:
        return False


class Agent:
    """A booted agent process plus a JSON-RPC-over-UDS client."""

    def __init__(self, proc: subprocess.Popen, socket_path: str, stderr_path: Path):
        self.proc = proc
        self.socket_path = socket_path
        self._stderr_path = stderr_path

    def stderr(self) -> str:
        try:
            return self._stderr_path.read_text(errors="replace")
        except OSError:
            return ""

    def send(self, payload: bytes, *, expect_lines: int = 1, timeout: float = 5.0) -> list[dict]:
        """Send raw bytes on a fresh connection; return up to `expect_lines` parsed replies."""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(self.socket_path)
            client.sendall(payload)
            buf = b""
            lines: list[bytes] = []
            while len(lines) < expect_lines:
                try:
                    chunk = client.recv(65536)
                except TimeoutError:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line:
                        lines.append(line)
                    if len(lines) >= expect_lines:
                        break
        return [json.loads(ln) for ln in lines]

    def rpc(self, method: str, params: dict | None = None, req_id: object = 1) -> dict:
        """Send one JSON-RPC request and return the single parsed response envelope."""
        req = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}
        replies = self.send(json.dumps(req).encode() + b"\n")
        assert replies, f"no response to {method}; agent stderr:\n{self.stderr()}"
        return replies[0]


@contextmanager
def boot_agent(
    *,
    env_extra: dict[str, str] | None = None,
    pre_create_socket: bool = False,
    omit_token: bool = False,
    wait: bool = True,
) -> Iterator[Agent]:
    """Boot a real agent-server process against throwaway config; yield an Agent."""
    run_dir = Path(tempfile.mkdtemp(prefix="xa-"))
    sock_path = str(run_dir / "a.sock")
    # AF_UNIX paths are capped (~104 bytes on macOS); bail rather than flake.
    if len(sock_path) > 100:
        shutil.rmtree(run_dir, ignore_errors=True)
        pytest.skip(f"socket path too long for AF_UNIX: {sock_path}")

    ctrl_id_path = run_dir / "controller-id"
    token_path = run_dir / "agent-token"
    config_path = run_dir / "config.json"
    stderr_path = run_dir / "stderr.log"

    ctrl_id_path.write_text(CONTROLLER_ID + "\n")
    if not omit_token:
        token_path.write_text("test-agent-token\n")
    config_path.write_text(
        json.dumps(
            {
                "api_socket": str(run_dir / "api.sock"),  # api is absent; agent only reads config
                "agent_socket": sock_path,
                "controller_id_path": str(ctrl_id_path),
                "agent_token_path": str(token_path),
                # No 'getent' on macOS / gid mismatch as non-root: the agent
                # logs socket_perm_skipped and still serves. See rpc/server.ts.
                "socket_group": "nogroup",
            }
        )
    )
    if pre_create_socket:
        # A leftover file where the socket belongs: the server must unlink it.
        Path(sock_path).write_text("stale")

    env = {**os.environ, "XINAS_AGENT_CONFIG_PATH": str(config_path)}
    if env_extra:
        env.update(env_extra)

    stderr_f = stderr_path.open("wb")
    proc = subprocess.Popen(
        [NODE, str(AGENT_ENTRY)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=stderr_f,
        start_new_session=True,
    )
    agent = Agent(proc, sock_path, stderr_path)
    try:
        if wait:
            # Wait for a real *socket* — not merely an existing path — so the
            # pre_create_socket case blocks until the agent has unlinked the
            # stale file and bound its own UDS.
            deadline = time.monotonic() + SOCKET_WAIT_S
            while not _is_socket(sock_path):
                if proc.poll() is not None:
                    raise AssertionError(
                        f"agent exited early (code {proc.returncode}):\n{agent.stderr()}"
                    )
                if time.monotonic() > deadline:
                    raise AssertionError(f"socket never appeared:\n{agent.stderr()}")
                time.sleep(0.05)
        yield agent
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        stderr_f.close()
        shutil.rmtree(run_dir, ignore_errors=True)


@pytest.fixture(scope="module")
def agent() -> Iterator[Agent]:
    """One default agent instance shared by the read-only tests."""
    with boot_agent() as a:
        yield a


# ── agent.version ────────────────────────────────────────────────────────────


def test_version_defaults_and_omits_optional_metadata(agent: Agent):
    resp = agent.rpc("agent.version")
    result = resp["result"]
    assert result["version"] == "0.0.0-dev"
    # exactOptionalPropertyTypes: absent env -> key absent, not null.
    assert "git_sha" not in result
    assert "build_date" not in result


def test_version_reflects_build_env():
    env = {
        "XINAS_AGENT_VERSION": "9.9.9",
        "XINAS_AGENT_GIT_SHA": "deadbeef",
        "XINAS_AGENT_BUILD_DATE": "2026-07-08",
    }
    with boot_agent(env_extra=env) as a:
        result = a.rpc("agent.version")["result"]
        assert result["version"] == "9.9.9"
        assert result["git_sha"] == "deadbeef"
        assert result["build_date"] == "2026-07-08"


# ── agent.health ─────────────────────────────────────────────────────────────


def test_health_status_shape_and_id_echo(agent: Agent):
    resp = agent.rpc("agent.health", req_id="hc-1")
    assert resp["id"] == "hc-1"  # request id echoed verbatim
    result = resp["result"]
    assert result["status"] in {"starting", "healthy", "degraded"}
    assert result["controller_id"] == CONTROLLER_ID
    assert result["in_flight_tasks"] == 0
    assert isinstance(result["collectors"], dict)
    assert isinstance(result["uptime_seconds"], int)


# ── JSON-RPC error model (dispatch.ts §Errors) ───────────────────────────────


def test_unknown_method_is_method_not_found(agent: Agent):
    resp = agent.rpc("does.not.exist")
    assert resp["error"]["code"] == -32601


def test_enumerated_stub_returns_executor_unsupported(agent: Agent):
    # disks.list is enumerated-but-stubbed: -32000 with a typed data.code.
    resp = agent.rpc("disks.list")
    assert resp["error"]["code"] == -32000
    assert resp["error"]["data"]["code"] == "EXECUTOR_UNSUPPORTED"


def test_non_json_line_is_invalid_request(agent: Agent):
    replies = agent.send(b"this is not json\n")
    assert replies[0]["error"]["code"] == -32600


def test_missing_method_field_is_invalid_request_and_echoes_id(agent: Agent):
    replies = agent.send(b'{"jsonrpc":"2.0","id":7}\n')
    assert replies[0]["error"]["code"] == -32600
    assert replies[0]["id"] == 7


def test_json_array_envelope_is_invalid_request(agent: Agent):
    replies = agent.send(b"[1,2,3]\n")
    assert replies[0]["error"]["code"] == -32600


# ── NDJSON framing ───────────────────────────────────────────────────────────


def test_pipelined_requests_answered_in_order(agent: Agent):
    line1 = json.dumps({"jsonrpc": "2.0", "id": 101, "method": "agent.version"})
    line2 = json.dumps({"jsonrpc": "2.0", "id": 102, "method": "agent.health"})
    replies = agent.send((line1 + "\n" + line2 + "\n").encode(), expect_lines=2)
    assert [r["id"] for r in replies] == [101, 102]


def test_oversized_request_is_rejected(agent: Agent):
    # >1 MB with no newline trips the DoS guard in rpc/server.ts.
    payload = b"a" * (1024 * 1024 + 16)
    replies = agent.send(payload, expect_lines=1)
    assert replies and replies[0]["error"]["code"] == -32600


# ── Task surface ─────────────────────────────────────────────────────────────


def test_task_list_inflight_starts_empty(agent: Agent):
    result = agent.rpc("task.list_inflight")["result"]
    assert result["tasks"] == []


# ── Socket lifecycle & permissions (rpc/server.ts) ───────────────────────────


def test_socket_is_not_world_accessible(agent: Agent):
    mode = stat.S_IMODE(os.stat(agent.socket_path).st_mode)
    assert mode & 0o007 == 0, f"agent socket is world-accessible: {oct(mode)}"
    assert mode & 0o777 == 0o660, f"expected 0660 socket, got {oct(mode)}"


def test_stale_socket_file_is_replaced_on_boot():
    with boot_agent(pre_create_socket=True) as a:
        result = a.rpc("agent.health")["result"]
        assert result["controller_id"] == CONTROLLER_ID


# ── Config preconditions ─────────────────────────────────────────────────────


def test_missing_agent_token_file_fails_fast():
    with boot_agent(omit_token=True, wait=False) as a:
        # loadAgentConfig throws when the token file is absent -> non-zero exit.
        try:
            a.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pytest.fail(f"agent did not exit on missing token:\n{a.stderr()}")
        assert a.proc.returncode not in (0, None)
        assert "agent-token" in a.stderr()
