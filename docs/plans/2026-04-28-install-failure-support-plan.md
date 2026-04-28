# Install-Failure Support Path Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a TUI install fails, persist the playbook log to disk, show a modal directing the user to **Collect Logs** + `support@xinnor.io`, and bundle the install log into the Collect Logs archive.

**Architecture:** Three additive changes in the Python TUI (`xinas_menu/`). No legacy bash menu work (deprecated). No new widget — reuse `ConfirmDialog` with custom button labels (`yes_label`, `no_label`). Install log lives at `/var/log/xinas/install.log`, with `/tmp/xinas-install.log` fallback when non-root.

**Tech Stack:** Python 3, Textual TUI, asyncio.

**Design doc:** [docs/plans/2026-04-28-install-failure-support-design.md](2026-04-28-install-failure-support-design.md)

---

## Task 1: Persist playbook output to `/var/log/xinas/install.log`

**Files:**
- Modify: `xinas_menu/screens/startup/playbook_screen.py:50-97`

**Step 1: Add helper to open the log file**

At module top (after imports), add:

```python
import datetime
import shlex

_INSTALL_LOG_PRIMARY = "/var/log/xinas/install.log"
_INSTALL_LOG_FALLBACK = "/tmp/xinas-install.log"


def _open_install_log(cmd: list[str], workdir: str) -> tuple[object | None, str | None]:
    """Open the install-log file in append mode. Try primary, fall back to /tmp.

    Returns (file_handle, path_used) or (None, None) if both paths fail.
    """
    for path in (_INSTALL_LOG_PRIMARY, _INSTALL_LOG_FALLBACK):
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, mode=0o755, exist_ok=True)
            fh = open(path, "ab")
            header = (
                f"\n=== {datetime.datetime.now().isoformat(timespec='seconds')} "
                f"| argv: {shlex.join(cmd)} | cwd: {workdir} ===\n"
            )
            fh.write(header.encode())
            fh.flush()
            return fh, path
        except OSError:
            continue
    return None, None
```

**Step 2: Tee output inside `_run_playbook`**

Replace the body of `_run_playbook` (lines 50-97) so each line streamed from the subprocess is also written to the log file.

```python
async def _run_playbook(self) -> None:
    log = self.query_one("#playbook-log", RichLog)
    status = self.query_one("#pb-status", Label)
    close_btn = self.query_one("#pb-close", Button)

    env = os.environ.copy()
    env.setdefault("ANSIBLE_FORCE_COLOR", "1")
    env.setdefault("PYTHONUNBUFFERED", "1")

    log_fh, log_path = _open_install_log(self._cmd, self._workdir)
    if log_path is None:
        log.write("[yellow]⚠ Could not open install log; output will not be saved to disk.[/yellow]")

    try:
        proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=self._workdir,
            env=env,
        )
        assert proc.stdout is not None
        async for raw in proc.stdout:
            if log_fh is not None:
                try:
                    log_fh.write(raw)
                    log_fh.flush()
                except OSError:
                    pass
            line = raw.decode(errors="replace").rstrip()
            if "PLAY RECAP" in line or "ok=" in line:
                log.write(f"[bold]{line}[/bold]")
            elif "FAILED" in line or "ERROR" in line or "error" in line.lower():
                log.write(f"[red]{line}[/red]")
            elif "changed" in line.lower() or "CHANGED" in line:
                log.write(f"[yellow]{line}[/yellow]")
            elif line.startswith("ok:") or "SUCCESS" in line:
                log.write(f"[green]{line}[/green]")
            else:
                log.write(line)
        await proc.wait()
        self._exit_code = proc.returncode
    except Exception as exc:
        log.write(f"[red]Failed to run playbook: {exc}[/red]")
        self._exit_code = 255
    finally:
        if log_fh is not None:
            try:
                log_fh.close()
            except OSError:
                pass
        self._running = False
        if self._exit_code == 0:
            status.update("  [green]✓ Playbook completed successfully.[/green]")
        else:
            status.update(
                f"  [red]✗ Playbook failed (exit {self._exit_code}). "
                f"Run Collect Logs and email to support@xinnor.io.[/red]"
            )
        close_btn.disabled = False
        self.app.audit.log(
            "playbook.run",
            " ".join(self._cmd[:4]),
            "OK" if self._exit_code == 0 else "FAIL",
        )
```

**Step 3: Manual smoke test**

Run: `python -c "from xinas_menu.screens.startup.playbook_screen import _open_install_log; fh,p=_open_install_log(['echo','hi'], '/tmp'); print(p); fh and fh.close()"`

Expected: prints `/var/log/xinas/install.log` if writable (root) else `/tmp/xinas-install.log`. The file at the printed path contains a header line `=== <ts> | argv: echo hi | cwd: /tmp ===`.

**Step 4: Commit**

```bash
git add xinas_menu/screens/startup/playbook_screen.py
git commit -m "feat(install): persist playbook output to /var/log/xinas/install.log"
```

---

## Task 2: Failure dialog in InstallScreen

**Files:**
- Modify: `xinas_menu/screens/startup/install_screen.py:95-99`

**Step 1: Replace failure-toast with `ConfirmDialog` modal**

In `_confirm_and_run`, change the post-run branch:

```python
        if exit_code == 0:
            await self.app.snapshots.record_baseline(preset=preset)
            self.app.notify("Installation completed successfully!", severity="information")
        else:
            go_collect = await self.app.push_screen_wait(
                ConfirmDialog(
                    f"Installation failed (exit {exit_code}).\n\n"
                    "Please run Collect Logs → Collect All, then email the\n"
                    "resulting archive (/tmp/<host>-logs-*.tgz) to\n"
                    "support@xinnor.io so we can investigate.",
                    title="Installation Failed",
                    yes_label="Go to Collect Logs",
                    no_label="Close",
                )
            )
            if go_collect:
                from xinas_menu.screens.collect_logs import CollectLogsScreen
                self.app.push_screen(CollectLogsScreen())
```

`ConfirmDialog` is already imported at the top of the file. No other changes needed.

**Step 2: Manual smoke test**

Force a failure: temporarily edit any preset playbook to reference a missing role, run `xinas-setup` → preset → confirm. After the playbook exits non-zero, verify:

- A modal titled "Installation Failed" appears with the message text.
- Two buttons: `Go to Collect Logs [y]` and `Close [n]`.
- Pressing "Go to Collect Logs" lands on the Collect Logs screen.
- Pressing "Close" or Esc returns to the install screen.
- Revert the playbook edit.

**Step 3: Commit**

```bash
git add xinas_menu/screens/startup/install_screen.py
git commit -m "feat(install): show support-path dialog when install fails"
```

---

## Task 3: Include install logs in Collect Logs archive

**Files:**
- Modify: `xinas_menu/screens/collect_logs.py:111-123`

**Step 1: Add two collection steps**

Insert after the existing `"Audit log"` step in the `steps` list:

```python
            ("Install playbook log", lambda: _collect_file(tmp, "install-playbook.log", "/var/log/xinas/install.log")),
            ("Install bootstrap log", lambda: _collect_file(tmp, "install-bootstrap.log", "/tmp/xinas-install.log")),
```

`_collect_file` (already defined at line 244) writes `(file not found)\n` if the path is missing — required behaviour for systems where one log doesn't exist.

**Step 2: Manual smoke test**

Run `xinas-menu` → Collect Logs → Collect All. After the run completes, list the archive:

```bash
tar tzf /tmp/$(hostname)-logs-*.tgz | grep install
```

Expected output:
```
install-playbook.log
install-bootstrap.log
```

If `/var/log/xinas/install.log` exists from a prior install run, `install-playbook.log` should contain that content; otherwise it will say `(file not found)`. Same for `/tmp/xinas-install.log`.

**Step 3: Commit**

```bash
git add xinas_menu/screens/collect_logs.py
git commit -m "feat(collect-logs): include install playbook + bootstrap logs in archive"
```

---

## Task 4: End-to-end smoke test

**Step 1: Run a known-failing install**

The Jinja2 `split` filter error from the bug report is a real-world fail. Either:
(a) reproduce it on the test rig if it's still present, or
(b) inject a deliberate failure: in `presets/default/playbook.yml`, add a single task `- fail: msg=test` at the top, then run `xinas-setup` → default.

**Step 2: Verify the full path**

- Playbook screen shows `✗ Playbook failed (exit 2). Run Collect Logs and email to support@xinnor.io.` in its status line.
- Closing the playbook screen lands on the InstallScreen and the `Installation Failed` modal appears.
- Press `Go to Collect Logs` → CollectLogsScreen renders.
- Run `Collect All` with any config name and email.
- Confirm the resulting `.tgz` contains `install-playbook.log` with the failed playbook output (search for the failed task name).

**Step 3: Revert any test-only changes**

```bash
git checkout -- presets/default/playbook.yml  # if you injected a fail task
```

No commit for this task — it's verification.

---

## Open follow-ups (intentionally out of scope)

- Log rotation for `/var/log/xinas/install.log` — defer until it actually grows; ad-hoc `truncate` will do for now.
- Stripping ANSI from the disk log — defer; `less -R` handles it.
- Auto-upload on failure — operator may not have egress; manual upload via "Upload Archive" stays the path.
