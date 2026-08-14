"""Pure prefill helpers for the NFS share wizard."""

from __future__ import annotations

import re
import inspect

from xinas_menu.screens.nfs import (
    NFSScreen,
    _format_exports,
    _format_sessions,
    _host_prefill,
    _parse_current_export,
    _path_prefill,
    _rows_from_api,
    _xiraid_mount_points,
)


def test_format_sessions_reads_helper_shape():
    # nfs.list_sessions() returns this shape (spec §4.8). The row must show
    # the real client IP and export path, not "?  ->  ?".
    out = _format_sessions(
        [
            {
                "client_ip": "10.0.0.15",
                "nfs_version": "4.2",
                "export_path": "/mnt/data",
                "active_locks": 3,
            },
            {
                "client_ip": "10.0.0.22",
                "nfs_version": "4.1",
                "export_path": "unknown",
                "active_locks": 0,
            },
        ]
    )
    assert "10.0.0.15  ->  /mnt/data" in out
    assert "10.0.0.22  ->  unknown" in out
    assert "?  ->  ?" not in out


def test_format_sessions_empty():
    assert "(no active sessions)" in _format_sessions([])


def test_format_sessions_legacy_client_path_fallback():
    # An alternate source that uses client/path still renders.
    out = _format_sessions([{"client": "192.168.1.5", "path": "/mnt/data/sub"}])
    assert "192.168.1.5  ->  /mnt/data/sub" in out


_HOST_CHOICES = [
    "Everyone (any host on the network)",
    "Specific network (e.g., 192.168.1.0/24)",
    "Single host (by IP address)",
]


def test_host_prefill_everyone():
    sel, hint = _host_prefill("*")
    assert sel == _HOST_CHOICES[0]
    assert hint == "Everyone"


def test_host_prefill_network():
    sel, hint = _host_prefill("192.168.1.0/24")
    assert sel == _HOST_CHOICES[1]
    assert hint == "Network 192.168.1.0/24"


def test_host_prefill_single():
    sel, hint = _host_prefill("10.0.0.5")
    assert sel == _HOST_CHOICES[2]
    assert hint == "Host 10.0.0.5"


def test_path_prefill_matches_mount():
    sel, default = _path_prefill("/mnt/data", ["/mnt/data", "/mnt/log"])
    assert sel == "/mnt/data"
    assert default == "/mnt/data/"  # custom default is unused when a mount matches


def test_path_prefill_custom_when_no_match():
    sel, default = _path_prefill("/mnt/data/share1", ["/mnt/data"])
    assert sel == "Custom path…"
    assert default == "/mnt/data/share1"


def test_path_prefill_empty():
    sel, default = _path_prefill("", ["/mnt/data"])
    assert sel is None
    assert default == "/mnt/data/"


def test_path_prefill_custom_default_uses_first_mount():
    sel, default = _path_prefill("", ["/srv/pool1", "/mnt/log"])
    assert sel is None
    assert default == "/srv/pool1/"


def test_xiraid_mount_points_keeps_only_xi_sources():
    out = "/mnt/data      /dev/xi_data\n/boot          /dev/sda1\n/              /dev/sda2\n"
    assert _xiraid_mount_points(out) == ["/mnt/data"]


def test_xiraid_mount_points_multiple():
    out = "/mnt/data   /dev/xi_data\n/mnt/logs   /dev/xi_logs\n"
    assert _xiraid_mount_points(out) == ["/mnt/data", "/mnt/logs"]


def test_xiraid_mount_points_none():
    out = "/           /dev/sda2\n/boot       /dev/sda1\n"
    assert _xiraid_mount_points(out) == []


def test_xiraid_mount_points_empty_string():
    assert _xiraid_mount_points("") == []


# ---- control-path adapter (fs-shares-management-spec §4.2) ----
#
# The API keeps sync / security_mode as SHARE-level fields; the renderer and
# the Edit wizard speak the legacy client-option shape. _rows_from_api folds
# them back in, so _parse_current_export keeps working unchanged.


def _api_share(spec_extra: dict | None = None) -> list[dict]:
    return [
        {
            "id": "mnt/data",
            "spec": {
                "path": "/mnt/data",
                "fsid": 1,
                "clients": [{"pattern": "10.0.0.0/24", "options": ["rw", "no_root_squash"]}],
                **(spec_extra or {}),
            },
            "status": {},
        }
    ]


def test_rows_from_api_folds_share_level_sync_and_sec_into_client_options():
    rows = _rows_from_api(_api_share({"sync": "async", "security_mode": "krb5p"}))
    assert len(rows) == 1
    opts = rows[0]["clients"][0]["options"]
    assert "async" in opts
    assert "sec=krb5p" in opts
    # pattern is renamed to the legacy key the renderer/wizard read.
    assert rows[0]["clients"][0]["host"] == "10.0.0.0/24"
    assert rows[0]["id"] == "mnt/data"


def test_rows_from_api_omits_sec_for_the_default_security_mode():
    rows = _rows_from_api(_api_share({"sync": "sync", "security_mode": "sys"}))
    opts = rows[0]["clients"][0]["options"]
    assert not any(o.startswith("sec=") for o in opts)


def test_rows_from_api_does_not_duplicate_an_option_already_present():
    rows = _rows_from_api(
        [
            {
                "id": "mnt/data",
                "spec": {
                    "path": "/mnt/data",
                    "clients": [{"pattern": "*", "options": ["rw", "sync"]}],
                    "sync": "sync",
                },
            }
        ]
    )
    assert rows[0]["clients"][0]["options"].count("sync") == 1


def test_rows_from_api_drops_pathless_and_malformed_docs():
    assert _rows_from_api([{"id": "x", "spec": {"clients": []}}]) == []
    assert _rows_from_api(["not-a-dict", {"id": "y"}]) == []
    assert _rows_from_api("not-a-list") == []


def test_adapter_output_round_trips_through_the_edit_parser():
    # §4.6 depends on this: the wizard reads its five fields back out of the
    # adapted row, not out of the API doc.
    rows = _rows_from_api(_api_share({"sync": "async", "security_mode": "krb5"}))
    parsed = _parse_current_export(rows[0])
    assert parsed["host"] == "10.0.0.0/24"
    assert parsed["access"] == "rw"
    assert parsed["root_squash"] == "no_root_squash"
    assert parsed["sync_mode"] == "async"
    assert parsed["sec"] == "krb5"


# ---- share writes ride the control path (§4.1, §4.5–4.7) ----


def test_share_writes_use_plan_apply_wait_not_the_helper_socket():
    for name, method, verb in (
        ("add", NFSScreen._add_share_wizard, "POST"),
        ("edit", NFSScreen._edit_share, "PATCH"),
        ("remove", NFSScreen._remove_share, "DELETE"),
    ):
        src = inspect.getsource(method)
        assert "plan_apply_wait" in src, f"{name} does not go through plan/apply"
        assert verb in src, f"{name} does not use {verb}"
        assert "/api/v1/shares" in src
        for op in ("add_export(", "update_export(", "remove_export(", "app.nfs"):
            assert op not in src, f"{name} still calls the helper socket: {op}"


def test_share_ids_are_percent_encoded_on_every_addressed_path():
    # An NfsShare id carries internal slashes (encExportId), so a raw id 404s.
    for method in (NFSScreen._edit_share, NFSScreen._remove_share):
        src = inspect.getsource(method)
        assert "quote_id(" in src, f"{method.__name__} addresses a share id unencoded"


def test_remove_share_passes_no_dangerous_flag():
    # Risk class is changing_access; the single confirmation is the gate.
    src = inspect.getsource(NFSScreen._remove_share)
    assert "dangerous=True" not in src


def test_edit_sends_security_mode_unconditionally_but_add_does_not():
    # §4.6: an omitted PATCH field means "leave alone", so Edit must always
    # send security_mode or sec=krb5 could never be cleared. Add only sets it
    # when the operator chose something other than the default.
    add = inspect.getsource(NFSScreen._add_share_wizard)
    edit = inspect.getsource(NFSScreen._edit_share)
    assert 'spec["security_mode"] = sec' in add
    assert 'if sec != "sys"' in add
    assert '"security_mode": sec' in edit
    # Edit's `if sec != "sys"` is the confirmation summary's display list,
    # never the patch — the patch block must not be conditional on it.
    patch_block = edit.split("patch: dict[str, Any] = {", 1)[1].split("try:", 1)[0]
    assert "security_mode" in patch_block
    assert "if " not in patch_block


def test_add_share_keeps_sync_and_sec_out_of_the_client_options():
    # They are share-level spec fields; _rows_from_api folds them back on read.
    src = inspect.getsource(NFSScreen._add_share_wizard)
    assert '"options": [access, root_squash, "no_subtree_check"]' in src
    assert '"sync": sync_mode' in src


# ---- Show: empty is empty, degraded says so (§4.2) ----
#
# The renderer used to parse /etc/exports whenever the row list came back
# empty. Under the control path an empty list means the api observed no
# shares — and the collector reads /etc/exports itself — so the fallback
# could only present unmanaged file contents as the managed share list.


def test_empty_share_list_renders_an_empty_state_not_etc_exports():
    out = _format_exports([])
    assert "no NFS shares configured" in out


def test_renderer_never_reads_etc_exports():
    # No path literal to open. (The prose comment naming the removed fallback
    # is fine; a quoted path is what a read would need. The renderer does
    # still open /proc/fs/nfsd/clients/*/info for the Connected-hosts block.)
    src = inspect.getsource(_format_exports)
    assert '"/etc/exports"' not in src and "'/etc/exports'" not in src


def test_degraded_banner_replaces_the_empty_state():
    out = _format_exports([], banner="NFS backend unavailable")
    assert "NFS backend unavailable" in out
    assert "no NFS shares configured" not in out


def test_degraded_banner_shows_above_rows_when_some_are_observed():
    rows = _rows_from_api(_api_share({"sync": "sync"}))
    out = _format_exports(rows, banner="NFS backend unavailable")
    assert "NFS backend unavailable" in out
    assert "/mnt/data" in out


def test_no_banner_keeps_the_plain_empty_state():
    assert "backend" not in _format_exports([]).lower()


def test_load_exports_reads_the_envelope_for_warnings():
    # control.get, not control.result — .result discards the warnings that
    # carry DEGRADED_BACKEND_UNAVAILABLE.
    src = inspect.getsource(NFSScreen._load_exports)
    assert "control.get" in src
    assert "degraded_banner" in src


# ---- fsid allocation fails closed (§4.5) ----
#
# Share.spec.fsid is required by the API, so the TUI must allocate. A
# swallowed read error made max(used, default=0)+1 restart at 1 and collide
# with every existing share.


def test_get_exports_propagates_a_control_path_error():
    src = inspect.getsource(NFSScreen._get_exports)
    assert "except ControlPathError" not in src, "_get_exports must not swallow the read failure"


def test_add_share_aborts_when_the_existing_shares_cannot_be_read():
    src = inspect.getsource(NFSScreen._add_share_wizard)
    fsid_block = src.split("used: set[int] = set()", 1)
    assert len(fsid_block) == 2, "fsid allocation block not found"
    assert "Could not read existing shares" in fsid_block[1]


def test_edit_and_remove_distinguish_unreadable_from_empty():
    for method in (NFSScreen._edit_share, NFSScreen._remove_share):
        src = inspect.getsource(method)
        assert "Could not load shares." in src, f"{method.__name__} reports a failed read as empty"
        assert "No shares configured." in src


def test_share_usage_df_is_bounded_by_a_timeout(monkeypatch):
    """A hung export must not stall the renderer forever."""
    import os
    import subprocess as _sp

    from xinas_menu.screens import nfs as nfs_mod

    seen: list[dict] = []

    def _fake_run(cmd, **kwargs):
        seen.append({"cmd": cmd, **kwargs})
        return _sp.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(nfs_mod.subprocess, "run", _fake_run)
    # The renderer only calls df if the path exists; mock that check for exports.
    original_isdir = os.path.isdir

    def mock_isdir(path):
        path_str = str(path)
        if path_str.startswith("/mnt") or path_str.startswith("/srv"):
            return True
        return original_isdir(path)

    monkeypatch.setattr(os.path, "isdir", mock_isdir)
    _format_exports(_rows_from_api(_api_share({"sync": "sync"})))

    df_calls = [c for c in seen if c["cmd"][:1] == ["df"]]
    assert df_calls, "renderer no longer calls df — update this test"
    for call in df_calls:
        assert isinstance(call.get("timeout"), (int, float)), "df has no timeout"
        assert 0 < call["timeout"] <= 30


def test_load_exports_renders_off_the_event_loop():
    """`@work` on an async def runs ON the loop, so the blocking renderer
    (df per share + /proc reads) has to be handed to a thread explicitly."""
    src = inspect.getsource(NFSScreen._load_exports)
    # Handed to to_thread as a reference, never called inline. A bare
    # `_format_exports(` in this method means it runs on the event loop —
    # and `to_thread` appearing *somewhere* in the method proves nothing,
    # because the control-path call already uses it.
    assert "_format_exports(" not in src, "_format_exports is still called inline"
    assert re.search(r"to_thread\(\s*_format_exports", src), (
        "_format_exports must be handed to asyncio.to_thread"
    )
