"""System information collectors for the client TUI."""
from __future__ import annotations

import os
import platform
import socket


def get_hostname() -> str:
    """Return the system hostname."""
    try:
        return socket.gethostname()
    except Exception:
        return "unknown"


def get_kernel() -> str:
    """Return the kernel release string (e.g. '6.8.0-45-generic')."""
    try:
        return platform.release()
    except Exception:
        return "unknown"


def get_uptime() -> str:
    """Return human-readable uptime from ``/proc/uptime``.

    Returns a string like ``"3d 5h 12m"`` or ``"unknown"`` on failure.
    """
    try:
        with open("/proc/uptime") as f:
            total = int(float(f.read().split()[0]))
    except Exception:
        return "unknown"

    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60

    parts: list[str] = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


def get_cpu_usage() -> int:
    """Return overall CPU usage percentage from ``/proc/stat``.

    This is a *cumulative-since-boot* snapshot, not a delta measurement.
    Returns 0 on failure.
    """
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()
        # Fields: user nice system idle iowait irq softirq steal
        vals = [int(v) for v in parts[1:9]]
        idle = vals[3] + vals[4]  # idle + iowait
        total = sum(vals)
        if total == 0:
            return 0
        return max(0, min(100, 100 - int(idle * 100 / total)))
    except Exception:
        return 0


def get_memory_info() -> tuple[int, int, int]:
    """Return ``(used_mb, total_mb, percent)`` from ``/proc/meminfo``.

    Returns ``(0, 0, 0)`` on failure.
    """
    try:
        meminfo: dict[str, int] = {}
        with open("/proc/meminfo") as f:
            for line in f:
                key, _, value = line.partition(":")
                try:
                    meminfo[key.strip()] = int(value.strip().split()[0])
                except (ValueError, IndexError):
                    pass
        total_kb = meminfo.get("MemTotal", 0)
        avail_kb = meminfo.get("MemAvailable", 0)
        used_kb = total_kb - avail_kb
        if total_kb == 0:
            return (0, 0, 0)
        used_mb = used_kb // 1024
        total_mb = total_kb // 1024
        percent = used_kb * 100 // total_kb
        return (used_mb, total_mb, percent)
    except Exception:
        return (0, 0, 0)
