"""Garbage collection for xiNAS configuration history snapshots.

Retention rules (configurable via /etc/xinas-mcp/config.json):
1. Never delete baseline.
2. Never delete the currently active/effective snapshot.
3. Never delete a snapshot referenced by an in-progress rollback.
4. Purge rollback-eligible snapshots exceeding max_snapshots (oldest first).
5. Purge rollback-eligible snapshots older than max_age_days (if > 0).
6. On startup, scan for stale ephemeral snapshots.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Set

from .models import Manifest, SnapshotStatus, SnapshotType
from .store import FilesystemStore

CONFIG_PATH = Path("/etc/xinas-mcp/config.json")


@dataclass(frozen=True)
class RetentionPolicy:
    """Configurable retention policy for GC."""
    max_snapshots: int = 40
    max_age_days: int = 0  # 0 = disabled


def load_retention_policy() -> RetentionPolicy:
    """Load retention policy from /etc/xinas-mcp/config.json.

    Falls back to defaults if the file is missing or malformed.
    """
    try:
        data = json.loads(CONFIG_PATH.read_text())
        section = data.get("retention", {})
        return RetentionPolicy(
            max_snapshots=max(1, int(section.get("max_snapshots", 40))),
            max_age_days=max(0, int(section.get("max_age_days", 0))),
        )
    except Exception:
        return RetentionPolicy()


class GarbageCollector:
    """Manages snapshot retention with configurable policy."""

    def __init__(self, store: FilesystemStore, policy: Optional[RetentionPolicy] = None) -> None:
        self._store = store
        self._policy = policy or RetentionPolicy()

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

        to_purge_ids: set[str] = set()

        # Rule 1: count-based
        excess = len(rollback_eligible) - self._policy.max_snapshots
        if excess > 0:
            for m in purgeable[:excess]:
                to_purge_ids.add(m.id)

        # Rule 2: age-based
        if self._policy.max_age_days > 0:
            for m in purgeable:
                if self._is_expired(m, self._policy.max_age_days):
                    to_purge_ids.add(m.id)

        # Delete in oldest-first order
        for m in purgeable:
            if m.id in to_purge_ids:
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

    @staticmethod
    def _is_expired(manifest: Manifest, max_age_days: int) -> bool:
        """Check if a snapshot is older than max_age_days."""
        if max_age_days <= 0:
            return False
        try:
            ts = manifest.timestamp.replace("Z", "+00:00")
            snap_time = datetime.fromisoformat(ts)
            cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
            return snap_time < cutoff
        except (ValueError, TypeError):
            return False
