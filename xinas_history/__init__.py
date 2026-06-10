"""xiNAS Configuration History — snapshot tracking and rollback classification."""
from __future__ import annotations

__version__ = "0.1.0"

from .classifier import RollbackClassifier
from .collector import ConfigCollector, RuntimeCollector
from .drift import DriftDetector, DriftPolicy, DriftReport
from .engine import SnapshotEngine
from .gc import GarbageCollector, RetentionPolicy, load_retention_policy
from .grpc_inspector import GrpcInspector
from .lock import GlobalConfigLock, LockError
from .models import (
    DiffResult,
    Manifest,
    OperationSource,
    OperationType,
    RollbackClass,
    SnapshotStatus,
    SnapshotType,
)
from .runner import RunResult, TransactionalRunner
from .store import FilesystemStore
from .validator import PostApplyValidator, PreflightValidator

__all__ = [
    "ConfigCollector",
    "DiffResult",
    "DriftDetector",
    "DriftPolicy",
    "DriftReport",
    "FilesystemStore",
    "GarbageCollector",
    "GlobalConfigLock",
    "GrpcInspector",
    "LockError",
    "load_retention_policy",
    "Manifest",
    "OperationSource",
    "OperationType",
    "PostApplyValidator",
    "PreflightValidator",
    "RetentionPolicy",
    "RollbackClass",
    "RollbackClassifier",
    "RunResult",
    "RuntimeCollector",
    "SnapshotEngine",
    "SnapshotStatus",
    "SnapshotType",
    "TransactionalRunner",
]
