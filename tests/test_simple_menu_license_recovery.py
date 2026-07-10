"""WS3.2 (T2, F3): simple_menu.sh must never write `xicli license show`
output straight to the canonical license path (docs/Installer/spec.md §8.2 —
that output has no license_key blob, so it is unusable by
`xicli license update -p`). startup_menu.sh already carries the fix
(_save_recovered_license_note, writing only <file>.recovered); mirror it.

Structural: driving simple_menu.sh's interactive menu_select prompts end to
end would need a full pty + arrow-key/digit-key navigation harness for a
pure text-content fix; a regex guard on the source (the same pattern already
used for startup_menu.sh's own regression coverage) is the practical check.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIMPLE = REPO / "simple_menu.sh"
STARTUP = REPO / "startup_menu.sh"


def test_helper_function_mirrored_from_startup_menu():
    assert "_save_recovered_license_note" in SIMPLE.read_text(), (
        "simple_menu.sh must define _save_recovered_license_note(), mirrored "
        "from startup_menu.sh's reference implementation"
    )


def test_xiraid_license_output_never_redirected_to_canonical_path():
    body = SIMPLE.read_text()
    # The only acceptable destination for $_XIRAID_LICENSE_OUTPUT is the
    # helper's own ".recovered" note file, never /tmp/license or
    # "$license_file" directly.
    assert not re.search(r'\$_XIRAID_LICENSE_OUTPUT"?\s*>\s*"?\$license_file', body)
    assert not re.search(r'\$_XIRAID_LICENSE_OUTPUT"?\s*>\s*/tmp/license\b', body)


def test_recovered_note_path_used_at_all_three_sites():
    # Assert the three exact call patterns rather than a bare mention count: a
    # count alone would still pass if a real call site were deleted and an
    # unrelated mention (a comment, say) added in its place. Pinning the
    # literal calls also pins the `|| true` suffix, which errexit makes
    # load-bearing — the helper returns 1 by design, and a `case` branch does
    # not suppress that under `set -euo pipefail`.
    body = SIMPLE.read_text()
    assert body.count('_save_recovered_license_note "$license_file" || true') == 2
    assert body.count("_save_recovered_license_note /tmp/license || true") == 1
    assert body.count("_save_recovered_license_note() {") == 1


def test_matches_startup_menu_function_body():
    # Same function body as the reference implementation (allow whitespace
    # drift only).
    def _norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip()

    fn_re = re.compile(r"_save_recovered_license_note\(\)\s*\{.*?\n\}", re.S)
    simple_fn = fn_re.search(SIMPLE.read_text())
    startup_fn = fn_re.search(STARTUP.read_text())
    assert simple_fn and startup_fn
    assert _norm(simple_fn.group(0)) == _norm(startup_fn.group(0))
