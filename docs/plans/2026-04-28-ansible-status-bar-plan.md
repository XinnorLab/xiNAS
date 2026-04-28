# Compact Ansible Status Bar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace verbose `ansible-playbook` output with a compact, single-line status indicator while running, with the full log available on demand. Ship parallel improvements to both the bash installer (`lib/menu_lib.sh`) and the Python Textual TUI (`xinas_menu/screens/startup/playbook_screen.py`).

**Architecture:** Display-layer change only. The playbook invocation, env vars, exit-code handling, and tee-to-`/var/log/xinas/install.log` are unchanged. The Python side wraps the existing `RichLog` in a collapsible `Container`, adds a spinner+elapsed `StatusBar` widget, and parses `PLAY [...]`/`TASK [...]` headers from stdout to drive the bar. The bash side pipes through an awk filter that overwrites a single ticker line with `\r` + clear-to-EOL, with a TTY guard for non-interactive runs. Both surfaces tee the unfiltered stream to the install log.

**Tech Stack:** Python 3.10+, Textual (already a dep), bash 4+, awk, less.

**Design doc:** [docs/plans/2026-04-28-ansible-status-bar-design.md](docs/plans/2026-04-28-ansible-status-bar-design.md)

**Testing reality:** xiNAS has no Python unit tests and no `bats` suite — per CLAUDE.md, "validation occurs through Ansible modules" and TUI/shell display logic is verified manually on a real test box. Each task therefore ends with a syntax-only check that this session can run, plus a clearly-marked **Manual on test box** verification that the executor performs (or defers to Task 11) when they have hardware available.

---

## Phase 1 — Python TUI

All edits in `xinas_menu/screens/startup/playbook_screen.py` and `xinas_menu/styles.tcss`. The screen is currently 165 lines; final state is ~290.

### Task 1: Wrap the existing RichLog in a collapsible Container

**Files:**
- Modify: `xinas_menu/screens/startup/playbook_screen.py:67-72` (the `compose` method) and `xinas_menu/screens/startup/playbook_screen.py:11-14` (imports)
- Modify: `xinas_menu/styles.tcss` (append a small block at end of file)

**Step 1: Add Container to imports**

In `xinas_menu/screens/startup/playbook_screen.py`, change line 11–14 from:

```python
from textual.app import ComposeResult
from textual.binding import Binding
from textual.screen import Screen
from textual.widgets import Button, Label, RichLog
```

to:

```python
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.screen import Screen
from textual.widgets import Button, Label, RichLog
```

**Step 2: Wrap the RichLog in a Container in `compose()`**

Replace the body of `compose()` (lines 67–72) with:

```python
def compose(self) -> ComposeResult:
    yield Label(f"  ── {self._title} ──", id="pb-title")
    yield Label(f"  $ {' '.join(self._cmd)}", id="pb-cmd")
    with Container(id="pb-log-panel"):
        yield RichLog(highlight=True, markup=True, id="playbook-log")
    yield Label("  Running…", id="pb-status")
    yield Button("View Log", id="pb-toggle-log")
    yield Button("Close [Esc]", id="pb-close", disabled=True)
```

**Step 3: Add CSS rule for the panel's hidden state**

Append to `xinas_menu/styles.tcss`:

```css
/* ── Playbook Run screen ─────────────────────────────────────── */
#pb-log-panel {
    height: 1fr;
    display: none;
}

#pb-log-panel.visible {
    display: block;
}
```

**Step 4: Add the toggle action and key binding**

In `xinas_menu/screens/startup/playbook_screen.py`, change the `BINDINGS` block (line 49–51) to:

```python
BINDINGS = [
    Binding("escape", "dismiss_zero", "Close (when done)", show=True),
    Binding("l", "toggle_log", "Toggle Log", show=True),
]
```

Add a new method on the screen class (place it after `action_dismiss_zero`):

```python
def action_toggle_log(self) -> None:
    panel = self.query_one("#pb-log-panel", Container)
    btn = self.query_one("#pb-toggle-log", Button)
    if panel.has_class("visible"):
        panel.remove_class("visible")
        btn.label = "View Log"
    else:
        panel.add_class("visible")
        btn.label = "Hide Log"
```

Wire the on-screen button to the same action — extend `on_button_pressed`:

```python
def on_button_pressed(self, event: Button.Pressed) -> None:
    if event.button.id == "pb-close" and not self._running:
        self.dismiss(self._exit_code)
    elif event.button.id == "pb-toggle-log":
        self.action_toggle_log()
```

**Step 5: Syntax-check Python**

Run from worktree root:

```
python3 -c "import ast; ast.parse(open('xinas_menu/screens/startup/playbook_screen.py').read())"
```

Expected: no output (success).

**Step 6: Commit**

```bash
git add xinas_menu/screens/startup/playbook_screen.py xinas_menu/styles.tcss
git commit -m "feat(playbook-screen): wrap log in collapsible panel, add L toggle

Hides the verbose ansible-playbook output by default. Operators press
L (or click View Log) to expand the panel. No behavioral change to the
subprocess or to the install-log file.
"
```

---

### Task 2: Add the StatusBar widget (spinner + elapsed timer)

**Files:**
- Modify: `xinas_menu/screens/startup/playbook_screen.py` (top of file, near the other helpers)

**Step 1: Add the StatusBar widget class**

Above the `class PlaybookRunScreen` declaration (after the `_open_install_log` helper), add:

```python
_SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


class _PlaybookStatusBar(Label):
    """Single-line live status: spinner + current task + elapsed timer.

    States: 'running' (animated spinner), 'success' (green ✓), 'failure' (red ✗).
    """

    def __init__(self, **kwargs) -> None:
        super().__init__("", id="pb-statusbar", **kwargs)
        self._frame = 0
        self._task_name = "Starting…"
        self._started_at: float = 0.0
        self._state = "running"  # 'running' | 'success' | 'failure'
        self._spin_timer = None
        self._tick_timer = None

    def on_mount(self) -> None:
        import time
        self._started_at = time.monotonic()
        self._spin_timer = self.set_interval(0.1, self._advance_spinner)
        self._tick_timer = self.set_interval(1.0, self._refresh)
        self._refresh()

    def set_task(self, name: str) -> None:
        self._task_name = name
        self._refresh()

    def mark_success(self) -> None:
        self._state = "success"
        self._stop_timers()
        self._refresh()

    def mark_failure(self, task_name: str | None = None) -> None:
        self._state = "failure"
        if task_name:
            self._task_name = task_name
        self._stop_timers()
        self._refresh()

    def _stop_timers(self) -> None:
        if self._spin_timer is not None:
            self._spin_timer.stop()
            self._spin_timer = None

    def _advance_spinner(self) -> None:
        self._frame = (self._frame + 1) % len(_SPINNER_FRAMES)
        self._refresh()

    def _refresh(self) -> None:
        import time
        elapsed = max(0, int(time.monotonic() - self._started_at)) if self._started_at else 0
        h, rem = divmod(elapsed, 3600)
        m, s = divmod(rem, 60)
        clock = f"{h:02d}:{m:02d}:{s:02d}"
        if self._state == "success":
            self.update(f"  [green]✓[/green]  Completed                              {clock}")
        elif self._state == "failure":
            self.update(f"  [red]✗[/red]  FAILED: TASK [{self._task_name}]    {clock}")
        else:
            spin = _SPINNER_FRAMES[self._frame]
            self.update(f"  [cyan]{spin}[/cyan]  TASK [{self._task_name}]    {clock}")
```

**Step 2: Replace the static `pb-status` label with the StatusBar**

In `compose()`, change the `Running…` label line (now in Task 1's modified compose) from:

```python
    yield Label("  Running…", id="pb-status")
```

to:

```python
    yield _PlaybookStatusBar()
```

**Step 3: Update the success/failure handlers to call the StatusBar**

In `_run_playbook()`, replace the post-loop status update block (currently around line 136–142) so it calls the StatusBar's mark methods:

```python
        finally:
            if log_fh is not None:
                try:
                    log_fh.close()
                except OSError:
                    pass
            self._running = False
            statusbar = self.query_one(_PlaybookStatusBar)
            if self._exit_code == 0:
                statusbar.mark_success()
            else:
                statusbar.mark_failure()
            close_btn.disabled = False
            self.app.audit.log(
                "playbook.run",
                " ".join(self._cmd[:4]),
                "OK" if self._exit_code == 0 else "FAIL",
            )
```

Also remove the now-unused `status = self.query_one("#pb-status", Label)` line near the top of `_run_playbook()`.

**Step 4: Add a CSS rule for the StatusBar**

Append to `xinas_menu/styles.tcss`:

```css
#pb-statusbar {
    height: 1;
    background: #111520;
    color: $text;
    padding: 0 1;
}
```

**Step 5: Syntax-check**

Run:

```
python3 -c "import ast; ast.parse(open('xinas_menu/screens/startup/playbook_screen.py').read())"
```

Expected: no output.

**Step 6: Commit**

```bash
git add xinas_menu/screens/startup/playbook_screen.py xinas_menu/styles.tcss
git commit -m "feat(playbook-screen): add live status bar with spinner + elapsed

Replaces the static 'Running…' label with a self-contained widget that
animates a braille spinner and ticks an elapsed clock. State machine
covers running / success / failure; later tasks wire task-name updates
and failure detection into it.
"
```

---

### Task 3: Parse PLAY / TASK headers from stdout into the StatusBar

**Files:**
- Modify: `xinas_menu/screens/startup/playbook_screen.py` (`_run_playbook` method body)

**Step 1: Add the parser as a helper method on `PlaybookRunScreen`**

Place this method above `_run_playbook`:

```python
import re as _re

_TASK_RE = _re.compile(r"^\s*TASK \[(.+?)\]\s*\*+\s*$")
_PLAY_RE = _re.compile(r"^\s*PLAY \[(.+?)\]\s*\*+\s*$")


def _parse_status_line(self, line: str) -> None:
    """Inspect a stdout line and update the StatusBar if it's a PLAY/TASK header."""
    m = self._TASK_RE.match(line)
    if m:
        self._current_task = m.group(1).strip()
        self.query_one(_PlaybookStatusBar).set_task(self._current_task)
        return
    m = self._PLAY_RE.match(line)
    if m:
        self._current_play = m.group(1).strip()
        return
```

(Put `_TASK_RE` / `_PLAY_RE` at module level — top of file with the other module-level constants — not inside the class. Move `import re` to the top with the other imports.)

**Step 2: Initialize parser state in `__init__`**

Add to `__init__` (after `self._running = False`):

```python
        self._current_task: str = ""
        self._current_play: str = ""
        self._failure_seen: bool = False
```

**Step 3: Call the parser inside the stdout loop**

In `_run_playbook`, change the `async for raw in proc.stdout:` block — between the file-write and the colorize-and-write — to:

```python
            async for raw in proc.stdout:
                if log_fh is not None:
                    try:
                        log_fh.write(raw)
                        log_fh.flush()
                    except OSError:
                        pass
                line = raw.decode(errors="replace").rstrip()
                self._parse_status_line(line)
                # Color-code Ansible output (existing rules unchanged below)
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
```

**Step 4: Syntax-check**

```
python3 -c "import ast; ast.parse(open('xinas_menu/screens/startup/playbook_screen.py').read())"
```

Expected: no output.

**Step 5: Sanity-check the regex with the actual `ansible-playbook` line shapes**

Run inline:

```
python3 - <<'PY'
import re
TASK_RE = re.compile(r"^\s*TASK \[(.+?)\]\s*\*+\s*$")
PLAY_RE = re.compile(r"^\s*PLAY \[(.+?)\]\s*\*+\s*$")
samples = [
    "TASK [common : install packages] *********************************************",
    "PLAY [Common baseline] *********************************************************",
    "ok: [localhost]",
    "TASK [doca_ofed : ensure /opt/mellanox exists] **************",
]
for s in samples:
    print("TASK:", TASK_RE.match(s).group(1) if TASK_RE.match(s) else None,
          "| PLAY:", PLAY_RE.match(s).group(1) if PLAY_RE.match(s) else None,
          "| line:", s[:60])
PY
```

Expected: TASK matches yield the bracketed name, PLAY matches yield the play name, the `ok:` line yields `None / None`.

**Step 6: Commit**

```bash
git add xinas_menu/screens/startup/playbook_screen.py
git commit -m "feat(playbook-screen): parse PLAY/TASK headers into status bar

Each ansible-playbook stdout line is inspected before being written to
the RichLog. PLAY [...] headers update the remembered play name; TASK
[...] headers update the live status bar. Pure additive — colorization
and log-write paths are unchanged.
"
```

---

### Task 4: Wire failure detection — auto-expand panel + red status

**Files:**
- Modify: `xinas_menu/screens/startup/playbook_screen.py`

**Step 1: Extend `_parse_status_line` to detect failure lines**

Add to the parser, after the TASK / PLAY blocks:

```python
    if line.startswith("fatal:") or line.startswith("failed:") or "ERROR!" in line:
        if not self._failure_seen:
            self._failure_seen = True
            self._auto_expand_log_on_failure()
```

**Step 2: Add the auto-expand helper**

Add to the screen class:

```python
def _auto_expand_log_on_failure(self) -> None:
    """When a failure is first detected, open the log panel so the error is visible."""
    panel = self.query_one("#pb-log-panel", Container)
    btn = self.query_one("#pb-toggle-log", Button)
    if not panel.has_class("visible"):
        panel.add_class("visible")
        btn.label = "Hide Log"
```

**Step 3: Pass current task into `mark_failure` on exit**

Update the `finally` block in `_run_playbook` so the StatusBar gets the task name:

```python
            statusbar = self.query_one(_PlaybookStatusBar)
            if self._exit_code == 0:
                statusbar.mark_success()
            else:
                statusbar.mark_failure(task_name=self._current_task or "(unknown)")
                # Ensure the log panel is open even if the failure marker
                # was not in the stream (e.g. process killed externally).
                self._auto_expand_log_on_failure()
```

**Step 4: Syntax-check**

```
python3 -c "import ast; ast.parse(open('xinas_menu/screens/startup/playbook_screen.py').read())"
```

Expected: no output.

**Step 5: Commit**

```bash
git add xinas_menu/screens/startup/playbook_screen.py
git commit -m "feat(playbook-screen): auto-expand log + red status on failure

When a fatal: / failed: / ERROR! line is seen — or the process exits
non-zero — the log panel auto-expands so the error block is immediately
visible, and the status bar swaps to a red ✗ with the failed task name.
"
```

---

### Task 5: Edge cases — pre-task phase and stalled-task hint

**Files:**
- Modify: `xinas_menu/screens/startup/playbook_screen.py`

**Step 1: Add a stall watchdog timer**

In `_PlaybookStatusBar`, add a "last task change" timestamp and append `· still running` when no new task has been seen for >30 s. Modify `set_task`:

```python
def set_task(self, name: str) -> None:
    import time
    self._task_name = name
    self._task_set_at = time.monotonic()
    self._refresh()
```

In `__init__`, add:

```python
        self._task_set_at: float = 0.0
```

In `on_mount`, set the initial value:

```python
        import time
        self._started_at = time.monotonic()
        self._task_set_at = self._started_at
```

In `_refresh`, after computing `clock` but before constructing the running-state string, compute a `stall_suffix`:

```python
        stall_suffix = ""
        if self._state == "running" and self._task_set_at:
            stall = time.monotonic() - self._task_set_at
            if stall > 30:
                stall_suffix = "  [dim]· still running[/dim]"
```

And in the running branch, append it:

```python
        else:
            spin = _SPINNER_FRAMES[self._frame]
            self.update(f"  [cyan]{spin}[/cyan]  TASK [{self._task_name}]{stall_suffix}    {clock}")
```

(Be sure `time` is imported once at the top of `_refresh` — or hoist `import time` to the top of the file with the other imports for cleanliness.)

**Step 2: Default initial task text already says `Starting…`**

The widget's `__init__` sets `self._task_name = "Starting…"` and the running-state format string above already produces `TASK [Starting…]` — clean enough. No further change needed.

If you want the tighter pre-task display (no `TASK [...]` wrapper before the first real TASK is seen), add a flag `self._task_seen = False` in `__init__`, flip to `True` in `set_task`, and branch in `_refresh`:

```python
        else:
            spin = _SPINNER_FRAMES[self._frame]
            if not self._task_seen:
                self.update(f"  [cyan]{spin}[/cyan]  Starting…{stall_suffix}    {clock}")
            else:
                self.update(f"  [cyan]{spin}[/cyan]  TASK [{self._task_name}]{stall_suffix}    {clock}")
```

**Step 3: Syntax-check**

```
python3 -c "import ast; ast.parse(open('xinas_menu/screens/startup/playbook_screen.py').read())"
```

Expected: no output.

**Step 4: Commit**

```bash
git add xinas_menu/screens/startup/playbook_screen.py
git commit -m "feat(playbook-screen): pre-task 'Starting…' state and stall hint

Before the first TASK header is parsed, the status bar reads 'Starting…'
instead of 'TASK [Starting…]'. If no new task arrives for 30+ seconds —
common during long downloads inside a single Ansible task — append
'· still running' so the operator can see we're not frozen.
"
```

---

## Phase 2 — Bash installer

All edits in `lib/menu_lib.sh`. The `xinas_run_playbook` function is currently 45 lines (907–951); final state is ~95.

### Task 6: Add the awk filter for PLAY/TASK ticker

**Files:**
- Modify: `lib/menu_lib.sh:907-951` (the `xinas_run_playbook` function)

**Step 1: Define the filter function above `xinas_run_playbook`**

Insert immediately before line 896 (the `# ════…` divider that starts the `xinas_run_playbook` block):

```bash
# ═══════════════════════════════════════════════════════════════════════════════
# _xinas_playbook_ticker — awk filter that compresses PLAY/TASK headers into a
# single overwriting status line. Errors and warnings pass through verbatim so
# they remain visible inline.
# ═══════════════════════════════════════════════════════════════════════════════
_xinas_playbook_ticker() {
    awk '
    BEGIN {
        spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
        sp_n = 10
        sp_i = 0
        # ANSI: \r = carriage return; \033[K = clear to end of line
        CR = "\r"
        EL = "\033[K"
    }
    /^[[:space:]]*PLAY \[/ {
        match($0, /PLAY \[[^]]*\]/)
        play = substr($0, RSTART, RLENGTH)
        sp_i = (sp_i + 1) % sp_n
        glyph = substr(spinner, sp_i*3+1, 3)
        printf "%s%s %s %s%s", CR, EL, glyph, play, EL
        fflush()
        next
    }
    /^[[:space:]]*TASK \[/ {
        match($0, /TASK \[[^]]*\]/)
        task = substr($0, RSTART, RLENGTH)
        sp_i = (sp_i + 1) % sp_n
        glyph = substr(spinner, sp_i*3+1, 3)
        printf "%s%s %s %s%s", CR, EL, glyph, task, EL
        fflush()
        next
    }
    /^fatal:/ || /^failed:/ || /ERROR!/ {
        printf "\n%s\n", $0
        fflush()
        next
    }
    /^PLAY RECAP/ {
        printf "\n%s\n", $0
        fflush()
        in_recap = 1
        next
    }
    in_recap == 1 {
        # Pass recap host lines through verbatim
        print
        fflush()
        next
    }
    # All other lines: swallow (full content is in the install log file)
    { next }
    END {
        printf "\n"
    }
    '
}
```

**Step 2: Modify `xinas_run_playbook` to pipe through the filter**

Change line 933 from:

```bash
    ansible-playbook "$@" 2>&1 | tee -a "$log_path"
```

to:

```bash
    ansible-playbook "$@" 2>&1 | tee -a "$log_path" | _xinas_playbook_ticker
    rc=${PIPESTATUS[0]}
```

(The existing `rc=${PIPESTATUS[0]}` on line 934 still captures the playbook exit code — `PIPESTATUS[0]` is unaffected by adding more pipe stages.)

**Step 3: Syntax-check bash**

Run from worktree root:

```
bash -n lib/menu_lib.sh
```

Expected: no output.

Also check the awk script in isolation:

```
echo 'PLAY [Test play] ********
TASK [common : install packages] ***
ok: [localhost]
fatal: [localhost]: FAILED!
PLAY RECAP **********
localhost                  : ok=1    changed=0    unreachable=0    failed=1' \
| awk '
BEGIN { spinner="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; sp_n=10; sp_i=0; CR="\r"; EL="\033[K" }
/^[[:space:]]*PLAY \[/ { match($0,/PLAY \[[^]]*\]/); play=substr($0,RSTART,RLENGTH); sp_i=(sp_i+1)%sp_n; glyph=substr(spinner,sp_i*3+1,3); printf "%s%s %s %s%s", CR, EL, glyph, play, EL; fflush(); next }
/^[[:space:]]*TASK \[/ { match($0,/TASK \[[^]]*\]/); task=substr($0,RSTART,RLENGTH); sp_i=(sp_i+1)%sp_n; glyph=substr(spinner,sp_i*3+1,3); printf "%s%s %s %s%s", CR, EL, glyph, task, EL; fflush(); next }
/^fatal:/ || /^failed:/ || /ERROR!/ { printf "\n%s\n", $0; fflush(); next }
/^PLAY RECAP/ { printf "\n%s\n", $0; fflush(); in_recap=1; next }
in_recap==1 { print; fflush(); next }
{ next }
END { printf "\n" }' | cat -v
```

Expected (rendering `^M` and `^[[K` as literal escape markers via `cat -v`): a stream of `^M^[[K ⠙ PLAY [Test play]^[[K`-style updates, the `fatal:` line on its own line, and the `PLAY RECAP` block printed verbatim.

**Step 4: Commit**

```bash
git add lib/menu_lib.sh
git commit -m "feat(installer): compress ansible PLAY/TASK headers into ticker line

Adds _xinas_playbook_ticker, an awk filter that overwrites a single
status line with the current PLAY/TASK header as ansible streams. Error
lines (fatal:, failed:, ERROR!) and the PLAY RECAP block pass through
verbatim. The unfiltered stream is still tee'd to the install log.
"
```

---

### Task 7: Add TTY guard for non-interactive runs

**Files:**
- Modify: `lib/menu_lib.sh` (the line modified in Task 6)

**Step 1: Conditionally bypass the ticker**

Replace the line modified in Task 6:

```bash
    ansible-playbook "$@" 2>&1 | tee -a "$log_path" | _xinas_playbook_ticker
    rc=${PIPESTATUS[0]}
```

with:

```bash
    if [ -t 1 ]; then
        ansible-playbook "$@" 2>&1 | tee -a "$log_path" | _xinas_playbook_ticker
        rc=${PIPESTATUS[0]}
    else
        # Non-TTY (CI, redirected install): preserve verbose passthrough
        ansible-playbook "$@" 2>&1 | tee -a "$log_path"
        rc=${PIPESTATUS[0]}
    fi
```

**Step 2: Syntax-check**

```
bash -n lib/menu_lib.sh
```

Expected: no output.

**Step 3: Verify the guard with a redirected dummy run**

Run from worktree root:

```
bash -c '
source lib/menu_lib.sh 2>/dev/null || true
# Verify the function exists and the [ -t 1 ] guard reaches the else branch.
( echo "PLAY [Demo] ***"
  echo "TASK [demo : noop] ***"
  echo "ok: [localhost]" ) > /tmp/xinas-tty-guard-test.txt
[ -t 1 ] && echo "TTY: ticker path" || echo "NON-TTY: verbose path"
' < /dev/null > /tmp/xinas-tty-guard-test.out 2>&1
cat /tmp/xinas-tty-guard-test.out
```

Expected output: `NON-TTY: verbose path` (because stdout is redirected to a file).

**Step 4: Commit**

```bash
git add lib/menu_lib.sh
git commit -m "feat(installer): bypass status-bar ticker on non-TTY runs

When stdout is not a terminal (CI, redirected install), the ticker's
\\r overwrite would corrupt the captured log. Detect with [ -t 1 ] and
fall through to the original verbose passthrough behavior.
"
```

---

### Task 8: Replace failure msg_box with three-button dialog

**Files:**
- Modify: `lib/menu_lib.sh:936-945` (the `if [ "$rc" -ne 0 ]` block)

**Step 1: Find the existing `menu` helper**

The bash menus build whiptail menus via a `menu` helper in the same file. Verify it exists and check its calling convention by running:

```
grep -n "^menu()" lib/menu_lib.sh
```

If a `menu` helper exists with a `menu "Title" "Prompt" tag1 "label1" tag2 "label2" ...` shape, use it directly. If not (or if the convention differs), the dialog can be assembled with `whiptail --menu` directly.

**Step 2: Replace the failure block**

Replace lines 936–945 (the `if [ "$rc" -ne 0 ]; then ... fi` block) with:

```bash
    if [ "$rc" -ne 0 ]; then
        while true; do
            local choice=""
            if command -v whiptail >/dev/null 2>&1; then
                choice=$(whiptail --title "Installation Failed" \
                    --menu "Installation failed (exit ${rc}).\n\nFull log: ${log_path}" \
                    16 70 3 \
                    "collect" "Collect Logs (auto-uploads diagnostic archive)" \
                    "view"    "View Log (opens less +G on full output)" \
                    "close"   "Continue (return to menu)" \
                    3>&1 1>&2 2>&3) || choice="close"
            else
                # No whiptail (very rare — e.g. very early bootstrap before
                # prepare_system.sh installed it). Fall back to plain prompt.
                printf '\n  Installation failed (exit %s).\n' "$rc" >&2
                printf '  [c]ollect logs / [v]iew log / [q]uit: ' >&2
                read -r ans
                case "$ans" in
                    c|C) choice="collect" ;;
                    v|V) choice="view" ;;
                    *)   choice="close" ;;
                esac
            fi

            case "$choice" in
                view)
                    if [ -r "$log_path" ] && command -v less >/dev/null 2>&1; then
                        less +G "$log_path"
                    elif [ -r "$log_path" ]; then
                        # less missing — fall back to whiptail textbox if available
                        if command -v whiptail >/dev/null 2>&1; then
                            whiptail --title "Install Log" --textbox "$log_path" 24 100
                        else
                            printf '\n  Log file: %s\n' "$log_path" >&2
                        fi
                    fi
                    # Loop back to dialog
                    ;;
                collect|close|*)
                    break
                    ;;
            esac
        done
    fi
```

**Step 3: Syntax-check**

```
bash -n lib/menu_lib.sh
```

Expected: no output.

**Step 4: Commit**

```bash
git add lib/menu_lib.sh
git commit -m "feat(installer): three-option dialog on playbook failure

Replaces the single 'Installation Failed' msg_box with a three-button
menu: Collect Logs / View Log / Continue. View Log runs 'less +G' on
the install log so the operator can scroll the full output before
deciding whether to collect logs. Picking View loops back to the dialog.
"
```

---

## Phase 3 — Verification

### Task 9: Quick smoke verification (this session, no test box required)

**Step 1: Verify both files import / parse**

```
python3 -c "import ast; ast.parse(open('xinas_menu/screens/startup/playbook_screen.py').read()); print('python OK')"
bash -n lib/menu_lib.sh && echo "bash OK"
```

Expected: `python OK` then `bash OK`.

**Step 2: Re-run the awk-filter sanity check from Task 6 Step 3**

Confirm the captured demo output still shows:
- ticker overwrite for PLAY/TASK lines,
- `fatal:` printed inline on its own line,
- `PLAY RECAP` printed verbatim with host summary.

**Step 3: No commit** (verification only).

---

### Task 10: Manual on test box — Python TUI

**Run only on a real or dev xiNAS box; cannot be performed from this session.**

Each of the four scenarios should be exercised; record pass/fail in the commit message of Task 11.

**Scenario 10.A — Success path (xinas_menu install)**

1. From the worktree on the test box: `python3 -m xinas_menu`
2. Navigate to install / re-run for the active preset.
3. Confirm:
   - StatusBar shows `Starting…` then transitions to the first `TASK [...]` name within seconds.
   - Spinner glyph rotates smoothly (not stuck on one frame).
   - Elapsed clock advances `00:00:01`, `00:00:02`, …
   - Log panel is hidden; only the StatusBar is visible.
   - Pressing `L` shows the colorized log; pressing `L` again hides it.
   - On `PLAY RECAP`, spinner stops, glyph turns green `✓`, status reads `✓ Completed   HH:MM:SS`.
   - `Close [Esc]` enables.

**Scenario 10.B — Failure path (xinas_menu install)**

1. Edit a preset's `raid_fs.yml` to point an array at a non-existent device (or `pkill -9 ansible-playbook` from another shell mid-run).
2. Re-run install via `xinas_menu`.
3. Confirm:
   - Log panel auto-expands the moment the `fatal:` / `failed:` line streams in.
   - Spinner stops, glyph turns red `✗`.
   - StatusBar reads `✗ FAILED: TASK [<name>]   HH:MM:SS` with the failing task name.
   - The error block is visible in the log panel without scrolling.
   - Existing caller-side failure dialog ([install_screen.py:99](xinas_menu/screens/startup/install_screen.py:99)) still appears after Close.

**Scenario 10.C — MCP role install (no caller regression)**

1. From `xinas_menu`, run the MCP install action (Settings → MCP → Install).
2. Confirm same StatusBar UX as 10.A.
3. Confirm the MCP install completes successfully and registers the systemd unit (existing behavior).

**Scenario 10.D — Stall hint**

1. Find a long-running task in your environment (e.g. an `apt update` over a slow link, or temporarily add a `command: sleep 45` task to a preset's playbook).
2. Confirm: after 30 s of no new TASK header, the status line gains `· still running` in dim text.

---

### Task 11: Manual on test box — Bash installer

**Run only on a real or dev xiNAS box.**

**Scenario 11.A — Success path (interactive TTY)**

1. From the worktree on the test box: `./startup_menu.sh` (or `./simple_menu.sh`) and pick "Run Ansible playbook".
2. Confirm:
   - A single ticker line replaces the verbose stream — TASK / PLAY headers overwrite each other in place.
   - Spinner glyph rotates as new headers arrive.
   - `fatal:`-class lines, if any, appear on their own newline (not overwritten).
   - On `PLAY RECAP`, the recap renders normally with all host summaries visible.
   - `/var/log/xinas/install.log` contains the full unfiltered output (verify with `grep -c "^TASK \[" /var/log/xinas/install.log` — should match the number of tasks ansible ran).

**Scenario 11.B — Failure path (interactive TTY)**

1. Induce a failure as in 10.B and re-run via `startup_menu.sh`.
2. Confirm:
   - Error lines pass through inline.
   - Failure dialog offers `Collect Logs` / `View Log` / `Continue`.
   - Picking `View Log` opens `less +G /var/log/xinas/install.log` at the bottom of the file with the failure visible; `q` returns to the dialog (loop verified).
   - Picking `Continue` returns to the menu without erroring.
   - Picking `Collect Logs` triggers the existing collect-logs flow.

**Scenario 11.C — Non-TTY guard**

1. From a non-interactive shell:
   ```
   ./startup_menu.sh < /dev/null > /tmp/install-noninteractive.log 2>&1
   ```
   (Or invoke the playbook step directly via whatever non-interactive entrypoint your CI uses.)
2. Confirm `/tmp/install-noninteractive.log` contains the **full verbose** ansible output, with no `\r` or escape sequences from the ticker — i.e. the guard worked.

**Scenario 11.D — Recovery / commit**

1. Once all four scenarios pass on the bash side and the four scenarios in Task 10 pass on the Python side, no further code change is needed.
2. Commit the verification record:

```bash
# Append a verification note to the design doc.
git commit --allow-empty -m "test(playbook-status): manual verification on <hostname>

Python TUI:
- 10.A success path: PASS
- 10.B failure path: PASS
- 10.C MCP install: PASS
- 10.D stall hint: PASS

Bash installer:
- 11.A success path: PASS
- 11.B failure path + View Log loop: PASS
- 11.C non-TTY guard: PASS

Verified on: <hostname>, <ubuntu version>, <ansible-core version>
"
```

(If anything fails: open a follow-up commit fixing the specific issue, then re-run the affected scenario before the empty verification commit.)

---

## Reference: skills

- @superpowers:executing-plans — use this skill to execute the plan in a separate session.
- @superpowers:subagent-driven-development — use this skill to execute the plan in this session via per-task subagents.
- @superpowers:verification-before-completion — apply at the end of Task 11 before claiming the work is done.

## Summary of files touched

| File | Lines added | Lines changed | Lines deleted |
|---|---|---|---|
| `xinas_menu/screens/startup/playbook_screen.py` | ~120 | ~10 | ~5 |
| `xinas_menu/styles.tcss` | ~12 | 0 | 0 |
| `lib/menu_lib.sh` | ~70 | ~3 | ~10 |
| `CLAUDE.md` | ~3 | ~1 | ~1 |
| `docs/plans/2026-04-28-ansible-status-bar-design.md` | (new, committed) | — | — |
| `docs/plans/2026-04-28-ansible-status-bar-plan.md` | (new, this file) | — | — |

Total: ~205 lines added, ~14 changed, ~16 deleted across two implementation files. Eight implementation commits + two verification/manual-only tasks.
