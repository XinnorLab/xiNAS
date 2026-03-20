"""Filesystem-based snapshot store for xiNAS configuration history.

Layout::

    {root}/
        baseline/           -- immutable first-install snapshot
            manifest.yml
            *.yml, *.j2     -- config files
            runtime/        -- gRPC dumps, checksums
        snapshots/          -- rolling snapshots
            {snapshot_id}/
                manifest.yml
                ...
        state/              -- lock, journal
            lock
            lock.meta
            journal.yml
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from .models import Manifest, SnapshotType

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_STORE_PATH = "/var/lib/xinas/config-history"
BASELINE_DIR = "baseline"
SNAPSHOTS_DIR = "snapshots"
STATE_DIR = "state"
RUNTIME_DIR = "runtime"
MANIFEST_FILE = "manifest.yml"

_DIR_MODE = 0o700
_FILE_MODE = 0o600


class FilesystemStore:
    """CRUD operations for configuration snapshots stored on disk."""

    def __init__(self, root: str = DEFAULT_STORE_PATH) -> None:
        self._root = Path(root)

    # -- path helpers -------------------------------------------------------

    @property
    def root(self) -> Path:
        return self._root

    @property
    def baseline_path(self) -> Path:
        return self._root / BASELINE_DIR

    @property
    def snapshots_path(self) -> Path:
        return self._root / SNAPSHOTS_DIR

    @property
    def state_path(self) -> Path:
        return self._root / STATE_DIR

    def snapshot_path(self, snapshot_id: str) -> Path:
        """Get the filesystem path for a snapshot ID."""
        return self.snapshots_path / snapshot_id

    # -- directory bootstrapping --------------------------------------------

    def ensure_dirs(self) -> None:
        """Create the store directory structure if missing.  Directories are
        created with mode 0o700."""
        for d in (self._root, self.baseline_path, self.snapshots_path,
                  self.state_path):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(str(d), _DIR_MODE)

    # -- write --------------------------------------------------------------

    def write_snapshot(
        self,
        snapshot_id: str,
        manifest: Manifest,
        config_files: Dict[str, bytes],
        runtime_files: Dict[str, bytes],
        is_baseline: bool = False,
    ) -> Path:
        """Write a complete snapshot to disk atomically.

        Args:
            snapshot_id: Unique ID for this snapshot.
            manifest: Snapshot manifest dataclass.
            config_files: ``{filename: content}`` for config files to store.
            runtime_files: ``{filename: content}`` for the ``runtime/``
                subdirectory.
            is_baseline: If ``True``, write to ``baseline/`` instead of
                ``snapshots/{id}/``.

        Returns:
            Path to the created snapshot directory.

        Raises:
            FileExistsError: If *snapshot_id* (or baseline) already exists.
            OSError: If the write fails for any other reason.
        """
        if is_baseline:
            target = self.baseline_path
        else:
            target = self.snapshot_path(snapshot_id)

        if target.exists():
            raise FileExistsError(
                "Snapshot path already exists: {}".format(target)
            )

        # Ensure parent directories exist.
        target.parent.mkdir(parents=True, exist_ok=True)

        # Write into a temporary directory on the *same* filesystem so that
        # os.rename() is atomic.
        tmp_dir = tempfile.mkdtemp(
            dir=str(target.parent), prefix=".tmp-{}-".format(snapshot_id)
        )
        try:
            tmp = Path(tmp_dir)

            # -- manifest
            self._write_yaml(tmp / MANIFEST_FILE, manifest.to_dict())

            # -- config files
            for name, content in config_files.items():
                self._write_bytes(tmp / name, content)

            # -- runtime files
            if runtime_files:
                rt_dir = tmp / RUNTIME_DIR
                rt_dir.mkdir(mode=_DIR_MODE)
                for name, content in runtime_files.items():
                    self._write_bytes(rt_dir / name, content)

            # Set directory permission before the rename.
            os.chmod(tmp_dir, _DIR_MODE)

            # Atomic rename.
            os.rename(tmp_dir, str(target))
        except Exception:
            # Clean up partial writes.
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        return target

    # -- read ---------------------------------------------------------------

    def read_manifest(self, snapshot_id: str) -> Optional[Manifest]:
        """Read manifest for a snapshot.  Returns ``None`` if not found."""
        manifest_path = self.snapshot_path(snapshot_id) / MANIFEST_FILE
        return self._load_manifest(manifest_path)

    def read_baseline_manifest(self) -> Optional[Manifest]:
        """Read the baseline manifest.  Returns ``None`` if no baseline."""
        manifest_path = self.baseline_path / MANIFEST_FILE
        return self._load_manifest(manifest_path)

    def read_file(self, snapshot_id: str, filename: str) -> Optional[bytes]:
        """Read a specific file from a snapshot."""
        path = self.snapshot_path(snapshot_id) / filename
        return self._read_bytes(path)

    def read_runtime_file(
        self, snapshot_id: str, filename: str
    ) -> Optional[bytes]:
        """Read a file from the ``runtime/`` subdirectory of a snapshot."""
        path = self.snapshot_path(snapshot_id) / RUNTIME_DIR / filename
        return self._read_bytes(path)

    # -- listing / queries --------------------------------------------------

    def list_snapshots(self) -> List[Manifest]:
        """List all snapshots (excluding baseline), sorted by timestamp
        ascending."""
        manifests: List[Manifest] = []
        if not self.snapshots_path.is_dir():
            return manifests

        for entry in self.snapshots_path.iterdir():
            if not entry.is_dir():
                continue
            m = self._load_manifest(entry / MANIFEST_FILE)
            if m is not None:
                manifests.append(m)

        manifests.sort(key=lambda m: m.timestamp)
        return manifests

    def get_baseline(self) -> Optional[Manifest]:
        """Get the baseline manifest, or ``None``."""
        return self.read_baseline_manifest()

    def has_baseline(self) -> bool:
        return (self.baseline_path / MANIFEST_FILE).is_file()

    def snapshot_exists(self, snapshot_id: str) -> bool:
        return (self.snapshot_path(snapshot_id) / MANIFEST_FILE).is_file()

    # -- purge --------------------------------------------------------------

    def purge_all(self) -> None:
        """Remove all snapshots, baseline, and state.  Recreate empty dirs."""
        for d in (self.baseline_path, self.snapshots_path, self.state_path):
            if d.is_dir():
                shutil.rmtree(str(d))
        self.ensure_dirs()

    # -- mutate / delete ----------------------------------------------------

    def delete_snapshot(self, snapshot_id: str) -> bool:
        """Delete a snapshot directory.

        Returns ``True`` if deleted, ``False`` if not found.

        Raises:
            ValueError: If the caller attempts to delete the baseline.
        """
        target = self.snapshot_path(snapshot_id)

        # Guard: refuse to delete baseline by checking if the resolved path
        # matches baseline_path.
        if target.resolve() == self.baseline_path.resolve():
            raise ValueError("Refusing to delete the baseline snapshot")

        # Also check by snapshot type from manifest if available.
        manifest = self._load_manifest(target / MANIFEST_FILE)
        if manifest is not None and manifest.type == SnapshotType.BASELINE.value:
            raise ValueError("Refusing to delete a baseline snapshot")

        if not target.is_dir():
            return False

        shutil.rmtree(str(target))
        return True

    def update_manifest(self, snapshot_id: str, manifest: Manifest) -> None:
        """Update the manifest for an existing snapshot (e.g. change status).

        Uses atomic write-to-temp-then-rename to avoid corruption.
        """
        snap_dir = self.snapshot_path(snapshot_id)
        manifest_path = snap_dir / MANIFEST_FILE
        if not snap_dir.is_dir():
            raise FileNotFoundError(
                "Snapshot directory not found: {}".format(snap_dir)
            )
        self._write_yaml_atomic(manifest_path, manifest.to_dict())

    def get_snapshot_size_bytes(self, snapshot_id: str) -> int:
        """Calculate total size of a snapshot directory in bytes."""
        snap_dir = self.snapshot_path(snapshot_id)
        if not snap_dir.is_dir():
            return 0
        total = 0
        for dirpath, _dirnames, filenames in os.walk(str(snap_dir)):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                try:
                    total += os.path.getsize(fp)
                except OSError:
                    pass
        return total

    # -- private helpers ----------------------------------------------------

    @staticmethod
    def _write_bytes(path: Path, content: bytes) -> None:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, _FILE_MODE)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(content)
        except Exception:
            os.close(fd)
            raise

    @staticmethod
    def _write_yaml(path: Path, data: dict) -> None:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, _FILE_MODE)
        try:
            with os.fdopen(fd, "w") as fh:
                yaml.safe_dump(data, fh, default_flow_style=False, sort_keys=False)
        except Exception:
            os.close(fd)
            raise

    @staticmethod
    def _write_yaml_atomic(path: Path, data: dict) -> None:
        """Atomic overwrite of an existing YAML file."""
        fd, tmp = tempfile.mkstemp(
            dir=str(path.parent), suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w") as fh:
                yaml.safe_dump(data, fh, default_flow_style=False, sort_keys=False)
            os.chmod(tmp, _FILE_MODE)
            os.replace(tmp, str(path))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def _load_manifest(path: Path) -> Optional[Manifest]:
        if not path.is_file():
            return None
        try:
            with open(str(path), "r") as fh:
                data = yaml.safe_load(fh)
            if not isinstance(data, dict):
                return None
            return Manifest.from_dict(data)
        except (yaml.YAMLError, OSError):
            return None

    @staticmethod
    def _read_bytes(path: Path) -> Optional[bytes]:
        if not path.is_file():
            return None
        try:
            return path.read_bytes()
        except OSError:
            return None
