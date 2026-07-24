"""The xiRAID exporter systemd unit name must never be hardcoded.

The upstream `.deb` (E4 Computer Engineering) is hyphenated as a *package*
(`xiraid-exporter`, `/usr/bin/xiraid-exporter`) but installs its systemd unit
with an *underscore*: `/usr/lib/systemd/system/xiraid_exporter.service`. Older
builds shipped the hyphenated unit.

Every xiNAS call site used to assume the hyphen, so on a current install:

  * the Integrations → xiRAID Exporter screen reported "inactive" for a
    healthy, metrics-serving exporter,
  * its Restart action was a silent no-op — it restarted a unit that does not
    exist, reported success, then re-read "inactive",
  * the health engine flagged the exporter as down,
  * the Ansible role's `service:` task failed outright with "Could not find the
    requested service".

The fix resolves the unit name at runtime. These tests pin that no call site
regresses to a hardcoded spelling, and that the two copies of the health-engine
helper (`xinas_menu/health/engine.py` and the standalone Python embedded in
`healthcheck.sh`, which cannot import it) stay in sync.
"""

import re
import subprocess
from pathlib import Path

import pytest

from xinas_menu.utils import service_ctl

REPO = Path(__file__).resolve().parents[1]

UNDERSCORE = "xiraid_exporter.service"
HYPHEN = "xiraid-exporter.service"


def _stub_run(loaded: set[str]):
    """Fake ServiceController._run answering `systemctl show --property=LoadState`."""

    def _run(*args: str, check: bool = False) -> subprocess.CompletedProcess:
        name = args[1]
        state = "loaded" if name in loaded else "not-found"
        return subprocess.CompletedProcess(
            args=list(args), returncode=0, stdout=f"LoadState={state}\n", stderr=""
        )

    return _run


# ── resolver behaviour ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("loaded", "expected"),
    [
        # Current .deb: only the underscore unit exists.
        ({UNDERSCORE}, UNDERSCORE),
        # Older build: only the hyphenated unit exists.
        ({HYPHEN}, HYPHEN),
        # Both present (upgrade leftovers) — the preferred spelling wins.
        ({UNDERSCORE, HYPHEN}, UNDERSCORE),
    ],
)
def test_resolves_whichever_unit_is_installed(monkeypatch, loaded, expected):
    monkeypatch.setattr(service_ctl.ServiceController, "_run", staticmethod(_stub_run(loaded)))
    assert service_ctl.xiraid_exporter_unit() == expected


def test_falls_back_to_first_candidate_when_nothing_resolves(monkeypatch):
    """Exporter not installed: callers still get a stable name to display."""
    monkeypatch.setattr(service_ctl.ServiceController, "_run", staticmethod(_stub_run(set())))
    assert service_ctl.xiraid_exporter_unit() == UNDERSCORE


def test_a_not_found_unit_is_never_accepted(monkeypatch):
    """The exact bug: `systemctl show` succeeds (rc=0) for an unknown unit.

    Resolution must key off LoadState, not the exit code — rc=0 with
    LoadState=not-found is what made the hyphen look like a usable unit.
    """
    monkeypatch.setattr(service_ctl.ServiceController, "_run", staticmethod(_stub_run(set())))
    assert service_ctl.resolve_unit(HYPHEN, UNDERSCORE) == HYPHEN  # fallback, not a match

    monkeypatch.setattr(
        service_ctl.ServiceController, "_run", staticmethod(_stub_run({UNDERSCORE}))
    )
    assert service_ctl.resolve_unit(HYPHEN, UNDERSCORE) == UNDERSCORE


def test_candidate_order_is_the_documented_preference():
    assert service_ctl.XIRAID_EXPORTER_UNITS == (UNDERSCORE, HYPHEN)


# ── drift guards ───────────────────────────────────────────────────────────

# Call sites that must go through the resolver, and the literals that would
# reintroduce the bug. The bare package name is legitimate elsewhere in these
# files (dpkg queries, apt purge, download URLs, display strings), so each
# entry pins the specific *systemd* usage rather than banning the word.
_FORBIDDEN = {
    "xinas_menu/screens/exporter.py": [
        'ctl.state("xiraid-exporter")',
        'ctl.restart("xiraid-exporter")',
    ],
    "xinas_menu/screens/quick_actions.py": [
        '"xiraid-exporter",',
    ],
    "xinas_menu/health/engine.py": [
        '("xiraid-exporter", "xiRAID Prometheus exporter")',
    ],
    "healthcheck.sh": [
        '("xiraid-exporter", "xiRAID Prometheus exporter")',
    ],
    "collection/roles/xiraid_exporter/tasks/main.yml": [
        "name: xiraid-exporter\n",
    ],
    "collection/roles/xiraid_exporter/handlers/main.yml": [
        "name: xiraid-exporter\n",
    ],
}


@pytest.mark.parametrize(("rel", "literals"), sorted(_FORBIDDEN.items()))
def test_no_call_site_hardcodes_the_hyphenated_unit(rel, literals):
    text = (REPO / rel).read_text()
    for literal in literals:
        assert literal not in text, (
            f"{rel} hardcodes the hyphenated exporter unit ({literal!r}). "
            f"Resolve it instead — the .deb installs {UNDERSCORE}."
        )


def test_uninstall_sweeps_both_unit_spellings():
    """Teardown must not depend on guessing which unit the .deb installed."""
    text = (REPO / "collection/roles/xinas_uninstall/tasks/91_optional_xiraid.yml").read_text()
    assert UNDERSCORE in text and HYPHEN in text


def test_role_defaults_list_both_candidates():
    text = (REPO / "collection/roles/xiraid_exporter/defaults/main.yml").read_text()
    assert "xiraid_exporter_unit_candidates:" in text
    assert UNDERSCORE in text and HYPHEN in text


# ── engine.py / healthcheck.sh parity ──────────────────────────────────────

# healthcheck.sh embeds a standalone Python program via a `<< 'PYEOF'` heredoc.
# It runs before/independently of the xinas_menu package and cannot import the
# resolver, so it carries its own copy. If one drifts, the shell health engine
# and the TUI health engine disagree about whether the exporter is up.
_HELPER_RE = re.compile(
    r"def xiraid_exporter_unit\(\):.*?return \"xiraid_exporter\.service\"",
    re.S,
)


@pytest.mark.parametrize("rel", ["xinas_menu/health/engine.py", "healthcheck.sh"])
def test_both_health_engines_carry_the_helper(rel):
    assert _HELPER_RE.search((REPO / rel).read_text()), f"{rel} lost its resolver helper"


def test_health_engine_copies_are_identical():
    engine = _HELPER_RE.search((REPO / "xinas_menu/health/engine.py").read_text())
    shell = _HELPER_RE.search((REPO / "healthcheck.sh").read_text())
    assert engine and shell
    assert engine.group(0) == shell.group(0), (
        "the xiraid_exporter_unit() helper drifted between engine.py and "
        "healthcheck.sh; keep the two copies byte-identical"
    )
