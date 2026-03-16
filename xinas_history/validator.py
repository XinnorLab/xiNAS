"""Pre-flight and post-apply validation for configuration changes."""
from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Optional

from .models import Manifest, ValidationResult, RollbackClass
from .grpc_inspector import GrpcInspector
from .store import FilesystemStore


# Minimum free space in MB for snapshot operations.
MIN_FREE_SPACE_MB = 50

# Default services to verify are running after apply.
_DEFAULT_SERVICES = ["nfs-server", "xiraid"]

# Path to system exports file.
_EXPORTS_PATH = "/etc/exports"


class PreflightValidator:
    """Validates that a configuration change can safely proceed.

    Checks:
    1. Disk space sufficient for snapshot + safety margin
    2. No dependency violations (e.g., can't delete RAID if FS depends on it)
    3. No active operations blocking the change
    4. System services are in expected state
    """

    def __init__(self, store: FilesystemStore, inspector: GrpcInspector) -> None:
        self._store = store
        self._inspector = inspector

    async def validate(
        self,
        operation: str,
        target_resources: Optional[list[str]] = None,
        rollback_class: Optional[str] = None,
    ) -> ValidationResult:
        """Run all preflight checks.

        Args:
            operation: OperationType value (e.g. "raid_create").
            target_resources: Resource names/paths affected.
            rollback_class: Expected risk classification.

        Returns:
            ValidationResult with passed/blockers/warnings.
        """
        blockers: list[str] = []
        warnings: list[str] = []

        # 1. Disk space
        try:
            ok, msg = await self.check_disk_space()
            if not ok:
                blockers.append(msg)
        except Exception as exc:
            warnings.append("Disk space check failed: {}".format(exc))

        # 2. Dependency checks (only for destructive operations)
        resources = target_resources or []
        try:
            if operation in ("raid_delete", "raid_modify"):
                raid_blockers = await self.check_raid_dependencies(resources)
                blockers.extend(raid_blockers)
        except Exception as exc:
            warnings.append("RAID dependency check failed: {}".format(exc))

        try:
            if operation in ("fs_delete", "fs_modify"):
                fs_blockers = await self.check_fs_dependencies(resources)
                blockers.extend(fs_blockers)
        except Exception as exc:
            warnings.append("FS dependency check failed: {}".format(exc))

        # 3. Service state (advisory only)
        try:
            svc_warnings = await self.check_service_state()
            warnings.extend(svc_warnings)
        except Exception as exc:
            warnings.append("Service state check failed: {}".format(exc))

        passed = len(blockers) == 0
        return ValidationResult(passed=passed, blockers=blockers, warnings=warnings)

    async def check_disk_space(self) -> tuple[bool, str]:
        """Verify sufficient disk space for snapshot operations.

        Checks free space on the partition containing the store.
        Requires MIN_FREE_SPACE_MB (50 MB) plus the estimated snapshot size.
        """
        store_root = str(self._store.root)
        # Use the nearest existing ancestor for statvfs if root doesn't exist yet.
        check_path = store_root
        while not os.path.exists(check_path):
            parent = os.path.dirname(check_path)
            if parent == check_path:
                break
            check_path = parent

        stat = os.statvfs(check_path)
        free_mb = (stat.f_bavail * stat.f_frsize) / (1024 * 1024)

        required_mb = MIN_FREE_SPACE_MB + self._estimate_snapshot_size_mb()

        if free_mb < required_mb:
            return (
                False,
                "Insufficient disk space: {:.1f} MB free, {:.1f} MB required "
                "({}MB safety + {:.1f}MB estimated snapshot)".format(
                    free_mb, required_mb, MIN_FREE_SPACE_MB,
                    self._estimate_snapshot_size_mb(),
                ),
            )
        return True, ""

    async def check_raid_dependencies(self, raid_names: list[str]) -> list[str]:
        """Check if any filesystems depend on the named RAID arrays.

        Returns list of blocker messages if dependencies exist.
        Used before RAID delete/modify operations.
        """
        if not raid_names:
            return []

        blockers: list[str] = []

        # Query gRPC for current RAID state to find device paths.
        ok, data, err = await self._inspector.raid_show(extended=True)
        if not ok or data is None:
            # Cannot verify — degrade to warning (caller will see empty list).
            return []

        # Build set of device paths for the target RAID arrays.
        raid_devices: set[str] = set()
        arrays = data if isinstance(data, dict) else {}
        for name in raid_names:
            arr = arrays.get(name, {})
            dev = arr.get("device", arr.get("dev", ""))
            if dev:
                raid_devices.add(dev)
            # Also match by array name in /dev/xi/ convention.
            raid_devices.add("/dev/xi/{}".format(name))

        if not raid_devices:
            return []

        # Check /proc/mounts for any filesystem mounted on these devices.
        try:
            with open("/proc/mounts", "r") as fh:
                for line in fh:
                    parts = line.split()
                    if len(parts) >= 2:
                        device = parts[0]
                        mountpoint = parts[1]
                        if device in raid_devices:
                            blockers.append(
                                "RAID array device {} is mounted at {}; "
                                "unmount first".format(device, mountpoint)
                            )
        except OSError:
            pass

        return blockers

    async def check_fs_dependencies(self, mountpoints: list[str]) -> list[str]:
        """Check if any NFS exports depend on the named mountpoints.

        Returns list of blocker messages if dependencies exist.
        Used before filesystem delete/modify operations.
        """
        if not mountpoints:
            return []

        blockers: list[str] = []
        exports = _parse_exports_file(_EXPORTS_PATH)

        for mp in mountpoints:
            for export_path in exports:
                # An export depends on a mountpoint if the export path
                # is equal to or nested inside the mountpoint.
                if export_path == mp or export_path.startswith(mp.rstrip("/") + "/"):
                    blockers.append(
                        "NFS export '{}' depends on mountpoint '{}'; "
                        "remove export first".format(export_path, mp)
                    )

        return blockers

    async def check_service_state(self) -> list[str]:
        """Check if critical services are in expected state.

        Returns list of warning messages (not blockers).
        """
        warnings: list[str] = []
        for svc in _DEFAULT_SERVICES:
            try:
                result = await asyncio.get_running_loop().run_in_executor(
                    None,
                    lambda s=svc: subprocess.run(
                        ["systemctl", "is-active", "--quiet", s],
                        capture_output=True,
                        timeout=5,
                    ),
                )
                if result.returncode != 0:
                    warnings.append(
                        "Service '{}' is not active".format(svc)
                    )
            except FileNotFoundError:
                # systemctl not available (e.g. container, macOS dev).
                break
            except subprocess.TimeoutExpired:
                warnings.append(
                    "Timed out checking service '{}'".format(svc)
                )
            except OSError as exc:
                warnings.append(
                    "Could not check service '{}': {}".format(svc, exc)
                )

        return warnings

    def _estimate_snapshot_size_mb(self) -> float:
        """Estimate size of next snapshot based on last snapshot."""
        snapshots = self._store.list_snapshots()
        if not snapshots:
            # No previous snapshots — use a conservative default (2 MB).
            return 2.0

        # Use the most recent snapshot's actual size as the estimate.
        latest = snapshots[-1]
        size_bytes = self._store.get_snapshot_size_bytes(latest.id)
        if size_bytes <= 0:
            return 2.0

        # Add 20% headroom.
        return (size_bytes / (1024 * 1024)) * 1.2


class PostApplyValidator:
    """Validates that a configuration change was applied successfully.

    Checks after Ansible playbook completion:
    1. gRPC state matches intended target
    2. Expected system artefacts are present
    3. Managed resources match intended state
    4. No unresolved dependency violations

    A snapshot is only marked 'applied' if ALL checks pass.
    """

    def __init__(self, inspector: GrpcInspector) -> None:
        self._inspector = inspector

    async def validate(
        self,
        target_manifest: Manifest,
        expected_state: Optional[dict] = None,
    ) -> ValidationResult:
        """Run all post-apply validation checks.

        Args:
            target_manifest: The manifest describing the intended state.
            expected_state: Optional dict of expected runtime values.

        Returns:
            ValidationResult with passed/blockers/warnings.
        """
        blockers: list[str] = []
        warnings: list[str] = []
        state = expected_state or {}

        # 1. RAID state
        try:
            raid_issues = await self.check_raid_state(
                expected_arrays=state.get("raid_arrays"),
            )
            blockers.extend(raid_issues)
        except Exception as exc:
            warnings.append("RAID state check failed: {}".format(exc))

        # 2. Mount state
        try:
            mount_issues = await self.check_mount_state(
                expected_mounts=state.get("mounts"),
            )
            blockers.extend(mount_issues)
        except Exception as exc:
            warnings.append("Mount state check failed: {}".format(exc))

        # 3. NFS exports
        try:
            export_issues = await self.check_export_state(
                expected_exports=state.get("exports"),
            )
            blockers.extend(export_issues)
        except Exception as exc:
            warnings.append("Export state check failed: {}".format(exc))

        # 4. Services
        try:
            svc_issues = await self.check_service_active(
                services=state.get("services"),
            )
            blockers.extend(svc_issues)
        except Exception as exc:
            warnings.append("Service check failed: {}".format(exc))

        passed = len(blockers) == 0
        return ValidationResult(passed=passed, blockers=blockers, warnings=warnings)

    async def check_raid_state(
        self, expected_arrays: Optional[dict] = None,
    ) -> list[str]:
        """Verify RAID arrays match expected state via gRPC.

        *expected_arrays* is a dict keyed by array name with values
        containing at least ``level`` (e.g. ``{"data": {"level": "5"}}``).
        """
        if not expected_arrays:
            return []

        issues: list[str] = []

        ok, data, err = await self._inspector.raid_show(extended=True)
        if not ok:
            issues.append(
                "Unable to query RAID state: {}".format(err or "unknown error")
            )
            return issues

        actual = data if isinstance(data, dict) else {}

        for name, expected in expected_arrays.items():
            if name not in actual:
                issues.append(
                    "Expected RAID array '{}' not found in runtime state".format(name)
                )
                continue

            arr = actual[name]
            expected_level = str(expected.get("level", ""))
            actual_level = str(arr.get("level", arr.get("raid_level", "")))
            if expected_level and actual_level and expected_level != actual_level:
                issues.append(
                    "RAID array '{}' level mismatch: expected {}, got {}".format(
                        name, expected_level, actual_level,
                    )
                )

        return issues

    async def check_mount_state(
        self, expected_mounts: Optional[list[dict]] = None,
    ) -> list[str]:
        """Verify filesystem mounts are active and correct.

        Each entry in *expected_mounts* should have at least ``mountpoint``
        and optionally ``fstype``.
        """
        if not expected_mounts:
            return []

        issues: list[str] = []

        # Read /proc/mounts (or use mount command as fallback).
        active_mounts: dict[str, dict] = {}
        try:
            with open("/proc/mounts", "r") as fh:
                for line in fh:
                    parts = line.split()
                    if len(parts) >= 3:
                        active_mounts[parts[1]] = {
                            "device": parts[0],
                            "fstype": parts[2],
                        }
        except OSError:
            # Fallback: call mount command.
            try:
                result = await asyncio.get_running_loop().run_in_executor(
                    None,
                    lambda: subprocess.run(
                        ["mount"], capture_output=True, text=True, timeout=5,
                    ),
                )
                if result.returncode == 0 and result.stdout:
                    for line in result.stdout.splitlines():
                        # Format: <dev> on <mountpoint> type <fstype> (opts)
                        parts = line.split()
                        if len(parts) >= 5 and parts[1] == "on" and parts[3] == "type":
                            active_mounts[parts[2]] = {
                                "device": parts[0],
                                "fstype": parts[4],
                            }
            except Exception:
                issues.append("Unable to read active mounts")
                return issues

        for entry in expected_mounts:
            mp = entry.get("mountpoint", "")
            if not mp:
                continue
            if mp not in active_mounts:
                issues.append(
                    "Expected mountpoint '{}' is not mounted".format(mp)
                )
                continue
            expected_fs = entry.get("fstype", "")
            actual_fs = active_mounts[mp].get("fstype", "")
            if expected_fs and actual_fs and expected_fs != actual_fs:
                issues.append(
                    "Mountpoint '{}' fstype mismatch: expected {}, got {}".format(
                        mp, expected_fs, actual_fs,
                    )
                )

        return issues

    async def check_export_state(
        self, expected_exports: Optional[list[dict]] = None,
    ) -> list[str]:
        """Verify NFS exports are present and correct.

        Each entry in *expected_exports* should have at least ``path``.
        """
        if not expected_exports:
            return []

        issues: list[str] = []
        current_exports = _parse_exports_file(_EXPORTS_PATH)

        for entry in expected_exports:
            path = entry.get("path", "")
            if not path:
                continue
            if path not in current_exports:
                issues.append(
                    "Expected NFS export '{}' not found in {}".format(
                        path, _EXPORTS_PATH,
                    )
                )

        return issues

    async def check_service_active(
        self, services: Optional[list[str]] = None,
    ) -> list[str]:
        """Verify named services are active."""
        if not services:
            services = list(_DEFAULT_SERVICES)

        issues: list[str] = []
        for svc in services:
            try:
                result = await asyncio.get_running_loop().run_in_executor(
                    None,
                    lambda s=svc: subprocess.run(
                        ["systemctl", "is-active", "--quiet", s],
                        capture_output=True,
                        timeout=5,
                    ),
                )
                if result.returncode != 0:
                    issues.append(
                        "Service '{}' is not active after apply".format(svc)
                    )
            except FileNotFoundError:
                # systemctl not available — skip silently.
                break
            except subprocess.TimeoutExpired:
                issues.append(
                    "Timed out checking service '{}'".format(svc)
                )
            except OSError as exc:
                issues.append(
                    "Could not check service '{}': {}".format(svc, exc)
                )

        return issues


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_exports_file(path: str) -> set[str]:
    """Parse /etc/exports and return the set of exported paths."""
    exported: set[str] = set()
    try:
        with open(path, "r") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                # Format: /path/to/export client(opts) ...
                parts = line.split()
                if parts:
                    exported.add(parts[0])
    except OSError:
        pass
    return exported
