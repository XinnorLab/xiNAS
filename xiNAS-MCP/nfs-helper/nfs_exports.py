"""
/etc/exports reader/writer.
Parses and serializes the exports file format:
  /path  client1(opts) client2(opts) ...
"""

import fcntl
import os
import re

EXPORTS_PATH = "/etc/exports"
LOCK_PATH = "/run/xinas-exports.lock"


def _parse_exports(text: str) -> list[dict]:
    """Parse /etc/exports into a list of ExportEntry dicts."""
    entries = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Split path from client specs
        # Path may be quoted: "/path with spaces" or unquoted
        if line.startswith('"'):
            end = line.index('"', 1)
            path = line[1:end]
            rest = line[end + 1:].strip()
        else:
            parts = line.split(None, 1)
            path = parts[0]
            rest = parts[1] if len(parts) > 1 else ""

        clients = []
        # Parse: host(opt1,opt2) host2(opt3)
        for match in re.finditer(r'(\S+?)(?:\(([^)]*)\))?(?:\s|$)', rest):
            host = match.group(1)
            opts_str = match.group(2) or ""
            if not host:
                continue
            opts = [o.strip() for o in opts_str.split(",") if o.strip()]
            clients.append({"host": host, "options": opts})

        if clients:
            entries.append({"path": path, "clients": clients})

    return entries


def _serialize_exports(entries: list[dict]) -> str:
    """Serialize export entries back to /etc/exports format."""
    lines = ["# Managed by xinas-nfs-helper — do not edit manually", ""]
    for entry in entries:
        path = entry["path"]
        client_strs = []
        for client in entry["clients"]:
            host = client["host"]
            opts = client.get("options", [])
            if opts:
                client_strs.append(f'{host}({",".join(opts)})')
            else:
                client_strs.append(host)
        lines.append(f'{path}  {" ".join(client_strs)}')
    return "\n".join(lines) + "\n"


def _with_lock(fn):
    """Execute fn while holding an exclusive lock on LOCK_PATH."""
    with open(LOCK_PATH, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def list_exports() -> list[dict]:
    """Read and parse /etc/exports."""
    def _read():
        try:
            text = open(EXPORTS_PATH).read()
        except FileNotFoundError:
            return []
        return _parse_exports(text)

    return _with_lock(_read)


def add_export(entry: dict) -> None:
    """Add or replace an export entry. Idempotent."""
    def _update():
        try:
            text = open(EXPORTS_PATH).read()
        except FileNotFoundError:
            text = ""
        entries = _parse_exports(text)
        # Remove existing entry with same path
        entries = [e for e in entries if e["path"] != entry["path"]]
        entries.append(entry)
        with open(EXPORTS_PATH, "w") as f:
            f.write(_serialize_exports(entries))

    _with_lock(_update)


def remove_export(path: str) -> None:
    """Remove an export entry by path."""
    def _update():
        try:
            text = open(EXPORTS_PATH).read()
        except FileNotFoundError:
            raise FileNotFoundError(f"Export not found: {path}")
        entries = _parse_exports(text)
        new_entries = [e for e in entries if e["path"] != path]
        if len(new_entries) == len(entries):
            raise KeyError(f"Export not found: {path}")
        with open(EXPORTS_PATH, "w") as f:
            f.write(_serialize_exports(new_entries))

    _with_lock(_update)


def update_export(path: str, patch: dict) -> None:
    """Merge-patch an existing export entry."""
    def _update():
        try:
            text = open(EXPORTS_PATH).read()
        except FileNotFoundError:
            raise FileNotFoundError(f"Export not found: {path}")
        entries = _parse_exports(text)
        found = False
        for entry in entries:
            if entry["path"] == path:
                entry.update(patch)
                found = True
                break
        if not found:
            raise KeyError(f"Export not found: {path}")
        with open(EXPORTS_PATH, "w") as f:
            f.write(_serialize_exports(entries))

    _with_lock(_update)
