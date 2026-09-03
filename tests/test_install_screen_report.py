"""xinas-setup → Install: real inventory, recorded state, role report.

The Python setup screen used to pass `-i inventories/hosts`, a file that has
never existed in the repository, so Ansible matched zero hosts, exited 0
and the screen announced success for an install that never ran. It must
use the same inventory as the bash menus, mark its run so the
xinas_install_state callback records it, and close the run with the §2.9
role report (docs/Installer/spec.md).

The screen's playbook command, environment and report text are pure
functions tested here without an App; the Textual wiring around them is
kept thin.
"""

from __future__ import annotations

import json
from pathlib import Path

from xinas_menu.screens.startup import install_screen as scr
from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen

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


def test_install_environment_marks_the_run_for_state_recording():
    env = scr.install_environment()
    assert env["XINAS_RECORD_INSTALL_STATE"] == "1"


def test_playbook_screen_passes_extra_env_to_the_subprocess():
    screen = PlaybookRunScreen(cmd=["true"], env={"XINAS_RECORD_INSTALL_STATE": "1"})
    env = screen._build_env()
    assert env["XINAS_RECORD_INSTALL_STATE"] == "1"
    assert env["ANSIBLE_STDOUT_CALLBACK"] == "default"  # existing override kept


def test_report_message_renders_the_role_table(tmp_path):
    state_path = tmp_path / "install-state.json"
    state_path.write_text(
        json.dumps(
            {
                "status": "failed",
                "preset": "default",
                "started": 5000.0,
                "updated": 5100.0,
                "expected": ["common", "doca_ofed", "xiraid_classic"],
                "roles": [
                    {"role": "common", "status": "ok", "ts": 0, "tasks": {}},
                    {"role": "doca_ofed", "status": "failed", "ts": 0, "tasks": {}},
                ],
            }
        )
    )
    text, complete = scr.report_message(exit_code=2, run_started=4000.0, state_path=state_path)
    assert complete is False
    assert "✗ doca_ofed" in text
    assert "· xiraid_classic" in text
    assert "INCOMPLETE: 1 of 3 roles applied, failed at doca_ofed, 1 not run" in text
    assert "\033[" not in text, "dialog text must be plain, not ANSI-colored"


def test_report_message_says_no_roles_ran_for_a_hostless_run(tmp_path):
    # The exact failure the old inventory path produced: exit 0, no play.
    text, complete = scr.report_message(
        exit_code=0, run_started=4000.0, state_path=tmp_path / "absent.json"
    )
    assert complete is False
    assert "No roles ran" in text


def test_success_is_claimed_only_when_the_report_is_complete():
    src = (REPO / "xinas_menu/screens/startup/install_screen.py").read_text()
    assert "Installation completed successfully" in src
    # The success notification must be gated on the report, not on exit_code alone.
    assert "if exit_code == 0 and complete" in src or "if complete" in src, (
        "install_screen.py still treats exit 0 as success without consulting the report"
    )
