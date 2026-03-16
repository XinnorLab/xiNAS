"""xiNAS Configuration History — snapshot tracking and rollback classification."""
from __future__ import annotations

__version__ = "0.1.0"

from .models import (
    DiffResult,
    Manifest,
    OperationSource,
    OperationType,
    RollbackClass,
    SnapshotStatus,
    SnapshotType,
)

__all__ = [
    "DiffResult",
    "Manifest",
    "OperationSource",
    "OperationType",
    "RollbackClass",
    "SnapshotStatus",
    "SnapshotType",
]
