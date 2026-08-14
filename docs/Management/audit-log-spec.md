# View Audit Log — merged audit trail (spec)

**Owns:** the System → Quick Actions → **View Audit Log** screen
(`xinas_menu/screens/quick_actions.py::_view_audit_log`) and its merge
helper (`xinas_menu/utils/audit_view.py`).

**Status:** design (2026-07-05).

## Problem

xiNAS records audit activity in **two disjoint trails**:

| Trail | Written by | Captures |
|-------|-----------|----------|
| `/var/log/xinas/audit.log` (plain text) | TUI `AuditLogger` (`xinas_menu/utils/audit.py`) | TUI-**direct** actions only: user management (`useradd`/`passwd` run in-process), service restart, system update |
| control-path trail — `GET /api/v1/audit` (hash-chained `audit.jsonl`, ADR-0011) | `xinas-api` server (`xiNAS-MCP/src/state/audit.ts`) | **every** control-path operation from **any** client (TUI, `xinasctl`, MCP): `share.create`/`share.delete`, RAID, network, filesystem, … |

Before this spec the View Audit Log screen read **only** the local
`audit.log`. Share creation is a control-path operation applied through
`POST /api/v1/shares`; it is recorded only in the control-path trail
(as `share.create`). In particular a share created via **MCP** never
touches `audit.log`, so it was invisible in the screen even though the
audit chain recorded it. The screen showed an incomplete picture that
omitted all control-path activity (shares, RAID, network, and every
MCP/CLI action).

## Behavior

The View Audit Log screen presents a **single, unified, time-ordered**
view that merges both trails:

1. Read the tail of the local `audit.log` (last `LIMIT` lines).
2. Query the control-path trail via `GET /api/v1/audit?limit=LIMIT`
   through the shared `ControlClient` (`self.app.control`).
3. Normalize both sources to a common record, merge, sort **ascending
   by timestamp** (chronological, matching the prior view), and render
   the most recent `LIMIT` (default **200**) entries.

### Display format

Every row — from either trail — renders in the existing 5-column form:

```
YYYY-MM-DD HH:MM:SS | principal | action | STATUS | detail
```

### Control-path row → display line

A `GET /audit` row (`AuditRow`, see `handlers/audit-query.ts`) maps as:

| Column | Source field | Notes |
|--------|--------------|-------|
| timestamp | `timestamp` | epoch **ms** → local `YYYY-MM-DD HH:MM:SS`. An ISO-8601 string is also accepted. |
| principal | `principal` | falls back to `unknown` when absent |
| action | `kind` | e.g. `share.create` |
| STATUS | `result_hash` | `FAIL` when the key is present **and** empty (`''` on failure, per `AuditEntry`); otherwise `OK` |
| detail | `client_type` | e.g. `mcp`, `rest` — shows which client performed it |

Local `audit.log` lines are parsed on ` | ` and pass through unchanged;
the leading `YYYY-MM-DD HH:MM:SS` is interpreted as **local** time for
sort ordering.

### Writer contract — STATUS is an observation, not a formality

The rendering rules above are only worth as much as the values writers put in.
Every local `audit.log` writer must pass the **observed** outcome as STATUS:
`OK` only when the operation it names actually succeeded, `FAIL` otherwise. A
writer that hardcodes `OK` makes the audit trail actively misleading — it is
the one record an operator reconstructs an incident from, and a failed action
recorded as a success is worse than no record at all, because it is trusted.

Where an action fans out over several units or resources, STATUS is `OK` only
when **all** of them succeeded; the per-item detail belongs in the rendered
view, not in the STATUS column.

### Degradation

The screen never crashes on a missing source:

- **Control API unreachable** (`ControlPathError`): show the local
  trail only, and append one note line
  `(control-path audit unavailable: <reason>)`.
- **Local log missing**: show the control-path trail only.
- **Both empty / absent**: show `Audit log is empty.`
- A local line that cannot be parsed is preserved verbatim and sorted
  to the end (most-recent) so no data is hidden.

## Non-goals

- No change to how entries are **written**. User management continues to
  write the local trail; control-path operations continue to write the
  hash-chained trail. This screen is read-only reconciliation.
- No exact-lookup / filtering UI (the `GET /audit`
  `request_id`/`kind`/`since` filters exist server-side but are not
  surfaced here yet).
- No de-duplication across trails. A share created **through the TUI**
  writes both a local `nfs.add_export` line and a control-path
  `share.create` row; both appear. (MCP/CLI-created shares appear once,
  from the control-path trail.)
