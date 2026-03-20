"""NFSScreen — NFS export management with structured share wizards."""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

_log = logging.getLogger(__name__)

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
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
            yield ScrollableTextView(
                "\033[1m\033[36mNFS Access Rights\033[0m\n"
                "\n"
                "  \033[1m1\033[0m  \033[36mShow Exports\033[0m      \033[2mList all NFS exports with options\033[0m\n"
                "  \033[1m2\033[0m  \033[36mAdd Share\033[0m         \033[2mCreate a new NFS export (wizard)\033[0m\n"
                "  \033[1m3\033[0m  \033[36mEdit Share\033[0m        \033[2mModify an existing export\033[0m\n"
                "  \033[1m4\033[0m  \033[36mRemove Share\033[0m      \033[2mDelete an NFS export\033[0m\n"
                "  \033[1m5\033[0m  \033[36mActive Sessions\033[0m   \033[2mView connected NFS clients\033[0m\n"
                "  \033[1m6\033[0m  \033[36mConfigure idmapd\033[0m  \033[2mSet NFS4 ID mapping domain\033[0m\n",
                id="nfs-content",
            )
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

    async def _get_export_paths(self) -> list[str]:
        """Fetch current export paths from the NFS helper."""
        exports = await self._get_exports()
        return [e["path"] for e in exports]

    async def _get_exports(self) -> list[dict]:
        """Fetch full export entries from the NFS helper."""
        loop = asyncio.get_running_loop()
        ok, data, _ = await loop.run_in_executor(None, self.app.nfs.list_exports)
        if not ok or not isinstance(data, list):
            return []
        return [e for e in data if isinstance(e, dict) and e.get("path")]

    # ── Shared access-control wizard (4 steps) ─────────────────────────────

    async def _access_wizard(
        self,
        title_prefix: str,
        step_offset: int,
        total_steps: int,
        current: dict | None = None,
    ) -> dict | None:
        """Run 5 structured access-control steps.

        Returns ``{"host", "access", "root_squash", "sync_mode", "sec"}``
        or *None* if the user cancelled at any step.
        """
        cur = current or {}

        # ── Step: Who Can Access? ────────────────────────────────────────
        step = step_offset
        cur_host = cur.get("host", "*")
        if cur_host == "*":
            cur_hint = "Everyone"
        elif "/" in cur_host:
            cur_hint = f"Network {cur_host}"
        else:
            cur_hint = f"Host {cur_host}"
        prompt = "Who should be able to connect?"
        if current:
            prompt += f"\n(Current: {cur_hint})"

        who = await self.app.push_screen_wait(
            SelectDialog(
                [
                    "Everyone (any host on the network)",
                    "Specific network (e.g., 192.168.1.0/24)",
                    "Single host (by IP address)",
                ],
                title=f"{title_prefix} — Step {step}/{total_steps}",
                prompt=prompt,
            )
        )
        if who is None:
            return None

        if who.startswith("Everyone"):
            host = "*"
        elif who.startswith("Specific"):
            host = await self.app.push_screen_wait(
                InputDialog(
                    "Network address:",
                    f"{title_prefix} — Step {step}/{total_steps}",
                    default=cur_host if "/" in cur_host else "192.168.1.0/24",
                    placeholder="192.168.1.0/24",
                )
            )
            if not host:
                return None
        else:
            host = await self.app.push_screen_wait(
                InputDialog(
                    "Host IP address:",
                    f"{title_prefix} — Step {step}/{total_steps}",
                    default=cur_host if cur_host != "*" and "/" not in cur_host else "",
                    placeholder="192.168.1.100",
                )
            )
            if not host:
                return None

        # ── Step: Access Permissions ─────────────────────────────────────
        step = step_offset + 1
        cur_access = cur.get("access", "rw")
        prompt = "What can connected hosts do?"
        if current:
            label = "Read & Write" if cur_access == "rw" else "Read Only"
            prompt += f"\n(Current: {label})"

        access_choice = await self.app.push_screen_wait(
            SelectDialog(
                [
                    "Read & Write (can add, edit, delete files)",
                    "Read Only (can only view files)",
                ],
                title=f"{title_prefix} — Step {step}/{total_steps}",
                prompt=prompt,
            )
        )
        if access_choice is None:
            return None
        access = "rw" if access_choice.startswith("Read & Write") else "ro"

        # ── Step: Admin Access ───────────────────────────────────────────
        step = step_offset + 2
        cur_root = cur.get("root_squash", "no_root_squash")
        prompt = "Allow full administrator access?"
        if current:
            label = "Yes" if cur_root == "no_root_squash" else "No"
            prompt += f"\n(Current: {label})"

        admin_choice = await self.app.push_screen_wait(
            SelectDialog(
                [
                    "Yes - Full admin access (recommended)",
                    "No - Limited access (more secure)",
                ],
                title=f"{title_prefix} — Step {step}/{total_steps}",
                prompt=prompt,
            )
        )
        if admin_choice is None:
            return None
        root_squash = "no_root_squash" if admin_choice.startswith("Yes") else "root_squash"

        # ── Step: Sync Mode ──────────────────────────────────────────────
        step = step_offset + 3
        cur_sync = cur.get("sync_mode", "sync")
        prompt = "When should the server confirm writes?"
        if current:
            label = "Sync (safer)" if cur_sync == "sync" else "Async (faster)"
            prompt += f"\n(Current: {label})"

        sync_choice = await self.app.push_screen_wait(
            SelectDialog(
                [
                    "Sync - confirm after writing to disk (safer, recommended)",
                    "Async - confirm immediately (faster, risk of data loss on crash)",
                ],
                title=f"{title_prefix} — Step {step}/{total_steps}",
                prompt=prompt,
            )
        )
        if sync_choice is None:
            return None
        sync_mode = "sync" if sync_choice.startswith("Sync") else "async"

        # ── Step: Security Mode ──────────────────────────────────────────
        step = step_offset + 4
        cur_sec = cur.get("sec", "sys")
        sec_labels = {
            "sys": "Standard UID/GID",
            "krb5": "Kerberos",
            "krb5i": "Kerberos + integrity",
            "krb5p": "Kerberos + encryption",
        }
        prompt = "Select authentication mode:"
        if current:
            prompt += f"\n(Current: {sec_labels.get(cur_sec, cur_sec)})"

        sec_choice = await self.app.push_screen_wait(
            SelectDialog(
                [
                    "Standard UID/GID (default)",
                    "Kerberos authentication",
                    "Kerberos + integrity",
                    "Kerberos + encryption",
                ],
                title=f"{title_prefix} — Step {step}/{total_steps}",
                prompt=prompt,
            )
        )
        if sec_choice is None:
            return None
        sec_map = {
            "Standard": "sys",
            "Kerberos authentication": "krb5",
            "Kerberos + integrity": "krb5i",
            "Kerberos + encryption": "krb5p",
        }
        sec = "sys"
        for key, val in sec_map.items():
            if sec_choice.startswith(key):
                sec = val
                break

        return {"host": host, "access": access, "root_squash": root_squash,
                "sync_mode": sync_mode, "sec": sec}

    # ── Wizard: Add Share ────────────────────────────────────────────────

    @work(exclusive=True)
    async def _add_share_wizard(self) -> None:
        """6-step share creation wizard."""
        # Step 1: Export path — list mounted XFS filesystems + custom option
        from xinas_menu.utils.xfs_helpers import run_async_cmd

        mount_points: list[str] = []
        ok, out, _ = await run_async_cmd("findmnt", "-t", "xfs", "-n", "-o", "TARGET", timeout=10)
        if ok and out:
            mount_points = [line.strip() for line in out.splitlines() if line.strip()]

        _CUSTOM = "Custom path…"
        if mount_points:
            choices = mount_points + [_CUSTOM]
            choice = await self.app.push_screen_wait(
                SelectDialog(
                    choices,
                    title="Add Share — Step 1/7",
                    prompt="Select filesystem to export (or choose custom for a subfolder):",
                )
            )
            if not choice:
                return
            if choice == _CUSTOM:
                path = await self.app.push_screen_wait(
                    InputDialog("Export path:", "Add Share — Step 1/7",
                                default="/mnt/data/", placeholder="/mnt/data/share1")
                )
                if not path:
                    return
            else:
                path = choice
        else:
            path = await self.app.push_screen_wait(
                InputDialog("Export path:", "Add Share — Step 1/7",
                            default="/mnt/data/", placeholder="/mnt/data/share1")
            )
            if not path:
                return

        if not path.startswith("/"):
            self.app.notify("Export path must start with '/'.", severity="error")
            return

        # Steps 2-6: Access control wizard (who / permissions / admin / sync / security)
        result = await self._access_wizard("Add Share", step_offset=2, total_steps=7)
        if result is None:
            return

        # Step 7: Confirm
        host = result["host"]
        access = result["access"]
        root_squash = result["root_squash"]
        sync_mode = result["sync_mode"]
        sec = result["sec"]
        options = [access, sync_mode, "no_subtree_check", root_squash]
        if sec != "sys":
            options.append(f"sec={sec}")

        access_label = "Read & Write" if access == "rw" else "Read Only"
        admin_label = "Yes (no_root_squash)" if root_squash == "no_root_squash" else "No (root_squash)"
        sync_label = "Sync (safer)" if sync_mode == "sync" else "Async (faster)"
        sec_labels = {"sys": "Standard UID/GID", "krb5": "Kerberos",
                      "krb5i": "Kerberos + integrity", "krb5p": "Kerberos + encryption"}
        summary = (
            f"Path:       {path}\n"
            f"Access:     {host}\n"
            f"Permission: {access_label}\n"
            f"Admin:      {admin_label}\n"
            f"Sync:       {sync_label}\n"
            f"Security:   {sec_labels.get(sec, sec)}\n"
            f"Options:    {','.join(options)}"
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Create this export?\n\n{summary}", "Add Share — Step 7/7")
        )
        if not confirmed:
            return

        # Ensure export directory exists
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, lambda: os.makedirs(path, exist_ok=True))
        except OSError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Cannot create directory:\n{exc}", "Error")
            )
            return

        ok, _, err = await loop.run_in_executor(
            None,
            lambda: self.app.nfs.add_export(
                {"path": path, "clients": [{"host": host, "options": options}]}
            ),
        )
        if ok:
            self.app.audit.log("nfs.add_export", path, "OK")
            await self.app.snapshots.record(
                "share_create", diff_summary=f"Added NFS share {path}",
            )
            self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    @work(exclusive=True)
    async def _edit_share(self) -> None:
        """6-step edit share wizard with structured access control."""
        # Step 1: Select export to edit
        exports = await self._get_exports()
        if not exports:
            await self.app.push_screen_wait(
                ConfirmDialog("No shares configured.", "Edit Share"))
            return
        paths = [e["path"] for e in exports]
        path = await self.app.push_screen_wait(
            SelectDialog(paths, title="Edit Share — Step 1/7",
                         prompt="Select export to edit:")
        )
        if not path:
            return

        # Parse current values for pre-population
        export = next((e for e in exports if e["path"] == path), {})
        current = _parse_current_export(export)

        # Steps 2-6: Access control wizard with current values shown
        result = await self._access_wizard(
            "Edit Share", step_offset=2, total_steps=7, current=current,
        )
        if result is None:
            return

        # Step 7: Confirm
        host = result["host"]
        access = result["access"]
        root_squash = result["root_squash"]
        sync_mode = result["sync_mode"]
        sec = result["sec"]

        # Assemble options: wizard-managed + preserved extras from original
        options = [access, sync_mode, root_squash]
        if sec != "sys":
            options.append(f"sec={sec}")
        options.extend(current["extra_opts"])

        access_label = "Read & Write" if access == "rw" else "Read Only"
        admin_label = "Yes (no_root_squash)" if root_squash == "no_root_squash" else "No (root_squash)"
        sync_label = "Sync (safer)" if sync_mode == "sync" else "Async (faster)"
        sec_labels = {"sys": "Standard UID/GID", "krb5": "Kerberos",
                      "krb5i": "Kerberos + integrity", "krb5p": "Kerberos + encryption"}
        summary = (
            f"Path:       {path}\n"
            f"Access:     {host}\n"
            f"Permission: {access_label}\n"
            f"Admin:      {admin_label}\n"
            f"Sync:       {sync_label}\n"
            f"Security:   {sec_labels.get(sec, sec)}\n"
            f"Options:    {','.join(options)}"
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Update this export?\n\n{summary}", "Edit Share — Step 7/7")
        )
        if not confirmed:
            return

        patch = {"clients": [{"host": host, "options": options}]}
        loop = asyncio.get_running_loop()
        ok, _, err = await loop.run_in_executor(
            None, lambda: self.app.nfs.update_export(path, patch)
        )
        if ok:
            self.app.audit.log("nfs.update_export", path, "OK")
            await self.app.snapshots.record(
                "share_modify", diff_summary=f"Updated NFS share {path}",
            )
            self._load_exports()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    @work(exclusive=True)
    async def _remove_share(self) -> None:
        paths = await self._get_export_paths()
        if not paths:
            await self.app.push_screen_wait(
                ConfirmDialog("No shares configured.", "Remove Share"))
            return
        path = await self.app.push_screen_wait(
            SelectDialog(paths, title="Remove Share", prompt="Select export to remove:")
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
            await self.app.snapshots.record(
                "share_delete", diff_summary=f"Removed NFS share {path}",
            )
            self._load_exports()
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
        while True:
            domain = await self.app.push_screen_wait(
                InputDialog("NFS4 idmapd domain:", "Configure idmapd Domain",
                            placeholder="example.com")
            )
            if domain is None:
                return
            domain = domain.strip()
            if domain and "." in domain:
                break
            self.app.notify(
                "Domain must not be empty and must contain at least one '.' (e.g. example.com).",
                severity="error",
            )
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
            await self.app.snapshots.record(
                "nfs_modify", diff_summary=f"Set idmapd domain to {domain}",
            )
            await self.app.push_screen_wait(ConfirmDialog("idmapd domain updated.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))


_WIZARD_MANAGED_OPTS = {"rw", "ro", "root_squash", "no_root_squash", "sync", "async"}


def _parse_current_export(export: dict) -> dict:
    """Extract structured wizard values from an export dict."""
    clients = export.get("clients", [])
    if not clients:
        return {"host": "*", "access": "rw", "root_squash": "no_root_squash",
                "sync_mode": "sync", "sec": "sys", "extra_opts": []}
    client = clients[0] if isinstance(clients[0], dict) else {}
    host = client.get("host", "*") if client else "*"
    opts = client.get("options", []) if client else []

    access = "ro" if "ro" in opts else "rw"
    root_squash = "root_squash" if ("root_squash" in opts and "no_root_squash" not in opts) else "no_root_squash"
    sync_mode = "async" if "async" in opts else "sync"
    sec = "sys"
    extra: list[str] = []
    for o in opts:
        if o.startswith("sec="):
            sec = o.split("=", 1)[1]
        elif o not in _WIZARD_MANAGED_OPTS:
            extra.append(o)
    return {"host": host, "access": access, "root_squash": root_squash,
            "sync_mode": sync_mode, "sec": sec, "extra_opts": extra}


def _format_exports(data: Any) -> str:
    """Format NFS exports — uses socket data if available, falls back to /etc/exports."""
    import os
    import shlex
    import subprocess

    GRN, YLW, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
    W = 65
    lines: list[str] = []

    def _run(cmd: str) -> str:
        try:
            return subprocess.check_output(
                shlex.split(cmd), stderr=subprocess.DEVNULL, text=True,
            ).strip()
        except Exception:
            _log.debug("command failed: %s", cmd, exc_info=True)
            return ""

    def _share_usage(path: str) -> str:
        try:
            r = subprocess.run(
                ["df", "-h", path], capture_output=True, text=True,
            )
            if r.returncode == 0 and r.stdout:
                lines = r.stdout.strip().splitlines()
                if len(lines) >= 2:
                    p = lines[-1].split()
                    if len(p) >= 5:
                        return f"{p[2]} used of {p[1]} ({p[4]})"
        except Exception:
            _log.debug("df failed for %s", path, exc_info=True)
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
            if not path:
                continue
            # clients may be [{"host": "*", "options": [...]}] or ["host(opts)"]
            raw: list[str] = []
            for c in (clients or [{"host": "*", "options": []}]):
                if isinstance(c, dict):
                    host = c.get("host", "*")
                    opts = c.get("options", [])
                    raw.append(f"{host}({','.join(opts)})" if opts else host)
                else:
                    raw.append(str(c))
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
                    _log.debug("failed to read NFS client info %s", entry, exc_info=True)
    if not clients:
        try:
            result = subprocess.run(
                ["ss", "-tn", "state", "established", "( dport = :2049 )"],
                capture_output=True, text=True,
            ).stdout.strip()
        except Exception:
            _log.debug("ss command failed for NFS session check", exc_info=True)
            result = ""
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
