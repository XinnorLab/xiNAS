# xiNAS-MCP — Requirements Document

**Version:** 0.1 (Draft for Review)
**Date:** 2026-02-26
**Status:** Pending stakeholder sign-off

---

## 1. Purpose & Scope

xiNAS-MCP is a Model Context Protocol (MCP) server that exposes xiNAS infrastructure operations as strongly-typed, auditable tools consumable by AI assistants (Claude Code and equivalents). It bridges AI agents to the xiRAID storage engine, Linux NFS server, and system observability stack running on a xiNAS node.

---

## 2. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| MCP runtime | Node.js / TypeScript | Official Anthropic MCP TypeScript SDK; first-class type safety |
| MCP transport | stdio (primary), SSE (secondary) | stdio for Claude Code integration; SSE for remote/web clients |
| xiRAID integration | Native API helper daemon (TBD) | See §6.1 — CLI execution is prohibited |
| NFS integration | Native API helper daemon (TBD) | See §6.2 — CLI execution is prohibited |
| Metrics source | Prometheus scrape of xiraid-exporter (:9827) | Already deployed; reuse without new API surface |
| AuthN/AuthZ | mTLS (agent↔director); OIDC/token (client↔MCP) | See §5 |
| Audit log | Append-only structured JSON, local + remote sink | See §5 |

---

## 3. Deployment Model

### 3.1 Topology Options

| Mode | Description |
|---|---|
| **Per-controller agent** | One MCP server instance per xiNAS node, accessed directly |
| **Federated director** | Central routing MCP server dispatching to per-controller agents |

Both modes MUST be supported. Each controller MUST carry a stable, unique `controller_id` — format is **UUID v4**. All mutating tool inputs MUST include `controller_id` or derive it from an established session context.

### 3.2 Discovery

- `system.get_server_info()` — version, build, supported tool namespaces
- `system.list_controllers()` — controller inventory
- `system.get_controller_capabilities(controller_id)` — RAID levels, NFS versions, Kerberos/AD, snapshot support

---

## 4. Functional Requirements — Tool Contract

### 4.1 System Inventory, Status & Telemetry

| Tool | Inputs | Output |
|---|---|---|
| `system.get_status` | controller_id | uptime, OS, kernel, xiNAS version, service states, load, memory pressure |
| `system.get_inventory` | controller_id | CPU, RAM, NICs, PCI, enclosure/backplane |
| `system.get_performance` | controller_id, target, metrics[], duration | time-series or current averages: IOPS, throughput, latency per array/share/disk/global |

**Source note:** `system.get_performance` SHOULD source data from the existing xiraid-exporter Prometheus endpoint (`:9827`) where metrics overlap. No new API surface is needed for this subset.

### 4.2 Network Management

| Tool | Inputs | Output |
|---|---|---|
| `network.list` | controller_id | interfaces, MACs, link states, MTU, IPs, LACP/bonding configs |
| `network.configure` | controller_id, interface_id, spec, mode | plan or apply result |

`network.configure` spec MUST include: static IP, VLAN tags, bonding, **and RDMA interface parameters** (NFS-RDMA port, RDMA transport mode). RDMA is a core xiNAS feature and MUST NOT be omitted.

### 4.3 Health Check & Diagnostics

| Tool | Inputs | Output |
|---|---|---|
| `health.run_check` | controller_id, profile (quick/standard/deep) | structured report per check: status (OK/WARN/CRIT), symptom, impact, evidence, recommended_action |
| `health.get_alerts` | controller_id, since, severity_min | active/recent alerts with stable IDs |

### 4.4 Disk Lifecycle

| Tool | Inputs | Output |
|---|---|---|
| `disk.list` | controller_id, filters | disk_id, path, serial, firmware, capacity, health summary |
| `disk.get_smart` | controller_id, disk_id | normalized SMART / NVMe logs |
| `disk.run_selftest` | controller_id, disk_id, test_type (short/extended) | job_id |
| `disk.set_led` | controller_id, disk_id, state (identify_on/off) | result |
| `disk.secure_erase` | controller_id, disk_id, mode, dangerous=true | plan or job_id |

### 4.5 RAID / xiRAID Operations

| Tool | Inputs | Output |
|---|---|---|
| `raid.list` | controller_id | array_id, uuid, level, members, state, capacity, wear level, rebuild/recon status |
| `raid.create` | controller_id, spec, mode, idempotency_key | plan diff or job_id |
| `raid.modify_performance` | controller_id, array_id, spec, mode | plan diff or result |
| `raid.lifecycle_control` | controller_id, array_id, action (start/stop), process (init/recon) | result |
| `raid.unload` | controller_id, array_id | result |
| `raid.restore` | controller_id, source (drives/backup) | result |
| `raid.delete` | controller_id, array_id, mode, dangerous=true | plan diff or job_id |

**`raid.create` spec MUST support:**
- `level`: 0, 1, 5, 6, 7, 10, 50, 60, 70, N+M
- `drives`: block device list
- `chunk_size`: stripe size (default 16 KiB)
- `block_size`: 512 or 4096
- `group_size`: mandatory for levels 50/60/70
- `synd_cnt`: syndrome count for N+M levels

**`raid.modify_performance` spec MUST support:** `merge_write_enable` (mwe), `merge_read_enable` (mre), `sched_enable` (se).

**Plan-mode preflight for `raid.create`:** verify minimum RAM (1024 MiB), valid drive count per level (e.g., Level 7 requires ≥ 4 drives; Level 7.3 recommended for > 20 drives).

**Plan-mode preflight for `raid.delete`:** traverse storage stack — MUST block if filesystem is mounted or NFS share is active on the array.

### 4.6 NFS Share & Data Services

| Tool | Inputs | Output |
|---|---|---|
| `share.list` | controller_id | share_id, path, clients, options, security, ownership |
| `share.get_active_sessions` | controller_id, share_id | connected client IPs, active file locks |
| `share.create` | controller_id, spec, mode, idempotency_key | plan diff or result |
| `share.update_policy` | controller_id, share_id, policy_patch, mode | plan diff or result |
| `share.set_quota` | controller_id, share_id, type, soft_limit, hard_limit | result |
| `share.delete` | controller_id, share_id, mode, dangerous=false, delete_data=false | plan diff or result |

`share.create` spec MUST include: path, clients, policies (ro/rw, root_squash), security (sys, krb5, krb5i, krb5p), NFS versions, sync/async commit, RDMA transport enablement.

`share.delete` MUST leave underlying filesystem data intact unless `delete_data=true` is explicitly set.

### 4.7 Access Control / Identity

| Tool | Inputs | Output |
|---|---|---|
| `auth.get_supported_modes` | controller_id | sys, Kerberos, AD/LDAP readiness |
| `auth.validate_kerberos` | controller_id, realm_config_ref | keytab validity, time sync status, DNS resolution |

### 4.8 Operational Jobs

| Tool | Inputs | Output |
|---|---|---|
| `job.get` | job_id | state (queued/running/success/failed), progress %, logs |
| `job.list` | controller_id | all jobs |
| `job.cancel` | job_id | result |

The MCP server MUST implement per-array locking: a `raid.delete` MUST be rejected if a consistency check is actively running on the same array (`CONFLICT` error).

---

## 5. Security Requirements

### 5.1 Authentication
- mTLS between agent and director
- Token or OIDC between client and MCP server

### 5.2 Authorization (RBAC)

| Role | Permissions |
|---|---|
| `viewer` | All read-only tools |
| `operator` | viewer + share create/update/delete, quota management, non-destructive operations |
| `admin` | operator + RAID create/delete, disk wipe, system configuration |

### 5.3 Audit Logging

Every tool call MUST generate an append-only audit record containing:
`principal`, `timestamp`, `controller_id`, `tool_name`, `parameters_hash`, `result_hash`, `request_id`, `job_id`

Records MUST be tamper-evident (hash-chained or signed).

**Sinks:** Local append-only log file (primary) + syslog forwarding (secondary). Remote SIEM integration is out of scope for v1.

---

## 6. Safety Model

### 6.1 CLI Prohibition (Non-negotiable)

**The MCP server MUST NOT invoke `xicli`, `exportfs`, `systemctl`, or any other CLI binary via subprocess, exec, or shell.**

All operations MUST use structured APIs (REST, gRPC, Unix domain socket) or native bindings. Where no such API exists today, an intermediate helper daemon MUST be developed as a **pre-requisite** to MCP tool implementation (see §8).

### 6.2 Plan / Apply Discipline

All mutating operations MUST support:
- `mode="plan"` — dry-run, returns a deterministic human/machine-readable change plan
- `mode="apply"` — executes the exact output of the plan
- `idempotency_key` — prevents duplicate execution

### 6.3 Dependency & Referential Integrity

Destructive operations MUST traverse the storage stack top-down before executing:

```
NFS share active?
  → cannot unmount filesystem
    → cannot delete/wipe RAID array
      → cannot wipe disk
```

Violations MUST return `PRECONDITION_FAILED` with an explicit list of blocking child resources.

### 6.4 Dangerous Operations

Disk wipe, RAID destroy, and data deletion MUST require `dangerous=true` in the tool input. Confirmation is required at AI assistant level before passing this flag.

---

## 7. Error Model

All errors MUST be structured:

| Field | Description |
|---|---|
| `error_code` | Stable enum: `INVALID_ARGUMENT`, `NOT_FOUND`, `PRECONDITION_FAILED`, `PERMISSION_DENIED`, `CONFLICT`, `TIMEOUT`, `UNSUPPORTED`, `INTERNAL`, `RESOURCE_EXHAUSTION` |
| `message` | Human-readable context |
| `details` | Structured JSON: conflicting IDs, failing preflight checks, recommended next steps |

---

## 8. Pre-Requisite Work (Blockers)

The following items are **not** part of xiNAS-MCP itself but MUST be completed before the corresponding MCP tools can be implemented without violating §6.1.

### 8.1 xiRAID Native API Helper

**Status:** CLOSED — No helper daemon required.

**Finding (2026-02-26):** Source analysis via `/xiraid-analyst` confirms that xiRAID ships a **full gRPC management API** (`XRAIDService`, package `xraid.v2`). The daemon listens on `localhost:6066` (default; configured in `/etc/xraid/net.conf`). Authentication is one-way TLS using `/etc/xraid/crt/ca-cert.{pem,crt}`.

**Approach:** xiNAS-MCP generates TypeScript gRPC stubs from the `.proto` files bundled with xiRAID and connects directly. No intermediate process needed.

**Proto files location:** `src/usr/lib/xraid/gRPC/protobuf/` in the xiRAID source tree.

**Scaffold:** See `xiraid-analysis/helper_scaffold/` for typed TypeScript wrappers.

**Affected tools:** All `raid.*`, `disk.*` — resolved via direct gRPC calls.

### 8.2 NFS Management API Helper

**Status:** NOT EXISTS — NFS exports are currently managed by writing `/etc/exports` and invoking `exportfs -r`.

**Required outcome:** A locally running helper daemon that exposes NFS export management via structured API: list exports, add export, remove export, update export policy, query active sessions/locks, set quotas.

**Affected tools:** All `share.*`

### 8.3 xiRAID API Documentation

**Status:** Unknown / not available in codebase.

**Action required:** Obtain internal API documentation or source access for the xiRAID daemon socket protocol before 8.1 can be designed.

---

## 9. Non-Functional Requirements

| Requirement | Specification |
|---|---|
| Latency (read tools) | P99 < 500 ms for status/list operations |
| Latency (plan mode) | P99 < 5 s including preflight traversal |
| Availability | Stateless design; MCP server can restart without losing job state (jobs tracked in xiRAID/NFS helpers) |
| Backward compatibility | Additive changes allowed freely; breaking changes MUST use versioned namespace (e.g., `raid.create_v2`) |
| Rollback | If `apply` fails mid-operation (e.g., `raid.create`), the server MUST report the exact failure point and current partial state. **No automatic rollback.** The user MUST be notified with enough detail to remediate manually. |

---

## 10. AI Assistant Skill Requirements

### 10.1 Operational Guardrails

- MUST distinguish read-only tools from mutating tools and never use a mutating tool without user confirmation
- MUST execute `mode="plan"` first, present the diff, evaluate warnings, then request explicit user confirmation before `mode="apply"`
- MUST articulate blast radius before any mutating operation (e.g., "Warning: deleting array md0 will disconnect 12 active sessions on share data-vol")
- MUST treat RAID creation/deletion, disk wipe, share deletion, and security downgrade (krb5p → sys) as high-risk requiring double-confirmation
- MUST generate a deterministic change log after successful apply: what changed, why, `job_id`, and verification steps taken

### 10.2 State Awareness

- If an array is REBUILDING, suppress latency warnings and do NOT initiate heavy IO diagnostic jobs
- MUST poll long-running operations via `job.get` rather than assuming completion
- Multi-layer root cause analysis: high latency → check `raid.list` (degraded?), `disk.get_smart` (failing media?), `network.list` (dropped packets?)
- Fleet consistency: SHOULD support reading a desired state and applying it uniformly across multiple `controller_id` targets

### 10.3 Incident Triage Loop

Standard runbook for incident investigation:
1. `system.get_status` + `health.get_alerts` — snapshot current state
2. `system.get_performance` + `disk.list` + `raid.list` — correlate telemetry with physical state
3. Propose mitigation plan (non-destructive first)
4. Execute via plan → confirm → apply
5. Verify recovery

---

## 11. Out of Scope — v1

The following are explicitly deferred to future versions:

| Feature | Rationale |
|---|---|
| Snapshot management | Not defined in PRD §1.6; mentioned only in Evolution |
| SMB / S3 gateway | Mentioned in Evolution; no xiNAS support today |
| Firmware update tools | Not in PRD |
| MCP server config backup/restore | Operational tooling, post-launch |
| Federated director implementation | Per-controller agent is sufficient for v1 |
| Pacemaker integration for `raid.unload` | Deferred to post-v1 HA work |
| Multi-node fleet batching | Complex; deferred until per-controller agent is stable |

---

## 12. Open Questions

| # | Question | Owner | Priority |
|---|---|---|---|
| Q1 | Does the xiRAID daemon expose an internal socket/API beyond xicli? What is the protocol? | **CLOSED** — xiRAID source will be provided for analysis via `/xiraid-analyst` skill | CLOSED |
| Q2 | Is xiRAID API documentation available under NDA or source access? | **CLOSED** — source code will be analyzed directly to derive API surface and protocol | CLOSED |
| Q3 | Which MCP transport is primary for Claude Code integration: stdio or SSE? | Confirmed: stdio primary, SSE secondary | CLOSED |
| Q4 | What is the `controller_id` format? UUID, hostname, or user-defined string? | **CLOSED** — UUID | CLOSED |
| Q5 | Is the audit log local-only or must it support remote sinks (syslog, SIEM)? | **CLOSED** — local + syslog forwarding | CLOSED |
| Q6 | Does `raid.unload` for HA hand-off require Pacemaker integration in v1? | **CLOSED** — not in v1, deferred | CLOSED |
| Q7 | What is the rollback strategy for a `raid.create` that fails mid-provisioning? | **CLOSED** — notify user, no automatic rollback | CLOSED |
