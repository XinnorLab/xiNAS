"""AuditLogger — writes user actions to /var/log/xinas/audit.log."""
from __future__ import annotations

import os
import pwd
import time
from pathlib import Path

AUDIT_LOG = Path("/var/log/xinas/audit.log")


class AuditLogger:
    """Thread-safe append-only audit log writer."""

    def __init__(self, log_path: Path = AUDIT_LOG) -> None:
        self._path = log_path
        self._ensure_log_dir()

    def _ensure_log_dir(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
        except OSError:
            pass

    @staticmethod
    def _current_user() -> str:
        try:
            return pwd.getpwuid(os.getuid()).pw_name
        except Exception:
            return os.environ.get("USER", "unknown")

    def log(self, action: str, detail: str = "", status: str = "OK") -> None:
        """Append a single audit entry.

        Format:
            YYYY-MM-DD HH:MM:SS | user | action | STATUS | detail
        """
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        user = self._current_user()
        line = f"{ts} | {user} | {action} | {status}"
        if detail:
            line += f" | {detail}"
        try:
            with self._path.open("a") as fh:
                fh.write(line + "\n")
        except OSError:
            pass

    def log_ok(self, action: str, detail: str = "") -> None:
        self.log(action, detail, "OK")

    def log_fail(self, action: str, detail: str = "") -> None:
        self.log(action, detail, "FAIL")

    def log_start(self, action: str, detail: str = "") -> None:
        self.log(action, detail, "START")


# Module-level singleton
_default_logger: AuditLogger | None = None


def get_audit_logger() -> AuditLogger:
    global _default_logger
    if _default_logger is None:
        _default_logger = AuditLogger()
    return _default_logger


def audit(action: str, detail: str = "", status: str = "OK") -> None:
    get_audit_logger().log(action, detail, status)
