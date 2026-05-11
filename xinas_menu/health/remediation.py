"""RemediationWizard — suggests and optionally applies fixes for health check failures.

Parses health check JSON reports and builds remediation actions from:
1. fix_hint fields embedded in check results (shell commands)
2. A static map of known service-level fixes
3. Targeted helpers for /etc/nfs.conf (threads, rdma) via xinas-nfs-helper

Used by HealthScreen to offer a post-check wizard for fixing issues.
"""
from __future__ import annotations

import json
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class RemediationAction:
    check_name: str
    description: str
    command: list[str] | None = None  # None = manual action only
    # If set, the wizard applies via xinas-nfs-helper instead of subprocess.
    # Keys map directly onto NFSHelperClient.fix_nfs_conf kwargs.
    nfs_conf_fix: dict | None = None
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
    "nmcli", "exportfs", "apt", "dnf", "yum", "blockdev",
)


_NFS_CONF_CHECK_NAMES = ("threads_config", "rdma_enabled")


def _expected_threads(check: dict) -> int | None:
    """Pull the expected thread count out of a threads_config check."""
    expected = check.get("expected", "")
    m = re.search(r"threads\s*=\s*(\d+)", expected)
    return int(m.group(1)) if m else None


def _build_nfs_conf_action(
    failed_checks: list[dict],
    consumed: set[int],
) -> RemediationAction | None:
    """Bundle nfs.conf-related WARN/FAIL checks into a single helper-IPC fix.

    Marks the corresponding indices in *consumed* so the caller skips them
    when generating per-check actions. Returns None when no nfs.conf check
    failed.
    """
    threads_idx: int | None = None
    rdma_idx: int | None = None
    threads_check: dict | None = None
    rdma_check: dict | None = None

    for idx, check in enumerate(failed_checks):
        if check.get("section") != "NFS":
            continue
        name = check.get("name", "")
        if name == "threads_config" and threads_idx is None:
            threads_idx = idx
            threads_check = check
        elif name == "rdma_enabled" and rdma_idx is None:
            rdma_idx = idx
            rdma_check = check

    if threads_check is None and rdma_check is None:
        return None

    fix: dict = {"restart": True}
    descriptions: list[str] = []
    evidence_parts: list[str] = []
    status = "WARN"

    if threads_check is not None:
        threads_val = _expected_threads(threads_check) or "auto"
        fix["threads"] = threads_val
        descriptions.append(f"threads={threads_val}")
        if threads_check.get("actual"):
            evidence_parts.append(f"threads: {threads_check['actual']}")
        if threads_check.get("status") == "FAIL":
            status = "FAIL"
        if threads_idx is not None:
            consumed.add(threads_idx)

    if rdma_check is not None:
        fix["rdma"] = True
        descriptions.append("rdma=y")
        if rdma_check.get("actual"):
            evidence_parts.append(f"rdma: {rdma_check['actual']}")
        if rdma_check.get("status") == "FAIL":
            status = "FAIL"
        if rdma_idx is not None:
            consumed.add(rdma_idx)

    description = (
        "Update /etc/nfs.conf [nfsd]: "
        + ", ".join(descriptions)
        + " (restart nfs-server)"
    )

    return RemediationAction(
        check_name="nfs_conf",
        description=description,
        command=None,
        nfs_conf_fix=fix,
        status=status,
        evidence="; ".join(evidence_parts),
    )


def _apply_nfs_conf_fix(fix: dict) -> tuple[bool, str]:
    """Call xinas-nfs-helper to apply /etc/nfs.conf updates."""
    try:
        from xinas_menu.api.nfs_client import NFSHelperClient
    except Exception as exc:
        return False, f"cannot import nfs client: {exc}"
    client = NFSHelperClient()
    ok, data, err = client.fix_nfs_conf(
        threads=fix.get("threads"),
        rdma=fix.get("rdma"),
        updates=fix.get("updates"),
        restart=fix.get("restart", True),
    )
    if not ok:
        return False, err
    if isinstance(data, dict):
        applied = data.get("applied") or []
        changed = [
            f"[{a.get('section')}] {a.get('key')}={a.get('new')}"
            for a in applied if a.get("action") in ("updated", "inserted")
        ]
        msg_parts: list[str] = []
        if changed:
            msg_parts.append("changed: " + ", ".join(changed))
        else:
            msg_parts.append("no changes needed")
        if data.get("restarted"):
            msg_parts.append("nfs-server restarted")
        elif data.get("restart_error"):
            msg_parts.append(f"restart failed: {data['restart_error']}")
            return False, "; ".join(msg_parts)
        return True, "; ".join(msg_parts)
    return True, ""


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

        Merges fix_hint from JSON with the static _REMEDIATION_MAP, and
        collapses /etc/nfs.conf-related checks into a single helper-IPC
        action (one helper call updates threads + rdma + restarts).
        """
        failed = self.failed_checks()
        consumed: set[int] = set()  # indices of checks consumed by nfs.conf bundle

        result: list[RemediationAction] = []

        nfs_conf_action = _build_nfs_conf_action(failed, consumed)
        if nfs_conf_action is not None:
            result.append(nfs_conf_action)

        for idx, check in enumerate(failed):
            if idx in consumed:
                continue
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
        if action.nfs_conf_fix is not None:
            return _apply_nfs_conf_fix(action.nfs_conf_fix)
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
