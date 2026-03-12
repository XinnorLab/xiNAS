"""NFSHelperClient — Unix socket JSON client for xinas-nfs-helper.

Protocol:
  Request:  { "op": "...", "request_id": "uuid", ...fields }\n
  Response: { "ok": true/false, "result": ..., "request_id": "uuid" }\n

All public methods return (ok: bool, data: Any, error: str).
"""
from __future__ import annotations

import json
import socket
import uuid
from typing import Any

NFS_SOCKET_PATH = "/run/xinas-nfs-helper.sock"

TIMEOUT = 10.0


class NFSHelperClient:
    """Synchronous client for the NFS helper Unix socket daemon."""

    def __init__(self, socket_path: str = NFS_SOCKET_PATH) -> None:
        self._path = socket_path

    def _request(self, op: str, **kwargs: Any) -> tuple[bool, Any, str]:
        payload = {"op": op, "request_id": str(uuid.uuid4()), **kwargs}
        raw = json.dumps(payload).encode() + b"\n"
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(TIMEOUT)
                sock.connect(self._path)
                sock.sendall(raw)
                buf = b""
                while True:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                    if b"\n" in buf:
                        break
        except FileNotFoundError:
            return False, None, f"NFS helper socket not found: {self._path}"
        except ConnectionRefusedError:
            return False, None, "NFS helper is not running (connection refused)"
        except socket.timeout:
            return False, None, "NFS helper timed out"
        except OSError as exc:
            return False, None, str(exc)

        try:
            resp = json.loads(buf.split(b"\n")[0])
        except json.JSONDecodeError as exc:
            return False, None, f"bad JSON from NFS helper: {exc}"

        if resp.get("ok"):
            return True, resp.get("result"), ""
        return False, None, resp.get("error", "unknown error from NFS helper")

    # ── Operations ──────────────────────────────────────────────────────────

    def list_exports(self) -> tuple[bool, list[dict], str]:
        return self._request("list_exports")

    def add_export(self, entry: dict) -> tuple[bool, None, str]:
        """Add a new NFS export.

        *entry* keys: path, clients (list), options (list).
        """
        return self._request("add_export", entry=entry)

    def remove_export(self, path: str) -> tuple[bool, None, str]:
        return self._request("remove_export", path=path)

    def update_export(self, path: str, patch: dict) -> tuple[bool, None, str]:
        """Patch fields of an existing export."""
        return self._request("update_export", path=path, patch=patch)

    def list_sessions(self) -> tuple[bool, list[dict], str]:
        return self._request("list_sessions")

    def get_sessions(self, path: str) -> tuple[bool, list[dict], str]:
        return self._request("get_sessions", path=path)

    def set_quota(
        self,
        path: str,
        soft_limit_kb: int,
        hard_limit_kb: int,
        project_id: int | None = None,
    ) -> tuple[bool, None, str]:
        quota = {
            "path": path,
            "soft_limit_kb": soft_limit_kb,
            "hard_limit_kb": hard_limit_kb,
        }
        if project_id is not None:
            quota["project_id"] = project_id
        return self._request("set_quota", quota=quota)

    def reload(self) -> tuple[bool, None, str]:
        """Force exportfs -r (reload all exports)."""
        return self._request("reload")
