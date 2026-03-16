"""Out-of-band drift detection for managed xiNAS artifacts."""
from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .engine import SnapshotEngine
    from .store import FilesystemStore

from .collector import CHECKSUM_TARGETS, CONFIG_SOURCES

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Policy enum
# ---------------------------------------------------------------------------


class DriftPolicy(Enum):
    """How to handle detected drift for an artifact class."""

    ADOPT = "adopt"  # Absorb drift into next snapshot
    BLOCK = "block"  # Refuse operation until resolved
    OVERWRITE = "overwrite"  # Overwrite with xiNAS desired state
    WARN_AND_CONFIRM = "warn_and_confirm"  # Detect, warn, require confirmation


# ---------------------------------------------------------------------------
# Drift entry
# ---------------------------------------------------------------------------


@dataclass
class DriftEntry:
    """A single detected drift item."""

    artifact: str  # File path or resource name
    artifact_class: str  # "system_config" | "role_default" | "template" | "service"
    previous_checksum: str  # From last applied snapshot
    current_checksum: str  # Current on-disk value
    is_semantic: bool = False  # True if semantic diff was done (not just checksum)
    safety_impact: str = ""  # "affects_rollback_safety" | "cosmetic" | "access_change"
    policy: str = ""  # DriftPolicy value
    detail: str = ""  # Human-readable description of what changed

    def to_dict(self) -> dict:
        """Serialize to a plain dict."""
        d: dict = {
            "artifact": self.artifact,
            "artifact_class": self.artifact_class,
            "previous_checksum": self.previous_checksum,
            "current_checksum": self.current_checksum,
        }
        if self.is_semantic:
            d["is_semantic"] = self.is_semantic
        if self.safety_impact:
            d["safety_impact"] = self.safety_impact
        if self.policy:
            d["policy"] = self.policy
        if self.detail:
            d["detail"] = self.detail
        return d


# ---------------------------------------------------------------------------
# Drift report
# ---------------------------------------------------------------------------


@dataclass
class DriftReport:
    """Complete drift analysis result."""

    clean: bool = True  # No drift detected
    entries: list[DriftEntry] = field(default_factory=list)
    snapshot_id: str = ""  # Snapshot compared against
    timestamp: str = ""  # When check was performed
    has_safety_impact: bool = False  # Any entry affects rollback safety
    has_blocking_drift: bool = False  # Any entry has BLOCK policy

    def to_dict(self) -> dict:
        """Serialize to a plain dict."""
        d: dict = {
            "clean": self.clean,
            "snapshot_id": self.snapshot_id,
            "timestamp": self.timestamp,
            "has_safety_impact": self.has_safety_impact,
            "has_blocking_drift": self.has_blocking_drift,
        }
        if self.entries:
            d["entries"] = [e.to_dict() for e in self.entries]
        return d

    @property
    def summary(self) -> str:
        """Human-readable summary."""
        if self.clean:
            return "No drift detected."

        n = len(self.entries)
        parts = [f"{n} drifted artifact{'s' if n != 1 else ''}"]

        if self.has_blocking_drift:
            blocking = sum(
                1 for e in self.entries if e.policy == DriftPolicy.BLOCK.value
            )
            parts.append(f"{blocking} blocking")

        if self.has_safety_impact:
            safety = sum(
                1 for e in self.entries
                if e.safety_impact == "affects_rollback_safety"
            )
            parts.append(f"{safety} safety-critical")

        return "; ".join(parts) + f" (vs {self.snapshot_id})."


# ---------------------------------------------------------------------------
# Default policy per artifact class / path
# ---------------------------------------------------------------------------

# Policies keyed by system file path or artifact class name.
ARTIFACT_POLICIES: dict[str, DriftPolicy] = {
    # Safety-critical: detect + warn + confirm
    "/etc/exports": DriftPolicy.WARN_AND_CONFIRM,
    "/etc/nfs.conf": DriftPolicy.WARN_AND_CONFIRM,
    "/etc/netplan/99-xinas.yaml": DriftPolicy.WARN_AND_CONFIRM,
    # systemd mount units: warn + confirm
    "systemd_mount": DriftPolicy.WARN_AND_CONFIRM,
    # Role defaults: adopt into snapshot
    "role_default": DriftPolicy.ADOPT,
    # Playbook: adopt
    "playbook": DriftPolicy.ADOPT,
    # Templates: adopt
    "template": DriftPolicy.ADOPT,
}

# Map of checksum keys to their system file paths (mirrors collector.CHECKSUM_TARGETS).
_CHECKSUM_KEY_TO_PATH: dict[str, str] = {
    key: path for key, path in CHECKSUM_TARGETS.items()
}

# Classify CONFIG_SOURCES snapshot filenames into artifact classes.
_CONFIG_ARTIFACT_CLASS: dict[str, str] = {}
for _name in CONFIG_SOURCES:
    if _name.endswith(".j2"):
        _CONFIG_ARTIFACT_CLASS[_name] = "template"
    elif "playbook" in _name:
        _CONFIG_ARTIFACT_CLASS[_name] = "playbook"
    else:
        _CONFIG_ARTIFACT_CLASS[_name] = "role_default"


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------


class DriftDetector:
    """Compares current system state against last known applied snapshot.

    Called during:
    - Preflight validation (before applying changes)
    - Snapshot creation (to record drift in snapshot metadata)
    - On-demand drift check (CLI: ``xinas-history drift check``)
    """

    def __init__(
        self,
        store: FilesystemStore,
        engine: Optional[SnapshotEngine] = None,
        repo_root: str = "/opt/xiNAS",
    ) -> None:
        """
        Args:
            store: FilesystemStore instance for reading snapshot data.
            engine: Optional SnapshotEngine for ``get_current_effective()``.
            repo_root: Path to the xiNAS repository on disk.
        """
        self._store = store
        self._engine = engine
        self._repo_root = Path(repo_root)

    # -- public API ---------------------------------------------------------

    def check(
        self, reference_snapshot_id: Optional[str] = None,
    ) -> DriftReport:
        """Run full drift detection against a reference snapshot.

        If *reference_snapshot_id* is ``None``, uses the current effective
        snapshot (via the engine).  If no effective snapshot exists either,
        returns a clean report.

        Checks:
        1. System config files (checksums from snapshot vs current on-disk)
        2. Role default / template / playbook files (repo vs snapshot copies)
        3. Systemd mount units (if xiNAS-managed)

        Returns:
            A :class:`DriftReport`.
        """
        report = DriftReport(
            timestamp=datetime.datetime.utcnow().isoformat() + "Z",
        )

        # Resolve reference snapshot.
        manifest = self._resolve_reference(reference_snapshot_id)
        if manifest is None:
            logger.info("No reference snapshot found; skipping drift check.")
            return report

        snapshot_id = manifest.id
        report.snapshot_id = snapshot_id

        # 1. System file checksums (from manifest.checksums vs live system).
        entries = self._check_system_files(manifest.checksums)
        report.entries.extend(entries)

        # 2. Config / role-default / template / playbook files (repo vs snapshot).
        entries = self._check_config_files(snapshot_id, manifest)
        report.entries.extend(entries)

        # 3. Systemd mount units.
        entries = self._check_mount_units(snapshot_id, manifest)
        report.entries.extend(entries)

        # Finalize report flags.
        if report.entries:
            report.clean = False
            report.has_safety_impact = any(
                e.safety_impact == "affects_rollback_safety"
                for e in report.entries
            )
            report.has_blocking_drift = any(
                e.policy == DriftPolicy.BLOCK.value for e in report.entries
            )

        return report

    # -- private: resolve reference -----------------------------------------

    def _resolve_reference(self, snapshot_id: Optional[str]):
        """Resolve the reference manifest.  Returns ``None`` if unavailable."""
        if snapshot_id is not None:
            # Try regular snapshot first, then baseline.
            manifest = self._store.read_manifest(snapshot_id)
            if manifest is not None:
                return manifest
            # Could be the baseline.
            baseline = self._store.get_baseline()
            if baseline is not None and baseline.id == snapshot_id:
                return baseline
            logger.warning("Reference snapshot %s not found.", snapshot_id)
            return None

        # Auto-detect via engine.
        if self._engine is not None:
            return self._engine.get_current_effective()

        logger.warning(
            "No reference snapshot ID provided and no engine available."
        )
        return None

    # -- private: system file checksums -------------------------------------

    def _check_system_files(
        self, snapshot_checksums: dict,
    ) -> list[DriftEntry]:
        """Compare system file checksums against snapshot.

        Iterates over :data:`CHECKSUM_TARGETS` (etc_exports, nfs_conf,
        netplan) and compares the stored checksum in the manifest against the
        current on-disk checksum.
        """
        entries: list[DriftEntry] = []

        for key, sys_path in CHECKSUM_TARGETS.items():
            previous = snapshot_checksums.get(key, "")
            current = self._sha256_file(sys_path)

            # If both are empty the file was absent at snapshot time and now.
            if not previous and not current:
                continue

            if previous == current:
                continue

            policy = self._get_policy(sys_path)
            safety = self._determine_safety_impact(sys_path, policy)

            detail = self._describe_system_drift(key, sys_path, previous, current)

            entries.append(DriftEntry(
                artifact=sys_path,
                artifact_class="system_config",
                previous_checksum=previous,
                current_checksum=current,
                is_semantic=False,
                safety_impact=safety,
                policy=policy.value,
                detail=detail,
            ))

        return entries

    # -- private: config / role files ---------------------------------------

    def _check_config_files(
        self, snapshot_id: str, manifest,
    ) -> list[DriftEntry]:
        """Compare role default / template / playbook files in repo against
        snapshot copies.

        For each file listed in :data:`CONFIG_SOURCES`:
        - Read current bytes from the repo on disk.
        - Read the corresponding file stored in the snapshot.
        - Compare via SHA-256.
        """
        entries: list[DriftEntry] = []

        for snapshot_name, rel_path in CONFIG_SOURCES.items():
            repo_path = self._repo_root / rel_path

            # Read current file from repo.
            current_bytes = self._read_file_bytes(str(repo_path))

            # Read snapshot copy.
            snapshot_bytes = self._read_snapshot_config(
                snapshot_id, manifest, snapshot_name,
            )

            previous_cksum = self._sha256(snapshot_bytes) if snapshot_bytes is not None else ""
            current_cksum = self._sha256(current_bytes) if current_bytes is not None else ""

            # Both missing — nothing to compare.
            if not previous_cksum and not current_cksum:
                continue

            if previous_cksum == current_cksum:
                continue

            artifact_class = _CONFIG_ARTIFACT_CLASS.get(snapshot_name, "role_default")
            policy = self._get_policy(artifact_class)
            safety = self._determine_safety_impact(rel_path, policy)

            if current_bytes is None:
                detail = f"{rel_path}: file removed from repo since last snapshot"
            elif snapshot_bytes is None:
                detail = f"{rel_path}: new file (not present in snapshot)"
            else:
                detail = f"{rel_path}: content changed since last snapshot"

            entries.append(DriftEntry(
                artifact=rel_path,
                artifact_class=artifact_class,
                previous_checksum=previous_cksum,
                current_checksum=current_cksum,
                is_semantic=False,
                safety_impact=safety,
                policy=policy.value,
                detail=detail,
            ))

        return entries

    # -- private: mount units -----------------------------------------------

    def _check_mount_units(
        self, snapshot_id: str, manifest,
    ) -> list[DriftEntry]:
        """Check xiNAS-managed systemd mount units for drift.

        Reads ``runtime/mounts.json`` from the snapshot, then compares each
        recorded unit against the current on-disk unit file.
        """
        entries: list[DriftEntry] = []

        # Read snapshot mounts data.
        snapshot_mounts = self._read_snapshot_runtime(
            snapshot_id, manifest, "mounts.json",
        )
        if snapshot_mounts is None:
            return entries

        try:
            mounts_data = json.loads(snapshot_mounts)
        except (json.JSONDecodeError, ValueError):
            logger.warning(
                "Could not parse mounts.json from snapshot %s", snapshot_id,
            )
            return entries

        units = mounts_data.get("units", [])
        if not units:
            return entries

        # For each unit recorded in the snapshot, check the unit file on disk.
        for unit_info in units:
            unit_name = unit_info.get("unit", "")
            if not unit_name:
                continue

            unit_file = f"/etc/systemd/system/{unit_name}"

            # Build a canonical representation of the snapshot's known state
            # for this unit so we can detect if it was removed or changed.
            previous_repr = json.dumps(unit_info, sort_keys=True).encode()
            previous_cksum = self._sha256(previous_repr)

            # Check current state of the unit file.
            current_bytes = self._read_file_bytes(unit_file)
            if current_bytes is not None:
                current_cksum = self._sha256(current_bytes)
            else:
                # Unit file removed — drift.
                current_cksum = ""

            # We also check the live systemd state for semantic comparison.
            live_state = self._get_live_mount_state(unit_name)
            if live_state is not None:
                live_repr = json.dumps(live_state, sort_keys=True).encode()
                live_cksum = self._sha256(live_repr)
                # If the live state matches the snapshot record, no drift.
                if live_cksum == previous_cksum:
                    continue
                is_semantic = True
            else:
                # Cannot query live state; fall back to unit-file check.
                if current_cksum and current_bytes is not None:
                    # Unit file exists — we cannot do semantic comparison
                    # without live state; skip this unit.
                    is_semantic = False
                else:
                    # Unit file gone — clear drift.
                    is_semantic = False

            # If unit file is missing entirely, that is definite drift.
            if not current_cksum and not live_state:
                detail = f"{unit_name}: mount unit removed from system"
            elif live_state:
                snap_active = unit_info.get("active", "")
                snap_sub = unit_info.get("sub", "")
                live_active = live_state.get("active", "")
                live_sub = live_state.get("sub", "")
                if snap_active == live_active and snap_sub == live_sub:
                    # Same active/sub state — no meaningful drift.
                    continue
                detail = (
                    f"{unit_name}: state changed from "
                    f"{snap_active}/{snap_sub} to {live_active}/{live_sub}"
                )
            else:
                detail = f"{unit_name}: mount unit file changed"

            policy = self._get_policy("systemd_mount")
            safety = self._determine_safety_impact(unit_file, policy)

            entries.append(DriftEntry(
                artifact=unit_file,
                artifact_class="service",
                previous_checksum=previous_cksum,
                current_checksum=current_cksum or self._sha256(
                    live_repr if live_state else b"",
                ),
                is_semantic=is_semantic,
                safety_impact=safety,
                policy=policy.value,
                detail=detail,
            ))

        return entries

    # -- private: helpers ---------------------------------------------------

    @staticmethod
    def _sha256(data: bytes) -> str:
        """Compute sha256 checksum string in ``sha256:<hex>`` format."""
        return f"sha256:{hashlib.sha256(data).hexdigest()}"

    @staticmethod
    def _sha256_file(path: str) -> str:
        """Compute sha256 of a file on disk.

        Returns ``sha256:<hex>`` or empty string if the file is missing or
        unreadable.
        """
        try:
            h = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
            return f"sha256:{h.hexdigest()}"
        except (OSError, IOError):
            return ""

    @staticmethod
    def _read_file_bytes(path: str) -> Optional[bytes]:
        """Read a file from disk.  Returns ``None`` if missing or unreadable."""
        try:
            return Path(path).read_bytes()
        except (OSError, IOError):
            return None

    def _read_snapshot_config(
        self, snapshot_id: str, manifest, filename: str,
    ) -> Optional[bytes]:
        """Read a config file from a snapshot, handling baseline directory."""
        from .models import SnapshotType

        if manifest.type == SnapshotType.BASELINE.value:
            path = self._store.baseline_path / filename
            if path.is_file():
                try:
                    return path.read_bytes()
                except OSError:
                    return None
            return None
        return self._store.read_file(snapshot_id, filename)

    def _read_snapshot_runtime(
        self, snapshot_id: str, manifest, filename: str,
    ) -> Optional[bytes]:
        """Read a runtime file from a snapshot, handling baseline directory."""
        from .models import SnapshotType

        if manifest.type == SnapshotType.BASELINE.value:
            path = self._store.baseline_path / "runtime" / filename
            if path.is_file():
                try:
                    return path.read_bytes()
                except OSError:
                    return None
            return None
        return self._store.read_runtime_file(snapshot_id, filename)

    @staticmethod
    def _get_live_mount_state(unit_name: str) -> Optional[dict]:
        """Query systemd for the current state of a mount unit.

        Returns a dict with ``unit``, ``active``, ``sub``, ``description``
        keys to mirror the snapshot format, or ``None`` on failure.
        """
        import subprocess

        try:
            result = subprocess.run(
                [
                    "systemctl", "show", unit_name,
                    "--property=ActiveState,SubState,Description",
                    "--no-pager",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0:
                return None

            props: dict[str, str] = {}
            for line in result.stdout.strip().splitlines():
                if "=" in line:
                    key, _, value = line.partition("=")
                    props[key.strip()] = value.strip()

            return {
                "unit": unit_name,
                "active": props.get("ActiveState", ""),
                "sub": props.get("SubState", ""),
                "description": props.get("Description", ""),
            }
        except (subprocess.TimeoutExpired, OSError):
            return None

    @staticmethod
    def _determine_safety_impact(artifact: str, policy: DriftPolicy) -> str:
        """Determine if drift on this artifact affects rollback safety.

        Safety-critical artifacts are those whose modification could cause
        data access loss or service disruption during rollback.
        """
        # Files that directly control data access or network reachability.
        safety_critical_paths = {
            "/etc/exports",
            "/etc/nfs.conf",
            "/etc/netplan/99-xinas.yaml",
        }

        # Exact path match.
        if artifact in safety_critical_paths:
            return "affects_rollback_safety"

        # Systemd mount units affect data access.
        if artifact.startswith("/etc/systemd/system/") and artifact.endswith(".mount"):
            return "affects_rollback_safety"

        # WARN_AND_CONFIRM policy implies safety concern.
        if policy == DriftPolicy.WARN_AND_CONFIRM:
            return "access_change"

        return "cosmetic"

    @staticmethod
    def _get_policy(artifact: str) -> DriftPolicy:
        """Get drift policy for an artifact path or class name.

        Lookup order:
        1. Exact path in :data:`ARTIFACT_POLICIES`.
        2. Artifact class name in :data:`ARTIFACT_POLICIES`.
        3. Default: ``WARN_AND_CONFIRM``.
        """
        # Direct path lookup.
        if artifact in ARTIFACT_POLICIES:
            return ARTIFACT_POLICIES[artifact]

        # Systemd mount units.
        if (
            artifact.startswith("/etc/systemd/system/")
            and artifact.endswith(".mount")
        ):
            return ARTIFACT_POLICIES.get(
                "systemd_mount", DriftPolicy.WARN_AND_CONFIRM,
            )

        # Artifact class lookup (role_default, playbook, template).
        if artifact in ARTIFACT_POLICIES:
            return ARTIFACT_POLICIES[artifact]

        # Default: warn and confirm.
        return DriftPolicy.WARN_AND_CONFIRM

    @staticmethod
    def _describe_system_drift(
        key: str, sys_path: str, previous: str, current: str,
    ) -> str:
        """Build a human-readable description for system-file drift."""
        if not current:
            return f"{sys_path}: file removed (was tracked as {key})"
        if not previous:
            return f"{sys_path}: new file appeared (not in snapshot)"
        return f"{sys_path}: content changed outside xiNAS"
