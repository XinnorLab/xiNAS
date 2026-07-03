"""UpdateChecker — GitHub-Releases-only update detection and apply.

xiNAS updates come from published GitHub Releases and nothing else.
See docs/Installer/update-spec.md for the full contract. In short:

  * the check reads the installed version and queries the GitHub
    Releases API — it never touches git and never inspects a branch;
  * drafts are always ignored; prereleases are ignored unless the
    prerelease channel is explicitly enabled;
  * the newest published release tag is compared to the installed
    version with semantic-version ordering (``v1.2.3`` == ``1.2.3``);
  * apply checks out the release *tag* (detached HEAD) — it never
    pulls ``main``/``master`` and never downloads a branch archive;
  * on API failure or a missing required asset the checker returns a
    clear error and does NOT fall back to a branch.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

_TRAILER_RE = re.compile(r"^Requires-Rebuild:\s*(.+)$", re.MULTILINE | re.IGNORECASE)

# Repository of record. Overridable via env for forks / dev mirrors, but the
# default — and the only production source — is XinnorLab/xiNAS.
_DEFAULT_REPO = os.environ.get("XINAS_UPDATE_REPO", "XinnorLab/xiNAS")

# A release ref we are willing to check out: a semver tag, optionally
# ``v``-prefixed, optionally with a prerelease suffix. Deliberately rejects
# branch names like ``main``/``master``/``origin/main`` and ``HEAD``.
_TAG_RE = re.compile(r"^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


class UpdateCheckError(Exception):
    """Raised inside the checker when the GitHub API cannot be consulted."""


def parse_rebuild_trailers(message_bodies: str) -> tuple[str, ...]:
    """Extract Ansible tags from ``Requires-Rebuild:`` trailers.

    The trailer is a free-form, comma-separated list of ansible-playbook
    ``--tags`` values. The special value ``all`` means "run site.yml
    without --tags" — it MUST short-circuit other tags so we don't pass
    ``--tags all,foo`` which would silently skip ``foo``-only tasks.

    With release-based updates the trailers are read from the release
    notes body (which aggregates the trailers of the commits it ships).
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


# ── semantic versioning ──────────────────────────────────────────────────


def _parse_semver(tag: str) -> tuple[int, int, int, tuple[str, ...]] | None:
    """Parse ``vX.Y.Z`` / ``X.Y.Z`` (optionally ``-pre``) → comparable parts.

    Returns ``(major, minor, patch, prerelease_ids)`` or ``None`` when the
    string is not a semver tag (e.g. a branch name like ``main``). Build
    metadata (``+...``) is ignored, per semver.
    """
    if not tag:
        return None
    s = tag.strip()
    if s[:1] in ("v", "V"):
        s = s[1:]
    s = s.split("+", 1)[0]
    core, _, pre = s.partition("-")
    parts = core.split(".")
    if len(parts) != 3:
        return None
    try:
        major, minor, patch = (int(p) for p in parts)
    except ValueError:
        return None
    pre_ids = tuple(pre.split(".")) if pre else ()
    return (major, minor, patch, pre_ids)


def _semver_key(parsed: tuple[int, int, int, tuple[str, ...]]):
    """Sort key implementing semver precedence.

    A final release outranks any prerelease of the same ``X.Y.Z`` (the
    ``1`` vs ``0`` flag decides before the prerelease identifiers are
    considered). Prerelease identifiers compare numerically when numeric,
    lexically otherwise, with numeric identifiers ranking below alphanumeric.
    """
    major, minor, patch, pre_ids = parsed
    if not pre_ids:
        return (major, minor, patch, 1, ())
    key_ids = tuple((0, int(i)) if i.isdigit() else (1, i) for i in pre_ids)
    return (major, minor, patch, 0, key_ids)


def installed_version() -> str:
    """Installed xiNAS version string (e.g. ``3.1.0``)."""
    from xinas_menu.version import XINAS_MENU_VERSION

    return XINAS_MENU_VERSION


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a single update check.

    ``available`` is True only when the check succeeded *and* the latest
    published release is strictly newer than the installed version.
    ``error`` is None on success and a short human-readable string on any
    failure (network, HTTP error, rate limit, malformed response, missing
    required asset, …). Treating "error" as "no update available" is the
    silent-failure bug this class exists to prevent — callers MUST check
    ``error`` and surface it, and MUST NOT fall back to a branch.

    ``required_rebuilds`` is the tuple of ansible-playbook ``--tags``
    values parsed from the release-notes ``Requires-Rebuild:`` trailers.
    Empty tuple means a code-only update. ``("all",)`` means run
    ``site.yml`` without ``--tags``.
    """

    available: bool
    error: str | None = None
    current_version: str = ""
    latest_version: str = ""
    release_notes: str = ""
    download_url: str = ""
    required_rebuilds: tuple[str, ...] = field(default_factory=tuple)


def format_update_prompt(result: CheckResult) -> str:
    """Human-facing confirm-dialog body for an available update."""
    cur = result.current_version or "?"
    new = result.latest_version or "?"
    lines = ["An update is available.", "", f"Current: {cur}  →  Latest: {new}"]
    if result.download_url:
        lines.append(f"Source: {result.download_url}")
    notes = (result.release_notes or "").strip()
    if notes:
        excerpt = notes if len(notes) <= 500 else notes[:500].rstrip() + " …"
        lines += ["", "Release notes:", excerpt]
    if result.required_rebuilds:
        what = (
            "the full site.yml"
            if result.required_rebuilds == ("all",)
            else ", ".join(result.required_rebuilds)
        )
        lines += ["", f"⚠ This update re-applies Ansible: {what}"]
    lines += ["", "Apply now?"]
    return "\n".join(lines)


# ── GitHub Releases API ──────────────────────────────────────────────────


def _releases_url(repo: str) -> str:
    return f"https://api.github.com/repos/{repo}/releases?per_page=30"


def _fetch_releases(repo: str, timeout: float = 8.0) -> list[dict]:
    """GET the repo's releases from the GitHub API. Raises on any failure.

    Never returns partial/garbage on error — the caller converts the
    raised exception into a ``CheckResult`` error string. There is no
    branch fallback anywhere in this path.
    """
    req = urllib.request.Request(
        _releases_url(repo),
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "xinas-update-check",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    token = os.environ.get("XINAS_GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as exc:
        raise UpdateCheckError(f"GitHub API HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise UpdateCheckError(f"GitHub API unreachable: {reason}") from exc
    try:
        data = json.loads(payload)
    except (ValueError, TypeError) as exc:
        raise UpdateCheckError("GitHub API returned malformed JSON") from exc
    if not isinstance(data, list):
        raise UpdateCheckError("GitHub API returned an unexpected payload")
    return data


class UpdateChecker:
    """Detects and applies xiNAS updates from published GitHub Releases.

    Usage::

        checker = UpdateChecker()
        result = await checker.check()
        if result.error:
            notify(f"Check failed: {result.error}")   # do NOT fall back
        elif result.available:
            ...prompt with format_update_prompt(result)...
            ok, msg = checker.apply_update(result.latest_version)
    """

    def __init__(
        self,
        repo_path: Path | None = None,
        *,
        repo: str = _DEFAULT_REPO,
        channel: str | None = None,
        current_version: str | None = None,
        required_asset: str | None = None,
        releases_fetcher=None,
    ) -> None:
        self._repo = repo_path or _find_repo_root()
        self._repo_slug = repo
        self._channel = (channel or os.environ.get("XINAS_UPDATE_CHANNEL", "stable")).lower()
        self._current = current_version if current_version is not None else installed_version()
        self._required_asset = required_asset
        # Injectable seam for tests; production uses the real API.
        self._fetch = releases_fetcher or (lambda: _fetch_releases(self._repo_slug))

    @property
    def allow_prerelease(self) -> bool:
        return self._channel == "prerelease"

    async def check(self) -> CheckResult:
        """Query the Releases API and compare versions. Non-blocking."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._check_sync)

    def _check_sync(self) -> CheckResult:
        try:
            raw = self._fetch()
        except UpdateCheckError as exc:
            return CheckResult(False, str(exc), current_version=self._current)
        except Exception as exc:  # noqa: BLE001 — any fetch failure is an error, not "no update"
            return CheckResult(False, f"update check failed: {exc}", current_version=self._current)

        # Filter: drop drafts always; drop prereleases unless opted in; drop
        # anything whose tag is not semver. NEVER consider a branch.
        candidates: list[tuple[tuple, dict]] = []
        for rel in raw:
            if not isinstance(rel, dict):
                continue
            if rel.get("draft"):
                continue
            if rel.get("prerelease") and not self.allow_prerelease:
                continue
            parsed = _parse_semver(str(rel.get("tag_name", "")))
            if parsed is None:
                continue
            candidates.append((_semver_key(parsed), rel))

        if not candidates:
            return CheckResult(
                False,
                current_version=self._current,
                error=None,
            )

        _key, latest = max(candidates, key=lambda kv: kv[0])
        latest_tag = str(latest.get("tag_name", ""))

        cur_parsed = _parse_semver(self._current)
        latest_parsed = _parse_semver(latest_tag)
        is_newer = (
            cur_parsed is not None
            and latest_parsed is not None
            and _semver_key(latest_parsed) > _semver_key(cur_parsed)
        )
        if not is_newer:
            return CheckResult(
                False,
                current_version=self._current,
                latest_version=latest_tag,
            )

        # A newer release exists. Enforce the required-asset contract before
        # reporting it as applicable — a missing asset is an error, not a
        # reason to reach for a branch.
        download_url = latest.get("html_url", "") or ""
        if self._required_asset:
            match = _find_asset(latest, self._required_asset)
            if match is None:
                return CheckResult(
                    False,
                    error=(
                        f"release {latest_tag} is missing required asset '{self._required_asset}'"
                    ),
                    current_version=self._current,
                    latest_version=latest_tag,
                )
            download_url = match

        rebuilds = parse_rebuild_trailers(str(latest.get("body", "") or ""))
        return CheckResult(
            True,
            current_version=self._current,
            latest_version=latest_tag,
            release_notes=str(latest.get("body", "") or ""),
            download_url=download_url,
            required_rebuilds=rebuilds,
        )

    def apply_update(self, tag: str) -> tuple[bool, str]:
        """Check out the release *tag* and redeploy. Call from a thread.

        Never pulls a branch: the only accepted ref is a semver release
        tag. A non-tag ref (``main``, ``origin/main``, ``HEAD``, …) is
        refused outright.
        """
        if not tag or not _TAG_RE.match(tag):
            return False, f"refusing to check out non-release ref: {tag!r}"
        if self._repo is None:
            return False, "no repo found"
        try:
            _privileged_git(self._repo, "fetch")
            out = _privileged_git(self._repo, "checkout", tag)
            self._sync_nfs_helper()
            return True, out or f"checked out {tag}"
        except subprocess.CalledProcessError as exc:
            return False, _short_git_error(exc)
        except Exception as exc:  # noqa: BLE001 — surface any apply failure verbatim
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
            capture_output=True,
            timeout=15,
        )

    @staticmethod
    def restart_self() -> None:
        """Replace the current process with a fresh copy (exec)."""
        os.execv(sys.executable, [sys.executable, "-m", "xinas_menu"] + sys.argv[1:])


def _find_asset(release: dict, name: str) -> str | None:
    """Return the download URL of the named asset, or None if absent."""
    for asset in release.get("assets", []) or []:
        if isinstance(asset, dict) and asset.get("name") == name:
            return asset.get("browser_download_url") or asset.get("url")
    return None


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


def _privileged_git(repo: Path, action: str, *extra: str) -> str:
    """Run a privileged git operation via the sudo helper.

    `action` is one of `fetch` or `checkout <tag>` — the only operations
    the wrapper script accepts. `checkout` takes the release tag as its
    single extra argument.

    The Ansible-deployed wrapper at /usr/local/sbin/xinas-update-git is
    granted passwordless sudo for the xinnor user, so writes to the
    root-owned /opt/xiNAS .git directory succeed without prompting.

    If the wrapper is not deployed (older install), fall back to
    invoking git directly — which will fail with EACCES when the repo
    is root-owned, and our caller surfaces that error to the user with
    a hint to redeploy. The fallback still targets the release tag —
    never ``main``.
    """
    if _PRIVILEGED_HELPER.exists() and os.access(_PRIVILEGED_HELPER, os.X_OK):
        r = subprocess.run(
            ["sudo", "-n", str(_PRIVILEGED_HELPER), action, *extra],
            check=True,
            capture_output=True,
            text=True,
        )
        return r.stdout.strip()
    # Fallback: direct git invocation (used on hosts where the role hasn't
    # been re-deployed since this change landed).
    if action == "fetch":
        return _git_output(repo, "fetch", "origin", "--tags", "--quiet")
    if action == "checkout":
        if not extra:
            raise ValueError("checkout requires a tag argument")
        return _git_output(repo, "checkout", "--quiet", extra[0])
    raise ValueError(f"unknown privileged action: {action}")


def _short_git_error(exc: subprocess.CalledProcessError) -> str:
    """Extract a single readable error line from a failed git invocation."""
    stderr = exc.stderr or b""
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
