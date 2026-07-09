"""ManagementScreen — expert-mode gating of the Uninstall entry.

Headless coverage for the pure helpers behind the Management submenu:
the menu is built per-app-mode, and "Uninstall xiNAS" is only offered
when the console was launched in expert mode (``xinas-menu -e``).
See docs/Installer/uninstall-spec.md §2.2.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import xinas_menu.screens.management as management
from xinas_menu.__main__ import _parse_args

REPO_ROOT = Path(__file__).resolve().parent.parent


# ── menu construction ─────────────────────────────────────────────────────────


def _labels(items):
    return [item.label for item in items]


def test_menu_without_expert_hides_uninstall():
    items = management._menu_items(expert=False)
    assert "Uninstall xiNAS" not in _labels(items)


def test_menu_without_expert_keeps_other_entries():
    items = management._menu_items(expert=False)
    labels = _labels(items)
    for expected in ("Settings", "Integrations", "Check for Updates", "Back"):
        assert expected in labels


def test_menu_with_expert_shows_uninstall_on_key_4():
    items = management._menu_items(expert=True)
    by_label = {item.label: item.key for item in items}
    assert by_label.get("Uninstall xiNAS") == "4"


# ── CLI flag ──────────────────────────────────────────────────────────────────


def test_parse_args_default_is_not_expert(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["xinas_menu"])
    assert _parse_args().expert is False


def test_parse_args_short_expert_flag(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["xinas_menu", "-e"])
    assert _parse_args().expert is True


def test_parse_args_long_expert_flag(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["xinas_menu", "--expert"])
    assert _parse_args().expert is True


# ── uninstall.sh output contract ──────────────────────────────────────────────


def test_uninstall_sh_forces_default_stdout_callback():
    """uninstall-spec §2.1: the interactive run must not dump the minimal
    callback's raw JSON — the script forces the default callback."""
    script = (REPO_ROOT / "uninstall.sh").read_text()
    playbook_lines = [ln for ln in script.splitlines() if 'ansible-playbook "${ANSIBLE_ARGS' in ln]
    assert playbook_lines, "uninstall.sh no longer invokes ansible-playbook with ANSIBLE_ARGS"
    assert all("ANSIBLE_STDOUT_CALLBACK=default" in ln for ln in playbook_lines)


def test_uninstall_sh_parses_cleanly():
    proc = subprocess.run(
        ["bash", "-n", str(REPO_ROOT / "uninstall.sh")],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
