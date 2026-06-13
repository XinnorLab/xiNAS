"""FilesystemScreen — Create and manage XFS filesystems on xiRAID arrays.

S8 T14b (ADR-0010, s8-clients-spec §1 T13b): the screen rides the
control-path API. List reads come from ``GET /api/v1/filesystems``;
create is ONE plan→apply ``POST /api/v1/filesystems`` (the fs.create
task runs mkfs + mount unit + mount); quota changes are one-intent
``PATCH`` calls; delete is a stop-on-failure SEQUENCE (shares delete →
unmount PATCH → unmanage DELETE) with NO cross-step rollback — each
step's task carries its own rollback. The direct mkfs.xfs / findmnt /
mount-unit / unmount helpers left the screen; the device picker reads
``GET /api/v1/arrays`` instead of gRPC ``raid_show``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, Label

from xinas_menu.api.control_client import ControlPathError, TaskCancelled, TaskFailed
from xinas_menu.apptype import XiNASAppMixin
from xinas_menu.widgets.confirm_dialog import ConfirmDialog
from xinas_menu.widgets.input_dialog import InputDialog
from xinas_menu.widgets.menu_list import MenuItem, NavigableMenu
from xinas_menu.widgets.select_dialog import SelectDialog
from xinas_menu.widgets.task_wait_dialog import TaskWaitDialog
from xinas_menu.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

_MENU = [
    MenuItem("1", "Show Filesystems"),
    MenuItem("2", "Create Filesystem"),
    MenuItem("3", "Delete Filesystem"),
    MenuItem("4", "Manage Quotas"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

# RAID levels typically used as data vs log arrays
_DATA_LEVELS = {"5", "6", "50", "60"}
_LOG_LEVELS = {"0", "1", "10"}

# Day-1 raid_fs mount options (logdev + quota flag ride the structured
# spec fields — log_device / quota_mode — per the fs.create contract).
_DEFAULT_MOUNT_OPTIONS = [
    "noatime",
    "nodiratime",
    "logbsize=256k",
    "largeio",
    "inode64",
    "swalloc",
    "allocsize=131072k",
]


def _classify_role(level: str) -> str:
    """Suggest 'data' or 'log' based on RAID level."""
    if str(level) in _DATA_LEVELS:
        return "data"
    return "log"


def _level_label(level: Any) -> str:
    """API level ('raid5' / 'n+m') → display label ('5' / 'n+m')."""
    text = str(level or "?")
    return text[4:] if text.startswith("raid") and len(text) > 4 else text


def _array_label(arr: dict) -> str:
    """Format array info for selection dialog."""
    name = arr.get("name", "?")
    level = arr.get("level", "?")
    devices = arr.get("devices", [])
    dev_count = len(devices) if isinstance(devices, list) else 0
    strip = arr.get("strip_size", "?")
    role_hint = _classify_role(level)
    return f"{name}  (RAID-{level}, {dev_count} drives, {strip}KB strip)  [{role_hint}]"


def _arrays_from_api(rows: Any) -> list[dict[str, Any]]:
    """Adapt GET /api/v1/arrays docs to the wizard's array dict shape."""
    arrays: list[dict[str, Any]] = []
    for doc in rows if isinstance(rows, list) else []:
        if not isinstance(doc, dict):
            continue
        spec = doc.get("spec")
        spec = spec if isinstance(spec, dict) else {}
        status = doc.get("status")
        status = status if isinstance(status, dict) else {}
        name = str(doc.get("id") or spec.get("name") or "")
        if not name:
            continue
        arrays.append(
            {
                "name": name,
                "level": _level_label(spec.get("level")),
                "devices": [str(m) for m in spec.get("member_disk_ids") or []],
                "strip_size": spec.get("strip_size_kib", "?"),
                "volume_path": str(status.get("volume_path") or f"/dev/xi_{name}"),
            }
        )
    return arrays


def _fs_rows_from_api(rows: Any) -> list[dict[str, Any]]:
    """Adapt GET /api/v1/filesystems docs to the screen's row shape.

    API rows are ``{id (mount-unit name), spec?, status: {mountpoint,
    backing_device, mounted, mount_options, effective_mount_options,
    size_bytes, free_bytes, label, uuid, ...}}``.
    """
    out: list[dict[str, Any]] = []
    for doc in rows if isinstance(rows, list) else []:
        if not isinstance(doc, dict):
            continue
        fid = doc.get("id")
        if fid is None:
            continue
        status = doc.get("status")
        status = status if isinstance(status, dict) else {}
        options = status.get("effective_mount_options") or status.get("mount_options") or []
        options = [str(o) for o in options] if isinstance(options, list) else []
        out.append(
            {
                "id": str(fid),
                "mountpoint": str(status.get("mountpoint") or ""),
                "backing_device": str(status.get("backing_device") or ""),
                "mounted": status.get("mounted") is True,
                "options": options,
                "size_bytes": status.get("size_bytes"),
                "free_bytes": status.get("free_bytes"),
                "label": str(status.get("label") or ""),
            }
        )
    return out


def _volumes_in_use(fs_rows: list[dict[str, Any]]) -> set[str]:
    """Volume paths consumed by managed filesystems (data OR log device)."""
    used: set[str] = set()
    for fs in fs_rows:
        if fs.get("backing_device"):
            used.add(str(fs["backing_device"]))
        for opt in fs.get("options") or []:
            if isinstance(opt, str) and opt.startswith("logdev="):
                used.add(opt[len("logdev=") :])
    return used


def _is_under(path: str, root: str) -> bool:
    """True when ``path`` is at or under ``root`` (path-segment aware)."""
    if path == root:
        return True
    prefix = root if root.endswith("/") else root + "/"
    return path.startswith(prefix)


def _fmt_size(size_bytes: Any) -> str:
    """Format byte count into human-readable string."""
    if not isinstance(size_bytes, int | float) or size_bytes <= 0:
        return "N/A"
    value = float(size_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if value < 1024:
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} EB"


def _quota_flags(options: list[str]) -> dict[str, bool]:
    """Quota enablement flags from a mount-options list.

    Group quotas are parsed but not exposed in the TUI — XFS+NFS
    setups use user and project quotas exclusively.
    """
    opts = {o.strip() for o in options}
    return {
        "user": bool(opts & {"uquota", "usrquota"}),
        "project": bool(opts & {"pquota", "prjquota"}),
        "group": bool(opts & {"gquota", "grpquota"}),
    }


class FilesystemScreen(XiNASAppMixin, Screen):
    """Filesystem management — show existing and create new XFS filesystems."""

    BINDINGS = [
        Binding("escape", "app.pop_screen", "Back", show=True, key_display="0/Esc"),
        Binding("0", "app.pop_screen", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Filesystem", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_MENU, id="fs-nav")
            yield ScrollableTextView(id="fs-content")
        yield Footer()

    def on_mount(self) -> None:
        BLD, DIM, CYN, NC = "\033[1m", "\033[2m", "\033[36m", "\033[0m"
        view = self.query_one("#fs-content", ScrollableTextView)
        view.set_content(
            f"{BLD}{CYN}Filesystem Management{NC}\n\n"
            f"  {BLD}1{NC}  {CYN}Show Filesystems{NC}    {DIM}Display currently mounted XFS filesystems{NC}\n"
            f"  {BLD}2{NC}  {CYN}Create Filesystem{NC}   {DIM}Create optimized XFS on xiRAID arrays{NC}\n"
            f"  {BLD}3{NC}  {CYN}Delete Filesystem{NC}   {DIM}Unmount and remove XFS filesystem{NC}\n"
            f"  {BLD}4{NC}  {CYN}Manage Quotas{NC}       {DIM}Enable/disable user & project quotas{NC}\n"
        )

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            self._show_filesystems()
        elif key == "2":
            self._create_filesystem_wizard()
        elif key == "3":
            self._delete_filesystem()
        elif key == "4":
            self._manage_quotas()

    # ── Task progress plumbing ────────────────────────────────────────────

    def _task_progress(self, label: str):
        """Build an ``on_progress`` callback for ``plan_apply_wait``.

        ``plan_apply_wait`` runs in a worker thread, so the callback hops
        back to the UI thread before raising the toast.
        """

        def _cb(state: str) -> None:
            self.app.call_from_thread(self.app.notify, f"{label}: task {state}", timeout=4)

        return _cb

    async def _list_filesystems(self) -> list[dict[str, Any]]:
        """GET /api/v1/filesystems adapted to the screen's row shape."""
        rows = await asyncio.to_thread(self.app.control.result, "/api/v1/filesystems")
        return _fs_rows_from_api(rows)

    # ── Show Filesystems ──────────────────────────────────────────────────

    @work(exclusive=True)
    async def _show_filesystems(self) -> None:
        """Display managed XFS filesystems (GET /api/v1/filesystems)."""
        view = self.query_one("#fs-content", ScrollableTextView)
        view.set_content("  Scanning filesystems...")

        GRN, BLD, DIM, YLW, CYN, NC = (
            "\033[32m",
            "\033[1m",
            "\033[2m",
            "\033[33m",
            "\033[36m",
            "\033[0m",
        )
        lines = [f"{BLD}{CYN}XFS Filesystems{NC}\n"]

        try:
            fs_rows = await self._list_filesystems()
        except ControlPathError as exc:
            lines.append(f"  {DIM}Could not load filesystems: {exc}{NC}")
            view.set_content("\n".join(lines))
            return

        if not fs_rows:
            lines.append(f"  {DIM}No XFS filesystems found.{NC}")
            view.set_content("\n".join(lines))
            return

        for fs in fs_rows:
            target = fs["mountpoint"] or fs["id"]
            mounted = f" {YLW}(not mounted){NC}" if not fs["mounted"] else ""
            lines.append(f"  {GRN}{target}{NC}{mounted}")
            lines.append(f"    Device:  {fs['backing_device'] or '?'}")
            lines.append(f"    Options: {DIM}{','.join(fs['options'])}{NC}")
            if fs.get("size_bytes") is not None:
                size = _fmt_size(fs.get("size_bytes"))
                free = _fmt_size(fs.get("free_bytes"))
                lines.append(f"    Size:    {size} total, {free} free")
            lines.append("")

        view.set_content("\n".join(lines))

    # ── Create Filesystem Wizard ──────────────────────────────────────────

    @work(exclusive=True)
    async def _create_filesystem_wizard(self) -> None:
        """Multi-step wizard: validate arrays → pick data → pick log → label → mount → confirm → plan/apply."""
        view = self.query_one("#fs-content", ScrollableTextView)

        # ── Pre-check: fetch RAID arrays (GET /api/v1/arrays) ─────────────
        try:
            arr_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/arrays")
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed to query RAID arrays.\n{exc}", "Error")
            )
            return

        # Filter out arrays already in use as a data OR log device of a
        # managed filesystem (GET /api/v1/filesystems).
        try:
            fs_rows = await self._list_filesystems()
        except ControlPathError:
            fs_rows = []
        used = _volumes_in_use(fs_rows)
        arrays = [a for a in _arrays_from_api(arr_rows) if a["volume_path"] not in used]

        if len(arrays) < 2:
            await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Filesystem creation requires at least 2 RAID arrays\n"
                    f"(one for data, one for log).\n\n"
                    f"Currently {len(arrays)} array(s) found.\n\n"
                    f"Please create RAID arrays first via Storage → RAID Management.",
                    "Cannot Create Filesystem",
                    ok_only=True,
                )
            )
            return

        # ── Step 1: Select DATA array ─────────────────────────────────────
        # Sort: data-suggested arrays first
        sorted_arrays = sorted(
            arrays, key=lambda a: 0 if _classify_role(a.get("level", "")) == "data" else 1
        )
        labels = [_array_label(a) for a in sorted_arrays]

        data_choice = await self.app.push_screen_wait(
            SelectDialog(
                labels,
                title="Create Filesystem — Step 1",
                prompt="Select DATA array (typically RAID-5/6):",
            )
        )
        if not data_choice:
            return

        data_idx = labels.index(data_choice)
        data_array = sorted_arrays[data_idx]
        data_name = data_array.get("name", "?")

        # ── Step 2: Select LOG array ──────────────────────────────────────
        remaining = [a for a in sorted_arrays if a.get("name") != data_name]
        remaining_sorted = sorted(
            remaining, key=lambda a: 0 if _classify_role(a.get("level", "")) == "log" else 1
        )
        remaining_labels = [_array_label(a) for a in remaining_sorted]

        if len(remaining_labels) == 1:
            # Only one option — auto-select and confirm
            log_array = remaining_sorted[0]
            confirmed = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Log array will be:\n\n  {_array_label(log_array)}\n\nProceed?",
                    "Create Filesystem — Step 2",
                )
            )
            if not confirmed:
                return
        else:
            log_choice = await self.app.push_screen_wait(
                SelectDialog(
                    remaining_labels,
                    title="Create Filesystem — Step 2",
                    prompt="Select LOG array (typically RAID-1/10):",
                )
            )
            if not log_choice:
                return
            log_idx = remaining_labels.index(log_choice)
            log_array = remaining_sorted[log_idx]

        log_name = log_array.get("name", "?")

        # ── Step 3: Filesystem label ──────────────────────────────────────
        label = await self.app.push_screen_wait(
            InputDialog(
                "Filesystem label:",
                "Create Filesystem — Step 3",
                default="nfsdata",
                placeholder="nfsdata",
            )
        )
        if not label:
            return

        # ── Step 4: Mount point ───────────────────────────────────────────
        mountpoint = await self.app.push_screen_wait(
            InputDialog(
                "Mount point path:",
                "Create Filesystem — Step 4",
                default="/mnt/data",
                placeholder="/mnt/data",
            )
        )
        if not mountpoint or not mountpoint.startswith("/"):
            if mountpoint:
                self.app.notify("Mount point must be an absolute path.", severity="error")
            return

        # ── XFS parameters (stripe geometry is derived server-side) ──────
        data_device = data_array["volume_path"]
        log_device = log_array["volume_path"]
        data_level = str(data_array.get("level", "5"))
        strip_size = data_array.get("strip_size", 128)
        try:
            su_kb = int(strip_size)
        except (ValueError, TypeError):
            su_kb = 128
        mount_opts = f"defaults,{','.join(_DEFAULT_MOUNT_OPTIONS)},logdev={log_device},uquota"

        # ── Step 5: Confirmation ──────────────────────────────────────────
        summary = (
            f"Create XFS Filesystem?\n\n"
            f"  Label:          {label}\n"
            f"  Data Array:     {data_name} (RAID-{data_level}, {data_device})\n"
            f"  Log Array:      {log_name} (RAID-{log_array.get('level', '?')}, {log_device})\n"
            f"  Mount Point:    {mountpoint}\n"
            f"\n"
            f"  XFS Parameters:\n"
            f"    su (strip unit):   {su_kb} KB\n"
            f"    sw (stripe width): derived from array geometry\n"
            f"    sector size:       4k\n"
            f"    log size:          1G (capped to device)\n"
            f"\n"
            f"  Mount Options:\n"
            f"    {mount_opts}\n"
        )
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(summary, "Confirm Filesystem Creation")
        )
        if not confirmed:
            return

        # ── Execute: ONE plan→apply POST (mkfs + mount unit + mount) ─────
        view.set_content(f"  Creating filesystem on {data_device} (plan → apply)...")
        spec: dict[str, Any] = {
            "backing_device": data_device,
            "mountpoint": mountpoint,
            "fs_type": "xfs",
            "label": label,
            "log_device": log_device,
            "log_size": "1G",
            "sector_size": 4096,
            "mount_options": list(_DEFAULT_MOUNT_OPTIONS),
            "quota_mode": "uquota",
        }
        create_dialog = TaskWaitDialog(
            f"Creating filesystem on {data_device}…", "Create Filesystem"
        )
        self.app.push_screen(create_dialog)
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "POST",
                "/api/v1/filesystems",
                spec,
                on_progress=create_dialog.progress_from_thread(self.app),
                cancel_check=create_dialog.cancel_requested,
            )
        except TaskCancelled:
            # MUST precede TaskFailed (subclass): a cancel is not a
            # create-failure and must not offer the force retry.
            create_dialog.dismiss(None)
            view.set_content("  Filesystem creation cancelled — partial work rolled back.")
            return
        except TaskFailed as exc:
            create_dialog.dismiss(None)
            # The executor's destruction gate: an existing filesystem on
            # the device fails a non-force create. Offer the force retry
            # (the legacy "existing filesystem" consent, post-task).
            warn_confirmed = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Filesystem creation failed:\n{exc}\n\n"
                    f"If {data_device} already carries a filesystem, retrying\n"
                    f"with force will DESTROY all existing data.\n\n"
                    f"Retry with force?",
                    "⚠ Create Failed",
                )
            )
            if not warn_confirmed:
                view.set_content("\033[31m  Filesystem creation failed.\033[0m")
                return
            view.set_content(f"  Re-creating with force on {data_device}...")
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "POST",
                    "/api/v1/filesystems",
                    {**spec, "force": True},
                    dangerous=True,
                    on_progress=self._task_progress("Create Filesystem"),
                )
            except ControlPathError as exc2:
                await self.app.push_screen_wait(
                    ConfirmDialog(f"Filesystem creation failed:\n\n{exc2}", "Error")
                )
                view.set_content("\033[31m  Filesystem creation failed.\033[0m")
                return
        except ControlPathError as exc:
            create_dialog.dismiss(None)
            # PlanBlocked carries the plan's blocker text; ApiError /
            # TransportError carry the envelope/socket failure.
            await self.app.push_screen_wait(
                ConfirmDialog(f"Filesystem creation failed:\n\n{exc}", "Error")
            )
            view.set_content("\033[31m  Filesystem creation failed.\033[0m")
            return
        else:
            # Happy path: the try completed without an exception.
            create_dialog.dismiss(None)

        # Success
        self.app.audit.log(
            "fs.create",
            f"label={label} data={data_device} log={log_device} mount={mountpoint}",
            "OK",
        )
        await self.app.snapshots.record(
            "fs_create",
            diff_summary=f"Created XFS filesystem '{label}' on {data_device}, mounted at {mountpoint}",
        )
        GRN, BLD, NC = "\033[32m", "\033[1m", "\033[0m"
        view.set_content(
            f"{BLD}{GRN}Filesystem created successfully!{NC}\n\n"
            f"  Label:       {label}\n"
            f"  Data:        {data_device}\n"
            f"  Log:         {log_device}\n"
            f"  Mounted at:  {mountpoint}\n"
            f"  Mount opts:  {mount_opts}\n"
        )
        self.app.notify("Filesystem created and mounted successfully!", severity="information")

    # ── Delete Filesystem ──────────────────────────────────────────────────

    def _teardown_append(self, lines: list[str], line: str) -> None:
        """Append a step line to the teardown progress view."""
        lines.append(line)
        self.query_one("#fs-content", ScrollableTextView).set_content("\n".join(lines))

    def _teardown_progress(self, lines: list[str]):
        """``on_progress`` callback rendering task states as step lines.

        ``plan_apply_wait`` runs in a worker thread, so the callback hops
        back to the UI thread before touching the view.
        """

        def _cb(state: str) -> None:
            self.app.call_from_thread(self._teardown_append, lines, f"      task {state}")

        return _cb

    async def _teardown_failed(self, lines: list[str], step: str, exc: Exception) -> None:
        """Render a stop-on-failure halt (s8-clients-spec §6: no cross-step
        rollback — each step's task carries its own rollback)."""
        self._teardown_append(lines, f"  FAILED: {exc}")
        self._teardown_append(lines, "  Teardown stopped — remaining steps were not run.")
        await self.app.push_screen_wait(
            ConfirmDialog(
                f"{step}:\n{exc}\n\n"
                "Teardown stopped at this step. No cross-step rollback; the "
                "failed task rolled itself back where supported.",
                "Delete Filesystem — Stopped",
            )
        )

    @work(exclusive=True)
    async def _delete_filesystem(self) -> None:
        """Delete a filesystem: shares delete → unmount PATCH → unmanage DELETE.

        Stop-on-failure SEQUENCE of control-path API operations (the
        s8-clients-spec §6 teardown shape) — a step failure stops the
        sequence with the task/plan error surfaced; no cross-step rollback.
        """
        view = self.query_one("#fs-content", ScrollableTextView)
        view.set_content("  Scanning filesystems...")

        try:
            fs_rows = await self._list_filesystems()
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Could not load filesystems.\n{exc}", "Delete Filesystem")
            )
            return

        if not fs_rows:
            await self.app.push_screen_wait(
                ConfirmDialog("No XFS filesystems found.", "Delete Filesystem")
            )
            return

        # Build selection list
        fs_labels = []
        for fs in fs_rows:
            target = fs["mountpoint"] or fs["id"]
            source = fs["backing_device"] or "?"
            fs_labels.append(f"{target}  ({source})")

        choice = await self.app.push_screen_wait(
            SelectDialog(
                fs_labels,
                title="Delete Filesystem",
                prompt="Select filesystem to delete:",
            )
        )
        if not choice:
            return

        idx = fs_labels.index(choice)
        target_fs = fs_rows[idx]
        fs_id = target_fs["id"]
        mountpoint = target_fs["mountpoint"]
        source_dev = target_fs["backing_device"]

        # ── Check for active NFS shares on this mountpoint ───────────────
        affected_shares: list[dict] = []  # [{id, path}]
        if mountpoint:
            try:
                share_rows = await asyncio.to_thread(self.app.control.result, "/api/v1/shares")
            except ControlPathError:
                share_rows = []
            for doc in share_rows if isinstance(share_rows, list) else []:
                if not isinstance(doc, dict):
                    continue
                doc_spec = doc.get("spec")
                path = doc_spec.get("path") if isinstance(doc_spec, dict) else None
                sid = doc.get("id")
                if not path or sid is None:
                    continue
                if _is_under(str(path), mountpoint):
                    affected_shares.append({"id": str(sid), "path": str(path)})

        # ── Build warning ────────────────────────────────────────────────
        warning_parts = [
            f"Filesystem: {mountpoint or fs_id}\nDevice:     {source_dev}\n",
        ]

        if affected_shares:
            share_list = "\n".join(f"  - {s['path']}" for s in affected_shares)
            warning_parts.append(f"ACTIVE NFS SHARES will be removed first:\n{share_list}\n")

        warning_parts.append(
            "WARNING: The filesystem will be unmounted and its systemd\n"
            "mount unit will be removed. Data on disk is NOT erased."
        )

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog("\n".join(warning_parts), "Delete Filesystem?")
        )
        if not confirmed:
            return

        # Double confirmation if shares are affected
        if affected_shares:
            confirmed2 = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Are you ABSOLUTELY sure?\n\n"
                    f"This will remove {len(affected_shares)} NFS share(s) "
                    f"and unmount '{mountpoint}'.",
                    "FINAL CONFIRMATION",
                )
            )
            if not confirmed2:
                return

        lines: list[str] = []
        self._teardown_append(lines, f"Teardown sequence for filesystem '{mountpoint or fs_id}':")
        progress = self._teardown_progress(lines)

        # ── Step 1: Remove NFS shares (API delete; stop on failure) ──────
        removed_shares = 0
        for share in affected_shares:
            path = share["path"]
            self._teardown_append(lines, f"  Removing NFS share: {path} ...")
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "DELETE",
                    f"/api/v1/shares/{share['id']}",
                    {},
                    on_progress=progress,
                )
            except ControlPathError as exc:
                await self._teardown_failed(lines, f"Failed to remove NFS share '{path}'", exc)
                return
            removed_shares += 1
            self.app.audit.log("nfs.remove", f"share={path} (FS teardown)", "OK")

        # ── Step 2: Unmount filesystem (one-intent PATCH) ────────────────
        if target_fs["mounted"]:
            self._teardown_append(lines, f"  Unmounting {mountpoint} ...")
            try:
                await asyncio.to_thread(
                    self.app.control.plan_apply_wait,
                    "PATCH",
                    f"/api/v1/filesystems/{fs_id}",
                    {"mounted": False},
                    on_progress=progress,
                )
            except ControlPathError as exc:
                await self._teardown_failed(lines, f"Failed to unmount '{mountpoint}'", exc)
                return
            self.app.audit.log("fs.unmount", f"mountpoint={mountpoint} (FS teardown)", "OK")

        # ── Step 3: Unmanage (DELETE removes the unit; data untouched) ───
        self._teardown_append(lines, f"  Removing mount unit: {fs_id} ...")
        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "DELETE",
                f"/api/v1/filesystems/{fs_id}",
                {},
                on_progress=progress,
            )
        except ControlPathError as exc:
            await self._teardown_failed(lines, f"Failed to remove mount unit '{fs_id}'", exc)
            return

        # Success
        self.app.audit.log(
            "fs.delete",
            f"mountpoint={mountpoint} device={source_dev}",
            "OK",
        )
        await self.app.snapshots.record(
            "fs_delete",
            diff_summary=f"Deleted filesystem at {mountpoint} (device {source_dev})"
            + (f", removed {removed_shares} share(s)" if removed_shares else ""),
        )
        GRN, BLD, NC = "\033[32m", "\033[1m", "\033[0m"
        self._teardown_append(lines, "")
        self._teardown_append(lines, f"{BLD}{GRN}Filesystem deleted successfully.{NC}")
        self._teardown_append(lines, f"  Mountpoint:  {mountpoint}")
        self._teardown_append(lines, f"  Device:      {source_dev}")
        if removed_shares:
            self._teardown_append(lines, f"  Removed {removed_shares} NFS share(s)")
        self.app.notify("Filesystem unmounted and removed.", severity="information")

    # ── Manage Quotas ──────────────────────────────────────────────────────

    @work(exclusive=True)
    async def _manage_quotas(self) -> None:
        """Set the XFS quota mode on a filesystem (one-intent PATCH)."""
        view = self.query_one("#fs-content", ScrollableTextView)
        view.set_content("  Scanning filesystems...")

        GRN, RED, YLW, BLD, DIM, CYN, NC = (
            "\033[32m",
            "\033[31m",
            "\033[33m",
            "\033[1m",
            "\033[2m",
            "\033[36m",
            "\033[0m",
        )

        # Discover managed XFS filesystems
        try:
            fs_rows = await self._list_filesystems()
        except ControlPathError as exc:
            view.set_content(f"  {DIM}Could not load filesystems: {exc}{NC}")
            return

        if not fs_rows:
            view.set_content(f"  {DIM}No XFS filesystems found.{NC}")
            return

        # Build selection list with quota status
        fs_labels = []
        for fs in fs_rows:
            target = fs["mountpoint"] or fs["id"]
            qs = _quota_flags(fs["options"])
            status_parts = []
            if qs["user"]:
                status_parts.append(f"{GRN}user{NC}")
            if qs["project"]:
                status_parts.append(f"{GRN}project{NC}")
            if not status_parts:
                status_parts.append(f"{YLW}none{NC}")
            fs_labels.append(f"{target}  [quotas: {', '.join(status_parts)}]")

        # Show overview first
        lines = [f"{BLD}{CYN}XFS Quota Status{NC}\n"]
        for label in fs_labels:
            lines.append(f"  {label}")
        lines.append(f"\n  {DIM}Select a filesystem below to change quota settings.{NC}")
        view.set_content("\n".join(lines))

        # Select filesystem
        # Use plain labels for SelectDialog (no ANSI)
        plain_labels = []
        for fs in fs_rows:
            target = fs["mountpoint"] or fs["id"]
            qs = _quota_flags(fs["options"])
            parts = []
            if qs["user"]:
                parts.append("user")
            if qs["project"]:
                parts.append("project")
            status = ", ".join(parts) if parts else "none"
            plain_labels.append(f"{target}  (quotas: {status})")

        choice = await self.app.push_screen_wait(
            SelectDialog(
                plain_labels,
                title="Manage Quotas",
                prompt="Select filesystem:",
            )
        )
        if not choice:
            return

        idx = plain_labels.index(choice)
        target_fs = fs_rows[idx]
        fs_id = target_fs["id"]
        mountpoint = target_fs["mountpoint"] or fs_id
        qs = _quota_flags(target_fs["options"])

        # Show toggle options. The API holds ONE quota mode per filesystem
        # (none | uquota | pquota) — enabling a mode replaces the current
        # flag, so user+project simultaneously is no longer offered.
        actions: list[tuple[str, str, str]] = []  # (label, quota_mode, description)
        if not qs["user"]:
            desc = "enable user quotas" + (" (replaces project quotas)" if qs["project"] else "")
            actions.append(("Enable User Quotas (uquota)", "uquota", desc))
        else:
            actions.append(("Disable User Quotas", "none", "disable user quotas"))
        if not qs["project"]:
            desc = "enable project quotas" + (" (replaces user quotas)" if qs["user"] else "")
            actions.append(("Enable Project Quotas (pquota)", "pquota", desc))
        else:
            actions.append(("Disable Project Quotas", "none", "disable project quotas"))

        action = await self.app.push_screen_wait(
            SelectDialog(
                [a[0] for a in actions],
                title=f"Quotas — {mountpoint}",
                prompt="Select action:",
            )
        )
        if not action:
            return

        quota_mode, desc = next((m, d) for label, m, d in actions if label == action)

        # Confirm
        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                f"Filesystem: {mountpoint}\n\n"
                f"Action: {desc}\n\n"
                f"WARNING: XFS requires a full unmount/mount cycle to change\n"
                f"quota settings. Active NFS clients may be briefly disconnected.",
                "Confirm Quota Change",
            )
        )
        if not confirmed:
            return

        view.set_content(f"  Updating quota settings on {mountpoint}...")

        try:
            await asyncio.to_thread(
                self.app.control.plan_apply_wait,
                "PATCH",
                f"/api/v1/filesystems/{fs_id}",
                {"quota_mode": quota_mode},
                on_progress=self._task_progress("Quota Change"),
            )
        except ControlPathError as exc:
            await self.app.push_screen_wait(
                ConfirmDialog(f"Failed to update quotas:\n\n{exc}", "Error", ok_only=True)
            )
            view.set_content(f"{RED}Failed to update quotas: {exc}{NC}")
            return

        self.app.audit.log(
            "fs.quota",
            f"{mountpoint}: {desc}",
            "OK",
        )
        await self.app.snapshots.record(
            "fs_modify",
            diff_summary=f"Changed quotas on {mountpoint}: {desc}",
        )
        view.set_content(
            f"{BLD}{GRN}Quota settings updated.{NC}\n\n"
            f"  Filesystem: {mountpoint}\n"
            f"  Changed:    {desc}\n\n"
            f"  {DIM}Filesystem remounted. Quotas are now active.{NC}"
        )
        self.app.notify("Quota settings updated.", severity="information")
