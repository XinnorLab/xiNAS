"""xinas-setup → Install must run against a real inventory.

The Python setup screen used to pass `-i inventories/hosts`, a file that has
never existed in the repository, so Ansible matched zero hosts, exited 0
and the screen announced success for an install that never ran. It must
use the same playbook and inventory as the bash menus
(docs/Installer/spec.md §2.1).
"""

from __future__ import annotations

from pathlib import Path

from xinas_menu.screens.startup import install_screen as scr

REPO = Path(__file__).resolve().parents[1]


def test_install_command_uses_the_repos_real_inventory():
    cmd = scr.install_command(REPO, "default")
    assert "-i" in cmd
    inventory = Path(cmd[cmd.index("-i") + 1])
    assert inventory == REPO / "inventories" / "lab.ini"
    assert inventory.exists(), "the inventory the screen passes must exist in the checkout"


def test_install_command_runs_site_yml_with_the_preset():
    # site.yml is always the playbook that runs (spec §2.1): it carries the
    # xiraid_skip_install guard the preset playbooks lack.
    cmd = scr.install_command(REPO, "xinnorVM")
    assert cmd[0] == "ansible-playbook"
    assert Path(cmd[1]) == REPO / "playbooks" / "site.yml"
    assert "--extra-vars" in cmd
    assert "preset=xinnorVM" in cmd
