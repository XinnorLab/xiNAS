"""Core data models for the xiNAS Configuration History subsystem."""
from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class RollbackClass(Enum):
    """Risk level for a rollback operation."""

    DESTROYING_DATA = "destroying_data"
    CHANGING_ACCESS = "changing_access"
    NON_DISRUPTIVE = "non_disruptive"


class OperationType(Enum):
    """Type of configuration operation being tracked."""

    INSTALL = "install"
    PROFILE_SELECT = "profile_select"
    RAID_CREATE = "raid_create"
    RAID_DELETE = "raid_delete"
    RAID_MODIFY = "raid_modify"
    FS_CREATE = "fs_create"
    FS_DELETE = "fs_delete"
    FS_MODIFY = "fs_modify"
    SHARE_CREATE = "share_create"
    SHARE_DELETE = "share_delete"
    SHARE_MODIFY = "share_modify"
    NETWORK_MODIFY = "network_modify"
    NFS_MODIFY = "nfs_modify"
    ROLLBACK = "rollback"
    RESET_TO_BASELINE = "reset_to_baseline"


class SnapshotStatus(Enum):
    """Lifecycle status of a configuration snapshot."""

    PENDING = "pending"
    APPLIED = "applied"
    ROLLED_BACK = "rolled_back"
    FAILED = "failed"
    PARTIAL = "partial"


class SnapshotType(Enum):
    """Category that governs snapshot retention and rollback eligibility."""

    BASELINE = "baseline"
    ROLLBACK_ELIGIBLE = "rollback_eligible"
    EPHEMERAL = "ephemeral"


class OperationSource(Enum):
    """Where the operation was initiated from."""

    INSTALLER = "installer"
    POST_INSTALL_MENU = "post_install_menu"
    XINAS_MENU = "xinas_menu"
    API = "api"
    MCP = "mcp"


# ---------------------------------------------------------------------------
# Supporting dataclasses
# ---------------------------------------------------------------------------


@dataclass
class Checksums:
    """SHA-256 checksums for key configuration files."""

    etc_exports: str = ""  # sha256:<hex>
    nfs_conf: str = ""
    netplan: str = ""

    def to_dict(self) -> dict:
        result: dict = {}
        if self.etc_exports:
            result["etc_exports"] = self.etc_exports
        if self.nfs_conf:
            result["nfs_conf"] = self.nfs_conf
        if self.netplan:
            result["netplan"] = self.netplan
        return result

    @classmethod
    def from_dict(cls, data: dict) -> Checksums:
        if not data:
            return cls()
        return cls(
            etc_exports=data.get("etc_exports", ""),
            nfs_conf=data.get("nfs_conf", ""),
            netplan=data.get("netplan", ""),
        )


@dataclass
class ValidationResult:
    """Pre-flight validation outcome."""

    passed: bool = True
    blockers: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        result: dict = {"passed": self.passed}
        if self.blockers:
            result["blockers"] = list(self.blockers)
        if self.warnings:
            result["warnings"] = list(self.warnings)
        return result

    @classmethod
    def from_dict(cls, data: dict) -> ValidationResult:
        if not data:
            return cls()
        return cls(
            passed=data.get("passed", True),
            blockers=list(data.get("blockers", [])),
            warnings=list(data.get("warnings", [])),
        )


# ---------------------------------------------------------------------------
# Manifest — the primary snapshot metadata record
# ---------------------------------------------------------------------------


@dataclass
class Manifest:
    """Metadata record for a single configuration snapshot.

    Designed for clean YAML serialization via ``to_dict()`` / ``from_dict()``.
    """

    id: str  # "20260316T145500Z-raid-modify"
    timestamp: str  # ISO 8601
    user: str
    source: str  # OperationSource value
    preset: str = ""
    operation: str = ""  # OperationType value
    rollback_class: str = ""  # RollbackClass value
    status: str = "pending"  # SnapshotStatus value
    type: str = "rollback_eligible"  # SnapshotType value
    parent_id: Optional[str] = None
    repo_commit: str = ""
    playbook: str = "playbooks/site.yml"
    extra_vars: dict = field(default_factory=dict)
    hostname: str = ""
    hardware_id: Optional[str] = None
    auto_detected: bool = False
    checksums: dict = field(default_factory=dict)
    validation: dict = field(default_factory=dict)
    diff_summary: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to a plain dict suitable for YAML serialization.

        * Enum values are stored as their string values (not Enum objects).
        * Optional fields that are ``None`` or empty are omitted to keep the
          output compact.
        """
        result: dict = {
            "id": self.id,
            "timestamp": self.timestamp,
            "user": self.user,
            "source": self.source,
            "status": self.status,
            "type": self.type,
            "playbook": self.playbook,
        }

        # Include non-empty string fields
        for key in ("preset", "operation", "rollback_class", "repo_commit", "hostname"):
            value = getattr(self, key)
            if value:
                result[key] = value

        # Optional string fields — include only when set
        if self.parent_id is not None:
            result["parent_id"] = self.parent_id
        if self.hardware_id is not None:
            result["hardware_id"] = self.hardware_id
        if self.diff_summary is not None:
            result["diff_summary"] = self.diff_summary

        # Boolean fields — include only when non-default
        if self.auto_detected:
            result["auto_detected"] = self.auto_detected

        # Dict fields — include only when non-empty
        if self.extra_vars:
            result["extra_vars"] = dict(self.extra_vars)
        if self.checksums:
            result["checksums"] = dict(self.checksums)
        if self.validation:
            result["validation"] = dict(self.validation)

        return result

    @classmethod
    def from_dict(cls, data: dict) -> Manifest:
        """Construct a Manifest from a plain dict (e.g. loaded from YAML).

        Missing keys fall back to field defaults.
        """
        return cls(
            id=data.get("id", ""),
            timestamp=data.get("timestamp", ""),
            user=data.get("user", ""),
            source=data.get("source", ""),
            preset=data.get("preset", ""),
            operation=data.get("operation", ""),
            rollback_class=data.get("rollback_class", ""),
            status=data.get("status", "pending"),
            type=data.get("type", "rollback_eligible"),
            parent_id=data.get("parent_id"),
            repo_commit=data.get("repo_commit", ""),
            playbook=data.get("playbook", "playbooks/site.yml"),
            extra_vars=dict(data.get("extra_vars", {})),
            hostname=data.get("hostname", ""),
            hardware_id=data.get("hardware_id"),
            auto_detected=data.get("auto_detected", False),
            checksums=dict(data.get("checksums", {})),
            validation=dict(data.get("validation", {})),
            diff_summary=data.get("diff_summary"),
        )


# ---------------------------------------------------------------------------
# DiffResult — comparison between two snapshots
# ---------------------------------------------------------------------------


@dataclass
class DiffResult:
    """Result of comparing two snapshots."""

    from_id: str
    to_id: str
    config_changes: list[dict] = field(default_factory=list)  # [{file, change_type, summary}]
    runtime_changes: list[dict] = field(default_factory=list)  # [{resource, change_type, summary}]
    rollback_class: str = ""
    summary: str = ""

    def to_dict(self) -> dict:
        result: dict = {
            "from_id": self.from_id,
            "to_id": self.to_id,
        }
        if self.config_changes:
            result["config_changes"] = list(self.config_changes)
        if self.runtime_changes:
            result["runtime_changes"] = list(self.runtime_changes)
        if self.rollback_class:
            result["rollback_class"] = self.rollback_class
        if self.summary:
            result["summary"] = self.summary
        return result

    @classmethod
    def from_dict(cls, data: dict) -> DiffResult:
        if not data:
            return cls(from_id="", to_id="")
        return cls(
            from_id=data.get("from_id", ""),
            to_id=data.get("to_id", ""),
            config_changes=list(data.get("config_changes", [])),
            runtime_changes=list(data.get("runtime_changes", [])),
            rollback_class=data.get("rollback_class", ""),
            summary=data.get("summary", ""),
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def generate_snapshot_id(operation: str) -> str:
    """Generate a snapshot ID from the current UTC time and operation name.

    Format: ``YYYYMMDDTHHMMSSZ-<operation>`` where *operation* has
    underscores replaced with hyphens for readability.

    Examples::

        generate_snapshot_id("raid_create")   -> "20260316T145500Z-raid-create"
        generate_snapshot_id("install")       -> "20260316T145500Z-install"
    """
    now = datetime.datetime.utcnow()
    ts = now.strftime("%Y%m%dT%H%M%SZ")
    slug = operation.replace("_", "-")
    return f"{ts}-{slug}"
