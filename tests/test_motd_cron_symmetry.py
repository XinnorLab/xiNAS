"""WS2.4: banner cron lives in /etc/cron.d/xinas-banner (what uninstall removes)."""

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
MOTD = REPO / "collection/roles/motd/tasks/main.yml"
UNINSTALL_PATHS = REPO / "collection/roles/xinas_uninstall/tasks/70_remove_paths.yml"


def _iter_tasks(tasks):
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        yield t
        for key in ("block", "rescue", "always"):
            if isinstance(t.get(key), list):
                yield from _iter_tasks(t[key])


def _cron_mods(task):
    m = task.get("ansible.builtin.cron")
    if m is None:
        m = task.get("cron")
    return m if isinstance(m, dict) else None


def test_motd_installs_cron_d_file():
    tasks = list(_iter_tasks(yaml.safe_load(MOTD.read_text())))
    installs = [
        m
        for t in tasks
        if (m := _cron_mods(t))
        and m.get("name") == "Refresh xiNAS login banner"
        and m.get("state", "present") == "present"
    ]
    assert installs, "motd must install the banner cron"
    assert all(m.get("cron_file") == "xinas-banner" for m in installs), (
        "banner cron must be a cron.d file (xinas-banner), not a user crontab (WS2.4)"
    )


def test_uninstall_removes_the_same_path():
    assert "/etc/cron.d/xinas-banner" in UNINSTALL_PATHS.read_text()


def test_legacy_removal_is_unconditional():
    tasks = list(_iter_tasks(yaml.safe_load(MOTD.read_text())))
    removals = [
        t
        for t in tasks
        if (m := _cron_mods(t)) and m.get("state") == "absent" and "cron_file" not in m
    ]
    assert removals, "legacy root-crontab removal task must exist"
    assert all(t.get("when") is None for t in removals), (
        "legacy cron removal must run unconditionally, even if banner_enabled is false (WS2.4)"
    )
