"""NFS-related utilities: mount options, fstab, mount/unmount helpers."""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
from pathlib import Path


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def run_showmount(ip: str) -> tuple[int, str, str]:
    """Run ``showmount -e <ip>`` and return ``(returncode, stdout, stderr)``."""
    try:
        r = subprocess.run(
            ["showmount", "-e", ip],
            capture_output=True, text=True, timeout=10,
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "showmount timed out"
    except FileNotFoundError:
        return 1, "", "showmount command not found (install nfs-common)"
    except Exception as exc:
        return 1, "", str(exc)


def parse_showmount_exports(stdout: str) -> list[tuple[str, str]]:
    """Parse ``showmount -e`` output into ``[(path, clients), ...]``."""
    exports: list[tuple[str, str]] = []
    for line in stdout.strip().splitlines():
        if not line.strip() or line.strip().lower().startswith("export"):
            continue
        parts = line.split(None, 1)
        path = parts[0]
        clients = parts[1].strip() if len(parts) > 1 else ""
        exports.append((path, clients))
    return exports


def has_nfs_tools() -> bool:
    """Return True if mount.nfs4 is available on the system."""
    return shutil.which("mount.nfs4") is not None


def has_rdma() -> bool:
    """Return True if /sys/class/infiniband exists and contains devices."""
    ib = Path("/sys/class/infiniband")
    if not ib.exists():
        return False
    try:
        return any(ib.iterdir())
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Mount option builder
# ---------------------------------------------------------------------------

def _kernel_major() -> int:
    """Return the major kernel version number (e.g. 6 for '6.8.0-...')."""
    try:
        return int(platform.release().split(".")[0])
    except (ValueError, IndexError):
        return 0


def build_mount_opts(
    protocol: str,
    nconnect: int,
    sec_mode: str,
    *,
    num_ips: int = 1,
) -> str:
    """Build the NFS mount option string.

    Parameters
    ----------
    protocol:
        ``"RDMA"`` or ``"TCP"`` (case-insensitive).
    nconnect:
        Per-IP nconnect value (e.g. 16, 8, 4, 2).
    sec_mode:
        Security flavour — ``"sys"``, ``"krb5"``, ``"krb5i"``, ``"krb5p"``.
    num_ips:
        Number of server IPs (used for trunkdiscovery decision).
    """
    proto = "rdma" if protocol.upper() == "RDMA" else "tcp"

    parts: list[str] = [
        "vers=4.2",
        f"proto={proto}",
    ]

    # RDMA uses non-standard NFS port
    if proto == "rdma":
        parts.append("port=20049")

    parts += [
        "hard",
        "max_connect=16",
        f"nconnect={nconnect}",
        "rsize=1048576",
        "wsize=1048576",
        "lookupcache=all",
        "acregmin=60",
        "acregmax=600",
        "acdirmin=60",
        "acdirmax=600",
    ]

    # trunkdiscovery for multi-IP on kernel >= 6
    if num_ips > 1 and _kernel_major() >= 6:
        parts.append("trunkdiscovery")

    parts.append(f"sec={sec_mode}")

    return ",".join(parts)


# ---------------------------------------------------------------------------
# Active mount parsing
# ---------------------------------------------------------------------------

def get_active_nfs_mounts() -> list[dict]:
    """Parse ``mount -t nfs,nfs4`` output.

    Returns a list of dicts with keys:
    ``server``, ``share``, ``mount_point``, ``fstype``, ``options``.
    """
    mounts: list[dict] = []
    try:
        r = subprocess.run(
            ["mount", "-t", "nfs,nfs4"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return mounts

        # Each line: "server:/share on /mount type nfs4 (options)"
        for line in r.stdout.strip().splitlines():
            m = re.match(
                r"^(\S+?):(\S+)\s+on\s+(\S+)\s+type\s+(\S+)\s+\((.+)\)$",
                line,
            )
            if m:
                mounts.append({
                    "server": m.group(1),
                    "share": m.group(2),
                    "mount_point": m.group(3),
                    "fstype": m.group(4),
                    "options": m.group(5),
                })
    except Exception:
        pass
    return mounts


# ---------------------------------------------------------------------------
# fstab helpers
# ---------------------------------------------------------------------------

def get_fstab_nfs_entries() -> list[dict]:
    """Parse ``/etc/fstab`` for nfs/nfs4 entries.

    Returns a list of dicts with keys:
    ``server_share``, ``mount_point``, ``fstype``, ``options``.
    """
    entries: list[dict] = []
    try:
        with open("/etc/fstab") as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                parts = stripped.split()
                if len(parts) >= 4 and parts[2] in ("nfs", "nfs4"):
                    entries.append({
                        "server_share": parts[0],
                        "mount_point": parts[1],
                        "fstype": parts[2],
                        "options": parts[3],
                    })
    except OSError:
        pass
    return entries


def add_fstab_entry(
    server_ip: str,
    share: str,
    mount_point: str,
    opts: str,
) -> None:
    """Append an NFS entry to ``/etc/fstab``."""
    entry = f"{server_ip}:{share} {mount_point} nfs {opts} 0 0\n"
    with open("/etc/fstab", "a") as fh:
        fh.write(entry)


def remove_fstab_entries(mount_point: str) -> None:
    """Remove all fstab lines whose mount point matches *mount_point*."""
    fstab = Path("/etc/fstab")
    try:
        lines = fstab.read_text().splitlines(keepends=True)
    except OSError:
        return

    kept: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            kept.append(line)
            continue
        parts = stripped.split()
        if len(parts) >= 2 and parts[1] == mount_point:
            continue  # drop this entry
        kept.append(line)

    fstab.write_text("".join(kept))


# ---------------------------------------------------------------------------
# Mount / unmount
# ---------------------------------------------------------------------------

def mount_nfs(
    server_ip: str,
    share: str,
    mount_point: str,
    opts: str,
) -> tuple[bool, str]:
    """Run ``mount -t nfs`` and return ``(success, stderr)``."""
    try:
        r = subprocess.run(
            ["mount", "-t", "nfs", "-o", opts,
             f"{server_ip}:{share}", mount_point],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode == 0, r.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "mount command timed out after 30 s"
    except Exception as exc:
        return False, str(exc)


def unmount(mount_point: str) -> tuple[bool, str]:
    """Run ``umount`` and return ``(success, stderr)``."""
    try:
        r = subprocess.run(
            ["umount", mount_point],
            capture_output=True, text=True, timeout=15,
        )
        return r.returncode == 0, r.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "umount timed out after 15 s"
    except Exception as exc:
        return False, str(exc)
