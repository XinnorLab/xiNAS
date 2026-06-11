# ADR-0008: Network/RDMA adapter (S6, WS8)

**Status:** accepted (2026-06-11). Supersedes nothing; extends ADR-0002/0004
with the network operation kinds and locks the network desired-state model.
Conforms to `docs/Network/spec-network-management.md` (the cross-cutting
netplan/PBR contract) — where this ADR is stricter (allocated-once PBR
tables, content-addressed freshness), this ADR wins for the control path;
day-1 Ansible and the TUI are unchanged.

## Context

WS8 requires day-2 IB/RDMA network management through the control path:
`99-xinas.yaml` as the only home for managed interface config, a
duplicate-netplan preflight blocker, IP/MTU/PBR/pool management, a
management-lockout guard, and RDMA-readiness evidence for the later
NFS-RDMA enable gate.

Verified integration facts this ADR is designed against:

- The day-2 truth lives in the TUI (`xinas_menu/screens/network.py`):
  write `99-xinas.yaml`, purge the iface from foreign netplan files, flush
  PBR tables 100–199 + all mlx IPs, `netplan apply`. Day-1
  (`net_controllers`) renders the whole file from a template with PBR
  table = `100 + loop.index0`.
- The engine leases `plan.lease_resources ?? plan.affected_resources`
  (`tasks/engine.ts`); `lease_resources` is the N-stream's override
  mechanism and is REQUIRED here (see §Concurrency).
- `PollDriver` re-sweeps every collector on its interval and every sweep
  re-puts rows (fresh `observed_at`), so **observed revisions churn ~every
  30 s on live hosts**. Revision-pinned observed freshness only holds
  within one sweep window; this ADR therefore uses content-addressed
  freshness for world state (see §Freshness) and pins revisions only on
  DESIRED rows (api-written, sweep-free, stable).
- Model R contract (verified in `tasks/progress.ts`): on a terminal
  non-success the EXECUTOR has already rolled back the HOST; the API then
  reverts the INTENT by replaying `desired_rollback`. S6 encodes exactly
  that split: executor owns host rollback, api owns desired rollback.
- The agent sandbox today: `CapabilityBoundingSet=CAP_CHOWN` (no
  CAP_NET_ADMIN — `ip rule/addr` mutations and netplan's kernel
  programming are impossible) and no write access to `/etc/netplan` or
  `/run/netplan`/`/run/systemd` under `ProtectSystem=strict`. §Sandbox
  lists the audited delta.
- `api-v1.yaml` `risk_level` enum is
  `[non_disruptive, changing_access, destructive, unsupported_rollback]`.
  S5 shipped `'disruptive'` (off-enum) on fs.unmount/fs.set_quota_mode;
  S6-T0 fixes that drift. S6 uses **`changing_access`** for network
  mutations — matching the project's own xinas_history risk taxonomy.

## Decision — object model

**Identity.** `NetworkInterface` id = kernel interface name (`ibp65s0`).
Managed ⇔ driver basename contains `mlx` (the existing classification).

**Desired projection (managed interfaces only).**
`/xinas/v1/desired/NetworkInterface/<name>`:

```jsonc
{ "kind": "NetworkInterface", "id": "ibp65s0",
  "spec": {
    "managed_by_xinas": true,
    "addresses": ["10.10.1.1/24"],   // CIDRs; render order preserved
    "mtu": 4092,                      // optional
    "enabled": true,                  // false ⇒ stanza omitted from render
    "pbr_table_id": 100               // ALLOCATED ONCE, never renumbered
  } }
```

Desired rows are the source of truth for the render:
`99-xinas.yaml == render(all enabled desired rows)` is the standing
invariant (full-file projection, never stanza patching). Management
ethernet (non-mlx) NEVER gets a desired row and is rejected at the route
(`422 UNSUPPORTED { reason: 'iface_not_managed' }`) — lockout prevention
by construction.

**Observed rows stay status-only** (ADR-0007 normalization). Enrichment
(S6) adds to `status`: `driver`, `rdma_capable`, `link_state`,
`current_addresses` (CIDRs), `rdma_link_state`, `owning_netplan_file`,
`duplicates_detected_in[]`, and `netplan` — the parsed `99-xinas.yaml`
stanza (`{addresses, mtu, pbr_table_id}`) that adoption reads.

**Synthetic observed singleton `NetworkConfig/default`.** The network
collector additionally emits one row summarizing the netplan file set:

```jsonc
{ "kind": "NetworkConfig", "id": "default",
  "status": {
    "files": { "/etc/netplan/99-xinas.yaml": "<sha256>", ... },
    "world_config_hash": "<sha256 over the sorted (path,hash) list — ALL files>",
    "xinas_file_hash": "<sha256 of 99-xinas.yaml alone ('' when absent)>",
    "duplicates": { "ibp65s0": ["/etc/netplan/50-cloud-init.yaml"] },
    "observed_at": "..." } }
```

The two hashes serve DIFFERENT contracts and must not be conflated
(foreign files like 50-cloud-init.yaml legitimately exist and change):
`world_config_hash` is the content-addressed world-state freshness pin
(§Freshness — ANY netplan edit invalidates in-flight plans);
`xinas_file_hash` is the WS9 drift anchor
(`xinas_file_hash != sha256(render(desired))` ⇒ drift in the file xiNAS
owns, regardless of foreign-file churn).

## Decision — public read model (review P0)

`api-v1.yaml` currently REQUIRES `spec` on `NetworkInterface`, but
observed rows carry none. T0 changes the contract: `spec` becomes
optional (`required: [kind, id, metadata, status]`), and
`GET /network/interfaces[/{id}]` returns a MERGED view — when a desired
row exists, its `spec` is attached verbatim (and `metadata.revision` is
the DESIRED row revision, the one mutations bind against); when none
exists (unmanaged or not yet adopted), `spec` is omitted and the revision
is the observed row's. The response thus tells clients exactly which
interfaces are under management.

## Decision — operations

Two kinds, both `risk_level: 'changing_access'`,
`rollback_model: 'non_disruptive'`:

| Kind | Route | Spec (writable) |
|---|---|---|
| `net.iface.update` | `PATCH /network/interfaces/{id}` | `addresses?`, `mtu?`, `enabled?`, `cleanup?` — any combination (no one-intent rule; all converge into one render+apply) |
| `net.pool.apply` | `POST /network/ip-pool` | `start` (first IP), `prefix`, `mtu?`, `cleanup?` |

Immutable per-field `422 UNSUPPORTED { reason: 'net_identity_immutable' }`:
`pbr_table_id` (allocated, never user-set), `managed_by_xinas`, `name`.

**`net.pool.apply` reallocates ADDRESSES ONLY** (review P1): day-1 pool
formula (incrementing third octet over sorted managed interfaces,
overflow blocker past 255). Existing `pbr_table_id`s are untouched; only
interfaces without a desired row get a fresh table allocation. The day-1
`100 + index` parity exists solely at adoption time (adopted stanzas keep
whatever table the file already had).

**PBR allocation.** `pbr_table_id` = lowest free id in [100, 199] across
(desired rows ∪ adoption candidates), allocated at plan time, persisted
forever in the desired row. `enabled: false` keeps the row AND its table
id (re-enable is a flag flip; no renumbering cascade). 100 ids ≫ any real
interface count; exhaustion is the `pbr_table_exhausted` blocker.

## Decision — adoption

On any network mutation, the provider compares observed managed
interfaces (with `status.netplan` stanzas) against desired rows. Every
managed interface lacking a desired row is ADOPTED: the plan's
`desired_mutations` batch seeds its desired row from the observed stanza
(addresses/mtu/table preserved; `enabled: true`) alongside the target's
updated row. The engine applies the batch atomically with the task
insert; Model R reverts it on failure. From the first mutation onward the
render is complete.

## Decision — concurrency (review P0)

Every network mutation's `lease_resources` (the N-stream override) is:

```
[ { kind: 'NetworkConfig', id: '99-xinas' },     // the singleton writer lease
  { kind: 'NetworkInterface', id: <target> },     // or all ifaces for pool
  ...one per interface adopted by this plan ]
```

The `NetworkConfig/99-xinas` singleton serializes ALL whole-file writers
— two concurrent `net.iface.update`s cannot interleave renders.
`affected_resources` (public) lists the target interface(s) only, primary
first.

## Decision — freshness (review P1, churn-aware)

Two layers, neither using observed-row revisions (they churn ~30 s):

1. **Desired state — per-resource revision pins.** The provider pins the
   CURRENT desired-row revision on EVERY affected `ResourceRef`
   (`{kind, id, revision}`; `revision: 0` for rows that do not exist yet
   — pre-adoption). The ENGINE's existing apply-txn freshness check
   (`r.revision ?? state_revision_expected` per resource, against
   desired revisions) then enforces all of them — this is what makes
   `net.pool.apply` safe across a MIXED pool (iface A at desired rev 3,
   iface B at rev 7): a scalar pin would false-stale one of them.
   `state_revision_expected` is set to the PRIMARY's revision and the
   route requires the apply body's `expected_revision` to echo it (the
   shared convention). Desired KV is api-written only, so these
   revisions are stable.
2. **World state**: the plan records `NetworkConfig/default`'s
   `world_config_hash` in the enriched spec. The route's apply re-check
   compares it against the CURRENT observed `world_config_hash`
   (→ `412 { reason: 'netplan_changed' }`), and the EXECUTOR preflight
   re-hashes the live files at the privilege boundary (closing the
   observe-lag TOCTOU the route check cannot). The network routes are
   CUSTOM S4-style routes (the arrays/filesystems pattern) — the shared
   `applyMode` helper has no pre-apply hook for this re-check.

## Decision — duplicate netplan definitions (review P1)

`duplicate_netplan_definition` (files listed in the message and
`details`) is a **blocker by default** — the WS8 requirement verbatim.
Sending `cleanup: true` in the op spec converts it into a **planned
repair**: the blocker is replaced by a `netplan_cleanup_planned` warning,
the plan `diff` lists exactly which interface keys leave which foreign
files, and the executor performs the cleanup in `render_write` with the
removed stanzas emitted as stage output (audit evidence). Day-1/TUI
auto-clean parity is therefore available, but only as an explicit,
audited choice. The `network.duplicate-netplan` health check reports the
condition independently of any op.

## Decision — apply sequences

- `net.iface.update` (surgical): flush ONLY the target's addresses
  (`ip addr flush dev <iface>`), its PBR rule(s)
  (`ip rule del` for its table), and its table
  (`ip route flush table <id>`); then `netplan apply`. Sound because
  table ids are allocated-once (no cross-interface renumbering) and the
  full-file render keeps every other stanza byte-identical.
- `net.pool.apply` (global): the day-1 sequence — flush tables 100–199 +
  all mlx addresses, then apply.
- Both write the FULL rendered `99-xinas.yaml` atomically
  (tmp + rename), run foreign-file cleanup when planned, and validate
  with `netplan generate` BEFORE touching kernel state — a render the
  merged config rejects aborts pre-flush with the prior file restored.

**Executor stages** (`net.iface.update`):
`preflight` (managed re-check; live re-hash vs the plan's `config_hash`;
duplicates re-scan honoring `cleanup`; stash prior file contents) →
`render_write` (write 99-xinas + planned foreign cleanups +
`netplan generate` validate) → `flush_target` (surgical) → `apply`
(`netplan apply`) → `verify` (`ip -j addr` shows desired addresses;
`ip rule` shows the table). Pool: same with the global flush.

**Rollback split (verified Model R contract):** the executor restores
every stashed file, re-runs `netplan generate` + the matching flush +
`netplan apply` (host returns to pre-task config); the api reverts the
desired rows via `desired_rollback` on the terminal-failed event. Neither
side touches the other's half.

## Decision — sandbox delta (Requires-Rebuild: xinas_agent)

Audited against the current unit:

| Need | Directive today | Delta |
|---|---|---|
| `ip rule/route/addr` mutations + netplan's kernel programming | `CapabilityBoundingSet=CAP_CHOWN` | `+ CAP_NET_ADMIN` (bounding + ambient) |
| write `/etc/netplan/99-xinas.yaml` + foreign-file cleanup | `ProtectSystem=strict` | `ReadWritePaths += /etc/netplan` |
| `netplan generate/apply` writes `/run/netplan`, `/run/systemd/network` | — | `ReadWritePaths += /run/netplan /run/systemd` |
| netlink for `ip -j`/monitor | `RestrictAddressFamilies` already has `AF_NETLINK` | none |
| networkd reload over dbus | `AF_UNIX` allowed | none |

One commit, `Requires-Rebuild: xinas_agent`, hardware smoke item appended
to the S6 spec checklist (no systemd/netlink mutation in CI — the
residual mirrors S5's).

## Decision — RDMA readiness & health

Observed enrichment supplies the evidence (`rdma_capable`,
`rdma_link_state` via `rdma link show -j`, addresses). `GET /health`
gains its first two real KV-derived checks:

- `network.duplicate-netplan` — status `critical` (the HealthCheck enum
  has no `error`) when any
  `duplicates_detected_in`/`NetworkConfig.duplicates` is non-empty;
  evidence lists files; remediation names `cleanup: true`.
- `network.rdma-readiness` — per managed interface: rdma-capable ∧ rdma
  link up ∧ has address ⇒ ok, else degraded with per-interface evidence.
  This check is the fact the later NFS-RDMA enable gate consumes (it does
  NOT block anything in S6).

## Blockers and warnings

| Code | Op | Meaning |
|---|---|---|
| `duplicate_netplan_definition` | both (sans `cleanup`) | target iface defined in a foreign netplan file |
| `addresses_invalid` / `mtu_invalid` | both | CIDR/MTU parse or range failure |
| `address_conflict` | both | CIDR collides with another desired interface |
| `pbr_table_exhausted` | both | no free id in 100–199 |
| `pool_overflow` | pool | third octet would exceed 255 (day-1 parity) |
| `no_managed_interfaces` | pool | nothing to allocate |
| warning `netplan_cleanup_planned` | both (`cleanup: true`) | foreign-file repair will run |
| warning `nfs_sessions_may_drop` | both | active NFS sessions exist (server-side IP correlation is not observable — honest warning, not a fake blocker) |

`iface_not_managed` is a route-level `422 UNSUPPORTED` and an unknown
interface id is a route/provider-level `404 NOT_FOUND` (the S5
`requireFsRow` pattern) — neither is a blocker.

## Deferred (out of S6)

VLAN/bonding (no day-1 surface to mirror), `ServiceIP` (Phase 1 HA
placeholder), management-ethernet writes (stay cloud-init/TUI-owned),
gateway/default-route management on IB interfaces, an automatic repair op
beyond `cleanup: true`, and any NFS-RDMA enable gating (consumes this
slice's facts later).
