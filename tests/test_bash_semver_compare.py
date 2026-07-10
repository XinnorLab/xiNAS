"""WS3 (T4, F6): update-available decisions in the bash menus must use
semantic-version ordering, not string inequality
(docs/Installer/update-spec.md "Bash-path parity"). Mirrors
xinas_menu/utils/update_check.py's _semver_key precedence: a final release
outranks a prerelease of the same X.Y.Z.

T4 also (Part B) hoists check_for_updates/_latest_release_tag/
_current_release_tag out of both menus into the single canonical copy in
lib/menu_lib.sh (they were byte-identical and had been fixed twice, in T3).
So the plan's original assertion ("_semver_gt appears in both menu files")
no longer holds after the hoist — check_for_updates, and therefore
_semver_gt, now lives only in lib/menu_lib.sh. This file's
test_check_for_updates_uses_semver_not_string_inequality targets the real
post-hoist location instead: no string-inequality comparison anywhere
(lib/menu_lib.sh or either menu), _semver_gt used in lib/menu_lib.sh, and
neither menu re-defines its own check_for_updates/_latest_release_tag/
_current_release_tag (the hoist would be pointless if a menu still shadowed
the shared copy).

Mandate A1 (errexit safety): _semver_gt is hardened so every branch returns
0/1 via an explicit `if (( … )); then return 0; else return 1; fi`, never a
bare `(( … )); return`. A bare `(( expr ))` that evaluates false exits 1,
and under `set -euo pipefail` a failing simple command that is not itself
being tested by an if/while/until condition, a `&&`/`||` list, or `!`
negation kills the shell immediately — bash exempts the *entire* execution
of a compound command / function call from -e only while that call's own
result is being tested, which is why every existing call site (always
`if _semver_gt …; then`) was already safe, but only by accident. A truly
unguarded (bare, unconditional) invocation of a boolean predicate that
legitimately answers "false" will still trip `errexit` no matter how it is
implemented internally — that is `set -e` working as intended for an
un-guarded failing command, not a bug to suppress. What hardening actually
buys: a bare call where the honest answer is "true" (0) is proven to
survive and continue executing past it (test_bare_call_true_survives_under_errexit),
and a bare call where the honest answer is "false" is proven to still fail
with exactly exit status 1 — not some other, incidental status arising from
whichever intermediate arithmetic test happened to run last
(test_bare_call_false_fails_cleanly_under_errexit).
"""

import subprocess
import textwrap
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MENU_LIB = REPO / "lib" / "menu_lib.sh"
STARTUP_MENU = REPO / "startup_menu.sh"
SIMPLE_MENU = REPO / "simple_menu.sh"


def _semver_gt(a: str, b: str) -> bool:
    script = f'source "{MENU_LIB}" >/dev/null 2>&1; _semver_gt "{a}" "{b}"'
    proc = subprocess.run(["bash", "-c", script])
    return proc.returncode == 0


def test_newer_patch_is_greater():
    assert _semver_gt("v3.1.1", "v3.1.0") is True
    assert _semver_gt("v3.1.0", "v3.1.1") is False


def test_newer_minor_is_greater():
    assert _semver_gt("v3.2.0", "v3.1.9") is True
    assert _semver_gt("v3.1.9", "v3.2.0") is False


def test_newer_major_is_greater():
    assert _semver_gt("v4.0.0", "v3.9.9") is True
    assert _semver_gt("v3.9.9", "v4.0.0") is False


def test_equal_versions_not_greater():
    assert _semver_gt("v3.1.0", "3.1.0") is False
    assert _semver_gt("3.1.0", "v3.1.0") is False


def test_v_prefix_equivalence():
    assert _semver_gt("v3.2.0", "3.1.9") is True
    assert _semver_gt("3.2.0", "v3.1.9") is True


def test_final_release_outranks_prerelease_same_xyz():
    assert _semver_gt("v3.2.0", "v3.2.0-rc.1") is True
    assert _semver_gt("v3.2.0-rc.1", "v3.2.0") is False


def test_older_release_is_not_greater():
    assert _semver_gt("v3.0.9", "v3.1.0") is False


def test_unparseable_tags_report_not_greater():
    # No comparison possible must never manufacture a false "update available".
    assert _semver_gt("v3.1.1", "") is False
    assert _semver_gt("v3.1.1", "not-a-tag") is False
    assert _semver_gt("", "v3.1.1") is False
    assert _semver_gt("not-a-tag", "not-a-tag") is False


# ── WS3 T4 code review: leading-zero octal inversion, oversized-component
# overflow, and REPO_DIR unbound-under-`set -u` ─────────────────────────────


def _semver_gt_proc(a: str, b: str) -> subprocess.CompletedProcess:
    """Like _semver_gt but captures stdout/stderr so tests can also assert
    on stderr noise (e.g. the bash octal-arithmetic error the leading-zero
    fix eliminates)."""
    script = f'source "{MENU_LIB}" >/dev/null 2>&1; _semver_gt "{a}" "{b}"'
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True)


def test_leading_zero_components_are_rejected():
    """Bash `((...))` reads a leading-zero literal as octal: "v1.010.0" used
    to compare as octal 8 (< 9), inverting the true decimal 10 > 9, and
    "v1.08.0" is not even a valid octal literal, so the comparison used to
    raise `value too great for base` -- swallowed as false because it fired
    as the *tested* condition of `if ((...))`, letting the patch field
    silently decide instead of the real minor-version difference. SemVer's
    own no-leading-zero rule (enforced in _semver_parse) makes both tags
    simply unparseable, so both directions read as "not greater" -- never a
    false "update available" -- and no stderr noise reaches the caller."""
    for a, b in (
        ("v1.010.0", "v1.9.0"),
        ("v1.9.0", "v1.010.0"),
        ("v1.08.0", "v1.7.0"),
        ("v1.7.0", "v1.08.0"),
    ):
        proc = _semver_gt_proc(a, b)
        assert proc.returncode == 1, f"_semver_gt({a!r}, {b!r}) should be False"
        assert proc.stderr == "", f"_semver_gt({a!r}, {b!r}) leaked stderr noise: {proc.stderr!r}"


def test_oversized_numeric_component_is_rejected():
    """A 26-digit patch component used to overflow bash's signed 64-bit
    `((...))` arithmetic and wrap negative, comparing as smaller than a tiny
    patch value. The 18-digit cap in _semver_parse's component regex makes
    the tag unparseable instead, so neither direction manufactures a false
    comparison."""
    huge = "v1.2.99999999999999999999999999"
    assert _semver_gt(huge, "v1.2.3") is False
    assert _semver_gt("v1.2.3", huge) is False


def test_normal_versions_still_compare():
    """Regression guard: tightening the component regex to reject leading
    zeros must not break ordinary multi-digit tags, and a bare "0" component
    (common in v0.x.y and v1.0.0 tags) must still be valid."""
    assert _semver_gt("v3.10.0", "v3.9.0") is True
    assert _semver_gt("v3.9.0", "v3.10.0") is False
    assert _semver_gt("v10.0.0", "v9.9.9") is True
    # A bare "0" component must still parse and compare correctly.
    assert _semver_gt("v0.1.0", "v0.0.9") is True
    assert _semver_gt("v1.0.0", "v0.9.9") is True


def test_check_for_updates_returns_quietly_when_repo_dir_unset():
    """check_for_updates' first line used to be a plain assignment reading
    $REPO_DIR -- a plain assignment gets no errexit/nounset exemption, so
    sourcing lib/menu_lib.sh under `set -euo pipefail` with REPO_DIR unset
    and calling check_for_updates aborted the ENTIRE shell with
    "REPO_DIR: unbound variable". It was safe only because both current
    callers (startup_menu.sh, simple_menu.sh) set REPO_DIR before sourcing
    this file. check_for_updates already returns 0 silently for every other
    missing precondition (no .git, no git binary, no network); the added
    guard makes a missing REPO_DIR consistent with that."""
    script = textwrap.dedent(f"""\
        set -euo pipefail
        unset REPO_DIR
        source "{MENU_LIB}" >/dev/null 2>&1
        check_for_updates
        echo "SURVIVED"
        """)
    proc = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    assert proc.stdout.strip() == "SURVIVED"
    assert proc.stderr == ""


def test_check_for_updates_uses_semver_not_string_inequality():
    """Post-hoist (Part B): check_for_updates/_semver_gt live only in
    lib/menu_lib.sh; the menus must not carry either the old string-
    inequality comparison or their own shadow copies of the hoisted
    functions."""
    lib_body = MENU_LIB.read_text()
    assert '"$current_tag" != "$latest_tag"' not in lib_body, (
        "lib/menu_lib.sh still compares release tags by string inequality (F6)"
    )
    assert "_semver_gt" in lib_body, (
        "lib/menu_lib.sh's check_for_updates must call the shared _semver_gt helper"
    )
    assert "check_for_updates()" in lib_body, (
        "lib/menu_lib.sh must define the single canonical check_for_updates"
    )

    for f in (STARTUP_MENU, SIMPLE_MENU):
        body = f.read_text()
        assert '"$current_tag" != "$latest_tag"' not in body, (
            f"{f.name} still compares release tags by string inequality (F6)"
        )
        for fn in ("check_for_updates", "_latest_release_tag", "_current_release_tag"):
            assert f"{fn}()" not in body, (
                f"{f.name} must not re-define {fn}() — it shadows the hoisted "
                "copy in lib/menu_lib.sh (Part B)"
            )
        assert "_semver_gt" not in body, (
            f"{f.name} calls _semver_gt directly instead of relying on the "
            "hoisted check_for_updates in lib/menu_lib.sh"
        )


def test_menus_still_call_check_for_updates_at_startup():
    # The hoist must not remove the top-level call site — only the
    # definitions move.
    import re

    for f in (STARTUP_MENU, SIMPLE_MENU):
        body = f.read_text()
        assert re.search(r"^check_for_updates\s*$", body, re.M), (
            f"{f.name} must still call check_for_updates synchronously at startup"
        )


# ── Mandate A1: bare-call errexit safety ────────────────────────────────────


def test_bare_call_true_survives_under_errexit():
    """A bare (unconditional) call to _semver_gt under `set -euo pipefail`
    must survive when the honest answer is "true" (exit 0) and execution
    must continue past it — proving the hardened body reaches an explicit
    `return 0` cleanly, with no accidental abort along the way."""
    script = textwrap.dedent(f"""\
        set -euo pipefail
        source "{MENU_LIB}" >/dev/null 2>&1
        _semver_gt v3.1.0 v3.0.9
        echo "REACHED_AFTER_TRUE"
        """)
    proc = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert proc.returncode == 0, f"stdout={proc.stdout}\nstderr={proc.stderr}"
    assert "REACHED_AFTER_TRUE" in proc.stdout


def test_bare_call_false_fails_cleanly_under_errexit():
    """A bare, unguarded call whose honest answer is "false" still trips
    `errexit` — that is `set -e` behaving correctly for an unguarded failing
    command, not something further hardening should (or can) suppress. What
    matters is that it fails with exactly the function's own exit status
    (1), not an unrelated/incidental code from whichever inner arithmetic
    test happened to run last — proving the hardened branches are self-
    contained `return 0`/`return 1` rather than a bare `(( … )); return`
    that relies on $? happening to still hold the right value."""
    script = textwrap.dedent(f"""\
        set -euo pipefail
        source "{MENU_LIB}" >/dev/null 2>&1
        _semver_gt v1.0.0 v2.0.0
        echo "UNREACHABLE"
        """)
    proc = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert proc.returncode == 1, f"expected exit 1, got {proc.returncode}"
    assert "UNREACHABLE" not in proc.stdout


# ── Part C: the interactive apply path gets a longer network bound ─────────


_STUB_CURL_SLEEPS = textwrap.dedent("""\
    #!/bin/bash
    max_time=999999
    prev=""
    for a in "$@"; do
        if [[ "$prev" == "--max-time" ]]; then
            max_time="$a"
        fi
        prev="$a"
    done
    sleep_for=5
    if (( max_time < sleep_for )); then
        sleep "$max_time"
        exit 28
    fi
    sleep "$sleep_for"
    echo '{"tag_name": "v9.9.9"}'
    """)


def test_passive_bound_gives_up_but_interactive_bound_resolves(tmp_path):
    """_latest_release_tag (lib/menu_lib.sh, Part C) takes an optional
    max-time (and connect-timeout) so the passive startup check
    (check_for_updates, default 3s) and the interactive do_update path (both
    menus, a longer explicit bound) can carry different bounds from the
    same helper. A stub curl that only ever responds after ~5s stands in for
    a slow-but-live network: the passive default must give up empty-handed
    well under 5s, while a >=15s bound (what do_update now passes) must ride
    out the delay and resolve the tag.

    This exercises the shared primitive directly rather than driving the
    full interactive do_update() through a pty: do_update needs whiptail/
    msg_box dialogs and a real navigation sequence to reach its resolve
    line, which the existing pty harness in
    test_update_check_backgrounding.py already shows is expensive to set up
    for menu structure alone. do_update's own resolve line is exactly
    `_latest_release_tag <bound>` (verified below to be >= 15), so testing
    the helper's bound-dependent behavior in isolation proves the same
    thing the interactive path relies on.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "curl").write_text(_STUB_CURL_SLEEPS)
    (bin_dir / "curl").chmod(0o755)

    def _run(*args: str) -> subprocess.CompletedProcess:
        arg_str = " ".join(f'"{a}"' for a in args)
        script = (
            f'export PATH="{bin_dir}:$PATH"\n'
            f'source "{MENU_LIB}" >/dev/null 2>&1\n'
            f'REPO_SLUG="dummy/dummy"\n'
            f"_latest_release_tag {arg_str}\n"
        )
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)

    # Passive default (no args -> 3s max-time): gives up, empty result, fast.
    import time

    start = time.time()
    passive = _run()
    elapsed = time.time() - start
    assert passive.stdout.strip() == "", f"expected empty result, got {passive.stdout!r}"
    assert elapsed < 5.0, f"passive default took {elapsed:.1f}s -> not bounded to ~3s"

    # Interactive bound (>=15s max-time): rides out the 5s delay, resolves.
    start = time.time()
    interactive = _run("20", "5")
    elapsed = time.time() - start
    assert interactive.stdout.strip() == "v9.9.9", (
        f"expected the tag to resolve under the longer bound, got {interactive.stdout!r}"
    )
    assert elapsed >= 5.0


def test_do_update_passes_at_least_15s_bound_in_both_menus():
    import re

    for f in (STARTUP_MENU, SIMPLE_MENU):
        body = f.read_text()
        m = re.search(r'_tag="\$\{UPDATE_TARGET_TAG:-\$\(_latest_release_tag\s+(\d+)', body)
        assert m, (
            f"{f.name}: do_update's resolve line must call _latest_release_tag with an explicit bound"
        )
        assert int(m.group(1)) >= 15, (
            f"{f.name}: do_update's _latest_release_tag bound ({m.group(1)}s) is too "
            "short for an explicit, already-waited-on interactive action"
        )
