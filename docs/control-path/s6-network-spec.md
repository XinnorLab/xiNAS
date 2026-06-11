# xiNAS S6 — Network/RDMA adapter (design spec)

**Status:** design (2026-06-11; conforms to **ADR-0008**). Completes WS8.
Implementation plan: `docs/plans/2026-06-11-s6-network-adapter-plan.md`.

**Goal.** Day-2 IB/RDMA network management through the control path:
`net.iface.update` (addresses/MTU/enable per managed interface, surgical
apply) and `net.pool.apply` (day-1-style address pool, global apply) on
the S2 engine + the N-stream desired-state machinery; the
duplicate-netplan blocker with the audited `cleanup: true` repair; the
observe enrichment (driver/RDMA/netplan ownership) and the first two real
health checks — all e2e-proven against a fake NetHost.

**Authoritative prior art.**
- **ADR-0008** — object model, full-file projection, allocated-once PBR
  tables, the `NetworkConfig/99-xinas` singleton lease, content-addressed
  freshness, duplicate/cleanup contract, sandbox delta, Model R split.
- `docs/Network/spec-network-management.md` — the netplan/PBR contract
  (file ownership, flush sequence, table range 100–199).
- Day-1 render truth: `collection/roles/net_controllers/templates/netplan.yaml.j2`
  (per-iface stanza shape) and the TUI `_update_netplan`/`_flush_pbr_rules`
  (surgical building blocks).
- Landed machinery: `PlanResult.{enriched_spec, lease_resources,
  desired_mutations}`, the engine apply txn, Model R revert on
  terminal-failed (`tasks/progress.ts`), `ctx.stash` for per-run executor
  state, the FsHost/fake-host pattern, fixture probe mode.

**Verified integration facts (truth-checked this session).**
- Engine leases `lease_resources ?? affected_resources`
  (`tasks/engine.ts:338`) — the singleton lease is expressible today.
- The engine's apply-txn freshness check is PER affected resource:
  `r.revision ?? plan.state_revision_expected` vs the current DESIRED
  revision (`tasks/engine.ts:218`) — pool plans pin every target's
  revision individually (mixed-revision pools would false-stale under a
  single scalar).
- The shared `applyMode` helper (`routes/apply-helpers.ts`) validates only
  the scalar expected revision and has no pre-apply hook — the network
  routes are custom S4-style routes so the `world_config_hash` re-check
  can run before `TaskEngine.apply`.
- `PollDriver` full-sweeps every collector on its interval; the observed
  handler dedupes unchanged re-pushes (the churn fix, landed before S6 —
  s0s1 spec Flow A step 3), so observed revisions move only on content
  change and the S4/S5 bindings are sweep-stable. S6 freshness remains
  desired-revision + `world_config_hash` (ADR-0008 §Freshness): netplan
  world state is multi-file and partly foreign-owned, the wrong
  granularity for one observed-row revision regardless of churn.
- The public `NetworkInterface` schema requires `spec` while the live
  route returns observed (spec-less) rows — fixed by the T0 merged read
  model.
- S5 shipped off-enum `risk_level: 'disruptive'`
  (`providers/filesystem.ts:347,407`) — T0 fixes both to
  `changing_access` (api enum + xinas_history taxonomy).
- Agent sandbox lacks CAP_NET_ADMIN and netplan write paths — T1 delta.
- `js-yaml` is already a dependency (observed-schemas) — the netplan
  parser/renderer use it.

---

## 1. Scope

### In scope
- **T0 contracts:** ADR-0008 (committed with this spec); api-v1.yaml —
  `NetworkInterface.spec` optional + merged-read description,
  `POST /network/ip-pool` (`applyIpPool`), `updateNetworkInterface`
  writability notes, `NetworkConfig` internal observed kind registered in
  BOTH registries — api `OBSERVED_KINDS` (observed-schemas.ts) AND the
  agent `Kind` union (`collectors/base.ts`, plus its `observedSegment`
  passthrough) — the collector emission will not compile otherwise; the
  S5 `risk_level` drift fix; stub supersession for the network mutating
  route.
- **Sandbox delta (T1):** CAP_NET_ADMIN + netplan/run write paths
  (`Requires-Rebuild: xinas_agent`) + hardware smoke checklist.
- **lib (T2–T3):** `lib/parse/netplan.ts` (file→stanzas, duplicates,
  config_hash), `lib/net/render.ts` (desired rows→full 99-xinas.yaml,
  day-1 goldens), `lib/net/validate.ts` (blockers, CIDR/MTU parsing,
  pool allocation formula, PBR table allocation).
- **NetHost (T4):** subprocess seam + file-backed fake
  (`net-host-state.json`) with kernel-state model and op log.
- **Observe enrichment (T5):** driver/rdma/link/current_addresses/
  netplan-stanza/duplicates per interface + the `NetworkConfig/default`
  singleton; fixture passthroughs.
- **Ops (T6–T8):** `net.iface.update` provider/route/executor;
  `net.pool.apply` provider/route/executor; adoption; merged reads.
- **Health (T9):** `network.duplicate-netplan` + `network.rdma-readiness`
  KV-derived checks in `GET /health`.
- **e2e (T10):** full scenario chain + the whole verification gate.

### Out of scope (ADR-0008 deferrals)
VLAN/bonding, ServiceIP, management-ethernet writes, IB gateways,
NFS-RDMA enable gating, the observed-revision churn fix for S4/S5.

---

## 2. Component map

```
   api (unprivileged)                                agent (root)
   ┌──────────────────────────────────────────┐      ┌─────────────────────────────────┐
   │ plan/providers/network.ts                │      │ task/net-executor.ts            │
   │   net.iface.update / net.pool.apply      │ task │   update: preflight→render_write│
   │   (adoption, table alloc, desired_       │ .begin│          →flush_target→apply   │
   │    mutations, lease_resources, config_   │ ────▶│          →verify                │
   │    hash pin)                             │      │   pool:   same, global flush    │
   │ routes/network.ts (PATCH iface, POST     │      │ net/host.ts (NetHost seam)      │
   │   ip-pool, merged GET reads)             │      │ net/fake-host.ts (e2e)          │
   │ routes/health.ts (2 real checks)         │      │ probe/network.ts (+enrichment)  │
   └──────────────────────────────────────────┘      │ collectors/network.ts (+        │
                                                     │   NetworkConfig singleton)      │
              shared: lib/parse/netplan.ts · lib/net/{render,validate}.ts
```

---

## 3. Shared lib contracts

### 3.1 `lib/parse/netplan.ts`
- `parseNetplanFiles(files: Record<path, text>)` →
  `{ stanzas: Record<iface, {file, addresses[], mtu?, pbr_table_id?}>,
     duplicates: Record<iface, file[]>, perFileIfaces: Record<file, iface[]> }`.
  Stanza fields read from `network.ethernets.<iface>`:
  `addresses`, `mtu`, `routing-policy[0].table` → `pbr_table_id`.
  Tolerant of foreign-file shapes (cloud-init etc.); unparsable YAML in a
  foreign file → that file is reported in
  `unparsable_files[]` (surfaces as a warning, never a crash).
- `netplanHashes(files)` → `{ world_config_hash, xinas_file_hash }` —
  sha256 over the sorted `(path, sha256(text))` list for ALL files
  (freshness pin) and sha256 of `99-xinas.yaml` alone, `''` when absent
  (the WS9 drift anchor) — ADR-0008's two-hash split.

### 3.2 `lib/net/render.ts`
- `renderNetplan(rows: DesiredIfaceSpec[])` → full `99-xinas.yaml` text.
  Day-1 template parity (goldens vs `netplan.yaml.j2` output shape):
  header comment, `network: {version: 2, renderer: networkd, ethernets:}`,
  per enabled iface sorted by name:
  `dhcp4: no`, `addresses`, `mtu?`,
  `routes: [{to: <connected subnet of addresses[0]>, scope: link, table: <pbr_table_id>}]`,
  `routing-policy: [{from: <ip of addresses[0]>, table, priority: table}]`.
  Multi-address stanzas add one routing-policy entry per address (same
  table). Deterministic output (stable key order) — `config_hash` of a
  re-render is reproducible.

### 3.3 `lib/net/validate.ts`
- `parseIfaceUpdateSpec` / `parsePoolSpec` — tolerant narrowing (enrichment
  keys ignored; junk → TypeError).
- `validateIfaceUpdate(spec, facts)` / `validatePool(spec, facts)` →
  ADR-0008 blockers (`duplicate_netplan_definition` honoring `cleanup`,
  `addresses_invalid`, `mtu_invalid` (1280–65520 — IB connected mode
  reaches 65520), `address_conflict`,
  `pbr_table_exhausted`, `pool_overflow`, `no_managed_interfaces`).
- `allocateTableId(used: Set<number>)` → lowest free in [100,199].
- `allocatePool(start, prefix, ifaceNames[])` → day-1 formula
  (`base.base.(startOctet+i).host/prefix`), overflow → null.

---

## 4. Operation contracts

### 4.1 `net.iface.update` (PATCH /network/interfaces/{id})

Plan:
1. Route rejects non-managed targets (`422 iface_not_managed` from
   observed `driver`) and immutable keys (`422 net_identity_immutable`).
2. Provider gathers facts: observed NetworkInterfaces (+ stanzas),
   `NetworkConfig/default` (config_hash + duplicates), desired rows,
   NFS sessions (warning only).
3. Adoption set = managed observed ifaces with stanzas minus desired rows.
4. Target's new desired spec = current desired (or adopted stanza, or
   empty) overlaid with the PATCH keys; `pbr_table_id` kept or allocated.
5. Blockers per §3.3; `desired_mutations` = adoption seeds + target row;
   `lease_resources` = `[NetworkConfig/99-xinas, target, ...adopted]`;
   `affected_resources` = `[{kind, id: target, revision: <current desired
   revision, 0 pre-adoption>}]` — per-resource pins, engine-enforced;
   `state_revision_expected` = the target's pinned revision.
6. `enriched_spec` = `{ id, desired: <full target spec>, render: <full
   file text>, world_config_hash, cleanup_files: {...},
   surgical: {addresses, pbr_table_id} }` — the executor needs no KV.
7. `risk_level: 'changing_access'`, `rollback_model: 'non_disruptive'`,
   diff = stanza-level before/after + cleanup list.

Apply (custom S4-style route — NOT the shared `applyMode`, which has no
pre-apply hook): `expected_revision` must echo the plan's
`state_revision_expected` (the primary's pinned revision; per-resource
staleness itself is enforced inside the engine txn from the
`affected_resources[].revision` pins); re-check provider preflight
(filtered per the S4 §8 pattern); current observed `world_config_hash`
=== plan's → else `412 netplan_changed`.

Executor stages (ADR-0008): preflight (live re-hash vs
`world_config_hash`, duplicate re-scan, stash prior files) → render_write (atomic write + planned cleanups +
`netplan generate`) → flush_target (surgical) → apply → verify.
Rollback: restore stashed files, `netplan generate`, surgical flush,
`netplan apply` — host back to pre-task; the api reverts desired rows
(Model R, verified `progress.ts` contract).

### 4.2 `net.pool.apply` (POST /network/ip-pool)

Same skeleton; differences: targets = ALL managed interfaces (adopted as
needed); addresses from `allocatePool`; **existing `pbr_table_id`s are
never reallocated** (ADR-0008); `lease_resources` = singleton + every
managed iface; `affected_resources` = every managed iface as
`{kind, id, revision: <its own current desired revision, 0 pre-adoption>}`
(primary = first sorted) — the engine enforces EACH pin, so a
mixed-revision pool (A at rev 3, B at rev 7) applies cleanly;
`state_revision_expected` = the primary's revision and the body's
`expected_revision` echoes it; executor uses the GLOBAL flush (tables
100–199 + all mlx addresses).

### 4.3 Merged reads (T6)

`GET /network/interfaces[/{id}]`: observed rows with `spec` +
`metadata.revision` overlaid from the desired row when present
(ADR-0008 §read model).

---

## 5. NetHost seam (T4)

```ts
interface NetHost {
  readNetplanDir(): Promise<Record<string, string>>;      // path → text
  writeNetplanFile(path: string, text: string): Promise<void>;  // atomic
  netplanGenerate(): Promise<void>;                        // validate; throws on reject
  netplanApply(): Promise<void>;
  ipRuleShow(): Promise<string>;
  ipRuleDel(spec: string): Promise<void>;
  ipRouteFlushTable(id: number): Promise<void>;
  ipAddrFlush(dev: string): Promise<void>;
  ipAddrShow(): Promise<string>;                           // `ip -j addr` json
  listSysClassNet(): Promise<Array<{name: string, driver: string}>>;
  rdmaLinkShow(): Promise<string>;                         // `rdma link show -j` json ('' if no rdma tool)
}
```

Fake (`net-host-state.json`): `{ netplan_files: {path: text},
kernel: { addrs: {dev: cidr[]}, rules: [{from, table, priority}],
tables: {id: route[]} }, sys_class_net: [{name, driver}],
rdma_links: [...], ops: [] }`. Behaviors: `netplanApply` re-derives
kernel state from the merged parse of `netplan_files` (the netplan-apply
"does not remove" quirk modeled: addresses are ADDED, never removed —
the flush verbs are what remove); `netplanGenerate` rejects when any file
fails YAML parse or a stanza has no addresses while enabled
(deterministic `-invalid` hook: a file containing the string
`INVALID-NETPLAN` rejects). `-fail` stem hooks on `netplanApply` /
`ipAddrFlush` targets for rollback paths.

## 6. Observe enrichment (T5)

Probe additions (injectable deps): `listSysClassNet` (driver →
`rdma_capable`), netplan dir read + `parseNetplanFiles` (stanza,
`owning_netplan_file`, `duplicates_detected_in`), `rdma link show -j`
(`rdma_link_state`), `current_addresses` from the existing `ip -j` parse.
Collector emits the per-iface enrichment + the `NetworkConfig/default`
singleton (compare-and-skip: re-emit only when `config_hash` or the
duplicate map changes, so the singleton's revision moves only on real
change). Fixture passthroughs: `netplan-files.json`
(`{path: text}`), `sys-class-net.json`, `rdma-links.json` — the fixture
probe runs the SAME parse/hash code as the real one. The collector honors
`XINAS_AGENT_NETWORK_POLL_MS` (the `XINAS_AGENT_XIRAID_POLL_MS` pattern)
so the e2e can shorten the 30 s sweep for the `netplan_changed`
scenario.

## 7. Health checks (T9)

`GET /health` becomes KV-backed for two checks (quick profile, no agent
round-trip): `network.duplicate-netplan` (status `critical` — the
HealthCheck enum is [ok, warning, degraded, critical, skipped]; evidence
= duplicate map + files; remediation names `cleanup: true`) and
`network.rdma-readiness`
(ok/degraded; per-iface evidence `{rdma_capable, rdma_link_state,
has_address}`). The stub `xinas-api.alive` check stays.

## 8. e2e (T10)

Boot api+agent in fixture mode; seed `netplan-files.json` (99-xinas with
two managed stanzas, 50-cloud-init.yaml duplicating `ibp65s0` + the mgmt
ethernet), `sys-class-net.json` (2× mlx + 1 ethernet), `rdma-links.json`,
`net-host-state.json` mirroring the files. Scenarios:
1. Duplicate blocker: PATCH `ibp65s0` plan → `duplicate_netplan_definition`
   listing 50-cloud-init.yaml; `GET /health` shows the check at
   `critical`.
2. Cleanup + update: re-plan `{addresses, cleanup: true}` → warning +
   diff lists the planned removal → apply (expected_revision 0,
   pre-adoption) → success; fake host: 99-xinas re-rendered with BOTH
   stanzas (adoption proven), cleaned 50-cloud-init, surgical flush ops
   for the target ONLY, `netplan generate` before any flush; GET merged
   read shows desired spec + stable revision.
3. Identity 422 + unmanaged 422: PATCH `pbr_table_id` → `net_identity_immutable`;
   PATCH the ethernet → `iface_not_managed`.
4. `netplan_changed` gate: mutate `netplan-files.json` (collector
   re-hashes `world_config_hash`) after plan → apply → 412.
5. Pool apply: POST ip-pool → both ifaces re-addressed
   (day-1 formula), table ids UNCHANGED, global flush ops, health
   rdma-readiness ok.
6. Rollback: `netplanApply` `-fail` hook → task failed; fake host files
   restored byte-identical; desired rows reverted (GET shows pre-task
   spec).

## 9. Decomposition (T0–T10)

| Task | Contents | Commit type |
|---|---|---|
| T0 | ADR-0008 + this spec land; api-v1 (spec-optional NetworkInterface, merged-read note, POST /network/ip-pool, NetworkConfig in OBSERVED_KINDS); S5 `risk_level` drift fix (`'disruptive'`→`'changing_access'` + tests); contract fixtures | docs+fix(api) |
| T1 | agent unit: `CAP_NET_ADMIN`, `ReadWritePaths += /etc/netplan /run/netplan /run/systemd`; smoke checklist appended here §10 | feat(agent), `Requires-Rebuild: xinas_agent` |
| T2 | `lib/parse/netplan.ts` + `lib/net/render.ts` (day-1 goldens, hash determinism) | feat(lib) |
| T3 | `lib/net/validate.ts` (blockers, allocations) | feat(lib) |
| T4 | NetHost + fake host | feat(agent) |
| T5 | observe enrichment + NetworkConfig singleton (compare-and-skip) + fixture passthroughs | feat(agent) |
| T6 | `net.iface.update` provider + PATCH route + merged GET reads | feat(api) |
| T7 | `net.iface.update` executor | feat(agent) |
| T8 | `net.pool.apply` provider + POST route + executor | feat(control-path) |
| T9 | health checks | feat(api) |
| T10 | e2e + full gate | test(e2e) |

## 10. Risks & residuals

- **Hardware smoke checklist (T1 residual; run with the S5 one):** on a
  lab node post-rebuild: PATCH an IB interface IP → `ip addr`/`ip rule`
  match; duplicates blocked then cleaned with `cleanup: true`; pool apply
  re-addresses with stable tables; agent journal free of EPERM/EACCES
  (CAP_NET_ADMIN sufficiency); `netplan generate` rejection path leaves
  the prior file in place; management ethernet untouched throughout.
- **Foreign-file YAML round-trip:** cleanup rewrites e.g.
  `50-cloud-init.yaml` via js-yaml (comments/ordering may change in THAT
  file — same behavior as the landed TUI cleanup; documented, not new).
- **`netplan apply` blast radius:** even the surgical path runs a global
  `netplan apply`; networkd may bounce other interfaces briefly. Risk
  level `changing_access` + the plan diff say so.
- **Observed-revision churn (repo-wide):** S4/S5 route bindings inherit a
  ≤1-sweep apply window on live hosts; S6 avoids the pattern but does not
  fix the older routes (tracked outside this slice).
