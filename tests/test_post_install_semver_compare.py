"""WS3 (T14, folded #132, F6): post_install_menu.sh must decide 'update
available' by semver, not string inequality (a string compare offers
downgrades). It sources lib/menu_lib.sh's _semver_gt.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = (REPO / "post_install_menu.sh").read_text()


def test_no_string_inequality_tag_compare():
    assert '"$current_tag" != "$latest_tag"' not in SRC
    # match whatever real var names post_install uses too:
    assert not re.search(r'\$\{?_?[A-Za-z_]*[Tt]ag\}?"?\s*!=\s*"?\$\{?_?[A-Za-z_]*[Tt]ag', SRC), (
        "post_install_menu.sh still string-compares release tags (F6)"
    )


def test_uses_semver_gt():
    assert "_semver_gt" in SRC


def test_sources_menu_lib():
    assert "menu_lib.sh" in SRC
