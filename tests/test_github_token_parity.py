"""The GitHub access token must be honoured identically by every bash path
that talks to GitHub (docs/Installer/update-spec.md "GitHub rate limits and
the access token").

GitHub throttles anonymous requests per source IP — clones over HTTPS as well
as the REST API — so every host behind one NAT shares one quota. A spent
quota surfaces as a 401 on clone/fetch (git then asks for a username) and a
403/429 on the API. The three functions here lift a path onto a token's own
quota, reactively for git (anonymous first, helper only after the 401) and
without ever placing the token in argv.

The block lives canonically in lib/menu_lib.sh and is copied verbatim into
the scripts that cannot source it. The behavioral tests drive the canonical
copy: a stub curl records what reached argv versus stdin, and a throw-away
HTTP server that answers 401 to anonymous requests records whether git
retried with the token. The parity tests then pin every copy to that text.
"""

from __future__ import annotations

import base64
import http.server
import os
import re
import subprocess
import threading
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
LIB = REPO / "lib" / "menu_lib.sh"
INSTALL_SH = REPO / "install.sh"

_BLOCK_RE = re.compile(
    r"^# ── GitHub access token ─+\n.*?^# ── end GitHub access token ─+\n",
    re.M | re.S,
)


def _block(path: Path) -> str:
    m = _BLOCK_RE.search(path.read_text())
    assert m, f"{path.relative_to(REPO)}: no GitHub access token block"
    return m.group(0)


def _clean_env(tmp_path: Path, **extra: str) -> dict[str, str]:
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("XINAS_GH_TOKEN", "GITHUB_TOKEN", "XINAS_GH_TOKEN_FILE")
    }
    env["XINAS_GH_TOKEN_FILE"] = str(tmp_path / "no-such-token-file")
    env.update(extra)
    return env


def _run(script: str, env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", _block(LIB) + "\n" + script],
        env=env,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
    )


# ── xinas_github_token ───────────────────────────────────────────────────────


def test_token_env_beats_file(tmp_path):
    f = tmp_path / "tok"
    f.write_text("from-file\n")
    env = _clean_env(tmp_path, XINAS_GH_TOKEN="from-env", XINAS_GH_TOKEN_FILE=str(f))
    assert _run("xinas_github_token", env, tmp_path).stdout == "from-env"


def test_github_token_env_is_second(tmp_path):
    env = _clean_env(tmp_path, GITHUB_TOKEN="gh-env")
    assert _run("xinas_github_token", env, tmp_path).stdout == "gh-env"


def test_token_file_first_line_trimmed(tmp_path):
    f = tmp_path / "tok"
    f.write_text("  from-file \n# second line ignored\n")
    env = _clean_env(tmp_path, XINAS_GH_TOKEN_FILE=str(f))
    assert _run("xinas_github_token", env, tmp_path).stdout == "from-file"


def test_missing_or_empty_file_means_no_token(tmp_path):
    env = _clean_env(tmp_path)
    assert _run("xinas_github_token", env, tmp_path).stdout == ""
    (tmp_path / "empty").write_text("\n")
    env["XINAS_GH_TOKEN_FILE"] = str(tmp_path / "empty")
    assert _run("xinas_github_token", env, tmp_path).stdout == ""


# ── xinas_gh_curl ────────────────────────────────────────────────────────────


def _stub_curl(tmp_path: Path) -> tuple[Path, Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    argv_log = tmp_path / "curl-argv.log"
    stdin_log = tmp_path / "curl-stdin.log"
    (bin_dir / "curl").write_text(
        "#!/bin/bash\n"
        f'printf \'%s\\n\' "$@" > "{argv_log}"\n'
        f'cat > "{stdin_log}"\n'
        'echo \'{"tag_name": "v9.9.9"}\'\n'
    )
    (bin_dir / "curl").chmod(0o755)
    return bin_dir, argv_log, stdin_log


def test_curl_sends_bearer_header_from_stdin_never_argv(tmp_path):
    bin_dir, argv_log, stdin_log = _stub_curl(tmp_path)
    env = _clean_env(tmp_path, XINAS_GH_TOKEN="sekret")
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    proc = _run("xinas_gh_curl -fsSL https://api.github.com/x", env, tmp_path)
    assert proc.returncode == 0, proc.stderr
    argv = argv_log.read_text().splitlines()
    assert "sekret" not in argv_log.read_text(), "the token must never reach argv"
    assert argv[:2] == ["-K", "-"], argv
    assert argv[2:] == ["-fsSL", "https://api.github.com/x"], argv
    assert stdin_log.read_text() == 'header = "Authorization: Bearer sekret"\n'


def test_curl_is_plain_without_a_token(tmp_path):
    bin_dir, argv_log, stdin_log = _stub_curl(tmp_path)
    env = _clean_env(tmp_path)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    proc = _run("xinas_gh_curl -fsSL https://api.github.com/x", env, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert argv_log.read_text().splitlines() == ["-fsSL", "https://api.github.com/x"]
    assert stdin_log.read_text() == ""


# ── xinas_gh_git ─────────────────────────────────────────────────────────────


class _Server:
    """Answers 401 to anonymous requests, 200 (junk body) to any Authorization."""

    def __init__(self) -> None:
        self.seen: list[str | None] = []
        seen = self.seen

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — http.server API
                auth = self.headers.get("Authorization")
                seen.append(auth)
                if auth is None:
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", 'Basic realm="GitHub"')
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = b"not-a-git-repo\n"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_a):  # silence
                pass

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def _git_env(tmp_path: Path, **extra: str) -> dict[str, str]:
    return _clean_env(tmp_path, GIT_TERMINAL_PROMPT="0", HOME=str(tmp_path), **extra)


def test_git_stays_anonymous_until_401_then_retries_with_the_token(tmp_path):
    with _Server() as srv:
        env = _git_env(tmp_path, XINAS_GH_TOKEN="tok123")
        _run(f"xinas_gh_git ls-remote http://127.0.0.1:{srv.port}/x/y.git", env, tmp_path)
    expected = "Basic " + base64.b64encode(b"x-access-token:tok123").decode()
    assert srv.seen == [None, expected], srv.seen


def test_git_makes_one_anonymous_request_without_a_token(tmp_path):
    with _Server() as srv:
        env = _git_env(tmp_path)
        proc = _run(f"xinas_gh_git ls-remote http://127.0.0.1:{srv.port}/x/y.git", env, tmp_path)
    assert srv.seen == [None], srv.seen
    assert proc.returncode != 0  # the 401 is a failure, not a prompt


def test_git_token_helper_outranks_a_stale_helper_on_the_host(tmp_path):
    """A host with a stale credential helper configured must not have that
    helper answer GitHub's 401 first — the empty credential.helper= resets
    the list before ours is added."""
    (tmp_path / ".gitconfig").write_text(
        "[credential]\n\thelper = !f() { echo username=stale; echo password=stale; }; f\n"
    )
    with _Server() as srv:
        env = _git_env(tmp_path, XINAS_GH_TOKEN="tok123")
        _run(f"xinas_gh_git ls-remote http://127.0.0.1:{srv.port}/x/y.git", env, tmp_path)
    expected = "Basic " + base64.b64encode(b"x-access-token:tok123").decode()
    assert srv.seen == [None, expected], srv.seen


# ── the menus route their GitHub calls through the wrappers ──────────────────


def test_lib_release_lookup_goes_through_the_wrapper():
    src = LIB.read_text()
    m = re.search(r"^_latest_release_tag\(\) \{\n(.*?)^\}\n", src, re.M | re.S)
    assert m, "_latest_release_tag not found"
    assert "xinas_gh_curl" in m.group(1), "_latest_release_tag must call xinas_gh_curl"
    assert not re.search(r"(?<![\w_])curl ", m.group(1)), "no bare curl in _latest_release_tag"


def test_post_install_release_lookup_goes_through_the_wrapper():
    src = (REPO / "post_install_menu.sh").read_text()
    m = re.search(r"^_latest_release_tag\(\) \{\n(.*?)^\}\n", src, re.M | re.S)
    assert m, "_latest_release_tag not found in post_install_menu.sh"
    assert "xinas_gh_curl" in m.group(1)


@pytest.mark.parametrize(
    "script,var",
    [
        ("startup_menu.sh", "REPO_DIR"),
        ("simple_menu.sh", "REPO_DIR"),
        ("post_install_menu.sh", "repo_dir"),
    ],
)
def test_menu_fetch_goes_through_the_wrapper(script, var):
    src = (REPO / script).read_text()
    assert f'xinas_gh_git -C "${var}" fetch origin --tags' in src, (
        f"{script}: do_update's fetch must go through xinas_gh_git"
    )
    # Strip the wrapper name: a surviving bare `git -C "$DIR" fetch origin
    # --tags` is the leftover this hunts.
    assert f'git -C "${var}" fetch origin --tags' not in src.replace("xinas_gh_git", ""), (
        f"{script}: a bare git fetch remains"
    )


# ── every copy of the block is byte-identical ────────────────────────────────

_SITES = {
    "lib/menu_lib.sh": "canonical copy",
    "install.sh": "standalone server installer, runs before the clone",
    "install_client.sh": "standalone client installer, never sources the lib",
    "prepare_system.sh": "bootstrap clone runs before the lib exists on disk",
    "client_repo/client_setup.sh": "runs on clients from /opt/xinas-client",
    "collection/roles/xinas_menu/files/xinas-update-git": "root-owned sudo wrapper",
}


def test_every_site_carries_the_identical_block():
    blocks = {path: _block(REPO / path) for path in _SITES}
    canonical = blocks["lib/menu_lib.sh"]
    drifted = [p for p, b in blocks.items() if b != canonical]
    assert not drifted, "GitHub access token block drifted from lib/menu_lib.sh in: " + ", ".join(
        drifted
    )


def _code_lines(path: str) -> list[str]:
    """Non-comment lines outside the shared block with their double-quoted
    strings blanked: what actually runs, minus the operator-facing messages
    that legitimately quote git ("git fetch/checkout error", the hint)."""
    body = _BLOCK_RE.sub("", (REPO / path).read_text())
    out = []
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(re.sub(r'"[^"]*"', '""', line))
    return out


def test_every_site_calls_the_wrappers_not_bare_tools():
    """Any curl against api.github.com for xiNAS releases and any network git
    call on a release path must go through the wrappers."""
    for path in _SITES:
        for line in _code_lines(path):
            if re.search(
                r"(?<![\w_])curl .*api\.github\.com/repos/\$\{?(REPO_SLUG|CLIENT_REPO_SLUG)", line
            ):
                raise AssertionError(f"{path}: bare curl on {line.strip()!r}")
            if re.search(
                r"(?<![\w_])git (clone|fetch|ls-remote)\b", line.replace("xinas_gh_git", "")
            ):
                raise AssertionError(f"{path}: bare network git call on {line.strip()!r}")


def test_bash_syntax_ok():
    for path in _SITES:
        subprocess.run(["bash", "-n", str(REPO / path)], check=True)


# ── install.sh persists the token it was given ───────────────────────────────


def _persist_fn() -> str:
    m = re.search(
        r"^xinas_persist_github_token\(\) \{\n.*?^\}\n", INSTALL_SH.read_text(), re.M | re.S
    )
    assert m, "install.sh must define xinas_persist_github_token()"
    return m.group(0)


def _persist(tmp_path: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    dest = tmp_path / "etc" / "xinas" / "github-token"
    return subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            _persist_fn() + f'\nxinas_persist_github_token "{dest}"',
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_persist_writes_0600_file_with_trailing_newline(tmp_path):
    proc = _persist(tmp_path, _clean_env(tmp_path, XINAS_GH_TOKEN="sekret"))
    assert proc.returncode == 0, proc.stderr
    dest = tmp_path / "etc" / "xinas" / "github-token"
    assert dest.read_text() == "sekret\n"
    assert oct(dest.stat().st_mode & 0o777) == "0o600"
    assert "sekret" not in proc.stdout + proc.stderr


def test_persist_is_a_noop_without_a_token(tmp_path):
    proc = _persist(tmp_path, _clean_env(tmp_path))
    assert proc.returncode == 0, proc.stderr
    assert not (tmp_path / "etc" / "xinas" / "github-token").exists()


def test_persist_replaces_an_existing_file(tmp_path):
    dest = tmp_path / "etc" / "xinas" / "github-token"
    dest.parent.mkdir(parents=True)
    dest.write_text("old\n")
    dest.chmod(0o644)
    proc = _persist(tmp_path, _clean_env(tmp_path, XINAS_GH_TOKEN="new"))
    assert proc.returncode == 0, proc.stderr
    assert dest.read_text() == "new\n"
    assert oct(dest.stat().st_mode & 0o777) == "0o600"


def test_install_sh_persists_before_its_first_network_git_call():
    src = INSTALL_SH.read_text()
    call = src.find('xinas_persist_github_token "$XINAS_GH_TOKEN_FILE"')
    first_git = re.search(r"^\s*xinas_gh_git (clone|fetch)", src, re.M)
    assert call > 0, "install.sh must persist the token it was given"
    assert first_git and call < first_git.start(), "persist must precede the first network git call"
