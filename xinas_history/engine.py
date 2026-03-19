"""Snapshot engine — core orchestrator for configuration history."""
from __future__ import annotations

import asyncio
import datetime
import getpass
import json
import socket
from typing import Optional

from .models import (
    Checksums,
    DiffResult,
    Manifest,
    OperationType,
    OperationSource,
    RollbackClass,
    SnapshotStatus,
    SnapshotType,
    ValidationResult,
    generate_snapshot_id,
)
from .store import FilesystemStore
from .gc import GarbageCollector, load_retention_policy
from .classifier import RollbackClassifier
from .collector import ConfigCollector, RuntimeCollector
from .grpc_inspector import GrpcInspector


class SnapshotEngine:
    """Core orchestrator for configuration snapshot lifecycle.

    Provides:
    - create_snapshot(): Create a new snapshot from current state
    - create_baseline(): Create the immutable first-install snapshot
    - list_snapshots(): List all snapshots with filtering
    - get_snapshot(): Get a specific snapshot's manifest
    - diff(): Compare two snapshots
    - get_current_effective(): Get the most recent applied snapshot
    - get_history_summary(): Summary dict for UI display
    """

    def __init__(
        self,
        store: Optional[FilesystemStore] = None,
        repo_root: str = "/opt/xiNAS",
        grpc_address: str = "localhost:6066",
        grpc_client=None,
    ):
        self._store = store or FilesystemStore()
        self._repo_root = repo_root
        self._inspector = GrpcInspector(
            grpc_address=grpc_address, grpc_client=grpc_client,
        )
        self._config_collector = ConfigCollector(repo_root=repo_root)
        self._runtime_collector = RuntimeCollector(self._inspector)
        self._gc = GarbageCollector(self._store, load_retention_policy())
        self._classifier = RollbackClassifier()

    # -- public API ---------------------------------------------------------

    async def create_snapshot(
        self,
        source: str,
        operation: str,
        preset: str = "",
        snapshot_type: str = SnapshotType.ROLLBACK_ELIGIBLE.value,
        parent_id: Optional[str] = None,
        extra_vars: Optional[dict] = None,
        diff_summary: Optional[str] = None,
    ) -> Manifest:
        """Create a new configuration snapshot from current system state.

        Steps:
        1. Generate snapshot ID
        2. Collect desired configuration files from repo
        3. Collect runtime state via gRPC + system inspection
        4. Compute checksums of managed system files
        5. Classify the operation
        6. Build manifest
        7. Write snapshot to store
        8. Run garbage collection

        Args:
            source: Operation source (OperationSource value).
            operation: Operation type (OperationType value).
            preset: Preset/profile name.
            snapshot_type: SnapshotType value (baseline, rollback_eligible,
                ephemeral).
            parent_id: Parent snapshot ID (auto-detected if not provided).
            extra_vars: Extra variables used during apply.
            diff_summary: Human-readable change summary.

        Returns:
            The created Manifest.
        """
        self._store.ensure_dirs()

        is_baseline = snapshot_type == SnapshotType.BASELINE.value

        # 1. Generate snapshot ID
        snapshot_id = generate_snapshot_id(operation)

        # 2. Collect config files
        config_files = self._config_collector.collect()

        # 3. Collect runtime state + checksums concurrently
        runtime_files, checksums = await asyncio.gather(
            self._runtime_collector.collect(),
            self._runtime_collector.collect_checksums(),
            return_exceptions=False,
        )

        # 4. Get repo commit
        repo_commit = self._config_collector.get_repo_commit()

        # 5. Classify the operation
        rollback_class = ""
        try:
            op_enum = OperationType(operation)
            rollback_class = self._classifier.classify_operation(op_enum).value
        except ValueError:
            rollback_class = RollbackClass.NON_DISRUPTIVE.value

        # 6. Auto-detect parent_id if not provided
        if parent_id is None and not is_baseline:
            effective = self.get_current_effective()
            if effective is not None:
                parent_id = effective.id

        # 7. Build manifest
        manifest = Manifest(
            id=snapshot_id,
            timestamp=datetime.datetime.utcnow().isoformat() + "Z",
            user=_get_user(),
            source=source,
            preset=preset,
            operation=operation,
            rollback_class=rollback_class,
            status=SnapshotStatus.APPLIED.value,
            type=snapshot_type,
            parent_id=parent_id,
            repo_commit=repo_commit,
            extra_vars=extra_vars or {},
            hostname=_get_hostname(),
            hardware_id=await self._get_hardware_id(),
            checksums=checksums.to_dict(),
            diff_summary=diff_summary,
        )

        # 8. Write snapshot to store
        self._store.write_snapshot(
            snapshot_id=snapshot_id,
            manifest=manifest,
            config_files=config_files,
            runtime_files=runtime_files,
            is_baseline=is_baseline,
        )

        # 9. Run garbage collection (non-baseline only)
        if not is_baseline:
            effective_id = snapshot_id  # this one is now the effective
            try:
                self._gc.run(current_effective_id=effective_id)
            except Exception:
                pass  # GC failures are non-fatal

        return manifest

    async def create_baseline(
        self,
        source: str,
        preset: str = "",
        extra_vars: Optional[dict] = None,
    ) -> Manifest:
        """Create the immutable baseline snapshot (first install).

        Raises ValueError if baseline already exists.
        """
        if self._store.has_baseline():
            raise ValueError("Baseline snapshot already exists")

        return await self.create_snapshot(
            source=source,
            operation=OperationType.INSTALL.value,
            preset=preset,
            snapshot_type=SnapshotType.BASELINE.value,
            parent_id=None,
            extra_vars=extra_vars,
            diff_summary="Initial baseline snapshot",
        )

    def list_snapshots(
        self,
        include_baseline: bool = True,
        status_filter: Optional[str] = None,
        type_filter: Optional[str] = None,
    ) -> list:
        """List snapshots with optional filtering.

        Returns list sorted by timestamp ascending.
        """
        manifests = []

        # Include baseline first if requested
        if include_baseline:
            baseline = self._store.get_baseline()
            if baseline is not None:
                manifests.append(baseline)

        # Add all non-baseline snapshots
        manifests.extend(self._store.list_snapshots())

        # Apply filters
        if status_filter is not None:
            manifests = [m for m in manifests if m.status == status_filter]

        if type_filter is not None:
            manifests = [m for m in manifests if m.type == type_filter]

        return manifests

    def get_snapshot(self, snapshot_id: str) -> Optional[Manifest]:
        """Get manifest for a specific snapshot.

        Checks both the snapshots directory and baseline.
        """
        # Check regular snapshots first
        manifest = self._store.read_manifest(snapshot_id)
        if manifest is not None:
            return manifest

        # Check baseline
        baseline = self._store.get_baseline()
        if baseline is not None and baseline.id == snapshot_id:
            return baseline

        return None

    def get_current_effective(self) -> Optional[Manifest]:
        """Get the most recent applied snapshot.

        Walks snapshots newest-first, returns first with status=applied.
        """
        snapshots = self._store.list_snapshots()  # sorted by timestamp asc

        # Walk newest-first
        for m in reversed(snapshots):
            if m.status == SnapshotStatus.APPLIED.value:
                return m

        # Fall back to baseline if it exists and is applied
        baseline = self._store.get_baseline()
        if baseline is not None and baseline.status == SnapshotStatus.APPLIED.value:
            return baseline

        return None

    def diff(self, from_id: str, to_id: str) -> DiffResult:
        """Compare two snapshots and return a DiffResult.

        Compares:
        1. Config file contents (byte-level diff)
        2. Runtime state differences (JSON comparison)
        3. Checksum changes
        """
        from_manifest = self.get_snapshot(from_id)
        to_manifest = self.get_snapshot(to_id)

        if from_manifest is None:
            raise ValueError(f"Snapshot not found: {from_id}")
        if to_manifest is None:
            raise ValueError(f"Snapshot not found: {to_id}")

        config_changes = self._diff_config_files(from_id, to_id, from_manifest, to_manifest)
        runtime_changes = self._diff_runtime_files(from_id, to_id, from_manifest, to_manifest)

        # Add checksum changes to config_changes
        checksum_changes = self._diff_checksums(from_manifest, to_manifest)
        if checksum_changes:
            config_changes.extend(checksum_changes)

        # Build the DiffResult
        diff_result = DiffResult(
            from_id=from_id,
            to_id=to_id,
            config_changes=config_changes,
            runtime_changes=runtime_changes,
        )

        # Classify the overall rollback risk
        risk = self._classifier.classify_diff(diff_result)
        diff_result.rollback_class = risk.value

        # Build a human-readable summary
        total = len(config_changes) + len(runtime_changes)
        diff_result.summary = (
            f"{total} change(s): {len(config_changes)} config, "
            f"{len(runtime_changes)} runtime"
        )

        return diff_result

    def get_baseline_manifest(self) -> Manifest:
        """Return the baseline manifest.

        Raises ValueError if no baseline exists.
        """
        baseline = self._store.get_baseline()
        if baseline is None:
            raise ValueError("No baseline snapshot exists")
        return baseline

    def get_history_summary(self) -> dict:
        """Get a summary dict suitable for UI display.

        Returns:
            {
                "baseline": manifest_dict or None,
                "snapshots": [manifest_dicts...],
                "current_effective": manifest_dict or None,
                "total_count": int,
                "rollback_eligible_count": int,
            }
        """
        baseline = self._store.get_baseline()
        snapshots = self._store.list_snapshots()
        current = self.get_current_effective()

        rollback_eligible = [
            m for m in snapshots
            if m.type == SnapshotType.ROLLBACK_ELIGIBLE.value
        ]

        total_count = len(snapshots)
        if baseline is not None:
            total_count += 1

        return {
            "baseline": baseline.to_dict() if baseline else None,
            "snapshots": [m.to_dict() for m in snapshots],
            "current_effective": current.to_dict() if current else None,
            "total_count": total_count,
            "rollback_eligible_count": len(rollback_eligible),
        }

    # -- private helpers ----------------------------------------------------

    def _diff_config_files(
        self,
        from_id: str,
        to_id: str,
        from_manifest: Manifest,
        to_manifest: Manifest,
    ) -> list:
        """Diff config files between two snapshots by reading stored bytes."""
        from .collector import CONFIG_SOURCES

        changes = []
        all_filenames = set(CONFIG_SOURCES.keys())

        for filename in sorted(all_filenames):
            from_bytes = self._read_snapshot_file(from_id, from_manifest, filename)
            to_bytes = self._read_snapshot_file(to_id, to_manifest, filename)

            if from_bytes == to_bytes:
                continue

            if from_bytes is None and to_bytes is not None:
                change_type = "added"
            elif from_bytes is not None and to_bytes is None:
                change_type = "removed"
            else:
                change_type = "modified"

            changes.append({
                "file": filename,
                "change_type": change_type,
                "summary": f"{filename}: {change_type}",
            })

        return changes

    def _diff_runtime_files(
        self,
        from_id: str,
        to_id: str,
        from_manifest: Manifest,
        to_manifest: Manifest,
    ) -> list:
        """Diff runtime state files between two snapshots using JSON comparison."""
        runtime_filenames = [
            "raid-show.json",
            "pool-show.json",
            "config-show.json",
            "mounts.json",
            "exports.json",
            "services.json",
        ]
        changes = []

        for filename in runtime_filenames:
            from_bytes = self._read_snapshot_runtime_file(
                from_id, from_manifest, filename,
            )
            to_bytes = self._read_snapshot_runtime_file(
                to_id, to_manifest, filename,
            )

            if from_bytes == to_bytes:
                continue

            # Try JSON-level comparison for semantic diff
            from_data = _try_parse_json(from_bytes)
            to_data = _try_parse_json(to_bytes)

            if from_data is not None and to_data is not None:
                if from_data == to_data:
                    continue  # JSON-equivalent despite byte differences

            resource = filename.replace(".json", "").replace("-", "_")

            if from_bytes is None and to_bytes is not None:
                change_type = "added"
            elif from_bytes is not None and to_bytes is None:
                change_type = "removed"
            else:
                change_type = "modified"

            changes.append({
                "resource": resource,
                "change_type": change_type,
                "summary": f"{resource}: {change_type}",
            })

        return changes

    def _diff_checksums(
        self, from_manifest: Manifest, to_manifest: Manifest,
    ) -> list:
        """Compare checksums between two manifests."""
        changes = []
        from_ck = Checksums.from_dict(from_manifest.checksums)
        to_ck = Checksums.from_dict(to_manifest.checksums)

        for field_name in ("etc_exports", "nfs_conf", "netplan"):
            from_val = getattr(from_ck, field_name, "")
            to_val = getattr(to_ck, field_name, "")
            if from_val != to_val:
                changes.append({
                    "file": f"checksum:{field_name}",
                    "change_type": "modified",
                    "summary": f"Checksum changed for {field_name}",
                })

        return changes

    def _read_snapshot_file(
        self, snapshot_id: str, manifest: Manifest, filename: str,
    ) -> Optional[bytes]:
        """Read a config file from a snapshot, handling baseline specially."""
        if manifest.type == SnapshotType.BASELINE.value:
            # Baseline files live in the baseline directory
            path = self._store.baseline_path / filename
            if path.is_file():
                try:
                    return path.read_bytes()
                except OSError:
                    return None
            return None
        return self._store.read_file(snapshot_id, filename)

    def _read_snapshot_runtime_file(
        self, snapshot_id: str, manifest: Manifest, filename: str,
    ) -> Optional[bytes]:
        """Read a runtime file from a snapshot, handling baseline specially."""
        if manifest.type == SnapshotType.BASELINE.value:
            path = self._store.baseline_path / "runtime" / filename
            if path.is_file():
                try:
                    return path.read_bytes()
                except OSError:
                    return None
            return None
        return self._store.read_runtime_file(snapshot_id, filename)

    async def _get_hardware_id(self) -> Optional[str]:
        """Try to get hardware ID from gRPC license_show, return None on failure."""
        try:
            # license_show is not exposed on GrpcInspector; try config_show
            ok, data, _ = await self._inspector.config_show()
            if ok and isinstance(data, dict):
                # Look for hardware_id or serial in config data
                hw_id = data.get("hardware_id") or data.get("serial")
                if hw_id:
                    return str(hw_id)
        except Exception:
            pass
        return None


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _get_user() -> str:
    """Get the current system user."""
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


def _get_hostname() -> str:
    """Get the current hostname."""
    try:
        return socket.gethostname()
    except Exception:
        return "unknown"


def _try_parse_json(data: Optional[bytes]) -> Optional[object]:
    """Try to parse bytes as JSON, return None on failure."""
    if data is None:
        return None
    try:
        return json.loads(data)
    except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
        return None
