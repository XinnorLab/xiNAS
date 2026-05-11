#!/usr/bin/env python3
"""
xiNAS NFS Helper Daemon.

Unix domain socket server at /run/xinas-nfs-helper.sock.
Protocol: newline-delimited JSON.

Request:  { "op": "...", "request_id": "...", ... }\n
Response: { "ok": true|false, "result": ..., "request_id": "...", [error fields] }\n
"""

import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading

from nfs_exports import list_exports, add_export, remove_export, update_export
from nfs_sessions import list_sessions, get_sessions_for_path
from nfs_quota import set_project_quota, set_user_quota
from nfs_conf import build_nfsd_updates, restart_nfs_server, set_nfs_conf

# --- Configuration ---

SOCKET_PATH = os.environ.get("NFS_HELPER_SOCKET", "/run/xinas-nfs-helper.sock")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

# --- Logging ---

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("nfs_helper")


# --- Operations ---

def handle_list_exports(_req: dict) -> list:
    return list_exports()


def handle_add_export(req: dict) -> None:
    entry = req.get("entry")
    if not entry or not isinstance(entry, dict):
        raise ValueError("Missing or invalid 'entry' field")
    if "path" not in entry:
        raise ValueError("entry.path is required")
    path = entry["path"]
    if not os.path.isdir(path):
        os.makedirs(path, exist_ok=True)
        log.info("Created export directory: %s", path)
    add_export(entry)
    _exportfs_reload()


def handle_remove_export(req: dict) -> None:
    path = req.get("path")
    if not path:
        raise ValueError("Missing 'path' field")
    remove_export(path)
    _exportfs_reload()


def handle_update_export(req: dict) -> None:
    path = req.get("path")
    patch = req.get("patch")
    if not path:
        raise ValueError("Missing 'path' field")
    if patch is None:
        raise ValueError("Missing 'patch' field")
    update_export(path, patch)
    _exportfs_reload()


def handle_list_sessions(_req: dict) -> list:
    return list_sessions()


def handle_get_sessions(req: dict) -> list:
    path = req.get("path")
    if not path:
        raise ValueError("Missing 'path' field")
    return get_sessions_for_path(path)


def handle_set_quota(req: dict) -> None:
    quota = req.get("quota")
    if not quota or not isinstance(quota, dict):
        raise ValueError("Missing or invalid 'quota' field")
    path = quota.get("path") or req.get("path")
    if not path:
        raise ValueError("quota.path is required")
    soft_kb = int(quota.get("soft_limit_kb", 0))
    hard_kb = int(quota.get("hard_limit_kb", 0))
    username = quota.get("username")
    if username:
        mountpoint = path
        set_user_quota(mountpoint, username, soft_kb, hard_kb)
    else:
        project_id = int(quota.get("project_id", abs(hash(path)) % 65535 + 1))
        set_project_quota(path, soft_kb, hard_kb, project_id)


def handle_reload(_req: dict) -> None:
    _exportfs_reload()


def handle_fix_nfs_conf(req: dict) -> dict:
    """Update /etc/nfs.conf settings, optionally restart nfs-server.

    Request fields:
      threads:  int | "auto" | null   — sets [nfsd] and [exportd] threads
      rdma:     bool | str | null     — sets [nfsd] rdma
      updates:  {section: {key: value}} — free-form additional updates
      restart:  bool (default true)   — restart nfs-server after writing
    """
    threads = req.get("threads")
    rdma = req.get("rdma")
    free_form = req.get("updates") or {}
    if not isinstance(free_form, dict):
        raise ValueError("'updates' must be an object of {section: {key: value}}")

    updates = build_nfsd_updates(threads, rdma)

    for section, kvs in free_form.items():
        if not isinstance(kvs, dict):
            raise ValueError(f"updates.{section} must be an object")
        for key, value in kvs.items():
            if value is None:
                continue
            updates[(str(section), str(key))] = str(value)

    if not updates:
        raise ValueError("no updates requested (need threads, rdma, or updates)")

    applied = set_nfs_conf(updates)

    changed = any(a["action"] in ("updated", "inserted") for a in applied)
    restart = req.get("restart", True)
    restarted = False
    restart_error = ""
    if restart and changed:
        ok, err = restart_nfs_server()
        restarted = ok
        if not ok:
            restart_error = err

    return {
        "applied": applied,
        "changed": changed,
        "restarted": restarted,
        "restart_error": restart_error,
    }


def _exportfs_reload() -> None:
    """Reload NFS exports via exportfs -r."""
    try:
        result = subprocess.run(
            ["exportfs", "-r"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        stderr = result.stderr.strip()
        if result.returncode != 0:
            # "Failed to stat" warnings are non-fatal (path doesn't exist yet)
            if stderr and "Failed to stat" not in stderr:
                raise RuntimeError(f"exportfs -r failed: {stderr}")
            log.warning("exportfs -r: %s", stderr)
        else:
            log.info("exportfs -r succeeded")
    except FileNotFoundError:
        raise RuntimeError("exportfs not found — is nfs-kernel-server installed?")


# --- Dispatch table ---

HANDLERS = {
    "list_exports": handle_list_exports,
    "add_export": handle_add_export,
    "remove_export": handle_remove_export,
    "update_export": handle_update_export,
    "list_sessions": handle_list_sessions,
    "get_sessions": handle_get_sessions,
    "set_quota": handle_set_quota,
    "reload": handle_reload,
    "fix_nfs_conf": handle_fix_nfs_conf,
}


# --- Request handling ---

def process_request(data: str) -> str:
    """Process one JSON request line and return a JSON response line."""
    try:
        req = json.loads(data)
    except json.JSONDecodeError as e:
        return json.dumps({"ok": False, "error": f"Invalid JSON: {e}", "code": "INVALID_ARGUMENT", "request_id": ""})

    request_id = req.get("request_id", "")
    op = req.get("op")

    if not op:
        return json.dumps({"ok": False, "error": "Missing 'op' field", "code": "INVALID_ARGUMENT", "request_id": request_id})

    handler = HANDLERS.get(op)
    if not handler:
        return json.dumps({"ok": False, "error": f"Unknown op: {op}", "code": "UNSUPPORTED", "request_id": request_id})

    try:
        result = handler(req)
        return json.dumps({"ok": True, "result": result, "request_id": request_id})
    except (KeyError, FileNotFoundError) as e:
        log.warning("NOT_FOUND in op=%s: %s", op, e)
        return json.dumps({"ok": False, "error": str(e), "code": "NOT_FOUND", "request_id": request_id})
    except (ValueError, TypeError) as e:
        log.warning("INVALID_ARGUMENT in op=%s: %s", op, e)
        return json.dumps({"ok": False, "error": str(e), "code": "INVALID_ARGUMENT", "request_id": request_id})
    except Exception as e:
        log.error("INTERNAL error in op=%s: %s", op, e, exc_info=True)
        return json.dumps({"ok": False, "error": str(e), "code": "INTERNAL", "request_id": request_id})


def handle_client(conn: socket.socket) -> None:
    """Handle a single client connection."""
    try:
        buf = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            nl = buf.find(b"\n")
            if nl != -1:
                line = buf[:nl].decode("utf-8", errors="replace")
                response = process_request(line)
                conn.sendall((response + "\n").encode("utf-8"))
                break  # One request per connection
    except Exception as e:
        log.error("Error handling client: %s", e)
    finally:
        conn.close()


# --- Server ---

def run_server() -> None:
    """Start the Unix socket server."""
    # Remove stale socket
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    # Ensure socket directory exists
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o660)
    server.listen(64)

    # Startup health check: warn if NFS server is not operational
    if not os.path.isfile("/usr/sbin/exportfs"):
        log.warning(
            "nfs-kernel-server does not appear to be installed "
            "(missing /usr/sbin/exportfs). Export operations will fail."
        )
    else:
        try:
            result = subprocess.run(
                ["exportfs", "-s"], capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                log.warning("exportfs -s returned non-zero: %s", result.stderr.strip())
            else:
                log.info("exportfs -s OK — NFS server appears functional")
        except Exception as e:
            log.warning("exportfs startup check failed: %s", e)

    log.info("xinas-nfs-helper listening on %s", SOCKET_PATH)

    def shutdown(signum, frame):
        log.info("Shutting down (signal %d)", signum)
        server.close()
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    while True:
        try:
            conn, _ = server.accept()
            t = threading.Thread(target=handle_client, args=(conn,), daemon=True)
            t.start()
        except OSError:
            break


if __name__ == "__main__":
    run_server()
