"""NFSScreen — NFS export management with 5-step share wizard."""
from __future__ import annotations

import asyncio
from typing import Any

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
        yield Label("  NFS Access Rights", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="nfs-nav")
            yield ScrollableTextView(id="nfs-content")
        yield Footer()

    def on_mount(self) -> None:
        self._load_exports()

    @work(exclusive=True)
    async def _load_exports(self) -> None:
        loop = asyncio.get_running_loop()
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
            self._load_exports()
        elif key == "2":
            self._add_share_wizard()
        elif key == "3":
            self._edit_share()
        elif key == "4":
            self._remove_share()
        elif key == "5":
            self._show_sessions()
        elif key == "6":
            self._configure_idmapd()

    # ── Wizard: Add Share (5 steps) ─────────────────────────────────────────

    @work(exclusive=True)
    async def _add_share_wizard(self) -> None:
        """5-step share creation wizard."""
        # Step 1: Export path
        path = await self.app.push_screen_wait(
            InputDialog("Export path (e.g. /mnt/data/share1):", "Add Share — Step 1/5",
                        default="/mnt/data/")
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

        loop = asyncio.get_running_loop()
        ok, _, err = await loop.run_in_executor(
            None,
            lambda: self.app.nfs.add_export(
                {"path": path, "clients": [{"host": clients, "options": options}]}
            ),
        )
        if ok:
            self.app.audit.log("nfs.add_export", path, "OK")
            await self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    @work(exclusive=True)
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
        if not new_clients and not new_opts:
            return
        opts = [o.strip() for o in new_opts.split(",") if o.strip()] if new_opts else []
        patch: dict = {}
        if new_clients or opts:
            # Build proper client structure; when only one field is given,
            # use sensible defaults for the other.
            host = new_clients or "*"
            patch["clients"] = [{"host": host, "options": opts}]

        loop = asyncio.get_running_loop()
        ok, _, err = await loop.run_in_executor(
            None, lambda: self.app.nfs.update_export(path, patch)
        )
        if ok:
            self.app.audit.log("nfs.update_export", path, "OK")
            await self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    @work(exclusive=True)
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
        loop = asyncio.get_running_loop()
        ok, _, err = await loop.run_in_executor(
            None, lambda: self.app.nfs.remove_export(path)
        )
        if ok:
            self.app.audit.log("nfs.remove_export", path, "OK")
            await self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    @work(exclusive=True)
    async def _show_sessions(self) -> None:
        loop = asyncio.get_running_loop()
        ok, data, err = await loop.run_in_executor(None, self.app.nfs.list_sessions)
        view = self.query_one("#nfs-content", ScrollableTextView)
        if ok:
            view.set_content(_format_sessions(data))
        else:
            view.set_content(f"[red]{err}[/red]")

    @work(exclusive=True)
    async def _configure_idmapd(self) -> None:
        domain = await self.app.push_screen_wait(
            InputDialog("NFS4 idmapd domain:", "Configure idmapd Domain",
                        placeholder="example.com")
        )
        if not domain:
            return
        from xinas_menu.utils.subprocess_utils import run_cmd
        loop = asyncio.get_running_loop()

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
    """Format NFS exports — uses socket data if available, falls back to /etc/exports."""
    import os
    import subprocess

    GRN, YLW, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
    W = 65
    lines: list[str] = []

    def _run(cmd: str) -> str:
        try:
            return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL,
                                           text=True).strip()
        except Exception:
            return ""

    def _share_usage(path: str) -> str:
        try:
            r = _run(f"df -h '{path}' 2>/dev/null | tail -1")
            if r:
                p = r.split()
                if len(p) >= 5:
                    return f"{p[2]} used of {p[1]} ({p[4]})"
        except Exception:
            pass
        return "N/A"

    def _explain_client(spec: str) -> str:
        if "(" in spec:
            host, opts_raw = spec.split("(", 1)
            opts_raw = opts_raw.rstrip(")")
        else:
            host, opts_raw = spec, ""
        if host == "*":
            host_desc = "Everyone (all hosts)"
        elif "/" in host:
            host_desc = f"Network: {host}"
        else:
            host_desc = f"Host: {host}"
        opts = opts_raw.split(",") if opts_raw else []
        perms = []
        if "rw" in opts:
            perms.append("Read & Write")
        elif "ro" in opts:
            perms.append("Read Only")
        else:
            perms.append("Read & Write")
        if "no_root_squash" in opts:
            perms.append("full admin")
        return f"{host_desc}  [{', '.join(perms)}]"

    def _sec_label(opts: list[str]) -> str:
        for o in opts:
            if o.startswith("sec="):
                s = o.split("=", 1)[1]
                return {"sys": "Standard (UID/GID)", "krb5": "Kerberos",
                        "krb5i": "Kerberos+integrity", "krb5p": "Kerberos+encryption"}.get(s, s)
        return "Standard (UID/GID)"

    lines.append(f"{BLD}{CYN}NFS SHARED FOLDERS{NC}")
    lines.append(f"{DIM}{'=' * W}{NC}")
    lines.append("")
    lines.append(f"  {DIM}NFS allows other hosts to access folders on this server.{NC}")
    lines.append("")

    # Build list of (path, raw_client_strings) from socket data or /etc/exports
    shares: list[tuple[str, list[str]]] = []

    if data and isinstance(data, list):
        for exp in data:
            if not isinstance(exp, dict):
                continue
            path = exp.get("path", "")
            clients = exp.get("clients", [])
            options = exp.get("options", [])
            if path:
                # Re-assemble as client(opts) strings for unified processing
                raw = [f"*({','.join(options)})" if not clients else
                       f"{c}({','.join(options)})" for c in (clients or ["*"])]
                shares.append((path, raw))
    else:
        # Fallback: read /etc/exports directly
        exports_file = "/etc/exports"
        try:
            with open(exports_file) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split()
                    if parts:
                        shares.append((parts[0], parts[1:]))
        except FileNotFoundError:
            lines.append("  /etc/exports not found — NFS may not be configured.")
            lines.append("")
            return "\n".join(lines)
        except Exception as exc:
            lines.append(f"  Error reading /etc/exports: {exc}")
            return "\n".join(lines)

    if not shares:
        lines.append(f"  {DIM}No shares configured.{NC}")
        lines.append("")
        lines.append(f"  Use {GRN}'Add Share'{NC} to create an NFS export.")
        lines.append("")
        return "\n".join(lines)

    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append(f"  {BLD}{CYN}YOUR SHARED FOLDERS{NC}")
    lines.append(f"{DIM}{'-' * W}{NC}")
    lines.append("")

    for i, (path, raw_clients) in enumerate(shares, 1):
        exists = os.path.isdir(path)
        status = f"{GRN}[OK]{NC}" if exists else f"{RED}[!] PATH MISSING{NC}"
        lines.append(f"  {BLD}{i}.{NC} {path}  {status}")
        lines.append("")
        if exists:
            lines.append(f"     {DIM}Storage:{NC}   {_share_usage(path)}")
        else:
            lines.append(f"     {DIM}Storage:{NC}   {RED}Path does not exist!{NC}")
        all_opts = []
        for spec in raw_clients:
            if "(" in spec:
                all_opts = spec.split("(", 1)[1].rstrip(")").split(",")
                break
        lines.append(f"     {DIM}Security:{NC}  {_sec_label(all_opts)}")
        lines.append("")
        lines.append(f"     {DIM}Who can access:{NC}")
        for spec in raw_clients:
            lines.append(f"       {_explain_client(spec)}")
        lines.append("")
        lines.append(f"{DIM}{'-' * W}{NC}")

    # Connected clients
    lines.append("")
    lines.append(f"  {BLD}{CYN}CONNECTED HOSTS{NC}")
    lines.append(f"{DIM}{'-' * W}{NC}")
    clients: list[str] = []
    clients_dir = "/proc/fs/nfsd/clients"
    if os.path.isdir(clients_dir):
        for entry in os.listdir(clients_dir):
            info_file = os.path.join(clients_dir, entry, "info")
            if os.path.isfile(info_file):
                try:
                    with open(info_file) as f:
                        for ln in f:
                            if "address:" in ln:
                                raw = ln.split("address:")[1].strip().strip('"').strip("'")
                                # strip port (last :N component)
                                ip = raw.rsplit(":", 1)[0] if ":" in raw else raw
                                if ip and ip not in clients:
                                    clients.append(ip)
                except Exception:
                    pass
    if not clients:
        result = _run("ss -tn state established '( dport = :2049 )' 2>/dev/null")
        for ln in result.splitlines()[1:]:
            p = ln.split()
            if len(p) >= 4:
                ip = p[3].rsplit(":", 1)[0]
                if ip and ip not in clients:
                    clients.append(ip)
    if clients:
        for ip in clients:
            lines.append(f"  {GRN}*{NC} {ip}")
    else:
        lines.append(f"  {DIM}No hosts currently connected{NC}")
    lines.append("")
    lines.append(f"{DIM}{'=' * W}{NC}")
    return "\n".join(lines)


def _format_sessions(data: Any) -> str:
    lines = ["Active NFS Sessions\n"]
    try:
        sessions = data or []
        if not sessions:
            lines.append("  (no active sessions)")
        for s in sessions:
            client = s.get("client", "?") if isinstance(s, dict) else str(s)
            path = s.get("path", "?") if isinstance(s, dict) else ""
            lines.append(f"  {client}  ->  {path}")
    except Exception as exc:
        lines.append(f"(parse error: {exc})")
    return "\n".join(lines)
