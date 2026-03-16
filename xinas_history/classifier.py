"""Rollback risk classification logic for xiNAS configuration changes."""
from __future__ import annotations

from typing import Optional

from .models import DiffResult, Manifest, OperationType, RollbackClass


# ---------------------------------------------------------------------------
# Internal classification tables
# ---------------------------------------------------------------------------

# Operations that unconditionally map to a single risk class.
_OPERATION_CLASS: dict[OperationType, RollbackClass] = {
    # RAID — structural changes destroy data
    OperationType.RAID_CREATE: RollbackClass.DESTROYING_DATA,
    OperationType.RAID_DELETE: RollbackClass.DESTROYING_DATA,
    # Filesystem — create/delete imply format/removal
    OperationType.FS_CREATE: RollbackClass.DESTROYING_DATA,
    OperationType.FS_DELETE: RollbackClass.DESTROYING_DATA,
    # Shares — affect client access
    OperationType.SHARE_CREATE: RollbackClass.CHANGING_ACCESS,
    OperationType.SHARE_DELETE: RollbackClass.CHANGING_ACCESS,
    OperationType.SHARE_MODIFY: RollbackClass.CHANGING_ACCESS,
    # Network / NFS service changes — affect connectivity
    OperationType.NETWORK_MODIFY: RollbackClass.CHANGING_ACCESS,
    OperationType.NFS_MODIFY: RollbackClass.CHANGING_ACCESS,
    # Full install / profile selection — always destructive
    OperationType.INSTALL: RollbackClass.DESTROYING_DATA,
    OperationType.PROFILE_SELECT: RollbackClass.DESTROYING_DATA,
    # Rollback itself is classified by what it rolls back to (see
    # classify_rollback), but as a standalone operation default to
    # CHANGING_ACCESS since it restores a prior state.
    OperationType.ROLLBACK: RollbackClass.CHANGING_ACCESS,
}

# Sub-detail keys that refine RAID_MODIFY classification.
_RAID_MODIFY_DESTRUCTIVE_KEYS = frozenset({
    "level_change",
    "device_change",
    "parity_change",
})

_RAID_MODIFY_NON_DISRUPTIVE_KEYS = frozenset({
    "restripe",
    "parameter_change",
})

# Sub-detail keys that refine FS_MODIFY classification.
_FS_MODIFY_DESTRUCTIVE_KEYS = frozenset({
    "reformat",
    "device_change",
    "label_change_reformat",
})

_FS_MODIFY_ACCESS_KEYS = frozenset({
    "mountpoint_change",
    "mount_option_change",
    "unit_enable",
    "unit_disable",
})

# Metadata-only changes — always non-disruptive.
_METADATA_KEYS = frozenset({
    "label",
    "comment",
    "annotation",
    "labels",
    "comments",
    "annotations",
})


# ---------------------------------------------------------------------------
# Risk-level ordering (higher index = higher risk)
# ---------------------------------------------------------------------------

_RISK_ORDER = {
    RollbackClass.NON_DISRUPTIVE: 0,
    RollbackClass.CHANGING_ACCESS: 1,
    RollbackClass.DESTROYING_DATA: 2,
}


def _higher_risk(a: RollbackClass, b: RollbackClass) -> RollbackClass:
    """Return the higher-risk class of *a* and *b*."""
    return a if _RISK_ORDER[a] >= _RISK_ORDER[b] else b


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class RollbackClassifier:
    """Classifies configuration changes by rollback risk level.

    Classification follows a strict precedence rule when multiple changes
    are evaluated together:

        DESTROYING_DATA > CHANGING_ACCESS > NON_DISRUPTIVE
    """

    def classify_operation(
        self,
        operation: OperationType,
        details: Optional[dict] = None,
    ) -> RollbackClass:
        """Classify a single operation.

        Parameters
        ----------
        operation:
            The operation type being performed.
        details:
            Optional dict of sub-detail keys that refine the classification
            for ``RAID_MODIFY`` and ``FS_MODIFY`` operations.  Keys present
            in the dict (with truthy values) are checked against the known
            refinement tables.

        Returns
        -------
        RollbackClass
            The assessed risk level.
        """
        # --- RAID_MODIFY: depends on what exactly changed ----------------
        if operation is OperationType.RAID_MODIFY:
            return self._classify_raid_modify(details)

        # --- FS_MODIFY: depends on what exactly changed ------------------
        if operation is OperationType.FS_MODIFY:
            return self._classify_fs_modify(details)

        # --- Static lookup for everything else ---------------------------
        if operation in _OPERATION_CLASS:
            return _OPERATION_CLASS[operation]

        # Unknown operations default to the safest assumption.
        return RollbackClass.NON_DISRUPTIVE

    def classify_diff(self, diff: DiffResult) -> RollbackClass:
        """Classify the overall risk of a diff between two snapshots.

        Examines every change entry in *diff* and returns the highest risk
        class found.  If the diff already carries a ``rollback_class`` it is
        included in the resolution.
        """
        overall = RollbackClass.NON_DISRUPTIVE

        # Honour any pre-set class on the diff itself.
        if diff.rollback_class:
            try:
                overall = _higher_risk(overall, RollbackClass(diff.rollback_class))
            except ValueError:
                pass

        for change in diff.config_changes:
            cls = self._classify_change_entry(change)
            overall = _higher_risk(overall, cls)

        for change in diff.runtime_changes:
            cls = self._classify_change_entry(change)
            overall = _higher_risk(overall, cls)

        return overall

    def classify_rollback(
        self,
        current_manifest: Manifest,
        target_manifest: Manifest,
    ) -> RollbackClass:
        """Classify the risk of rolling back from *current* to *target*.

        The risk is determined by the highest-risk operation involved in
        either the current or target manifest.
        """
        overall = RollbackClass.NON_DISRUPTIVE

        for manifest in (current_manifest, target_manifest):
            if manifest.rollback_class:
                try:
                    overall = _higher_risk(overall, RollbackClass(manifest.rollback_class))
                except ValueError:
                    pass

            if manifest.operation:
                try:
                    op = OperationType(manifest.operation)
                    op_class = self.classify_operation(op)
                    overall = _higher_risk(overall, op_class)
                except ValueError:
                    pass

        return overall

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _classify_raid_modify(details: Optional[dict]) -> RollbackClass:
        """Refine classification for RAID_MODIFY based on sub-details."""
        if not details:
            # No details provided — assume worst case.
            return RollbackClass.DESTROYING_DATA

        has_destructive = any(
            details.get(k) for k in _RAID_MODIFY_DESTRUCTIVE_KEYS
        )
        if has_destructive:
            return RollbackClass.DESTROYING_DATA

        has_non_disruptive = any(
            details.get(k) for k in _RAID_MODIFY_NON_DISRUPTIVE_KEYS
        )
        if has_non_disruptive:
            return RollbackClass.NON_DISRUPTIVE

        # Metadata-only RAID changes.
        if all(k in _METADATA_KEYS for k in details if details[k]):
            return RollbackClass.NON_DISRUPTIVE

        # Unknown detail keys — default to destructive (safe).
        return RollbackClass.DESTROYING_DATA

    @staticmethod
    def _classify_fs_modify(details: Optional[dict]) -> RollbackClass:
        """Refine classification for FS_MODIFY based on sub-details."""
        if not details:
            return RollbackClass.DESTROYING_DATA

        has_destructive = any(
            details.get(k) for k in _FS_MODIFY_DESTRUCTIVE_KEYS
        )
        if has_destructive:
            return RollbackClass.DESTROYING_DATA

        has_access = any(
            details.get(k) for k in _FS_MODIFY_ACCESS_KEYS
        )
        if has_access:
            return RollbackClass.CHANGING_ACCESS

        # Metadata-only FS changes.
        if all(k in _METADATA_KEYS for k in details if details[k]):
            return RollbackClass.NON_DISRUPTIVE

        # Unknown detail keys — default to destructive (safe).
        return RollbackClass.DESTROYING_DATA

    @staticmethod
    def _classify_change_entry(change: dict) -> RollbackClass:
        """Classify a single change dict from a DiffResult.

        Change dicts may contain a ``change_type`` key with values like
        ``"raid_create"``, ``"fs_delete"``, ``"share_modify"`` etc., which
        map to OperationType values.  They may also carry an explicit
        ``rollback_class`` key.
        """
        # Explicit class takes precedence.
        explicit = change.get("rollback_class")
        if explicit:
            try:
                return RollbackClass(explicit)
            except ValueError:
                pass

        change_type = change.get("change_type", "")

        # Try to map change_type to an OperationType.
        try:
            op = OperationType(change_type)
            if op in _OPERATION_CLASS:
                return _OPERATION_CLASS[op]
        except ValueError:
            pass

        # Heuristic: file-path based classification.
        file_path = change.get("file", change.get("resource", ""))
        if file_path:
            if "raid" in file_path or "mdadm" in file_path:
                return RollbackClass.DESTROYING_DATA
            if "export" in file_path or "nfs" in file_path:
                return RollbackClass.CHANGING_ACCESS
            if "netplan" in file_path or "network" in file_path:
                return RollbackClass.CHANGING_ACCESS
            if "fstab" in file_path or "mount" in file_path:
                return RollbackClass.CHANGING_ACCESS

        # Default to non-disruptive for unrecognised entries.
        return RollbackClass.NON_DISRUPTIVE
