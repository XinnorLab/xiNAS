"""SnapshotHelper — thin wrapper for xinas_history integration in TUI screens.

Provides fire-and-forget snapshot creation so screen code stays simple.
All errors are logged but never propagated to the UI (snapshots are
best-effort and must not block the primary operation).
"""
from __future__ import annotations

import logging
from typing import Optional

_log = logging.getLogger(__name__)

# Guard: xinas_history may not be installed on dev machines.
try:
    from xinas_history import SnapshotEngine, FilesystemStore
    _HAS_ENGINE = True
except ImportError:
    _HAS_ENGINE = False


class SnapshotHelper:
    """Convenience wrapper exposed as ``app.snapshots``."""

    def __init__(
        self,
        grpc_address: str = "localhost:6066",
        repo_root: str = "/opt/xiNAS",
    ) -> None:
        self._engine: Optional[object] = None
        if _HAS_ENGINE:
            try:
                self._engine = SnapshotEngine(
                    store=FilesystemStore(),
                    repo_root=repo_root,
                    grpc_address=grpc_address,
                )
            except Exception:
                _log.warning("Failed to init SnapshotEngine", exc_info=True)

    @property
    def available(self) -> bool:
        return self._engine is not None

    async def record(
        self,
        operation: str,
        source: str = "xinas_menu",
        preset: str = "",
        snapshot_type: str = "rollback_eligible",
        diff_summary: Optional[str] = None,
    ) -> Optional[str]:
        """Create a snapshot, return its ID or None on failure.

        This is the only method screens need to call.
        """
        if not self._engine:
            _log.debug("snapshot skipped: engine not available")
            return None
        try:
            manifest = await self._engine.create_snapshot(
                source=source,
                operation=operation,
                preset=preset,
                snapshot_type=snapshot_type,
                diff_summary=diff_summary,
            )
            _log.info("snapshot created: %s", manifest.id)
            return manifest.id
        except Exception:
            _log.warning("snapshot creation failed", exc_info=True)
            return None

    async def record_baseline(self, preset: str = "") -> Optional[str]:
        """Purge existing history and create a fresh baseline snapshot.

        Called after a successful install.  Any previous config history
        (baseline, snapshots, state) is wiped so only the new baseline
        remains.
        """
        if not self._engine:
            _log.debug("baseline skipped: engine not available")
            return None
        try:
            manifest = await self._engine.purge_and_create_baseline(
                source="installer",
                preset=preset,
            )
            _log.info("baseline snapshot created: %s", manifest.id)
            return manifest.id
        except Exception:
            _log.warning("baseline creation failed", exc_info=True)
            return None
