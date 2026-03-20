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
from xinas_menu.widgets.select_dialog import SelectDialog
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
    MenuItem("3", "Manage User"),
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
                "  \033[1m3\033[0m  \033[36mManage User\033[0m        \033[2mPassword, lock, shell, groups, delete\033[0m\n"
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
            self._manage_user()
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

        while True:
            password = await self.app.push_screen_wait(
                InputDialog("Password (leave blank for no password):", "Create User",
                            password=True)
            )
            if password is None:
                return
            if not password:
                break
            password2 = await self.app.push_screen_wait(
                InputDialog("Confirm password:", "Create User",
                            password=True)
            )
            if password2 is None:
                return
            if password == password2:
                break
            self.app.notify("Passwords do not match. Please try again.", severity="error")

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
            self._list_users()
        else:
            view = self.query_one("#users-content", ScrollableTextView)
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    @work(exclusive=True)
    async def _manage_user(self) -> None:
        loop = asyncio.get_running_loop()
        users = await loop.run_in_executor(None, _get_local_users)
        if not users:
            self.app.notify("No regular users found.", severity="warning")
            return
        user_labels = [f"{u.pw_name}  (UID {u.pw_uid})" for u in sorted(users, key=lambda x: x.pw_name)]
        choice = await self.app.push_screen_wait(
            SelectDialog(user_labels, title="Manage User", prompt="Select user:")
        )
        if not choice:
            return
        username = choice.split()[0]

        while True:
            locked = await loop.run_in_executor(None, lambda: _get_lock_status(username))
            lock_label = "Unlock Account" if locked else "Lock Account"
            actions = [
                "Change Password",
                lock_label,
                "Change Shell",
                "Manage Groups",
                "Delete User",
            ]
            action = await self.app.push_screen_wait(
                SelectDialog(actions, title=f"Manage: {username}", prompt="Select action:")
            )
            if not action:
                break

            if action == "Change Password":
                await self._change_password(username)
            elif action in ("Lock Account", "Unlock Account"):
                await self._lock_unlock(username, locked)
            elif action == "Change Shell":
                await self._change_shell(username)
            elif action == "Manage Groups":
                await self._manage_groups(username)
            elif action == "Delete User":
                confirmed = await self.app.push_screen_wait(
                    ConfirmDialog(f"Delete user '{username}'? Home directory will be removed.", "Confirm")
                )
                if confirmed:
                    ok, _, err = await loop.run_in_executor(
                        None, lambda: _run_cmd("userdel", "-r", username)
                    )
                    if ok:
                        self.app.audit.log("user.delete", username, "OK")
                        self._list_users()
                    else:
                        view = self.query_one("#users-content", ScrollableTextView)
                        view.set_content(f"{_RED}Failed: {err}{_NC}")
                break

    async def _change_password(self, username: str) -> None:
        while True:
            password = await self.app.push_screen_wait(
                InputDialog("New password:", f"Change Password: {username}", password=True)
            )
            if password is None:
                return
            if not password:
                self.app.notify("Password must not be empty.", severity="error")
                continue
            password2 = await self.app.push_screen_wait(
                InputDialog("Confirm password:", f"Change Password: {username}", password=True)
            )
            if password2 is None:
                return
            if password == password2:
                break
            self.app.notify("Passwords do not match. Please try again.", severity="error")

        loop = asyncio.get_running_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _change_password_sync(username, password)
        )
        view = self.query_one("#users-content", ScrollableTextView)
        if ok:
            self.app.audit.log("user.change_password", username, "OK")
            view.set_content(f"{_GRN}Password changed for '{username}'.{_NC}")
        else:
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    async def _lock_unlock(self, username: str, currently_locked: bool) -> None:
        if currently_locked:
            cmd_args = ("usermod", "-U", username)
            action_word, audit_action = "Unlocked", "user.unlock"
        else:
            cmd_args = ("usermod", "-L", username)
            action_word, audit_action = "Locked", "user.lock"

        loop = asyncio.get_running_loop()
        ok, _, err = await loop.run_in_executor(None, lambda: _run_cmd(*cmd_args))
        view = self.query_one("#users-content", ScrollableTextView)
        if ok:
            self.app.audit.log(audit_action, username, "OK")
            view.set_content(f"{_GRN}{action_word} account '{username}'.{_NC}")
        else:
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    async def _change_shell(self, username: str) -> None:
        _CUSTOM = "Custom\u2026"
        shells = ["/bin/bash", "/bin/sh", "/usr/sbin/nologin", "/bin/false", _CUSTOM]
        choice = await self.app.push_screen_wait(
            SelectDialog(shells, title=f"Change Shell: {username}", prompt="Select shell:")
        )
        if not choice:
            return
        if choice == _CUSTOM:
            shell = await self.app.push_screen_wait(
                InputDialog("Shell path:", f"Change Shell: {username}",
                            placeholder="/usr/bin/zsh")
            )
            if not shell or not shell.strip():
                return
            shell = shell.strip()
        else:
            shell = choice

        loop = asyncio.get_running_loop()
        ok, _, err = await loop.run_in_executor(
            None, lambda: _run_cmd("chsh", "-s", shell, username)
        )
        view = self.query_one("#users-content", ScrollableTextView)
        if ok:
            self.app.audit.log("user.change_shell", f"{username} -> {shell}", "OK")
            view.set_content(f"{_GRN}Shell changed to '{shell}' for '{username}'.{_NC}")
        else:
            view.set_content(f"{_RED}Failed: {err}{_NC}")

    async def _manage_groups(self, username: str) -> None:
        loop = asyncio.get_running_loop()
        while True:
            current = await loop.run_in_executor(None, lambda: _get_user_groups(username))
            view = self.query_one("#users-content", ScrollableTextView)
            view.set_content(
                f"{_BLD}{_CYN}Groups for '{username}':{_NC}\n\n"
                f"  {', '.join(current) if current else '(none)'}\n"
            )

            action = await self.app.push_screen_wait(
                SelectDialog(
                    ["Add to group", "Remove from group"],
                    title=f"Groups: {username}",
                    prompt="Select action:",
                )
            )
            if not action:
                break

            if action == "Add to group":
                all_groups = await loop.run_in_executor(None, _get_all_groups)
                available = [g for g, _ in all_groups if g not in current]
                if not available:
                    self.app.notify("No additional groups available.", severity="warning")
                    continue
                group = await self.app.push_screen_wait(
                    SelectDialog(available, title="Add to Group", prompt="Select group:")
                )
                if not group:
                    continue
                ok, _, err = await loop.run_in_executor(
                    None, lambda: _run_cmd("usermod", "-aG", group, username)
                )
                if ok:
                    self.app.audit.log("user.add_to_group", f"{username} -> {group}", "OK")
                    self.app.notify(f"Added '{username}' to group '{group}'.", severity="information")
                else:
                    view.set_content(f"{_RED}Failed: {err}{_NC}")

            elif action == "Remove from group":
                # Get primary group to exclude it
                try:
                    import pwd as _pwd
                    pw = _pwd.getpwnam(username)
                    primary_gid = pw.pw_gid
                except KeyError:
                    primary_gid = -1
                removable = []
                for g in current:
                    try:
                        gi = grp.getgrnam(g)
                        if gi.gr_gid != primary_gid:
                            removable.append(g)
                    except KeyError:
                        pass
                if not removable:
                    self.app.notify("No removable groups (primary group cannot be removed).", severity="warning")
                    continue
                group = await self.app.push_screen_wait(
                    SelectDialog(removable, title="Remove from Group", prompt="Select group:")
                )
                if not group:
                    continue
                ok, _, err = await loop.run_in_executor(
                    None, lambda: _run_cmd("gpasswd", "-d", username, group)
                )
                if ok:
                    self.app.audit.log("user.remove_from_group", f"{username} <- {group}", "OK")
                    self.app.notify(f"Removed '{username}' from group '{group}'.", severity="information")
                else:
                    view.set_content(f"{_RED}Failed: {err}{_NC}")

    @work(exclusive=True)
    async def _set_quota(self) -> None:
        loop = asyncio.get_running_loop()
        users = await loop.run_in_executor(None, _get_local_users)
        if not users:
            self.app.notify("No regular users found.", severity="warning")
            return
        user_labels = [f"{u.pw_name}  (UID {u.pw_uid})" for u in sorted(users, key=lambda x: x.pw_name)]
        choice = await self.app.push_screen_wait(
            SelectDialog(user_labels, title="Set Disk Quota — User",
                         prompt="Select user:")
        )
        if not choice:
            return
        username = choice.split()[0]

        # Export path — list mounted XFS filesystems + custom option
        from xinas_menu.utils.xfs_helpers import run_async_cmd
        mount_points: list[str] = []
        ok, out, _ = await run_async_cmd("findmnt", "-t", "xfs", "-n", "-o", "TARGET", timeout=10)
        if ok and out:
            mount_points = [line.strip() for line in out.splitlines() if line.strip()]

        _CUSTOM = "Custom path…"
        if mount_points:
            choices = mount_points + [_CUSTOM]
            path_choice = await self.app.push_screen_wait(
                SelectDialog(choices, title="Set Disk Quota — Path",
                             prompt="Select filesystem:")
            )
            if not path_choice:
                return
            if path_choice == _CUSTOM:
                export_path = await self.app.push_screen_wait(
                    InputDialog("Export path:", "Set Disk Quota",
                                default="/mnt/data/", placeholder="/mnt/data/share1")
                )
                if not export_path or not export_path.strip().startswith("/"):
                    self.app.notify("Export path must start with '/'.", severity="error")
                    return
                export_path = export_path.strip()
            else:
                export_path = path_choice
        else:
            export_path = await self.app.push_screen_wait(
                InputDialog("Export path:", "Set Disk Quota", placeholder="/mnt/data/share1")
            )
            if export_path is None:
                return
            if not export_path.strip() or not export_path.strip().startswith("/"):
                self.app.notify("Export path must start with '/'.", severity="error")
                return
            export_path = export_path.strip()

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
            lambda: self.app.nfs.set_quota(export_path, soft_kb, hard_kb, username=username),
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
        # XFS quotas are managed via xfs_quota, not repquota
        ok_u, out_u, err_u = await loop.run_in_executor(
            None, lambda: _run_cmd("xfs_quota", "-x", "-c", "report -ubh")
        )
        ok_p, out_p, err_p = await loop.run_in_executor(
            None, lambda: _run_cmd("xfs_quota", "-x", "-c", "report -pbh")
        )
        view = self.query_one("#users-content", ScrollableTextView)
        sections: list[str] = []
        if ok_u and out_u.strip():
            sections.append(f"[bold]User Quotas[/bold]\n\n{out_u}")
        if ok_p and out_p.strip():
            sections.append(f"[bold]Project Quotas[/bold]\n\n{out_p}")
        if sections:
            view.set_content("\n\n".join(sections))
        else:
            err = err_u or err_p or "no quotas configured"
            view.set_content(f"[dim]xfs_quota not available or no quotas: {err}[/dim]")


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
    # Quota status — XFS quotas are enabled via mount options, not quotaon
    try:
        r = subprocess.run(
            ["findmnt", "-t", "xfs", "-n", "-o", "TARGET,OPTIONS"],
            capture_output=True, text=True, timeout=5,
        )
        quota_mounts = []
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                parts = line.split(None, 1)
                if len(parts) == 2 and any(
                    opt in parts[1] for opt in ("uquota", "usrquota", "pquota", "prjquota")
                ):
                    quota_mounts.append(parts[0])
        if quota_mounts:
            lines.append(f"  Disk Quotas: {GRN}ENABLED{NC} on {', '.join(quota_mounts)}")
        else:
            lines.append(f"  Disk Quotas: {YLW}Not enabled{NC}")
            lines.append(f"  {DIM}(Mount XFS with uquota option to enable){NC}")
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


def _change_password_sync(username: str, password: str) -> tuple[bool, str]:
    p = subprocess.run(
        ["chpasswd"],
        input=f"{username}:{password}\n",
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        return False, p.stderr.strip()
    return True, ""


def _get_lock_status(username: str) -> bool:
    """Return True if account is locked."""
    r = subprocess.run(
        ["passwd", "-S", username],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return False
    fields = r.stdout.split()
    return len(fields) >= 2 and fields[1] == "L"


def _get_user_groups(username: str) -> list[str]:
    r = subprocess.run(
        ["id", "-Gn", username],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return []
    return r.stdout.strip().split()


def _get_all_groups() -> list[tuple[str, int]]:
    """Return (name, gid) for groups with GID >= 1000."""
    result: list[tuple[str, int]] = []
    try:
        for g in grp.getgrall():
            if g.gr_gid >= _UID_MIN:
                result.append((g.gr_name, g.gr_gid))
    except Exception:
        pass
    return sorted(result)
