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
        stdin=subprocess.DEVNULL,
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


# The menus source lib/menu_lib.sh, so they carry no copy — but their update
# paths must go through the wrappers all the same.
_MENUS = ("startup_menu.sh", "simple_menu.sh", "post_install_menu.sh")

# startup_menu.sh's configure_git_repo is gated behind XINAS_DEV_REPO_CONFIG=1,
# clones an operator-supplied URL and is explicitly out of scope
# (update-spec.md "Non-interactive git access").
_DEV_ONLY_RE = re.compile(r"^configure_git_repo\(\) \{\n.*?^\}\n", re.M | re.S)

# A network git call, with any options — each with an optional argument —
# between `git` and the subcommand (`git -C "$dir" fetch`, `git -c k=v fetch`,
# `git -q clone`). Quoted strings are blanked to "" by _code_lines first.
_BARE_GIT_RE = re.compile(
    r'(?<![\w_])git(?:\s+-\S+(?:\s+(?:""|[^-\s"]\S*))?)*\s+(clone|fetch|ls-remote)\b'
)


def _code_lines(path: str) -> list[str]:
    """Non-comment lines outside the shared block (and outside the dev-only
    function) with their double-quoted strings blanked: what actually runs,
    minus the operator-facing messages that legitimately quote git ("git
    fetch/checkout error", the hint)."""
    body = _BLOCK_RE.sub("", (REPO / path).read_text())
    body = _DEV_ONLY_RE.sub("", body)
    out = []
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(re.sub(r'"[^"]*"', '""', line))
    return out


@pytest.mark.parametrize(
    "line",
    [
        'if git -C "" fetch --quiet origin --tags 2>/dev/null \\',
        "git -c x=y fetch origin",
        "git -q clone --branch v1 url dir",
        "git fetch origin --tags",
        "git ls-remote url",
    ],
)
def test_bare_git_regex_sees_options_between_git_and_subcommand(line):
    assert _BARE_GIT_RE.search(line), line


@pytest.mark.parametrize(
    "line",
    ['git -C "" checkout --force ""', 'xinas_gh_git -C "" fetch origin', "git describe --tags"],
)
def test_bare_git_regex_ignores_local_and_wrapped_calls(line):
    assert not _BARE_GIT_RE.search(line.replace("xinas_gh_git", "")), line


def test_every_site_calls_the_wrappers_not_bare_tools():
    """Any curl against api.github.com for xiNAS releases and any network git
    call on a release path must go through the wrappers — in the six copies
    and in the three menus that source the canonical one."""
    for path in list(_SITES) + list(_MENUS):
        for line in _code_lines(path):
            if re.search(
                r"(?<![\w_])curl .*api\.github\.com/repos/\$\{?"
                r"(REPO_SLUG|CLIENT_REPO_SLUG|_UPDATE_REPO_SLUG)",
                line,
            ):
                raise AssertionError(f"{path}: bare curl on {line.strip()!r}")
            if _BARE_GIT_RE.search(line.replace("xinas_gh_git", "")):
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


def test_persist_keeps_a_github_token_env_too(tmp_path):
    proc = _persist(tmp_path, _clean_env(tmp_path, GITHUB_TOKEN="from-gh"))
    assert proc.returncode == 0, proc.stderr
    assert (tmp_path / "etc" / "xinas" / "github-token").read_text() == "from-gh\n"


def test_persist_keeps_an_existing_directory_mode_and_leaves_no_temp_file(tmp_path):
    d = tmp_path / "etc" / "xinas"
    d.mkdir(parents=True)
    d.chmod(0o750)
    proc = _persist(tmp_path, _clean_env(tmp_path, XINAS_GH_TOKEN="sekret"))
    assert proc.returncode == 0, proc.stderr
    assert oct(d.stat().st_mode & 0o777) == "0o750", (
        "an operator-hardened /etc/xinas keeps its mode"
    )
    assert [q.name for q in d.iterdir()] == ["github-token"]


@pytest.mark.parametrize(
    "script,accepted",
    [
        ("install.sh", 'ok "Latest release:'),
        ("install_client.sh", 'RELEASE_TAG="$(xinas_latest_release_tag)"'),
    ],
)
def test_installers_persist_only_after_github_accepted_the_token(script, accepted):
    """A mistyped token persisted before the release lookup would be reused by
    every later run — and nothing in xiNAS removes the file. Persist after the
    lookup succeeded (GitHub took the token), and before the first network
    git call so the clone benefits from it."""
    src = (REPO / script).read_text()
    call = src.find('xinas_persist_github_token "$XINAS_GH_TOKEN_FILE"')
    resolved = src.find(accepted)
    first_git = re.search(r"^\s*(if |)xinas_gh_git (clone|fetch)", src, re.M)
    assert call > 0, f"{script} must persist the token it was given"
    assert 0 < resolved < call, f"{script}: persist must follow a successful release lookup"
    assert first_git and call < first_git.start(), (
        f"{script}: persist must precede the first network git call"
    )


# ── the release-lookup failure names its cause ───────────────────────────────


def _stub_curl_status(tmp_path: Path, code: str) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    (bin_dir / "curl").write_text("#!/bin/bash\ncat >/dev/null\nprintf '%s' '" + code + "'\n")
    (bin_dir / "curl").chmod(0o755)
    return bin_dir


@pytest.mark.parametrize(
    "code,token_env,expect",
    [
        ("401", {"XINAS_GH_TOKEN": "sekret"}, "rejected the token from XINAS_GH_TOKEN"),
        ("403", {}, "anonymous requests from this public address"),
        ("429", {}, "anonymous requests from this public address"),
        ("403", {"GITHUB_TOKEN": "sekret"}, "token from GITHUB_TOKEN is spent"),
        ("000", {}, "No connection"),
        ("500", {}, "answered HTTP 500"),
    ],
)
def test_explain_release_lookup_failure_names_the_cause(tmp_path, code, token_env, expect):
    bin_dir = _stub_curl_status(tmp_path, code)
    env = _clean_env(tmp_path, **token_env)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    proc = _run("xinas_gh_explain_release_lookup_failure XinnorLab/xiNAS", env, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert expect in proc.stdout, proc.stdout
    assert "sekret" not in proc.stdout + proc.stderr, "never the value, only the source"


def test_explain_names_the_file_when_the_token_came_from_it(tmp_path):
    f = tmp_path / "tok"
    f.write_text("sekret\n")
    bin_dir = _stub_curl_status(tmp_path, "401")
    env = _clean_env(tmp_path, XINAS_GH_TOKEN_FILE=str(f))
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    proc = _run("xinas_gh_explain_release_lookup_failure XinnorLab/xiNAS", env, tmp_path)
    assert f"rejected the token from {f}" in proc.stdout, proc.stdout
    assert "sekret" not in proc.stdout


@pytest.mark.parametrize("script", ["install.sh", "install_client.sh", "prepare_system.sh"])
def test_installers_explain_a_failed_release_lookup(script):
    assert "xinas_gh_explain_release_lookup_failure" in (REPO / script).read_text(), (
        f"{script}: a failed /releases/latest lookup must name its cause"
    )
