# Config-History Tools Specification

## Overview

The config-history tools expose xiNAS configuration snapshot management
through the MCP interface. They provide AI assistants and automation
with the ability to inspect configuration history, detect drift, and
initiate rollbacks.

**Backend**: Python subprocess — `python3 -m xinas_history <cmd> --format json`
(matches the nfs-helper subprocess pattern)

---

## Tools (6 new tools)

### `config.list_snapshots`
- **Role**: viewer
- **Description**: List all configuration snapshots (baseline + rolling)
- **Input Schema**:
  - `controller_id` (string, required)
  - `include_baseline` (boolean, optional, default: true)
  - `status_filter` (string, optional: `"applied"` | `"failed"` | `"rolled_back"`)
- **Output**: Array of snapshot summaries (`id`, `timestamp`, `operation`, `status`, `rollback_class`, `diff_summary`)
- **Backend**: `python3 -m xinas_history snapshot list --format json`

### `config.show_snapshot`
- **Role**: viewer
- **Description**: Get full manifest and details for a specific snapshot
- **Input Schema**:
  - `controller_id` (string, required)
  - `id` (string, required): Snapshot ID
- **Output**: Full manifest as JSON object
- **Backend**: `python3 -m xinas_history snapshot show <id> --format json`

### `config.diff_snapshots`
- **Role**: viewer
- **Description**: Compare two snapshots and show changes
- **Input Schema**:
  - `controller_id` (string, required)
  - `from_id` (string, required): Source snapshot ID
  - `to_id` (string, required): Target snapshot ID
- **Output**: DiffResult with `config_changes`, `runtime_changes`, `rollback_class`, `summary`
- **Backend**: `python3 -m xinas_history snapshot diff <from_id> <to_id> --format json`

### `config.check_drift`
- **Role**: operator
- **Description**: Detect out-of-band changes to managed configuration files
- **Input Schema**:
  - `controller_id` (string, required)
- **Output**: DriftReport with `entries`, `clean`, `safety_impact`, `blocking_drift`
- **Backend**: `python3 -m xinas_history drift check --format json`

### `config.get_status`
- **Role**: viewer
- **Description**: Get configuration history status summary
- **Input Schema**:
  - `controller_id` (string, required)
- **Output**: `{ baseline_exists, snapshot_count, rollback_eligible_count, current_effective }`
- **Backend**: `python3 -m xinas_history status --format json`

### `config.rollback`
- **Role**: admin
- **Description**: Roll back to a previous configuration snapshot
- **Mode**: plan/apply (preflight validation before execution)
- **Input Schema**:
  - `controller_id` (string, required)
  - `target_id` (string, required): Snapshot ID to roll back to
  - `reason` (string, required): Audit reason for rollback
  - `mode` (string: `"plan"` | `"apply"`, default: `"plan"`)
- **Output (plan)**: Preflight result with `rollback_class`, `affected_resources`, `blockers`, `warnings`
- **Output (apply)**: RunResult with `success`, `snapshot_id`, rollback details
- **Backend**: `python3 -m xinas_history snapshot rollback <target_id> --reason <text> [--yes]`

---

## RBAC Permissions

| Tool | Minimum Role | Reason |
|---|---|---|
| `config.list_snapshots` | viewer | Read-only listing |
| `config.show_snapshot` | viewer | Read-only inspection |
| `config.diff_snapshots` | viewer | Read-only comparison |
| `config.check_drift` | operator | Reads system files, may trigger alerts |
| `config.get_status` | viewer | Read-only status |
| `config.rollback` | admin | Destructive/access-changing operation |

---

## Error Handling

| Error | Code | When |
|---|---|---|
| Snapshot not found | `NOT_FOUND` | Snapshot ID doesn't exist |
| Lock contention | `CONFLICT` | Another config operation in progress |
| Preflight failed | `PRECONDITION_FAILED` | Blockers prevent rollback |
| Insufficient space | `RESOURCE_EXHAUSTION` | Not enough disk for snapshot |
| Drift detected | `PRECONDITION_FAILED` | Drift blocks operation |
| Backend error | `INTERNAL` | Python subprocess failed |

---

## Subprocess Protocol

Invocation: `python3 -m xinas_history <command> [args] --format json`

- **Stdout**: JSON result
- **Stderr**: Error messages
- **Exit 0**: Success (parse stdout)
- **Exit 1**: Error (parse stderr as JSON `{ "error": "...", "code": "..." }`)
- **Timeout**: 30s for reads, 300s for rollback
