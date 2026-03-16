"""Global configuration lock and transaction journal."""
from __future__ import annotations

import fcntl
import getpass
import json
import os
import tempfile
import time
import datetime
import uuid
from pathlib import Path
from typing import Optional

import yaml


class LockError(Exception):
    """Raised when lock cannot be acquired."""
    pass


class GlobalConfigLock:
    """Process-level exclusive lock for configuration mutations.

    Uses fcntl.flock() for kernel-level locking.
    Persists transaction state in a journal for crash recovery.

    Usage::

        lock = GlobalConfigLock(state_dir="/var/lib/xinas/config-history/state")

        if lock.acquire(operation="raid_create", source="xinas_menu"):
            try:
                lock.update_journal(phase="executing")
                # ... do work ...
                lock.update_journal(phase="completed")
            finally:
                lock.release()
    """

    LOCK_FILE = "lock"
    LOCK_META_FILE = "lock.meta"
    JOURNAL_FILE = "journal.yml"

    # Valid journal phases in lifecycle order.
    _PHASES = (
        "preflight",
        "snapshot_created",
        "executing",
        "validating",
        "completed",
        "failed",
        "rolling_back",
    )

    def __init__(self, state_dir: str) -> None:
        self._state_dir = Path(state_dir)
        self._lock_fd: Optional[int] = None
        self._locked = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def acquire(
        self,
        operation: str,
        source: str,
        pre_change_snapshot: str = "",
        target_snapshot: str = "",
    ) -> bool:
        """Acquire the global configuration lock.

        Returns True if acquired, raises LockError if another operation
        is active.

        Writes lock metadata and initialises the transaction journal.
        """
        self._state_dir.mkdir(parents=True, exist_ok=True)

        lock_path = self._state_dir / self.LOCK_FILE

        # Open (or create) the lock file.
        fd = os.open(
            str(lock_path),
            os.O_WRONLY | os.O_CREAT,
            0o600,
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            # Try to give a helpful error message.
            info = self.get_lock_info()
            if info:
                holder = (
                    "pid={pid}, operation={operation}, user={user}, "
                    "source={source}, started={started}"
                ).format(**{k: info.get(k, "?") for k in (
                    "pid", "operation", "user", "source", "started",
                )})
                raise LockError(
                    "Configuration lock held by another process: {}".format(holder)
                )
            raise LockError("Configuration lock held by another process")

        self._lock_fd = fd
        self._locked = True

        # Persist metadata & journal.
        try:
            user = getpass.getuser()
        except Exception:
            user = "unknown"

        self._write_lock_meta(operation, source, pre_change_snapshot)

        now = datetime.datetime.utcnow().isoformat() + "Z"
        journal = {
            "transaction_id": str(uuid.uuid4()),
            "operation": operation,
            "phase": "preflight",
            "pre_change_snapshot": pre_change_snapshot,
            "target_snapshot": target_snapshot,
            "user": user,
            "source": source,
            "started": now,
            "last_updated": now,
            "steps_completed": [],
            "steps_remaining": [],
            "error": "",
        }
        self._write_journal(journal)

        return True

    def release(self) -> None:
        """Release the lock, clean up metadata and journal."""
        if self._lock_fd is not None:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(self._lock_fd)
            except OSError:
                pass
            self._lock_fd = None

        self._locked = False
        self._clear_lock_files()

    @property
    def is_locked(self) -> bool:
        """Return True if this instance currently holds the lock."""
        return self._locked

    def get_lock_info(self) -> Optional[dict]:
        """Read lock metadata.  Returns None if no lock held."""
        meta_path = self._state_dir / self.LOCK_META_FILE
        if not meta_path.is_file():
            return None
        try:
            with open(str(meta_path), "r") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, OSError):
            return None

    def get_journal(self) -> Optional[dict]:
        """Read the current transaction journal.  Returns None if absent."""
        journal_path = self._state_dir / self.JOURNAL_FILE
        if not journal_path.is_file():
            return None
        try:
            with open(str(journal_path), "r") as fh:
                data = yaml.safe_load(fh)
            if isinstance(data, dict):
                return data
            return None
        except (yaml.YAMLError, OSError):
            return None

    def update_journal(
        self,
        phase: Optional[str] = None,
        step_completed: Optional[str] = None,
        step_remaining: Optional[str] = None,
        error: Optional[str] = None,
        target_snapshot: Optional[str] = None,
        pre_change_snapshot: Optional[str] = None,
    ) -> None:
        """Update the transaction journal atomically.

        Any parameter that is ``None`` is left unchanged.
        """
        journal = self.get_journal()
        if journal is None:
            return

        if phase is not None:
            journal["phase"] = phase
        if step_completed is not None:
            completed = journal.get("steps_completed", [])
            completed.append(step_completed)
            journal["steps_completed"] = completed
        if step_remaining is not None:
            remaining = journal.get("steps_remaining", [])
            remaining.append(step_remaining)
            journal["steps_remaining"] = remaining
        if error is not None:
            journal["error"] = error
        if target_snapshot is not None:
            journal["target_snapshot"] = target_snapshot
        if pre_change_snapshot is not None:
            journal["pre_change_snapshot"] = pre_change_snapshot

        journal["last_updated"] = datetime.datetime.utcnow().isoformat() + "Z"
        self._write_journal(journal)

    # ------------------------------------------------------------------
    # Stale lock detection & recovery
    # ------------------------------------------------------------------

    def check_stale_lock(self) -> Optional[dict]:
        """Check for a stale lock from a crashed process.

        Returns lock info dict if a stale lock is found, None otherwise.
        A lock is stale if the PID in lock.meta is no longer running.
        """
        info = self.get_lock_info()
        if info is None:
            return None

        pid = info.get("pid")
        if pid is None:
            return None

        try:
            os.kill(int(pid), 0)
            # Process still alive — not stale.
            return None
        except (OSError, ValueError):
            # Process gone — stale.
            return info

    def recover_stale_lock(self) -> dict:
        """Recover from a stale lock.

        1. Read lock.meta and journal.
        2. Determine recovery action based on journal phase.
        3. Clear lock files.
        4. Return recovery report dict.

        Recovery logic:
        - phase=preflight or snapshot_created: safe cleanup, delete ephemeral
        - phase=executing or rolling_back: mark as interrupted, keep
          pre-change snapshot
        - phase=completed: just clear (was already done)
        - phase=failed: just clear
        """
        info = self.get_lock_info() or {}
        journal = self.get_journal() or {}
        phase = journal.get("phase", "unknown")

        report: dict = {
            "recovered": True,
            "phase": phase,
            "operation": journal.get("operation", info.get("operation", "unknown")),
            "pid": info.get("pid"),
            "action": "",
            "pre_change_snapshot": journal.get(
                "pre_change_snapshot", info.get("pre_change_snapshot", "")
            ),
        }

        if phase in ("preflight", "snapshot_created"):
            report["action"] = (
                "safe_cleanup: operation never reached execution, "
                "ephemeral artefacts may be deleted"
            )
        elif phase in ("executing", "rolling_back"):
            report["action"] = (
                "interrupted: operation was in progress, "
                "pre-change snapshot preserved for manual recovery"
            )
        elif phase == "completed":
            report["action"] = "clear: operation had already completed successfully"
        elif phase == "failed":
            report["action"] = "clear: operation had already failed"
        elif phase == "validating":
            report["action"] = (
                "interrupted_validation: post-apply validation was in progress, "
                "pre-change snapshot preserved for manual review"
            )
        else:
            report["action"] = "clear: unknown phase, lock files removed"

        # Clear the stale lock files (but NOT the flock file descriptor
        # since we don't hold it).
        self._clear_lock_files()

        return report

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _write_lock_meta(
        self, operation: str, source: str, pre_change_snapshot: str,
    ) -> None:
        """Write lock metadata as JSON."""
        try:
            user = getpass.getuser()
        except Exception:
            user = "unknown"

        meta = {
            "pid": os.getpid(),
            "operation": operation,
            "user": user,
            "source": source,
            "started": datetime.datetime.utcnow().isoformat() + "Z",
            "pre_change_snapshot": pre_change_snapshot,
        }

        meta_path = self._state_dir / self.LOCK_META_FILE
        self._atomic_write_json(meta_path, meta)

    def _write_journal(self, journal: dict) -> None:
        """Write transaction journal as YAML (atomic)."""
        journal_path = self._state_dir / self.JOURNAL_FILE
        self._atomic_write_yaml(journal_path, journal)

    def _clear_lock_files(self) -> None:
        """Remove lock metadata and journal files.

        The lock file itself is left in place (it is just a sentinel for
        flock and contains no meaningful data).
        """
        for name in (self.LOCK_META_FILE, self.JOURNAL_FILE):
            path = self._state_dir / name
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass

    # -- atomic file writers ---

    @staticmethod
    def _atomic_write_json(path: Path, data: dict) -> None:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(data, fh, indent=2)
            os.chmod(tmp, 0o600)
            os.replace(tmp, str(path))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    @staticmethod
    def _atomic_write_yaml(path: Path, data: dict) -> None:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                yaml.safe_dump(
                    data, fh, default_flow_style=False, sort_keys=False,
                )
            os.chmod(tmp, 0o600)
            os.replace(tmp, str(path))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
