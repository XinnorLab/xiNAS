"""
NFS session info from /proc/net/rpc/nfsd.
Falls back to nfsstat if /proc data is insufficient.
"""

import os
import subprocess


def _parse_nfsd_clients() -> list[dict]:
    """Parse /proc/fs/nfsd/clients/ for active NFS clients."""
    clients = []
    clients_dir = "/proc/fs/nfsd/clients"
    if not os.path.isdir(clients_dir):
        return clients

    for client_id in os.listdir(clients_dir):
        info_path = os.path.join(clients_dir, client_id, "info")
        try:
            info_text = open(info_path).read()
        except OSError:
            continue

        client_info = {}
        for line in info_text.splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                client_info[k.strip()] = v.strip()

        clients.append({
            "client_ip": client_info.get("address", "unknown").split(":")[0],
            "nfs_version": client_info.get("version", "unknown"),
            "export_path": "unknown",  # per-client, not per-export in this file
            "active_locks": 0,
        })

    return clients


def _parse_nfsd_rpc_stats() -> dict:
    """Parse /proc/net/rpc/nfsd for high-level stats."""
    stats = {}
    try:
        text = open("/proc/net/rpc/nfsd").read()
        for line in text.splitlines():
            parts = line.split()
            if not parts:
                continue
            key = parts[0]
            stats[key] = parts[1:]
    except OSError:
        pass
    return stats


def list_sessions() -> list[dict]:
    """Get list of active NFS sessions."""
    sessions = _parse_nfsd_clients()
    if not sessions:
        # Try to get connected clients from /proc/net/rpc/auth.unix.ip
        try:
            text = open("/proc/net/rpc/auth.unix.ip").read()
            for line in text.splitlines():
                if line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 1:
                    sessions.append({
                        "client_ip": parts[0] if parts else "unknown",
                        "nfs_version": "unknown",
                        "export_path": "unknown",
                        "active_locks": 0,
                    })
        except OSError:
            pass
    return sessions


def get_sessions_for_path(export_path: str) -> list[dict]:
    """Filter sessions by export path."""
    all_sessions = list_sessions()
    # Without per-session export tracking, return all sessions as potential users
    return [s for s in all_sessions if s["export_path"] == export_path or s["export_path"] == "unknown"]
