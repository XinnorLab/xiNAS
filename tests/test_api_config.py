"""api_config — schema-adapting helpers for the TUI MCP Server screen.

Headless coverage for the pure helpers in ``xinas_menu.utils.api_config``
that translate between the screen's view model and the live ``xinas-api``
config schema (``/etc/xinas-api/config.json`` — ``src/api/config.ts``
``ApiConfig``). The screen must read/write ``mcp.http`` / ``mcp.allow_apply``
/ ``tokens: {token: {principal, role}}`` and NEVER the retired legacy shape
(``http_enabled`` / ``tokens: {token: role}`` / ``token_labels`` / ``tls``),
while preserving every unrelated key so it can't clobber the api's live
config. See docs/control-path/s8-clients-spec.md §6c.
"""

from __future__ import annotations

import json
import os
import stat

import xinas_menu.utils.api_config as ac


def _base_cfg() -> dict:
    """A minimal but realistic api config (as Ansible templates it)."""
    return {
        "controller_id": "11111111-2222-3333-4444-555555555555",
        "listen": {"kind": "unix", "socket": "/run/xinas/api.sock", "socketGroup": 1000},
        "tokens": {
            "aaaa1111bbbb2222": {"principal": "admin:bootstrap", "role": "admin"},
        },
        "state": {
            "databasePath": "/var/lib/xinas/state/xinas.db",
            "auditJsonlPath": "/var/log/xinas/audit.jsonl",
        },
    }


# ── HTTP transport view ─────────────────────────────────────────────────────────


def test_http_view_disabled_when_no_mcp_section():
    view = ac.http_transport_view(_base_cfg())
    assert view["enabled"] is False


def test_http_view_disabled_when_mcp_has_no_http():
    cfg = _base_cfg()
    cfg["mcp"] = {"allow_apply": True}
    assert ac.http_transport_view(cfg)["enabled"] is False


def test_http_view_enabled_reports_host_and_port():
    cfg = _base_cfg()
    cfg["mcp"] = {"http": {"host": "0.0.0.0", "port": 9000}}
    view = ac.http_transport_view(cfg)
    assert view["enabled"] is True
    assert view["host"] == "0.0.0.0"
    assert view["port"] == 9000


# ── set / disable HTTP transport ─────────────────────────────────────────────────


def test_set_http_transport_writes_mcp_http_shape():
    cfg = ac.set_http_transport(_base_cfg(), host="0.0.0.0", port=8080)
    assert cfg["mcp"]["http"] == {"host": "0.0.0.0", "port": 8080}


def test_set_http_transport_never_emits_legacy_keys():
    cfg = ac.set_http_transport(_base_cfg(), host="0.0.0.0", port=8080)
    assert "http_enabled" not in cfg
    assert "http_port" not in cfg
    assert "tls" not in cfg
    assert "token_labels" not in cfg


def test_set_http_transport_preserves_unrelated_keys():
    cfg = ac.set_http_transport(_base_cfg(), host="10.0.0.1", port=8080)
    assert cfg["controller_id"] == "11111111-2222-3333-4444-555555555555"
    assert cfg["listen"]["socket"] == "/run/xinas/api.sock"
    assert cfg["state"]["databasePath"] == "/var/lib/xinas/state/xinas.db"
    assert cfg["tokens"]["aaaa1111bbbb2222"]["principal"] == "admin:bootstrap"


def test_set_http_transport_preserves_allow_apply():
    cfg = _base_cfg()
    cfg["mcp"] = {"allow_apply": True}
    out = ac.set_http_transport(cfg, host="0.0.0.0", port=8080)
    assert out["mcp"]["allow_apply"] is True
    assert out["mcp"]["http"]["port"] == 8080


def test_set_http_transport_does_not_mutate_input():
    original = _base_cfg()
    ac.set_http_transport(original, host="0.0.0.0", port=8080)
    assert "mcp" not in original


def test_disable_http_removes_http_but_keeps_allow_apply():
    cfg = _base_cfg()
    cfg["mcp"] = {"allow_apply": True, "http": {"host": "0.0.0.0", "port": 8080}}
    out = ac.disable_http_transport(cfg)
    assert "http" not in out["mcp"]
    assert out["mcp"]["allow_apply"] is True


def test_disable_http_prunes_empty_mcp_section():
    cfg = _base_cfg()
    cfg["mcp"] = {"http": {"host": "0.0.0.0", "port": 8080}}
    out = ac.disable_http_transport(cfg)
    assert "mcp" not in out


def test_disable_http_is_idempotent_when_absent():
    out = ac.disable_http_transport(_base_cfg())
    assert ac.http_transport_view(out)["enabled"] is False


# ── allow_apply ─────────────────────────────────────────────────────────────────


def test_allow_apply_defaults_false():
    assert ac.allow_apply_enabled(_base_cfg()) is False


def test_allow_apply_reads_flag():
    cfg = _base_cfg()
    cfg["mcp"] = {"allow_apply": True}
    assert ac.allow_apply_enabled(cfg) is True


def test_set_allow_apply_preserves_http_listener():
    cfg = _base_cfg()
    cfg["mcp"] = {"http": {"host": "0.0.0.0", "port": 8080}}
    out = ac.set_allow_apply(cfg, True)
    assert out["mcp"]["allow_apply"] is True
    assert out["mcp"]["http"]["port"] == 8080


def test_set_allow_apply_off_does_not_mutate_input():
    original = _base_cfg()
    original["mcp"] = {"allow_apply": True}
    out = ac.set_allow_apply(original, False)
    assert out["mcp"]["allow_apply"] is False
    assert original["mcp"]["allow_apply"] is True


# ── token listing / protection ──────────────────────────────────────────────────


def test_list_tokens_empty_when_no_tokens():
    cfg = {"controller_id": "x", "tokens": {}}
    assert ac.list_tokens(cfg) == []


def test_list_tokens_maps_principal_and_role():
    cfg = _base_cfg()
    cfg["tokens"]["cccc3333dddd4444"] = {"principal": "monitoring", "role": "viewer"}
    rows = ac.list_tokens(cfg)
    by_principal = {r["principal"]: r for r in rows}
    assert by_principal["monitoring"]["role"] == "viewer"
    assert by_principal["monitoring"]["token"] == "cccc3333dddd4444"


def test_list_tokens_marks_bootstrap_protected():
    rows = ac.list_tokens(_base_cfg())
    boot = next(r for r in rows if r["principal"] == "admin:bootstrap")
    assert boot["protected"] is True


def test_list_tokens_marks_operator_tokens_unprotected():
    cfg = _base_cfg()
    cfg["tokens"]["cccc3333dddd4444"] = {"principal": "monitoring", "role": "viewer"}
    rows = ac.list_tokens(cfg)
    mon = next(r for r in rows if r["principal"] == "monitoring")
    assert mon["protected"] is False


def test_token_is_protected_only_for_bootstrap():
    assert ac.token_is_protected("admin:bootstrap") is True
    assert ac.token_is_protected("remote-claude") is False


# ── add / remove tokens ─────────────────────────────────────────────────────────


def test_add_token_writes_nested_principal_role_shape():
    out = ac.add_token(_base_cfg(), "ffff9999", "remote-claude", "operator")
    assert out["tokens"]["ffff9999"] == {"principal": "remote-claude", "role": "operator"}


def test_add_token_preserves_existing_tokens():
    out = ac.add_token(_base_cfg(), "ffff9999", "remote-claude", "operator")
    assert out["tokens"]["aaaa1111bbbb2222"]["principal"] == "admin:bootstrap"


def test_add_token_does_not_mutate_input():
    original = _base_cfg()
    ac.add_token(original, "ffff9999", "remote-claude", "operator")
    assert "ffff9999" not in original["tokens"]


def test_remove_token_deletes_the_entry():
    cfg = ac.add_token(_base_cfg(), "ffff9999", "remote-claude", "operator")
    out = ac.remove_token(cfg, "ffff9999")
    assert "ffff9999" not in out["tokens"]
    # bootstrap untouched
    assert "aaaa1111bbbb2222" in out["tokens"]


def test_remove_token_refuses_to_remove_bootstrap():
    try:
        ac.remove_token(_base_cfg(), "aaaa1111bbbb2222")
    except ValueError:
        return
    raise AssertionError("expected ValueError removing the protected bootstrap token")


# ── redaction ───────────────────────────────────────────────────────────────────


def test_redact_config_masks_token_keys():
    red = ac.redact_config(_base_cfg())
    assert "aaaa1111bbbb2222" not in red["tokens"]
    # principal + role survive under the masked key
    masked_key = next(iter(red["tokens"]))
    assert red["tokens"][masked_key]["principal"] == "admin:bootstrap"
    assert red["tokens"][masked_key]["role"] == "admin"


def test_redact_config_does_not_mutate_input():
    original = _base_cfg()
    ac.redact_config(original)
    assert "aaaa1111bbbb2222" in original["tokens"]


def test_redact_config_keeps_non_token_keys():
    red = ac.redact_config(_base_cfg())
    assert red["controller_id"] == "11111111-2222-3333-4444-555555555555"
    assert red["listen"]["socket"] == "/run/xinas/api.sock"


# ── read / write round-trip + permission preservation ───────────────────────────


def test_api_cfg_read_missing_file_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(ac, "API_CONFIG_PATH", tmp_path / "nope.json")
    assert ac.api_cfg_read() == {}


def test_api_cfg_write_round_trips(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    monkeypatch.setattr(ac, "API_CONFIG_PATH", path)
    cfg = ac.add_token(_base_cfg(), "ffff9999", "remote-claude", "operator")
    ac.api_cfg_write(cfg)
    back = json.loads(path.read_text())
    assert back["tokens"]["ffff9999"] == {"principal": "remote-claude", "role": "operator"}
    assert back["controller_id"] == cfg["controller_id"]


def test_api_cfg_write_preserves_existing_mode(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{}")
    os.chmod(path, 0o640)
    monkeypatch.setattr(ac, "API_CONFIG_PATH", path)

    ac.api_cfg_write(_base_cfg())

    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o640


def test_api_cfg_write_defaults_to_0640_when_creating(monkeypatch, tmp_path):
    path = tmp_path / "config.json"
    monkeypatch.setattr(ac, "API_CONFIG_PATH", path)

    ac.api_cfg_write(_base_cfg())

    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o640
