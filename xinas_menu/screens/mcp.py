"""MCPScreen — MCP server management + SSH access sub-screen."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

_MENU = [
    MenuItem("1", "Show MCP Status"),
    MenuItem("2", "Setup / Reinstall"),
    MenuItem("3", "Restart MCP Server"),
    MenuItem("4", "SSH Access Settings"),
    MenuItem("5", "View MCP Config"),
    MenuItem("6", "View Audit Log"),
    MenuItem("7", "View NFS Helper Logs"),
    MenuItem("8", "Check for MCP Updates"),
    MenuItem("0", "Back"),
]

_MCP_CONFIG = Path("/etc/xinas-mcp/config.json")
_MCP_AUDIT = Path("/var/log/xinas/mcp-audit.jsonl")


class MCPScreen(Screen):
    """MCP server management."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=False),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── MCP Server ──", id="screen-title")
        yield NavigableMenu(_MENU, id="mcp-nav")
        yield ScrollableTextView(id="mcp-content")

    def on_mount(self) -> None:
        asyncio.create_task(self._show_status())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._show_status())
        elif key == "2":
            asyncio.create_task(self._setup())
        elif key == "3":
            asyncio.create_task(self._restart())
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

    async def _show_status(self) -> None:
        from xinas_menu.utils.service_ctl import ServiceController
        loop = asyncio.get_event_loop()
        ctl = ServiceController()
        lines = ["[bold]MCP Server Status[/bold]\n"]
        for svc in ("xinas-mcp", "xinas-nfs-helper"):
            state = await loop.run_in_executor(None, lambda s=svc: ctl.state(s))
            color = "green" if state.is_active else "red"
            lines.append(f"  [{color}]●[/{color}] {svc:<30} {state.active}")
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
        Binding("escape", "app.pop_screen", "Back", show=False),
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
