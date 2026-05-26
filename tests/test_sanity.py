"""First-green sanity test for the Python toolchain."""
import re

from xinas_menu.version import XINAS_MENU_VERSION


def test_version_is_semver():
    assert re.match(r"^\d+\.\d+\.\d+", XINAS_MENU_VERSION), (
        f"XINAS_MENU_VERSION={XINAS_MENU_VERSION!r} is not semver"
    )
