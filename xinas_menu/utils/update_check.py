"""UpdateChecker — background git fetch; triggers reactive flag in the app."""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path


class UpdateChecker:
    """Checks for upstream git updates in a background task.

    Usage::

        checker = UpdateChecker(repo_path)
        available = await checker.check()   # True if update available
    """

    def __init__(self, repo_path: Path | None = None) -> None:
        self._repo = repo_path or _find_repo_root()

    async def check(self) -> bool:
        """Fetch and compare local HEAD vs origin/main. Non-blocking."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._check_sync)

    def _check_sync(self) -> bool:
        if self._repo is None:
            return False
        try:
            _git(self._repo, "fetch", "origin", "--quiet")
            local = _git_output(self._repo, "rev-parse", "HEAD")
            remote = _git_output(self._repo, "rev-parse", "origin/main")
            return local != remote
        except Exception:
            return False

    def apply_update(self) -> tuple[bool, str]:
        """Run git pull. Call from a thread (blocking)."""
        if self._repo is None:
            return False, "no repo found"
        try:
            out = _git_output(self._repo, "pull", "--ff-only")
            return True, out
        except Exception as exc:
            return False, str(exc)

    @staticmethod
    def restart_self() -> None:
        """Replace the current process with a fresh copy (exec)."""
        os.execv(sys.executable, [sys.executable, "-m", "xinas_menu"] + sys.argv[1:])


def _find_repo_root() -> Path | None:
    candidates = [
        Path("/opt/xiNAS"),
        Path("/home/xinnor/xiNAS"),
        Path(__file__).parent.parent.parent,
    ]
    for p in candidates:
        if (p / ".git").exists():
            return p
    return None


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo)] + list(args),
        check=True,
        capture_output=True,
    )


def _git_output(repo: Path, *args: str) -> str:
    r = subprocess.run(
        ["git", "-C", str(repo)] + list(args),
        check=True,
        capture_output=True,
        text=True,
    )
    return r.stdout.strip()
