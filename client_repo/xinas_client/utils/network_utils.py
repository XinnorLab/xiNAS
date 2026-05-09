"""Network interface enumeration utilities for the client TUI."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path


def get_interfaces() -> list[dict]:
    """Enumerate network interfaces via ``/sys/class/net/``.

    Skips the loopback interface (``lo``).

    Returns a list of dicts, each with keys:

    * ``name`` -- interface name (e.g. ``"enp1s0f0"``)
    * ``state`` -- ``"up"`` or ``"down"`` (from ``operstate``)
    * ``speed`` -- link speed in Mb/s as an int, or ``0`` if unavailable
    * ``ip`` -- IPv4 address/prefix (e.g. ``"10.0.0.5/24"``) or ``""``
    * ``driver_badge`` -- one of ``"ETH"``, ``"RDMA"``, ``"IB"``
    """
    net_dir = Path("/sys/class/net")
    interfaces: list[dict] = []

    try:
        iface_dirs = sorted(net_dir.iterdir())
    except OSError:
        return interfaces

    for iface in iface_dirs:
        name = iface.name
        if name == "lo":
            continue

        # operstate
        try:
            state = (iface / "operstate").read_text().strip()
        except OSError:
            state = "unknown"
        if state not in ("up", "down"):
            state = "down"

        # speed (Mb/s)
        try:
            speed = int((iface / "speed").read_text().strip())
            if speed < 0:
                speed = 0
        except (OSError, ValueError):
            speed = 0

        # IPv4 address via ``ip`` command
        ip_addr = ""
        try:
            r = subprocess.run(
                ["ip", "-4", "-o", "addr", "show", name],
                capture_output=True, text=True, timeout=2,
            )
            m = re.search(r"inet\s+(\S+)", r.stdout)
            if m:
                ip_addr = m.group(1)
        except Exception:
            pass

        # Driver badge: ETH / RDMA / IB
        badge = "ETH"
        try:
            driver = (iface / "device" / "driver").resolve().name
            if "mlx" in driver:
                badge = "RDMA"
        except (OSError, ValueError):
            pass
        try:
            itype = (iface / "type").read_text().strip()
            if itype == "32":  # ARPHRD_INFINIBAND
                badge = "IB"
        except OSError:
            pass

        interfaces.append({
            "name": name,
            "state": state,
            "speed": speed,
            "ip": ip_addr,
            "driver_badge": badge,
        })

    return interfaces
