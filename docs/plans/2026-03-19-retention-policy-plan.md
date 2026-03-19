# Retention Policy Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hardcoded `MAX_ROLLBACK_SNAPSHOTS = 40` with a configurable hybrid retention policy (count + max_age) manageable through TUI and MCP.

**Architecture:** Add a `RetentionPolicy` dataclass to `gc.py` with `max_snapshots` and `max_age_days` fields. Policy is persisted in `/etc/xinas-mcp/config.json` (existing config system). GC reads policy on every run. TUI gets a new "Retention Settings" menu item. MCP gets `config.get_retention` / `config.set_retention` tools.

**Tech Stack:** Python 3.10+ (dataclass, datetime), Textual TUI (InputDialog pattern), TypeScript/MCP (zod schemas, subprocess bridge)

---

### Task 1: Add RetentionPolicy dataclass and config loader

**Files:**
- Modify: `xinas_history/gc.py:1-27`

**Step 1: Add RetentionPolicy dataclass and load_retention_policy()**

Add at the top of `gc.py`, after the existing imports:

```python
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

CONFIG_PATH = Path("/etc/xinas-mcp/config.json")

@dataclass(frozen=True)
class RetentionPolicy:
    """Configurable retention policy for GC."""
    max_snapshots: int = 40
    max_age_days: int = 0  # 0 = disabled

def load_retention_policy() -> RetentionPolicy:
    """Load retention policy from /etc/xinas-mcp/config.json.

    Falls back to defaults if the file is missing or malformed.
    """
    try:
        data = json.loads(CONFIG_PATH.read_text())
        section = data.get("retention", {})
        return RetentionPolicy(
            max_snapshots=max(1, int(section.get("max_snapshots", 40))),
            max_age_days=max(0, int(section.get("max_age_days", 0))),
        )
    except Exception:
        return RetentionPolicy()
```

**Step 2: Verify module imports work**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -c "from xinas_history.gc import RetentionPolicy, load_retention_policy; p = RetentionPolicy(); print(p)"`
Expected: `RetentionPolicy(max_snapshots=40, max_age_days=0)`

**Step 3: Commit**

```bash
git add xinas_history/gc.py
git commit -m "feat(config-history): add RetentionPolicy dataclass and config loader"
```

---

### Task 2: Wire RetentionPolicy into GarbageCollector

**Files:**
- Modify: `xinas_history/gc.py:20-76`

**Step 1: Update GarbageCollector.__init__ to accept policy**

```python
class GarbageCollector:
    """Manages snapshot retention with configurable policy."""

    def __init__(
        self, store: FilesystemStore, policy: Optional[RetentionPolicy] = None,
    ) -> None:
        self._store = store
        self._policy = policy or RetentionPolicy()
```

Remove the class-level `MAX_ROLLBACK_SNAPSHOTS = 40` constant.

**Step 2: Add _is_expired() helper**

After `_get_purgeable_snapshots()`:

```python
@staticmethod
def _is_expired(manifest: Manifest, max_age_days: int) -> bool:
    """Check if a snapshot is older than max_age_days."""
    if max_age_days <= 0:
        return False
    try:
        ts = manifest.timestamp.replace("Z", "+00:00")
        snap_time = datetime.fromisoformat(ts)
        cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
        return snap_time < cutoff
    except (ValueError, TypeError):
        return False
```

**Step 3: Update run() to use policy and age-based purging**

Replace the current `run()` body with:

```python
def run(
    self,
    current_effective_id: Optional[str] = None,
    in_progress_ids: Optional[Set[str]] = None,
) -> List[str]:
    """Run garbage collection.

    Purges snapshots that exceed max_snapshots OR are older than
    max_age_days. Protected snapshots are never removed.
    """
    if in_progress_ids is None:
        in_progress_ids = set()

    snapshots = self._store.list_snapshots()  # sorted by timestamp asc
    purged: List[str] = []

    rollback_eligible = [
        m for m in snapshots
        if m.type == SnapshotType.ROLLBACK_ELIGIBLE.value
    ]

    purgeable = self._get_purgeable_snapshots(
        rollback_eligible, current_effective_id, in_progress_ids
    )

    # Build set of IDs to purge.
    to_purge_ids: set[str] = set()

    # Rule 1: count-based — purge oldest when over limit.
    excess = len(rollback_eligible) - self._policy.max_snapshots
    if excess > 0:
        for m in purgeable[:excess]:
            to_purge_ids.add(m.id)

    # Rule 2: age-based — purge expired snapshots.
    if self._policy.max_age_days > 0:
        for m in purgeable:
            if self._is_expired(m, self._policy.max_age_days):
                to_purge_ids.add(m.id)

    # Delete in oldest-first order.
    for m in purgeable:
        if m.id in to_purge_ids:
            if self._store.delete_snapshot(m.id):
                purged.append(m.id)

    return purged
```

**Step 4: Update the module docstring**

Replace the module docstring (lines 1-11) to reflect the new configurable policy:

```python
"""Garbage collection for xiNAS configuration history snapshots.

Retention rules (configurable via /etc/xinas-mcp/config.json):
1. Never delete baseline.
2. Never delete the currently active/effective snapshot.
3. Never delete a snapshot referenced by an in-progress rollback.
4. Purge rollback-eligible snapshots exceeding max_snapshots (oldest first).
5. Purge rollback-eligible snapshots older than max_age_days (if > 0).
6. On startup, scan for stale ephemeral snapshots.
"""
```

**Step 5: Verify import still works**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -c "from xinas_history.gc import GarbageCollector, RetentionPolicy; print('OK')"`
Expected: `OK`

**Step 6: Commit**

```bash
git add xinas_history/gc.py
git commit -m "feat(config-history): wire RetentionPolicy into GarbageCollector.run()"
```

---

### Task 3: Update GC callers to load policy

**Files:**
- Modify: `xinas_history/engine.py:24,57`
- Modify: `xinas_history/runner.py:35,122`
- Modify: `xinas_menu/screens/config_history.py:26,500-501`
- Modify: `xinas_history/__main__.py:381`

**Step 1: Update engine.py**

At line 24, add import:
```python
from .gc import GarbageCollector, load_retention_policy
```

At line 57, change:
```python
self._gc = GarbageCollector(self._store)
```
to:
```python
self._gc = GarbageCollector(self._store, load_retention_policy())
```

**Step 2: Update runner.py**

At line 35, change:
```python
from .gc import GarbageCollector
```
to:
```python
from .gc import GarbageCollector, load_retention_policy
```

At line 122, change:
```python
self._gc = GarbageCollector(self._store)
```
to:
```python
self._gc = GarbageCollector(self._store, load_retention_policy())
```

**Step 3: Update config_history.py TUI screen**

At line 26 (inside the `try` block), add `load_retention_policy` to the import:
```python
from xinas_history.gc import GarbageCollector, load_retention_policy
```

At lines 500-501, change:
```python
gc = GarbageCollector(store)
```
to:
```python
gc = GarbageCollector(store, load_retention_policy())
```

Also update the confirmation dialog text at line 489:
```python
"This will remove snapshots beyond the retention limit\n"
"(configured in Settings > Retention).",
```

**Step 4: Update __main__.py CLI**

At the top imports section, change the gc import or add it. In `_cmd_gc_run()` at line 381, change:
```python
purged = engine._gc.run(current_effective_id=effective_id)
```
to:
```python
from .gc import GarbageCollector, load_retention_policy
policy = load_retention_policy()
gc = GarbageCollector(store, policy)
purged = gc.run(current_effective_id=effective_id)
```

Note: need to pass `store` — use the `engine._store` reference or the `store` local from `main()`. Since `_cmd_gc_run` gets `engine` as param, use `engine._store`:

```python
def _cmd_gc_run(engine: SnapshotEngine) -> int:
    from .gc import GarbageCollector, load_retention_policy

    effective = engine.get_current_effective()
    effective_id = effective.id if effective else None

    policy = load_retention_policy()
    gc = GarbageCollector(engine._store, policy)
    purged = gc.run(current_effective_id=effective_id)

    if purged:
        print(f"Purged {len(purged)} snapshot(s):")
        for sid in purged:
            print(f"  - {sid}")
    else:
        print("No snapshots purged.")

    return 0
```

**Step 5: Verify imports work**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -c "from xinas_history.engine import SnapshotEngine; from xinas_history.runner import TransactionalRunner; print('OK')"`
Expected: `OK`

**Step 6: Commit**

```bash
git add xinas_history/engine.py xinas_history/runner.py xinas_menu/screens/config_history.py xinas_history/__main__.py
git commit -m "feat(config-history): load RetentionPolicy at all GC invocation points"
```

---

### Task 4: Add `gc policy` CLI subcommand

**Files:**
- Modify: `xinas_history/__main__.py:98-101,369-390`

**Step 1: Add `policy` subcommand to gc parser**

After line 101 (`gc_sub.add_parser("run", help="Run GC")`), add:

```python
policy_parser = gc_sub.add_parser("policy", help="Show or update retention policy")
policy_parser.add_argument("--format", choices=["json", "text"], default="text")
policy_parser.add_argument("--set", action="store_true", help="Update policy")
policy_parser.add_argument("--max-snapshots", type=int, default=None)
policy_parser.add_argument("--max-age-days", type=int, default=None)
```

**Step 2: Update _dispatch_gc()**

Replace `_dispatch_gc()`:

```python
def _dispatch_gc(args: argparse.Namespace, engine: SnapshotEngine) -> int:
    if args.action is None:
        print("Error: specify action: run, policy", file=sys.stderr)
        return 1
    if args.action == "run":
        return _cmd_gc_run(engine)
    if args.action == "policy":
        return _cmd_gc_policy(args)
    print(f"Error: unknown gc action: {args.action}", file=sys.stderr)
    return 1
```

**Step 3: Add _cmd_gc_policy()**

```python
def _cmd_gc_policy(args: argparse.Namespace) -> int:
    from .gc import load_retention_policy, RetentionPolicy, CONFIG_PATH

    if args.set:
        # Load current, merge updates, write back.
        import json as _json
        try:
            data = _json.loads(CONFIG_PATH.read_text())
        except Exception:
            data = {}
        section = data.get("retention", {})
        if args.max_snapshots is not None:
            val = max(1, args.max_snapshots)
            section["max_snapshots"] = val
        if args.max_age_days is not None:
            val = max(0, args.max_age_days)
            section["max_age_days"] = val
        data["retention"] = section

        import tempfile, os
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(CONFIG_PATH.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                _json.dump(data, f, indent=2)
                f.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, str(CONFIG_PATH))
        except Exception:
            os.unlink(tmp)
            raise
        print("Retention policy updated.")

    policy = load_retention_policy()
    if args.format == "json":
        print(json.dumps({
            "max_snapshots": policy.max_snapshots,
            "max_age_days": policy.max_age_days,
        }))
    else:
        print(f"Retention Policy")
        print(f"  max_snapshots: {policy.max_snapshots}")
        print(f"  max_age_days:  {policy.max_age_days}"
              f"{' (disabled)' if policy.max_age_days == 0 else ''}")
    return 0
```

**Step 4: Verify CLI works**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -m xinas_history gc policy --format json`
Expected: `{"max_snapshots": 40, "max_age_days": 0}`

**Step 5: Commit**

```bash
git add xinas_history/__main__.py
git commit -m "feat(config-history): add 'gc policy' CLI subcommand"
```

---

### Task 5: Add TUI Retention Settings screen

**Files:**
- Modify: `xinas_menu/screens/config_history.py:36-44,88-103`

**Step 1: Add menu item**

Change `_MENU` (lines 36-44) to add item 7:

```python
_MENU = [
    MenuItem("1", "View History"),
    MenuItem("2", "View Snapshot"),
    MenuItem("3", "Drift Check"),
    MenuItem("4", "Garbage Collect"),
    MenuItem("5", "Create Baseline"),
    MenuItem("6", "Reset to Baseline"),
    MenuItem("7", "Retention Settings"),
    MenuItem("0", "Back"),
]
```

**Step 2: Add dispatch in on_navigable_menu_selected()**

After the `elif key == "6":` block (line 103), add:

```python
        elif key == "7":
            self._retention_settings()
```

**Step 3: Update the compose() help text**

In the `compose()` method, add line for item 7 in the help text area (around line 80):

```python
f"  {_BLD}7{_NC}  {_CYN}Retention Settings{_NC}  {_DIM}Configure snapshot retention policy{_NC}\n",
```

**Step 4: Add import for cfg_read/cfg_write**

At the top of the file, add:
```python
from xinas_menu.utils.config import cfg_read, cfg_write
```

**Step 5: Add _retention_settings() method**

Add before the `# -- Formatters` section (before line 538):

```python
    @work(exclusive=True)
    async def _retention_settings(self) -> None:
        """Show and edit retention policy settings."""
        view = self.query_one("#history-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        cfg = await loop.run_in_executor(None, cfg_read)
        retention = cfg.get("retention", {})
        cur_max = retention.get("max_snapshots", 40)
        cur_age = retention.get("max_age_days", 0)

        lines = [
            f"{_BLD}{_CYN}Retention Policy{_NC}",
            "",
            f"  Max snapshots:  {_BLD}{cur_max}{_NC}",
            f"  Max age (days): {_BLD}{cur_age}{_NC}"
            f"  {_DIM}(0 = disabled){_NC}" if cur_age == 0 else "",
            "",
            f"  {_DIM}Snapshots exceeding either limit are purged by GC.{_NC}",
            f"  {_DIM}Protected snapshots (baseline, effective, locked) are never removed.{_NC}",
        ]
        view.set_content("\n".join(lines))

        choice = await self.app.push_screen_wait(
            SelectDialog(
                ["Edit Settings", "Keep Current"],
                title="Retention Policy",
                prompt="Choose an action:",
            )
        )
        if choice is None or choice == "Keep Current":
            return

        # max_snapshots
        while True:
            val = await self.app.push_screen_wait(
                InputDialog(
                    "Max rollback-eligible snapshots (5–1000):",
                    "Retention Settings",
                    default=str(cur_max),
                    placeholder="40",
                )
            )
            if val is None:
                return
            try:
                new_max = int(val.strip())
                if 5 <= new_max <= 1000:
                    break
            except ValueError:
                pass
            self.app.notify("Enter a number between 5 and 1000", severity="error")

        # max_age_days
        while True:
            val = await self.app.push_screen_wait(
                InputDialog(
                    "Max age in days (0 = disabled, 1–3650):",
                    "Retention Settings",
                    default=str(cur_age),
                    placeholder="0",
                )
            )
            if val is None:
                return
            try:
                new_age = int(val.strip())
                if 0 <= new_age <= 3650:
                    break
            except ValueError:
                pass
            self.app.notify("Enter a number between 0 and 3650", severity="error")

        # Save
        cfg["retention"] = {
            "max_snapshots": new_max,
            "max_age_days": new_age,
        }
        await loop.run_in_executor(None, cfg_write, cfg)

        lines = [
            f"{_GRN}Retention policy updated.{_NC}",
            "",
            f"  Max snapshots:  {_BLD}{new_max}{_NC}",
            f"  Max age (days): {_BLD}{new_age}{_NC}"
            + (f"  {_DIM}(disabled){_NC}" if new_age == 0 else ""),
        ]
        view.set_content("\n".join(lines))

        try:
            self.app.audit.log(
                "history.retention_update",
                f"max_snapshots={new_max} max_age_days={new_age}",
                "OK",
            )
        except Exception:
            pass
```

**Step 6: Verify import**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS && python3 -c "from xinas_menu.screens.config_history import ConfigHistoryScreen; print('OK')"`
Expected: `OK`

**Step 7: Commit**

```bash
git add xinas_menu/screens/config_history.py
git commit -m "feat(tui): add Retention Settings to Config History screen"
```

---

### Task 6: Add MCP tools — config.get_retention / config.set_retention

**Files:**
- Modify: `xiNAS-MCP/src/tools/config.ts`
- Modify: `xiNAS-MCP/src/os/configHistory.ts`
- Modify: `xiNAS-MCP/src/registry/toolRegistry.ts:73-76,144-150`

**Step 1: Add bridge functions in configHistory.ts**

At the end of `xiNAS-MCP/src/os/configHistory.ts`, add:

```typescript
export async function getRetentionPolicy(): Promise<unknown> {
  return parseJsonOutput(await run(['gc', 'policy', '--format', 'json'], READ_TIMEOUT_MS));
}

export async function setRetentionPolicy(maxSnapshots?: number, maxAgeDays?: number): Promise<unknown> {
  const args = ['gc', 'policy', '--set', '--format', 'json'];
  if (maxSnapshots !== undefined) args.push('--max-snapshots', String(maxSnapshots));
  if (maxAgeDays !== undefined) args.push('--max-age-days', String(maxAgeDays));
  return parseJsonOutput(await run(args, WRITE_TIMEOUT_MS));
}
```

**Step 2: Add schemas and handlers in config.ts**

At the end of the schemas section in `xiNAS-MCP/src/tools/config.ts`:

```typescript
export const ConfigGetRetentionSchema = z.object({
  controller_id: z.string().optional(),
});

export const ConfigSetRetentionSchema = z.object({
  controller_id: z.string().optional(),
  max_snapshots: z.number().int().min(1).max(1000).optional()
    .describe('Maximum rollback-eligible snapshots to retain'),
  max_age_days: z.number().int().min(0).max(3650).optional()
    .describe('Delete snapshots older than N days (0 = disabled)'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});
```

Add import for new bridge functions:
```typescript
import { listSnapshots, showSnapshot, diffSnapshots, getStatus, getRetentionPolicy, setRetentionPolicy } from '../os/configHistory.js';
```

Add handlers:

```typescript
export async function handleConfigGetRetention(params: z.infer<typeof ConfigGetRetentionSchema>) {
  resolveController(params.controller_id);
  return getRetentionPolicy();
}

export async function handleConfigSetRetention(params: z.infer<typeof ConfigSetRetentionSchema>) {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      const current = await getRetentionPolicy() as Record<string, unknown>;
      const changes: Array<Record<string, unknown>> = [];

      if (params.max_snapshots !== undefined) {
        changes.push({
          action: 'modify' as const,
          resource_type: 'retention_policy',
          resource_id: 'max_snapshots',
          before: { value: current.max_snapshots },
          after: { value: params.max_snapshots },
        });
      }
      if (params.max_age_days !== undefined) {
        changes.push({
          action: 'modify' as const,
          resource_type: 'retention_policy',
          resource_id: 'max_age_days',
          before: { value: current.max_age_days },
          after: { value: params.max_age_days },
        });
      }

      return {
        mode: 'plan' as const,
        description: 'Update snapshot retention policy',
        changes,
        warnings: [] as string[],
        preflight_passed: changes.length > 0,
        ...(changes.length === 0 ? { blocking_resources: ['No changes specified'] } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      return setRetentionPolicy(params.max_snapshots, params.max_age_days);
    },
  });
}
```

**Step 3: Register tools in toolRegistry.ts**

Add imports at line ~73:
```typescript
  ConfigGetRetentionSchema, handleConfigGetRetention,
  ConfigSetRetentionSchema, handleConfigSetRetention,
```

Add entries after line 150 (after `config.rollback`):
```typescript
  { name: 'config.get_retention', description: 'Get current snapshot retention policy (max_snapshots, max_age_days)', schema: ConfigGetRetentionSchema, handler: handleConfigGetRetention },
  { name: 'config.set_retention', description: 'Update snapshot retention policy (admin, plan/apply)', schema: ConfigSetRetentionSchema, handler: handleConfigSetRetention },
```

**Step 4: Verify TypeScript compiles**

Run: `cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/xiNAS-MCP && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add xiNAS-MCP/src/tools/config.ts xiNAS-MCP/src/os/configHistory.ts xiNAS-MCP/src/registry/toolRegistry.ts
git commit -m "feat(mcp): add config.get_retention and config.set_retention tools"
```

---

### Task 7: Export RetentionPolicy from __init__.py

**Files:**
- Modify: `xinas_history/__init__.py`

**Step 1: Add RetentionPolicy to imports and __all__**

Add to imports:
```python
from .gc import GarbageCollector, RetentionPolicy, load_retention_policy
```

Add to `__all__`:
```python
    "RetentionPolicy",
    "load_retention_policy",
```

**Step 2: Commit**

```bash
git add xinas_history/__init__.py
git commit -m "feat(config-history): export RetentionPolicy and load_retention_policy"
```

---

### Task 8: Update documentation

**Files:**
- Modify: `docs/config-history/specs.md:362-379`
- Modify: `docs/config-history/architecture.md:153-163`
- Modify: `xiNAS-MCP/specs/spec-config-history.md`

**Step 1: Update specs.md Section 7**

Replace lines 362-379 with:

```markdown
### 7.1 Retention Policy

Retention is configurable via `/etc/xinas-mcp/config.json` (key: `retention`):

| Parameter | Default | Range | Description |
|---|---|---|---|
| `max_snapshots` | 40 | 1–1000 | Maximum rollback-eligible snapshots retained |
| `max_age_days` | 0 | 0–3650 | Delete snapshots older than N days (0 = disabled) |

| Snapshot Type | Retention Rule |
|---|---|
| `baseline` | Always retained (immutable) |
| `rollback_eligible` | Oldest purged when count > `max_snapshots` OR age > `max_age_days` |
| `ephemeral` | 1 per active transaction, cleaned up after completion |
| Currently effective | Always retained regardless of policy |

Settings can be changed via TUI (Config History → Retention Settings) or MCP (`config.set_retention`).

### 7.2 Purge Trigger

After every successful snapshot creation:

1. Count `rollback_eligible` snapshots (excluding baseline).
2. If count exceeds `max_snapshots`: mark oldest excess snapshots for purging.
3. If `max_age_days` > 0: mark snapshots older than the cutoff for purging.
4. For each candidate: verify not protected (not locked, not currently effective, not in-progress).
5. Remove the snapshot directory (manifest and all collected files).
6. Log the purge event to `audit.log`.
```

**Step 2: Update architecture.md Section gc.py**

Replace lines 153-163 with:

```markdown
Retention policy (configurable via `/etc/xinas-mcp/config.json`):

| Category | Rule |
|----------|------|
| `baseline` | 1 (immutable, never deleted) |
| `rollback_eligible` | Purge when count > `max_snapshots` (default 40) or age > `max_age_days` (default 0 = off) |
| `ephemeral` | 1 most recent (pre-change recovery only) |

On every snapshot creation the GC runs and purges snapshots that exceed the
configured limits. It also cleans up incomplete directories left behind by
crashes (detected via missing `manifest.yml`).
```

**Step 3: Update spec-config-history.md**

After the `config.reset_to_baseline` section (before `## RBAC Permissions`), add:

```markdown
### `config.get_retention`
- **Role**: viewer
- **Description**: Get current snapshot retention policy
- **Input Schema**:
  - `controller_id` (string, optional)
- **Output**: `{ "max_snapshots": 40, "max_age_days": 0 }`
- **Backend**: `python3 -m xinas_history gc policy --format json`

### `config.set_retention`
- **Role**: admin
- **Description**: Update snapshot retention policy
- **Mode**: plan/apply
- **Input Schema**:
  - `controller_id` (string, optional)
  - `max_snapshots` (integer, optional, 1–1000): Max rollback-eligible snapshots
  - `max_age_days` (integer, optional, 0–3650): Max age in days (0 = disabled)
  - `mode` (string: `"plan"` | `"apply"`, default: `"plan"`)
- **Output (plan)**: Change preview with before/after values
- **Output (apply)**: Updated policy values
- **Backend**: `python3 -m xinas_history gc policy --set --max-snapshots <n> --max-age-days <n> --format json`
```

Update the tools count from "6 new tools" to "8 new tools" in the heading.

Add to RBAC table:
```markdown
| `config.get_retention` | viewer | Read-only policy inspection |
| `config.set_retention` | admin | Modifies retention limits |
```

**Step 4: Commit**

```bash
git add docs/config-history/specs.md docs/config-history/architecture.md xiNAS-MCP/specs/spec-config-history.md
git commit -m "docs(config-history): update retention policy documentation for configurable GC"
```

---

### Task 9: End-to-end verification

**Step 1: Verify CLI policy read**

Run: `python3 -m xinas_history gc policy --format json`
Expected: `{"max_snapshots": 40, "max_age_days": 0}`

**Step 2: Verify Python imports**

Run: `python3 -c "from xinas_history import RetentionPolicy, load_retention_policy, GarbageCollector; print('All imports OK')"`
Expected: `All imports OK`

**Step 3: Verify TypeScript compiles**

Run: `cd xiNAS-MCP && npx tsc --noEmit`
Expected: No errors

**Step 4: Verify TUI screen loads**

Run: `python3 -c "from xinas_menu.screens.config_history import ConfigHistoryScreen; print('TUI screen OK')"`
Expected: `TUI screen OK`
