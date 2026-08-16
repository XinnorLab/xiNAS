"""The login banner must not paint a RAID array healthier than it is.

Both motd templates embed the same small Python reader over
``xicli raid show -f json``. It used to take ``state[0]`` and match it against
an invented vocabulary (``rebuilding``, ``active``) rather than xiRAID's own
(AG 4.4 "Showing RAID State",
https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html), which
made two things wrong at once:

* ``state`` is a LIST of words. ``["online", "degraded"]`` rendered as a green
  ``online`` — the banner said the array was fine while a drive was gone.
* ``reconstructing`` and ``initing`` are the real state words; neither matched
  the invented set, so both fell through to the red cross.

These tests run the extracted snippet as its own process, so what is asserted
is the code that actually ships in the banner.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
TEMPLATES = (
    REPO / "collection/roles/motd/templates/99-xinas-status.j2",
    REPO / "collection/roles/motd/templates/generate-banner.j2",
)

_SNIPPET = re.compile(r'python3 -c "\n(import sys, json.*?)\n" 2>/dev/null', re.S)


def _snippet(path: Path) -> str:
    match = _SNIPPET.search(path.read_text())
    assert match, f"no RAID-status python snippet found in {path.name}"
    return match.group(1)


def _render(snippet: str, payload: dict) -> list[list[str]]:
    proc = subprocess.run(
        [sys.executable, "-c", snippet],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    assert proc.stderr == "", proc.stderr
    return [line.split("|") for line in proc.stdout.strip().splitlines() if line]


def _array(*states):
    return {"data": {"name": "data", "level": "5", "size": "100G", "state": list(states)}}


GREEN = "\033[1;32m"
YELLOW = "\033[1;33m"
RED = "\033[0;31m"


@pytest.fixture(params=[p.name for p in TEMPLATES], ids=lambda n: n)
def snippet(request):
    return _snippet(next(p for p in TEMPLATES if p.name == request.param))


def test_both_templates_carry_the_same_reader():
    """They render the same section; a fix to one must not miss the other."""
    first, second = (_snippet(p) for p in TEMPLATES)
    assert first == second


def test_healthy_array_is_green(snippet):
    (row,) = _render(snippet, _array("online", "initialized"))
    assert row[0] == "✓"
    assert row[4] == GREEN


def test_a_bad_word_anywhere_in_the_list_wins(snippet):
    """The whole list is read, not just its first word."""
    (row,) = _render(snippet, _array("online", "degraded"))
    assert row[0] == "✗"
    assert row[4] == RED
    # ...and the word the operator is shown is the one that decided it.
    assert row[5] == "degraded"


@pytest.mark.parametrize("state", ["initing", "restriping", "sdc_scanning", "need_restripe"])
def test_in_progress_states_are_yellow_not_red(snippet, state):
    """An initializing or scanning array is busy, not broken."""
    (row,) = _render(snippet, _array("online", state))
    assert row[0] == "⚠"
    assert row[4] == YELLOW
    assert row[5] == state


@pytest.mark.parametrize(
    "state",
    [
        "degraded",
        "reconstructing",
        "need_recon",
        "need_init",
        "inconsistent",
        "read_only",
        "offline",
        "none",
        "unrecovered",
    ],
)
def test_redundancy_loss_states_are_red(snippet, state):
    (row,) = _render(snippet, _array(state))
    assert row[0] == "✗"
    assert row[4] == RED


def test_unknown_state_word_is_not_painted_green(snippet):
    (row,) = _render(snippet, _array("online", "some_future_state"))
    assert row[0] != "✓"


def test_bare_string_state_still_works(snippet):
    """Older payloads report `state` as a single string, not a list."""
    (row,) = _render(snippet, {"data": {"name": "data", "level": "5", "state": "online"}})
    assert row[0] == "✓"


def test_empty_payload_reports_empty(snippet):
    (row,) = _render(snippet, {})
    assert row[0] == "EMPTY"


# ---- unreadable state payloads --------------------------------------------
#
# The same hole the health check had: the reader inferred the verdict from the
# payload's shape. `state: null` and `state: []` both left the word list empty
# and fell through to the healthy branch, so an array whose state was not
# reported at all was painted green.


@pytest.mark.parametrize(
    ("label", "state"),
    [("null", None), ("empty list", []), ("empty string", ""), ("number", 7), ("dict", {"a": 1})],
)
def test_unreadable_state_is_never_green(snippet, label, state):
    (row,) = _render(snippet, {"data": {"name": "data", "level": "5", "state": state}})
    assert row[0] != "✓", f"{label} rendered as healthy"
    assert row[4] != GREEN


def test_missing_state_key_is_never_green(snippet):
    (row,) = _render(snippet, {"data": {"name": "data", "level": "5"}})
    assert row[0] != "✓"


def test_a_readable_failure_survives_a_junk_entry(snippet):
    (row,) = _render(snippet, {"data": {"name": "data", "level": "5", "state": [None, "degraded"]}})
    assert row[0] == "✗"
    assert row[5] == "degraded"


def test_snippet_is_safe_inside_the_shell_double_quotes():
    """The reader lives in `python3 -c "..."` inside the template.

    Bash expands `$`, backticks and `\\` inside double quotes, and a stray
    backtick in a comment becomes a command substitution that bash -n happily
    accepts and then misexecutes at runtime. Jinja delimiters would be eaten
    before bash ever sees them.
    """
    for path in TEMPLATES:
        snippet = _snippet(path)
        for token in ('"', "`", "$", "{{", "{%", "{#"):
            assert token not in snippet, f"{path.name} snippet contains {token!r}"
