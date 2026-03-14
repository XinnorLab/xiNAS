"""config.py — shared config read/write for /etc/xinas-mcp/config.json."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

CONFIG_PATH = Path("/etc/xinas-mcp/config.json")


def cfg_read() -> dict:
    """Read config JSON, returning empty dict on failure."""
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception:
        return {}


def cfg_write(data: dict) -> None:
    """Atomic write of config JSON (mktemp + rename, mode 0600)."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(CONFIG_PATH.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, str(CONFIG_PATH))
    except Exception:
        os.unlink(tmp)
        raise
