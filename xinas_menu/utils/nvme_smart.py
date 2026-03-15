"""NVMe SMART data helpers — async wrappers around nvme-cli."""
from __future__ import annotations

import asyncio
import json
import logging
import re

_log = logging.getLogger(__name__)

_DEVICE_RE = re.compile(r"^[a-zA-Z0-9]+$")


async def _run_smart_log(device: str) -> dict:
    """Run ``nvme smart-log /dev/{device} -o json`` and return parsed JSON.

    Returns dict with at minimum ``ok`` (bool) and ``error`` (str) keys.
    On success the full nvme-cli JSON is merged in.
    """
    if not _DEVICE_RE.match(device):
        return {"ok": False, "error": f"Invalid device name: {device}"}

    try:
        proc = await asyncio.create_subprocess_exec(
            "nvme", "smart-log", f"/dev/{device}", "-o", "json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
    except FileNotFoundError:
        return {"ok": False, "error": "nvme-cli is not installed"}
    except asyncio.TimeoutError:
        return {"ok": False, "error": "nvme smart-log timed out"}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}

    if proc.returncode != 0:
        err_text = stderr.decode(errors="replace").strip() if stderr else "unknown error"
        return {"ok": False, "error": f"nvme smart-log failed: {err_text}"}

    try:
        data = json.loads(stdout.decode(errors="replace"))
    except (json.JSONDecodeError, ValueError) as exc:
        return {"ok": False, "error": f"Failed to parse SMART JSON: {exc}"}

    data["ok"] = True
    data["error"] = ""
    return data


async def smart_summary(device: str) -> dict:
    """Return a concise SMART summary for an NVMe device.

    Keys: ``temperature`` (int, °C), ``wear_level`` (int, %),
    ``critical_warning`` (int), ``ok`` (bool), ``error`` (str).
    """
    raw = await _run_smart_log(device)
    if not raw.get("ok"):
        return raw

    # Temperature — nvme-cli may report Kelvin (> 200) or Celsius
    temp = raw.get("temperature", 0)
    if isinstance(temp, (int, float)) and temp > 200:
        temp = int(temp) - 273
    else:
        temp = int(temp) if isinstance(temp, (int, float)) else 0

    wear = raw.get("percent_used", 0)
    if not isinstance(wear, (int, float)):
        wear = 0

    crit = raw.get("critical_warning", 0)
    if not isinstance(crit, int):
        crit = 0

    return {
        "ok": True,
        "error": "",
        "temperature": temp,
        "wear_level": int(wear),
        "critical_warning": crit,
    }


async def smart_full(device: str) -> dict:
    """Return the full SMART log for an NVMe device.

    Returns the complete nvme-cli JSON dict with ``ok`` and ``error`` keys added.
    """
    return await _run_smart_log(device)
