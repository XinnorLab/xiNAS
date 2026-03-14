"""MCPScreen — MCP server management + SSH access + HTTP remote access."""
from __future__ import annotations

import asyncio
import secrets
import socket as _socket
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView
from xinas_menu.utils.config import CONFIG_PATH as _MCP_CONFIG, cfg_read as _cfg_read, cfg_write as _cfg_write

_MCP_AUDIT = Path("/var/log/xinas/mcp-audit.jsonl")


def _cfg_restart_service() -> tuple[bool, str]:
    """Restart xinas-nfs-helper after config change."""
    r = subprocess.run(
        ["systemctl", "restart", "xinas-nfs-helper"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return False, r.stderr.strip()
    return True, ""


def _get_ip() -> str:
    """Best-effort local IP."""
    try:
        return _socket.gethostbyname(_socket.gethostname())
    except Exception:
        return "10.10.1.1"


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
    MenuItem("0", "Back"),
]


class MCPScreen(Screen):
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

    @work(exclusive=True)
    async def _toggle_nfs_helper(self) -> None:
        from xinas_menu.utils.service_ctl import ServiceController
        loop = asyncio.get_running_loop()
        ctl = ServiceController()
        state = await loop.run_in_executor(None, lambda: ctl.state("xinas-nfs-helper"))
        if state.is_active:
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog("Stop xinas-nfs-helper?\n\nThis prevents MCP from managing NFS exports until restarted.", "Stop NFS Helper")
            )
            if not confirmed:
                return
            ok, err = await loop.run_in_executor(None, lambda: ctl.stop("xinas-nfs-helper"))
            msg = "xinas-nfs-helper stopped." if ok else f"Failed: {err}"
        else:
            ok, err = await loop.run_in_executor(None, lambda: ctl.start("xinas-nfs-helper"))
            msg = "xinas-nfs-helper started." if ok else f"Failed: {err}"
        if ok:
            self.app.audit.log("mcp.nfs_helper_toggle", "start" if not state.is_active else "stop", "OK")
        await self.app.push_screen_wait(ConfirmDialog(msg, "NFS Helper"))
        await self._show_status()

    @work(exclusive=True)
    async def _show_status(self) -> None:
        from xinas_menu.utils.service_ctl import ServiceController
        loop = asyncio.get_running_loop()
        ctl = ServiceController()

        mcp_dist = Path("/opt/xiNAS/xiNAS-MCP/dist/index.js")
        nfs_sock = Path("/run/xinas-nfs-helper.sock")
        mcp_cfg = _MCP_CONFIG

        nfs_state = await loop.run_in_executor(None, lambda: ctl.state("xinas-nfs-helper"))

        GRN, YLW, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
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
        sock_status = f"{GRN}OK{NC}" if nfs_sock.exists() else f"{RED}missing{NC}"
        lines.append(f"     {DIM}Socket:{NC}       {nfs_sock}  ({sock_status})")
        lines.append("")

        # HTTP transport status
        cfg = await loop.run_in_executor(None, _cfg_read)
        http_on = cfg.get("http_enabled", False)
        http_port = cfg.get("http_port", 8080)
        tls = cfg.get("tls")
        token_count = len(cfg.get("tokens", {}))
        if http_on:
            proto = "https" if tls else "http"
            lines.append(f"  {GRN}*{NC}  HTTP Remote   {GRN}Enabled ({proto}://…:{http_port}/mcp){NC}")
            lines.append(f"     {DIM}Tokens:{NC}       {token_count} configured")
        else:
            lines.append(f"  {DIM}○{NC}  HTTP Remote   {DIM}Disabled{NC}")
        lines.append("")

        if mcp_cfg.exists():
            lines.append(f"  {GRN}*{NC}  Config        {mcp_cfg}")
            cid = cfg.get("controller_id", "")
            lines.append(f"     {DIM}Controller:{NC}   {(cid[:20] + '...') if len(cid) > 20 else cid or '(not set)'}")
        else:
            lines.append(f"  {RED}!{NC}  Config        {RED}Missing: {mcp_cfg}{NC}")
        lines.append("")

        ak = Path("/root/.ssh/authorized_keys")
        if ak.exists():
            try:
                n = sum(1 for l in ak.read_text().splitlines() if l.startswith("ssh-"))
            except Exception:
                n = 0
            lines.append(f"  {DIM}SSH keys for root:{NC} {GRN}{n}{NC} key(s) in {ak}")
        else:
            ip = _get_ip()
            lines.append(f"  {DIM}SSH keys for root:{NC} {YLW}none (authorized_keys missing){NC}")
            lines.append(f"     {DIM}Add with:{NC} ssh-copy-id root@{ip}")
        lines.append("")

        claude_cfg = Path("/root/.claude/mcp_servers.json")
        if claude_cfg.exists():
            lines.append(f"  {GRN}*{NC}  Claude Code   {claude_cfg}")
        else:
            ip = _get_ip()
            lines.append(f"  {DIM}[ ]{NC} Claude Code   {YLW}Not configured locally{NC}")
            lines.append(f"     {DIM}Register with:{NC}")
            lines.append(f"       claude mcp add --transport stdio xinas -- ssh -T root@{ip} xinas-mcp")

        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content("\n".join(lines))

    @work(exclusive=True)
    async def _restart(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Restart xinas-mcp and xinas-nfs-helper?", "Confirm")
        )
        if not confirmed:
            return
        from xinas_menu.utils.service_ctl import ServiceController
        loop = asyncio.get_running_loop()
        ctl = ServiceController()
        results = []
        for svc in ("xinas-mcp", "xinas-nfs-helper"):
            ok, err = await loop.run_in_executor(None, lambda s=svc: ctl.restart(s))
            results.append(f"  {svc}: {'OK' if ok else err[:60]}")
        self.app.audit.log("mcp.restart", "both services", "OK")
        await self.app.push_screen_wait(
            ConfirmDialog("\n".join(results), "Restart Result")
        )
        await self._show_status()

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
        try:
            text = _MCP_CONFIG.read_text()
            view.set_content(f"[bold]{_MCP_CONFIG}[/bold]\n\n{text}")
        except FileNotFoundError:
            view.set_content("[dim]MCP config not found.[/dim]")
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
                capture_output=True, text=True,
            )
        )
        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content(r.stdout or "[dim]No NFS helper log entries.[/dim]")

    @work(exclusive=True)
    async def _check_updates(self) -> None:
        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content("[dim]Checking for updates…[/dim]")
        available = await self.app._update_checker.check()
        if available:
            self.app.update_available = True
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog("Update available. Apply now?", "Update")
            )
            if confirmed:
                await self.app._apply_update()
        else:
            view.set_content("[green]MCP server is up to date.[/green]")


# ── Remote Access (HTTP) sub-screen ─────────────────────────────────────────

class RemoteAccessScreen(Screen):
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
        cfg = _cfg_read()
        http_on = cfg.get("http_enabled", False)
        http_port = cfg.get("http_port", 8080)
        token_count = len(cfg.get("tokens", {}))

        toggle_label = "Disable HTTP Transport" if http_on else "Enable HTTP Transport"
        items = [
            MenuItem("1", toggle_label),
            MenuItem("2", f"Set Port (current: {http_port})"),
            MenuItem("3", f"Manage Tokens ({token_count})"),
            MenuItem("4", "Configure TLS"),
            MenuItem("5", "Show Connection Command"),
            MenuItem("0", "Back"),
        ]
        nav = self.query_one("#ra-nav", NavigableMenu)
        nav.update_items(items)
        self._show_status_panel(cfg)

    def _show_status_panel(self, cfg: dict | None = None) -> None:
        """Update the right-side status panel."""
        if cfg is None:
            cfg = _cfg_read()
        GRN, RED, DIM, NC = "\033[32m", "\033[31m", "\033[2m", "\033[0m"

        http_on = cfg.get("http_enabled", False)
        http_port = cfg.get("http_port", 8080)
        tls = cfg.get("tls")
        tokens = cfg.get("tokens", {})
        labels = cfg.get("token_labels", {})

        lines = []
        if http_on:
            lines.append(f"  {GRN}●{NC}  HTTP Transport   {GRN}Enabled (port {http_port}){NC}")
        else:
            lines.append(f"  {RED}○{NC}  HTTP Transport   {RED}Disabled{NC}")

        if tls and tls.get("cert"):
            lines.append(f"  {GRN}●{NC}  TLS              {GRN}Configured{NC}")
            lines.append(f"     {DIM}Cert:{NC} {tls['cert']}")
        else:
            lines.append(f"  {DIM}○{NC}  TLS              {DIM}Not configured{NC}")

        lines.append(f"  {DIM}   Tokens:{NC}          {len(tokens)} configured")
        if tokens:
            lines.append("")
            for tv, role in tokens.items():
                name = labels.get(tv, tv[:12] + "…")
                lines.append(f"     {GRN}●{NC} {name}  {DIM}[{role}]{NC}")

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
            self._configure_tls()
        elif key == "5":
            self._show_connection_cmd()

    @work(exclusive=True)
    async def _toggle_http(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)
        http_on = cfg.get("http_enabled", False)

        if http_on:
            cfg["http_enabled"] = False
            await loop.run_in_executor(None, _cfg_write, cfg)
            await loop.run_in_executor(None, _cfg_restart_service)
            self.app.audit.log("mcp.http_disable", "", "OK")
            await self.app.push_screen_wait(
                ConfirmDialog("HTTP transport disabled.\nMCP server is now stdio-only.", "HTTP Disabled")
            )
        else:
            token_count = len(cfg.get("tokens", {}))
            if token_count == 0:
                proceed = await self.app.push_screen_wait(
                    ConfirmDialog(
                        "No auth tokens configured.\n"
                        "Enabling HTTP without tokens allows\n"
                        "unauthenticated access.\n\n"
                        "Continue anyway?",
                        "Warning: No Tokens",
                    )
                )
                if not proceed:
                    return
            cfg["http_enabled"] = True
            await loop.run_in_executor(None, _cfg_write, cfg)
            await loop.run_in_executor(None, _cfg_restart_service)
            port = cfg.get("http_port", 8080)
            ip = _get_ip()
            self.app.audit.log("mcp.http_enable", f"port={port}", "OK")
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"HTTP transport enabled on port {port}.\n\n"
                    f"Remote clients can connect at:\n"
                    f"  http://{ip}:{port}/mcp",
                    "HTTP Enabled",
                )
            )
        self._refresh_menu()

    @work(exclusive=True)
    async def _set_port(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)
        current = str(cfg.get("http_port", 8080))

        while True:
            new_port = await self.app.push_screen_wait(
                InputDialog("Enter port number for HTTP transport:", "HTTP Port", default=current, placeholder="8080")
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

        cfg["http_port"] = port
        await loop.run_in_executor(None, _cfg_write, cfg)
        await loop.run_in_executor(None, _cfg_restart_service)
        self.app.audit.log("mcp.http_port", str(port), "OK")
        await self.app.push_screen_wait(
            ConfirmDialog(f"HTTP port set to {port}.", "Port Updated")
        )
        self._refresh_menu()

    @work(exclusive=True)
    async def _configure_tls(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)
        tls = cfg.get("tls") or {}

        cert_path = await self.app.push_screen_wait(
            InputDialog(
                "Path to TLS certificate (.crt/.pem):\n\n(Leave empty to disable TLS)",
                "TLS Certificate",
                default=tls.get("cert", ""),
                placeholder="/etc/ssl/certs/server.crt",
            )
        )
        if cert_path is None:
            return

        if not cert_path.strip():
            # Disable TLS
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog("Remove TLS configuration?\nHTTP will use plain (unencrypted) connections.", "Disable TLS?")
            )
            if confirmed:
                cfg.pop("tls", None)
                await loop.run_in_executor(None, _cfg_write, cfg)
                await loop.run_in_executor(None, _cfg_restart_service)
                self.app.audit.log("mcp.tls_disable", "", "OK")
                await self.app.push_screen_wait(ConfirmDialog("TLS configuration removed.", "TLS Disabled"))
            self._refresh_menu()
            return

        if not Path(cert_path).exists():
            await self.app.push_screen_wait(ConfirmDialog(f"File not found:\n{cert_path}", "Error"))
            return

        key_path = await self.app.push_screen_wait(
            InputDialog("Path to TLS private key (.key/.pem):", "TLS Private Key", default=tls.get("key", ""), placeholder="/etc/ssl/private/server.key")
        )
        if not key_path:
            return
        if not Path(key_path).exists():
            await self.app.push_screen_wait(ConfirmDialog(f"File not found:\n{key_path}", "Error"))
            return

        ca_path = await self.app.push_screen_wait(
            InputDialog(
                "Path to CA certificate for mTLS (optional):\n\n(Leave empty to skip client verification)",
                "CA Certificate",
                default=tls.get("ca", ""),
                placeholder="/etc/ssl/certs/ca.crt",
            )
        )
        if ca_path is None:
            return
        if ca_path.strip() and not Path(ca_path).exists():
            await self.app.push_screen_wait(ConfirmDialog(f"File not found:\n{ca_path}", "Error"))
            return

        new_tls: dict = {"cert": cert_path.strip(), "key": key_path.strip()}
        if ca_path.strip():
            new_tls["ca"] = ca_path.strip()
        cfg["tls"] = new_tls
        await loop.run_in_executor(None, _cfg_write, cfg)
        await loop.run_in_executor(None, _cfg_restart_service)
        self.app.audit.log("mcp.tls_configure", f"cert={cert_path}", "OK")

        msg = f"TLS configured:\n  Cert: {cert_path}\n  Key:  {key_path}"
        if ca_path.strip():
            msg += f"\n  CA:   {ca_path}"
        await self.app.push_screen_wait(ConfirmDialog(msg, "TLS Configured"))
        self._refresh_menu()

    @work(exclusive=True)
    async def _show_connection_cmd(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)
        ip = _get_ip()
        port = cfg.get("http_port", 8080)
        tls = cfg.get("tls")
        proto = "https" if tls else "http"
        tokens = cfg.get("tokens", {})
        first_token = next(iter(tokens), None)

        GRN, CYN, BLD, DIM, NC = "\033[32m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
        lines = [
            f"{BLD}{CYN}=== MCP Remote Connection ==={NC}",
            "",
            f"  {DIM}Endpoint:{NC} {proto}://{ip}:{port}/mcp",
            "",
            f"{BLD}--- Claude Code (CLI) ---{NC}",
            "",
        ]
        if first_token:
            masked = f"{first_token[:8]}...{first_token[-4:]}"
            lines.append(f"  claude mcp add \\")
            lines.append(f"    --transport http \\")
            lines.append(f'    --header "Authorization: Bearer {masked}" \\')
            lines.append(f"    xinas {proto}://{ip}:{port}/mcp")
            lines.append(f"")
            lines.append(f"  {DIM}(Replace masked token with full value from Token Management){NC}")
        else:
            lines.append(f"  claude mcp add \\")
            lines.append(f"    --transport http \\")
            lines.append(f"    xinas {proto}://{ip}:{port}/mcp")

        lines.extend([
            "",
            f"{BLD}--- curl test ---{NC}",
            "",
            f"  curl -X POST {proto}://{ip}:{port}/mcp \\",
        ])
        if first_token:
            lines.append(f'    -H "Authorization: Bearer {masked}" \\')
        lines.extend([
            '    -H "Content-Type: application/json" \\',
            """    -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test"}}}'""",
        ])

        view = self.query_one("#ra-content", ScrollableTextView)
        view.set_content("\n".join(lines))


# ── Token Management sub-screen ─────────────────────────────────────────────

class TokenManagementScreen(Screen):
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
        cfg = _cfg_read()
        tokens = cfg.get("tokens", {})
        labels = cfg.get("token_labels", {})

        items = [
            MenuItem("A", "Add Token"),
            MenuItem("R", "Remove Token"),
        ]
        if tokens:
            items.append(MenuItem("", "", separator=True))
            idx = 1
            for tv, role in tokens.items():
                name = labels.get(tv, tv[:12] + "…")
                items.append(MenuItem(str(idx), f"{name}  [{role}]", enabled=False))
                idx += 1
        items.append(MenuItem("0", "Back"))

        nav = self.query_one("#tok-nav", NavigableMenu)
        nav.update_items(items)

        # Status panel
        GRN, DIM, NC = "\033[32m", "\033[2m", "\033[0m"
        lines = [f"  {len(tokens)} token(s) configured", ""]
        for tv, role in tokens.items():
            name = labels.get(tv, tv[:12] + "…")
            lines.append(f"  {GRN}●{NC} {name}  {DIM}[{role}]{NC}")
            lines.append(f"    {DIM}{tv[:8]}…{NC}")
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
        _TOKEN_NAME_RE = re.compile(r'^[A-Za-z0-9_-]+$')

        while True:
            token_name = await self.app.push_screen_wait(
                InputDialog("Enter a name for the new token\n(e.g. remote-claude, monitoring):", "Token Name", placeholder="remote-claude")
            )
            if not token_name:
                return
            if not token_name.strip():
                self.app.notify("Token name must not be empty.", severity="error")
                continue
            token_name = token_name.strip()
            if not _TOKEN_NAME_RE.match(token_name):
                self.app.notify("Token name must be alphanumeric, dash, or underscore only.", severity="error")
                continue
            # Check duplicate name
            cfg = await loop.run_in_executor(None, _cfg_read)
            labels = cfg.get("token_labels", {})
            if token_name in labels.values():
                self.app.notify(f"Token '{token_name}' already exists. Remove it first to regenerate.", severity="error")
                continue
            break

        # Select role
        role_key = await self.app.push_screen_wait(
            _RoleSelectDialog()
        )
        if not role_key:
            return

        # Generate token
        token_value = secrets.token_hex(32)

        # Save atomically
        cfg.setdefault("tokens", {})[token_value] = role_key
        cfg.setdefault("token_labels", {})[token_value] = token_name
        await loop.run_in_executor(None, _cfg_write, cfg)
        await loop.run_in_executor(None, _cfg_restart_service)
        self.app.audit.log("mcp.token_add", f"{token_name} ({role_key})", "OK")

        await self.app.push_screen_wait(
            ConfirmDialog(
                f"Name:  {token_name}\n"
                f"Role:  {role_key}\n\n"
                f"Token (copy now — shown once):\n\n"
                f"{token_value}\n\n"
                f"Use as Bearer token in Authorization header.",
                "Token Created",
            )
        )
        self._refresh()

    @work(exclusive=True)
    async def _remove_token(self) -> None:
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, _cfg_read)
        tokens = cfg.get("tokens", {})
        labels = cfg.get("token_labels", {})

        if not tokens:
            await self.app.push_screen_wait(ConfirmDialog("No tokens to remove.", "No Tokens"))
            return

        # Build selection menu
        items: list[MenuItem] = []
        token_keys: list[str] = []
        for idx, (tv, role) in enumerate(tokens.items(), 1):
            name = labels.get(tv, tv[:12] + "…")
            items.append(MenuItem(str(idx), f"{name}  [{role}]"))
            token_keys.append(tv)
        items.append(MenuItem("0", "Cancel"))

        sel = await self.app.push_screen_wait(_SelectionDialog("Select token to remove:", items))
        if not sel or sel == "0":
            return

        rm_idx = int(sel) - 1
        if rm_idx < 0 or rm_idx >= len(token_keys):
            return
        rm_key = token_keys[rm_idx]
        rm_label = labels.get(rm_key, rm_key[:12] + "…")

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Remove token '{rm_label}'?", "Confirm Remove")
        )
        if not confirmed:
            return

        tokens.pop(rm_key, None)
        labels.pop(rm_key, None)
        cfg["tokens"] = tokens
        cfg["token_labels"] = labels
        await loop.run_in_executor(None, _cfg_write, cfg)
        await loop.run_in_executor(None, _cfg_restart_service)
        self.app.audit.log("mcp.token_remove", rm_label, "OK")
        await self.app.push_screen_wait(ConfirmDialog(f"Token '{rm_label}' removed.", "Removed"))
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

class SSHAccessScreen(Screen):
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
            keys = [l for l in ak.read_text().splitlines() if l.strip() and not l.startswith("#")]
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
        if ok:
            self.app.audit.log("ssh.root_enable", "", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Root SSH enabled.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))
        await self._show_status()

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
            await self.app.push_screen_wait(ConfirmDialog(str(exc), "Error"))
        await self._show_status()

    @work(exclusive=True)
    async def _add_key(self) -> None:
        while True:
            key = await self.app.push_screen_wait(
                InputDialog("Paste public key:", "Add Authorized Key", placeholder="ssh-rsa AAAA... user@host")
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
            await self.app.push_screen_wait(ConfirmDialog("Key added.", "Done"))
        except Exception as exc:
            await self.app.push_screen_wait(ConfirmDialog(str(exc), "Error"))
        await self._show_status()


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
