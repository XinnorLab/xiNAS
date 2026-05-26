# ADR-0005: NfsProfile object schema and Phase 0 writability

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Sergey Platonov
- **Supersedes:** —
- **Depends on:** [ADR-0001](0001-api-surface.md), [ADR-0002](0002-agent-privilege-model.md), [ADR-0003](0003-state-store.md), [ADR-0004](0004-task-engine.md)
- **Related requirements:** [phase0-requirements.md](../phase0-requirements.md) §9, §10, §17

## Context

Reqs §9 requires Phase 0 to expose an `NfsProfile` object that includes:

- NFS versions (subset of v3, v4.0, v4.1, v4.2)
- NFS-RDMA port
- Thread count (nfsd workers)
- Server scope (NFSv4 server scope identifier)
- Fixed RPC port settings for NFSv3 (nfsd, mountd, lockd, statd ports)
- Recovery-state path (nfsdcltrack RecoveryRoot)
- Service restart/reload policy

Reqs §9 also requires that **non-default writes to HA-shaped fields
(server scope, fixed RPC ports, recovery-state path) return `UNSUPPORTED`
in Phase 0**, since those fields are HA scaffolding for Phase 1.

The architecture proposal (`docs/plans/2026-05-26-phase0-control-path-plan.md`
and the source DOCX) lays out the model for NFSv4.1/4.2 HA, NFSv3
compatibility profile, recovery-record placement on the protected XFS
volume, and centrally managed fixed RPC ports. The accepted ADRs (0001–0004)
do not define the canonical schema for these fields or the API endpoint
shape.

This ADR locks the `NfsProfile` schema, writability matrix, effective-config
rendering targets, and Phase-0 API endpoint behavior before any
implementation begins.

## Decision

Phase 0 ships a **singleton `NfsProfile`** with `id = "default"` per node.
Phase 1+ may introduce per-ExportGroup profiles; the schema is shaped so
that addition does not require a migration.

### Schema (canonical JSON)

```json
{
  "kind": "NfsProfile",
  "id": "default",
  "metadata": {
    "revision": 7,
    "created_at": "2026-05-26T16:00:00Z",
    "modified_at": "2026-05-26T16:42:11Z",
    "owner": "system:installer",
    "source": "ansible:nfs_server",
    "validation_status": "valid"
  },
  "spec": {
    "versions": {
      "v3":    { "enabled": false },
      "v4_0":  { "enabled": false },
      "v4_1":  { "enabled": true  },
      "v4_2":  { "enabled": true  }
    },
    "rdma": {
      "enabled": true,
      "port": 20049
    },
    "threads": {
      "count": 64
    },
    "v3_locking": {
      "enabled": false,
      "fixed_rpc_ports": {
        "nfsd":   2049,
        "mountd": 20048,
        "lockd_udp": 32803,
        "lockd_tcp": 32803,
        "statd":  32765,
        "statd_outgoing": 32766
      }
    },
    "v4_recovery": {
      "backend": "nfsdcltrack",
      "recovery_root": "/var/lib/nfs/v4recovery",
      "server_scope": ""
    },
    "service_policy": {
      "on_thread_count_change": "reload",
      "on_version_change":     "restart",
      "on_rdma_change":        "restart",
      "on_v3_settings_change": "restart"
    }
  },
  "status": {
    "effective_files": {
      "/etc/nfs/nfsd.conf":             "sha256:...",
      "/etc/default/nfs-kernel-server": "sha256:...",
      "/etc/modprobe.d/lockd.conf":     "sha256:..."
    },
    "running": {
      "thread_count":  64,
      "rdma_listening": true,
      "rdma_port": 20049,
      "active_versions": ["4.1", "4.2"]
    },
    "warnings": [],
    "errors": []
  }
}
```

### Phase 0 writability matrix

| Field path                                    | Phase 0                                                          | Why                                                                                       |
|-----------------------------------------------|------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `spec.versions.v3.enabled`                    | writable (default: `false`)                                      | Standard NFS server config.                                                               |
| `spec.versions.v4_0.enabled`                  | writable (default: `false`)                                      | Standard NFS server config.                                                               |
| `spec.versions.v4_1.enabled`                  | writable (default: `true`)                                       | Primary supported profile.                                                                |
| `spec.versions.v4_2.enabled`                  | writable (default: `true`)                                       | Primary supported profile.                                                                |
| `spec.rdma.enabled`                           | writable                                                         | Operator may toggle NFS-RDMA. Plan checks `network.rdma_ready` blocker.                   |
| `spec.rdma.port`                              | writable (default: `20049`)                                      | Standard NFS-RDMA port; alternate ports are allowed.                                      |
| `spec.threads.count`                          | writable (default: `64`)                                         | Operator-tunable; reload-class change.                                                    |
| `spec.v3_locking.enabled`                     | writable, but **gated** on `spec.versions.v3.enabled == true`    | Enabling NFSv3 locking without NFSv3 enabled is invalid input.                            |
| `spec.v3_locking.fixed_rpc_ports.*`           | **read-only in Phase 0**, returns `UNSUPPORTED` on non-default writes | HA scaffolding (per reqs §9, §17). Defaults are exposed so a Phase 0 NFSv3 client can plan firewalls; centrally managed change is a Phase 1+ feature. |
| `spec.v4_recovery.backend`                    | **read-only**, always `nfsdcltrack` in Phase 0                   | NFS-Ganesha is a future option; Phase 0 ships kernel NFS.                                 |
| `spec.v4_recovery.recovery_root`              | **read-only**, returns `UNSUPPORTED` on non-default writes        | HA scaffolding (Phase 1+ places this on the protected XFS volume per the proposal §11.2.3). |
| `spec.v4_recovery.server_scope`               | **read-only**, returns `UNSUPPORTED` on non-empty writes          | HA scaffolding; server scope only matters across failover.                                |
| `spec.service_policy.*`                       | writable (with safe defaults)                                    | Operator-tunable restart/reload behavior.                                                 |
| `status.*`                                    | server-managed                                                    | Computed from observed state by the agent.                                                |

The `UNSUPPORTED` response includes:

```json
{
  "code": "UNSUPPORTED",
  "field": "spec.v4_recovery.recovery_root",
  "reason": "ha_scaffolding_phase0",
  "remediation": "This field is reserved for clustered Phase 1+ deployments. Phase 0 must leave it at the default value."
}
```

### Effective-config rendering

`xinas-agent` is the only component that writes the effective files. The
rendering targets on Ubuntu 22.04/24.04 are:

| File                                  | Owns                                                                   |
|---------------------------------------|------------------------------------------------------------------------|
| `/etc/nfs/nfsd.conf`                  | modular nfs-utils: enabled versions, RDMA port, debug flags.           |
| `/etc/default/nfs-kernel-server`      | Ubuntu-style: `RPCNFSDCOUNT`, `RPCMOUNTDOPTS`, additional flags.       |
| `/etc/modprobe.d/lockd.conf`          | `lockd` module parameters (`nlm_udpport`, `nlm_tcpport`) when v3 locking enabled. |
| `/etc/default/nfs-common`             | `STATDOPTS`, `STATDPRIV_TCPPORT`, `STATDPRIV_UDPPORT` for fixed statd ports (Phase 1+). |

Every rendered file is checksummed and the checksum lands in
`status.effective_files`. Manual modification of any of these files
shows up in `xinas_history` drift detection on the next sweep.

`/etc/nfs.conf` is **not** authoritative on Ubuntu 22.04/24.04. The
modular tools read `/etc/nfs/nfsd.conf`. Earlier drafts of the
requirements referenced `/etc/nfs.conf`; that has been corrected to
`/etc/nfs/nfsd.conf` in reqs §9 and §11.

### API endpoints (REST)

```
GET    /api/v1/nfs-profiles                 list (singleton in Phase 0)
GET    /api/v1/nfs-profiles/default         current state
PUT    /api/v1/nfs-profiles/default         replace spec; supports mode=plan|apply
PATCH  /api/v1/nfs-profiles/default         partial update; supports mode=plan|apply
```

Mutating calls follow the standard plan/apply contract:

1. `mode=plan` returns the computed diff (effective files before/after,
   service restart/reload decision, blast radius = list of affected
   exports), revision check, and any blockers (e.g. trying to disable
   RDMA while NFS-RDMA mounts are active).
2. `mode=apply` requires the `plan_id` from step 1 and the
   `expected_revision`. The task acquires a lease on
   `(nfs_profile, default)` and an advisory lease on every dependent
   share. Stage sequence: render → snapshot_before → write_files →
   reload_or_restart → snapshot_after → validate.

Writes to read-only fields fail at validation **before** any plan is
produced; clients see `UNSUPPORTED` per the schema above.

### Preflight blockers

Plan-mode rejects with `PRECONDITION_FAILED` when:

- Enabling RDMA but `network.rdma_ready == false` (per reqs §10).
- Disabling RDMA while any active NFS-RDMA session exists (reqs §9
  session visibility).
- Disabling a version that has active sessions (clients would lose
  mounts).
- `threads.count` outside `[8, 1024]` (sanity bound; not a hard
  kernel limit).

Plan-mode warns (not blocks) when:

- Thread count change exceeds 50% (operator should verify cgroup
  budgets).
- Enabling v3 without enabling v3_locking (some clients require it).

### Relationship to other objects

- **Share** objects continue to carry per-export fields (clients, RDMA
  enablement, fsid, sync/async). The `NfsProfile` is server-wide;
  share-level RDMA toggles still require `spec.rdma.enabled` at the
  profile level.
- **ExportGroup** singleton `default` references the `NfsProfile` by
  ID. Phase 1 will introduce per-ExportGroup profiles with the same
  schema.
- **Cluster.capabilities** advertises `nfs.v3_locking_managed=false` and
  `nfs.recovery_state_managed=false` in Phase 0 so clients can verify
  the HA scaffolding is inert.

## Consequences

### Pros

- **Schema is locked before code.** All future work (REST routes, agent
  rendering, TUI screens, MCP tools) targets one canonical shape.
- **HA scaffolding is present but inert.** Reqs §9 and §17 are satisfied
  literally: the fields exist, writes to non-default values return
  `UNSUPPORTED`, no Phase 1 migration of the data model is required.
- **Effective-file targets are documented for the right OS**
  (Ubuntu 22.04/24.04 modular nfs-utils). The earlier
  `/etc/nfs.conf` confusion is resolved.
- **Service-policy fields make restart/reload behavior reviewable**
  rather than buried in the implementation.

### Cons

- **Singleton profile is a constraint.** A Phase 0 operator cannot run
  two NFS profiles on the same node. This is fine for single-server
  Phase 0; multi-profile arrives with multi-ExportGroup in Phase 1.
- **`status.effective_files` snapshots couple the profile to the file
  layout.** A future OS change that moves these files requires a schema
  bump or a translation layer.
- **More schema surface to test.** Each `UNSUPPORTED` field needs a
  contract test that verifies the rejection.

### What this ADR does NOT decide

- The mechanism for migrating `recovery_root` to the protected XFS
  volume in Phase 1. That is a Phase 1 design and ADR-0010-series
  problem.
- Whether `NfsProfile` may be edited via the TUI in Phase 0 (it must
  be via the API; whether a dedicated screen ships in M4 is a UI
  scoping question, not an ADR question).
- The exact rendering of `/etc/modprobe.d/lockd.conf` when v3_locking
  is enabled in Phase 0. Phase 0 may ship this file unmanaged and
  require a manual restart of `lockd` to pick up changes; production
  tuning happens in implementation.

## Rejected alternatives

### Per-share NFS settings, no profile object

Rejected: server-wide settings (thread count, RDMA, version set) cannot
be expressed per share. Forcing them into share objects creates
contradiction. The profile is the right level of indirection.

### Expose HA fields as writable in Phase 0

Rejected: it would imply functionality that does not exist. Operators
who set `recovery_root = /mnt/protected/v4recovery` in Phase 0 would
see no effect, then discover at HA enablement that the field was
silently ignored. `UNSUPPORTED` on write is honest.

### Defer NfsProfile to Phase 1

Rejected: reqs §9 mandates the object exists in Phase 0 as preparatory
configuration. Deferring it would require a schema migration when
Phase 1 ships, which is exactly what the proposal asks Phase 0 to
prevent.

## Implementation notes for downstream workstreams

- **WS1 (API contracts):** OpenAPI v1 includes the schema above
  verbatim. The `UNSUPPORTED` family is documented as a per-field
  validation outcome in the contract.
- **WS3 (xinas-agent):** Implements `nfs.profile.render`,
  `nfs.profile.apply`, and `nfs.profile.observe` agent methods (per
  ADR-0002 method list). Reads the writability matrix from a shared
  schema definition; no logic is duplicated between API validation and
  agent rendering.
- **WS7 (NFS):** `xinas-nfs-helper` gains a thin pass-through for the
  effective-file write step. Helper continues to own `/etc/exports`
  changes; the new files (`nfsd.conf`, `nfs-kernel-server`) are
  written by the agent directly because they are not concurrency-hot.
- **WS9 (Config history):** `status.effective_files` checksums are
  reported into `/xinas/v1/observed/managed_files/<path>` (ADR-0003)
  on every successful apply. Drift detection picks them up on the next
  sweep without separate plumbing.
- **WS13 (Packaging):** The `nfs_server` Ansible role's initial
  rendering must produce the same files this ADR specifies. A
  reconciliation hook on first `xinas-api` start imports the
  Ansible-rendered state into the desired NfsProfile so the API and
  Ansible installer agree on the baseline.
