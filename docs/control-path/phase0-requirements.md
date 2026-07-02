# xiNAS Phase 0 Requirements

> **Status:** Working contract for Phase 0.
> **Source:** Drafted 2026-05-26. ADRs under `docs/control-path/adr/` resolve
> open questions and may supersede individual requirements; in case of
> conflict, the most recent accepted ADR wins.
> **Companion plan:** [docs/plans/2026-05-26-phase0-control-path-plan.md](../plans/2026-05-26-phase0-control-path-plan.md).

## Scope

Phase 0 is the Control Path foundation phase for xiNAS. It establishes a single-node management architecture that wraps the existing xiNAS provisioning, storage, filesystem, NFS, networking, configuration history, and diagnostics components behind a typed API, local agent, local state store, task model, audit trail, and automation interface.

Phase 0 must not claim high availability, Active/Passive failover, Active/Active operation, witness quorum, Pacemaker failover, or NFS lock-reclaim correctness across nodes. It must prepare the object model, state model, execution model, and safety mechanisms required for later clustered phases.

The format below is:

**Requirement — How to verify**

---

## 1. Control API / API Gateway

**Requirement:** Implement a local versioned Control API as the single entry point for xiNAS day-2 operations, including inventory, capabilities, RAID, filesystem, shares, NFS profile, network, health, configuration history, support bundle, tasks, and audit.
**How to verify:** Run API integration tests against `/api/v1/*` and confirm that each supported day-2 operation is available through the API without direct shell/menu execution.

**Requirement:** All mutating operations must support `plan` and `apply` modes. `plan` must return deterministic preflight results before any change is made.
**How to verify:** For RAID create/delete, filesystem create/mount/unmount, share create/delete, NFS profile update, and network configuration, call `plan` first and verify that `apply` is rejected without a valid plan or state revision.

**Requirement:** API responses for mutating operations must include `operation_id`, `correlation_id`, current state revision, expected revision, affected resources, preflight blockers, warnings, risk level, rollback/remediation model, and estimated client impact.
**How to verify:** Execute positive and negative API calls and validate every response against the API contract schema.

**Requirement:** API errors must be structured and stable, with machine-readable error codes such as `INVALID_ARGUMENT`, `PRECONDITION_FAILED`, `PERMISSION_DENIED`, `CONFLICT`, `TIMEOUT`, `UNSUPPORTED`, and `INTERNAL`.
**How to verify:** Send invalid input, duplicate resource creation requests, unsafe delete requests, stale revision updates, and unauthorized requests. Verify the returned error code, message, details, and remediation hint.

**Requirement:** The Control API must remain outside the Data Path and must never be a synchronous dependency for steady-state NFS I/O.
**How to verify:** Run continuous NFS client read/write I/O, restart or stop `xinas-api`, and confirm that existing NFS I/O continues unless the test explicitly changes NFS, filesystem, or network configuration.

---

## 2. Local Desired/Observed State Store

**Requirement:** Phase 0 must introduce a local source of truth using either single-member etcd or an embedded local state store with the same key layout expected by future clustered deployment.
**How to verify:** Inspect the state store after provisioning and after each operation. Verify that the key layout can be migrated to multi-node etcd without changing object semantics.

**Requirement:** Desired state and observed state must be stored separately. Desired state describes the intended xiNAS configuration; observed state is reported by the local agent from the actual system.
**How to verify:** Manually change `/etc/exports`, `/etc/nfs/nfsd.conf`, `/etc/netplan/99-xinas.yaml`, or mount state outside xiNAS. Verify that observed state changes, desired state remains unchanged, and drift is reported.

**Requirement:** The Phase 0 object model must include at least `Node`, `Controller`, `Disk`, `XiraidArray`, `Filesystem`, `Share`, `NfsProfile`, `NetworkInterface`, `ServiceIP`, `ExportGroup`, `Task`, `Event`, and `Policy`.
**How to verify:** Query the API after installation and confirm that every object type is present, versioned, serializable as JSON, and represented in the state store.

**Requirement:** Every managed object must have a stable ID, revision, creation timestamp, modification timestamp, owner/source metadata, and validation status.
**How to verify:** Create, update, and delete objects through the API. Verify that IDs remain stable, revisions increment, timestamps change correctly, and validation status is updated.

**Requirement:** State updates must be atomic per operation and must prevent lost updates through revision checks.
**How to verify:** Submit two conflicting updates against the same object revision. Verify that one succeeds and the other fails with a stale revision or conflict error.

---

## 3. xinas-agent

**Requirement:** Implement `xinas-agent` as the only supported local executor for storage, filesystem, NFS, network, service, and system inspection actions in Phase 0.
**How to verify:** Disable `xinas-agent` and attempt mutating API operations. They must fail with a clear executor-unavailable error while read-only cached state remains available.

**Requirement:** The agent must have a stable `controller_id` generated once and persisted across reboots, service restarts, and upgrades.
**How to verify:** Reboot the node and restart all Control Path services. Verify that `controller_id` is unchanged and matches API, audit, task, and support-bundle records.

**Requirement:** The agent must report observed state for xiRAID arrays, disks, filesystems, mountpoints, NFS exports, NFS server state, RDMA interfaces, netplan configuration, and key systemd units.
**How to verify:** Compare API observed state with `xicli`, NVMe tools, `findmnt`, `exportfs`, `systemctl`, `ip addr`, `rdma link`, and netplan output.

**Requirement:** The agent must implement dependency-aware guardrails for destructive or unsafe operations, including traversal from share to filesystem to RAID array to disk.
**How to verify:** Try to delete a RAID array that backs a mounted filesystem and active NFS export. The operation must be blocked and must list the dependent share, filesystem, mountpoint, and array.

**Requirement:** The agent must execute only typed operations and must not expose arbitrary shell execution to API, CLI, TUI, or MCP clients.
**How to verify:** Review the agent API and perform static analysis. Confirm that user-facing components cannot submit arbitrary shell commands or uncontrolled script fragments.

---

## 4. Task Engine / Operation Manager

**Requirement:** All mutating operations must execute as durable tasks with states `queued`, `running`, `success`, `failed`, `cancelled`, and `requires_manual_recovery`.
**How to verify:** Start a long-running operation, restart `xinas-api`, and verify that task state, stage logs, and final result survive the restart.

**Requirement:** Each task must contain stage-level logs, preflight result, applied changes, final observed state, error details, and rollback or remediation hints.
**How to verify:** Run successful and failed RAID, filesystem, NFS, and network operations. Inspect task details through API and CLI.

**Requirement:** The task engine must enforce per-resource locks to prevent concurrent conflicting modifications to the same RAID array, filesystem, share, NFS profile, or network interface.
**How to verify:** Start two conflicting operations against the same resource. Verify that the second operation is rejected or waits with a clear `CONFLICT` or lock status.

**Requirement:** Tasks must be idempotent where safe and must support client-provided idempotency keys.
**How to verify:** Retry the same request with the same idempotency key after a timeout. Verify that the operation is not duplicated and that the original task is returned.

**Requirement:** Task cancellation must be supported only for safe cancellation points.
**How to verify:** Attempt cancellation during preflight, during a reversible stage, and during a non-interruptible stage. Verify that cancellation is accepted only when safe and otherwise returns a clear reason.

---

## 5. Installer / Ansible / Bootstrap

**Requirement:** Ansible must remain the Phase 0 bootstrap mechanism, but post-install day-2 operations must move to Control API tasks instead of repeated Ansible runs.
**How to verify:** Perform unattended installation, then create/update/delete shares, NFS settings, and network settings through API, CLI, or TUI without re-running Ansible.

**Requirement:** The installer must deploy and enable local Control Path services: `xinas-api`, `xinas-agent`, local state store, `xinas-nfs-helper`, `xinas-history`, and optionally `xinas-mcp`.
**How to verify:** After installation, verify systemd unit status, health endpoints, log paths, service dependencies, and API readiness.

**Requirement:** Existing Ansible roles must publish the initial desired state into the local Control Path store after provisioning.
**How to verify:** Complete a clean install and compare API desired state with the generated xiRAID, XFS, NFS, network, and tuning configuration.

**Requirement:** `xinas-api` must self-seed the infrastructure singletons — the `/xinas/v1/cluster` record (`mode=single_node`, Phase 0 capability flags) and its own `/xinas/v1/nodes/<controller_id>` record — at startup whenever they are absent, without any installer or agent involvement (ADR-0016). Existing rows must not be overwritten, except that the advertised `mcp.allow_apply` capability follows the api config.
**How to verify:** On a fresh install (or after deleting the state database and restarting `xinas-api`), `GET /system` and `GET /capabilities` return 200 with `mode=single_node` and exactly one node, with no manual seeding step.

**Requirement:** Shell menu scripts must remain compatibility wrappers only. New day-2 functionality must be implemented through the Control API and Python TUI/CLI clients.
**How to verify:** Run static-code checks on new commits. Fail the check if a new day-2 feature is implemented only in shell menu scripts.

**Requirement:** Bootstrap must be repeatable and must not overwrite existing user data, arrays, filesystems, exports, or network configuration without an explicit plan and destructive confirmation.
**How to verify:** Re-run bootstrap on a configured node and verify that it detects existing state, imports or reconciles it, and blocks destructive changes by default.

---

## 6. TUI / CLI / Automation Interface

**Requirement:** `xinas-menu` must use the Control API for all post-deployment changes, including storage, shares, NFS profile, network, users/quotas where supported, health, and configuration history.
**How to verify:** Perform operations from the TUI and verify that each operation creates an API task, audit record, config-history snapshot, and event.

**Requirement:** Provide a machine-oriented CLI, for example `xinasctl`, that uses the same Control API and supports JSON output.
**How to verify:** Run equivalent operations through API and CLI. Verify matching results, task IDs, audit records, and JSON schema.

**Requirement:** CLI, TUI, MCP, and automation clients must not implement separate business logic for safety decisions. All validation and preflight decisions must come from the Control API.
**How to verify:** Execute the same invalid operation through CLI, TUI, and MCP. Verify that all clients receive the same API-level preflight blocker.

**Requirement:** CLI commands must support `--plan`, `--apply`, `--json`, `--wait`, and `--timeout` options for mutating operations.
**How to verify:** Execute representative storage, NFS, and network commands using these flags and validate behavior against the API task model.

---

## 7. xiRAID / Disk / Storage Backend

**Requirement:** Phase 0 must expose xiRAID inventory and lifecycle through typed API objects instead of direct CLI calls from user-facing components.
**How to verify:** RAID list/create/delete/modify operations must go through the agent/API path. Static analysis must show no direct `xicli` execution from MCP, UI, or CLI client code paths.

**Requirement:** xiRAID integration must use the available xiRAID management interface where possible, with direct CLI execution limited to approved agent internals and compatibility fallback.
**How to verify:** Trace RAID operations and confirm that they use the preferred management interface or the approved agent executor. Fail the test if MCP, TUI, or CLI shells out directly.

**Requirement:** Disk inventory must include path, serial number, model, firmware, capacity, namespace layout, health, membership, and whether the disk is safe for use.
**How to verify:** Compare API disk inventory with NVMe identify data, SMART/health output, and xiRAID membership state.

**Requirement:** RAID create planning must validate RAID level, drive count, block size, chunk size, group size, spare policy, destructive impact, and expected usable capacity.
**How to verify:** Run parameterized tests for valid and invalid RAID 5, RAID 6, RAID 10, RAID 50, RAID 60, and N+M layouts.

**Requirement:** RAID delete or disk wipe must be blocked when the array backs a mounted filesystem, active export, or known desired-state object.
**How to verify:** Create an exported filesystem on a RAID array and attempt array deletion. Verify that the operation is blocked with dependency evidence.

**Requirement:** Existing arrays must be discoverable and importable into desired state without data loss.
**How to verify:** Install Phase 0 on a node with pre-existing xiRAID arrays. Verify discovery, import plan, and read-only health status before any mutation.

---

## 8. Filesystem Layer

**Requirement:** Filesystems must be first-class Control Path objects, including type, backing device/array, mountpoint, mount options, quota mode, health, owner policy, and desired/observed state.
**How to verify:** Create or discover XFS filesystems and verify complete representation through API, CLI, and state store.

**Requirement:** Filesystem operations must be stack-aware and must block unsafe unmount, format, grow, or delete actions when active shares or client sessions exist.
**How to verify:** Mount an NFS client and attempt filesystem unmount, format, or RAID deletion. Verify that the operation is blocked with active share/client evidence.

**Requirement:** XFS options generated by installer or presets must be captured in desired state, not only in systemd mount files.
**How to verify:** Compare the desired filesystem object with generated mount configuration and `findmnt` output.

**Requirement:** Filesystem creation must require an explicit plan that shows target device, filesystem type, label/UUID, mountpoint, destructive impact, and resulting desired-state object.
**How to verify:** Run filesystem create in `plan` mode and verify all required fields before allowing `apply`.

**Requirement:** Manual filesystem drift must be detected.
**How to verify:** Change mount options or unmount a managed filesystem outside xiNAS. Verify that health and drift APIs report the discrepancy.

---

## 9. NFS / Share Management

**Requirement:** NFS exports must be managed through `xinas-nfs-helper` or an agent-controlled structured API, not by direct calls to `exportfs` from MCP, TUI, or CLI clients.
**How to verify:** Create, update, and delete exports. Confirm through tracing and static analysis that only the approved helper/agent path invokes NFS management commands.

**Requirement:** Share objects must include path, clients, export options, NFS versions, security mode, RDMA enablement, stable `fsid`, sync/async behavior, quota policy, and generated client mount profile.
**How to verify:** Create shares with different client policies and verify rendered `/etc/exports`, API state, and client mount instructions.

**Requirement:** Phase 0 must introduce an `NfsProfile` object even before HA. It must represent NFS versions, NFS-RDMA port, thread count, server scope, fixed RPC port settings, and recovery-state path fields.
**How to verify:** Apply an NFS profile and compare `/etc/nfs/nfsd.conf`, effective service state, listening ports, and API desired state.

**Requirement:** NFS session visibility must be exposed through API and helper, including connected clients, NFS version, export path if known, and active lock count if available.
**How to verify:** Mount from at least two clients, open files, optionally hold byte-range locks, and confirm session visibility through API.

**Requirement:** Share deletion must never delete underlying data unless an explicit dangerous flag such as `delete_data=true` is provided and preflight allows it.
**How to verify:** Delete an export and verify that the underlying directory and files remain intact by default.

**Requirement:** NFSv3 and NFSv4 settings must be represented separately because they have different state, locking, recovery, and RPC-port requirements.
**How to verify:** Configure an NFSv3-only export and an NFSv4.2/RDMA export. Verify separate effective settings, service dependencies, firewall/RPC-port checks, and client mount profiles.

**Requirement:** NFS recovery-state path fields must be represented in Phase 0 desired state even if clustered failover is not enabled. These fields are configuration scaffolding for Phase 1 and must not be settable to non-default values in Phase 0 (writes return `UNSUPPORTED`).
**How to verify:** Query the NFS profile and verify explicit recovery-state configuration fields exist. Verify that attempting to write a non-default value returns `UNSUPPORTED`.

---

## 10. Network / RDMA Management

**Requirement:** Phase 0 must centralize xiNAS-managed IB/RDMA network configuration in `/etc/netplan/99-xinas.yaml`.
**How to verify:** Configure IB/RDMA interfaces through API or TUI and verify that xiNAS-managed IB definitions are rendered only into `/etc/netplan/99-xinas.yaml`.

**Requirement:** The Control API must detect and block duplicate IB/RDMA interface definitions in non-xiNAS netplan files.
**How to verify:** Add a conflicting IB stanza into another netplan file. Run health and network preflight. Verify that a blocker is reported before applying changes.

**Requirement:** Network configuration must include static IPs, MTU, IP pools where applicable, policy-based routing, VLAN/bonding where supported, RDMA capability, NFS-RDMA port, and transport mode.
**How to verify:** Apply a network plan and validate with `ip addr`, `ip rule`, `ip route`, `rdma link`, NFS-RDMA mount tests, and API observed state.

**Requirement:** Network changes must be planned with a management-connectivity safety check to prevent accidental lockout.
**How to verify:** Attempt to remove or misconfigure the active management interface. Verify that preflight warns or blocks unless explicit override is provided.

**Requirement:** RDMA readiness must be checked before enabling NFS over RDMA.
**How to verify:** Disable or break RDMA configuration and attempt to enable NFS-RDMA. Verify that the operation is blocked with evidence from RDMA/interface checks.

---

## 11. Configuration History / Rollback / Drift

**Requirement:** Every successful mutating `apply` task must automatically create a configuration-history snapshot before and after the change.
**How to verify:** Run share, RAID, NFS, filesystem, and network changes. Verify snapshot list, diff, operation metadata, and rollback classification.

**Requirement:** Drift detection must compare desired state with observed state and with managed files such as `/etc/exports`, `/etc/nfs/nfsd.conf`, and `/etc/netplan/99-xinas.yaml`.
**How to verify:** Modify these files manually and verify that API/TUI health reports drift with safety impact.

**Requirement:** Rollback must be plan/apply based and classified by risk: non-disruptive, changing access, destructive, or not supported.
**How to verify:** Attempt rollback after share policy changes, NFS profile changes, network changes, and storage layout changes. Verify correct classification and blockers.

**Requirement:** Configuration snapshots must include enough metadata to reconstruct what changed, who initiated it, through which client, and which task performed it.
**How to verify:** Inspect snapshots after API, CLI, TUI, and MCP operations. Verify principal, client type, task ID, operation ID, timestamp, and diff.

---

## 12. MCP

**Requirement:** In Phase 0, MCP is a transport on the same Control API core as REST (see ADR-0001). It must not be an independent executor.
**How to verify:** Trace MCP tool calls and confirm that every call invokes a shared core handler, not a parallel code path.

**Requirement:** Phase 0 MCP scope must be read-only diagnostics and plan-only workflows by default. Destructive `apply` operations must be blocked unless explicitly enabled by policy.
**How to verify:** Attempt RAID delete, disk wipe, share delete, filesystem format, and network reconfiguration through MCP. Verify policy denial or plan-only output.

**Requirement:** MCP must preserve RBAC, audit logging, idempotency, and plan/apply semantics. The same principal hitting the same handler via MCP or REST must receive identical authorization and produce identical audit records (transport noted, but no extra privilege).
**How to verify:** Run MCP calls as viewer, operator, and admin. Verify permissions, audit records, idempotency behavior, and task correlation. Confirm the same call via REST as the same principal yields the same outcome.

**Requirement:** MCP tool responses must be stable, structured, and suitable for agentic automation, with no dependence on parsing human-only CLI output.
**How to verify:** Run MCP diagnostic and plan tools and validate responses against JSON schemas.

---

## 13. Health, Telemetry, and Support Bundle

**Requirement:** Implement unified health profiles: `quick`, `standard`, and `deep`. Each check must return status, symptom, impact, evidence, and recommended action.
**How to verify:** Run all profiles on a healthy node and on nodes with broken NFS, missing RDMA, failed disk, config drift, and stopped services.

**Requirement:** Health checks must cover xiRAID service/API, array state, license, disks/NVMe, filesystem mount state, NFS server, NFS exports, NFS-RDMA readiness, network interfaces, netplan ownership, config drift, system tuning, and relevant systemd units.
**How to verify:** Inject one failure per area and confirm deterministic health output.

**Requirement:** Expose performance and telemetry through the existing metrics path where available, including xiRAID metrics, storage capacity, array state, NFS service state, and network/RDMA health.
**How to verify:** Query metrics through API and compare with exporter output and system tools.

**Requirement:** Provide a support-bundle endpoint that collects logs, task history, audit records, config snapshots, health reports, NFS configuration, netplan configuration, xiRAID state, filesystem state, network state, and system inventory.
**How to verify:** Generate a support bundle and verify redaction rules, completeness, reproducible archive structure, and absence of secrets.

---

## 14. Security / RBAC / Audit

**Requirement:** Phase 0 must define local RBAC roles at minimum: `viewer`, `operator`, and `admin`.
**How to verify:** Run API, CLI, TUI, and MCP operations under each role and confirm correct permission boundaries.

**Requirement:** Every API, TUI, CLI, and MCP operation must create an audit record with principal, timestamp, `controller_id`, operation/tool name, parameters hash, result hash, request ID, operation ID, and task ID if applicable.
**How to verify:** Execute read-only and mutating operations and inspect the append-only audit log.

**Requirement:** There must be a single canonical audit sink for Phase 0. Existing `/var/log/xinas/audit.log` (TUI) and `/var/log/xinas/mcp-audit.jsonl` (MCP) must be consolidated to one path with a documented migration for in-field support bundles.
**How to verify:** After upgrade, confirm only one audit file is written; older paths are either symlinks or contain a tombstone pointer; support bundle collects the canonical log.

**Requirement:** Dangerous operations must require an explicit dangerous flag and must expose blast radius before `apply`. The gate is enforced in the Control API core; clients only render and propagate the flag.
**How to verify:** Attempt disk wipe, RAID destroy, filesystem format, and data-delete share removal without the flag through API, CLI, TUI, and MCP. Each must be blocked at the same place.

**Requirement:** No user-facing component may execute arbitrary shell commands on the storage controller.
**How to verify:** Perform static-code scan and runtime tracing. Confirm that shell execution is limited to approved helper/agent internals with typed operations.

**Requirement:** Secrets and sensitive local data must be redacted from API responses, logs, task records, audit records, and support bundles.
**How to verify:** Configure credentials or sensitive values and generate logs/support bundles. Verify that raw secrets are not present.

---

## 15. Packaging / Service Model

**Requirement:** Phase 0 services must be packaged as systemd services or Podman containers. Kubernetes must not be mandatory.
**How to verify:** Install on a clean Ubuntu 22.04 or Ubuntu 24.04 system and verify that all Control Path services start without Kubernetes.

**Requirement:** Service units must include health checks, restart policies, log paths, configuration paths, and dependency ordering.
**How to verify:** Reboot the node and verify readiness of `xinas-api`, `xinas-agent`, state store, `xinas-nfs-helper`, `xinas-history`, and NFS services.

**Requirement:** Upgrade must preserve local state store, controller identity, configuration-history snapshots, audit logs, existing NFS shares, RAID arrays, filesystems, and network configuration.
**How to verify:** Perform upgrade from a previous Phase 0 build with existing arrays and shares. Verify no object ID, state, or data loss.

**Requirement:** Phase 0 state store and task/audit/event/snapshot stores must have a documented retention and garbage-collection policy with a bounded on-disk footprint.
**How to verify:** Run a soak test producing thousands of tasks/events; verify GC keeps usage under the documented bound and that the controller's root filesystem does not fill.

**Requirement:** Commits that require an Ansible role to re-run on the host to take effect must use the `Requires-Rebuild:` Git trailer (per CLAUDE.md). New Control Path services (`xinas-api`, `xinas-agent`, etc.) must integrate with the existing in-TUI updater's trailer-driven `--tags` flow.
**How to verify:** Modify a unit file or role and confirm that the update flow surfaces the role(s) to be re-run; modify Python-only code and confirm no Ansible step runs.

**Requirement:** Package uninstall must clearly separate software removal from data destruction.
**How to verify:** Run uninstall in non-destructive mode and confirm that arrays, filesystems, exports backup, state backup, and data remain intact.

---

## 16. Phase 0 End-to-End Acceptance

**Requirement:** A clean Phase 0 install must support the full workflow through Control Path: discover hardware, apply/import license, create or import xiRAID array, create XFS filesystem, configure RDMA network, create NFS share, generate client mount profile, mount from client, run health check, and collect support bundle.
**How to verify:** Execute this workflow on physical NVMe hardware and on a VM/lab preset. After bootstrap, all steps must be driven through API, TUI, or CLI rather than direct scripts.

**Requirement:** Restarting Control Path services must not interrupt existing NFS data traffic.
**How to verify:** Run continuous client I/O, restart `xinas-api`, `xinas-agent`, and history services. NFS I/O must continue unless NFS/kernel/network services are explicitly changed.

**Requirement:** Phase 0 documentation, API capabilities, and health output must clearly report deployment mode as `single-node` and HA capability as `not_enabled`.
**How to verify:** Review generated documentation, API capability output, TUI status, CLI status, and health reports.

**Requirement:** Phase 0 must include automated regression tests for API contracts, agent execution, NFS helper, network rendering, config history, RBAC, audit, idempotency, drift detection, and destructive-operation blockers.
**How to verify:** CI must run unit, contract, and end-to-end tests. Release must be blocked if any critical safety test fails.

**Requirement:** Phase 0 must provide a clear compatibility path for Phase 1 clustered management, including object IDs, state layout, NFS profile model, service IP model, and task/audit model.
**How to verify:** Review Phase 0 schemas against Phase 1 design. Confirm that no object or key layout must be redesigned to add cluster membership, witness, failover, shared recovery records, or service IP migration.

---

## 17. Explicit Non-Goals for Phase 0

**Requirement:** Phase 0 must not implement or advertise automatic controller failover.
**How to verify:** Product documentation, API capability output, and TUI status must show HA as unavailable or disabled.

**Requirement:** Phase 0 must not implement Active/Active NFS.
**How to verify:** Attempt to configure Active/Active mode and verify that the API returns `UNSUPPORTED`.

**Requirement:** Phase 0 must not claim NFSv4 lock/session recovery across node failover.
**How to verify:** Review documentation and API capability output. Verify that NFS recovery-state fields exist only as preparatory configuration objects (writes to non-default values return `UNSUPPORTED`).

**Requirement:** Phase 0 must not require a witness node or quorum configuration.
**How to verify:** Install and run Phase 0 on a single controller without witness configuration.

**Requirement:** Phase 0 must not make MCP a privileged bypass path.
**How to verify:** Confirm that MCP cannot perform actions that the same principal would be denied through the Control API's REST transport (ADR-0001).
