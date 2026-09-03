"""Every unattended install/update path must disable git's terminal prompt
(docs/Installer/update-spec.md "Bash-path parity" → *Non-interactive git
access*).

Reproduced in the field on a fresh 22.04 host: `install.sh` resolved
`v3.13.0` from the Releases API, then its clone stalled forever with
`Username for 'https://github.com':` printed over the spinner. GitHub
answers a fetch/clone it will not serve with `401`, and git's reflex on a
`401` is to prompt on `/dev/tty` — which install.sh's `run_quiet` cannot
intercept, because it redirects only stdout/stderr into the install log and
backgrounds the command. The operator sees a bare prompt with no context
and an installer that never returns. `xinas-update-git` (the privileged
update helper) has exported `GIT_TERMINAL_PROMPT=0` since it landed; the
three bootstrap scripts that run *before* that helper exists did not.

The repository is public and the tag exists, so a `401` on this path is
GitHub throttling anonymous requests from this host's public address
(docs/Installer/update-spec.md "GitHub rate limits and the access token") or,
less often, a host-side proxy or credential helper. Hanging on an invisible
prompt tells the operator none of that, hence the second half of the
contract: name the per-IP limit, give the token remedy, then the host-side
causes.

`prepare_system.sh -u` is driven end-to-end here with a stubbed git, the
way tests/test_bash_checkout_force_parity.py drives it. `install.sh` and
`install_client.sh` gate on `EUID == 0` at the top and mutate the real
filesystem, so they are pinned structurally — the same documented fallback
those sibling suites use — with an ordering assertion that the export
really precedes the first `git` call rather than merely appearing somewhere
in the file.
"""

import os
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO / "install.sh"
INSTALL_CLIENT_SH = REPO / "install_client.sh"
PREPARE_SYSTEM = REPO / "prepare_system.sh"
UPDATE_GIT_HELPER = REPO / "collection" / "roles" / "xinas_menu" / "files" / "xinas-update-git"

EXPORT_RE = re.compile(r"^[ \t]*export GIT_TERMINAL_PROMPT=0[ \t]*$", re.M)
# Matches a git invocation as a command word: at the start of a statement, or
# after run_quiet/if/&&/||/! etc. Deliberately loose — a false positive here
# only makes the ordering assertion stricter.
GIT_CALL_RE = re.compile(r"(?<![\w./-])git[ \t]+[a-z]", re.M)


def _first_git_call_line(src: str) -> int:
    for m in GIT_CALL_RE.finditer(src):
        line = src[: m.start()].count("\n") + 1
        stripped = src.splitlines()[line - 1].lstrip()
        if stripped.startswith("#"):
            continue
        return line
    raise AssertionError("no git invocation found")


@pytest.mark.parametrize(
    "script",
    [INSTALL_SH, INSTALL_CLIENT_SH, PREPARE_SYSTEM, UPDATE_GIT_HELPER],
    ids=lambda p: p.name,
)
def test_export_precedes_first_git_call(script):
    src = script.read_text()
    exports = [src[: m.start()].count("\n") + 1 for m in EXPORT_RE.finditer(src)]
    assert exports, (
        f"{script.name} must export GIT_TERMINAL_PROMPT=0 — otherwise a 401 from "
        "GitHub makes git prompt for a username on /dev/tty and the unattended "
        "run hangs (update-spec.md, Non-interactive git access)"
    )
    assert min(exports) < _first_git_call_line(src), (
        f"{script.name} exports GIT_TERMINAL_PROMPT=0 only after it has already "
        "called git — the first call can still hang"
    )


def test_prepare_system_update_only_runs_git_without_terminal_prompt(tmp_path):
    """Behavioral: the stub git records the variable it was actually invoked
    with, so this fails if the export is written but not exported (a plain
    assignment), or is scoped to a subshell the git calls do not run in.
    """
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
    env_log = tmp_path / "git-env.log"
    (stub_bin / "git").write_text(
        f'#!/bin/bash\necho "$1 GIT_TERMINAL_PROMPT=${{GIT_TERMINAL_PROMPT-unset}}" >> "{env_log}"\nexit 0\n'
    )
    (stub_bin / "git").chmod(0o755)
    (stub_bin / "curl").write_text('#!/bin/bash\necho \'{"tag_name": "v9.9.9"}\'\n')
    (stub_bin / "curl").chmod(0o755)

    env = dict(os.environ, PATH=f"{stub_bin}:{os.environ['PATH']}")
    env.pop("GIT_TERMINAL_PROMPT", None)
    env.pop("XINAS_GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
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
    calls = env_log.read_text().splitlines()
    assert calls, "expected git to be invoked by the -u path"
    assert all(c.endswith("GIT_TERMINAL_PROMPT=0") for c in calls), calls


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
    fetch_call, checkout_call = log.split("checkout", 1)
    assert "credential.helper=" in fetch_call, "fetch must carry the reactive helper"
    assert "username=x-access-token" in fetch_call
    assert "env XINAS_GH_TOKEN=sekret" in fetch_call
    argv_lines = [ln for ln in log.splitlines() if not ln.startswith("env ")]
    assert "sekret" not in "\n".join(argv_lines), "the token must never reach git's argv"
    assert "credential.helper" not in checkout_call, "checkout is local and stays plain git"


def _git_access_hint_body() -> str:
    src = INSTALL_SH.read_text()
    m = re.search(r"^git_access_hint\(\) \{\n.*?\n\}\n", src, re.M | re.S)
    assert m, "install.sh must define git_access_hint() for refused git access"
    body = m.group(0)
    # The token instructions are shared with the release-lookup failure and
    # live in their own function; read them through the call.
    if "token_howto_hint" in body:
        h = re.search(r"^token_howto_hint\(\) \{\n.*?\n\}\n", src, re.M | re.S)
        assert h, "install.sh must define token_howto_hint()"
        body += h.group(0)
    return body


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
    assert "--preserve-env=XINAS_GH_TOKEN" in body, (
        "the hint must hand the token over by name — sudo VAR=value would put "
        "the value in ps for the whole run and in sudo's log (sudoers(5) LOG FORMAT)"
    )
    assert "XINAS_GH_TOKEN=<token>" not in body
    assert "/etc/xinas/github-token" in body or "XINAS_GH_TOKEN_FILE" in body, (
        "the hint must name the token file"
    )
    assert re.search(r"\bproxy\b", body, re.I), "the hint must still name a proxy as a cause"
    assert "${REPO_SLUG}" in body or "$REPO_URL" in body, (
        "the hint must print the repository it tried to reach"
    )


# Only the network operations: `git checkout` is local, so a failure there is a
# dirty or mismatched tree, not a credential problem, and the access hint would
# misdirect the operator.
@pytest.mark.parametrize("call", ["xinas_gh_git fetch", "xinas_gh_git clone"])
def test_install_sh_routes_git_failures_into_the_hint(call):
    src = INSTALL_SH.read_text()
    m = re.search(rf"^\s*{call}\b.*$", src, re.M)
    assert m, f"{call} call site not found in install.sh"
    # From the start of the call line: the `||` guard may sit on that same
    # line or on a continuation below it.
    window = src[m.start() : m.end() + 120]
    assert "git_access_hint" in window, (
        f"a failed `{call}` must explain the likely cause, not just dump the log tail"
    )


def test_bash_syntax_ok():
    for script in (INSTALL_SH, INSTALL_CLIENT_SH, PREPARE_SYSTEM, UPDATE_GIT_HELPER):
        subprocess.run(["bash", "-n", str(script)], check=True)
