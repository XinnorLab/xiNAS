"""NFSScreen — NFS export management with 5-step share wizard."""
from __future__ import annotations

import asyncio
from typing import Any

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
    MenuItem("1", "Show NFS Exports"),
    MenuItem("2", "Add Share"),
    MenuItem("3", "Edit Share"),
    MenuItem("4", "Remove Share"),
    MenuItem("5", "Active Sessions"),
    MenuItem("6", "Configure idmapd Domain"),
    MenuItem("0", "Back"),
]


class NFSScreen(Screen):
    """NFS access rights management."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── NFS Access Rights ──", id="screen-title")
        yield NavigableMenu(_MENU, id="nfs-nav")
        yield ScrollableTextView(id="nfs-content")
        yield Footer()

    def on_mount(self) -> None:
        asyncio.create_task(self._load_exports())

    async def _load_exports(self) -> None:
        loop = asyncio.get_event_loop()
        ok, data, err = await loop.run_in_executor(None, self.app.nfs.list_exports)
        view = self.query_one("#nfs-content", ScrollableTextView)
        if ok:
            view.set_content(_format_exports(data))
        else:
            view.set_content(f"[yellow]NFS helper: {err}[/yellow]")

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._load_exports())
        elif key == "2":
            asyncio.create_task(self._add_share_wizard())
        elif key == "3":
            asyncio.create_task(self._edit_share())
        elif key == "4":
            asyncio.create_task(self._remove_share())
        elif key == "5":
            asyncio.create_task(self._show_sessions())
        elif key == "6":
            asyncio.create_task(self._configure_idmapd())

    # ── Wizard: Add Share (5 steps) ─────────────────────────────────────────

    async def _add_share_wizard(self) -> None:
        """5-step share creation wizard."""
        # Step 1: Export path
        path = await self.app.push_screen_wait(
            InputDialog("Export path (e.g. /mnt/data/share1):", "Add Share — Step 1/5",
                        placeholder="/mnt/data/")
        )
        if not path:
            return

        # Step 2: Client spec
        clients = await self.app.push_screen_wait(
            InputDialog("Client spec (e.g. 192.168.1.0/24 or *):", "Add Share — Step 2/5",
                        default="*")
        )
        if clients is None:
            return

        # Step 3: Access mode
        access = await self.app.push_screen_wait(
            InputDialog("Access mode (rw / ro):", "Add Share — Step 3/5", default="rw")
        )
        if access is None:
            return

        # Step 4: Extra NFS options
        extra_opts = await self.app.push_screen_wait(
            InputDialog(
                "Extra NFS options (comma-separated, leave blank for defaults):",
                "Add Share — Step 4/5",
                default="sync,no_subtree_check,no_root_squash",
            )
        )
        if extra_opts is None:
            return

        # Step 5: Confirm
        options = [o.strip() for o in (access + "," + extra_opts).split(",") if o.strip()]
        summary = (
            f"Path:    {path}\n"
            f"Clients: {clients}\n"
            f"Options: {','.join(options)}"
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Create this export?\n\n{summary}", "Add Share — Step 5/5")
        )
        if not confirmed:
            return

        loop = asyncio.get_event_loop()
        ok, _, err = await loop.run_in_executor(
            None,
            lambda: self.app.nfs.add_export(
                {"path": path, "clients": [clients], "options": options}
            ),
        )
        if ok:
            self.app.audit.log("nfs.add_export", path, "OK")
            await self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _edit_share(self) -> None:
        path = await self.app.push_screen_wait(
            InputDialog("Export path to edit:", "Edit Share")
        )
        if not path:
            return
        new_clients = await self.app.push_screen_wait(
            InputDialog("New client spec (leave blank to keep):", "Edit Share — Clients")
        )
        new_opts = await self.app.push_screen_wait(
            InputDialog("New options (leave blank to keep):", "Edit Share — Options")
        )
        patch: dict = {}
        if new_clients:
            patch["clients"] = [new_clients]
        if new_opts:
            patch["options"] = [o.strip() for o in new_opts.split(",") if o.strip()]
        if not patch:
            return

        loop = asyncio.get_event_loop()
        ok, _, err = await loop.run_in_executor(
            None, lambda: self.app.nfs.update_export(path, patch)
        )
        if ok:
            self.app.audit.log("nfs.update_export", path, "OK")
            await self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _remove_share(self) -> None:
        path = await self.app.push_screen_wait(
            InputDialog("Export path to remove:", "Remove Share")
        )
        if not path:
            return
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Remove export {path}?", "Confirm Removal")
        )
        if not confirmed:
            return
        loop = asyncio.get_event_loop()
        ok, _, err = await loop.run_in_executor(
            None, lambda: self.app.nfs.remove_export(path)
        )
        if ok:
            self.app.audit.log("nfs.remove_export", path, "OK")
            await self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _show_sessions(self) -> None:
        loop = asyncio.get_event_loop()
        ok, data, err = await loop.run_in_executor(None, self.app.nfs.list_sessions)
        view = self.query_one("#nfs-content", ScrollableTextView)
        if ok:
            view.set_content(_format_sessions(data))
        else:
            view.set_content(f"[red]{err}[/red]")

    async def _configure_idmapd(self) -> None:
        domain = await self.app.push_screen_wait(
            InputDialog("NFS4 idmapd domain:", "Configure idmapd Domain",
                        placeholder="example.com")
        )
        if not domain:
            return
        from xinas_menu.utils.subprocess_utils import run_cmd
        loop = asyncio.get_event_loop()

        def _set_domain():
            import re
            cfg = "/etc/idmapd.conf"
            try:
                with open(cfg) as f:
                    text = f.read()
                text = re.sub(r"^(Domain\s*=\s*).*$", f"\\1{domain}", text, flags=re.M)
                with open(cfg, "w") as f:
                    f.write(text)
                return True, ""
            except Exception as exc:
                return False, str(exc)

        ok, err = await loop.run_in_executor(None, _set_domain)
        if ok:
            self.app.audit.log("nfs.idmapd_domain", domain, "OK")
            await self.app.push_screen_wait(ConfirmDialog("idmapd domain updated.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))


def _format_exports(data: Any) -> str:
    lines = ["[bold]NFS Exports[/bold]\n"]
    try:
        exports = data or []
        if not exports:
            lines.append("  (no exports configured)")
        for exp in exports:
            path = exp.get("path", "?")
            clients = exp.get("clients", [])
            options = exp.get("options", [])
            lines.append(f"  [cyan]{path}[/cyan]")
            for c in clients:
                lines.append(f"      {c}  ({','.join(options)})")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)


def _format_sessions(data: Any) -> str:
    lines = ["[bold]Active NFS Sessions[/bold]\n"]
    try:
        sessions = data or []
        if not sessions:
            lines.append("  (no active sessions)")
        for s in sessions:
            client = s.get("client", "?")
            path = s.get("path", "?")
            lines.append(f"  {client}  →  {path}")
    except Exception as exc:
        lines.append(f"[dim](parse error: {exc})[/dim]")
    return "\n".join(lines)
