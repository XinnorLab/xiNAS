"""Regression guards for the ``xinas_agent`` role — the privileged
observation + execution daemon that runs *on* a xiNAS controller
(``xinas-agent.service``, Phase 0 control path, ADR-0002).

The agent's own logic is unit-tested in TypeScript
(``xiNAS-MCP/src/__tests__/agent/**``). These tests instead pin the
*deployment contract*: the systemd unit, the role tasks, the config
template, and the cross-role wiring that must hold for the daemon to
actually come up and reach ``offline -> healthy`` on a real box.

Everything is validated as text / parsed YAML — no host, no Ansible run,
no jinja2 (which is intentionally not a ``[dev]`` test dependency; the
Jinja itself is exercised by the ``ansible`` CI job). The invariants
guarded here each map to a concrete on-host failure mode, several of
them to named InstallationFeedback findings:

* #31 — agent must join ``xinas-admin`` or its POST to the api socket
  (``0660 xinas-api:xinas-admin``) gets EACCES and it stays ``offline``.
* #30 — the ConfigSnapshot collector shells out to ``xinas_history``; the
  unit must point ``XINAS_HISTORY_PYTHON`` / ``PYTHONPATH`` at the venv.
* #29 — ``/etc/netplan`` / ``/run/netplan`` may not exist; their
  ``ReadWritePaths`` entries must be optional (``-`` prefix) or the
  namespace setup fails ``226/NAMESPACE`` and the agent restart-loops.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
ROLE = REPO_ROOT / "collection/roles/xinas_agent"
UNIT = REPO_ROOT / "xiNAS-MCP/xinas-agent.service"
API_DEFAULTS = REPO_ROOT / "collection/roles/xinas_api/defaults/main.yml"
CONFIG_TEMPLATE = ROLE / "templates/xinas-agent-config.json.j2"
PLAYBOOKS = [
    REPO_ROOT / "presets/default/playbook.yml",
    REPO_ROOT / "presets/xinnorVM/playbook.yml",
    REPO_ROOT / "playbooks/site.yml",
]


# --------------------------------------------------------------------------- #
# Loaders
# --------------------------------------------------------------------------- #
def _unit_text() -> str:
    return UNIT.read_text()


def _directive_values(name: str) -> list[str]:
    """Return the values of every ``Name=Value`` line for ``name`` in the
    unit file, skipping comment lines so words that appear only in a
    comment (e.g. a disabled directive documented in prose) don't match.
    """
    values: list[str] = []
    for line in _unit_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        if key.strip() == name:
            values.append(value.strip())
    return values


def _defaults() -> dict:
    return yaml.safe_load((ROLE / "defaults/main.yml").read_text())


def _api_defaults() -> dict:
    return yaml.safe_load(API_DEFAULTS.read_text())


def _tasks() -> list[dict]:
    return yaml.safe_load((ROLE / "tasks/main.yml").read_text())


def _meta() -> dict:
    return yaml.safe_load((ROLE / "meta/main.yml").read_text())


def _task(name_substr: str) -> dict:
    for task in _tasks():
        if name_substr in (task.get("name") or ""):
            return task
    raise AssertionError(f"no task whose name contains {name_substr!r}")


def _as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _role_order(playbook: Path) -> list[str]:
    doc = yaml.safe_load(playbook.read_text())
    roles = doc[0]["roles"]
    return [r["role"] if isinstance(r, dict) else r for r in roles]


# --------------------------------------------------------------------------- #
# systemd unit — identity & ordering
# --------------------------------------------------------------------------- #
def test_unit_runs_as_root() -> None:
    # ADR-0002 §Privilege boundary: the agent needs root to chown the
    # socket, read /proc directly, and drive dbus/udev.
    assert _directive_values("User") == ["root"]
    assert _directive_values("Group") == ["root"]


def test_unit_execstart_targets_compiled_agent() -> None:
    exec_start = _directive_values("ExecStart")
    assert len(exec_start) == 1
    assert exec_start[0].endswith("dist/agent-server.js")


def test_unit_requires_and_orders_after_api() -> None:
    # The api role generates the agent-token + controller-id the agent
    # reads at startup, and the agent POSTs observations back to the api.
    assert any("xinas-api.service" in v for v in _directive_values("After"))
    assert "xinas-api.service" in _directive_values("Requires")


# --------------------------------------------------------------------------- #
# systemd unit — the socket gate (finding #31) and capabilities
# --------------------------------------------------------------------------- #
def test_unit_joins_xinas_admin_group() -> None:
    # Finding #31: without this the agent's POST to /run/xinas/api.sock
    # (0660 xinas-api:xinas-admin) gets EACCES and it never leaves offline.
    assert "xinas-admin" in _directive_values("SupplementaryGroups")


def test_unit_grants_cap_chown_and_net_admin() -> None:
    # CAP_CHOWN: the agent chgrps /run/xinas/agent.sock to xinas-api so the
    # api can connect — an empty bounding set (User=root+NoNewPrivileges)
    # would mask it and break the socket gate. CAP_NET_ADMIN: S6 network
    # executors program the kernel (ip rule/route/addr, netplan apply).
    for directive in ("CapabilityBoundingSet", "AmbientCapabilities"):
        values = _directive_values(directive)
        assert values, f"{directive} must be set"
        assert "CAP_CHOWN" in values[0]
        assert "CAP_NET_ADMIN" in values[0]
    assert _directive_values("NoNewPrivileges") == ["true"]


# --------------------------------------------------------------------------- #
# systemd unit — filesystem sandbox
# --------------------------------------------------------------------------- #
def test_unit_readwritepaths_cover_agent_writables() -> None:
    rwp = _directive_values("ReadWritePaths")
    assert len(rwp) == 1
    paths = rwp[0]
    assert "/run/xinas" in paths  # agent.sock create + chgrp
    assert "/etc/systemd/system" in paths  # S5 .mount unit writes
    # Finding #29: netplan dirs may be absent; the '-' prefix makes the
    # ReadWritePaths entry optional so namespace setup doesn't 226/NAMESPACE.
    assert "-/etc/netplan" in paths
    assert "-/run/netplan" in paths


def test_unit_does_not_grant_write_to_state_dir() -> None:
    # ADR-0002: the api is the SOLE SQLite writer; the agent reports via
    # /internal/v1/observed and must NOT be able to write the state dir.
    assert "/var/lib/xinas/state" not in _directive_values("ReadWritePaths")[0]
    assert "/var/lib/xinas" in _directive_values("ReadOnlyPaths")[0]


def test_unit_reads_agent_config_and_identity_readonly() -> None:
    read_only = _directive_values("ReadOnlyPaths")[0]
    assert "/etc/xinas-agent" in read_only  # config.json + agent-token
    assert "/var/lib/xinas" in read_only  # controller-id


# --------------------------------------------------------------------------- #
# systemd unit — environment, address families, deliberate omissions
# --------------------------------------------------------------------------- #
def test_unit_wires_config_and_history_environment() -> None:
    env = _directive_values("Environment")
    assert "XINAS_AGENT_CONFIG=/etc/xinas-agent/config.json" in env
    # Finding #30: ConfigSnapshot collector needs the xiNAS venv python and
    # PYTHONPATH so `-m xinas_history` resolves (system python3 lacks it).
    assert any(e.startswith("XINAS_HISTORY_PYTHON=") for e in env)
    assert any(e.startswith("PYTHONPATH=") for e in env)


def test_unit_restricts_address_families_to_loopback() -> None:
    families = _directive_values("RestrictAddressFamilies")[0]
    for fam in ("AF_UNIX", "AF_NETLINK", "AF_INET", "AF_INET6"):
        assert fam in families
    # AF_INET* is only for the localhost xiRAID gRPC client — pin the loopback.
    assert _directive_values("IPAddressAllow") == ["localhost"]
    assert _directive_values("IPAddressDeny") == ["any"]


def test_unit_omits_memory_deny_write_execute() -> None:
    # Deliberately OMITTED: V8's JIT must mprotect PROT_EXEC pages, which
    # MDWE's seccomp filter EPERMs → a default Node runtime aborts. This
    # guards against a well-meaning "harden it" edit re-adding the directive.
    assert _directive_values("MemoryDenyWriteExecute") == []


# --------------------------------------------------------------------------- #
# Role tasks — files, modes, handlers, preflight
# --------------------------------------------------------------------------- #
def test_config_dir_is_root_owned_0755() -> None:
    file_args = _task("directory exists")["ansible.builtin.file"]
    assert file_args["owner"] == "root"
    assert file_args["group"] == "root"
    assert file_args["mode"] == "0755"


def test_config_file_is_0640_root_and_restarts_agent() -> None:
    task = _task("Template xinas-agent config")
    tpl = task["ansible.builtin.template"]
    assert tpl["dest"].endswith("/config.json")
    assert tpl["owner"] == "root"
    assert tpl["group"] == "root"
    assert tpl["mode"] == "0640"
    assert "Restart xinas-agent" in _as_list(task["notify"])


def test_unit_install_task_reloads_and_restarts() -> None:
    task = _task("Install xinas-agent.service")
    copy = task["ansible.builtin.copy"]
    assert copy["dest"] == "/etc/systemd/system/xinas-agent.service"
    assert copy["mode"] == "0644"
    notify = _as_list(task["notify"])
    assert "Reload systemd" in notify
    assert "Restart xinas-agent" in notify


def test_preflight_fails_without_token_or_binary() -> None:
    # The role must refuse to run (with an actionable message) when the
    # xinas_api role hasn't produced the agent-token, or when the agent
    # binary hasn't been built — not start a broken service.
    guards = {t.get("when") for t in _tasks() if "ansible.builtin.fail" in t}
    joined = " ".join(w for w in guards if isinstance(w, str))
    assert "_xinas_agent_token_stat.stat.exists" in joined
    assert "_xinas_agent_binary_stat.stat.exists" in joined


# --------------------------------------------------------------------------- #
# Config template — stays valid JSON with the keys agent-server.ts reads
# --------------------------------------------------------------------------- #
def test_config_template_renders_valid_json() -> None:
    text = CONFIG_TEMPLATE.read_text()
    # Substitute placeholders without jinja2: the heartbeat is a bare number;
    # the string-valued placeholders are already wrapped in quotes in the
    # template, so they get a bare token (not a re-quoted one).
    rendered = text.replace("{{ xinas_agent_heartbeat_interval_ms }}", "5000")
    rendered = re.sub(r"\{\{[^}]*\}\}", "x", rendered)
    data = json.loads(rendered)
    assert set(data) == {
        "api_socket",
        "agent_socket",
        "controller_id_path",
        "agent_token_path",
        "socket_group",
        "heartbeat_interval_ms",
    }
    assert isinstance(data["heartbeat_interval_ms"], int)


# --------------------------------------------------------------------------- #
# Cross-role wiring — the agent and api must agree, or the heartbeat fails
# --------------------------------------------------------------------------- #
def test_socket_group_default_lets_api_connect() -> None:
    # Wrong/undefined group → agent-server.ts falls back to gid 0, the socket
    # is left root:root 0660, the api gets EACCES, the agent is pinned offline.
    assert _defaults()["xinas_agent_socket_group"] == "xinas-api"


def test_agent_and_api_agree_on_socket_paths() -> None:
    agent = _defaults()
    api = _api_defaults()
    assert agent["xinas_agent_socket"] == api["xinas_api_agent_socket"]
    assert agent["xinas_api_socket"] == api["xinas_api_socket"]


def test_agent_and_api_agree_on_heartbeat_interval() -> None:
    assert (
        _defaults()["xinas_agent_heartbeat_interval_ms"]
        == _api_defaults()["xinas_api_agent_heartbeat_interval_ms"]
    )


def test_meta_depends_on_xinas_api() -> None:
    deps = _meta()["dependencies"]
    names = [d["role"] if isinstance(d, dict) else d for d in deps]
    assert "xinas_api" in names


# --------------------------------------------------------------------------- #
# Deployment wiring — every shipping playbook runs the agent, after the api
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("playbook", PLAYBOOKS, ids=lambda p: p.parent.name)
def test_playbooks_run_agent_after_api(playbook: Path) -> None:
    order = _role_order(playbook)
    assert "xinas_agent" in order, f"{playbook} does not run xinas_agent"
    assert "xinas_api" in order, f"{playbook} does not run xinas_api"
    assert order.index("xinas_api") < order.index("xinas_agent")
