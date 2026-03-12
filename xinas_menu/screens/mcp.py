"""MCPScreen — MCP server management + SSH access sub-screen."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label
from textual.widgets import Footer

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
        yield Label("  ── MCP Server ──", id="screen-title")
        yield NavigableMenu(_MENU, id="mcp-nav")
        yield ScrollableTextView(id="mcp-content")
        yield Footer()

    def on_mount(self) -> None:
        asyncio.create_task(self._show_status())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._toggle_nfs_helper())
        elif key == "2":
            asyncio.create_task(self._restart())
        elif key == "3":
            asyncio.create_task(self._show_status())
        elif key == "4":
            self.app.push_screen(SSHAccessScreen())
        elif key == "5":
            asyncio.create_task(self._view_config())
        elif key == "6":
            asyncio.create_task(self._view_audit())
        elif key == "7":
            asyncio.create_task(self._view_nfs_logs())
        elif key == "8":
            asyncio.create_task(self._check_updates())

    async def _toggle_nfs_helper(self) -> None:
        from xinas_menu.utils.service_ctl import ServiceController
        loop = asyncio.get_event_loop()
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

    async def _show_status(self) -> None:
        from xinas_menu.utils.service_ctl import ServiceController
        loop = asyncio.get_event_loop()
        ctl = ServiceController()

        mcp_dist = Path("/opt/xiNAS/xiNAS-MCP/dist/index.js")
        nfs_sock = Path("/run/xinas-nfs-helper.sock")
        mcp_cfg = _MCP_CONFIG

        nfs_state = await loop.run_in_executor(None, lambda: ctl.state("xinas-nfs-helper"))

        lines = ["=== MCP Server Status ===", ""]
        if mcp_dist.exists():
            lines.append(f"  *  MCP server    Ready (stdio)")
            lines.append(f"     Binary:       {mcp_dist}")
        else:
            lines.append("  !  MCP server    NOT BUILT")
            lines.append("     Run: cd /opt/xiNAS/xiNAS-MCP && npm run build")
        lines.append("")

        nfs_icon = "*" if nfs_state.is_active else "!"
        lines.append(f"  {nfs_icon}  NFS Helper    {nfs_state.active}")
        lines.append(f"     Socket:       {nfs_sock}  ({'OK' if nfs_sock.exists() else 'missing'})")
        lines.append("")

        if mcp_cfg.exists():
            lines.append(f"  *  Config        {mcp_cfg}")
            try:
                import json
                d = json.loads(mcp_cfg.read_text())
                cid = d.get("controller_id", "")
                lines.append(f"     Controller:   {(cid[:20] + '...') if len(cid) > 20 else cid or '(not set)'}")
            except Exception:
                pass
        else:
            lines.append(f"  !  Config        Missing: {mcp_cfg}")
        lines.append("")

        ak = Path("/root/.ssh/authorized_keys")
        if ak.exists():
            try:
                n = sum(1 for l in ak.read_text().splitlines() if l.startswith("ssh-"))
            except Exception:
                n = 0
            lines.append(f"  SSH keys for root: {n} key(s) in {ak}")
        else:
            lines.append("  SSH keys for root: none (authorized_keys missing)")
            import socket as _sock
            try:
                ip = _sock.gethostbyname(_sock.gethostname())
            except Exception:
                ip = "10.10.1.1"
            lines.append(f"     Add with: ssh-copy-id root@{ip}")
        lines.append("")

        claude_cfg = Path("/root/.claude/mcp_servers.json")
        if claude_cfg.exists():
            lines.append(f"  *  Claude Code   {claude_cfg}")
        else:
            lines.append("  [ ] Claude Code   Not configured locally")
            try:
                import socket as _sock
                ip = _sock.gethostbyname(_sock.gethostname())
            except Exception:
                ip = "10.10.1.1"
            lines.append(f"     Register with:")
            lines.append(f"       claude mcp add --transport stdio xinas -- ssh -T root@{ip} xinas-mcp")

        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content("\n".join(lines))

    async def _restart(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Restart xinas-mcp and xinas-nfs-helper?", "Confirm")
        )
        if not confirmed:
            return
        from xinas_menu.utils.service_ctl import ServiceController
        loop = asyncio.get_event_loop()
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

    async def _view_config(self) -> None:
        view = self.query_one("#mcp-content", ScrollableTextView)
        try:
            text = _MCP_CONFIG.read_text()
            view.set_content(f"[bold]{_MCP_CONFIG}[/bold]\n\n{text}")
        except FileNotFoundError:
            view.set_content("[dim]MCP config not found.[/dim]")
        except Exception as exc:
            view.set_content(f"[red]{exc}[/red]")

    async def _view_audit(self) -> None:
        view = self.query_one("#mcp-content", ScrollableTextView)
        try:
            lines = _MCP_AUDIT.read_text().splitlines()[-200:]
            view.set_content("\n".join(lines) or "[dim]Audit log is empty.[/dim]")
        except FileNotFoundError:
            view.set_content("[dim]MCP audit log not found.[/dim]")
        except Exception as exc:
            view.set_content(f"[red]{exc}[/red]")

    async def _view_nfs_logs(self) -> None:
        loop = asyncio.get_event_loop()
        r = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["journalctl", "-n", "200", "--no-pager", "-u", "xinas-nfs-helper"],
                capture_output=True, text=True,
            )
        )
        view = self.query_one("#mcp-content", ScrollableTextView)
        view.set_content(r.stdout or "[dim]No NFS helper log entries.[/dim]")

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
        yield Label("  ── SSH Access Settings ──")
        yield NavigableMenu(self._MENU, id="ssh-nav")
        yield ScrollableTextView(id="ssh-content")
        yield Footer()

    def on_mount(self) -> None:
        asyncio.create_task(self._show_status())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._show_status())
        elif key == "2":
            asyncio.create_task(self._enable_root_ssh())
        elif key == "3":
            asyncio.create_task(self._disable_root_ssh())
        elif key == "4":
            asyncio.create_task(self._add_key())

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

    async def _enable_root_ssh(self) -> None:
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("Enable key-based root SSH login?", "Confirm")
        )
        if not confirmed:
            return
        loop = asyncio.get_event_loop()
        ok, err = await loop.run_in_executor(None, _enable_root_ssh_sync)
        if ok:
            self.app.audit.log("ssh.root_enable", "", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Root SSH enabled.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))
        await self._show_status()

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
