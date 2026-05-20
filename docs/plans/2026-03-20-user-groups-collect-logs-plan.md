# User Group Display & Collect Logs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show group membership in the user list and group management dialog, and add a Collect Logs function to Quick Actions.

**Architecture:** Two independent features in the Textual TUI. Feature 1 modifies `users.py` — the user list formatter and the manage-groups dialog loop. Feature 2 adds a new menu item and async worker to `quick_actions.py` that shells out to collect system data, logs, and audit info into a tarball.

**Tech Stack:** Python 3, Textual TUI framework, subprocess (system commands), tarfile (stdlib)

---

### Task 1: Add group membership column to user list

**Files:**
- Modify: `xinas_menu/screens/users.py:482-531` (`_format_users` function)

**Step 1: Add `_get_user_groups` call for each user and format with truncation**

Update `_format_users` to widen the display and add a "Groups" column. Use existing `_get_user_groups()` (line 581) to fetch supplementary groups. Truncate long group lists with `(+N more)` to fit ~35 chars.

Replace lines 484-506 in `_format_users`:

```python
def _format_users(users: list[pwd.struct_passwd]) -> str:
    GRN, YLW, RED, CYN, BLD, DIM, NC = "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[1m", "\033[2m", "\033[0m"
    W = 110
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
        lines.append(f"  {DIM}{'Username':<16} {'UID':<8} {'Group':<16} {'Groups':<36} Home Directory{NC}")
        lines.append(f"{DIM}{'-' * W}{NC}")
        for u in sorted(users, key=lambda x: x.pw_name):
            try:
                group = grp.getgrgid(u.pw_gid).gr_name
            except Exception:
                group = str(u.pw_gid)
            groups = _get_user_groups(u.pw_name)
            groups_str = _format_group_list(groups, max_width=35)
            lines.append(f"  {GRN}{u.pw_name:<16}{NC} {u.pw_uid:<8} {group:<16} {groups_str:<36} {u.pw_dir}")
        lines.append(f"{DIM}{'-' * W}{NC}")
```

**Step 2: Add `_format_group_list` helper**

Add this helper function right after `_get_all_groups` (after line 600):

```python
def _format_group_list(groups: list[str], max_width: int = 35) -> str:
    """Format a group list, truncating with (+N more) if too long."""
    if not groups:
        return "(none)"
    full = ", ".join(groups)
    if len(full) <= max_width:
        return full
    # Fit as many groups as possible with (+N more) suffix
    shown: list[str] = []
    for g in groups:
        candidate = ", ".join(shown + [g])
        remaining = len(groups) - len(shown) - 1
        suffix = f" (+{remaining})" if remaining > 0 else ""
        if len(candidate + suffix) > max_width and shown:
            break
        shown.append(g)
    remaining = len(groups) - len(shown)
    result = ", ".join(shown)
    if remaining > 0:
        result += f" (+{remaining})"
    return result
```

**Step 3: Verify manually**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -c "from xinas_menu.screens.users import _format_group_list; print(_format_group_list(['a','b','c'])); print(_format_group_list(['docker','sudo','www-data','nfs-users','storage','backup','monitoring','admin','dev','ops','logs']))"`

Expected: First prints `a, b, c`. Second prints a truncated version with `(+N)` suffix.

**Step 4: Commit**

```bash
git add xinas_menu/screens/users.py
git commit -m "feat(tui): show group membership in user list table"
```

---

### Task 2: Show current groups in Manage Groups dialog prompt

**Files:**
- Modify: `xinas_menu/screens/users.py:290-361` (`_manage_groups` method)

**Step 1: Update the SelectDialog prompt to include current groups**

Replace the `_manage_groups` method body (lines 290-361). The key change is formatting the current group list into the SelectDialog prompt so the user sees it inline without looking behind the dialog. For long lists, wrap lines at ~60 chars.

Replace the SelectDialog call in `_manage_groups` (lines 300-306):

```python
            # Format current groups for display in dialog prompt
            groups_display = _format_groups_for_dialog(current)
            prompt = f"Current groups: {groups_display}\n\nSelect action:"

            action = await self.app.push_screen_wait(
                SelectDialog(
                    ["Add to group", "Remove from group"],
                    title=f"Groups: {username}",
                    prompt=prompt,
                )
            )
```

**Step 2: Add `_format_groups_for_dialog` helper**

Add after `_format_group_list`:

```python
def _format_groups_for_dialog(groups: list[str], line_width: int = 60) -> str:
    """Format group list for dialog display, wrapping long lines."""
    if not groups:
        return "(none)"
    lines: list[str] = []
    current_line: list[str] = []
    current_len = 0
    for g in groups:
        addition = len(g) + (2 if current_line else 0)  # ", " separator
        if current_line and current_len + addition > line_width:
            lines.append(", ".join(current_line) + ",")
            current_line = [g]
            current_len = len(g)
        else:
            current_line.append(g)
            current_len += addition
    if current_line:
        lines.append(", ".join(current_line))
    return "\n  ".join(lines)
```

**Step 3: Verify manually**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -c "from xinas_menu.screens.users import _format_groups_for_dialog; print(_format_groups_for_dialog(['docker','sudo','www-data','nfs-users','storage','backup','monitoring','admin','dev','ops','logs']))"`

Expected: Multi-line output with wrapped group names.

**Step 4: Commit**

```bash
git add xinas_menu/screens/users.py
git commit -m "feat(tui): show current groups inline in manage-groups dialog"
```

---

### Task 3: Add Collect Logs menu item to Quick Actions

**Files:**
- Modify: `xinas_menu/screens/quick_actions.py:26-33` (menu list)
- Modify: `xinas_menu/screens/quick_actions.py:74-87` (event handler)

**Step 1: Add menu item and route**

In `_MENU` (line 26), add before the Back item:

```python
_MENU = [
    MenuItem("1", "Restart NFS Server"),
    MenuItem("2", "View System Logs"),
    MenuItem("3", "Service Status"),
    MenuItem("4", "System Monitor (btop)"),
    MenuItem("5", "View Audit Log"),
    MenuItem("6", "Collect Logs"),
    MenuItem("0", "Back"),
]
```

In `on_navigable_menu_selected` (line 74), add the route:

```python
        elif key == "6":
            self._collect_logs()
```

In `on_mount` help text, add:

```python
            f"  {BLD}6{NC}  {CYN}Collect Logs{NC}     {DIM}Gather system info, logs & audit into tarball{NC}\n"
```

**Step 2: Commit**

```bash
git add xinas_menu/screens/quick_actions.py
git commit -m "feat(tui): add Collect Logs menu item to Quick Actions"
```

---

### Task 4: Implement Collect Logs worker

**Files:**
- Modify: `xinas_menu/screens/quick_actions.py` (add `_collect_logs` method and `_collect_logs_sync` helper)

**Step 1: Add imports at top of file**

Add to existing imports:

```python
import os
import socket
import tarfile
import tempfile
import time
from pathlib import Path
```

**Step 2: Add the `_collect_logs` async worker method**

Add after `_view_audit_log` (after line 166):

```python
    @work(exclusive=True)
    async def _collect_logs(self) -> None:
        view = self.query_one("#qa-content", ScrollableTextView)
        view.set_content("  Collecting system information and logs...\n")
        loop = asyncio.get_running_loop()
        ok, archive_path, err = await loop.run_in_executor(None, _collect_logs_sync)
        if not ok:
            view.set_content(f"{_RED}Collection failed: {err}{_NC}")
            return

        self.app.audit.log("system.collect_logs", archive_path, "OK")
        view.set_content(
            f"{_GRN}Logs collected successfully.{_NC}\n\n"
            f"  Archive: {_BLD}{archive_path}{_NC}\n"
        )

        upload = await self.app.push_screen_wait(
            ConfirmDialog("Upload archive to transfer server?", "Upload Logs")
        )
        if not upload:
            return

        view.set_content(f"  Uploading {archive_path}...")
        server = os.environ.get("TRANSFER_SERVER", "http://178.253.23.152:8080")
        upload_ok, upload_err = await loop.run_in_executor(
            None, lambda: _upload_archive(archive_path, server)
        )
        if upload_ok:
            self.app.audit.log("system.upload_logs", archive_path, "OK")
            view.set_content(
                f"{_GRN}Upload complete.{_NC}\n\n"
                f"  Archive: {_BLD}{archive_path}{_NC}\n"
                f"  Server:  {server}\n"
            )
        else:
            view.set_content(
                f"{_GRN}Archive saved locally:{_NC} {archive_path}\n\n"
                f"{_RED}Upload failed: {upload_err}{_NC}\n"
            )
```

**Step 3: Add the `_collect_logs_sync` function**

Add as a module-level function after the class:

```python
def _collect_logs_sync() -> tuple[bool, str, str]:
    """Collect system info, logs, and audit data into a tarball.

    Returns (success, archive_path, error_message).
    """
    hostname = socket.gethostname()
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    archive_path = f"/tmp/xinas-logs-{hostname}-{timestamp}.tar.gz"

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)

            # --- System information (same as collect_data.sh) ---
            _collect_cmd(tmp_path / "lsblk.txt", ["lsblk", "-o", "NAME,SIZE,TYPE,MOUNTPOINT"])
            _collect_file(tmp_path / "mdstat.txt", Path("/proc/mdstat"))
            _collect_cmd(tmp_path / "pvs.txt", ["pvs"])
            _collect_cmd(tmp_path / "nvme_list.txt", ["nvme", "list"])
            _collect_cmd(tmp_path / "lspci.txt", ["lspci"])
            _collect_cmd(tmp_path / "uname.txt", ["uname", "-a"])
            _collect_file(tmp_path / "os-release.txt", Path("/etc/os-release"))
            _collect_cmd(tmp_path / "uptime.txt", ["uptime"])

            # NUMA nodes
            _collect_numa(tmp_path / "numa_nodes.txt")

            # --- System logs ---
            _collect_cmd(tmp_path / "journal.txt", ["journalctl", "--no-pager", "-n", "5000"])

            # --- Audit log ---
            _collect_file(tmp_path / "audit.log", Path("/var/log/xinas/audit.log"))

            # --- Service status ---
            for svc in _SERVICES:
                _collect_cmd(tmp_path / f"service-{svc}.txt", ["systemctl", "status", svc, "--no-pager"])

            # --- NFS / network config ---
            _collect_file(tmp_path / "exports.txt", Path("/etc/exports"))
            _collect_file(tmp_path / "nfs.conf", Path("/etc/nfs.conf"))
            # Netplan configs
            netplan_dir = Path("/etc/netplan")
            if netplan_dir.is_dir():
                for f in netplan_dir.glob("*.yaml"):
                    _collect_file(tmp_path / f"netplan-{f.name}", f)

            # --- xiRAID status ---
            _collect_cmd(tmp_path / "xiraid-status.txt", ["xiraid", "status"])

            # Build tarball
            with tarfile.open(archive_path, "w:gz") as tar:
                for item in sorted(tmp_path.iterdir()):
                    tar.add(item, arcname=item.name)

        return True, archive_path, ""
    except Exception as exc:
        return False, "", str(exc)


def _collect_cmd(dest: Path, cmd: list[str]) -> None:
    """Run a command and write output to dest. Silently skip failures."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        dest.write_text(r.stdout + (f"\n--- stderr ---\n{r.stderr}" if r.stderr else ""))
    except Exception as exc:
        dest.write_text(f"(command failed: {exc})")


def _collect_file(dest: Path, src: Path) -> None:
    """Copy a file to dest. Silently skip if missing."""
    try:
        dest.write_text(src.read_text())
    except Exception:
        pass


def _collect_numa(dest: Path) -> None:
    """Gather NUMA node info for each disk."""
    lines: list[str] = []
    try:
        r = subprocess.run(
            ["lsblk", "-ndo", "NAME,TYPE"],
            capture_output=True, text=True, timeout=10,
        )
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1] == "disk":
                dev = parts[0]
                node_file = Path(f"/sys/block/{dev}/device/numa_node")
                if node_file.exists():
                    lines.append(f"{dev} {node_file.read_text().strip()}")
                else:
                    lines.append(f"{dev} unknown")
    except Exception:
        pass
    dest.write_text("\n".join(lines))


def _upload_archive(archive_path: str, server: str) -> tuple[bool, str]:
    """Upload archive via curl. Returns (success, error_message)."""
    import os
    basename = os.path.basename(archive_path)
    r = subprocess.run(
        ["curl", "--fail", "--upload-file", archive_path, f"{server}/{basename}"],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0:
        return False, r.stderr.strip() or f"curl exit code {r.returncode}"
    return True, ""
```

**Step 4: Commit**

```bash
git add xinas_menu/screens/quick_actions.py
git commit -m "feat(tui): implement Collect Logs — gather system info, logs, audit into tarball with optional upload"
```

---

### Task 5: Final verification

**Step 1: Syntax check both files**

Run: `python3 -m py_compile xinas_menu/screens/users.py && python3 -m py_compile xinas_menu/screens/quick_actions.py && echo "OK"`

Expected: `OK`

**Step 2: Verify helpers work in isolation**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -c "from xinas_menu.screens.users import _format_group_list, _format_groups_for_dialog; print(_format_group_list(['a','b','c'])); print('---'); print(_format_groups_for_dialog(['docker','sudo','www-data','nfs','storage','backup','monitoring','admin','dev','ops','logs']))"`

**Step 3: Commit any fixups if needed**
