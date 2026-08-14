"""MCPScreen — MCP server management + SSH access + HTTP remote access."""

from __future__ import annotations

import asyncio
import json
import secrets
import socket as _socket
import subprocess
from pathlib import Path

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.utils.api_config import (
    API_CONFIG_PATH,
    DEFAULT_HTTP_HOST,
    DEFAULT_HTTP_PORT,
    add_token,
    allow_apply_enabled,
    api_cfg_read,
    api_cfg_write,
    api_config_present,
    disable_http_transport,
    http_transport_view,
    list_tokens,
    redact_config,
    remove_token,
    set_allow_apply,
    set_http_transport,
)
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_RED = "\033[31m"
_GRN = "\033[32m"
_YLW = "\033[33m"
_CYN = "\033[36m"
_BLD = "\033[1m"
_DIM = "\033[2m"
_NC = "\033[0m"

_MCP_AUDIT = Path("/var/log/xinas/mcp-audit.jsonl")


def _safe_exists(p: Path) -> bool:
    """Path.exists() that returns False on EACCES.

    Python 3.12 changed Path.exists() to propagate non-ENOENT OSErrors, so a
    plain `.exists()` on a root-owned file (e.g. /etc/xinas-api/config.json,
    mode 0640 root:xinas-admin) raises PermissionError when the TUI is run as
    a non-root user. We treat "can't stat" the same as "not there" for display.
    """
    try:
        return p.exists()
    except OSError:
        return False


async def _probe_unix_socket(sock_path: Path, *, attempts: int = 4, delay: float = 0.25) -> bool:
    """Return True if a Unix socket is reachable, with brief retries.

    xinas-nfs-helper.service is Type=simple, so systemd marks the unit
    'active' the moment ExecStart forks — well before the daemon's
    `server.bind()` recreates /run/xinas-nfs-helper.sock (the daemon
    unlinks the stale socket at startup before rebinding). A naive
    Path.exists() check during that window reports "missing" even
    though the service is healthy. Probing with connect() and retrying
    over ~1s closes the race and also catches the worse case where the
    file exists but the daemon is not actually accepting.
    """
    loop = asyncio.get_running_loop()

    def _try() -> bool:
        s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        try:
            s.settimeout(0.5)
            s.connect(str(sock_path))
            return True
        except OSError:
            return False
        finally:
            s.close()

    for i in range(attempts):
        if await loop.run_in_executor(None, _try):
            return True
        if i < attempts - 1:
            await asyncio.sleep(delay)
    return False


def _cfg_restart_service() -> tuple[bool, str]:
    """Restart xinas-api so token / mcp.http / allow_apply edits take effect.

    The MCP transport lives inside xinas-api.service now (ADR-0010), and the
    api reads /etc/xinas-api/config.json once at boot (loadConfig — no hot
    reload), so a config write only applies after the service restarts.
    """
    from xinas_menu.utils.service_ctl import ServiceController

    return ServiceController().restart("xinas-api")


async def _write_and_restart(
    app, cfg: dict, audit_action: str, audit_target: str
) -> tuple[bool, str]:
    """Persist an api-config edit, restart xinas-api, and audit the change.

    Returns ``(ok, err)`` — ``ok`` is False (with the message in ``err``) if
    the write fails (e.g. EACCES for a non-root TUI) or the restart fails.
    """
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, api_cfg_write, cfg)
    except Exception as exc:
        app.audit.log(audit_action, audit_target, "FAIL")
        return False, str(exc)
    ok, err = await loop.run_in_executor(None, _cfg_restart_service)
    app.audit.log(audit_action, audit_target, "OK" if ok else "FAIL")
    return ok, err


def _get_ip() -> str:
    """Best-effort local IP."""
    try:
        return _socket.gethostbyname(_socket.gethostname())
    except Exception:
        return "10.10.1.1"


# Control-plane daemons, in dependency order. xinas-agent declares
# Requires=/After= xinas-api, so xinas-api MUST be restarted first:
# restarting the api stops the agent (Requires propagates the stop) and
# nothing pulls it back up, so the agent is restarted explicitly after.
_CONTROL_PLANE_SERVICES = ("xinas-api", "xinas-agent")


def _restart_control_plane(restart_fn) -> tuple[bool, list[tuple[str, bool, str]]]:
    """Restart the control-plane daemons in dependency order (api → agent).

    ``restart_fn(name) -> (ok, err)`` is injected so this is unit-testable
    without systemd. Returns ``(all_ok, [(service, ok, err), ...])``; every
    service is attempted (honest per-service report) even if an earlier one
    fails.
    """
    results: list[tuple[str, bool, str]] = []
    all_ok = True
    for svc in _CONTROL_PLANE_SERVICES:
        ok, err = restart_fn(svc)
        results.append((svc, ok, err))
        if not ok:
            all_ok = False
    return all_ok, results


# ── Main MCP menu ──────────────────────────────────────────────────────────

_MENU = [
    MenuItem("1", "Toggle NFS Helper (Start/Stop)"),
    MenuItem("2", "Restart NFS Helper"),
    MenuItem("3", "Show MCP Status"),
    MenuItem("4", "SSH Access Settings"),
    MenuItem("5", "View MCP Config"),
    MenuItem("6", "View Audit Log"),
    MenuItem("7", "View NFS Helper Logs"),
    MenuItem("8", "Check & Install Updates"),
    MenuItem("9", "Remote Access (HTTP)"),
    MenuItem("R", "Restart Control-Plane (api+agent)"),
    MenuItem("0", "Back"),
]


class MCPScreen(XiNASAppMixin, Screen):
    """MCP server management."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  MCP Server", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="mcp-nav")
            yield ScrollableTextView(id="mcp-content")
        yield Footer()

    def on_mount(self) -> None:
        self._show_status()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._toggle_nfs_helper()
        elif key == "2":
            self._restart()
        elif key == "3":
            self._show_status()
        elif key == "4":
            self.app.push_screen(SSHAccessScreen())
        elif key == "5":
            self._view_config()
        elif key == "6":
            self._view_audit()
        elif key == "7":
            self._view_nfs_logs()
        elif key == "8":
            self._check_updates()
        elif key == "9":
            self.app.push_screen(RemoteAccessScreen())
        elif key == "R":
            self._restart_control_plane_action()

    @work(exclusive=True)
    async def _toggle_nfs_helper(self) -> None:
        from xinas_menu.utils.service_ctl import ServiceController

        loop = asyncio.get_running_loop()
        ctl = ServiceController()
        state = await loop.run_in_executor(None, lambda: ctl.state("xinas-nfs-helper"))
        if state.is_active:
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog(
                    "Stop xinas-nfs-helper?\n\nThis prevents MCP from managing NFS exports until restarted.",
                    "Stop NFS Helper",
                )
            )
            if not confirmed:
                return
            ok, err = await loop.run_in_executor(None, lambda: ctl.stop("xinas-nfs-helper"))
            msg = "xinas-nfs-helper stopped." if ok else f"Failed: {err}"
        else:
            ok, err = await loop.run_in_executor(None, lambda: ctl.start("xinas-nfs-helper"))
            msg = "xinas-nfs-helper started." if ok else f"Failed: {err}"
        if ok:
            self.app.audit.log(
                "mcp.nfs_helper_toggle", "start" if not state.is_active else "stop", "OK"
            )
        view = self.query_one("#mcp-content", ScrollableTextView)
        if "Failed" in msg:
            view.set_content(f"{_RED}{msg}{_NC}")
        else:
            view.set_content(f"{_GRN}{msg}{_NC}")
        self._show_status()

    @work(exclusive=True)
    async def _show_status(self) -> None:
        from xinas_menu.utils.service_ctl import ServiceController

        loop = asyncio.get_running_loop()
        ctl = ServiceController()

        mcp_dist = Path("/opt/xiNAS/xiNAS-MCP/dist/mcp-stdio.js")
        nfs_sock = Path("/run/xinas-nfs-helper.sock")
        mcp_cfg = API_CONFIG_PATH

        nfs_state = await loop.run_in_executor(None, lambda: ctl.state("xinas-nfs-helper"))

        GRN, YLW, RED, CYN, BLD, DIM, NC = (
            "\033[32m",
            "\033[33m",
            "\033[31m",
            "\033[36m",
            "\033[1m",
            "\033[2m",
            "\033[0m",
        )
        lines = [f"{BLD}{CYN}=== MCP Server Status ==={NC}", ""]
        if mcp_dist.exists():
            lines.append(f"  {GRN}*{NC}  MCP server    {GRN}Ready (stdio){NC}")
            lines.append(f"     {DIM}Binary:{NC}       {mcp_dist}")
        else:
            lines.append(f"  {RED}!{NC}  MCP server    {RED}NOT BUILT{NC}")
            lines.append(f"     {DIM}Run: cd /opt/xiNAS/xiNAS-MCP && npm run build{NC}")
        lines.append("")

        if nfs_state.is_active:
            nfs_icon = f"{GRN}*{NC}"
            nfs_status = f"{GRN}{nfs_state.active}{NC}"
        else:
            nfs_icon = f"{RED}!{NC}"
            nfs_status = f"{RED}{nfs_state.active}{NC}"
        lines.append(f"  {nfs_icon}  NFS Helper    {nfs_status}")
        if nfs_state.is_active:
            sock_ok = await _probe_unix_socket(nfs_sock)
        else:
            sock_ok = nfs_sock.exists()
        sock_status = f"{GRN}OK{NC}" if sock_ok else f"{RED}missing{NC}"
        lines.append(f"     {DIM}Socket:{NC}       {nfs_sock}  ({sock_status})")
        lines.append("")

        # HTTP transport status (read from the xinas-api config)
        cfg = await loop.run_in_executor(None, api_cfg_read)
        http = http_transport_view(cfg)
        token_count = len(list_tokens(cfg))
        if http["enabled"]:
            apply_note = "apply on" if allow_apply_enabled(cfg) else "read/plan only"
            lines.append(
                f"  {GRN}*{NC}  HTTP Remote   {GRN}Enabled (http://…:{http['port']}/mcp){NC}"
            )
            lines.append(f"     {DIM}Tokens:{NC}       {token_count} configured")
            lines.append(f"     {DIM}MCP apply:{NC}    {apply_note}")
        else:
            lines.append(f"  {DIM}○{NC}  HTTP Remote   {DIM}Disabled (stdio only){NC}")
        lines.append("")

        if _safe_exists(mcp_cfg):
            lines.append(f"  {GRN}*{NC}  Config        {mcp_cfg}")
            cid = cfg.get("controller_id", "")
            lines.append(
                f"     {DIM}Controller:{NC}   {(cid[:20] + '...') if len(cid) > 20 else cid or '(not set)'}"
            )
        else:
            lines.append(f"  {RED}!{NC}  Config        {RED}Missing: {mcp_cfg}{NC}")
        lines.append("")

        ak = Path("/root/.ssh/authorized_keys")
        if _safe_exists(ak):
            try:
                n = sum(1 for line in ak.read_text().splitlines() if line.startswith("ssh-"))
            except Exception:
                n = 0
            lines.append(f"  {DIM}SSH keys for root:{NC} {GRN}{n}{NC} key(s) in {ak}")
        else:
            ip = _get_ip()
            lines.append(f"  {DIM}SSH keys for root:{NC} {YLW}none (authorized_keys missing){NC}")
            lines.append(f"     {DIM}Add with:{NC} ssh-copy-id root@{ip}")
        lines.append("")

        claude_cfg = Path("/root/.claude/mcp_servers.json")
        if _safe_exists(claude_cfg):
            lines.append(f"  {GRN}*{NC}  Claude Code   {claude_cfg}")
        else:
            ip = _get_ip()
            lines.append(f"  {DIM}[ ]{NC} Claude Code   {YLW}Not configured locally{NC}")
            lines.append(f"     {DIM}Register with:{NC}")
            lines.append(
                f"       claude mcp add --transport stdio xinas -- ssh -T root@{ip} xinas-mcp-stdio"
            )

        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content("\n".join(lines))

    @work(exclusive=True)
    async def _restart(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Restart xinas-nfs-helper?", "Confirm")
        )
        if not confirmed:
            return
        from xinas_menu.utils.service_ctl import ServiceController

        loop = asyncio.get_running_loop()
        ctl = ServiceController()
        # xinas-mcp.service is retired — MCP runs on-demand over Streamable
        # HTTP via xinas-api's /mcp, so only the NFS helper needs restarting.
        results = []
        all_ok = True
        for svc in ("xinas-nfs-helper",):
            ok, err = await loop.run_in_executor(None, lambda s=svc: ctl.restart(s))
            all_ok = all_ok and ok
            results.append(f"  {svc}: {'OK' if ok else err[:60]}")
        self.app.audit.log("mcp.restart", "xinas-nfs-helper", "OK" if all_ok else "FAIL")
        view = self.query_one("#mcp-content", ScrollableTextView)
        header = "Services restarted:" if all_ok else "Service restart FAILED:"
        colour = _GRN if all_ok else _RED
        view.set_content(f"{colour}{header}{_NC}\n\n" + "\n".join(results))
        self._show_status()

    @work(exclusive=True)
    async def _restart_control_plane_action(self) -> None:
        """Break-glass: restart xinas-api then xinas-agent. See
        docs/control-path/s8-clients-spec.md §6b."""
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Restart the control-plane services xinas-api and xinas-agent?\n\n"
                "This briefly interrupts the REST/MCP API, disconnects active\n"
                "remote MCP/API sessions, and may interrupt in-flight operations.\n"
                "Use only to recover a hung daemon.",
                "Restart Control-Plane",
            )
        )
        if not confirmed:
            return
        from xinas_menu.utils.service_ctl import ServiceController

        loop = asyncio.get_running_loop()
        ctl = ServiceController()
        all_ok, results = await loop.run_in_executor(
            None, lambda: _restart_control_plane(ctl.restart)
        )
        self.app.audit.log(
            "mcp.control_plane_restart",
            "xinas-api,xinas-agent",
            "OK" if all_ok else "FAILED",
        )
        lines = [f"  {svc}: {'OK' if ok else (err[:60] or 'failed')}" for svc, ok, err in results]
        header = _GRN if all_ok else _RED
        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content(f"{header}Control-plane restart:{_NC}\n\n" + "\n".join(lines))
        self._show_status()

    @work(exclusive=True)
    async def _setup(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Run Ansible xinas_mcp role to install/update MCP?", "Setup MCP")
        )
        if not confirmed:
            return
        from xinas_menu.screens.startup.playbook_screen import PlaybookRunScreen

        await self.app.push_screen_wait(
            PlaybookRunScreen(
                cmd=["ansible-playbook", "playbooks/site.yml", "--tags", "xinas_mcp"],
                title="Install / Update MCP Server",
            )
        )

    @work(exclusive=True)
    async def _view_config(self) -> None:
        view = self.query_one("#mcp-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        if not await loop.run_in_executor(None, api_config_present):
            view.set_content(f"[dim]xinas-api config not found: {API_CONFIG_PATH}[/dim]")
            return
        try:
            cfg = await loop.run_in_executor(None, api_cfg_read)
            text = json.dumps(redact_config(cfg), indent=2)
            view.set_content(
                f"[bold]{API_CONFIG_PATH}[/bold]  [dim](token values masked)[/dim]\n\n{text}"
            )
        except Exception as exc:
            view.set_content(f"[red]{exc}[/red]")

    @work(exclusive=True)
    async def _view_audit(self) -> None:
        view = self.query_one("#mcp-content", ScrollableTextView)
        try:
            lines = _MCP_AUDIT.read_text().splitlines()[-200:]
            view.set_content("\n".join(lines) or "[dim]Audit log is empty.[/dim]")
        except FileNotFoundError:
            view.set_content("[dim]MCP audit log not found.[/dim]")
        except Exception as exc:
            view.set_content(f"[red]{exc}[/red]")

    @work(exclusive=True)
    async def _view_nfs_logs(self) -> None:
        loop = asyncio.get_running_loop()
        r = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["journalctl", "-n", "200", "--no-pager", "-u", "xinas-nfs-helper"],
                capture_output=True,
                text=True,
            ),
        )
        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content(r.stdout or "[dim]No NFS helper log entries.[/dim]")

    @work(exclusive=True)
    async def _check_updates(self) -> None:
        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content("[dim]Checking for updates…[/dim]")
        result = await self.app._update_checker.check()
        if result.error:
            view.set_content(f"{_RED}Update check failed: {result.error}{_NC}")
            return
        if result.available:
            self.app._last_check_result = result
            self.app.update_available = True
            await self.app.prompt_and_apply_update(result)
        else:
            view.set_content("[green]MCP server is up to date.[/green]")


# ── Remote Access (HTTP) sub-screen ─────────────────────────────────────────


class RemoteAccessScreen(XiNASAppMixin, Screen):
    """Configure Streamable HTTP transport, tokens, and TLS."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Remote Access (HTTP)", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu([], id="ra-nav")
            yield ScrollableTextView(id="ra-content")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_menu()

    def _refresh_menu(self) -> None:
        """Rebuild menu to reflect current config state."""
        nav = self.query_one("#ra-nav", NavigableMenu)
        if not api_config_present():
            nav.update_items([MenuItem("0", "Back")])
            view = self.query_one("#ra-content", ScrollableTextView)
            view.set_content(
                f"{_RED}xinas-api config not found:{_NC} {API_CONFIG_PATH}\n\n"
                f"  {_DIM}MCP transport + tokens are managed in the xinas-api\n"
                f"  config. Install/enable xinas-api first.{_NC}"
            )
            return

        cfg = api_cfg_read()
        http = http_transport_view(cfg)
        port = http["port"] or DEFAULT_HTTP_PORT
        token_count = len(list_tokens(cfg))
        apply_on = allow_apply_enabled(cfg)

        toggle_label = "Disable HTTP Transport" if http["enabled"] else "Enable HTTP Transport"
        apply_label = "Disable MCP Apply" if apply_on else "Allow MCP Apply"
        items = [
            MenuItem("1", toggle_label),
            MenuItem("2", f"Set Port (current: {port})"),
            MenuItem("3", f"Manage Tokens ({token_count})"),
            MenuItem("4", apply_label),
            MenuItem("5", "Show Connection Command"),
            MenuItem("0", "Back"),
        ]
        nav.update_items(items)
        self._show_status_panel(cfg)

    def _show_status_panel(self, cfg: dict | None = None) -> None:
        """Update the right-side status panel."""
        if cfg is None:
            cfg = api_cfg_read()
        GRN, RED, DIM, NC = "\033[32m", "\033[31m", "\033[2m", "\033[0m"

        http = http_transport_view(cfg)
        apply_on = allow_apply_enabled(cfg)
        tokens = list_tokens(cfg)

        lines = []
        if http["enabled"]:
            lines.append(f"  {GRN}●{NC}  HTTP Transport   {GRN}Enabled (port {http['port']}){NC}")
        else:
            lines.append(f"  {RED}○{NC}  HTTP Transport   {RED}Disabled{NC}")

        if apply_on:
            lines.append(f"  {GRN}●{NC}  MCP Apply        {GRN}Allowed{NC}")
        else:
            lines.append(f"  {DIM}○{NC}  MCP Apply        {DIM}Disabled (read/plan only){NC}")

        lines.append(f"  {DIM}   Tokens:{NC}          {len(tokens)} configured")
        if tokens:
            lines.append("")
            for row in tokens:
                tag = " (bootstrap)" if row["protected"] else ""
                lines.append(f"     {GRN}●{NC} {row['principal']}  {DIM}[{row['role']}]{tag}{NC}")

        view = self.query_one("#ra-content", ScrollableTextView)
        view.set_content("\n".join(lines))

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._toggle_http()
        elif key == "2":
            self._set_port()
        elif key == "3":
            self.app.push_screen(TokenManagementScreen())
        elif key == "4":
            self._toggle_allow_apply()
        elif key == "5":
            self._show_connection_cmd()

    @work(exclusive=True)
    async def _toggle_http(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, api_cfg_read)
        http = http_transport_view(cfg)
        view = self.query_one("#ra-content", ScrollableTextView)

        if http["enabled"]:
            new_cfg = disable_http_transport(cfg)
            ok, err = await _write_and_restart(self.app, new_cfg, "mcp.http_disable", "")
            if not ok:
                view.set_content(f"{_RED}Failed: {err}{_NC}")
            else:
                view.set_content(
                    f"{_GRN}HTTP transport disabled.{_NC}\n\n"
                    f"  {_DIM}MCP is now reachable via stdio only.{_NC}"
                )
        else:
            port = http["port"] or DEFAULT_HTTP_PORT
            host = http["host"] or DEFAULT_HTTP_HOST
            proceed = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Enable MCP HTTP transport on {host}:{port}?\n\n"
                    "Remote clients presenting a valid bearer token will be\n"
                    "able to reach the control API over TCP.",
                    "Enable HTTP Transport",
                )
            )
            if not proceed:
                return
            new_cfg = set_http_transport(cfg, host=host, port=port)
            ok, err = await _write_and_restart(self.app, new_cfg, "mcp.http_enable", f"port={port}")
            if not ok:
                view.set_content(f"{_RED}Failed: {err}{_NC}")
            else:
                ip = _get_ip()
                view.set_content(
                    f"{_GRN}HTTP transport enabled on port {port}.{_NC}\n\n"
                    f"  {_DIM}Remote clients can connect at:{_NC}\n"
                    f"  http://{ip}:{port}/mcp"
                )
        self._refresh_menu()

    @work(exclusive=True)
    async def _set_port(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, api_cfg_read)
        http = http_transport_view(cfg)
        current = str(http["port"] or DEFAULT_HTTP_PORT)
        host = http["host"] or DEFAULT_HTTP_HOST

        while True:
            new_port = await self.app.push_screen_wait(
                InputDialog(
                    "Enter port number for HTTP transport:",
                    "HTTP Port",
                    default=current,
                    placeholder="8080",
                )
            )
            if not new_port:
                return
            try:
                port = int(new_port)
                if not 1 <= port <= 65535:
                    raise ValueError
            except ValueError:
                self.app.notify("Port must be a number between 1 and 65535.", severity="error")
                continue
            break

        new_cfg = set_http_transport(cfg, host=host, port=port)
        view = self.query_one("#ra-content", ScrollableTextView)
        ok, err = await _write_and_restart(self.app, new_cfg, "mcp.http_port", str(port))
        if not ok:
            view.set_content(f"{_RED}Failed: {err}{_NC}")
        elif http["enabled"]:
            view.set_content(f"{_GRN}HTTP port set to {port}.{_NC}")
        else:
            ip = _get_ip()
            view.set_content(
                f"{_GRN}HTTP transport enabled on port {port}.{_NC}\n\n"
                f"  {_DIM}Remote clients can connect at:{_NC}\n"
                f"  http://{ip}:{port}/mcp"
            )
        self._refresh_menu()

    @work(exclusive=True)
    async def _toggle_allow_apply(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, api_cfg_read)
        view = self.query_one("#ra-content", ScrollableTextView)

        if allow_apply_enabled(cfg):
            new_cfg = set_allow_apply(cfg, False)
            ok, err = await _write_and_restart(self.app, new_cfg, "mcp.allow_apply_disable", "")
            if not ok:
                view.set_content(f"{_RED}Failed: {err}{_NC}")
            else:
                view.set_content(
                    f"{_GRN}MCP apply disabled.{_NC}\n\n"
                    f"  {_DIM}Remote MCP clients can plan/read but not apply changes.{_NC}"
                )
        else:
            proceed = await self.app.push_screen_wait(
                ConfirmDialog(
                    "Allow MCP clients to APPLY changes?\n\n"
                    "By default remote MCP is plan/read-only. Enabling this\n"
                    "lets an MCP client with an operator/admin token mutate\n"
                    "host state (RAID, shares, network). RBAC still applies.",
                    "Allow MCP Apply",
                )
            )
            if not proceed:
                return
            new_cfg = set_allow_apply(cfg, True)
            ok, err = await _write_and_restart(self.app, new_cfg, "mcp.allow_apply_enable", "")
            if not ok:
                view.set_content(f"{_RED}Failed: {err}{_NC}")
            else:
                view.set_content(
                    f"{_GRN}MCP apply enabled.{_NC}\n\n"
                    f"  {_DIM}Remote MCP clients may now apply changes (RBAC enforced).{_NC}"
                )
        self._refresh_menu()

    @work(exclusive=True)
    async def _show_connection_cmd(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, api_cfg_read)
        ip = _get_ip()
        http = http_transport_view(cfg)
        port = http["port"] or DEFAULT_HTTP_PORT
        proto = "http"
        tokens = list_tokens(cfg)
        first_token = tokens[0]["token"] if tokens else None
        masked = f"{first_token[:8]}...{first_token[-4:]}" if first_token else ""

        _GRN, CYN, BLD, DIM, NC = "\033[32m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
        lines = [
            f"{BLD}{CYN}=== MCP Remote Connection ==={NC}",
            "",
            f"  {DIM}Endpoint:{NC} {proto}://{ip}:{port}/mcp",
            "",
            f"{BLD}--- Claude Code (CLI) ---{NC}",
            "",
        ]
        if first_token:
            lines.append("  claude mcp add \\")
            lines.append("    --transport http \\")
            lines.append(f'    --header "Authorization: Bearer {masked}" \\')
            lines.append(f"    xinas {proto}://{ip}:{port}/mcp")
            lines.append("")
            lines.append(f"  {DIM}(Replace masked token with full value from Token Management){NC}")
        else:
            lines.append("  claude mcp add \\")
            lines.append("    --transport http \\")
            lines.append(f"    xinas {proto}://{ip}:{port}/mcp")

        lines.extend(
            [
                "",
                f"{BLD}--- curl test ---{NC}",
                "",
                f"  curl -X POST {proto}://{ip}:{port}/mcp \\",
            ]
        )
        if first_token:
            lines.append(f'    -H "Authorization: Bearer {masked}" \\')
        lines.extend(
            [
                '    -H "Content-Type: application/json" \\',
                """    -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test"}}}'""",
            ]
        )

        view = self.query_one("#ra-content", ScrollableTextView)
        view.set_content("\n".join(lines))


# ── Token Management sub-screen ─────────────────────────────────────────────


class TokenManagementScreen(XiNASAppMixin, Screen):
    """Add / remove API tokens for HTTP authentication."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  API Tokens", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu([], id="tok-nav")
            yield ScrollableTextView(id="tok-content")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh()

    def _refresh(self) -> None:
        nav = self.query_one("#tok-nav", NavigableMenu)
        if not api_config_present():
            nav.update_items([MenuItem("0", "Back")])
            view = self.query_one("#tok-content", ScrollableTextView)
            view.set_content(f"{_RED}xinas-api config not found:{_NC} {API_CONFIG_PATH}")
            return

        cfg = api_cfg_read()
        tokens = list_tokens(cfg)

        items = [
            MenuItem("A", "Add Token"),
            MenuItem("R", "Remove Token"),
        ]
        if tokens:
            items.append(MenuItem("", "", separator=True))
            for idx, row in enumerate(tokens, 1):
                tag = " (bootstrap)" if row["protected"] else ""
                items.append(
                    MenuItem(str(idx), f"{row['principal']}  [{row['role']}]{tag}", enabled=False)
                )
        items.append(MenuItem("0", "Back"))
        nav.update_items(items)

        # Status panel
        GRN, DIM, NC = "\033[32m", "\033[2m", "\033[0m"
        lines = [f"  {len(tokens)} token(s) configured", ""]
        for row in tokens:
            tag = " (bootstrap, protected)" if row["protected"] else ""
            lines.append(f"  {GRN}●{NC} {row['principal']}  {DIM}[{row['role']}]{tag}{NC}")
            lines.append(f"    {DIM}{row['token'][:8]}…{NC}")
            lines.append("")
        if not tokens:
            lines.append(f"  {DIM}No tokens. Press A to add one.{NC}")

        view = self.query_one("#tok-content", ScrollableTextView)
        view.set_content("\n".join(lines))

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.pop_screen()
        elif key == "A":
            self._add_token()
        elif key == "R":
            self._remove_token()

    @work(exclusive=True)
    async def _add_token(self) -> None:
        loop = asyncio.get_running_loop()

        import re

        _TOKEN_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

        while True:
            token_name = await self.app.push_screen_wait(
                InputDialog(
                    "Enter a name (principal) for the new token\n(e.g. remote-claude, monitoring):",
                    "Token Name",
                    placeholder="remote-claude",
                )
            )
            if not token_name:
                return
            if not token_name.strip():
                self.app.notify("Token name must not be empty.", severity="error")
                continue
            token_name = token_name.strip()
            if not _TOKEN_NAME_RE.match(token_name):
                self.app.notify(
                    "Token name must be alphanumeric, dash, or underscore only.", severity="error"
                )
                continue
            # Check duplicate principal
            cfg = await loop.run_in_executor(None, api_cfg_read)
            existing = {row["principal"] for row in list_tokens(cfg)}
            if token_name in existing:
                self.app.notify(
                    f"A token with principal '{token_name}' already exists. "
                    "Remove it first to regenerate.",
                    severity="error",
                )
                continue
            break

        # Select role
        role_key = await self.app.push_screen_wait(_RoleSelectDialog())
        if not role_key:
            return

        # Generate token and persist (write api config + restart xinas-api)
        token_value = secrets.token_hex(32)
        new_cfg = add_token(cfg, token_value, token_name, role_key)
        ok, err = await _write_and_restart(
            self.app, new_cfg, "mcp.token_add", f"{token_name} ({role_key})"
        )
        if not ok:
            view = self.query_one("#tok-content", ScrollableTextView)
            view.set_content(f"{_RED}Failed: {err}{_NC}")
            return

        await self.app.push_screen_wait(
            ConfirmDialog(
                f"Principal: {token_name}\n"
                f"Role:      {role_key}\n\n"
                f"Token (copy now — shown once):\n\n"
                f"{token_value}\n\n"
                f"Press Ctrl+Y to copy the token.\n"
                f"Use as Bearer token in the Authorization header.",
                "Token Created",
                ok_only=True,
                copy_text=token_value,
            )
        )
        self._refresh()

    @work(exclusive=True)
    async def _remove_token(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, api_cfg_read)
        # The bootstrap admin token is protected — never offered for removal.
        tokens = [row for row in list_tokens(cfg) if not row["protected"]]

        if not tokens:
            view = self.query_one("#tok-content", ScrollableTextView)
            view.set_content(
                f"{_YLW}No removable tokens.{_NC}\n\n"
                f"  {_DIM}The bootstrap admin token is protected. Press A to add one.{_NC}"
            )
            return

        # Build selection menu
        items: list[MenuItem] = []
        for idx, row in enumerate(tokens, 1):
            items.append(MenuItem(str(idx), f"{row['principal']}  [{row['role']}]"))
        items.append(MenuItem("0", "Cancel"))

        sel = await self.app.push_screen_wait(_SelectionDialog("Select token to remove:", items))
        if not sel or sel == "0":
            return

        rm_idx = int(sel) - 1
        if rm_idx < 0 or rm_idx >= len(tokens):
            return
        row = tokens[rm_idx]

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Remove token '{row['principal']}'?", "Confirm Remove")
        )
        if not confirmed:
            return

        new_cfg = remove_token(cfg, row["token"])
        ok, err = await _write_and_restart(self.app, new_cfg, "mcp.token_remove", row["principal"])
        view = self.query_one("#tok-content", ScrollableTextView)
        if not ok:
            view.set_content(f"{_RED}Failed: {err}{_NC}")
        else:
            view.set_content(f"{_GRN}Token '{row['principal']}' removed.{_NC}")
        self._refresh()


# ── Helper modal screens ────────────────────────────────────────────────────


class _RoleSelectDialog(Screen[str | None]):
    """Modal screen to select a token role."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
        Binding("0", "cancel", "Cancel", show=False),
    ]

    _ITEMS = [
        MenuItem("1", "admin    — Full access"),
        MenuItem("2", "operator — Read + execute"),
        MenuItem("3", "viewer   — Read-only"),
        MenuItem("0", "Cancel"),
    ]

    _ROLE_MAP = {"1": "admin", "2": "operator", "3": "viewer"}

    def compose(self) -> ComposeResult:
        yield Label("  Select Token Role", id="screen-title")
        yield NavigableMenu(self._ITEMS, id="role-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        role = self._ROLE_MAP.get(event.key)
        if role:
            self.dismiss(role)
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class _SelectionDialog(Screen[str | None]):
    """Modal screen to select from a list of items."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel", show=False),
        Binding("0", "cancel", "Cancel", show=False),
    ]

    def __init__(self, title: str, items: list[MenuItem]) -> None:
        super().__init__()
        self._title = title
        self._items = items

    def compose(self) -> ComposeResult:
        yield Label(f"  {self._title}", id="screen-title")
        yield NavigableMenu(self._items, id="sel-nav")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.dismiss(None)
        else:
            self.dismiss(event.key)

    def action_cancel(self) -> None:
        self.dismiss(None)


# ── SSH Access sub-screen ───────────────────────────────────────────────────


class SSHAccessScreen(XiNASAppMixin, Screen):
    """Configure root SSH access for Claude Code."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    _SSH_CFG = Path("/etc/ssh/sshd_config.d/10-xinas-root-access.conf")

    _MENU = [
        MenuItem("1", "Show SSH Status"),
        MenuItem("2", "Enable Key-Based Root Login"),
        MenuItem("3", "Disable Root Login"),
        MenuItem("4", "Add Authorized Key"),
        MenuItem("0", "Back"),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  SSH Access Settings", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(self._MENU, id="ssh-nav")
            yield ScrollableTextView(id="ssh-content")
        yield Footer()

    def on_mount(self) -> None:
        self._show_status()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._show_status()
        elif key == "2":
            self._enable_root_ssh()
        elif key == "3":
            self._disable_root_ssh()
        elif key == "4":
            self._add_key()

    @work(exclusive=True)
    async def _show_status(self) -> None:
        lines = ["[bold]Root SSH Configuration[/bold]\n"]
        if self._SSH_CFG.exists():
            lines.append(f"  Config: {self._SSH_CFG}")
            lines.append(f"\n{self._SSH_CFG.read_text()}")
        else:
            lines.append("  [yellow]Root SSH config not present[/yellow]")
        # Check authorized_keys
        ak = Path("/root/.ssh/authorized_keys")
        if ak.exists():
            keys = [
                line
                for line in ak.read_text().splitlines()
                if line.strip() and not line.startswith("#")
            ]
            lines.append(f"\n  Authorized keys: {len(keys)}")
        view = self.query_one("#ssh-content", ScrollableTextView)
        view.set_content("\n".join(lines))

    @work(exclusive=True)
    async def _enable_root_ssh(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Enable key-based root SSH login?", "Confirm")
        )
        if not confirmed:
            return
        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(None, _enable_root_ssh_sync)
        view = self.query_one("#ssh-content", ScrollableTextView)
        if ok:
            self.app.audit.log("ssh.root_enable", "", "OK")
            view.set_content(f"{_GRN}Root SSH enabled.{_NC}")
        else:
            view.set_content(f"{_RED}Failed: {err}{_NC}")
        self._show_status()

    @work(exclusive=True)
    async def _disable_root_ssh(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Disable root SSH login?", "Confirm")
        )
        if not confirmed:
            return
        try:
            self._SSH_CFG.unlink(missing_ok=True)
            subprocess.run(["systemctl", "reload", "sshd"], capture_output=True)
            self.app.audit.log("ssh.root_disable", "", "OK")
        except Exception as exc:
            view = self.query_one("#ssh-content", ScrollableTextView)
            view.set_content(f"{_RED}{exc}{_NC}")
        self._show_status()

    @work(exclusive=True)
    async def _add_key(self) -> None:
        while True:
            key = await self.app.push_screen_wait(
                InputDialog(
                    "Paste public key:",
                    "Add Authorized Key",
                    placeholder="ssh-rsa AAAA... user@host",
                )
            )
            if not key:
                return
            if not (key.strip().startswith("ssh-") or key.strip().startswith("ecdsa-")):
                self.app.notify("Public key must start with 'ssh-' or 'ecdsa-'.", severity="error")
                continue
            break
        try:
            ak = Path("/root/.ssh/authorized_keys")
            ak.parent.mkdir(mode=0o700, exist_ok=True)
            ak.parent.chmod(0o700)
            with ak.open("a") as f:
                f.write(key.strip() + "\n")
            ak.chmod(0o600)
            self.app.audit.log("ssh.add_key", key[:30] + "…", "OK")
            view = self.query_one("#ssh-content", ScrollableTextView)
            view.set_content(f"{_GRN}Key added.{_NC}")
        except Exception as exc:
            view = self.query_one("#ssh-content", ScrollableTextView)
            view.set_content(f"{_RED}{exc}{_NC}")
        self._show_status()


def _enable_root_ssh_sync() -> tuple[bool, str]:
    try:
        cfg = Path("/etc/ssh/sshd_config.d/10-xinas-root-access.conf")
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(
            "# Managed by xiNAS — allows key-based root login for Claude Code\n"
            "PermitRootLogin prohibit-password\n"
        )
        r = subprocess.run(["systemctl", "reload", "sshd"], capture_output=True, text=True)
        if r.returncode != 0:
            return False, r.stderr.strip()
        return True, ""
    except Exception as exc:
        return False, str(exc)
