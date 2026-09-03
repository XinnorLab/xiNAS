# GitHub Rate Limit — Token and Cached Update Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop GitHub's per-IP throttle of anonymous requests from breaking xiNAS installs and update checks on hosts that share one public address, by honouring one optional GitHub token on every path that talks to GitHub and by making the TUI ask GitHub less often.

**Architecture:** Three bash functions (`xinas_github_token`, `xinas_gh_curl`, `xinas_gh_git`) live canonically in `lib/menu_lib.sh` and are copied verbatim into the five scripts that cannot source it, with a parity test pinning the copies — the same pattern the release-tag regex already uses. `xinas_gh_git` attaches an inline git credential helper that GitHub's `401` triggers, so git stays anonymous until throttled. The Python checker resolves the token identically, reports rate limits by name, and caches the Releases payload (1 h TTL + `ETag`) so the background check on menu launch costs no request.

**Tech Stack:** bash 5 (`curl -K -`, git `-c credential.helper`), Python 3.10+ stdlib (`urllib`, `json`), pytest, a throw-away `http.server` in tests.

**Spec:** `docs/Installer/update-spec.md` — section *GitHub rate limits and the access token* (written in Task 1) plus the amended *Bash-path parity* bullets. Vendor facts cited there: GitHub changelog 2025-05-08 (anonymous limits cover HTTPS clones), REST rate limits (60/h per IP anonymous, 5,000/h per token), best practices (a `304` on an authenticated conditional request is free), PAT docs (every token reads public repositories).

## Global Constraints

- Branch `fix/github-rate-limit-token` is stacked on `fix/installer-git-noninteractive` (PR #333) and targets `release/3.14`; it will be cherry-picked to a `v3.13.x` hotfix afterwards. Keep commits self-contained.
- **No commits without Sergey's explicit go-ahead** (project rule). Every "Commit" step below is executed only after that go-ahead; until then, stop after verification.
- Release policy is untouched: the token changes *how* GitHub is reached, never *what* is reached — releases only, tags only, no branch fallback anywhere.
- The token is never printed, never placed in argv, never written into `.git/config` or `~/.git-credentials`. Error text names the *source* (`XINAS_GH_TOKEN`, `/etc/xinas/github-token`), never the value.
- Token resolution order everywhere: `XINAS_GH_TOKEN` env → `GITHUB_TOKEN` env → first line of `/etc/xinas/github-token` (path overridable as `XINAS_GH_TOKEN_FILE` in bash; a `path` argument in Python).
- Only *network* git operations (`clone`, `fetch`, `ls-remote`) go through `xinas_gh_git`; local ones (`checkout`, `describe`, `rev-parse`) stay plain `git`.
- `GIT_TERMINAL_PROMPT=0` exports from PR #333 stay exactly where they are; `tests/test_git_noninteractive_parity.py` keeps passing.
- The change to `collection/roles/xinas_menu/files/xinas-update-git` is deployed by Ansible, so the commit carrying it needs the trailer `Requires-Rebuild: xinas_menu`.
- Verification gate (copied from CLAUDE.md, run from the worktree with `.venv` active): `pytest --cov=xinas_history --cov-fail-under=20`, `ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper`, `ruff format --check .`, `pyright xinas_menu xinas_history xiNAS-MCP/nfs-helper`, `npx --yes markdownlint-cli2 'docs/**/*.md'`, `bash -n` on every touched script. No YAML or TypeScript is touched.
- Tests that spawn bash must scrub `XINAS_GH_TOKEN` and `GITHUB_TOKEN` from the environment and point `XINAS_GH_TOKEN_FILE` at a path that does not exist, so a CI runner's own token cannot change the outcome.

---

## The shared bash block (referenced by Tasks 2 and 3)

This exact text — comments included — is what `tests/test_github_token_parity.py` requires to be identical in all six sites. Copy it byte-for-byte.

```bash
# ── GitHub access token ───────────────────────────────────────────────────────
# GitHub throttles *anonymous* requests per source IP — REST and git-over-HTTPS
# alike — so every host behind one NAT shares one quota, and a spent quota
# surfaces as a 401 on clone/fetch and a 403/429 on the API. A token moves the
# caller onto its own per-account quota. Resolution order: $XINAS_GH_TOKEN,
# $GITHUB_TOKEN, then the first line of /etc/xinas/github-token. The token is
# never printed and never placed in argv: curl reads it from stdin config, git
# from a credential helper that GitHub's 401 triggers (anonymous first).
# Canonical copy: lib/menu_lib.sh; docs/Installer/update-spec.md "GitHub rate
# limits and the access token"; tests/test_github_token_parity.py pins copies.
XINAS_GH_TOKEN_FILE="${XINAS_GH_TOKEN_FILE:-/etc/xinas/github-token}"

xinas_github_token() {
    local t="${XINAS_GH_TOKEN:-${GITHUB_TOKEN:-}}"
    if [[ -z "$t" && -r "$XINAS_GH_TOKEN_FILE" ]]; then
        t="$(head -n 1 "$XINAS_GH_TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
    fi
    printf '%s' "$t"
}

xinas_gh_curl() {
    local t
    t="$(xinas_github_token)"
    if [[ -n "$t" ]]; then
        printf 'header = "Authorization: Bearer %s"\n' "$t" | curl -K - "$@"
    else
        curl "$@"
    fi
}

xinas_gh_git() {
    local t
    t="$(xinas_github_token)"
    if [[ -n "$t" ]]; then
        XINAS_GH_TOKEN="$t" git -c credential.helper= \
            -c 'credential.helper=!f() { [ "$1" = get ] || exit 0; echo username=x-access-token; echo "password=$XINAS_GH_TOKEN"; }; f' \
            "$@"
    else
        git "$@"
    fi
}
# ── end GitHub access token ───────────────────────────────────────────────────
```

Verified on 2026-09-03 against a local server that answers `401` to anonymous requests: git sends the first request without `Authorization`, calls the helper, retries with `Basic base64("x-access-token:<token>")`; the empty `credential.helper=` stops a previously configured helper from answering first; `-C <dir>` may appear before or after the `-c` options; `curl -K -` puts the header on the wire with nothing in argv.

---

### Task 1: Spec, README, TODO

**Files:**
- Modify: `docs/Installer/update-spec.md` (section *Update check* step 2; *Bash-path parity* bullets *Non-interactive git access* and *Naming the authentication failure*; new bullet *Authenticated GitHub access*; section *Install / bootstrap*; new top-level section *GitHub rate limits and the access token* placed right after *Install / bootstrap*)
- Modify: `README.md` (after the server one-liner, and after the client one-liner)
- Modify: `docs/TODO.md` (new entry, newest first)

**Interfaces:**
- Produces: the contract every later task implements — names `xinas_github_token`, `xinas_gh_curl`, `xinas_gh_git`, `XINAS_GH_TOKEN_FILE`, `/etc/xinas/github-token`, the 1-hour TTL, the cache paths, the exact error strings.

- [x] **Step 1: Amend *Update check* step 2**

Replace the two lines

```
   HTTPS. An optional token is read from `XINAS_GH_TOKEN` /
   `GITHUB_TOKEN` for rate-limit headroom; unauthenticated is fine.
```

with

```
   HTTPS. An optional token is sent when one is configured — see
   *GitHub rate limits and the access token* below for where it comes
   from and why. Unauthenticated is fine until a shared public address
   exhausts GitHub's anonymous quota. The background check on menu
   launch may be answered from a local cache instead of GitHub — see
   *Fewer requests from the TUI* in that section.
```

- [x] **Step 2: Amend the *Non-interactive git access* bullet**

Replace

```
  When GitHub answers a fetch/clone with `401` — a stale credential in
  root's `~/.git-credentials` or credential helper, an authenticating
  proxy, or a repository that has been made private or renamed — git
  falls back to prompting `Username for 'https://github.com':` on
```

with

```
  When GitHub answers a fetch/clone with `401` — most often because
  the anonymous per-IP quota is spent (see *GitHub rate limits and the
  access token*), otherwise a stale credential in root's
  `~/.git-credentials` or credential helper, an authenticating proxy,
  or a repository that has been made private or renamed — git falls
  back to prompting `Username for 'https://github.com':` on
```

- [x] **Step 3: Rewrite the *Naming the authentication failure* bullet**

Replace the whole bullet with

```
- **Naming the authentication failure** — a path that fails its clone
  or fetch because GitHub refused it MUST NOT leave the operator with
  only a raw git error. It MUST print the repository it tried, name
  GitHub's per-IP limit on anonymous requests as the first suspect,
  give the remedy — the token one-liner
  (`… | sudo XINAS_GH_TOKEN=<token> bash`) and the token file
  (`/etc/xinas/github-token`) — and only then the host-side causes
  (an HTTP proxy in root's environment, an `insteadOf` rewrite or a
  credential helper). The xiNAS repository is public: a `401` on that
  path is GitHub throttling the source address or a host configuration
  problem, never a xiNAS one.
```

- [x] **Step 4: Add the *Authenticated GitHub access* bullet**

Insert immediately after the rewritten bullet:

```
- **Authenticated GitHub access** — every bash path that calls
  `api.github.com` for xiNAS releases, and every *network* git
  operation against GitHub on an install/update path (`clone`,
  `fetch`, `ls-remote`), MUST go through `xinas_gh_curl` /
  `xinas_gh_git` (see *GitHub rate limits and the access token*) so a
  configured token is honoured uniformly. Local git operations
  (`checkout`, `describe`, `rev-parse`) MUST stay plain `git` — they
  never authenticate, and routing them through the wrapper would only
  obscure which calls reach the network.
```

- [x] **Step 5: Extend *Install / bootstrap***

After the fenced block with the two one-liners, add:

```
Behind a shared public address, pass a token and the installer keeps
it for the day-2 surfaces (see *GitHub rate limits and the access
token*):

```bash
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh \
  | sudo XINAS_GH_TOKEN=<token> bash
```
```

- [x] **Step 6: Add the new section after *Install / bootstrap***

```markdown
## GitHub rate limits and the access token

GitHub throttles **unauthenticated** requests per source IP, and since
2025-05-08 that covers cloning over HTTPS, not only the REST API
(GitHub changelog, *Updated rate limits for unauthenticated requests*,
<https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/>).
The REST quota is 60 requests per hour per IP; a personal access token
raises it to 5,000 per hour per account (*Rate limits for the REST
API*,
<https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>,
read 2026-09-03). Git-over-HTTPS has its own, unpublished per-IP limit
("dynamic limits", GitHub staff in
<https://github.com/orgs/community/discussions/44515>).

Every host behind one public address — a lab, an office NAT, a client
fleet — shares those anonymous quotas. One `install.sh` run costs one
API call and one clone or fetch; every `xinas-menu`, `startup_menu.sh`,
`simple_menu.sh` or `post_install_menu.sh` launch costs one API call;
`install_client.sh` and `xinas-client` cost the same on every client.
Once the quota is spent GitHub answers an anonymous git request with
`401` (git then asks for a username) and an API request with `403` or
`429` carrying `x-ratelimit-remaining: 0`. Observed 2026-09-02 on a
fresh Ubuntu 22.04 host in a lab behind one NAT address: the tag
resolved, the clone was refused. A `401` against a public repository
is GitHub's throttle first and a host-side credential problem second.

### The token

xiNAS accepts one optional GitHub token on **every** path that talks to
GitHub for xiNAS releases. Resolution order, identical everywhere:

1. `XINAS_GH_TOKEN` in the environment;
2. `GITHUB_TOKEN` in the environment;
3. the first line of `/etc/xinas/github-token`, surrounding whitespace
   stripped. An unreadable or empty file means "no token". Bash paths
   accept `XINAS_GH_TOKEN_FILE` to relocate the file (tests use it).

A **fine-grained personal access token with no permissions** is enough:
every token "always include[s] read-only access to all public
repositories" (*Managing your personal access tokens*,
<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>,
read 2026-09-03). Such a token is worth exactly its quota — keep the
file a secret anyway: mode `0600`, readable by the user that runs the
menu. `install.sh` persists the token it was given
(`… | sudo XINAS_GH_TOKEN=<token> bash`) to that file, mode `0600`, so
the day-2 surfaces find it after `sudo` has stripped the environment; a
token given on a later run replaces the file. Nothing in xiNAS removes
the file — `uninstall.sh` leaves `/etc/xinas/` in place — so a reinstall
picks it up again.

### How the token is used

- **REST** (`api.github.com`): `Authorization: Bearer <token>`. Bash
  paths feed the header to curl as a config file on stdin (`curl -K -`),
  never as an argument, so the token appears neither in `ps` nor in the
  install log.
- **git over HTTPS** (`github.com`): git runs with an inline credential
  helper that answers `username=x-access-token` and the token as the
  password. Git tries anonymously first and consults the helper only
  after GitHub answers `401`, so the token costs nothing while the
  anonymous quota lasts and the clone or fetch never carries the token
  in its URL. The helper is preceded by an empty `credential.helper=`
  so a stale helper configured on the host cannot answer first. The
  token reaches the helper through the environment of that one git
  process — never through argv, `.git/config` or `~/.git-credentials`.
  `GIT_TERMINAL_PROMPT=0` stays in force: git consults helpers before
  the terminal, so the two compose.
- **Never printed.** No path prints the token, an `Authorization`
  header, or a URL carrying it; messages name the *source* it came from
  (`XINAS_GH_TOKEN`, `/etc/xinas/github-token`), never the value.

The three bash functions — `xinas_github_token`, `xinas_gh_curl`,
`xinas_gh_git` — live canonically in `lib/menu_lib.sh` and are copied
verbatim into the scripts that cannot source it: `install.sh`,
`install_client.sh`, `prepare_system.sh` (its bootstrap clone runs
before the lib exists), `client_repo/client_setup.sh`, and the
root-owned `xinas-update-git` helper. `tests/test_github_token_parity.py`
fails when any copy drifts and exercises the canonical copy against a
local server that answers `401`. The Python checker resolves the token
the same way (`update_check.github_token`), and its direct-git fallback
(used when the `xinas-update-git` helper is not deployed) passes the
same credential helper.

### Fewer requests from the TUI

The Python update check keeps a cache of the last successful Releases
response:

- **Location:** `/var/cache/xinas/update-check.json` when running as
  root, else `$XDG_CACHE_HOME/xinas/update-check.json`
  (`~/.cache/xinas/update-check.json`). Mode `0600`, written atomically.
  Any failure to read or write it is ignored: the cache is an
  optimisation, never a dependency.
- **Content:** the releases payload, the response `ETag`, the installed
  version the check ran against, and the time of the check.
- **Background check on launch** (`XiNASApp` on mount): reuses the
  cached payload with no network call when it is younger than **one
  hour** and was taken for the same installed version. Opening the menu
  ten times in an hour costs one API call, not ten.
- **Explicit check** (`u`, Management → Check for Updates, MCP /
  Advanced → Check for Updates): always contacts GitHub, sending the
  cached `ETag` as `If-None-Match`. A `304 Not Modified` reuses the
  cached payload; with a token, a `304` does not count against the
  quota (*Best practices for using the REST API*,
  <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>,
  read 2026-09-03).
- **The cache never changes the verdict.** It holds the payload GitHub
  returned; filtering, the semver comparison and the trailer union run
  on it unchanged. It is keyed to the installed version, so an update
  applied by any path invalidates it.

The bash menus' passive startup check is not cached — see
`docs/TODO.md`.

### Naming the failure

- The Python checker maps `403`/`429` with `x-ratelimit-remaining: 0`
  to `GitHub API rate limit exceeded for anonymous requests from this
  IP (resets at HH:MM UTC) — set XINAS_GH_TOKEN or
  /etc/xinas/github-token`; when a token was sent it says `for the
  configured token` and drops the hint. A `401` while a token was sent
  reads `GitHub rejected the configured token (HTTP 401) — check
  XINAS_GH_TOKEN / /etc/xinas/github-token`. Other HTTP errors keep the
  plain `GitHub API HTTP <code>` form. The reset time comes from
  `x-ratelimit-reset` and is omitted when the header is absent.
- `install.sh`'s hint on a refused clone or fetch follows *Naming the
  authentication failure* under *Bash-path parity*: the per-IP limit
  first, the token one-liner and file second, host-side causes last.
```

- [x] **Step 7: Note the fallback in *Update apply***

In the paragraph beginning `If the helper is not deployed (host predating this change), apply falls back to invoking` append, after `never \`main\`.`:

```
The fallback passes the same credential helper as `xinas_gh_git` when a
token is configured (see *GitHub rate limits and the access token*).
```

- [x] **Step 8: README**

After the server one-liner's paragraph (the one ending `deploy`), before `Ansible runs the`, insert:

```markdown
Behind a shared public address (a lab, an office NAT, a fleet of clients) GitHub's per-IP limit on anonymous requests can refuse the clone with a `401` or the release lookup with a `403`. Pass a GitHub token — a fine-grained personal access token with no permissions is enough — and the installer keeps it in `/etc/xinas/github-token` (mode `0600`) for the update checks that follow:

```bash
curl -fsSL https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh | sudo XINAS_GH_TOKEN=<token> bash
```
```

After the client one-liner's paragraph (ending `Run it again any time:` block), insert:

```markdown
The same `XINAS_GH_TOKEN=<token>` works here; clients on one NAT share GitHub's anonymous quota just like servers do.
```

- [x] **Step 9: TODO entry** (newest first, right after the `---` line)

```markdown
## Installer — the bash menus' passive update check is not cached

*Deferred 2026-09-03, from the GitHub rate-limit change
([docs/Installer/update-spec.md](Installer/update-spec.md) "GitHub rate
limits and the access token").*

**What is missing.** `check_for_updates` in `lib/menu_lib.sh` (run at every
`startup_menu.sh` / `simple_menu.sh` start) and its twin in
`post_install_menu.sh` call `api.github.com` on every launch. The Python
TUI now keeps a one-hour cache with an `ETag`; the bash menus do not.

**What the code does instead.** The bash calls go through `xinas_gh_curl`,
so a configured token lifts them onto the token's 5,000/h quota — which is
the fix that matters on a shared address. Without a token they still cost
one anonymous request per launch.

**Why it was cut.** `startup_menu.sh` runs once per install and
`post_install_menu.sh` is a deprecated surface; a second cache format in
bash would duplicate the Python one for a launch count that is small in
practice. The token covers the case that actually failed.

**What done looks like.** One cache file both surfaces read — the Python
`ReleaseCache` JSON at `/var/cache/xinas/update-check.json` is the obvious
candidate — with the bash passive check honouring the same one-hour TTL.
```

- [x] **Step 10: Lint the docs**

Run: `npx --yes markdownlint-cli2 'docs/**/*.md' README.md`
Expected: no findings.

- [ ] **Step 11: Commit** (only after Sergey's go-ahead)

```bash
git add docs/Installer/update-spec.md README.md docs/TODO.md
git commit -m "docs(installer): GitHub per-IP rate limits, the access token, and the cached check"
```

---

### Task 2: Canonical bash functions in `lib/menu_lib.sh` and the menus

**Files:**
- Modify: `lib/menu_lib.sh` — insert the shared block immediately before the `_is_release_tag` comment banner (the `# ═══ _is_release_tag — WS3 T5c` line); change `_latest_release_tag` to call `xinas_gh_curl`
- Modify: `startup_menu.sh` `do_update` (`git -C "$REPO_DIR" fetch origin --tags` → `xinas_gh_git -C "$REPO_DIR" fetch origin --tags`)
- Modify: `simple_menu.sh` `do_update` (same line)
- Modify: `post_install_menu.sh` — `_latest_release_tag` uses `xinas_gh_curl`; `do_update`'s `git -C "$repo_dir" fetch origin --tags` → `xinas_gh_git -C "$repo_dir" fetch origin --tags`
- Create: `tests/test_github_token_parity.py` (the behavioral half; Task 3 adds the cross-site parity half to the same file)

**Interfaces:**
- Produces: `xinas_github_token` (prints the token or nothing), `xinas_gh_curl "$@"` (curl with the bearer header when a token exists), `xinas_gh_git "$@"` (git with the reactive credential helper when a token exists), `XINAS_GH_TOKEN_FILE` (default `/etc/xinas/github-token`).
- Consumes: nothing.

- [x] **Step 1: Write the failing behavioral tests**

`tests/test_github_token_parity.py`:

```python
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


def test_git_stays_anonymous_until_401_then_retries_with_the_token(tmp_path):
    with _Server() as srv:
        env = _clean_env(tmp_path, XINAS_GH_TOKEN="tok123", GIT_TERMINAL_PROMPT="0", HOME=str(tmp_path))
        _run(f"xinas_gh_git ls-remote http://127.0.0.1:{srv.port}/x/y.git", env, tmp_path)
    expected = "Basic " + base64.b64encode(b"x-access-token:tok123").decode()
    assert srv.seen == [None, expected], srv.seen


def test_git_makes_one_anonymous_request_without_a_token(tmp_path):
    with _Server() as srv:
        env = _clean_env(tmp_path, GIT_TERMINAL_PROMPT="0", HOME=str(tmp_path))
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
        env = _clean_env(tmp_path, XINAS_GH_TOKEN="tok123", GIT_TERMINAL_PROMPT="0", HOME=str(tmp_path))
        _run(f"xinas_gh_git ls-remote http://127.0.0.1:{srv.port}/x/y.git", env, tmp_path)
    expected = "Basic " + base64.b64encode(b"x-access-token:tok123").decode()
    assert srv.seen == [None, expected], srv.seen


def test_lib_release_lookup_goes_through_the_wrapper():
    src = LIB.read_text()
    m = re.search(r"^_latest_release_tag\(\) \{\n(.*?)^\}\n", src, re.M | re.S)
    assert m, "_latest_release_tag not found"
    assert "xinas_gh_curl" in m.group(1), "_latest_release_tag must call xinas_gh_curl"
    assert not re.search(r"(?<![\w_])curl ", m.group(1)), "no bare curl in _latest_release_tag"


@pytest.mark.parametrize(
    "script,var",
    [("startup_menu.sh", "REPO_DIR"), ("simple_menu.sh", "REPO_DIR"), ("post_install_menu.sh", "repo_dir")],
)
def test_menu_fetch_goes_through_the_wrapper(script, var):
    src = (REPO / script).read_text()
    assert f'xinas_gh_git -C "${var}" fetch origin --tags' in src, (
        f"{script}: do_update's fetch must go through xinas_gh_git"
    )
    assert f'git -C "${var}" fetch origin --tags' not in src.replace("xinas_gh_git", ""), (
        f"{script}: a bare git fetch remains"
    )
```

Note the last assertion: `src.replace("xinas_gh_git", "")` turns `xinas_gh_git -C` into a bare `-C`, so any *remaining* bare `git -C "$REPO_DIR" fetch origin --tags` is the leftover it hunts. Also add to this file the `post_install_menu.sh` lookup check:

```python
def test_post_install_release_lookup_goes_through_the_wrapper():
    src = (REPO / "post_install_menu.sh").read_text()
    m = re.search(r"^_latest_release_tag\(\) \{\n(.*?)^\}\n", src, re.M | re.S)
    assert m
    assert "xinas_gh_curl" in m.group(1)
```

- [x] **Step 2: Run them to see them fail**

Run: `.venv/bin/pytest tests/test_github_token_parity.py -q`
Expected: every test fails, the first ones with `no GitHub access token block`.

- [x] **Step 3: Insert the shared block into `lib/menu_lib.sh`**

Insert the block from *The shared bash block* above, verbatim, immediately before the line

```
# ═══════════════════════════════════════════════════════════════════════════════
# _is_release_tag — WS3 T5c (code review hardening)
```

leaving one blank line on each side.

- [x] **Step 4: Route `_latest_release_tag` through `xinas_gh_curl`**

In `lib/menu_lib.sh` change

```bash
    curl --connect-timeout "$connect_timeout" --max-time "$max_time" -fsSL \
        "https://api.github.com/repos/${REPO_SLUG:-}/releases/latest" 2>/dev/null \
```

to

```bash
    xinas_gh_curl --connect-timeout "$connect_timeout" --max-time "$max_time" -fsSL \
        "https://api.github.com/repos/${REPO_SLUG:-}/releases/latest" 2>/dev/null \
```

and extend the function's comment (the paragraph starting `# Resolve the latest PUBLISHED GitHub Release tag`) with:

```
# Goes through xinas_gh_curl so a configured GitHub token (update-spec.md
# "GitHub rate limits and the access token") lifts the call off the anonymous
# per-IP quota that every host behind one NAT shares.
```

- [x] **Step 5: Route the three menus' fetch and post_install's lookup**

`startup_menu.sh`:

```bash
    if xinas_gh_git -C "$REPO_DIR" fetch origin --tags 2>"$TMP_DIR/update.log" \
        && git -C "$REPO_DIR" checkout --force "$_tag" 2>>"$TMP_DIR/update.log"; then
```

`simple_menu.sh`: identical line.

`post_install_menu.sh`:

```bash
    if xinas_gh_git -C "$repo_dir" fetch origin --tags 2>"$TMP_DIR/update.log" \
```

and

```bash
_latest_release_tag() {
    xinas_gh_curl -fsSL "https://api.github.com/repos/${_UPDATE_REPO_SLUG}/releases/latest" 2>/dev/null \
```

Add above each changed fetch the one-line comment
`# Network fetch goes through xinas_gh_git (token, see lib/menu_lib.sh); checkout is local and stays plain git.`

- [x] **Step 6: Run the tests**

Run: `.venv/bin/pytest tests/test_github_token_parity.py tests/test_update_check_backgrounding.py tests/test_post_install_semver_compare.py -q`
Expected: all pass. (The backgrounding suite drives the real menus with stub curl/git — it proves `xinas_gh_curl` is transparent when no token is set.)

- [x] **Step 7: Syntax check**

Run: `for f in lib/menu_lib.sh startup_menu.sh simple_menu.sh post_install_menu.sh; do bash -n "$f" || echo "FAIL $f"; done`
Expected: no output.

- [ ] **Step 8: Commit** (only after Sergey's go-ahead)

```bash
git add lib/menu_lib.sh startup_menu.sh simple_menu.sh post_install_menu.sh tests/test_github_token_parity.py
git commit -m "fix(menu): honour a GitHub token on the bash update paths"
```

---

### Task 3: Inline copies in the standalone scripts, the installer's persist step, and the corrected hint

**Files:**
- Modify: `install.sh` — shared block after `export GIT_TERMINAL_PROMPT=0`; new `xinas_persist_github_token`; rewritten `git_access_hint`; `xinas_latest_release_tag` via `xinas_gh_curl`; `git fetch`/`git clone` via `xinas_gh_git`; persist + "using token" lines before the git step
- Modify: `prepare_system.sh` — shared block after its `export GIT_TERMINAL_PROMPT=0`; `xinas_latest_release_tag` via `xinas_gh_curl`; `git fetch origin --tags --quiet` and `git clone --branch` via `xinas_gh_git`
- Modify: `install_client.sh` — same pattern; its `git fetch --quiet origin --tags` and `git clone --quiet --branch …` via `xinas_gh_git`
- Modify: `client_repo/client_setup.sh` — shared block right above `client_latest_release_tag`; that function via `xinas_gh_curl`
- Modify: `collection/roles/xinas_menu/files/xinas-update-git` — shared block after `export GIT_TERMINAL_PROMPT=0`; `exec git fetch origin --tags --quiet` becomes `xinas_gh_git fetch origin --tags --quiet` (no `exec`: a function cannot be exec'd)
- Modify: `tests/test_git_noninteractive_parity.py` — docstring diagnosis, hint assertions, call-site regex
- Modify: `tests/test_github_token_parity.py` — add the cross-site parity tests and the persist/hint tests
- Modify: `tests/test_release_tag_regex_parity.py` — no change needed; it keeps passing (the regex sites are untouched)

**Interfaces:**
- Consumes: the shared block text (identical to Task 2's).
- Produces: `xinas_persist_github_token <dest>` in `install.sh` (writes `$XINAS_GH_TOKEN` + newline to `<dest>`, mode 0600, creating the parent 0755; no-op when the variable is unset or empty; returns 0 either way).

- [x] **Step 1: Add the failing parity, persist, and hint tests**

Append to `tests/test_github_token_parity.py`:

```python
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
    assert not drifted, "GitHub access token block drifted from lib/menu_lib.sh in: " + ", ".join(drifted)


def _code_lines(path: Path) -> list[str]:
    """Non-comment, non-echo lines outside the shared block: what actually
    runs, minus the operator-facing hint text that legitimately quotes git."""
    body = _BLOCK_RE.sub("", (REPO / path).read_text())
    out = []
    for line in body.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "echo" in s:
            continue
        out.append(line)
    return out


def test_every_site_calls_the_wrappers_not_bare_tools():
    """Any curl against api.github.com for xiNAS releases and any network git
    call on a release path must go through the wrappers."""
    for path in _SITES:
        for line in _code_lines(path):
            if re.search(r"(?<![\w_])curl .*api\.github\.com/repos/\$\{?(REPO_SLUG|CLIENT_REPO_SLUG)", line):
                raise AssertionError(f"{path}: bare curl on {line.strip()!r}")
            if re.search(r"(?<![\w_])git (clone|fetch|ls-remote)\b", line.replace("xinas_gh_git", "")):
                raise AssertionError(f"{path}: bare network git call on {line.strip()!r}")


def test_bash_syntax_ok():
    for path in _SITES:
        subprocess.run(["bash", "-n", str(REPO / path)], check=True)


# ── install.sh persists the token it was given ───────────────────────────────

INSTALL_SH = REPO / "install.sh"


def _persist_fn() -> str:
    m = re.search(r"^xinas_persist_github_token\(\) \{\n.*?^\}\n", INSTALL_SH.read_text(), re.M | re.S)
    assert m, "install.sh must define xinas_persist_github_token()"
    return m.group(0)


def _persist(tmp_path: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    dest = tmp_path / "etc" / "xinas" / "github-token"
    return subprocess.run(
        ["bash", "-euo", "pipefail", "-c", _persist_fn() + f'\nxinas_persist_github_token "{dest}"'],
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
```

And in `tests/test_git_noninteractive_parity.py`:

1. Replace the docstring paragraph starting `The repository is public and the tag exists, so a \`401\` on this path is a host-side problem` with:

   ```
   The repository is public and the tag exists, so a `401` on this path is
   GitHub throttling anonymous requests from this host's public address
   (docs/Installer/update-spec.md "GitHub rate limits and the access token") or,
   less often, a host-side proxy or credential helper. Hanging on an invisible
   prompt tells the operator none of that, hence the second half of the
   contract: name the per-IP limit, give the token remedy, then the host-side
   causes.
   ```

2. Replace `test_install_sh_auth_failure_hint_names_the_host_side_causes` with:

   ```python
   def test_install_sh_auth_failure_hint_names_the_limit_and_the_token():
       """The clone/fetch runs inside run_quiet, which prints a generic ✗ and
       20 log lines. With prompting disabled a 401 now fails fast — so the
       operator has to be told this is GitHub's per-IP limit on anonymous
       requests (or, second, a host-side proxy/helper), and how to lift it.
       """
       body = _git_access_hint_body()
       assert re.search(r"per-IP|rate limit", body, re.I), (
           "install.sh's git-access hint must name GitHub's per-IP anonymous limit "
           "(update-spec.md, Naming the authentication failure)"
       )
       assert "XINAS_GH_TOKEN=" in body, "the hint must give the token one-liner"
       assert "/etc/xinas/github-token" in body or "XINAS_GH_TOKEN_FILE" in body, (
           "the hint must name the token file"
       )
       assert re.search(r"\bproxy\b", body, re.I), "the hint must still name a proxy as a cause"
       assert "${REPO_SLUG}" in body or "$REPO_URL" in body, (
           "the hint must print the repository it tried to reach"
       )
   ```

3. Change the parametrization of `test_install_sh_routes_git_failures_into_the_hint` from `["git fetch", "git clone"]` to `["xinas_gh_git fetch", "xinas_gh_git clone"]`.

4. In `test_prepare_system_update_only_runs_git_without_terminal_prompt`, after `env.pop("GIT_TERMINAL_PROMPT", None)` add:

   ```python
       env.pop("XINAS_GH_TOKEN", None)
       env.pop("GITHUB_TOKEN", None)
       env["XINAS_GH_TOKEN_FILE"] = str(tmp_path / "no-such-token-file")
   ```

5. Add a sibling behavioral test right after it:

   ```python
   def test_prepare_system_update_only_passes_the_credential_helper_when_a_token_is_set(tmp_path):
       """Same drive as above, but with a token: the stub git must see the
       reactive credential helper on its argv and the token in its environment —
       and never the token itself on argv."""
       sandbox = tmp_path / "sandbox"
       sandbox.mkdir()
       (sandbox / "ansible.cfg").write_text("")
       (sandbox / "playbooks").mkdir()
       lib_dir = sandbox / "lib"
       lib_dir.mkdir()
       (lib_dir / "menu_lib.sh").write_text(
           '_is_release_tag() { [[ "$1" =~ ^v?[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }\n'
       )
       stub_bin = tmp_path / "bin"
       stub_bin.mkdir()
       argv_log = tmp_path / "git-argv.log"
       (stub_bin / "git").write_text(
           "#!/bin/bash\n"
           f'printf \'%s\\n\' "$@" >> "{argv_log}"\n'
           f'echo "env XINAS_GH_TOKEN=${{XINAS_GH_TOKEN-unset}}" >> "{argv_log}"\n'
           "exit 0\n"
       )
       (stub_bin / "git").chmod(0o755)
       (stub_bin / "curl").write_text('#!/bin/bash\ncat >/dev/null\necho \'{"tag_name": "v9.9.9"}\'\n')
       (stub_bin / "curl").chmod(0o755)

       env = dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}")
       env.pop("GITHUB_TOKEN", None)
       env["XINAS_GH_TOKEN"] = "sekret"
       env["XINAS_GH_TOKEN_FILE"] = str(tmp_path / "no-such-token-file")
       proc = subprocess.run(
           ["bash", str(PREPARE_SYSTEM), "-u"],
           cwd=sandbox,
           env=env,
           capture_output=True,
           text=True,
           timeout=30,
       )
       assert proc.returncode == 0, proc.stderr
       log = argv_log.read_text()
       fetch_call = log.split("checkout")[0]
       assert "credential.helper=" in fetch_call, "fetch must carry the reactive helper"
       assert "username=x-access-token" in fetch_call
       assert "env XINAS_GH_TOKEN=sekret" in fetch_call
       argv_lines = [ln for ln in log.splitlines() if not ln.startswith("env ")]
       assert "sekret" not in "\n".join(argv_lines), "the token must never reach git's argv"
       checkout_call = log.split("checkout", 1)[1]
       assert "credential.helper" not in checkout_call, "checkout is local and stays plain git"
   ```

Note: the stub `curl` swallows stdin (`cat >/dev/null`) because `xinas_gh_curl` pipes the config into it.

- [x] **Step 2: Run to see them fail**

Run: `.venv/bin/pytest tests/test_github_token_parity.py tests/test_git_noninteractive_parity.py -q`
Expected: the new tests fail (`no GitHub access token block` for five sites, `must define xinas_persist_github_token`, hint assertions).

- [x] **Step 3: `install.sh`**

Directly after `export GIT_TERMINAL_PROMPT=0` (and its comment), insert the shared block, then:

```bash
# Keep the token this run was given where the day-2 surfaces will look for it
# (xinas-menu's update check, the xinas-update-git sudo helper): `sudo` strips
# the environment, so an env-only token would be lost the moment install.sh
# exits. Silent no-op without a token; a token given on a later run replaces
# the file. Mode 0600 — a no-permission token is worth its quota, nothing
# more, but it is still a credential.
xinas_persist_github_token() {
    local dest="$1"
    [[ -n "${XINAS_GH_TOKEN:-}" ]] || return 0
    install -d -m 0755 "$(dirname "$dest")"
    (umask 077 && printf '%s\n' "$XINAS_GH_TOKEN" > "$dest")
    chmod 0600 "$dest"
}
```

Replace `git_access_hint` with:

```bash
# Printed when GitHub refuses the clone/fetch of a repository that is public
# and whose release tag we just resolved — so the request itself was turned
# away (update-spec.md "Naming the authentication failure"). The usual cause
# is GitHub's per-IP limit on anonymous requests: every install, update check
# and clone from one public address shares one quota, and a spent quota comes
# back as 401.
git_access_hint() {
    echo ""
    fail "GitHub refused git access to ${CYAN}https://github.com/${REPO_SLUG}${NC}."
    echo ""
    echo -e "     The repository is public, so this is GitHub's per-IP rate limit on"
    echo -e "     anonymous requests (many installs, update checks or clones from one"
    echo -e "     public address — a lab or office NAT) or, less often, this host."
    echo ""
    echo -e "     Lift the limit with a GitHub token (a fine-grained personal access"
    echo -e "     token with no permissions is enough); the installer keeps it in"
    echo -e "     ${WHITE}${XINAS_GH_TOKEN_FILE}${NC} for the update checks that follow:"
    echo -e "       ${CYAN}curl -fsSL https://github.com/${REPO_SLUG}/releases/latest/download/install.sh | sudo XINAS_GH_TOKEN=<token> bash${NC}"
    echo ""
    echo -e "     Host-side causes worth ruling out:"
    echo -e "       ${DIM}•${NC} an HTTP proxy in root's environment (${WHITE}https_proxy${NC})"
    echo -e "       ${DIM}•${NC} an ${WHITE}insteadOf${NC} rewrite or credential helper —"
    echo -e "         ${CYAN}git config --list --show-origin | grep -Ei 'credential|insteadof|proxy'${NC}"
    echo ""
    echo -e "     Reproduce the failure directly:"
    echo -e "       ${CYAN}sudo env GIT_TERMINAL_PROMPT=0 git ls-remote ${REPO_URL}${NC}"
    echo ""
}
```

`xinas_latest_release_tag`: `curl -fsSL` → `xinas_gh_curl -fsSL`.

Before `RELEASE_TAG="$(xinas_latest_release_tag)"` insert:

```bash
xinas_persist_github_token "$XINAS_GH_TOKEN_FILE"
if [[ -n "${XINAS_GH_TOKEN:-}" ]]; then
    ok "GitHub token saved to ${WHITE}${XINAS_GH_TOKEN_FILE}${NC} (0600)"
elif [[ -n "$(xinas_github_token)" ]]; then
    info "Using GitHub token from ${WHITE}${XINAS_GH_TOKEN_FILE}${NC}"
fi
```

(If `GITHUB_TOKEN` alone is set the `elif` prints the file path although the token came from the environment; acceptable — the message names a source, never a value. Keep it simple.)

Git calls:

```bash
    run_quiet "Fetching xiNAS release tags" \
        xinas_gh_git fetch origin --tags -q || { git_access_hint; exit 1; }
```

```bash
    run_quiet "Cloning xiNAS ${RELEASE_TAG} to ${INSTALL_DIR}" \
        xinas_gh_git clone -q --branch "$RELEASE_TAG" "$REPO_URL" "$INSTALL_DIR" \
        || { git_access_hint; exit 1; }
```

Check first that `run_quiet` runs `"$@"` in the same shell (functions visible): read its definition near the top of `install.sh`. If it wraps the command in `bash -c`, wrap the call as `bash -c` is not needed — it does not; if it did, the parity test's stub run would show it.

- [x] **Step 4: `prepare_system.sh`**

Shared block directly after its `export GIT_TERMINAL_PROMPT=0`. `xinas_latest_release_tag`: `curl -fsSL` → `xinas_gh_curl -fsSL`. In `xinas_update_to_latest_release`: `if ! git fetch origin --tags --quiet; then` → `if ! xinas_gh_git fetch origin --tags --quiet; then`. Bootstrap clone: `git clone --branch "$_tag" "$REPO_URL" "$REPO_DIR"` → `xinas_gh_git clone --branch "$_tag" "$REPO_URL" "$REPO_DIR"`.

- [x] **Step 5: `install_client.sh`**

Shared block directly after its `export GIT_TERMINAL_PROMPT=0`. `xinas_latest_release_tag`: via `xinas_gh_curl`. Update path: `if git fetch --quiet origin --tags && git checkout …` → `if xinas_gh_git fetch --quiet origin --tags && git checkout …`. Clone: `git clone --quiet --branch "$RELEASE_TAG" --depth 1 --filter=blob:none --sparse "$REPO_URL" "$INSTALL_DIR" 2>/dev/null` → `xinas_gh_git clone --quiet --branch …` (keep every other argument).

- [x] **Step 6: `client_repo/client_setup.sh`**

Shared block immediately above the comment that precedes `client_latest_release_tag`; that function's `curl -fsSL` → `xinas_gh_curl -fsSL`. Leave the kubernetes-csi and helm curls alone (different repositories, explicit user actions, out of scope).

- [x] **Step 7: `xinas-update-git`**

Shared block after `export GIT_TERMINAL_PROMPT=0`. Replace

```bash
        exec git fetch origin --tags --quiet
```

with

```bash
        # Not exec: xinas_gh_git is a function. Under set -e a failed fetch
        # still ends the script non-zero. Runs as root, so the token comes from
        # /etc/xinas/github-token — sudo -n strips the caller's environment.
        xinas_gh_git fetch origin --tags --quiet
```

- [x] **Step 8: Run the suites**

Run: `.venv/bin/pytest tests/test_github_token_parity.py tests/test_git_noninteractive_parity.py tests/test_release_tag_regex_parity.py tests/test_install_client_update_accuracy.py tests/test_installer_exit_code_contract.py tests/test_update_check.py -q`
Expected: all pass. If `test_every_site_carries_the_identical_block` fails, diff the two blocks — a trailing space or a re-wrapped comment is the usual cause; re-copy from `lib/menu_lib.sh`.

- [ ] **Step 9: Commit** (only after Sergey's go-ahead; this commit carries the helper change)

```bash
git add install.sh prepare_system.sh install_client.sh client_repo/client_setup.sh collection/roles/xinas_menu/files/xinas-update-git tests/test_github_token_parity.py tests/test_git_noninteractive_parity.py
git commit -m "fix(installer): honour a GitHub token on every install path and name the per-IP limit" -m "Requires-Rebuild: xinas_menu"
```

---

### Task 4: Python — token resolution, rate-limit wording, fallback git auth

**Files:**
- Modify: `xinas_menu/utils/update_check.py` (`_fetch_releases`, new `github_token`, `_describe_http_error`, `_git_auth_args`, `_privileged_git` fallback, `_git_output` env)
- Create: `tests/test_update_check_token.py`

**Interfaces:**
- Produces: `github_token(env: Mapping[str, str] | None = None, path: Path = GITHUB_TOKEN_FILE) -> str | None`; `GITHUB_TOKEN_FILE = Path("/etc/xinas/github-token")`; `_fetch_releases(repo, timeout=8.0, *, token: str | None = None)` (Task 5 adds the cache keywords); `_describe_http_error(exc, *, authenticated: bool) -> str`; `_git_auth_args(token) -> list[str]`; `_GIT_CREDENTIAL_HELPER` (the same string as the bash block's helper).
- Consumes: nothing from earlier tasks.

- [x] **Step 1: Failing tests**

`tests/test_update_check_token.py`:

```python
"""The Python update checker honours the GitHub token and names a rate limit
(docs/Installer/update-spec.md "GitHub rate limits and the access token").
"""

from __future__ import annotations

import email.message
import io
import subprocess
import urllib.error
import urllib.request

import pytest

from xinas_menu.utils import update_check as uc


# ── token resolution ─────────────────────────────────────────────────────────


def test_github_token_env_precedence(tmp_path):
    f = tmp_path / "tok"
    f.write_text("from-file\n")
    assert uc.github_token({"XINAS_GH_TOKEN": "a", "GITHUB_TOKEN": "b"}, path=f) == "a"
    assert uc.github_token({"GITHUB_TOKEN": "b"}, path=f) == "b"
    assert uc.github_token({}, path=f) == "from-file"


def test_github_token_file_first_line_trimmed_and_missing(tmp_path):
    f = tmp_path / "tok"
    f.write_text("  t \nsecond\n")
    assert uc.github_token({}, path=f) == "t"
    assert uc.github_token({}, path=tmp_path / "missing") is None
    (tmp_path / "empty").write_text("\n")
    assert uc.github_token({}, path=tmp_path / "empty") is None
    assert uc.github_token({"XINAS_GH_TOKEN": "  "}, path=tmp_path / "missing") is None


# ── HTTP error wording ───────────────────────────────────────────────────────


def _http_error(code: int, **headers: str) -> urllib.error.HTTPError:
    hdrs = email.message.Message()
    for k, v in headers.items():
        hdrs[k.replace("_", "-")] = v
    return urllib.error.HTTPError("https://api.github.com/x", code, "x", hdrs, io.BytesIO(b""))


def test_anonymous_rate_limit_names_reset_and_token():
    exc = _http_error(403, x_ratelimit_remaining="0", x_ratelimit_reset="1760000000")
    msg = uc._describe_http_error(exc, authenticated=False)
    assert msg.startswith("GitHub API rate limit exceeded for anonymous requests from this IP")
    assert "resets at 08:53 UTC" in msg  # 1760000000 = 2025-10-09 08:53:20 UTC
    assert "XINAS_GH_TOKEN" in msg and "/etc/xinas/github-token" in msg


def test_429_is_a_rate_limit_even_without_the_remaining_header():
    msg = uc._describe_http_error(_http_error(429), authenticated=False)
    assert "rate limit exceeded" in msg
    assert "resets at" not in msg


def test_token_rate_limit_names_the_token_and_drops_the_hint():
    exc = _http_error(403, x_ratelimit_remaining="0")
    msg = uc._describe_http_error(exc, authenticated=True)
    assert "for the configured token" in msg
    assert "XINAS_GH_TOKEN" not in msg


def test_403_with_remaining_quota_is_not_a_rate_limit():
    msg = uc._describe_http_error(_http_error(403, x_ratelimit_remaining="12"), authenticated=False)
    assert msg == "GitHub API HTTP 403"


def test_401_with_token_names_the_token():
    msg = uc._describe_http_error(_http_error(401), authenticated=True)
    assert msg.startswith("GitHub rejected the configured token (HTTP 401)")
    assert uc._describe_http_error(_http_error(401), authenticated=False) == "GitHub API HTTP 401"


def test_fetch_releases_surfaces_the_wording(monkeypatch):
    def boom(req, timeout):
        raise _http_error(403, x_ratelimit_remaining="0")

    monkeypatch.setattr(uc.urllib.request, "urlopen", boom)
    with pytest.raises(uc.UpdateCheckError, match="rate limit exceeded for anonymous"):
        uc._fetch_releases("XinnorLab/xiNAS", token=None)


def test_fetch_releases_sends_bearer_when_token_given(monkeypatch):
    seen = {}

    class _Resp(io.BytesIO):
        headers = email.message.Message()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake(req, timeout):
        seen["auth"] = req.get_header("Authorization")
        return _Resp(b"[]")

    monkeypatch.setattr(uc.urllib.request, "urlopen", fake)
    assert uc._fetch_releases("XinnorLab/xiNAS", token="tok") == []
    assert seen["auth"] == "Bearer tok"
    uc._fetch_releases("XinnorLab/xiNAS", token=None)
    assert seen["auth"] is None


# ── direct-git fallback carries the same helper ──────────────────────────────


def test_fallback_fetch_passes_credential_helper_when_token_set(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw.get("env")))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(uc.subprocess, "run", fake_run)
    monkeypatch.setattr(uc, "_PRIVILEGED_HELPER", tmp_path / "absent")
    monkeypatch.setattr(uc, "github_token", lambda: "tok")
    uc._privileged_git(tmp_path, "fetch")
    cmd, env = calls[0]
    assert cmd[-4:] == ["fetch", "origin", "--tags", "--quiet"]
    assert "credential.helper=" in cmd and f"credential.helper={uc._GIT_CREDENTIAL_HELPER}" in cmd
    assert cmd.index("credential.helper=") < cmd.index(f"credential.helper={uc._GIT_CREDENTIAL_HELPER}")
    assert "tok" not in " ".join(cmd)
    assert env is not None and env["XINAS_GH_TOKEN"] == "tok"


def test_fallback_fetch_is_plain_without_a_token(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw.get("env")))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(uc.subprocess, "run", fake_run)
    monkeypatch.setattr(uc, "_PRIVILEGED_HELPER", tmp_path / "absent")
    monkeypatch.setattr(uc, "github_token", lambda: None)
    uc._privileged_git(tmp_path, "fetch")
    cmd, env = calls[0]
    assert not any(a.startswith("credential.helper") for a in cmd)
    assert env is None


def test_fallback_checkout_never_carries_the_helper(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(uc.subprocess, "run", fake_run)
    monkeypatch.setattr(uc, "_PRIVILEGED_HELPER", tmp_path / "absent")
    monkeypatch.setattr(uc, "github_token", lambda: "tok")
    uc._privileged_git(tmp_path, "checkout", "v9.9.9")
    assert not any(a.startswith("credential.helper") for a in calls[0])


def test_helper_string_matches_the_bash_block():
    """One helper text everywhere — the bash sites are pinned by
    tests/test_github_token_parity.py; this pins Python to the same text."""
    from pathlib import Path

    lib = (Path(__file__).resolve().parents[1] / "lib" / "menu_lib.sh").read_text()
    assert f"'credential.helper={uc._GIT_CREDENTIAL_HELPER}'" in lib
```

- [x] **Step 2: Run to see them fail**

Run: `.venv/bin/pytest tests/test_update_check_token.py -q`
Expected: `AttributeError: module ... has no attribute 'github_token'` and friends.

- [x] **Step 3: Implement**

In `xinas_menu/utils/update_check.py` add `import time` and `from typing import Mapping` (keep imports sorted for ruff), then after `_TAG_RE`:

```python
# Where install.sh keeps the token it was given (docs/Installer/update-spec.md
# "GitHub rate limits and the access token"). Read on every check, not cached
# at import: the operator may create the file while the menu is open.
GITHUB_TOKEN_FILE = Path("/etc/xinas/github-token")

# The same inline credential helper the bash paths use (lib/menu_lib.sh
# xinas_gh_git). Git consults it only after GitHub answers 401, and it reads
# the token from the environment of that one git process — never from argv.
_GIT_CREDENTIAL_HELPER = (
    '!f() { [ "$1" = get ] || exit 0; '
    'echo username=x-access-token; echo "password=$XINAS_GH_TOKEN"; }; f'
)


def github_token(
    env: Mapping[str, str] | None = None, path: Path = GITHUB_TOKEN_FILE
) -> str | None:
    """Resolve the optional GitHub token: XINAS_GH_TOKEN, GITHUB_TOKEN, then
    the first line of *path*. Whitespace is stripped; empty means None."""
    env = os.environ if env is None else env
    for var in ("XINAS_GH_TOKEN", "GITHUB_TOKEN"):
        val = (env.get(var) or "").strip()
        if val:
            return val
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    first = lines[0].strip() if lines else ""
    return first or None


def _git_auth_args(token: str | None) -> list[str]:
    """`git -c` options that add the reactive credential helper. The leading
    empty credential.helper= clears any helper configured on the host so a
    stale stored credential cannot answer GitHub's 401 before ours does."""
    if not token:
        return []
    return ["-c", "credential.helper=", "-c", f"credential.helper={_GIT_CREDENTIAL_HELPER}"]


def _describe_http_error(exc: urllib.error.HTTPError, *, authenticated: bool) -> str:
    """Name a GitHub rate limit as such (update-spec.md "Naming the failure")."""
    headers = exc.headers
    remaining = headers.get("x-ratelimit-remaining") if headers is not None else None
    if exc.code == 429 or (exc.code == 403 and remaining == "0"):
        reset = headers.get("x-ratelimit-reset") if headers is not None else None
        when = ""
        if reset and reset.strip().isdigit():
            when = " (resets at " + time.strftime("%H:%M UTC", time.gmtime(int(reset))) + ")"
        if authenticated:
            return f"GitHub API rate limit exceeded for the configured token{when}"
        return (
            "GitHub API rate limit exceeded for anonymous requests from this IP"
            f"{when} — set XINAS_GH_TOKEN or {GITHUB_TOKEN_FILE}"
        )
    if exc.code == 401 and authenticated:
        return (
            "GitHub rejected the configured token (HTTP 401) — check "
            f"XINAS_GH_TOKEN / {GITHUB_TOKEN_FILE}"
        )
    return f"GitHub API HTTP {exc.code}"
```

Change `_fetch_releases`:

```python
def _fetch_releases(repo: str, timeout: float = 8.0, *, token: str | None = None) -> list[dict]:
    """GET the repo's releases from the GitHub API. Raises on any failure.

    *token*, when given, is sent as a bearer token so the call runs on the
    token's own quota instead of the anonymous per-IP one. Never returns
    partial/garbage on error — the caller converts the raised exception into
    a ``CheckResult`` error string. There is no branch fallback anywhere in
    this path.
    """
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "xinas-update-check",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(_releases_url(repo), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as exc:
        raise UpdateCheckError(_describe_http_error(exc, authenticated=bool(token))) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise UpdateCheckError(f"GitHub API unreachable: {reason}") from exc
    ... (json parsing unchanged)
```

Drop the old `token = os.environ.get("XINAS_GH_TOKEN") or ...` lines. In `UpdateChecker.__init__` the default fetcher becomes
`lambda: _fetch_releases(self._repo_slug, token=github_token())`.

`_git_output` gains `env`:

```python
def _git_output(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    r = subprocess.run(
        ["git", "-c", f"safe.directory={repo}", "-C", str(repo)] + list(args),
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return r.stdout.strip()
```

`_privileged_git` fallback for `fetch`:

```python
    if action == "fetch":
        token = github_token()
        env = {**os.environ, "XINAS_GH_TOKEN": token} if token else None
        return _git_output(
            repo, *_git_auth_args(token), "fetch", "origin", "--tags", "--quiet", env=env
        )
```

(`checkout` stays as is.) Extend `_privileged_git`'s docstring with one line: `The fallback fetch carries the same reactive credential helper as the bash paths when a token is configured.`

- [x] **Step 4: Run**

Run: `.venv/bin/pytest tests/test_update_check_token.py tests/test_update_check.py tests/test_update_apply_orchestration.py -q`
Expected: all pass.

- [x] **Step 5: Lint/type**

Run: `.venv/bin/ruff check xinas_menu && .venv/bin/ruff format --check xinas_menu tests && .venv/bin/pyright xinas_menu`
Expected: clean. (`pyright` must run with the venv on `PATH` or with `--pythonpath .venv/bin/python`.)

- [ ] **Step 6: Commit** (only after Sergey's go-ahead)

```bash
git add xinas_menu/utils/update_check.py tests/test_update_check_token.py
git commit -m "fix(tui): resolve the GitHub token from the file and name a rate limit"
```

---

### Task 5: Python — cached Releases payload (1 h TTL + ETag) and `check(force=…)`

**Files:**
- Modify: `xinas_menu/utils/update_check.py` (`ReleaseCache`, `_CachedReleases`, `default_cache_path`, `CHECK_CACHE_TTL`, `_fetch_releases` cache keywords, `UpdateChecker(cache_path=…)`, `check(force=…)`, `_check_sync(force)`)
- Modify: `xinas_menu/screens/management.py:86`, `xinas_menu/screens/mcp.py:474`, `xinas_menu/screens/startup/advanced_screen.py:125` — `check(force=True)`
- Modify: `xinas_menu/app.py:101` — unchanged call (documented as the cached one) — add a comment
- Create: `tests/test_update_check_cache.py`

**Interfaces:**
- Consumes: `_fetch_releases(repo, timeout, *, token)` and `github_token` from Task 4.
- Produces: `CHECK_CACHE_TTL = 3600.0`; `default_cache_path() -> Path`; `ReleaseCache(path).load() -> _CachedReleases | None`, `.save(entry)`; `_CachedReleases(checked_at: float, etag: str, installed: str, releases: list[dict])`; `_fetch_releases(..., cache: ReleaseCache | None = None, max_age: float | None = None, installed: str = "", now=time.time)`; `UpdateChecker(..., cache_path: Path | None = None)`; `async check(*, force: bool = False)`.

- [x] **Step 1: Failing tests**

`tests/test_update_check_cache.py`:

```python
"""The TUI's background check reuses a cached Releases payload for an hour and
an explicit check revalidates it with an ETag (docs/Installer/update-spec.md
"Fewer requests from the TUI"). The cache never changes the verdict — it holds
the payload GitHub returned.
"""

from __future__ import annotations

import asyncio
import email.message
import io
import json
import urllib.error

from xinas_menu.utils import update_check as uc


class _FakeGitHub:
    """Counts requests; answers a fixed payload with an ETag, or 304 when the
    request carries a matching If-None-Match."""

    def __init__(self, releases, etag='"e1"'):
        self.releases = releases
        self.etag = etag
        self.requests = []

    def __call__(self, req, timeout):
        self.requests.append(req)
        if req.get_header("If-none-match") == self.etag:
            hdrs = email.message.Message()
            raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", hdrs, io.BytesIO(b""))
        hdrs = email.message.Message()
        hdrs["ETag"] = self.etag

        class _Resp(io.BytesIO):
            headers = hdrs

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return _Resp(json.dumps(self.releases).encode())


def _rel(tag):
    return {"tag_name": tag, "draft": False, "prerelease": False, "body": "", "html_url": "", "assets": []}


def test_fresh_cache_serves_the_background_check_without_a_request(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    clock = [1000.0]
    kw = dict(cache=cache, installed="3.1.0", now=lambda: clock[0])
    assert uc._fetch_releases("r", max_age=3600, **kw) == [_rel("v9.9.9")]
    assert len(gh.requests) == 1
    clock[0] += 1800
    assert uc._fetch_releases("r", max_age=3600, **kw) == [_rel("v9.9.9")]
    assert len(gh.requests) == 1, "within the TTL the cache answers"
    clock[0] += 1801
    uc._fetch_releases("r", max_age=3600, **kw)
    assert len(gh.requests) == 2, "past the TTL GitHub is asked again"


def test_cache_is_keyed_to_the_installed_version(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    uc._fetch_releases("r", max_age=3600, cache=cache, installed="3.1.0", now=lambda: 1000.0)
    uc._fetch_releases("r", max_age=3600, cache=cache, installed="3.2.0", now=lambda: 1001.0)
    assert len(gh.requests) == 2


def test_forced_check_revalidates_with_etag_and_304_reuses_the_payload(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1000.0)
    out = uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1500.0)
    assert out == [_rel("v9.9.9")]
    assert len(gh.requests) == 2
    assert gh.requests[1].get_header("If-none-match") == '"e1"'
    saved = cache.load()
    assert saved is not None and saved.checked_at == 1500.0, "a 304 refreshes the cache age"


def test_changed_payload_replaces_the_cache(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    cache = uc.ReleaseCache(tmp_path / "c.json")
    uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1000.0)
    gh.releases = [_rel("v10.0.0")]
    gh.etag = '"e2"'
    out = uc._fetch_releases("r", max_age=None, cache=cache, installed="3.1.0", now=lambda: 1001.0)
    assert out == [_rel("v10.0.0")]
    assert cache.load().etag == '"e2"'


def test_cache_write_and_read_failures_are_ignored(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    blocker = tmp_path / "file"
    blocker.write_text("")
    cache = uc.ReleaseCache(blocker / "c.json")  # parent is a file → OSError
    assert uc._fetch_releases("r", max_age=3600, cache=cache, installed="3.1.0") == [_rel("v9.9.9")]
    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not json")
    assert uc.ReleaseCache(corrupt).load() is None


def test_cache_file_is_private(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    path = tmp_path / "c.json"
    uc._fetch_releases("r", cache=uc.ReleaseCache(path), installed="3.1.0")
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_checker_background_uses_cache_and_force_bypasses_it(tmp_path, monkeypatch):
    gh = _FakeGitHub([_rel("v9.9.9")])
    monkeypatch.setattr(uc.urllib.request, "urlopen", gh)
    monkeypatch.setattr(uc, "github_token", lambda: None)
    checker = uc.UpdateChecker(current_version="3.1.0", cache_path=tmp_path / "c.json")
    r1 = asyncio.run(checker.check())
    r2 = asyncio.run(checker.check())
    assert r1.available and r2.available and r1.latest_version == "v9.9.9"
    assert len(gh.requests) == 1
    r3 = asyncio.run(checker.check(force=True))
    assert r3.available and len(gh.requests) == 2


def test_default_cache_path_root_vs_user(monkeypatch, tmp_path):
    monkeypatch.setattr(uc.os, "geteuid", lambda: 0)
    assert uc.default_cache_path() == uc.Path("/var/cache/xinas/update-check.json")
    monkeypatch.setattr(uc.os, "geteuid", lambda: 1000)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    assert uc.default_cache_path() == tmp_path / "xdg" / "xinas" / "update-check.json"
    monkeypatch.delenv("XDG_CACHE_HOME")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert uc.default_cache_path() == tmp_path / "home" / ".cache" / "xinas" / "update-check.json"


def test_explicit_check_call_sites_force(tmp_path):
    """The three user-initiated checks must revalidate; only the on-mount
    background check may be served from the cache."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "xinas_menu"
    for rel in ("screens/management.py", "screens/mcp.py", "screens/startup/advanced_screen.py"):
        src = (root / rel).read_text()
        assert "_update_checker.check(force=True)" in src, f"{rel}: explicit check must pass force=True"
    app = (root / "app.py").read_text()
    assert "_update_checker.check()" in app, "the on-mount background check stays cached"
```

- [x] **Step 2: Run to see them fail**

Run: `.venv/bin/pytest tests/test_update_check_cache.py -q`
Expected: `AttributeError: ... 'ReleaseCache'` etc.

- [x] **Step 3: Implement the cache**

After `_git_auth_args` (Task 4) add:

```python
# One hour: the background check on every menu launch is served from the
# cache within this window (update-spec.md "Fewer requests from the TUI").
CHECK_CACHE_TTL = 3600.0


def default_cache_path() -> Path:
    """Root shares one system-wide cache; other users keep one under XDG."""
    if os.geteuid() == 0:
        return Path("/var/cache/xinas/update-check.json")
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return Path(base) / "xinas" / "update-check.json"


@dataclass(frozen=True)
class _CachedReleases:
    checked_at: float
    etag: str
    installed: str
    releases: list[dict]


class ReleaseCache:
    """Last successful Releases payload on disk. Best effort on every path:
    a cache that cannot be read or written is simply absent."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> _CachedReleases | None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return _CachedReleases(
                checked_at=float(data["checked_at"]),
                etag=str(data.get("etag") or ""),
                installed=str(data.get("installed") or ""),
                releases=list(data["releases"]),
            )
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def save(self, entry: _CachedReleases) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(asdict(entry)), encoding="utf-8")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except OSError:
            pass
```

(`from dataclasses import asdict, dataclass, field`.) Then `_fetch_releases` becomes:

```python
def _fetch_releases(
    repo: str,
    timeout: float = 8.0,
    *,
    token: str | None = None,
    cache: ReleaseCache | None = None,
    max_age: float | None = None,
    installed: str = "",
    now=time.time,
) -> list[dict]:
    """GET the repo's releases from the GitHub API. Raises on any failure.

    *token*, when given, is sent as a bearer token so the call runs on the
    token's own quota instead of the anonymous per-IP one. With a *cache*, a
    payload younger than *max_age* seconds that was fetched for the same
    *installed* version is returned without a request; otherwise the cached
    ETag is sent as If-None-Match and a 304 reuses the payload. Never returns
    partial/garbage on error — the caller converts the raised exception into a
    ``CheckResult`` error string. There is no branch fallback anywhere in this
    path.
    """
    cached = cache.load() if cache is not None else None
    if cached is not None and cached.installed != installed:
        cached = None
    if cached is not None and max_age is not None and now() - cached.checked_at < max_age:
        return cached.releases

    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "xinas-update-check",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if cached is not None and cached.etag:
        headers["If-None-Match"] = cached.etag
    req = urllib.request.Request(_releases_url(repo), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            etag = str(resp.headers.get("ETag") or "")
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and cached is not None:
            if cache is not None:
                cache.save(replace(cached, checked_at=now()))
            return cached.releases
        raise UpdateCheckError(_describe_http_error(exc, authenticated=bool(token))) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise UpdateCheckError(f"GitHub API unreachable: {reason}") from exc
    try:
        data = json.loads(payload)
    except (ValueError, TypeError) as exc:
        raise UpdateCheckError("GitHub API returned malformed JSON") from exc
    if not isinstance(data, list):
        raise UpdateCheckError("GitHub API returned an unexpected payload")
    if cache is not None:
        cache.save(_CachedReleases(checked_at=now(), etag=etag, installed=installed, releases=data))
    return data
```

(`from dataclasses import asdict, dataclass, field, replace`.)

`UpdateChecker`:

```python
    def __init__(
        self,
        repo_path: Path | None = None,
        *,
        repo: str = _DEFAULT_REPO,
        channel: str | None = None,
        current_version: str | None = None,
        required_asset: str | None = None,
        releases_fetcher=None,
        cache_path: Path | None = None,
    ) -> None:
        ...
        self._cache = ReleaseCache(cache_path or default_cache_path())
        # Injectable seam for tests; production uses the real API (with the
        # cache: a background check may be served from disk, a forced one
        # always revalidates against GitHub).
        if releases_fetcher is not None:
            self._fetch = lambda force: releases_fetcher()
        else:
            self._fetch = lambda force: _fetch_releases(
                self._repo_slug,
                token=github_token(),
                cache=self._cache,
                max_age=None if force else CHECK_CACHE_TTL,
                installed=self._current,
            )

    async def check(self, *, force: bool = False) -> CheckResult:
        """Query the Releases API and compare versions. Non-blocking.

        *force* — an explicit, user-initiated check: always contact GitHub
        (revalidating with the cached ETag). The default serves the
        background check on launch from the cache when it is fresh.
        """
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._check_sync, force)

    def _check_sync(self, force: bool = False) -> CheckResult:
        try:
            raw = self._fetch(force)
```

Call sites: `management.py:86`, `mcp.py:474`, `advanced_screen.py:125` → `await self.app._update_checker.check(force=True)`. In `app.py` above `result = await self._update_checker.check()` add the comment `# Background check on launch: may be served from the one-hour cache.`

- [x] **Step 4: Run**

Run: `.venv/bin/pytest tests/test_update_check_cache.py tests/test_update_check_token.py tests/test_update_check.py tests/test_update_apply_orchestration.py -q`
Expected: all pass.

- [x] **Step 5: Lint/type**

Run: `.venv/bin/ruff check xinas_menu && .venv/bin/ruff format --check . && .venv/bin/pyright xinas_menu`
Expected: clean.

- [ ] **Step 6: Commit** (only after Sergey's go-ahead)

```bash
git add xinas_menu/utils/update_check.py xinas_menu/app.py xinas_menu/screens/management.py xinas_menu/screens/mcp.py xinas_menu/screens/startup/advanced_screen.py tests/test_update_check_cache.py
git commit -m "fix(tui): cache the Releases payload for an hour and revalidate explicit checks with an ETag"
```

---

### Task 6: Verification gate and review

- [x] **Step 1: Full gate**

```bash
.venv/bin/pytest --cov=xinas_history --cov-fail-under=20 -q
.venv/bin/ruff check xinas_menu xinas_history xiNAS-MCP/nfs-helper
.venv/bin/ruff format --check .
.venv/bin/pyright --pythonpath .venv/bin/python xinas_menu xinas_history xiNAS-MCP/nfs-helper
npx --yes markdownlint-cli2 'docs/**/*.md'
for f in install.sh prepare_system.sh install_client.sh client_repo/client_setup.sh lib/menu_lib.sh startup_menu.sh simple_menu.sh post_install_menu.sh collection/roles/xinas_menu/files/xinas-update-git; do bash -n "$f" || echo "FAIL $f"; done
```

Expected: all green.

- [ ] **Step 2: Adversarial review**

Dispatch a reviewer with the brief: try to (a) make the token reach argv, a log, `.git/config` or `~/.git-credentials` on any path; (b) find a curl against `api.github.com` or a network git call for xiNAS releases that bypasses the wrappers; (c) make the cache change a verdict (stale `available`, missed trailer union, wrong installed version); (d) break PR #333's non-interactive guarantee; (e) find a way the empty `credential.helper=` or the `-K -` stdin breaks an existing caller (`run_quiet`, `set -euo pipefail`, `$(...)` capture).

- [ ] **Step 3: Report to Sergey and wait for the commit go-ahead**

Summarise: what changed, the gate output, the review findings and their fixes, and the exact commit set (with `Requires-Rebuild: xinas_menu` on the helper commit). Then, on his word: commit, push, open the PR against `release/3.14` with `--merge` semantics in the description, and note the later cherry-pick set for the `v3.13.x` hotfix (PR #333's commit plus these).
