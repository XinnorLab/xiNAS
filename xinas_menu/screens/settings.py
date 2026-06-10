"""SettingsScreen — email config, HC scheduler, test email."""

from __future__ import annotations

import asyncio
import logging
import socket

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.utils.config import cfg_read, cfg_write
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Email Configuration"),
    MenuItem("2", "Health Check Scheduler"),
    MenuItem("3", "Send Test Email"),
    MenuItem("4", "xiRAID Notifications"),
    MenuItem("0", "Back"),
]


class SettingsScreen(Screen):
    """Application settings — email and health-check scheduler."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Settings", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="settings-nav")
            yield ScrollableTextView(id="settings-content")
        yield Footer()

    def on_mount(self) -> None:
        self._show_overview()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        if event.key == "0":
            self.app.pop_screen()
        elif event.key == "1":
            self._email_config()
        elif event.key == "2":
            self._hc_scheduler()
        elif event.key == "3":
            self._send_test_email()
        elif event.key == "4":
            self._xiraid_notifications()

    # ── Overview ───────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _show_overview(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)

        GRN, _RED, BLD, DIM, NC = "\033[32m", "\033[31m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}Settings Overview{NC}", ""]

        email = cfg.get("email", {})
        if email.get("enabled"):
            lines.append(
                f"  Email:     {GRN}enabled{NC}  ({email.get('smtp_host', '?')}:{email.get('smtp_port', '?')})"
            )
            lines.append(f"  Recipients: {', '.join(email.get('to_addrs', []))}")
        else:
            lines.append(f"  Email:     {DIM}not configured{NC}")

        lines.append("")

        sched = cfg.get("healthcheck_schedule", {})
        if sched.get("enabled"):
            from xinas_menu.utils.hc_scheduler import scheduler_status

            status = await loop.run_in_executor(None, scheduler_status)
            lines.append(
                f"  HC Scheduler: {GRN}enabled{NC}  (every {status.get('interval_hours', '?')}h)"
            )
            lines.append(f"  Profile:      {sched.get('profile', 'standard')}")
            lines.append(f"  Next run:     {status.get('next_run', 'n/a')}")
            lines.append(f"  Last run:     {status.get('last_run', 'n/a')}")
        else:
            lines.append(f"  HC Scheduler: {DIM}not configured{NC}")

        lines.append("")

        from xinas_menu.utils.xicli_mail import grpc_available, mail_show, settings_mail_show

        xicli_ok = await grpc_available()
        if xicli_ok:
            ok_r, receivers, _ = await mail_show()
            ok_s, msettings, _ = await settings_mail_show()
            if ok_r and receivers:
                lines.append(
                    f"  xiRAID Mail: {GRN}enabled{NC}  ({len(receivers)} recipient{'s' if len(receivers) != 1 else ''})"
                )
            elif ok_r:
                lines.append(f"  xiRAID Mail: {DIM}no recipients{NC}")
            else:
                lines.append(f"  xiRAID Mail: {DIM}query failed{NC}")
            if ok_s and msettings:
                pi = msettings.get("polling_interval", "?")
                ppi = msettings.get("progress_polling_interval", "?")
                lines.append(f"  Polling:      {pi}s / {ppi}min")
        else:
            lines.append(f"  xiRAID Mail: {DIM}not available (gRPC unreachable){NC}")

        view.set_content("\n".join(lines))

    # ── Email Configuration ────────────────────────────────────────────────

    @work(exclusive=True)
    async def _email_config(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)
        email = cfg.get("email", {})

        _GRN, BLD, _DIM, NC = "\033[32m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}Email Configuration{NC}", ""]
        lines.append(f"  Enabled:   {email.get('enabled', False)}")
        lines.append(f"  SMTP Host: {email.get('smtp_host', '(not set)')}")
        lines.append(f"  SMTP Port: {email.get('smtp_port', 587)}")
        lines.append(f"  TLS:       {email.get('smtp_tls', True)}")
        lines.append(f"  User:      {email.get('smtp_user', '(not set)')}")
        pw = email.get("smtp_password", "")
        lines.append(f"  Password:  {'●' * min(len(pw), 8) if pw else '(not set)'}")
        lines.append(f"  From:      {email.get('from_addr', '(not set)')}")
        lines.append(f"  To:        {', '.join(email.get('to_addrs', []))}")
        view.set_content("\n".join(lines))

        choice = await self.app.push_screen_wait(
            SelectDialog(
                ["Configure Email", "Disable Email"],
                title="Email Configuration",
                prompt="Choose an action:",
            )
        )
        if choice is None:
            return

        if choice == "Disable Email":
            cfg.setdefault("email", {})["enabled"] = False
            await loop.run_in_executor(None, cfg_write, cfg)
            self.app.notify("Email disabled")
            self._show_overview()
            return

        while True:
            host = await self.app.push_screen_wait(
                InputDialog(
                    "SMTP Host:",
                    "Email Setup",
                    default=email.get("smtp_host", ""),
                    placeholder="smtp.example.com",
                )
            )
            if host is None:
                return
            if host.strip():
                host = host.strip()
                break
            self.app.notify("SMTP host cannot be empty", severity="error")

        while True:
            port_str = await self.app.push_screen_wait(
                InputDialog(
                    "SMTP Port:",
                    "Email Setup",
                    default=str(email.get("smtp_port", 587)),
                    placeholder="587",
                )
            )
            if port_str is None:
                return
            try:
                port = int(port_str)
                if 1 <= port <= 65535:
                    break
                raise ValueError("out of range")
            except ValueError:
                self.app.notify("Port must be 1-65535", severity="error")

        tls_choice = await self.app.push_screen_wait(
            SelectDialog(["Yes", "No"], title="Email Setup", prompt="Use STARTTLS?")
        )
        if tls_choice is None:
            return
        use_tls = tls_choice == "Yes"

        user = await self.app.push_screen_wait(
            InputDialog("SMTP Username:", "Email Setup", default=email.get("smtp_user", ""))
        )
        if user is None:
            return

        password = await self.app.push_screen_wait(
            InputDialog("SMTP Password:", "Email Setup", password=True)
        )
        if password is None:
            return

        while True:
            from_addr = await self.app.push_screen_wait(
                InputDialog(
                    "From Address:",
                    "Email Setup",
                    default=email.get("from_addr", user),
                    placeholder="alerts@example.com",
                )
            )
            if from_addr is None:
                return
            if "@" in from_addr:
                break
            self.app.notify("Invalid email address (must contain @)", severity="error")

        while True:
            to_str = await self.app.push_screen_wait(
                InputDialog(
                    "To Addresses (comma-separated):",
                    "Email Setup",
                    default=", ".join(email.get("to_addrs", [])),
                    placeholder="admin@example.com, ops@example.com",
                )
            )
            if to_str is None:
                return
            to_addrs = [a.strip() for a in to_str.split(",") if a.strip()]
            if not to_addrs:
                self.app.notify("At least one recipient required", severity="error")
                continue
            invalid = [a for a in to_addrs if "@" not in a]
            if invalid:
                self.app.notify(f"Invalid address(es): {', '.join(invalid)}", severity="error")
                continue
            break

        cfg["email"] = {
            "enabled": True,
            "smtp_host": host,
            "smtp_port": port,
            "smtp_tls": use_tls,
            "smtp_user": user,
            "smtp_password": password,
            "from_addr": from_addr,
            "to_addrs": to_addrs,
        }
        await loop.run_in_executor(None, cfg_write, cfg)
        self.app.audit.log("settings.email", f"host={host}", "OK")
        self.app.notify("Email configuration saved")
        self._show_overview()

    # ── Health Check Scheduler ─────────────────────────────────────────────

    @work(exclusive=True)
    async def _hc_scheduler(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)
        sched = cfg.get("healthcheck_schedule", {})

        from xinas_menu.utils.hc_scheduler import (
            scheduler_disable,
            scheduler_enable,
            scheduler_status,
        )

        status = await loop.run_in_executor(None, scheduler_status)

        GRN, RED, BLD, _DIM, NC = "\033[32m", "\033[31m", "\033[1m", "\033[2m", "\033[0m"
        lines = [f"{BLD}Health Check Scheduler{NC}", ""]
        if status["enabled"]:
            lines.append(f"  Status:    {GRN}enabled{NC}")
            lines.append(f"  Interval:  every {status.get('interval_hours', '?')}h")
            lines.append(f"  Profile:   {sched.get('profile', 'standard')}")
            lines.append(f"  Next run:  {status.get('next_run', 'n/a')}")
            lines.append(f"  Last run:  {status.get('last_run', 'n/a')}")
        else:
            lines.append(f"  Status:    {RED}disabled{NC}")
        view.set_content("\n".join(lines))

        options = ["Enable/Update Scheduler", "Disable Scheduler"]
        choice = await self.app.push_screen_wait(
            SelectDialog(options, title="HC Scheduler", prompt="Choose an action:")
        )
        if choice is None:
            return

        if choice == "Disable Scheduler":
            ok, err = await loop.run_in_executor(None, scheduler_disable)
            cfg["healthcheck_schedule"] = {"enabled": False}
            await loop.run_in_executor(None, cfg_write, cfg)
            if ok:
                self.app.audit.log("settings.hc_scheduler", "disabled", "OK")
                self.app.notify("Health check scheduler disabled")
            else:
                self.app.notify(f"Disable failed: {err}", severity="error")
            self._show_overview()
            return

        interval_str = await self.app.push_screen_wait(
            InputDialog(
                "Run interval in hours (1-168):",
                "HC Scheduler",
                default=str(sched.get("interval_hours", 24)),
                placeholder="24",
            )
        )
        if interval_str is None:
            return
        try:
            interval = int(interval_str)
            if not 1 <= interval <= 168:
                raise ValueError("out of range")
        except ValueError:
            self.app.notify("Invalid interval (must be 1-168)", severity="error")
            return

        profile = await self.app.push_screen_wait(
            SelectDialog(
                ["quick", "standard", "deep"],
                title="HC Scheduler",
                prompt="Health check profile:",
            )
        )
        if profile is None:
            return

        ok, err = await loop.run_in_executor(None, lambda: scheduler_enable(interval, profile))
        if ok:
            cfg["healthcheck_schedule"] = {
                "enabled": True,
                "interval_hours": interval,
                "profile": profile,
            }
            await loop.run_in_executor(None, cfg_write, cfg)
            self.app.audit.log(
                "settings.hc_scheduler", f"enabled every {interval}h profile={profile}", "OK"
            )
            self.app.notify(f"Scheduler enabled: every {interval}h ({profile})")
        else:
            self.app.notify(f"Enable failed: {err}", severity="error")
        self._show_overview()

    # ── Test Email ─────────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _send_test_email(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        cfg = await loop.run_in_executor(None, cfg_read)

        if not cfg.get("email", {}).get("enabled"):
            view.set_content(
                "\033[33m  Email is not configured.\n\n  Use 'Email Configuration' first.\033[0m"
            )
            return

        view.set_content("  Sending test email...")
        from xinas_menu.utils.email_sender import send_email

        hostname = socket.gethostname()
        ok, err = await loop.run_in_executor(
            None,
            lambda: send_email(
                f"[xiNAS] Test Email — {hostname}",
                f"This is a test email from xiNAS Management Console on {hostname}.\n\n"
                "If you received this, email delivery is working correctly.",
                cfg,
            ),
        )
        if ok:
            GRN, NC = "\033[32m", "\033[0m"
            view.set_content(f"  {GRN}Test email sent successfully!{NC}")
            self.app.audit.log("settings.test_email", "sent", "OK")
        else:
            RED, NC = "\033[31m", "\033[0m"
            view.set_content(f"  {RED}Email send failed:{NC} {err}")

    # ── xiRAID Notifications ────────────────────────────────────────────────

    @work(exclusive=True)
    async def _xiraid_notifications(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)

        from xinas_menu.utils.xicli_mail import (
            grpc_available,
            mail_show,
            settings_mail_show,
        )

        available = await grpc_available()
        if not available:
            view.set_content(
                "\033[33m  xiRAID daemon is not reachable.\n\n"
                "  Ensure xiRAID is installed and the gRPC service is running.\033[0m"
            )
            return

        ok_r, receivers, err_r = await mail_show()
        ok_s, settings, err_s = await settings_mail_show()

        _GRN, RED, BLD, DIM, NC = (
            "\033[32m",
            "\033[31m",
            "\033[1m",
            "\033[2m",
            "\033[0m",
        )
        lines = [f"{BLD}xiRAID Notifications{NC}", ""]

        if ok_r:
            if receivers:
                lines.append(f"  Recipients ({len(receivers)}):")
                for r in receivers:
                    lines.append(f"    {r['address']:30s}  {r['level']}")
            else:
                lines.append(f"  Recipients: {DIM}none configured{NC}")
        else:
            lines.append(f"  {RED}Failed to query recipients:{NC} {err_r}")

        lines.append("")
        if ok_s and settings:
            pi = settings.get("polling_interval", "?")
            ppi = settings.get("progress_polling_interval", "?")
            lines.append(f"  Polling interval:          {pi}s")
            lines.append(f"  Progress polling interval: {ppi}min")
        elif not ok_s:
            lines.append(f"  {RED}Failed to query settings:{NC} {err_s}")

        view.set_content("\n".join(lines))

        options = ["Add Recipient", "Modify Polling Intervals", "Send Test Notification"]
        if receivers:
            options.insert(1, "Remove Recipient")
        choice = await self.app.push_screen_wait(
            SelectDialog(options, title="xiRAID Notifications", prompt="Choose an action:")
        )
        if choice is None:
            return

        if choice == "Add Recipient":
            await self._xiraid_notif_add_recipient()
        elif choice == "Remove Recipient":
            await self._xiraid_notif_remove_recipient(receivers)
        elif choice == "Modify Polling Intervals":
            await self._xiraid_notif_modify_intervals(settings)
        elif choice == "Send Test Notification":
            await self._xiraid_notif_send_test()

    async def _xiraid_notif_add_recipient(self) -> None:
        while True:
            address = await self.app.push_screen_wait(
                InputDialog(
                    "Recipient email:",
                    "Add Notification Recipient",
                    placeholder="admin@example.com",
                )
            )
            if address is None:
                return
            if "@" in address.strip():
                address = address.strip()
                break
            self.app.notify("Invalid email address (must contain @)", severity="error")

        level = await self.app.push_screen_wait(
            SelectDialog(
                ["error", "warning", "info"],
                title="Notification Level",
                prompt="Receive notifications at this level and above:",
            )
        )
        if level is None:
            return

        from xinas_menu.utils.xicli_mail import mail_add

        ok, err = await mail_add(address, level)
        if ok:
            self.app.audit.log("settings.xiraid_mail", f"add {address} level={level}", "OK")
            self.app.notify(f"Added {address} ({level})")
        else:
            self.app.audit.log("settings.xiraid_mail", f"add {address} level={level}", "FAIL")
            self.app.notify(f"Failed: {err}", severity="error")
        self._xiraid_notifications()

    async def _xiraid_notif_remove_recipient(
        self,
        receivers: list[dict[str, str]],
    ) -> None:
        labels = [f"{r['address']} ({r['level']})" for r in receivers]
        choice = await self.app.push_screen_wait(
            SelectDialog(labels, title="Remove Recipient", prompt="Select recipient to remove:")
        )
        if choice is None:
            return

        idx = labels.index(choice)
        address = receivers[idx]["address"]

        confirm = await self.app.push_screen_wait(
            ConfirmDialog(f"Remove {address} from xiRAID notifications?")
        )
        if not confirm:
            return

        from xinas_menu.utils.xicli_mail import mail_remove

        ok, err = await mail_remove(address)
        if ok:
            self.app.audit.log("settings.xiraid_mail", f"remove {address}", "OK")
            self.app.notify(f"Removed {address}")
        else:
            self.app.audit.log("settings.xiraid_mail", f"remove {address}", "FAIL")
            self.app.notify(f"Failed: {err}", severity="error")
        self._xiraid_notifications()

    async def _xiraid_notif_modify_intervals(self, current: dict) -> None:
        pi_str = await self.app.push_screen_wait(
            InputDialog(
                "RAID/drive polling interval (seconds):",
                "Polling Intervals",
                default=str(current.get("polling_interval", 10)),
                placeholder="10",
            )
        )
        if pi_str is None:
            return
        try:
            pi = int(pi_str)
            if pi < 1:
                raise ValueError
        except ValueError:
            self.app.notify("Must be a positive integer", severity="error")
            return

        ppi_str = await self.app.push_screen_wait(
            InputDialog(
                "Progress polling interval (minutes):",
                "Polling Intervals",
                default=str(current.get("progress_polling_interval", 10)),
                placeholder="10",
            )
        )
        if ppi_str is None:
            return
        try:
            ppi = int(ppi_str)
            if ppi < 1:
                raise ValueError
        except ValueError:
            self.app.notify("Must be a positive integer", severity="error")
            return

        from xinas_menu.utils.xicli_mail import settings_mail_modify

        ok, err = await settings_mail_modify(pi, ppi)
        if ok:
            self.app.audit.log(
                "settings.xiraid_mail",
                f"modify pi={pi} ppi={ppi}",
                "OK",
            )
            self.app.notify(f"Polling intervals updated: {pi}s / {ppi}min")
        else:
            self.app.audit.log(
                "settings.xiraid_mail",
                f"modify pi={pi} ppi={ppi}",
                "FAIL",
            )
            self.app.notify(f"Failed: {err}", severity="error")
        self._xiraid_notifications()

    async def _xiraid_notif_send_test(self) -> None:
        view = self.query_one("#settings-content", ScrollableTextView)

        view.set_content("  Sending xiRAID test notification...")

        from xinas_menu.utils.xicli_mail import mail_send_test

        ok, err = await mail_send_test()
        if ok:
            GRN, NC = "\033[32m", "\033[0m"
            view.set_content(f"  {GRN}xiRAID test notification sent!{NC}")
            self.app.audit.log("settings.xiraid_mail", "test_send", "OK")
        else:
            RED, NC = "\033[31m", "\033[0m"
            view.set_content(f"  {RED}Send failed:{NC} {err}")
            self.app.audit.log("settings.xiraid_mail", "test_send", "FAIL")
