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
| 2 | Create User | `useradd -m` + `chpasswd` (**password required**) |
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

## Create User — a password is required

Create User prompts for a username, a **non-empty** password (confirmed
twice), and a home directory, then runs
`useradd -m -d <home> -s /bin/bash <name>` followed by `chpasswd`.

The password is mandatory by design. `useradd` on its own writes `!` to
the account's `/etc/shadow` password field; `passwd -S` then reports the
status field as `L`, so a freshly created **passwordless** account shows
as **`Locked`** in the List Users Status column (see above) even though
no admin ever locked it. Requiring a password means the new account has a
real hash, `passwd -S` reports `P`, and the account renders as `Active`.

The rule is enforced at two layers so the invariant "a user created by
this screen is never left in a `!`/Locked state" holds even if a caller
is added later:

1. **UI** — the password prompt loop rejects an empty value and re-asks;
   the account-creation step is never reached without a password.
2. **`_create_user_sync`** — refuses to run `useradd` when the password
   is empty (returns a `Password is required.` error), so it can never
   create the passwordless account that would surface as Locked. If
   `useradd` succeeds but the follow-up `chpasswd` fails, it rolls the
   account back with `userdel -r` before returning the error, so a
   half-created `!`/Locked account is never left behind.

Deleting a user does **not** carry lock state to a later account: `L` is
a per-name `/etc/shadow` fact, and `userdel` removes the shadow entry.
The Locked-on-a-new-user symptom is created entirely by the passwordless
`useradd` path above, not inherited from the deleted account.

## Manage User

Lock/unlock uses `usermod -L` / `usermod -U`; the menu label reflects the
current `passwd -S` state. Other actions: change password (`chpasswd`),
change shell (`chsh`), manage groups (`usermod -aG` / `gpasswd -d`),
delete (see below). Every mutating action is audited via
`self.app.audit.log(...)`.

### Delete User — quota cleanup first

XFS user quotas are keyed by **numeric UID**, not by name. A plain
`userdel` therefore leaves the user's quota limits behind in the XFS
quota database; when a later `useradd` reuses the freed UID, the new
account silently inherits the stale limits (observed as an unresolved
`#<uid>` row in Show Quotas carrying the old soft/hard limits). Deleting
a user must clear its quotas **before** removing the account, while the
name still resolves to the UID.

The delete flow is:

1. **Collect** the user's block quotas across every mounted XFS
   filesystem (`findmnt -t xfs -n -o TARGET`, then
   `xfs_quota -x -c 'report -u -N' <mount>` per mount). The collector
   reads the **`report`** command, not the per-user `quota` command:
   `report -u -N` prints one line per user — `<name> <used> <soft> <hard>
   <warn> [<grace>]`, block values in **kilobytes** — and the collector
   picks the row whose first field equals the username. The per-user
   `xfs_quota -x -c 'quota -u -N -b <user>' <mount>` form is **not** used:
   on some xfsprogs/device combinations (observed on an xiRAID-backed XFS)
   it prints **nothing** for a user that plainly has a limit, so the
   collector silently saw no quota and `userdel` then orphaned it — the
   exact bug this flow exists to prevent. A mount is in scope only when
   the user's soft **or** hard block limit is nonzero. Limits are read and
   re-applied in kilobytes — the same unit as the `limit -u bsoft=Nk` set
   path — so the capture/restore round-trip is exact.

   `xfs_quota` **exits 0 even on hard errors** (e.g. `foreign filesystem`,
   `cannot setup path … No such device`). The collector therefore judges
   success from the command's **text**, not its exit code: any listed mount
   whose output carries a known error marker is treated as a **read
   failure**, not as "no quota". `_collect_user_quotas` returns
   `(saved, read_ok)` where `read_ok` is False if a listed mount could not
   be read (xfs_quota error in the output, or `_run_cmd` non-zero). Note the
   scope: this catches a mount that `findmnt` lists but `xfs_quota` chokes
   on (e.g. a flaky `foreign filesystem` reading). It does **not** cover a
   filesystem that `findmnt` does not list at all (array fully unmounted at
   delete time) — there is nothing to key a warning off, and a system with
   genuinely no XFS mounts has no quotas to orphan.
2. **Confirm.** The confirmation dialog names how many quota entries will
   be cleared first (when any), so the removal is not a surprise. If the
   quota read **failed** on a listed mount (`read_ok` False — e.g.
   `xfs_quota` reports the mount as a foreign filesystem), the dialog
   instead **warns** that quotas could not be verified and that deleting now
   may orphan stale limits onto a future account reusing this UID, so the
   operator deletes with eyes open rather than silently orphaning.
3. **Clear** each in-scope mount to `0/0` via the NFS helper
   (`set_quota(mount, 0, 0, username=…)`), remembering the prior
   `(mount, soft_kb, hard_kb)` for each cleared entry.
4. **Delete** the account with `userdel -r` (home removed).
5. **Roll back on any failure.** If clearing a mount fails, or if
   `userdel` fails after quotas were cleared, every already-cleared quota
   is restored to its captured `(soft_kb, hard_kb)` and the account is
   **not** left half-deleted. The result view reports the failing step
   and whether the quotas were restored cleanly; a restore that itself
   fails is surfaced as a warning to check Show Quotas. Nothing is
   deleted unless every quota was cleared successfully.

A user with no quotas skips step 1's scope entirely and deletes as
before. The core sequencing + rollback (`_delete_user_with_quota_cleanup`)
is a pure, injectable function so it is unit-testable without a live
filesystem; the report-line parser (`_parse_report_user_quota`), the
xfs_quota error sniffer (`_xfs_quota_errored`), the collector
(`_collect_user_quotas`), and the confirm-note builder
(`_delete_confirm_note`) are likewise separable.

## Notes

- The List Users view is local-only (`pwd` / `passwd`); it is independent
  of the control-path `User` API schema (`docs/control-path/api-v1.yaml`),
  whose `status` object does not model lock state.
- This is Python-TUI-only day-2 management; no bash surface participates.
