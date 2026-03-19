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
from .store import FilesystemStore
from .engine import SnapshotEngine
from .runner import TransactionalRunner, RunResult
from .lock import GlobalConfigLock, LockError
from .classifier import RollbackClassifier
from .gc import GarbageCollector, RetentionPolicy, load_retention_policy
from .drift import DriftDetector, DriftReport, DriftPolicy
from .validator import PreflightValidator, PostApplyValidator
from .grpc_inspector import GrpcInspector
from .collector import ConfigCollector, RuntimeCollector

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
