"""api_config.py — read/adapt the live xinas-api config for the MCP screen.

The MCP transport was retired as a standalone daemon (S8 T14, ADR-0010);
it now runs inside ``xinas-api.service`` (the ``/mcp`` Streamable HTTP
endpoint + the ``xinas-mcp-stdio`` adapter). Its config is the api
config, ``/etc/xinas-api/config.json`` — schema ``src/api/config.ts``
``ApiConfig`` (env override ``XINAS_API_CONFIG``).

This module gives the TUI MCP Server screen (``xinas_menu/screens/mcp.py``)
a raw read/write that PRESERVES the file's mode + owner — Ansible templates
it ``0640 root:xinas-admin`` and the unprivileged ``xinas-api`` user must
keep read access, so a naive ``0600 root:root`` rewrite would lock the
service out of its own config — plus pure, schema-adapting helpers so the
screen never writes the retired legacy shape (``http_enabled`` /
``tokens: {token: role}`` / ``token_labels`` / ``tls``) and never clobbers
an unrelated key.

See docs/control-path/s8-clients-spec.md §6c for the reconciliation
contract this implements.
"""

from __future__ import annotations

import contextlib
import copy
import json
import os
import stat
import tempfile
from pathlib import Path

API_CONFIG_PATH = Path(os.environ.get("XINAS_API_CONFIG", "/etc/xinas-api/config.json"))

# Principal of the bootstrap admin token the xinas_api role templates and
# mirrors to /etc/xinas-api/admin-token. Protected: shown but not removable
# from the TUI so an operator can't lock themselves out.
BOOTSTRAP_PRINCIPAL = "admin:bootstrap"

# Roles an operator may hand-assign to a token. `local_admin` (UDS peer
# trust) and `internal_agent` (the agent bearer, kept in the separate
# internalTokensPath file) are system-internal and never assigned here.
ASSIGNABLE_ROLES = ("admin", "operator", "viewer")

# Defaults when enabling the MCP HTTP listener (remote clients ⇒ bind all).
DEFAULT_HTTP_HOST = "0.0.0.0"
DEFAULT_HTTP_PORT = 8080


# ── raw read / write (perms-preserving) ─────────────────────────────────────────


def api_config_present() -> bool:
    """True if the api config file exists (False on EACCES, like the screen)."""
    try:
        return API_CONFIG_PATH.exists()
    except OSError:
        return False


def api_cfg_read() -> dict:
    """Read the api config JSON, returning an empty dict on any failure."""
    try:
        return json.loads(API_CONFIG_PATH.read_text())
    except Exception:
        return {}


def api_cfg_write(data: dict) -> None:
    """Atomically write the api config, preserving the file's mode + owner.

    mktemp + rename in the config directory. When the file already exists we
    reuse its mode/uid/gid so the ``xinas-api`` service keeps read access;
    when creating it we fall back to ``0640`` (matching the Ansible template).
    A non-root TUI that cannot ``chown`` still preserves the mode.
    """
    path = API_CONFIG_PATH
    try:
        st = os.stat(path)
        mode = stat.S_IMODE(st.st_mode)
        uid, gid = st.st_uid, st.st_gid
    except FileNotFoundError:
        mode, uid, gid = 0o640, -1, -1

    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.chmod(tmp, mode)
        if uid != -1 or gid != -1:
            # Non-root TUI can't chown; the preserved mode still keeps the
            # file group-readable for the xinas-api service.
            with contextlib.suppress(PermissionError, OSError):
                os.chown(tmp, uid, gid)
        os.replace(tmp, str(path))
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


# ── pure adapters (unit-tested; operate on copies, never mutate input) ──────────


def http_transport_view(cfg: dict) -> dict:
    """Derive the HTTP-listener view from ``mcp.http`` presence.

    Returns ``{"enabled": bool, "host": str | None, "port": int | None}``.
    """
    http = (cfg.get("mcp") or {}).get("http")
    if isinstance(http, dict) and http.get("port") is not None:
        return {"enabled": True, "host": http.get("host"), "port": http.get("port")}
    return {"enabled": False, "host": None, "port": None}


def set_http_transport(
    cfg: dict, host: str = DEFAULT_HTTP_HOST, port: int = DEFAULT_HTTP_PORT
) -> dict:
    """Enable the MCP HTTP listener by setting ``mcp.http = {host, port}``."""
    out = copy.deepcopy(cfg)
    mcp = out.setdefault("mcp", {})
    mcp["http"] = {"host": host, "port": port}
    return out


def disable_http_transport(cfg: dict) -> dict:
    """Remove ``mcp.http``; keep ``mcp.allow_apply``; prune an empty ``mcp``."""
    out = copy.deepcopy(cfg)
    mcp = out.get("mcp")
    if isinstance(mcp, dict):
        mcp.pop("http", None)
        if not mcp:
            out.pop("mcp", None)
    return out


def allow_apply_enabled(cfg: dict) -> bool:
    """Whether ``mcp.allow_apply`` is set (default false — WS12 exit posture)."""
    return bool((cfg.get("mcp") or {}).get("allow_apply", False))


def set_allow_apply(cfg: dict, on: bool) -> dict:
    """Set ``mcp.allow_apply``, preserving any configured ``mcp.http``."""
    out = copy.deepcopy(cfg)
    out.setdefault("mcp", {})["allow_apply"] = bool(on)
    return out


def token_is_protected(principal: str) -> bool:
    """The bootstrap admin token is protected from TUI removal."""
    return principal == BOOTSTRAP_PRINCIPAL


def list_tokens(cfg: dict) -> list[dict]:
    """Rows ``[{token, principal, role, protected}]`` from ``tokens``.

    Internal agent tokens live in the separate ``internalTokensPath`` file
    and so never appear in this map.
    """
    rows: list[dict] = []
    for token, entry in (cfg.get("tokens") or {}).items():
        entry = entry or {}
        principal = entry.get("principal", "")
        rows.append(
            {
                "token": token,
                "principal": principal,
                "role": entry.get("role", ""),
                "protected": token_is_protected(principal),
            }
        )
    return rows


def add_token(cfg: dict, token: str, principal: str, role: str) -> dict:
    """Add ``tokens[token] = {principal, role}`` (the live api shape)."""
    out = copy.deepcopy(cfg)
    out.setdefault("tokens", {})[token] = {"principal": principal, "role": role}
    return out


def remove_token(cfg: dict, token: str) -> dict:
    """Delete ``tokens[token]``; refuse to remove the bootstrap admin token."""
    out = copy.deepcopy(cfg)
    entry = (out.get("tokens") or {}).get(token) or {}
    if token_is_protected(entry.get("principal", "")):
        raise ValueError("refusing to remove the protected bootstrap admin token")
    out.get("tokens", {}).pop(token, None)
    return out


def _mask_token(token: str) -> str:
    """A short, non-reversible display form of a bearer token."""
    if len(token) <= 12:
        return "…"
    return f"{token[:8]}…{token[-4:]}"


def redact_config(cfg: dict) -> dict:
    """Copy of ``cfg`` with token keys masked (principal + role kept).

    For "View MCP Config" so bearer values are not dumped to the panel.
    """
    out = copy.deepcopy(cfg)
    tokens = out.get("tokens")
    if isinstance(tokens, dict):
        out["tokens"] = {_mask_token(tok): entry for tok, entry in tokens.items()}
    return out
