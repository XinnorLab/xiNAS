"""UsersScreen — user management and disk quota."""
from __future__ import annotations

import asyncio
import grp
import pwd
import subprocess
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Label

from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.text_view import ScrollableTextView

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
        Binding("escape", "app.pop_screen", "Back", show=False),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  ── User Management ──", id="screen-title")
        yield NavigableMenu(_MENU, id="users-nav")
        yield ScrollableTextView(id="users-content")

    def on_mount(self) -> None:
        asyncio.create_task(self._list_users())

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            asyncio.create_task(self._list_users())
        elif key == "2":
            asyncio.create_task(self._create_user())
        elif key == "3":
            asyncio.create_task(self._delete_user())
        elif key == "4":
            asyncio.create_task(self._set_quota())
        elif key == "5":
            asyncio.create_task(self._show_quotas())

    async def _list_users(self) -> None:
        loop = asyncio.get_event_loop()
        users = await loop.run_in_executor(None, _get_local_users)
        view = self.query_one("#users-content", ScrollableTextView)
        view.set_content(_format_users(users))

    async def _create_user(self) -> None:
        username = await self.app.push_screen_wait(
            InputDialog("New username:", "Create User")
        )
        if not username:
            return

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

        loop = asyncio.get_event_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _create_user_sync(username, home, password)
        )
        if ok:
            self.app.audit.log("user.create", username, "OK")
            await self._list_users()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _delete_user(self) -> None:
        username = await self.app.push_screen_wait(
            InputDialog("Username to delete:", "Delete User")
        )
        if not username:
            return

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Delete user '{username}'? Home directory will be kept.", "Confirm")
        )
        if not confirmed:
            return

        loop = asyncio.get_event_loop()
        ok, err = await loop.run_in_executor(
            None, lambda: _run_cmd("userdel", username)
        )
        if ok:
            self.app.audit.log("user.delete", username, "OK")
            await self._list_users()
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _set_quota(self) -> None:
        username = await self.app.push_screen_wait(
            InputDialog("Username:", "Set Disk Quota")
        )
        if not username:
            return

        export_path = await self.app.push_screen_wait(
            InputDialog("Export path:", "Set Disk Quota", placeholder="/mnt/data/")
        )
        if not export_path:
            return

        soft_str = await self.app.push_screen_wait(
            InputDialog("Soft limit (GB, 0=none):", "Set Disk Quota", default="0")
        )
        if soft_str is None:
            return

        hard_str = await self.app.push_screen_wait(
            InputDialog("Hard limit (GB, 0=none):", "Set Disk Quota", default="0")
        )
        if hard_str is None:
            return

        try:
            soft_kb = int(float(soft_str) * 1024 * 1024)
            hard_kb = int(float(hard_str) * 1024 * 1024)
        except ValueError:
            await self.app.push_screen_wait(ConfirmDialog("Invalid quota value.", "Error"))
            return

        loop = asyncio.get_event_loop()
        ok, _, err = await loop.run_in_executor(
            None,
            lambda: self.app.nfs.set_quota(export_path, soft_kb, hard_kb),
        )
        if ok:
            self.app.audit.log("user.quota", f"{username}@{export_path}", "OK")
            await self.app.push_screen_wait(ConfirmDialog("Quota set.", "Done"))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error"))

    async def _show_quotas(self) -> None:
        loop = asyncio.get_event_loop()
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
    lines = ["[bold]Local Users (UID >= 1000)[/bold]\n"]
    for u in sorted(users, key=lambda x: x.pw_uid):
        lines.append(
            f"  [cyan]{u.pw_name:<20}[/cyan]  uid={u.pw_uid}  {u.pw_dir}"
        )
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
