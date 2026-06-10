# Install-Failure Support Path

**Date:** 2026-04-28
**Status:** Approved

## Problem

When `ansible-playbook` fails inside the TUI installer (e.g. the
`nvme_namespace : Extract unique VGs from PVs` Jinja2 `split` filter error
seen in production), the user sees only:

1. A red `✗ Playbook failed (exit N)` line in `PlaybookRunScreen`.
2. A toast `Installation failed (exit N). Check the log above.` from
   `InstallScreen`.

The user is given no instruction to capture diagnostic data or contact
support. Worse, the live playbook output is **never persisted to disk** —
once the user closes the screen, it is gone. `Collect Logs → Collect All`
therefore cannot recover the install log even if the user knows to run it.

## Goal

On install failure, direct the operator to run `Collect Logs → Collect All`
and email the resulting archive to `support@xinnor.io`. Make sure that
archive actually contains the playbook output that failed.

## Non-goals

- Parsing the failed task name out of Ansible output for the dialog title.
- Auto-uploading on failure (operator may not be on a network with egress).
- Touching the legacy bash menu (`startup_menu.sh` is deprecated per
  `CLAUDE.md`).

## Design

### 1. Persist playbook output to disk

`xinas_menu/screens/startup/playbook_screen.py` currently streams stdout
into a `RichLog` only. Extend `_run_playbook` to also append each line to
`/var/log/xinas/install.log` (created with mode 0644, parent dir 0755).

- Open the file once before the read loop, close in `finally`.
- Write a header line per run:
  `=== <ISO8601> | argv: <cmd> | cwd: <workdir> ===`
- Strip ANSI from the disk copy? **No** — keep raw bytes; `less -R` and
  most text editors handle them, and stripping requires extra parsing.
  The `RichLog` already gets the colored version on screen.
- If the file is not writable (non-root, missing dir) fall back to
  `/tmp/xinas-install.log` and log a warning to the on-screen log.

### 2. Failure dialog in InstallScreen

Replace the lone `self.app.notify(...)` at
`xinas_menu/screens/startup/install_screen.py:99` with a modal:

> **Installation failed (exit N)**
>
> Please run **Collect Logs → Collect All**, then email the resulting
> archive (`/tmp/<host>-logs-*.tgz`) to **<support@xinnor.io>** so we can
> investigate.
>
> [ Go to Collect Logs ] [ Close ]

Reuse `xinas_menu/widgets/confirm_dialog.py` if its API supports custom
button labels; otherwise add a small `SupportDialog` widget in
`xinas_menu/widgets/`. Either way, "Go to Collect Logs" pushes
`CollectLogsScreen` (already exists).

The dialog only appears on `exit_code != 0`. Success path keeps the
existing notification.

### 3. Include install log in Collect Logs archive

In `xinas_menu/screens/collect_logs.py`, add to the `steps` list (after
"Audit log"):

```python
("Install playbook log", lambda: _collect_file(tmp, "install-playbook.log", "/var/log/xinas/install.log")),
("Install bootstrap log", lambda: _collect_file(tmp, "install-bootstrap.log", "/tmp/xinas-install.log")),
```

`_collect_file` already writes "(file not found)\n" gracefully when the
file is missing — fine for systems where one of the two paths was never
written.

### 4. PlaybookRunScreen final status

When `exit_code != 0`, change the status label from:
`✗ Playbook failed (exit N).`
to:
`✗ Playbook failed (exit N). Run Collect Logs and email to support@xinnor.io.`

This catches the case where the operator dismisses the
`InstallScreen` dialog and stares at the playbook screen instead.

## Files touched

| File | Change |
|---|---|
| `xinas_menu/screens/startup/playbook_screen.py` | Tee output to `/var/log/xinas/install.log`; final-status copy. |
| `xinas_menu/screens/startup/install_screen.py` | Failure dialog with "Go to Collect Logs" button. |
| `xinas_menu/screens/collect_logs.py` | Two extra `_collect_file` steps for the install logs. |
| `xinas_menu/widgets/support_dialog.py` *(new, only if `ConfirmDialog` lacks button-label customization)* | Two-button modal. |

## Testing

Manual (no automated TUI test infra):

1. Force a failure — temporarily edit a playbook so a task fails, run
   install via `xinas-setup`, confirm:
   - `/var/log/xinas/install.log` exists and contains the failed run.
   - The new dialog appears with both buttons.
   - "Go to Collect Logs" lands on the Collect Logs screen.
   - `Collect All` archive contains `install-playbook.log`.
2. Success path — confirm the dialog does **not** appear, success toast
   still shows.
3. Non-root run — confirm fallback to `/tmp/xinas-install.log` works
   (or that the warning is shown if both paths are unwritable).

## Risk

Low. All changes are additive UI/log paths. The only state mutation is
appending to `/var/log/xinas/install.log`, owned by the installer process.
No existing test relies on the absence of that file.
