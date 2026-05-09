"""RDMA / InfiniBand detection utilities."""
from __future__ import annotations

from pathlib import Path

_IB_SYSFS = Path("/sys/class/infiniband")


def get_ib_devices() -> list[dict]:
    """Enumerate InfiniBand devices via sysfs.

    Returns a list of dicts::

        [
            {
                "name": "mlx5_0",
                "ports": [
                    {"number": 1, "state": "ACTIVE"},
                    {"number": 2, "state": "DOWN"},
                ],
            },
            ...
        ]
    """
    devices: list[dict] = []
    if not _IB_SYSFS.exists():
        return devices

    try:
        dev_dirs = sorted(_IB_SYSFS.iterdir())
    except OSError:
        return devices

    for dev_dir in dev_dirs:
        if not dev_dir.is_dir():
            continue
        ports_dir = dev_dir / "ports"
        ports: list[dict] = []
        if ports_dir.is_dir():
            try:
                for port_dir in sorted(ports_dir.iterdir()):
                    if not port_dir.is_dir():
                        continue
                    try:
                        port_num = int(port_dir.name)
                    except ValueError:
                        continue
                    state_file = port_dir / "state"
                    try:
                        # File content is like "4: ACTIVE\n"
                        raw = state_file.read_text().strip()
                        state = raw.split(":")[-1].strip() if ":" in raw else raw
                    except OSError:
                        state = "UNKNOWN"
                    ports.append({"number": port_num, "state": state})
            except OSError:
                pass

        devices.append({"name": dev_dir.name, "ports": ports})

    return devices


def has_rdma() -> bool:
    """Return True if at least one InfiniBand device exists."""
    if not _IB_SYSFS.exists():
        return False
    try:
        return any(_IB_SYSFS.iterdir())
    except OSError:
        return False


def check_rdma_available() -> tuple[bool, str]:
    """Check whether RDMA is usable.

    Returns ``(available, description)`` where *description* is a
    human-readable status string suitable for display in the TUI.
    """
    if not _IB_SYSFS.exists():
        return False, "RDMA not available (no /sys/class/infiniband)"

    devices = get_ib_devices()
    if not devices:
        return False, "RDMA module loaded but no devices found"

    active_ports = 0
    for dev in devices:
        for port in dev["ports"]:
            if port["state"] == "ACTIVE":
                active_ports += 1

    names = ", ".join(d["name"] for d in devices)
    if active_ports > 0:
        return True, f"RDMA available: {names} ({active_ports} active port(s))"
    return False, f"RDMA devices present ({names}) but no active ports"
