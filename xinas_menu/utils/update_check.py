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
        loop = asyncio.get_running_loop()
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
        """Run git pull and redeploy changed components. Call from a thread (blocking)."""
        if self._repo is None:
            return False, "no repo found"
        try:
            out = _git_output(self._repo, "pull", "--ff-only")
            self._sync_nfs_helper()
            return True, out
        except Exception as exc:
            return False, str(exc)

    def _sync_nfs_helper(self) -> None:
        """Copy nfs-helper sources to installed location and restart the service."""
        if self._repo is None:
            return
        src = self._repo / "xiNAS-MCP" / "nfs-helper"
        dest = Path("/usr/lib/xinas-mcp/nfs-helper")
        if not src.is_dir() or not dest.is_dir():
            return
        import shutil
        for py_file in src.glob("*.py"):
            shutil.copy2(py_file, dest / py_file.name)
        subprocess.run(
            ["systemctl", "restart", "xinas-nfs-helper"],
            capture_output=True, timeout=15,
        )

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
