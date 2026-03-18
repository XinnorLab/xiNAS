"""Garbage collection for xiNAS configuration history snapshots.

Retention rules:
1. Never delete baseline.
2. Never delete the currently active/effective snapshot.
3. Never delete a snapshot referenced by an in-progress rollback.
4. Verify a snapshot is not locked before deletion.
5. When a new rollback-eligible snapshot is created, purge the 41st oldest
   (excluding baseline).
6. On startup, scan for stale ephemeral snapshots.
"""
from __future__ import annotations

from typing import List, Optional, Set

from .models import Manifest, SnapshotStatus, SnapshotType
from .store import FilesystemStore


class GarbageCollector:
    """Manages snapshot retention: baseline + 40 rollback-eligible + 1 ephemeral."""

    MAX_ROLLBACK_SNAPSHOTS = 40

    def __init__(self, store: FilesystemStore) -> None:
        self._store = store

    # -- public API ---------------------------------------------------------

    def run(
        self,
        current_effective_id: Optional[str] = None,
        in_progress_ids: Optional[Set[str]] = None,
    ) -> List[str]:
        """Run garbage collection.

        Returns list of purged snapshot IDs.

        Args:
            current_effective_id: ID of the currently active snapshot
                (protected from deletion).
            in_progress_ids: IDs of snapshots involved in active transactions
                (protected from deletion).
        """
        if in_progress_ids is None:
            in_progress_ids = set()

        snapshots = self._store.list_snapshots()  # sorted by timestamp asc
        purged: List[str] = []

        # Separate rollback-eligible snapshots from others.
        rollback_eligible = [
            m for m in snapshots
            if m.type == SnapshotType.ROLLBACK_ELIGIBLE.value
        ]

        # Determine which ones can be purged.
        purgeable = self._get_purgeable_snapshots(
            rollback_eligible, current_effective_id, in_progress_ids
        )

        # How many rollback-eligible snapshots exceed the limit?
        protected_count = len(rollback_eligible) - len(purgeable)
        excess = len(rollback_eligible) - self.MAX_ROLLBACK_SNAPSHOTS
        if excess <= 0:
            return purged

        # We can only remove as many as are purgeable and needed.
        to_remove = min(excess, len(purgeable))

        # purgeable is oldest-first, so take from the front.
        for m in purgeable[:to_remove]:
            if self._store.delete_snapshot(m.id):
                purged.append(m.id)

        return purged

    def cleanup_stale_ephemeral(
        self, active_transaction_ids: Optional[Set[str]] = None
    ) -> List[str]:
        """Find and clean up orphaned ephemeral snapshots.

        Called on startup.  Returns list of cleaned-up snapshot IDs.

        For each ephemeral snapshot:
        - If no active transaction references it: delete.
        - If the associated operation never started (status == pending):
          delete.
        - If the operation had begun (status != pending): mark as failed
          and keep for forensics.
        """
        if active_transaction_ids is None:
            active_transaction_ids = set()

        snapshots = self._store.list_snapshots()
        cleaned: List[str] = []

        for m in snapshots:
            if m.type != SnapshotType.EPHEMERAL.value:
                continue

            # If an active transaction still references this snapshot, skip.
            if m.id in active_transaction_ids:
                continue

            if m.status == SnapshotStatus.PENDING.value:
                # Operation never started -- safe to remove outright.
                if self._store.delete_snapshot(m.id):
                    cleaned.append(m.id)
            else:
                # Operation had begun -- mark failed, keep for forensics.
                m.status = SnapshotStatus.FAILED.value
                self._store.update_manifest(m.id, m)
                cleaned.append(m.id)

        return cleaned

    # -- internal helpers ---------------------------------------------------

    def _is_protected(
        self,
        manifest: Manifest,
        current_effective_id: Optional[str],
        in_progress_ids: Optional[Set[str]],
    ) -> bool:
        """Check if a snapshot is protected from deletion."""
        # Baseline is always protected.
        if manifest.type == SnapshotType.BASELINE.value:
            return True

        # Currently effective snapshot is protected.
        if current_effective_id is not None and manifest.id == current_effective_id:
            return True

        # Snapshots involved in in-progress transactions are protected.
        if in_progress_ids and manifest.id in in_progress_ids:
            return True

        return False

    def _get_purgeable_snapshots(
        self,
        snapshots: List[Manifest],
        current_effective_id: Optional[str],
        in_progress_ids: Optional[Set[str]],
    ) -> List[Manifest]:
        """Get list of snapshots eligible for purging, oldest first.

        The input *snapshots* should already be sorted by timestamp ascending.
        """
        return [
            m for m in snapshots
            if not self._is_protected(m, current_effective_id, in_progress_ids)
        ]
