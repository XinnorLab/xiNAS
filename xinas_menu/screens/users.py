"""UsersScreen — user management and disk quota."""
from __future__ import annotations

import asyncio
import grp
import pwd
import subprocess
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

_RED = "\033[31m"
_GRN = "\033[32m"
_YLW = "\033[33m"
_CYN = "\033[36m"
_BLD = "\033[1m"
_DIM = "\033[2m"
_NC = "\033[0m"

_MENU = [
    MenuItem("1", "List Users"),
    MenuItem("2", "Create User"),
    MenuItem("3", "Delete User"),
    MenuItem("4", "Set Disk Quota"),
    MenuItem("5", "Show Quotas"),
    MenuItem("0", "Back"),
]

_UID_MIN = 1000


class UsersScreen(Screen):
    """User account management."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  User Management", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="users-nav")
            yield ScrollableTextView(
                "\033[1m\033[36mUser Management\033[0m\n"
                "\n"
                "  \033[1m1\033[0m  \033[36mList Users\033[0m         \033[2mShow all system users\033[0m\n"
                "  \033[1m2\033[0m  \033[36mCreate User\033[0m        \033[2mAdd a new user with home directory\033[0m\n"
                "  \033[1m3\033[0m  \033[36mDelete User\033[0m        \033[2mRemove a user from the system\033[0m\n"
                "  \033[1m4\033[0m  \033[36mSet Disk Quota\033[0m     \033[2mConfigure storage limits per user\033[0m\n"
                "  \033[1m5\033[0m  \033[36mShow Quotas\033[0m        \033[2mDisplay current disk quota report\033[0m\n",
                id="users-content",
            )
        yield Footer()

    def on_mount(self) -> None:
        self._list_users()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._list_users()
        elif key == "2":
            self._create_user()
        elif key == "3":
            self._delete_user()
        elif key == "4":
            self._set_quota()
        elif key == "5":
            self._show_quotas()

    @work(exclusive=True)
    async def _list_users(self) -> None:
        loop = asyncio.get_running_loop()
        users = await loop.run_in_executor(None, _get_local_users)
        view = self.query_one("#users-content", ScrollableTextView)
        view.set_content(_format_users(users))

    @work(exclusive=True)
    async def _create_user(self) -> None:
        import re
        _USERNAME_RE = re.compile(r'^[A-Za-z0-9_-]+$')

        while True:
            username = await self.app.push_screen_wait(
                InputDialog("New username:", "Create User", placeholder="john")
            )
            if not username:
                return
            username = username.strip()
            if not username:
                self.app.notify("Username must not be empty.", severity="error")
                continue
            if len(username) > 32:
                self.app.notify("Username must be 32 characters or fewer.", severity="error")
                continue
            if not _USERNAME_RE.match(username):
                self.app.notify("Username must contain only alphanumeric, underscore, or dash characters.", severity="error")
                continue
            break

        password = await self.app.push_screen_wait(
            InputDialog("Password (leave blank for no password):", "Create User",
                        password=True)
        )
        if password is None:
            return

        home = await self.app.push_screen_wait(
            InputDialog("Home directory:", "Create User",
                        default=f"/home/{username}")
        )
        if home is None:
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Create user '{username}' with home {home}?", "Confirm")
        )
        if not confirmed:
            return

        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _create_user_sync(username, home, password)
        )
        if ok:
            self.app.audit.log("user.create", username, "OK")
            await self._list_users()
        else:
            view = self.query_one("#users-content", ScrollableTextView)
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    @work(exclusive=True)
    async def _delete_user(self) -> None:
        while True:
            username = await self.app.push_screen_wait(
                InputDialog("Username to delete:", "Delete User", placeholder="john")
            )
            if username is None:
                return
            if not username.strip():
                self.app.notify("Username must not be empty.", severity="error")
                continue
            username = username.strip()
            break

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Delete user '{username}'? Home directory will be kept.", "Confirm")
        )
        if not confirmed:
            return

        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _run_cmd("userdel", username)
        )
        if ok:
            self.app.audit.log("user.delete", username, "OK")
            await self._list_users()
        else:
            view = self.query_one("#users-content", ScrollableTextView)
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    @work(exclusive=True)
    async def _set_quota(self) -> None:
        while True:
            username = await self.app.push_screen_wait(
                InputDialog("Username:", "Set Disk Quota", placeholder="john")
            )
            if username is None:
                return
            if not username.strip():
                self.app.notify("Username must not be empty.", severity="error")
                continue
            username = username.strip()
            break

        while True:
            export_path = await self.app.push_screen_wait(
                InputDialog("Export path:", "Set Disk Quota", placeholder="/mnt/data/share1")
            )
            if export_path is None:
                return
            if not export_path.strip():
                self.app.notify("Export path must not be empty.", severity="error")
                continue
            if not export_path.strip().startswith("/"):
                self.app.notify("Export path must start with '/'.", severity="error")
                continue
            export_path = export_path.strip()
            break

        while True:
            soft_str = await self.app.push_screen_wait(
                InputDialog("Soft limit (GB, 0=none):", "Set Disk Quota", default="0", placeholder="10")
            )
            if soft_str is None:
                return
            try:
                soft_kb = int(float(soft_str) * 1024 * 1024)
            except ValueError:
                self.app.notify("Soft limit must be a valid number.", severity="error")
                continue
            break

        while True:
            hard_str = await self.app.push_screen_wait(
                InputDialog("Hard limit (GB, 0=none):", "Set Disk Quota", default="0", placeholder="20")
            )
            if hard_str is None:
                return
            try:
                hard_kb = int(float(hard_str) * 1024 * 1024)
            except ValueError:
                self.app.notify("Hard limit must be a valid number.", severity="error")
                continue
            break

        loop = asyncio.get_running_loop()
        ok, _, err = await loop.run_in_executor(
            None,
            lambda: self.app.nfs.set_quota(export_path, soft_kb, hard_kb),
        )
        view = self.query_one("#users-content", ScrollableTextView)
        if ok:
            self.app.audit.log("user.quota", f"{username}@{export_path}", "OK")
            view.set_content(f"{_GRN}Quota set.{_NC}")
        else:
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    @work(exclusive=True)
    async def _show_quotas(self) -> None:
        loop = asyncio.get_running_loop()
        ok, stdout, stderr = await loop.run_in_executor(
            None, lambda: _run_cmd("repquota", "-a")
        )
        view = self.query_one("#users-content", ScrollableTextView)
        if ok:
            view.set_content(f"[bold]Disk Quotas[/bold]\n\n{stdout}")
        else:
            view.set_content(f"[dim]repquota not available or no quotas: {stderr}[/dim]")


def _get_local_users() -> list[pwd.struct_passwd]:
    return [p for p in pwd.getpwall() if p.pw_uid >= _UID_MIN]


def _format_users(users: list[pwd.struct_passwd]) -> str:
    GRN, YLW, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
    W = 70
    lines: list[str] = []
    lines.append(f"{BLD}{CYN}USER ACCOUNTS{NC}")
    lines.append(f"{DIM}{'=' * W}{NC}")
    lines.append("")

    if not users:
        lines.append(f"  {DIM}No regular user accounts found.{NC}")
        lines.append("")
        lines.append(f"  {DIM}System only has root and service accounts.{NC}")
    else:
        lines.append(f"  Found {GRN}{len(users)}{NC} user account(s)")
        lines.append("")
        lines.append(f"{DIM}{'-' * W}{NC}")
        lines.append(f"  {DIM}{'Username':<16} {'UID':<8} {'Group':<16} Home Directory{NC}")
        lines.append(f"{DIM}{'-' * W}{NC}")
        for u in sorted(users, key=lambda x: x.pw_name):
            try:
                group = grp.getgrgid(u.pw_gid).gr_name
            except Exception:
                group = str(u.pw_gid)
            lines.append(f"  {GRN}{u.pw_name:<16}{NC} {u.pw_uid:<8} {group:<16} {u.pw_dir}")
        lines.append(f"{DIM}{'-' * W}{NC}")

    lines.append("")
    # Quota status
    try:
        r = subprocess.run(
            ["quotaon", "-p", "/mnt/data"],
            capture_output=True, text=True, timeout=5,
        )
        if "is on" in r.stdout + r.stderr:
            lines.append(f"  Disk Quotas: {GRN}ENABLED{NC} on /mnt/data")
        else:
            lines.append(f"  Disk Quotas: {YLW}Not enabled{NC}")
            lines.append(f"  {DIM}(Enable with: sudo quotaon -v /mnt/data){NC}")
    except Exception:
        lines.append(f"  Disk Quotas: {DIM}status unknown{NC}")
    lines.append("")
    lines.append(f"{DIM}{'=' * W}{NC}")
    return "\n".join(lines)


def _run_cmd(*args: str) -> tuple[bool, str, str]:
    r = subprocess.run(list(args), capture_output=True, text=True)
    return r.returncode == 0, r.stdout, r.stderr


def _create_user_sync(username: str, home: str, password: str) -> tuple[bool, str]:
    r = subprocess.run(
        ["useradd", "-m", "-d", home, "-s", "/bin/bash", username],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return False, r.stderr.strip()
    if password:
        p = subprocess.run(
            ["chpasswd"],
            input=f"{username}:{password}\n",
            capture_output=True, text=True,
        )
        if p.returncode != 0:
            return False, p.stderr.strip()
    return True, ""
