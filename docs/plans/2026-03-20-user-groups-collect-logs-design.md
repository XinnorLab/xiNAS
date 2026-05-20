# User Group Display & Collect Logs Design

Date: 2026-03-20

## Feature 1: Group Membership in User Management UI

### Problem

- The user list table shows only the primary group, not supplementary groups.
- The Manage Groups dialog does not show current group membership inline — the user must look behind the dialog at the content pane.
- Users may belong to 10+ groups, so the UI must handle long lists gracefully.

### Changes

#### A. User list table — add "Groups" column

In `_format_users()`, add a column showing all supplementary groups for each user (via `id -Gn`). Long lists are truncated with a `(+N more)` suffix to fit within ~35 characters.

Example:
```
Username         UID      Group            Groups                          Home Directory
alice            1001     alice            docker, sudo, www-data (+4)     /home/alice
bob              1002     bob              docker                          /home/bob
```

#### B. Manage Groups dialog — show current groups in prompt

Change the `SelectDialog` prompt in `_manage_groups` to include the current group list. For long lists (10+), wrap across multiple lines:

```
Current groups: docker, sudo, www-data, nfs-users,
  storage, backup, monitoring, admin, dev, ops, logs

Select action:
```

The existing loop already re-fetches groups after each add/remove, so the dialog prompt will reflect changes dynamically when re-shown.

### Files modified

- `xinas_menu/screens/users.py`: `_format_users()`, `_manage_groups()`

---

## Feature 2: Collect Logs in Quick Actions

### Problem

`collect_data.sh` collects hardware inventory only. There is no way to collect audit logs, system logs, and system info together for support/debugging purposes.

### Solution

Add a "Collect Logs" menu item to `QuickActionsScreen` that gathers:

1. **System info** — `lsblk`, `/proc/mdstat`, `pvs`, `nvme list`, `lspci`, NUMA nodes
2. **System logs** — `journalctl --no-pager -n 5000`
3. **Audit log** — `/var/log/xinas/audit.log`
4. **Service status** — `systemctl status` for all xiNAS services
5. **NFS/network config** — `/etc/exports`, `/etc/nfs.conf`, netplan yaml
6. **xiRAID status** — `xiraid status` if available
7. **Kernel/OS info** — `uname -a`, `/etc/os-release`, `uptime`

### Output

- Local tarball: `/tmp/xinas-logs-<hostname>-<YYYYMMDD-HHMMSS>.tar.gz`
- Optional upload to transfer server (same `TRANSFER_SERVER` env var as `collect_data.sh`, default `http://178.253.23.152:8080`)

### UI flow

1. User selects "Collect Logs" (menu item 6) from Quick Actions
2. Content pane shows collection progress
3. On completion, show archive path and ask "Upload to server?" via ConfirmDialog
4. If yes, upload via curl and show result

### Files modified

- `xinas_menu/screens/quick_actions.py`: new menu item + `_collect_logs()` method
