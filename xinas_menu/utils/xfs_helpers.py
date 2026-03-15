"""XFS filesystem helpers — async wrappers for mkfs.xfs, mount units, and geometry calculations.

Replicates the XFS optimization parameters from the Ansible raid_fs role
(collection/roles/raid_fs/tasks/create_fs.yml) including stripe alignment,
external log device, and high-performance mount options.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile

_log = logging.getLogger(__name__)

_DEVICE_RE = re.compile(r"^/dev/[a-zA-Z0-9_]+$")

# ── Async subprocess wrapper ─────────────────────────────────────────────


async def run_async_cmd(
    *args: str, timeout: int = 120
) -> tuple[bool, str, str]:
    """Run a command asynchronously and return (ok, stdout, stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        out = stdout.decode(errors="replace").strip() if stdout else ""
        err = stderr.decode(errors="replace").strip() if stderr else ""
        return (proc.returncode == 0, out, err)
    except FileNotFoundError:
        return (False, "", f"Command not found: {args[0]}")
    except asyncio.TimeoutError:
        return (False, "", f"Command timed out after {timeout}s: {' '.join(args)}")
    except OSError as exc:
        return (False, "", str(exc))


# ── RAID geometry calculations ────────────────────────────────────────────


_PARITY_MAP = {
    "0": 0,
    "1": 1,
    "5": 1,
    "6": 2,
    "10": 0,
    "50": 1,
    "60": 2,
}


def calculate_parity_disks(raid_level: str) -> int:
    """Return the number of parity/mirror disks for a RAID level."""
    return _PARITY_MAP.get(str(raid_level), 0)


def calculate_stripe_width(device_count: int, raid_level: str) -> int:
    """Calculate XFS stripe width (sw) from device count and RAID level.

    For RAID-10: sw = device_count // 2 (each mirror pair = 1 stripe unit).
    For others:  sw = device_count - parity_disks.
    Always returns at least 1.
    """
    level = str(raid_level)
    if level == "10":
        return max(1, device_count // 2)
    return max(1, device_count - calculate_parity_disks(level))


# ── Mount options ─────────────────────────────────────────────────────────


def build_mount_options(log_device: str) -> str:
    """Build the XFS mount options string matching the Ansible raid_fs role.

    Includes: logdev, noatime, nodiratime, logbsize=256k, largeio, inode64,
    swalloc, allocsize=131072k, uquota.
    """
    return (
        f"logdev={log_device},"
        "noatime,nodiratime,"
        "logbsize=256k,"
        "largeio,"
        "inode64,"
        "swalloc,"
        "allocsize=131072k,"
        "uquota"
    )


# ── Device queries ────────────────────────────────────────────────────────


async def get_device_size_bytes(device: str) -> tuple[bool, int, str]:
    """Get device size in bytes via ``blockdev --getsize64``.

    Returns (ok, size_bytes, error).
    """
    ok, out, err = await run_async_cmd("blockdev", "--getsize64", device, timeout=10)
    if not ok:
        return (False, 0, err)
    try:
        return (True, int(out), "")
    except ValueError:
        return (False, 0, f"Invalid size output: {out}")


async def check_existing_filesystem(device: str) -> tuple[str | None, str | None]:
    """Check if a device already has a filesystem via ``blkid``.

    Returns (fs_type, label) or (None, None) if no filesystem found.
    """
    ok_type, fs_type, _ = await run_async_cmd(
        "blkid", "-s", "TYPE", "-o", "value", device, timeout=10
    )
    ok_label, label, _ = await run_async_cmd(
        "blkid", "-s", "LABEL", "-o", "value", device, timeout=10
    )
    return (
        fs_type if ok_type and fs_type else None,
        label if ok_label and label else None,
    )


# ── XFS creation ──────────────────────────────────────────────────────────


def _parse_size_to_bytes(size_str: str) -> int:
    """Parse a human-readable size string (e.g., '1G', '500M') to bytes."""
    size_str = size_str.strip().upper()
    multipliers = {"B": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}
    for suffix, mult in multipliers.items():
        if size_str.endswith(suffix):
            try:
                return int(float(size_str[:-1]) * mult)
            except ValueError:
                break
    # Try raw integer (bytes)
    try:
        return int(size_str)
    except ValueError:
        return 1024**3  # Default 1G


async def mkfs_xfs(
    label: str,
    data_device: str,
    log_device: str,
    su_kb: int,
    sw: int,
    sector_size: str = "4k",
    log_size: str = "1G",
) -> tuple[bool, str, str]:
    """Create an XFS filesystem with optimized parameters.

    Matches the Ansible raid_fs role ``create_fs.yml`` mkfs.xfs command:
    ``mkfs.xfs -f -L {label} -d su={su_kb}k,sw={sw}
               -l logdev={log_device},size={eff_log_size}
               -s size={sector_size} {data_device}``

    Log size is capped to the actual log device capacity.
    """
    # Cap log size to device capacity (matching create_fs.yml lines 69-82)
    requested_bytes = _parse_size_to_bytes(log_size)
    ok, dev_bytes, err = await get_device_size_bytes(log_device)
    if ok and dev_bytes > 0:
        effective_log_size = str(min(requested_bytes, dev_bytes))
    else:
        effective_log_size = log_size

    return await run_async_cmd(
        "mkfs.xfs", "-f",
        "-L", label,
        "-d", f"su={su_kb}k,sw={sw}",
        "-l", f"logdev={log_device},size={effective_log_size}",
        "-s", f"size={sector_size}",
        data_device,
        timeout=300,
    )


# ── Systemd mount unit ───────────────────────────────────────────────────


def _path_to_unit_name(path: str) -> str:
    """Convert a path to a systemd unit name fragment.

    Strips leading '/', replaces '/' with '-'.
    E.g., '/dev/xi_data' → 'dev-xi_data'
    """
    return path.lstrip("/").replace("/", "-")


def generate_mount_unit(
    mountpoint: str,
    data_device: str,
    log_device: str,
    mount_opts: str,
) -> str:
    """Generate systemd .mount unit text matching the Ansible template.

    Replicates: collection/roles/raid_fs/templates/mount.unit.j2
    """
    block_unit = _path_to_unit_name(data_device) + ".device"
    log_unit = _path_to_unit_name(log_device) + ".device"
    unit_opts = f"defaults,{mount_opts}" if mount_opts else "defaults"
    description = mountpoint.rstrip("/").rsplit("/", 1)[-1] or "root"

    return (
        f"[Unit]\n"
        f"Description=xiRAID Classic {description}\n"
        f"Requires={block_unit} {log_unit}\n"
        f"After={block_unit} {log_unit}\n"
        f"Before=umount.target\n"
        f"Conflicts=umount.target\n"
        f"\n"
        f"[Mount]\n"
        f"What={data_device}\n"
        f"Where={mountpoint}\n"
        f"Options={unit_opts}\n"
        f"Type=xfs\n"
        f"\n"
        f"[Install]\n"
        f"WantedBy=local-fs.target\n"
    )


async def create_mount_unit(
    mountpoint: str,
    data_device: str,
    log_device: str,
    mount_opts: str,
) -> tuple[bool, str]:
    """Write a systemd mount unit and create the mountpoint directory.

    Returns (ok, error_message).
    """
    unit_name = _path_to_unit_name(mountpoint) + ".mount"
    unit_path = f"/etc/systemd/system/{unit_name}"
    unit_content = generate_mount_unit(mountpoint, data_device, log_device, mount_opts)

    # Create mountpoint directory
    ok, _, err = await run_async_cmd("mkdir", "-p", mountpoint, timeout=10)
    if not ok:
        return (False, f"Failed to create mountpoint: {err}")

    # Write unit file atomically
    try:
        fd, tmp = tempfile.mkstemp(
            dir="/etc/systemd/system", prefix=".xinas_mount_", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w") as f:
                f.write(unit_content)
            os.chmod(tmp, 0o644)
            os.replace(tmp, unit_path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception as exc:
        return (False, f"Failed to write mount unit: {exc}")

    return (True, "")


async def mount_filesystem(mountpoint: str) -> tuple[bool, str]:
    """Reload systemd and enable+start the mount unit.

    Returns (ok, error_message).
    """
    unit_name = _path_to_unit_name(mountpoint) + ".mount"

    ok, _, err = await run_async_cmd("systemctl", "daemon-reload", timeout=30)
    if not ok:
        return (False, f"systemctl daemon-reload failed: {err}")

    ok, _, err = await run_async_cmd(
        "systemctl", "enable", "--now", unit_name, timeout=60
    )
    if not ok:
        return (False, f"Failed to enable mount: {err}")

    return (True, "")
