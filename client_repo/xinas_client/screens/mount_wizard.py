"""MountWizardScreen -- 7-step NFS mount wizard with internal state machine."""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.confirm_dialog import ConfirmDialog
from xinas_client.widgets.input_dialog import InputDialog
from xinas_client.widgets.select_dialog import SelectDialog
from xinas_client.utils.nfs_utils import run_showmount, parse_showmount_exports
from xinas_client.utils.op_tracker import OpTracker

_log = logging.getLogger(__name__)

_IP_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")

_STEP_NAMES = {
    1: "Protocol",
    2: "Number of IPs",
    3: "IP Addresses",
    4: "Share Path",
    5: "Mount Point",
    6: "Authentication",
    7: "Persistent Mount",
}


def _menu_items_for_step(step: int) -> list[MenuItem]:
    """Build the NavigableMenu items reflecting the current wizard step."""
    items: list[MenuItem] = []
    for s in range(1, 8):
        prefix = ">" if s == step else " "
        items.append(
            MenuItem(
                str(s),
                f"{prefix} Step {s}/7: {_STEP_NAMES[s]}",
                enabled=(s == step),
            )
        )
    items.append(MenuItem("", "", separator=True))
    items.append(MenuItem("0", "Cancel"))
    return items


def _help_text_for_step(step: int) -> str:
    """Return contextual help shown in the text view for each step."""
    texts = {
        1: (
            "  [bold]Step 1: Select Protocol[/bold]\n"
            "\n"
            "  Choose the transport protocol for your NFS mount.\n"
            "\n"
            "  [bold]RDMA[/bold]  High-performance, zero-copy transport.\n"
            "        Requires DOCA OFED and InfiniBand/RoCE hardware.\n"
            "\n"
            "  [bold]TCP[/bold]   Standard transport. Works everywhere.\n"
        ),
        2: (
            "  [bold]Step 2: Number of Server IPs[/bold]\n"
            "\n"
            "  Multiple IPs enable NFS session trunking\n"
            "  for higher aggregate throughput.\n"
            "\n"
            "  Total connections are split across IPs:\n"
            "    1 IP  -> nconnect=16\n"
            "    2 IPs -> nconnect=8  per IP\n"
            "    4 IPs -> nconnect=4  per IP\n"
            "    8 IPs -> nconnect=2  per IP\n"
        ),
        3: (
            "  [bold]Step 3: Server IP Addresses[/bold]\n"
            "\n"
            "  Enter the storage-network IP(s) of your\n"
            "  xiNAS server.\n"
            "\n"
            "  Example: 10.10.1.1\n"
            "\n"
            "  For multi-IP, leave an entry empty to\n"
            "  finish early with fewer IPs.\n"
        ),
        4: (
            "  [bold]Step 4: Share Path[/bold]\n"
            "\n"
            "  The NFS export path on the server.\n"
            "\n"
            "  /           Root export (default, fsid=0)\n"
            "  /mnt/data   Specific data volume\n"
            "\n"
            "  Use / for the root export unless your\n"
            "  server has multiple named exports.\n"
        ),
        5: (
            "  [bold]Step 5: Mount Point[/bold]\n"
            "\n"
            "  Local directory where the share will\n"
            "  appear. Created automatically if needed.\n"
            "\n"
            "  Example: /mnt/nas\n"
        ),
        6: (
            "  [bold]Step 6: Authentication[/bold]\n"
            "\n"
            "  Standard (sys): UID/GID mapping, no auth.\n"
            "\n"
            "  Kerberos modes:\n"
            "    krb5   Authentication only\n"
            "    krb5i  + integrity checking\n"
            "    krb5p  + encryption (most secure)\n"
        ),
        7: (
            "  [bold]Step 7: Persistent Mount[/bold]\n"
            "\n"
            "  Add this mount to /etc/fstab so it is\n"
            "  automatically mounted on boot.\n"
            "\n"
            "  Recommended: Yes\n"
        ),
    }
    return texts.get(step, "")


class MountWizardScreen(Screen):
    """Seven-step NFS mount wizard with an internal state machine.

    Each step uses ``push_screen_wait`` with a dialog widget.  Pressing
    Escape in a dialog returns ``None`` which decrements the step
    (back-navigation).  Going below step 1 pops the screen entirely.
    """

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="Esc"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self._step: int = 1
        self._protocol: str = ""
        self._num_ips: int = 1
        self._nconnect: int = 16
        self._server_ips: list[str] = []
        self._share_path: str = ""
        self._mount_point: str = ""
        self._sec_mode: str = "sys"
        self._add_to_fstab: bool = True
        self._wizard_running: bool = False

    # ------------------------------------------------------------------
    # Compose
    # ------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Label("  Connect to NAS", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(
                _menu_items_for_step(1),
                id="wizard-nav",
            )
            yield ScrollableTextView(
                _help_text_for_step(1),
                id="wizard-content",
            )
        yield Footer()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def on_mount(self) -> None:
        self._wizard_running = True
        await self._run_wizard()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self._wizard_running = False
            self.app.pop_screen()

    def action_go_back(self) -> None:
        # Escape while no dialog is open: treat as cancel
        if self._wizard_running:
            self._wizard_running = False
        self.app.pop_screen()

    # ------------------------------------------------------------------
    # UI helpers
    # ------------------------------------------------------------------

    def _update_ui(self) -> None:
        """Sync the menu and text view to the current step."""
        try:
            nav = self.query_one("#wizard-nav", NavigableMenu)
            nav.update_items(_menu_items_for_step(self._step))
        except Exception:
            pass
        try:
            tv = self.query_one("#wizard-content", ScrollableTextView)
            tv.set_content(_help_text_for_step(self._step))
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Wizard loop
    # ------------------------------------------------------------------

    async def _run_wizard(self) -> None:
        """Drive the 7-step state machine."""
        while self._wizard_running and 1 <= self._step <= 7:
            self._update_ui()

            step_fn = {
                1: self._step_protocol,
                2: self._step_num_ips,
                3: self._step_ip_addresses,
                4: self._step_share_path,
                5: self._step_mount_point,
                6: self._step_authentication,
                7: self._step_persistent,
            }[self._step]

            result = await step_fn()

            if not self._wizard_running:
                return

            if result is None:
                self._step -= 1
                if self._step < 1:
                    self.app.pop_screen()
                    return
            else:
                self._step += 1

        if not self._wizard_running:
            return

        # -- Confirmation after all 7 steps --------------------------------
        confirmed = await self._show_confirmation()
        if not self._wizard_running:
            return

        if not confirmed:
            self._step = 7
            await self._run_wizard()
            return

        # -- Execute the mount ---------------------------------------------
        self._execute_mount()

    # ------------------------------------------------------------------
    # Step implementations
    # ------------------------------------------------------------------

    async def _step_protocol(self) -> str | None:
        result = await self.app.push_screen_wait(
            SelectDialog(
                ["RDMA", "TCP"],
                title="Step 1/7: Select Protocol",
                prompt="Choose protocol (RDMA = high performance, TCP = universal)",
            )
        )
        if result is None:
            return None

        self._protocol = result

        # Check RDMA availability when selected
        if self._protocol == "RDMA":
            from xinas_client.utils.rdma_utils import check_rdma_available

            available, desc = check_rdma_available()
            if not available:
                fallback = await self.app.push_screen_wait(
                    ConfirmDialog(
                        f"RDMA hardware not detected:\n{desc}\n\n"
                        "Continue with TCP instead?\n"
                        "(No = cancel and install DOCA OFED first)",
                        title="RDMA Not Available",
                    )
                )
                if not fallback:
                    return None
                self._protocol = "TCP"

        return self._protocol

    async def _step_num_ips(self) -> str | None:
        result = await self.app.push_screen_wait(
            SelectDialog(
                [
                    "1  -  Single IP (nconnect=16)",
                    "2  -  Two IPs with trunking (nconnect=8 each)",
                    "4  -  Four IPs with trunking (nconnect=4 each)",
                    "8  -  Eight IPs with trunking (nconnect=2 each)",
                ],
                title="Step 2/7: Number of Server IPs",
                prompt="Multiple IPs use NFS session trunking for higher throughput.",
            )
        )
        if result is None:
            return None

        # Extract the leading digit from the selected string
        self._num_ips = int(result.strip()[0])
        self._nconnect = 16 // self._num_ips
        return result

    async def _step_ip_addresses(self) -> str | None:
        self._server_ips = []

        for i in range(1, self._num_ips + 1):
            if self._num_ips == 1:
                title = "Step 3/7: Server Address"
                prompt = "Enter the IP address of your xiNAS server:"
            else:
                title = f"Step 3/7: Server Address {i} of {self._num_ips}"
                prompt = f"Enter IP address {i} of {self._num_ips}:"
                if i > 1:
                    prompt += (
                        f"\n\nLeave empty to finish with "
                        f"{len(self._server_ips)} IP(s)."
                    )

            ip_val = await self.app.push_screen_wait(
                InputDialog(
                    prompt=prompt,
                    title=title,
                    default=f"10.10.1.{i}",
                    placeholder="192.168.1.100",
                )
            )

            if ip_val is None:
                # Escape pressed -- go back
                if i == 1:
                    return None
                # If we already have at least one IP, treat Escape
                # from subsequent dialogs as "done entering IPs"
                break

            ip_val = ip_val.strip()

            # Allow skipping from 2nd IP onward (empty input = done)
            if not ip_val:
                if self._server_ips:
                    break
                else:
                    return None

            # Validate IP format
            if not _IP_RE.match(ip_val):
                await self.app.push_screen_wait(
                    ConfirmDialog(
                        f"'{ip_val}' is not a valid IP address.\n\n"
                        "Please enter an address like 10.10.1.1.",
                        title="Invalid IP",
                        ok_only=True,
                    )
                )
                return None

            self._server_ips.append(ip_val)

        if not self._server_ips:
            return None

        # Update num_ips based on actual count; keep nconnect from step 2
        self._num_ips = len(self._server_ips)
        return "ok"

    async def _step_share_path(self) -> str | None:
        import asyncio

        # Try auto-discovery via showmount
        loop = asyncio.get_running_loop()
        ip = self._server_ips[0]
        rc, out, _err = await loop.run_in_executor(None, run_showmount, ip)

        exports = parse_showmount_exports(out) if rc == 0 else []

        if exports:
            options = [f"{path}  ({clients})" if clients else path for path, clients in exports]
            options.append("Enter manually...")
            result = await self.app.push_screen_wait(
                SelectDialog(
                    options,
                    title="Step 4/7: Share Path",
                    prompt=f"Exports discovered on {ip}:",
                )
            )
            if result is None:
                return None
            if result != "Enter manually...":
                # Extract just the path (before any whitespace/parens)
                self._share_path = result.split()[0]
                return self._share_path

        # Manual fallback (showmount failed or user chose manual entry)
        result = await self.app.push_screen_wait(
            InputDialog(
                prompt=(
                    "Enter the NFS export path on the server:\n\n"
                    "  /           Root export (default, fsid=0)\n"
                    "  /mnt/data   Specific data volume"
                ),
                title="Step 4/7: Share Path",
                default="/",
                placeholder="/",
            )
        )
        if result is None:
            return None
        self._share_path = result.strip() or "/"
        return self._share_path

    async def _step_mount_point(self) -> str | None:
        if self._num_ips > 1:
            prompt = (
                f"Enter the mount directory:\n\n"
                f"All {self._num_ips} IPs will be trunked into a single mount.\n"
                f"Directory will be created if it doesn't exist."
            )
        else:
            prompt = (
                "Enter the local directory to mount the share:\n\n"
                "Directory will be created if it doesn't exist."
            )

        result = await self.app.push_screen_wait(
            InputDialog(
                prompt=prompt,
                title="Step 5/7: Mount Point",
                default="/mnt/nas",
                placeholder="/mnt/nas",
            )
        )
        if result is None:
            return None
        self._mount_point = result.strip() or "/mnt/nas"
        return self._mount_point

    async def _step_authentication(self) -> str | None:
        self._sec_mode = "sys"

        needs_krb = await self.app.push_screen_wait(
            ConfirmDialog(
                "Does your NFS server require authentication?\n\n"
                "Select Yes if your administrator has set up\n"
                "Kerberos (krb5) authentication.\n\n"
                "Select No for standard UID/GID mapping.",
                title="Step 6/7: Authentication",
            )
        )

        if needs_krb is None:
            return None

        if needs_krb:
            mode = await self.app.push_screen_wait(
                SelectDialog(
                    [
                        "krb5   -  Kerberos authentication",
                        "krb5i  -  Kerberos + integrity checking",
                        "krb5p  -  Kerberos + encryption (most secure)",
                        "sys    -  Standard UID/GID (no Kerberos)",
                    ],
                    title="Step 6/7: Security Mode",
                    prompt="Select NFS security mode:",
                )
            )
            if mode is None:
                return None

            # Extract the mode name (first word)
            self._sec_mode = mode.strip().split()[0]

            # Kerberos pre-flight warnings
            if self._sec_mode != "sys":
                warnings: list[str] = []

                if not Path("/etc/krb5.conf").exists():
                    warnings.append(
                        "- /etc/krb5.conf not found\n"
                        "  Install: apt install krb5-user"
                    )

                # Time sync check
                try:
                    import subprocess

                    r = subprocess.run(
                        ["timedatectl", "show",
                         "--property=NTPSynchronized", "--value"],
                        capture_output=True, text=True, timeout=3,
                    )
                    if r.stdout.strip() == "no":
                        warnings.append(
                            "- System clock is NOT synchronized\n"
                            "  Kerberos requires accurate time\n"
                            "  Fix: timedatectl set-ntp true"
                        )
                except Exception:
                    pass

                # Kerberos ticket check
                try:
                    import subprocess

                    r = subprocess.run(
                        ["klist", "-s"],
                        capture_output=True, timeout=3,
                    )
                    if r.returncode != 0:
                        warnings.append(
                            "- No valid Kerberos ticket found\n"
                            "  Run: kinit user@REALM"
                        )
                except Exception:
                    warnings.append(
                        "- Could not check Kerberos tickets\n"
                        "  (klist not available)"
                    )

                if warnings:
                    await self.app.push_screen_wait(
                        ConfirmDialog(
                            "The following issues were detected:\n\n"
                            + "\n\n".join(warnings)
                            + "\n\nThe mount may fail without these resolved.",
                            title="Kerberos Warnings",
                            ok_only=True,
                        )
                    )

        return self._sec_mode

    async def _step_persistent(self) -> str | None:
        result = await self.app.push_screen_wait(
            ConfirmDialog(
                "Add this mount to /etc/fstab?\n\n"
                "If yes, the share will be automatically\n"
                "mounted when the system boots.\n\n"
                "Recommended: Yes",
                title="Step 7/7: Persistent Mount",
            )
        )
        if result is None:
            return None
        self._add_to_fstab = bool(result)
        return "ok"

    # ------------------------------------------------------------------
    # Confirmation dialog
    # ------------------------------------------------------------------

    async def _show_confirmation(self) -> bool:
        from xinas_client.utils.nfs_utils import build_mount_opts

        opts = build_mount_opts(
            self._protocol,
            self._nconnect,
            self._sec_mode,
            num_ips=self._num_ips,
        )

        ip_list = ", ".join(self._server_ips)

        auth_desc = {
            "sys": "None (UID/GID)",
            "krb5": "Kerberos",
            "krb5i": "Kerberos + integrity",
            "krb5p": "Kerberos + encryption",
        }.get(self._sec_mode, self._sec_mode)

        mode_desc = (
            "training + trunking" if self._num_ips > 1
            else "training (attribute caching)"
        )
        conn_desc = f"max_connect=16, nconnect={self._nconnect} per IP"

        summary = (
            f"Server IPs:   {ip_list}\n"
            f"Share:        {self._share_path}\n"
            f"Mount Point:  {self._mount_point}\n"
            f"Protocol:     {self._protocol}\n"
            f"Mode:         {mode_desc}\n"
            f"Auth:         {auth_desc} (sec={self._sec_mode})\n"
            f"Connections:  {conn_desc}\n"
            f"I/O Size:     rsize/wsize=1MB\n"
            f"Persistent:   {'yes' if self._add_to_fstab else 'no'}"
        )

        return await self.app.push_screen_wait(
            ConfirmDialog(
                f"Please review your mount configuration:\n\n{summary}",
                title="Confirm Settings",
                yes_label="Mount [y]",
                no_label="Back [n]",
            )
        )

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    @work(exclusive=True)
    async def _execute_mount(self) -> None:
        """Mount the NFS share(s) in a background worker."""
        from xinas_client.utils.nfs_utils import (
            build_mount_opts,
            mount_nfs,
            add_fstab_entry,
            remove_fstab_entries,
        )

        try:
            tv = self.query_one("#wizard-content", ScrollableTextView)
        except Exception:
            return

        opts = build_mount_opts(
            self._protocol,
            self._nconnect,
            self._sec_mode,
            num_ips=self._num_ips,
        )

        proto_desc = self._protocol
        tracker = OpTracker(
            f"Mount NFS: {self._share_path}",
            before=f"Protocol: {proto_desc}, IPs: {self._num_ips}",
        )

        tv.set_content(
            f"  [bold]Mounting {self._share_path} via {proto_desc}...[/bold]\n"
        )

        # Create mount point
        mount_point = self._mount_point
        try:
            os.makedirs(mount_point, exist_ok=True)
            tracker.step("create mount point", ok=True)
            tv.append(f"  [OK]   Created {mount_point}")
        except OSError as exc:
            tracker.step("create mount point", ok=False, detail=str(exc))
            tv.append(f"  [FAIL] Create {mount_point}: {exc}")
            result = tracker.finish()
            tv.append("")
            for line in result.format_lines():
                tv.append(line)
            return

        # Mount each IP
        successful: list[str] = []
        for ip in self._server_ips:
            ok, err = mount_nfs(ip, self._share_path, mount_point, opts)
            step_name = f"mount {ip}:{self._share_path}"
            tracker.step(step_name, ok=ok, detail=err if not ok else "")
            if ok:
                tv.append(f"  [OK]   Mounted {ip} -> {mount_point}")
                successful.append(ip)
            else:
                tv.append(f"  [FAIL] Mount {ip}: {err}")

        # Add to fstab
        if self._add_to_fstab and successful:
            try:
                remove_fstab_entries(mount_point)
                for ip in successful:
                    add_fstab_entry(ip, self._share_path, mount_point, opts)
                tracker.step("add to fstab", ok=True)
                tv.append(f"  [OK]   Added {len(successful)} fstab entry(ies)")
            except OSError as exc:
                tracker.step("add to fstab", ok=False, detail=str(exc))
                tv.append(f"  [FAIL] fstab: {exc}")

        # Summary
        result = tracker.finish(
            after=(
                f"{len(successful)}/{len(self._server_ips)} IP(s) mounted"
                + (", persistent" if self._add_to_fstab else "")
            ),
        )

        tv.append("")
        tv.append(f"  [bold]Result: {result.status.value}[/bold]")
        for line in result.format_lines():
            tv.append(line)
        tv.append("")
        tv.append("  Press Esc to return to the main menu.")

        # Update nav to show completion
        try:
            nav = self.query_one("#wizard-nav", NavigableMenu)
            nav.update_items([
                MenuItem("R", "Result: " + result.status.value, enabled=False),
                MenuItem("", "", separator=True),
                MenuItem("0", "Back to menu"),
            ])
        except Exception:
            pass
