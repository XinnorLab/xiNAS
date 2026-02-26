"""
XFS project quota management via xfs_quota.
The daemon is allowed to call xfs_quota — the CLI prohibition applies
only to the MCP server itself.
"""

import subprocess
import os


def _find_mountpoint(path: str) -> str:
    """Find the filesystem mountpoint for a given path."""
    # Walk up until we find a different device
    path = os.path.realpath(path)
    prev_dev = os.stat(path).st_dev
    current = path
    while True:
        parent = os.path.dirname(current)
        if parent == current:
            return current
        if os.stat(parent).st_dev != prev_dev:
            return current
        current = parent


def set_project_quota(path: str, soft_kb: int, hard_kb: int, project_id: int) -> None:
    """Set XFS project quota for a given path."""
    mountpoint = _find_mountpoint(path)

    # Set up project mapping in /etc/projects and /etc/projid
    _setup_project_files(path, project_id)

    # Initialize the project
    subprocess.run(
        ["xfs_quota", "-x", "-c", f"project -s {project_id}", mountpoint],
        check=True,
        capture_output=True,
        text=True,
    )

    # Apply limits
    limit_cmd = f"limit -p bsoft={soft_kb}k bhard={hard_kb}k {project_id}"
    subprocess.run(
        ["xfs_quota", "-x", "-c", limit_cmd, mountpoint],
        check=True,
        capture_output=True,
        text=True,
    )


def _setup_project_files(path: str, project_id: int) -> None:
    """Ensure /etc/projects and /etc/projid contain entries for this project."""
    projects_path = "/etc/projects"
    projid_path = "/etc/projid"
    project_name = f"xinas_quota_{project_id}"

    # Update /etc/projects
    _upsert_line(projects_path, f":{project_id}:", f"{project_id}:{path}")

    # Update /etc/projid
    _upsert_line(projid_path, f":{project_id}\n", f"{project_name}:{project_id}")


def _upsert_line(filepath: str, match_str: str, new_line: str) -> None:
    """Add or replace a line containing match_str in filepath."""
    try:
        with open(filepath) as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []

    # Remove existing matching line
    lines = [l for l in lines if match_str not in l]
    lines.append(new_line + "\n")

    with open(filepath, "w") as f:
        f.writelines(lines)
