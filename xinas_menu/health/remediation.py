"""RemediationWizard — suggests and optionally applies fixes for health check failures.

Parses health check JSON reports and builds remediation actions from:
1. fix_hint fields embedded in check results (shell commands)
2. A static map of known service-level fixes

Used by HealthScreen to offer a post-check wizard for fixing issues.
"""
from __future__ import annotations

import json
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class RemediationAction:
    check_name: str
    description: str
    command: list[str] | None = None  # None = manual action only
    status: str = ""                  # FAIL or WARN
    evidence: str = ""                # current observed value


# Map check names to known remediation actions (service-level fixes)
_REMEDIATION_MAP: dict[str, RemediationAction] = {
    "nfs_service": RemediationAction(
        "nfs_service",
        "Start and enable NFS server",
        ["systemctl", "enable", "--now", "nfs-server"],
    ),
    "xiraid_service": RemediationAction(
        "xiraid_service",
        "Start xiRAID server",
        ["systemctl", "start", "xiraid-server"],
    ),
    "rdma_service": RemediationAction(
        "rdma_service",
        "Load RDMA modules",
        ["modprobe", "ib_core"],
    ),
}


# Allowlisted command prefixes for automated remediation
_SAFE_COMMAND_PREFIXES = (
    "systemctl", "sysctl", "modprobe", "ethtool", "ip",
    "nmcli", "exportfs", "apt", "dnf", "yum",
)


def _parse_fix_hint(hint: str) -> list[str] | None:
    """Try to parse a fix_hint string into a safe shell command list.

    Only commands starting with allowlisted binaries are accepted.
    Returns None if the hint is not a runnable command or is not in the allowlist.
    """
    if not hint:
        return None
    try:
        parts = shlex.split(hint)
    except ValueError:
        return None
    if not parts:
        return None
    # Only allow commands that start with known-safe binaries
    binary = parts[0].split("/")[-1]  # handle absolute paths
    if binary not in _SAFE_COMMAND_PREFIXES:
        return None
    # Reject commands with shell metacharacters
    if any(c in hint for c in (";", "&&", "||", "|", "`", "$(")):
        return None
    return parts


class RemediationWizard:
    """Parse a health check JSON report and suggest remediations for failures."""

    def __init__(self, json_path: str | Path) -> None:
        self._path = Path(json_path)
        self._report: dict = {}

    def load(self) -> None:
        self._report = json.loads(self._path.read_text())

    def failed_checks(self) -> list[dict]:
        checks = self._report.get("checks", [])
        return [c for c in checks if c.get("status") in ("FAIL", "WARN")]

    def actions(self) -> list[RemediationAction]:
        """Build remediation actions for all failed/warned checks.

        Merges fix_hint from JSON with the static _REMEDIATION_MAP.
        """
        result: list[RemediationAction] = []
        for check in self.failed_checks():
            name = check.get("name", "")
            desc = check.get("impact") or name
            hint = check.get("fix_hint", "")
            status = check.get("status", "")
            evidence = check.get("evidence", "")

            # Try static map first
            action = self.remediation_for(name)
            if action:
                action = RemediationAction(
                    check_name=name,
                    description=action.description,
                    command=action.command,
                    status=status,
                    evidence=evidence,
                )
            elif hint:
                cmd = _parse_fix_hint(hint)
                action = RemediationAction(
                    check_name=name,
                    description=desc,
                    command=cmd,
                    status=status,
                    evidence=evidence,
                )
            else:
                action = RemediationAction(
                    check_name=name,
                    description=desc,
                    command=None,
                    status=status,
                    evidence=evidence,
                )
            result.append(action)
        return result

    def remediation_for(self, check_name: str) -> RemediationAction | None:
        for key, action in _REMEDIATION_MAP.items():
            if key in check_name.lower():
                return action
        return None

    def apply(self, action: RemediationAction) -> tuple[bool, str]:
        if not action.command:
            return False, "no automated fix available"
        r = subprocess.run(action.command, capture_output=True, text=True)
        return r.returncode == 0, r.stderr.strip() or r.stdout.strip()

    @staticmethod
    def latest_json_report(log_dir: str = "/var/log/xinas/healthcheck") -> Path | None:
        """Find the most recent JSON health report."""
        d = Path(log_dir)
        if not d.exists():
            return None
        reports = sorted(d.glob("healthcheck_*.json"), reverse=True)
        return reports[0] if reports else None
