"""RemediationWizard — suggests and optionally applies fixes for health check failures."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class RemediationAction:
    check_name: str
    description: str
    command: list[str] | None = None  # None = manual action only


# Map check names to known remediation actions
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


class RemediationWizard:
    """Parse a health check JSON report and suggest remediations for failures."""

    def __init__(self, json_path: str | Path) -> None:
        self._path = Path(json_path)
        self._report: dict = {}

    def load(self) -> None:
        self._report = json.loads(self._path.read_text())

    def failed_checks(self) -> list[dict]:
        results = self._report.get("results", [])
        return [r for r in results if r.get("status") in ("FAIL", "WARN")]

    def remediation_for(self, check_name: str) -> RemediationAction | None:
        for key, action in _REMEDIATION_MAP.items():
            if key in check_name.lower():
                return action
        return None

    def apply(self, action: RemediationAction) -> tuple[bool, str]:
        if not action.command:
            return False, "no automated fix available"
        import subprocess
        r = subprocess.run(action.command, capture_output=True, text=True)
        return r.returncode == 0, r.stderr.strip() or r.stdout.strip()
