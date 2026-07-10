"""WS3: the semver release-tag regex must stay identical across every copy.

`_is_release_tag`'s pattern is duplicated by necessity — the two standalone
installers (`install.sh`, `install_client.sh`) run before/independently of the
clone and cannot source `lib/menu_lib.sh`, and the privileged
`xinas-update-git` wrapper is a root-owned file deployed by Ansible. All four
copies gate `git checkout` against a non-release ref; if one drifts, a bash
path could accept a ref the others reject (or vice versa). This guards the
"keep in sync" burden the copies' own comments describe, which had no
enforcement — WS3 added the fourth copy.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# Every file that carries an inline copy of the release-tag regex, and why it
# can't just call the shared lib/menu_lib.sh::_is_release_tag.
_SITES = {
    "lib/menu_lib.sh": "canonical _is_release_tag",
    "install.sh": "standalone server installer, runs before the clone",
    "install_client.sh": "standalone client installer, never sources the lib",
    "collection/roles/xinas_menu/files/xinas-update-git": "root-owned sudo wrapper",
}

# The one true pattern. A `# _is_release_tag pattern:` change here without
# updating every file (or vice versa) fails this test.
_CANONICAL = r"^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$"

# Match the literal wherever it appears (=~ in bash, or a quoted copy).
_PATTERN_RE = re.compile(r"\^v\?\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(-\[0-9A-Za-z\.-\]\+\)\?\$")


def _extract(path: str) -> str:
    text = (REPO / path).read_text()
    matches = _PATTERN_RE.findall(text)
    assert matches, f"{path}: no release-tag regex found (did the pattern move or drift?)"
    return matches[0]


def test_all_release_tag_regexes_are_identical():
    found = {path: _extract(path) for path in _SITES}
    unique = set(found.values())
    assert unique == {_CANONICAL}, "release-tag regex copies have drifted apart:\n" + "\n".join(
        f"  {p}: {r}" for p, r in found.items()
    )


def test_every_known_site_still_has_the_regex():
    # If a site is refactored away (e.g. finally sources the lib), update
    # _SITES deliberately — don't let a copy silently disappear unnoticed.
    for path, why in _SITES.items():
        assert _PATTERN_RE.search((REPO / path).read_text()), (
            f"{path} ({why}) no longer carries the release-tag regex — "
            "if that's intentional, remove it from _SITES"
        )
