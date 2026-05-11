"""UpdateChecker — background git fetch; triggers reactive flag in the app."""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


_TRAILER_RE = re.compile(r"^Requires-Rebuild:\s*(.+)$", re.MULTILINE | re.IGNORECASE)


def parse_rebuild_trailers(message_bodies: str) -> tuple[str, ...]:
    """Extract Ansible tags from ``Requires-Rebuild:`` trailers.

    The trailer is a free-form, comma-separated list of ansible-playbook
    ``--tags`` values. The special value ``all`` means "run site.yml
    without --tags" — it MUST short-circuit other tags so we don't pass
    ``--tags all,foo`` which would silently skip ``foo``-only tasks.
    """
    tags: set[str] = set()
    for m in _TRAILER_RE.finditer(message_bodies):
        for tag in m.group(1).split(","):
            tag = tag.strip()
            if tag:
                tags.add(tag)
    if "all" in tags:
        return ("all",)
    return tuple(sorted(tags))


def build_rebuild_cmd(tags: tuple[str, ...]) -> list[str]:
    """Build the ansible-playbook argv for *tags*. Returns [] if no rebuild."""
    if not tags:
        return []
    cmd = ["ansible-playbook", "playbooks/site.yml"]
    if tags != ("all",):
        cmd += ["--tags", ",".join(tags)]
    return cmd


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a single update check.

    ``available`` is True only when the check succeeded *and* the local
    HEAD differs from ``origin/main``. ``error`` is None on success and
    a short human-readable string on any failure (network, permissions,
    git not installed, repo not found, …). Treating "error" as "no
    update available" is the silent-failure bug this class exists to
    prevent — callers must check ``error`` and surface it to the user.

    ``required_rebuilds`` is the tuple of ansible-playbook ``--tags``
    values extracted from ``Requires-Rebuild:`` trailers across the
    incoming commits. Empty tuple means a code-only update — apply with
    ``git pull`` + service restart, no ansible run needed. A single
    ``("all",)`` entry means run ``site.yml`` without ``--tags``.
    """

    available: bool
    error: str | None = None
    required_rebuilds: tuple[str, ...] = field(default_factory=tuple)


class UpdateChecker:
    """Checks for upstream git updates in a background task.

    Usage::

        checker = UpdateChecker(repo_path)
        result = await checker.check()
        if result.error:
            notify(f"Check failed: {result.error}")
        elif result.available:
            ...prompt to update...
    """

    def __init__(self, repo_path: Path | None = None) -> None:
        self._repo = repo_path or _find_repo_root()

    async def check(self) -> CheckResult:
        """Fetch and compare local HEAD vs origin/main. Non-blocking."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._check_sync)

    def _check_sync(self) -> CheckResult:
        if self._repo is None:
            return CheckResult(
                False,
                "xiNAS git repo not found (looked in /opt/xiNAS, /home/xinnor/xiNAS)",
            )
        try:
            _privileged_git(self._repo, "fetch")
            local = _git_output(self._repo, "rev-parse", "HEAD")
            remote = _git_output(self._repo, "rev-parse", "origin/main")
            if local == remote:
                return CheckResult(False)
            rebuilds: tuple[str, ...] = ()
            try:
                log_body = _git_output(
                    self._repo, "log", f"{local}..{remote}", "--format=%B"
                )
                rebuilds = parse_rebuild_trailers(log_body)
            except subprocess.CalledProcessError:
                # Trailer parse is best-effort — if `git log` fails we still
                # report the update as available; the user can apply it
                # without an ansible run (we just won't know to run one).
                pass
            return CheckResult(True, required_rebuilds=rebuilds)
        except subprocess.CalledProcessError as exc:
            return CheckResult(False, _short_git_error(exc))
        except FileNotFoundError:
            return CheckResult(False, "git not installed")
        except Exception as exc:  # noqa: BLE001 — last-resort safety net
            return CheckResult(False, str(exc))

    def apply_update(self) -> tuple[bool, str]:
        """Run git pull and redeploy changed components. Call from a thread (blocking)."""
        if self._repo is None:
            return False, "no repo found"
        try:
            out = _privileged_git(self._repo, "pull")
            self._sync_nfs_helper()
            return True, out
        except subprocess.CalledProcessError as exc:
            return False, _short_git_error(exc)
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


_PRIVILEGED_HELPER = Path("/usr/local/sbin/xinas-update-git")


def _git_output(repo: Path, *args: str) -> str:
    """Run a read-only git command and return stdout.

    Uses safe.directory to bypass git's CVE-2022-24765 ownership check,
    so xinas-menu running as a non-root user can still read a repo
    owned by root.
    """
    r = subprocess.run(
        ["git", "-c", f"safe.directory={repo}", "-C", str(repo)] + list(args),
        check=True,
        capture_output=True,
        text=True,
    )
    return r.stdout.strip()


def _privileged_git(repo: Path, action: str) -> str:
    """Run a privileged git command (fetch/pull) via the sudo helper.

    `action` must be one of `fetch` or `pull` — these are the only
    subcommands the wrapper script accepts.

    The Ansible-deployed wrapper at /usr/local/sbin/xinas-update-git is
    granted passwordless sudo for the xinnor user, so writes to the
    root-owned /opt/xiNAS .git directory succeed without prompting.

    If the wrapper is not deployed (older install), fall back to
    invoking git directly — which will fail with EACCES when the repo
    is root-owned, and our caller surfaces that error to the user with
    a hint to redeploy. We do NOT try to silently work around the
    permission issue by, e.g., running git as root via `sudo git ...`,
    because that would require granting `xinnor` blanket sudo on git.
    """
    if _PRIVILEGED_HELPER.exists() and os.access(_PRIVILEGED_HELPER, os.X_OK):
        r = subprocess.run(
            ["sudo", "-n", str(_PRIVILEGED_HELPER), action],
            check=True,
            capture_output=True,
            text=True,
        )
        return r.stdout.strip()
    # Fallback: direct git invocation (used on hosts where the role
    # hasn't been re-deployed since this change landed).
    if action == "fetch":
        return _git_output(repo, "fetch", "origin", "--quiet")
    if action == "pull":
        return _git_output(repo, "pull", "--ff-only")
    raise ValueError(f"unknown privileged action: {action}")


def _short_git_error(exc: subprocess.CalledProcessError) -> str:
    """Extract a single readable error line from a failed git invocation."""
    stderr = (exc.stderr or b"")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")
    stderr = stderr.strip()
    if not stderr:
        return f"git exit {exc.returncode}"
    # Pick the first line containing 'error' or 'fatal' — git's output
    # often has multi-line suggestions that bury the actual cause.
    for line in stderr.splitlines():
        if "error" in line.lower() or "fatal" in line.lower():
            return line
    return stderr.splitlines()[0]
