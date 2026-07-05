# User Management Screen Spec

Live contract for the **User Management** Textual TUI screen
(`xinas_menu/screens/users.py`, class `UsersScreen`), reached from the
Management submenu (`System → Management → User Management`).

This is the durable behavior contract. The original build was described
in the append-only plan
`docs/plans/2026-03-20-user-groups-collect-logs-design.md`; that plan is
history — this spec is the source of truth.

## Menu

| Key | Item | Action |
|-----|------|--------|
| 1 | List Users | Render the user-accounts table (default view on mount) |
| 2 | Create User | `useradd -m` + optional `chpasswd` |
| 3 | Manage User | Password / lock / shell / groups / delete for one user |
| 4 | Set Disk Quota | XFS user quota via the NFS helper |
| 5 | Show Quotas | `xfs_quota` user + project report |
| 0 | Back | Pop screen |

## List Users table

Regular accounts only: `pwd.getpwall()` filtered to `pw_uid >= 1000`
(`_UID_MIN`), sorted by name. Rendered by `_format_users(users, locked)`.

Columns, in order:

| Column | Width | Source |
|--------|-------|--------|
| Username | 16 | `pw_name` (green) |
| UID | 8 | `pw_uid` |
| Group | 16 | primary group name via `grp.getgrgid(pw_gid)` |
| Groups | 36 | supplementary groups via `id -Gn`, truncated `(+N)` |
| **Status** | 8 | account lock state (see below) |
| Home Directory | rest | `pw_dir` |

Example:

```
Username         UID      Group            Groups                          Status   Home Directory
nobody           65534    nogroup          (none)                          Active   /nonexistent
rufat            1001     rufat            (none)                          Locked   /home/rufat
xinnor           1000     xinnor           adm, cdrom, sudo, dip (+2)      Active   /home/xinnor
```

### Status column

- Value is **`Locked`** (red) when the account's password is locked,
  otherwise **`Active`** (green).
- Lock state is determined by `passwd -S <user>`: the account is locked
  when the status field (2nd token) is `L`. This is the same source the
  Manage User flow uses to toggle the `Lock Account` / `Unlock Account`
  label (`_get_lock_status`), so the list and the manage dialog always
  agree.
- Reading lock state requires privilege to read the shadow database; the
  TUI runs as root. If `passwd -S` cannot be read, the account is
  reported as `Active` (fail-safe, matching `_get_lock_status`).
- Lock state is collected once per List Users render, in a worker
  thread, as a `dict[str, bool]` keyed by username (`_get_lock_map`),
  and passed into `_format_users`. `_format_users` renders each cell
  purely from that map (no side effects), which keeps the formatter
  unit-testable.

Below the table, a **Disk Quotas** line reports whether any mounted XFS
filesystem carries a quota mount option (`uquota`/`usrquota`/`pquota`/
`prjquota`) via `findmnt`.

## Manage User

Lock/unlock uses `usermod -L` / `usermod -U`; the menu label reflects the
current `passwd -S` state. Other actions: change password (`chpasswd`),
change shell (`chsh`), manage groups (`usermod -aG` / `gpasswd -d`),
delete (`userdel -r`, home removed). Every mutating action is audited via
`self.app.audit.log(...)`.

## Notes

- The List Users view is local-only (`pwd` / `passwd`); it is independent
  of the control-path `User` API schema (`docs/control-path/api-v1.yaml`),
  whose `status` object does not model lock state.
- This is Python-TUI-only day-2 management; no bash surface participates.
