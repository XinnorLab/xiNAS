"""NFSScreen — NFS export management with structured share wizards."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

_log = logging.getLogger(__name__)

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.api.control_client import ControlPathError, lease_conflict_message, quote_id
from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.utils.xfs_helpers import is_path_under
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.text_view import ScrollableTextView
from xinas_menu.widgets.wizard import BACK, CANCEL, WizardStep, run_wizard

_HOST_CHOICES = [
    "Everyone (any host on the network)",
    "Specific network (e.g., 192.168.1.0/24)",
    "Single host (by IP address)",
]
_CUSTOM_PATH = "Custom path…"


def _host_prefill(host: str) -> tuple[str, str]:
    """Map a stored export host to (selected radio label, "(Current:)" hint)."""
    if host == "*":
        return _HOST_CHOICES[0], "Everyone"
    if "/" in host:
        return _HOST_CHOICES[1], f"Network {host}"
    return _HOST_CHOICES[2], f"Host {host}"


def _path_prefill(stored: str, mount_points: list[str]) -> tuple[str | None, str]:
    """Map a stored path to (SelectDialog pre-selection, custom-input default).

    The custom-input default is the first xiRAID mount root with a trailing
    slash (falling back to ``/mnt/data/`` only when the list is empty), so the
    custom-path field always starts inside a valid xiRAID filesystem.

    Returns ``(mount, <default>)`` when *stored* is one of *mount_points*,
    ``("Custom path…", stored)`` when it is a non-empty non-mount path, and
    ``(None, <default>)`` when *stored* is empty (first entry).
    """
    default = (mount_points[0].rstrip("/") + "/") if mount_points else "/mnt/data/"
    if not stored:
        return None, default
    if stored in mount_points:
        return stored, default
    return _CUSTOM_PATH, stored


def _xiraid_mount_points(findmnt_output: str) -> list[str]:
    """Return the TARGET mountpoints backed by a xiRAID volume (``/dev/xi_*``).

    *findmnt_output* is the raw text of ``findmnt -t xfs -n -o TARGET,SOURCE``
    (one ``<target> <source>`` row per line). Only rows whose SOURCE begins with
    ``/dev/xi_`` are kept — that is xiNAS's block-device namespace for xiRAID
    arrays.
    """
    mounts: list[str] = []
    for line in findmnt_output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.rsplit(None, 1)
        if len(parts) == 2 and parts[1].startswith("/dev/xi_"):
            mounts.append(parts[0])
    return mounts


def _share_summary(
    path: str,
    host: str,
    access: str,
    root_squash: str,
    sync_mode: str,
    sec: str,
    options: list[str],
) -> str:
    access_label = "Read & Write" if access == "rw" else "Read Only"
    admin_label = "Yes (no_root_squash)" if root_squash == "no_root_squash" else "No (root_squash)"
    sync_label = "Sync (safer)" if sync_mode == "sync" else "Async (faster)"
    sec_labels = {
        "sys": "Standard UID/GID",
        "krb5": "Kerberos",
        "krb5i": "Kerberos + integrity",
        "krb5p": "Kerberos + encryption",
    }
    return (
        f"Path:       {path}\n"
        f"Access:     {host}\n"
        f"Permission: {access_label}\n"
        f"Admin:      {admin_label}\n"
        f"Sync:       {sync_label}\n"
        f"Security:   {sec_labels.get(sec, sec)}\n"
        f"Options:    {','.join(options)}"
    )


_MENU = [
    MenuItem("1", "Show NFS Exports"),
    MenuItem("2", "Add Share"),
    MenuItem("3", "Edit Share"),
    MenuItem("4", "Remove Share"),
    MenuItem("5", "Active Sessions"),
    MenuItem("6", "Configure idmapd Domain"),
    MenuItem("0", "Back"),
]


class NFSScreen(XiNASAppMixin, Screen):
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
        view = self.query_one("#nfs-content", ScrollableTextView)
        try:
            shares = await asyncio.to_thread(self.app.control.result, "/api/v1/shares")
        except ControlPathError as exc:
            view.set_content(f"[yellow]Control API: {exc}[/yellow]")
            return
        view.set_content(_format_exports(_rows_from_api(shares)))

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

    async def _get_exports(self) -> list[dict]:
        """Fetch shares from the control-path API, adapted to legacy rows."""
        try:
            shares = await asyncio.to_thread(self.app.control.result, "/api/v1/shares")
        except ControlPathError:
            return []
        return [e for e in _rows_from_api(shares) if e.get("path") and e.get("id")]

    def _task_progress(self, label: str):
        """Build an ``on_progress`` callback for ``plan_apply_wait``.

        ``plan_apply_wait`` runs in a worker thread, so the callback hops
        back to the UI thread before raising the toast.
        """

        def _cb(state: str) -> None:
            self.app.call_from_thread(self.app.notify, f"{label}: task {state}", timeout=4)

        return _cb

    # ── Shared access-control steps (host / perms / admin / sync / security) ──

    def _access_steps(self, prefix: str, total: int) -> list[WizardStep]:
        """Build the 5 shared access-control steps.

        Each step reads its working value from ``answers`` (retained across
        Back) and, when ``answers`` carries an ``_orig`` snapshot (Edit),
        annotates the prompt with the share's original value.
        """

        def title(step_no: int) -> str:
            return f"{prefix} — Step {step_no}/{total}"

        def orig(answers: dict) -> dict | None:
            return answers.get("_orig")

        async def host_step(answers, allow_back, step_no):
            while True:
                cur_host = answers.get("host", "*")
                selected, _ = _host_prefill(cur_host)
                prompt = "Who should be able to connect?"
                o = orig(answers)
                if o is not None:
                    _, hint = _host_prefill(o.get("host", "*"))
                    prompt += f"\n(Current: {hint})"
                who = await self.app.push_screen_wait(
                    SelectDialog(
                        _HOST_CHOICES,
                        title=title(step_no),
                        prompt=prompt,
                        selected=selected,
                        allow_back=allow_back,
                    )
                )
                if who is None:
                    return CANCEL
                if who is BACK:
                    return BACK
                if who.startswith("Everyone"):
                    return "*"
                if who.startswith("Specific"):
                    default = cur_host if "/" in cur_host else "192.168.1.0/24"
                    sub = await self.app.push_screen_wait(
                        InputDialog(
                            "Network address:",
                            title(step_no),
                            default=default,
                            placeholder="192.168.1.0/24",
                            allow_back=True,
                        )
                    )
                else:
                    default = cur_host if (cur_host != "*" and "/" not in cur_host) else ""
                    sub = await self.app.push_screen_wait(
                        InputDialog(
                            "Host IP address:",
                            title(step_no),
                            default=default,
                            placeholder="192.168.1.100",
                            allow_back=True,
                        )
                    )
                if sub is None:
                    return CANCEL
                if sub is BACK:
                    continue  # back to the who-select
                if not sub:
                    self.app.notify("Host/network must not be empty.", severity="error")
                    continue
                return sub

        access_choices = [
            "Read & Write (can add, edit, delete files)",
            "Read Only (can only view files)",
        ]
        admin_choices = [
            "Yes - Full admin access (recommended)",
            "No - Limited access (more secure)",
        ]
        sync_choices = [
            "Sync - confirm after writing to disk (safer, recommended)",
            "Async - confirm immediately (faster, risk of data loss on crash)",
        ]
        sec_choices = [
            "Standard UID/GID (default)",
            "Kerberos authentication",
            "Kerberos + integrity",
            "Kerberos + encryption",
        ]
        _SEC_MAP = {
            "Standard": "sys",
            "Kerberos authentication": "krb5",
            "Kerberos + integrity": "krb5i",
            "Kerberos + encryption": "krb5p",
        }
        _SEC_LABELS = {
            "sys": "Standard UID/GID",
            "krb5": "Kerberos",
            "krb5i": "Kerberos + integrity",
            "krb5p": "Kerberos + encryption",
        }

        def _sec_value(choice: str) -> str:
            for key, val in _SEC_MAP.items():
                if choice.startswith(key):
                    return val
            return "sys"

        steps: list[WizardStep] = [WizardStep(key="host", run=host_step)]

        async def access_run_fn(answers, allow_back, step_no):
            cur = answers.get("access", "rw")
            selected = access_choices[0] if cur == "rw" else access_choices[1]
            prompt = "What can connected hosts do?"
            o = orig(answers)
            if o is not None:
                prompt += "\n(Current: %s)" % (
                    "Read & Write" if o.get("access") == "rw" else "Read Only"
                )
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    access_choices,
                    title=title(step_no),
                    prompt=prompt,
                    selected=selected,
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return "rw" if pick.startswith("Read & Write") else "ro"

        async def admin_run_fn(answers, allow_back, step_no):
            cur = answers.get("root_squash", "no_root_squash")
            selected = admin_choices[0] if cur == "no_root_squash" else admin_choices[1]
            prompt = "Allow full administrator access?"
            o = orig(answers)
            if o is not None:
                prompt += "\n(Current: %s)" % (
                    "Yes" if o.get("root_squash") == "no_root_squash" else "No"
                )
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    admin_choices,
                    title=title(step_no),
                    prompt=prompt,
                    selected=selected,
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return "no_root_squash" if pick.startswith("Yes") else "root_squash"

        async def sync_run_fn(answers, allow_back, step_no):
            cur = answers.get("sync_mode", "sync")
            selected = sync_choices[0] if cur == "sync" else sync_choices[1]
            prompt = "When should the server confirm writes?"
            o = orig(answers)
            if o is not None:
                prompt += "\n(Current: %s)" % (
                    "Sync (safer)" if o.get("sync_mode") == "sync" else "Async (faster)"
                )
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    sync_choices,
                    title=title(step_no),
                    prompt=prompt,
                    selected=selected,
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return "sync" if pick.startswith("Sync") else "async"

        async def sec_run_fn(answers, allow_back, step_no):
            cur = answers.get("sec", "sys")
            selected = next((c for c in sec_choices if _sec_value(c) == cur), sec_choices[0])
            prompt = "Select authentication mode:"
            o = orig(answers)
            if o is not None:
                cur_sec = o.get("sec", "sys")
                prompt += f"\n(Current: {_SEC_LABELS.get(cur_sec, cur_sec)})"
            pick = await self.app.push_screen_wait(
                SelectDialog(
                    sec_choices,
                    title=title(step_no),
                    prompt=prompt,
                    selected=selected,
                    allow_back=allow_back,
                )
            )
            if pick is None:
                return CANCEL
            if pick is BACK:
                return BACK
            return _sec_value(pick)

        steps.append(WizardStep(key="access", run=access_run_fn))
        steps.append(WizardStep(key="root_squash", run=admin_run_fn))
        steps.append(WizardStep(key="sync_mode", run=sync_run_fn))
        steps.append(WizardStep(key="sec", run=sec_run_fn))
        return steps

    # ── Wizard: Add Share ────────────────────────────────────────────────

    @work(exclusive=True)
    async def _add_share_wizard(self) -> None:
        """7-step share creation wizard with Back navigation."""
        from xinas_menu.utils.xfs_helpers import run_async_cmd

        mount_points: list[str] = []
        ok, out, _ = await run_async_cmd(
            "findmnt", "-t", "xfs", "-n", "-o", "TARGET,SOURCE", timeout=10
        )
        if not ok:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "Couldn't read the mount table (findmnt failed), so the "
                    "available xiRAID filesystems can't be determined.\n\n"
                    "Check the system and try again.",
                    "Add Share",
                    ok_only=True,
                )
            )
            return
        if out:
            mount_points = _xiraid_mount_points(out)

        if not mount_points:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    "No xiRAID-backed filesystem found.\n\n"
                    "NFS shares can only be exported from a filesystem on a "
                    "xiRAID array. Create one first:\n"
                    "Storage → Filesystems → Create Filesystem.",
                    "Add Share",
                    ok_only=True,
                )
            )
            return

        async def path_step(answers, allow_back, step_no):
            stored = answers.get("path", "")
            title = f"Add Share — Step {step_no}/7"
            while True:
                selected, custom_default = _path_prefill(stored, mount_points)
                choice = await self.app.push_screen_wait(
                    SelectDialog(
                        mount_points + [_CUSTOM_PATH],
                        title=title,
                        prompt="Select filesystem to export (or choose custom for a subfolder):",
                        selected=selected,
                        allow_back=allow_back,
                    )
                )
                if choice is None:
                    return CANCEL
                if choice is BACK:
                    return BACK
                if choice == _CUSTOM_PATH:
                    sub = await self.app.push_screen_wait(
                        InputDialog(
                            "Export path:",
                            title,
                            default=custom_default,
                            placeholder="/mnt/data/share1",
                            allow_back=True,
                        )
                    )
                    if sub is None:
                        return CANCEL
                    if sub is BACK:
                        continue
                    path = sub
                else:
                    path = choice
                if not path.startswith("/"):
                    self.app.notify("Export path must start with '/'.", severity="error")
                    continue
                path = os.path.normpath(path)
                if not any(is_path_under(path, mp) for mp in mount_points):
                    self.app.notify(
                        "Export path must be inside a xiRAID filesystem "
                        f"({', '.join(mount_points)}).",
                        severity="error",
                    )
                    continue
                return path

        async def confirm_step(answers, allow_back, step_no):
            host = answers["host"]
            access = answers["access"]
            root_squash = answers["root_squash"]
            sync_mode = answers["sync_mode"]
            sec = answers["sec"]
            options = [access, sync_mode, "no_subtree_check", root_squash]
            if sec != "sys":
                options.append(f"sec={sec}")
            summary = _share_summary(
                answers["path"], host, access, root_squash, sync_mode, sec, options
            )
            result = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Create this export?\n\n{summary}",
                    f"Add Share — Step {step_no}/7",
                    allow_back=allow_back,
                )
            )
            if result is BACK:
                return BACK
            return True if result is True else CANCEL

        steps = (
            [WizardStep(key="path", run=path_step)]
            + self._access_steps("Add Share", total=7)
            + [WizardStep(key="confirmed", run=confirm_step)]
        )
        answers = await run_wizard(steps)
        if answers is None:
            return

        path = answers["path"]
        host = answers["host"]
        access = answers["access"]
        root_squash = answers["root_squash"]
        sync_mode = answers["sync_mode"]
        sec = answers["sec"]

        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, lambda: os.makedirs(path, exist_ok=True))
        except OSError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Cannot create directory:\n{exc}", "Error", ok_only=True)
            )
            return

        used: set[int] = set()
        for row in await self._get_exports():
            fsid = row.get("fsid")
            if isinstance(fsid, int):
                used.add(fsid)
            elif isinstance(fsid, str) and fsid.strip().lstrip("-").isdigit():
                used.add(int(fsid))
        spec: dict[str, Any] = {
            "path": path,
            "fsid": max(used, default=0) + 1,
            "clients": [{"pattern": host, "options": [access, root_squash, "no_subtree_check"]}],
            "sync": sync_mode,
        }
        if sec != "sys":
            spec["security_mode"] = sec
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                "/api/v1/shares",
                spec,
                on_progress=self._task_progress("Add Share"),
            )
        except ControlPathError as exc:
            await self._show_control_error(exc)
            return
        self.app.audit.log("nfs.add_export", path, "OK")
        await self.app.snapshots.record("share_create", diff_summary=f"Added NFS share {path}")
        self._load_exports()

    @work(exclusive=True)
    async def _edit_share(self) -> None:
        """7-step edit share wizard with Back navigation."""
        exports = await self._get_exports()
        if not exports:
            await self.app.push_screen_wait(
                ConfirmDialog("No shares configured.", "Edit Share", ok_only=True)
            )
            return
        paths = [e["path"] for e in exports]

        async def select_step(answers, allow_back, step_no):
            choice = await self.app.push_screen_wait(
                SelectDialog(
                    paths,
                    title=f"Edit Share — Step {step_no}/7",
                    prompt="Select export to edit:",
                    selected=answers.get("path"),
                    allow_back=allow_back,
                )
            )
            if choice is None:
                return CANCEL
            if choice is BACK:
                return BACK
            if choice != answers.get("path"):
                export = next((e for e in exports if e["path"] == choice), {})
                share_id = str(export.get("id", ""))
                if not share_id:
                    await self.app.push_screen_wait(
                        ConfirmDialog("Share not found.", "Edit Share", ok_only=True)
                    )
                    return CANCEL
                current = _parse_current_export(export)
                answers["_orig"] = current
                answers["share_id"] = share_id
                for k in ("host", "access", "root_squash", "sync_mode", "sec"):
                    answers[k] = current[k]
            return choice

        async def confirm_step(answers, allow_back, step_no):
            host = answers["host"]
            access = answers["access"]
            root_squash = answers["root_squash"]
            sync_mode = answers["sync_mode"]
            sec = answers["sec"]
            extra = answers["_orig"]["extra_opts"]
            options = [access, sync_mode, root_squash]
            if sec != "sys":
                options.append(f"sec={sec}")
            options.extend(extra)
            summary = _share_summary(
                answers["path"], host, access, root_squash, sync_mode, sec, options
            )
            result = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Update this export?\n\n{summary}",
                    f"Edit Share — Step {step_no}/7",
                    allow_back=allow_back,
                )
            )
            if result is BACK:
                return BACK
            return True if result is True else CANCEL

        steps = (
            [WizardStep(key="path", run=select_step)]
            + self._access_steps("Edit Share", total=7)
            + [WizardStep(key="confirmed", run=confirm_step)]
        )
        answers = await run_wizard(steps)
        if answers is None:
            return

        host = answers["host"]
        access = answers["access"]
        root_squash = answers["root_squash"]
        sync_mode = answers["sync_mode"]
        sec = answers["sec"]
        share_id = answers["share_id"]
        extra = answers["_orig"]["extra_opts"]

        patch: dict[str, Any] = {
            "clients": [{"pattern": host, "options": [access, root_squash, *extra]}],
            "sync": sync_mode,
            "security_mode": sec,
        }
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/shares/{quote_id(share_id)}",
                patch,
                on_progress=self._task_progress("Edit Share"),
            )
        except ControlPathError as exc:
            await self._show_control_error(exc)
            return
        self.app.audit.log("nfs.update_export", answers["path"], "OK")
        await self.app.snapshots.record(
            "share_modify", diff_summary=f"Updated NFS share {answers['path']}"
        )
        self._load_exports()

    # NOT a @work worker: callers `await` this inline to show the dialog and
    # return. textual 8.x Workers are not awaitable (Worker has no __await__),
    # so decorating it with @work breaks `await self._show_control_error(...)`
    # at both type-check and runtime.
    async def _show_control_error(self, exc: ControlPathError) -> None:
        """Render a control-path failure. A transient lease conflict gets a
        calm "busy, retry" dialog (the resource is locked by another task and
        the lock is short-lived — the periodic sweep bounds it); everything
        else keeps the plain ``Failed: …`` message."""
        locked = lease_conflict_message(exc)
        if locked is not None:
            await self.app.push_screen_wait(ConfirmDialog(locked, "Resource Busy", ok_only=True))
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {exc}", "Error", ok_only=True))

    @work(exclusive=True)
    async def _remove_share(self) -> None:
        exports = await self._get_exports()
        if not exports:
            await self.app.push_screen_wait(
                ConfirmDialog("No shares configured.", "Remove Share", ok_only=True)
            )
            return
        paths = [e["path"] for e in exports]
        path = await self.app.push_screen_wait(
            SelectDialog(paths, title="Remove Share", prompt="Select export to remove:")
        )
        if not path:
            return
        share = next((e for e in exports if e["path"] == path), {})
        share_id = str(share.get("id", ""))
        if not share_id:
            await self.app.push_screen_wait(
                ConfirmDialog("Share not found.", "Remove Share", ok_only=True)
            )
            return
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(f"Remove export {path}?", "Confirm Removal")
        )
        if not confirmed:
            return
        # The delete plan spec is built server-side from the desired share
        # ({id, path}); risk is changing_access, so no dangerous flag.
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "DELETE",
                f"/api/v1/shares/{quote_id(share_id)}",
                {},
                on_progress=self._task_progress("Remove Share"),
            )
        except ControlPathError as exc:
            await self._show_control_error(exc)
            return
        self.app.audit.log("nfs.remove_export", path, "OK")
        await self.app.snapshots.record(
            "share_delete",
            diff_summary=f"Removed NFS share {path}",
        )
        self._load_exports()

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
                InputDialog(
                    "NFS4 idmapd domain:", "Configure idmapd Domain", placeholder="example.com"
                )
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
                "nfs_modify",
                diff_summary=f"Set idmapd domain to {domain}",
            )
            await self.app.push_screen_wait(
                ConfirmDialog("idmapd domain updated.", "Done", ok_only=True)
            )
        else:
            await self.app.push_screen_wait(ConfirmDialog(f"Failed: {err}", "Error", ok_only=True))


def _rows_from_api(shares: Any) -> list[dict]:
    """Adapt GET /api/v1/shares docs to the legacy export-row shape.

    The API returns ``{id, spec: {path, clients: [{pattern, options}],
    fsid, sync?, security_mode?}, status: {...}}`` per share; the renderer
    and the edit wizard parse ``{path, clients: [{host, options}]}``. The
    share-level ``sync``/``security_mode`` fields are folded into each
    client's option list (mirroring the server's exports compile) so
    ``_parse_current_export`` and the display keep working unchanged.
    """
    rows: list[dict] = []
    if not isinstance(shares, list):
        return rows
    for doc in shares:
        if not isinstance(doc, dict):
            continue
        spec = doc.get("spec")
        if not isinstance(spec, dict):
            continue
        path = spec.get("path")
        if not path:
            continue
        sync = spec.get("sync")
        sec = spec.get("security_mode")
        clients: list[dict] = []
        raw_clients = spec.get("clients")
        for c in raw_clients if isinstance(raw_clients, list) else []:
            if not isinstance(c, dict):
                continue
            raw_opts = c.get("options")
            opts = [o for o in raw_opts if isinstance(o, str)] if isinstance(raw_opts, list) else []
            if sync in ("sync", "async") and not any(o in ("sync", "async") for o in opts):
                opts.append(sync)
            if (
                isinstance(sec, str)
                and sec != "sys"
                and not any(o.startswith("sec=") for o in opts)
            ):
                opts.append(f"sec={sec}")
            clients.append({"host": str(c.get("pattern", "*")), "options": opts})
        rows.append(
            {
                "id": doc.get("id"),
                "path": path,
                "fsid": spec.get("fsid"),
                "clients": clients,
            }
        )
    return rows


_WIZARD_MANAGED_OPTS = {"rw", "ro", "root_squash", "no_root_squash", "sync", "async"}


def _parse_current_export(export: dict) -> dict:
    """Extract structured wizard values from an export dict."""
    clients = export.get("clients", [])
    if not clients:
        return {
            "host": "*",
            "access": "rw",
            "root_squash": "no_root_squash",
            "sync_mode": "sync",
            "sec": "sys",
            "extra_opts": [],
        }
    client = clients[0] if isinstance(clients[0], dict) else {}
    host = client.get("host", "*") if client else "*"
    opts = client.get("options", []) if client else []

    access = "ro" if "ro" in opts else "rw"
    root_squash = (
        "root_squash"
        if ("root_squash" in opts and "no_root_squash" not in opts)
        else "no_root_squash"
    )
    sync_mode = "async" if "async" in opts else "sync"
    sec = "sys"
    extra: list[str] = []
    for o in opts:
        if o.startswith("sec="):
            sec = o.split("=", 1)[1]
        elif o not in _WIZARD_MANAGED_OPTS:
            extra.append(o)
    return {
        "host": host,
        "access": access,
        "root_squash": root_squash,
        "sync_mode": sync_mode,
        "sec": sec,
        "extra_opts": extra,
    }


def _format_exports(data: Any) -> str:
    """Format NFS exports — uses socket data if available, falls back to /etc/exports."""
    import os
    import shlex
    import subprocess

    GRN, _YLW, RED, CYN, BLD, DIM, NC = (
        "\033[32m",
        "\033[33m",
        "\033[31m",
        "\033[36m",
        "\033[1m",
        "\033[2m",
        "\033[0m",
    )
    W = 65
    lines: list[str] = []

    def _run(cmd: str) -> str:
        try:
            return subprocess.check_output(
                shlex.split(cmd),
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
        except Exception:
            _log.debug("command failed: %s", cmd, exc_info=True)
            return ""

    def _share_usage(path: str) -> str:
        try:
            r = subprocess.run(
                ["df", "-h", path],
                capture_output=True,
                text=True,
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
                return {
                    "sys": "Standard (UID/GID)",
                    "krb5": "Kerberos",
                    "krb5i": "Kerberos+integrity",
                    "krb5p": "Kerberos+encryption",
                }.get(s, s)
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
            client_specs: list = clients or [{"host": "*", "options": []}]
            for c in client_specs:
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
                                addr = ln.split("address:")[1].strip().strip('"').strip("'")
                                # strip port (last :N component)
                                ip = addr.rsplit(":", 1)[0] if ":" in addr else addr
                                if ip and ip not in clients:
                                    clients.append(ip)
                except Exception:
                    _log.debug("failed to read NFS client info %s", entry, exc_info=True)
    if not clients:
        try:
            result = subprocess.run(
                ["ss", "-tn", "state", "established", "( dport = :2049 )"],
                capture_output=True,
                text=True,
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
            if isinstance(s, dict):
                # nfs.list_sessions() returns {client_ip, nfs_version,
                # export_path, active_locks} (spec §4.8). Read those keys —
                # the old client/path keys never exist in that shape, so every
                # row rendered as "?  ->  ?". Keep client/path as a fallback so
                # an alternate session source still renders.
                client = s.get("client_ip") or s.get("client") or "?"
                path = s.get("export_path") or s.get("path") or "?"
            else:
                client, path = str(s), ""
            lines.append(f"  {client}  ->  {path}")
    except Exception as exc:
        lines.append(f"(parse error: {exc})")
    return "\n".join(lines)
