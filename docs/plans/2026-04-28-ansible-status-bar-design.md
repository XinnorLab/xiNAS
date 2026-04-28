# Compact Ansible Status Bar — Design

**Date:** 2026-04-28
**Scope:** Replace the verbose live-streamed `ansible-playbook` output with a compact status indicator while running, with the full log available on demand. Applies to both the Python Textual TUI (`PlaybookRunScreen`) and the bash installer (`xinas_run_playbook`).

## Motivation

Today, every `ansible-playbook` invocation from xiNAS dumps raw `-v` output straight at the operator — hundreds of `ok:`/`changed:` lines that scroll past faster than they can be read. The information that actually matters during a run is just "what task is running right now, and is it failing?" The full log is only useful after the fact.

This design hides the verbose stream behind a compact status indicator and gives the operator an explicit way to bring the detail back when they want it.

## Non-goals

- Changing what the playbooks themselves do or how Ansible is invoked.
- Replacing or restructuring the install-log file (`/var/log/xinas/install.log`). It continues to be written exactly as today and is still the source of truth for `collect-logs` bundles.
- Adding feature parity in the post-install bash management menus (`post_install_menu.sh`, `configure_*.sh`). Those remain deprecated per the updated CLAUDE.md scope rule.
- Backgrounding the playbook so the operator can navigate elsewhere mid-run. That was considered (option A in initial brainstorming) and rejected — operators stay on the install screen until it finishes.

## CLAUDE.md scope rule (updated)

The previous blanket "shell menu scripts are obsolete" wording has been replaced with a two-surface rule:

- **Installer / bootstrap (bash, still active):** `prepare_system.sh`, `startup_menu.sh`, `simple_menu.sh`, `lib/menu_lib.sh`. These run before the Python TUI is installed and remain the supported install path. Bug fixes and polish are welcome.
- **Post-install management (Python only):** `post_install_menu.sh`, `configure_*.sh`. Deprecated. Do not add new features there — use `xinas_menu/` (Textual TUI) instead.

When a feature touches both surfaces (as this one does), update both for feel-parity.

## Behavior — Python TUI

`xinas_menu/screens/startup/playbook_screen.py` (callers: `install_screen.py`, `mcp.py`).

### Layout

```
┌────────────────────────────────────────────────────────────┐
│  ── Running Ansible Playbook ──                            │
│  $ ansible-playbook playbooks/site.yml                     │
│                                                            │
│  ⠋  TASK [common : install packages]            00:01:23   │  ← StatusBar (always visible)
│                                                            │
│  ┌─ Detailed log ─────────────────────────── (hidden) ──┐  │  ← LogPanel (collapsed by default)
│  │                                                       │
│  └───────────────────────────────────────────────────────┘
│                                                            │
│           [ View Log (L) ]   [ Close (Esc) ]               │
└────────────────────────────────────────────────────────────┘
```

- **StatusBar** — single-line label: braille spinner + current task name + monospace `HH:MM:SS` elapsed timer. Updates in place; no scrolling.
- **LogPanel** — the existing `RichLog` (with current colorization rules unchanged) wrapped in a plain `Container` whose `display` CSS property toggles between `none` (collapsed) and `block` (expanded). `Container` chosen over Textual's `Collapsible` to avoid built-in header chrome.
- **Toggle** — `L` key binding (shown automatically in the Footer hint) and an on-screen `View Log` / `Hide Log` button both invoke the same toggle action.

### Stdout parsing rules

A `_parse_line(line)` method runs before each line is written to the RichLog:

| Line pattern | Action |
|---|---|
| `PLAY [<name>] *****` | Remember `current_play = <name>` (used in the failure detail block; not shown in StatusBar) |
| `TASK [<name>] *****` | Set `current_task = <name>`; StatusBar text refreshes |
| `fatal:` or `failed:` or `ERROR!` | Set `failure_seen = True`; capture this line + contiguous block until blank line or next `TASK`/`PLAY` header for the failure dialog |
| `PLAY RECAP` | Stop further StatusBar updates; freeze current state |
| anything else | Pass through unchanged |

Spinner is driven by a Textual `set_interval(0.1, ...)` callback. Elapsed timer by `set_interval(1.0, ...)`. Both stop on process exit.

### Edge cases

- **Pre-task phase** (gathering facts, parsing inventory): no `TASK` line has been seen yet. StatusBar reads `Starting…` with active spinner.
- **Long-running task** (>30 s without a new `TASK` header — typical inside long downloads): StatusBar appends `· still running` so the operator sees forward progress.
- **Output stalls entirely** (process hung): the spinner keeps animating but no other indication is given. Operators can press `L` to see the live log and decide.

### Failure behavior

When `failure_seen = True` *or* the process exits non-zero:

1. Spinner stops; glyph swaps to red `✗`.
2. StatusBar text becomes `✗ FAILED: TASK [<name>]   00:03:14`.
3. LogPanel auto-expands so the colorized error stream is visible immediately.
4. `Close` button enables. The toggle button label flips to `Hide Log` (since panel is open).
5. Existing `audit.log("playbook.run", ..., "FAIL")` call and the caller-side failure dialog flow are unchanged.

### Success behavior

On exit code 0:

1. Spinner stops; glyph swaps to green `✓`.
2. StatusBar text becomes `✓ Completed   HH:MM:SS`.
3. LogPanel state is left as the operator left it (collapsed by default).
4. `Close` button enables.

## Behavior — Bash installer

`lib/menu_lib.sh::xinas_run_playbook()` (callers: `startup_menu.sh::run_playbook`, `simple_menu.sh`).

The Textual collapsible-panel UX does not translate to whiptail. The bash side gets the *spirit* of the design at a coarser granularity:

### While running

- `ansible-playbook` output is piped through a small awk filter.
- The filter emits `PLAY [...]` and `TASK [...]` headers as a **single overwriting status line** using `\r` + clear-to-EOL.
- A rotating spinner glyph from `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` is prefixed and advanced on every emitted header. No separate spinner thread — keeps it portable and tmux-friendly.
- `fatal:` / `failed:` / `ERROR!` lines are passed through verbatim with a leading newline so errors are visible inline and never hidden behind the ticker.
- On `PLAY RECAP`, the filter prints a final newline and lets the recap render normally so the operator sees the per-host summary as today.

### TTY guard

If stdout is not a TTY (CI runs, redirected installs), the awk filter is bypassed entirely and the current verbose passthrough behavior is preserved. Detection: `[ -t 1 ]`.

### Tee to log

`tee -a "$log_path"` writes the **unfiltered** stream to `/var/log/xinas/install.log` exactly as today. The compact ticker is a display-only transformation; the log file always has the full output.

### Failure path

The existing `msg_box "Installation Failed"` is replaced with a `yes_no` (or three-button menu) offering:

- `[ Collect Logs ]` — closes dialog, returns to caller (which already routes to the collect-logs flow).
- `[ View Log ]` — runs `less +G "$log_path"` so the operator can scroll the full output, then re-shows the same dialog after `less` exits.
- `[ Continue ]` — closes dialog, returns to caller.

### What bash deliberately does NOT do

- No elapsed timer (would require a background process or signal handling that's fragile across whiptail pop-ins/outs).
- No in-place collapsible "panel" of recent lines (would require `tput`-driven cursor positioning that breaks under tmux/screen and on resize).
- No spinner advancing while a single task is running (only on `PLAY`/`TASK` header arrival). A constant-rate spinner needs a background process; the cost/benefit isn't there for a one-shot installer.

## Parity matrix

| Aspect | Bash installer | Python TUI |
|---|---|---|
| Default view | Single ticker line, no scrollback | Compact StatusBar, log panel collapsed |
| Status content | Spinner + current TASK name | Spinner + current TASK + elapsed |
| Spinner cadence | Per task header arrival | 10 Hz timer |
| Errors | Pass through unfiltered (visible inline) | Auto-expand log panel, status turns red |
| View full log | `less +G` from failure dialog | `L` key / `View Log` button toggles panel |
| Log file path | `/var/log/xinas/install.log` (unchanged) | `/var/log/xinas/install.log` (unchanged) |
| Non-TTY fallback | Verbose passthrough | N/A — Textual requires TTY |

## Implementation surface

### Python

- `xinas_menu/screens/startup/playbook_screen.py`: ~150 lines added, ~5 changed.
  - New `_PlaybookStatusBar` widget (Label + spinner timer + elapsed timer).
  - `Container` wrapping the existing `RichLog`, toggled via CSS `display`.
  - `Binding("l", "toggle_log", "Toggle Log", show=True)`.
  - `_parse_line(line)` regex set per the table above.
  - Existing log-file writing, env vars, exit-code handling untouched.
- `xinas_menu/styles.tcss`: small CSS rule for the new container's hidden state.
- No caller changes (both `install_screen.py` and `mcp.py` reuse `PlaybookRunScreen` as a black box).

### Bash

- `lib/menu_lib.sh::xinas_run_playbook()`: ~40 lines added.
  - TTY-detection guard.
  - awk filter as described.
  - Replace single `msg_box` failure call with `yes_no`-based three-option dialog dispatching to `less +G` when chosen.
- No caller changes (`startup_menu.sh::run_playbook`, `simple_menu.sh`).

### CLAUDE.md

- Replace the "Shell menu scripts are OBSOLETE" paragraph with the two-surface rule documented above.

## Testing

Manual only — no unit tests. The Python screen is a Textual UI driving a subprocess; the bash function is a shell wrapper. End-to-end exercise via real playbook runs:

- **Python success:** Run install via `xinas_menu` → confirm StatusBar shows tasks updating, log panel hidden, `L` toggles panel, Close enables on `PLAY RECAP`.
- **Python failure:** Point a preset's RAID array at a non-existent device (or `pkill ansible-playbook` mid-run) → confirm StatusBar turns red, panel auto-expands with error visible.
- **Python MCP path:** Run MCP role install via `xinas_menu/screens/mcp.py` → confirm no caller-side regression.
- **Bash success:** Run install via `startup_menu.sh` on a real or dev box → confirm single ticker line replaces verbose stream, `PLAY RECAP` renders normally at the end.
- **Bash failure:** Same induced-failure trick → confirm error lines pass through inline, dialog offers `View Log` / `Collect Logs` / `Continue`, `View Log` opens `less +G` on the right file.
- **Bash non-TTY:** `./startup_menu.sh < /dev/null > out.log 2>&1` (or via `script`-less CI run) → confirm verbose passthrough, no `\r` clobbering in `out.log`.

No `xfs_force_mkfs`-class destructive testing is required — this is a display-layer change that does not affect what playbooks do.

## Risks

- **Awk filter swallows a line we should have shown.** Mitigated by passing `fatal:`/`failed:`/`ERROR!` through verbatim and by tee-ing the unfiltered stream to the log file. The log is always complete.
- **`\r` clobbering important warnings.** Ansible warnings without `fatal:`/`failed:`/`ERROR!` markers (rare — usually `[WARNING]:` prefix) would be overwritten by the next ticker update. We accept this — the warnings remain in the log file.
- **Textual layout under small terminals.** The StatusBar must remain visible even on 80×24. Single-line label with `text-overflow: ellipsis` (or Textual equivalent) handles long task names.
- **Drift between the two implementations.** The parity matrix above is the contract. Future changes to one side should consciously re-evaluate the other.
