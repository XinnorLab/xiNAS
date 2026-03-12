"""MCPScreen — MCP server management + SSH access sub-screen."""
from __future__ import annotations

import asyncio
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

_MENU = [
    MenuItem("1", "Toggle NFS Helper (Start/Stop)"),
    MenuItem("2", "Restart NFS Helper"),
    MenuItem("3", "Show MCP Status"),
    MenuItem("4", "SSH Access Settings"),
    MenuItem("5", "View MCP Config"),
    MenuItem("6", "View Audit Log"),
    MenuItem("7", "View NFS Helper Logs"),
    MenuItem("8", "Check & Install Updates"),
    MenuItem("0", "Back"),
]

_MCP_CONFIG = Path("/etc/xinas-mcp/config.json")
_MCP_AUDIT = Path("/var/log/xinas/mcp-audit.jsonl")


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

        if mcp_cfg.exists():
            lines.append(f"  {GRN}*{NC}  Config        {mcp_cfg}")
            try:
                import json
                d = json.loads(mcp_cfg.read_text())
                cid = d.get("controller_id", "")
                lines.append(f"     {DIM}Controller:{NC}   {(cid[:20] + '...') if len(cid) > 20 else cid or '(not set)'}")
            except Exception:
                pass
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
            lines.append(f"  {DIM}SSH keys for root:{NC} {YLW}none (authorized_keys missing){NC}")
            import socket as _sock
            try:
                ip = _sock.gethostbyname(_sock.gethostname())
            except Exception:
                ip = "10.10.1.1"
            lines.append(f"     {DIM}Add with:{NC} ssh-copy-id root@{ip}")
        lines.append("")

        claude_cfg = Path("/root/.claude/mcp_servers.json")
        if claude_cfg.exists():
            lines.append(f"  {GRN}*{NC}  Claude Code   {claude_cfg}")
        else:
            lines.append(f"  {DIM}[ ]{NC} Claude Code   {YLW}Not configured locally{NC}")
            try:
                import socket as _sock
                ip = _sock.gethostbyname(_sock.gethostname())
            except Exception:
                ip = "10.10.1.1"
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
        key = await self.app.push_screen_wait(
            InputDialog("Paste public key:", "Add Authorized Key")
        )
        if not key:
            return
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
