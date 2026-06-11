# S6 Network/RDMA Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Day-2 IB/RDMA network management through the control path — `net.iface.update` + `net.pool.apply` over desired-state full-file projection of `/etc/netplan/99-xinas.yaml`, with the duplicate-netplan blocker, audited `cleanup: true` repair, observe enrichment, and the first two real health checks (WS8; ADR-0008 + `docs/control-path/s6-network-spec.md`).

**Architecture:** Desired `NetworkInterface` rows are the source of truth; every apply renders the whole `99-xinas.yaml` (never stanza-patches), serialized by the `NetworkConfig/99-xinas` singleton lease. Freshness is per-resource desired-revision pins (engine-enforced) + the content-addressed `world_config_hash`. The executor runs against an injectable `NetHost` (FsHost pattern) with a file-backed fake for e2e. Executor owns host rollback; the api owns desired rollback (Model R).

**Tech Stack:** TypeScript (xiNAS-MCP), vitest, express, better-sqlite3 KV, js-yaml, the landed S2 engine + N-stream `lease_resources`/`desired_mutations` machinery.

**Conventions (apply to every task):** work in `xiNAS-MCP/`; `.js` ESM import suffixes; `exactOptionalPropertyTypes` conditional spreads; TDD (write the failing test first, run it, implement, re-run); never `git add -A` — stage exact paths; commit per task with a HEREDOC message ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; gate per task = the named vitest file(s) + `npx tsc --noEmit`; full gate at T10. Run `npm test` from `xiNAS-MCP/` (cwd resets between Bash calls — always `cd` first).

---

### Task T0: Contracts — api-v1, Kind registries, S5 risk_level drift fix

**Files:**
- Modify: `docs/control-path/api-v1.yaml` (NetworkInterface schema; new `/network/ip-pool` path)
- Modify: `xiNAS-MCP/src/api/observed-schemas.ts` (OBSERVED_KINDS)
- Modify: `xiNAS-MCP/src/agent/collectors/base.ts` (Kind union)
- Modify: `xiNAS-MCP/src/api/plan/providers/filesystem.ts` (two `risk_level: 'disruptive'` → `'changing_access'`)
- Modify: every test asserting `'disruptive'` (grep: `src/__tests__/api/plan/filesystem-provider.test.ts`, `src/__tests__/api/routes-filesystems.test.ts`, `src/__tests__/e2e/filesystem-adapter.test.ts`)
- Modify: `docs/control-path/s5-filesystem-spec.md` (risk wording note)
- Create: `xiNAS-MCP/src/__tests__/contracts/fixtures/NetworkInterface.json`

- [ ] **Step 1: api-v1.yaml — NetworkInterface spec optional + merged-read contract.** In the `NetworkInterface` schema change `required: [kind, id, metadata, spec, status]` → `required: [kind, id, metadata, status]` and add to the schema description:

```yaml
    NetworkInterface:
      type: object
      description: |
        MERGED read model (ADR-0008): when a desired row exists (managed +
        adopted), `spec` is the desired spec verbatim and metadata.revision
        is the DESIRED row revision (the one mutations bind). Unmanaged or
        not-yet-adopted interfaces have no `spec`. `spec.pbr_table_id` is
        allocated once at first manage and never renumbered.
      required: [kind, id, metadata, status]
```

Add `enabled` default note and extend `status` with the enrichment fields:

```yaml
            rdma_link_state: { type: string, enum: [up, down, unknown] }
            netplan:
              type: object
              description: "Parsed 99-xinas.yaml stanza for this interface (adoption source)."
              properties:
                addresses: { type: array, items: { type: string } }
                mtu: { type: integer }
                pbr_table_id: { type: integer }
```

- [ ] **Step 2: api-v1.yaml — the pool route.** Add under `paths` next to `/network/interfaces`:

```yaml
  /network/ip-pool:
    post:
      tags: [network]
      operationId: applyIpPool
      summary: Re-allocate the managed-interface IP pool (plan/apply).
      description: |
        Day-1 pool formula (incrementing third octet over sorted managed
        interfaces). Reallocates ADDRESSES ONLY — existing pbr_table_ids
        persist (ADR-0008). spec: { start, prefix, mtu?, cleanup? }.
      requestBody: { $ref: '#/components/requestBodies/Mutating' }
      responses:
        '200': { $ref: '#/components/responses/PlanReturned' }
        '202': { $ref: '#/components/responses/TaskAccepted' }
        '400': { $ref: '#/components/responses/InvalidArgument' }
        '409': { $ref: '#/components/responses/Conflict' }
        '412': { $ref: '#/components/responses/PreconditionFailed' }
        '500': { $ref: '#/components/responses/Internal' }
```

- [ ] **Step 3: register `NetworkConfig` in BOTH registries.** `src/api/observed-schemas.ts`: add `'NetworkConfig'` to `OBSERVED_KINDS` (it has no public schema → gets the permissive validator, the `managed_files` precedent). `src/agent/collectors/base.ts`: add `| 'NetworkConfig' // internal observed singleton (id 'default'); netplan file-set summary (ADR-0008)` to the `Kind` union. Check `observedSegment` passes unknown kinds through unchanged (it does for `XiraidArray`); no edit needed unless it whitelists.

- [ ] **Step 4: S5 risk drift fix.** In `src/api/plan/providers/filesystem.ts` replace both `risk_level: 'disruptive'` (fs.unmount ~line 347, fs.set_quota_mode ~line 407) with `risk_level: 'changing_access'`. Grep `'disruptive'` across `src/` and update the three test files' assertions to `'changing_access'`. Add one sentence to `docs/control-path/s5-filesystem-spec.md` §4: "Post-S6-T0: risk_level is `changing_access` (the api enum has no `disruptive`)."

- [ ] **Step 5: contract fixture.** Create `src/__tests__/contracts/fixtures/NetworkInterface.json` — a MANAGED merged row:

```json
{
  "kind": "NetworkInterface",
  "id": "ibp65s0",
  "metadata": { "revision": 2, "created_at": "2026-06-11T10:00:00Z", "modified_at": "2026-06-11T10:05:00Z", "owner": "system:installer", "source": "ansible:net_controllers", "validation_status": "valid" },
  "spec": { "managed_by_xinas": true, "addresses": ["10.10.1.1/24"], "mtu": 4092, "enabled": true, "pbr_table_id": 100 },
  "status": {
    "driver": "mlx5_core", "rdma_capable": true, "link_state": "up",
    "rdma_link_state": "up",
    "current_addresses": ["10.10.1.1/24"],
    "owning_netplan_file": "/etc/netplan/99-xinas.yaml",
    "duplicates_detected_in": [],
    "netplan": { "addresses": ["10.10.1.1/24"], "mtu": 4092, "pbr_table_id": 100 },
    "observed_at": "2026-06-11T10:05:00Z"
  }
}
```

- [ ] **Step 6: gate + commit.** Run `cd xiNAS-MCP && npm run test:contracts && npm test 2>&1 | grep -E "Test Files|Tests "` (expect all green — the risk assertions now match) and `npx tsc --noEmit`. Commit:

```bash
git add docs/control-path/api-v1.yaml docs/control-path/s5-filesystem-spec.md xiNAS-MCP/src/api/observed-schemas.ts xiNAS-MCP/src/agent/collectors/base.ts xiNAS-MCP/src/api/plan/providers/filesystem.ts xiNAS-MCP/src/__tests__/contracts/fixtures/NetworkInterface.json xiNAS-MCP/src/__tests__/api/plan/filesystem-provider.test.ts xiNAS-MCP/src/__tests__/api/routes-filesystems.test.ts xiNAS-MCP/src/__tests__/e2e/filesystem-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(control-path): S6 T0 — network contracts (merged reads, ip-pool route, NetworkConfig kind) + S5 risk enum fix

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task T1: Agent sandbox delta (Requires-Rebuild)

**Files:**
- Modify: `xiNAS-MCP/xinas-agent.service`

- [ ] **Step 1: edit the unit.** `CapabilityBoundingSet=CAP_CHOWN` → `CapabilityBoundingSet=CAP_CHOWN CAP_NET_ADMIN`; same for `AmbientCapabilities`. `ReadWritePaths=/run/xinas /var/log/xinas /etc/systemd/system` → append ` /etc/netplan /run/netplan /run/systemd`. Add a comment block mirroring the ADR-0008 sandbox table (why each path/cap: netplan render+cleanup writes; `netplan generate/apply` writes /run/netplan + /run/systemd/network; `ip rule/route/addr` + kernel programming need CAP_NET_ADMIN; AF_NETLINK already allowed).

- [ ] **Step 2: commit with the trailer.**

```bash
git add xiNAS-MCP/xinas-agent.service
git commit -m "$(cat <<'EOF'
feat(agent): S6 T1 — CAP_NET_ADMIN + netplan write paths for the network executors

ADR-0008 §Sandbox: ip rule/route/addr mutations and netplan's kernel
programming need CAP_NET_ADMIN; /etc/netplan (render + cleanup),
/run/netplan and /run/systemd (netplan generate/apply) join
ReadWritePaths under ProtectSystem=strict. Hardware smoke checklist:
s6-network-spec §10.

Requires-Rebuild: xinas_agent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task T2: `lib/parse/netplan.ts` + `lib/net/render.ts`

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/netplan.ts`
- Create: `xiNAS-MCP/src/lib/net/render.ts`
- Test: `xiNAS-MCP/src/__tests__/lib/parse/netplan.test.ts`, `xiNAS-MCP/src/__tests__/lib/net/render.test.ts`

- [ ] **Step 1: failing parse tests.** Cover: two files where `ibp65s0` appears in both → `duplicates['ibp65s0'] = ['/etc/netplan/50-cloud-init.yaml']` (foreign file only — the owning 99-xinas entry is not a "duplicate"); stanza extraction (`addresses`, `mtu`, `routing-policy[0].table → pbr_table_id`); `owning` precedence (99-xinas wins); unparsable foreign YAML lands in `unparsable_files` without throwing; `netplanHashes` determinism (same files → same hashes; editing ANY file changes `world_config_hash`; editing only a foreign file does NOT change `xinas_file_hash`; absent 99-xinas → `xinas_file_hash === ''`).

- [ ] **Step 2: implement `parse/netplan.ts`.** Shape:

```ts
export interface NetplanStanza { file: string; addresses: string[]; mtu?: number; pbr_table_id?: number; }
export interface ParsedNetplan {
  stanzas: Record<string, NetplanStanza>;          // iface → owning stanza (99-xinas preferred)
  duplicates: Record<string, string[]>;            // iface → foreign files also defining it
  perFileIfaces: Record<string, string[]>;
  unparsable_files: string[];
}
export const XINAS_NETPLAN = '/etc/netplan/99-xinas.yaml';
export function parseNetplanFiles(files: Record<string, string>): ParsedNetplan;
export function netplanHashes(files: Record<string, string>): { world_config_hash: string; xinas_file_hash: string };
```

Use `js-yaml` `load` per file inside try/catch; read `network.ethernets` objects; `world_config_hash` = sha256 of `JSON.stringify(sortedEntries.map(([p, t]) => [p, sha256(t)]))`; `xinas_file_hash` = sha256 of the 99-xinas text or `''`.

- [ ] **Step 3: failing render tests.** Goldens (day-1 `netplan.yaml.j2` parity): one enabled row `{addresses: ['10.10.1.1/24'], mtu: 4092, pbr_table_id: 100}` renders `dhcp4: false`, the address list, mtu, `routes: [{to: '10.10.1.0/24', scope: link, table: 100}]`, `routing-policy: [{from: '10.10.1.1', table: 100, priority: 100}]` under `network.ethernets.ibp65s0` with `version: 2`/`renderer: networkd`; disabled rows are omitted; output is deterministic (two calls byte-equal; iface order = sorted names); multi-address rows emit one routing-policy entry per address (same table) and the connected route of `addresses[0]`; parse-back via `parseNetplanFiles({[XINAS_NETPLAN]: text})` round-trips addresses/mtu/table.

- [ ] **Step 4: implement `net/render.ts`.**

```ts
export interface DesiredIfaceSpec { name: string; addresses: string[]; mtu?: number; enabled: boolean; pbr_table_id: number; }
export function connectedSubnet(cidr: string): string;   // '10.10.1.1/24' → '10.10.1.0/24' (IPv4 prefix math)
export function renderNetplan(rows: DesiredIfaceSpec[]): string;
```

Build the object, `yaml.dump(obj, { sortKeys: false, lineWidth: 120 })`, prefix a header comment (`# Managed by xiNAS — render of desired NetworkInterface state (ADR-0008). Do not hand-edit.`).

- [ ] **Step 5: gate + commit** (`npx vitest run src/__tests__/lib/parse/netplan.test.ts src/__tests__/lib/net/render.test.ts`, tsc; `feat(lib): S6 T2 — netplan parse/hashes + day-1-parity full-file render`).

---

### Task T3: `lib/net/validate.ts`

**Files:**
- Create: `xiNAS-MCP/src/lib/net/validate.ts`
- Test: `xiNAS-MCP/src/__tests__/lib/net/validate.test.ts`

- [ ] **Step 1: failing tests** for: `parseIfaceUpdateSpec` (tolerant; junk → TypeError; at least one of addresses/mtu/enabled required), `parsePoolSpec` (start IPv4 + prefix 8–30 required); `allocateTableId(new Set([100,101])) === 102`, exhaustion (all 100–199 used) → `null`; `allocatePool('10.10.1.1', 24, ['a','b','c'])` → `['10.10.1.1/24','10.10.2.1/24','10.10.3.1/24']`, overflow (start third octet 254 + 3 ifaces) → `null`; `validateIfaceUpdate` blocker table: `duplicate_netplan_definition` (duplicates present + `cleanup !== true`; with `cleanup: true` → no blocker), `addresses_invalid` (bad CIDR), `mtu_invalid` (1279 and 65521 fail; 1280/65520 pass), `address_conflict` (CIDR equals another desired iface's), `pbr_table_exhausted`; `validatePool` adds `pool_overflow`, `no_managed_interfaces`.

- [ ] **Step 2: implement.** Facts shape consumed by both validators:

```ts
export interface NetFacts {
  managed: Array<{ name: string; desired?: DesiredIfaceSpec; stanza?: NetplanStanza }>;
  duplicates: Record<string, string[]>;
  usedTableIds: Set<number>;
  desiredAddressByIface: Record<string, string[]>;
}
```

- [ ] **Step 3: gate + commit** (`feat(lib): S6 T3 — network validation (blockers, pool + PBR allocation)`).

---

### Task T4: NetHost seam + fake host

**Files:**
- Create: `xiNAS-MCP/src/agent/net/host.ts`
- Create: `xiNAS-MCP/src/agent/net/fake-host.ts`
- Test: `xiNAS-MCP/src/__tests__/agent/net/host.test.ts`

- [ ] **Step 1: failing tests.** Real host (recorded `runCommand`, the FsHost recorder pattern): exact argv goldens — `netplan generate`, `netplan apply`, `ip rule show`, `ip rule del from 10.10.1.1 lookup 100`, `ip route flush table 100`, `ip addr flush dev ibp65s0`, `ip -j addr show`, `rdma link show -j` (`''` resolved when the binary is missing — code 127 → `''`); `writeNetplanFile` atomic (tmp+rename — assert final content; injectable dir); `readNetplanDir` lists only `*.yaml`/`*.yml`. Fake host: `netplanApply()` re-derives `kernel` from the merged parse of `netplan_files` with ADD-ONLY addresses (a removed stanza's address SURVIVES apply until `ipAddrFlush`); flush verbs remove; `netplanGenerate()` rejects when any file contains `INVALID-NETPLAN` or fails YAML parse; `-fail` stem hooks (`netplanApply` when any file contains `APPLY-FAIL`; `ipAddrFlush('ibpX-fail')` rejects); every verb appends to `ops`.

- [ ] **Step 2: implement `host.ts`** (mirror `agent/fs/host.ts`: `RunCommand` injectable, `must()` wrapper, `unitDir`-style `netplanDir` option) and **`fake-host.ts`** (state file `net-host-state.json`:

```jsonc
{ "netplan_files": { "/etc/netplan/99-xinas.yaml": "..." },
  "kernel": { "addrs": { "ibp65s0": ["10.10.1.1/24"] },
              "rules": [{ "from": "10.10.1.1", "table": 100, "priority": 100 }],
              "tables": { "100": ["10.10.1.0/24 dev ibp65s0"] } },
  "sys_class_net": [{ "name": "ibp65s0", "driver": "mlx5_core" }],
  "rdma_links": [{ "ifname": "ibp65s0", "state": "ACTIVE", "physical_state": "LINK_UP" }],
  "ops": [] }
```

`ipAddrShow()` returns `ip -j`-shaped JSON built from `kernel.addrs` + `sys_class_net`; load/save per verb like `fake-host.ts` for fs). Export `makeUnimplementedNetHost()`.

- [ ] **Step 3: gate + commit** (`feat(agent): S6 T4 — NetHost seam + file-backed fake (kernel model, add-only netplan-apply quirk)`).

---

### Task T5: Observe enrichment + `NetworkConfig/default` singleton

**Files:**
- Modify: `xiNAS-MCP/src/agent/probe/network.ts` (enrichment deps), `xiNAS-MCP/src/agent/collectors/network.ts` (status passthrough + singleton emission), `xiNAS-MCP/src/agent/probe/fixture.ts` (passthroughs), `xiNAS-MCP/src/agent/convergence.ts` (wiring)
- Test: extend `src/__tests__/agent/probe/network.test.ts`, `src/__tests__/agent/collectors/network.test.ts`, `src/__tests__/agent/probe/fixture.test.ts`

- [ ] **Step 1: failing probe tests.** Injected enrich deps `{ readNetplanDir, listSysClassNet, rdmaLinkShow }`; snapshot rows gain `driver`, `rdma_capable` (driver contains `mlx`), `rdma_link_state` (`up` when the rdma json lists the ifname with LINK_UP, `unknown` when rdma output is `''`), `current_addresses` (CIDRs from the existing ip-json parse), `owning_netplan_file`, `duplicates_detected_in`, `netplan` stanza; each enrichment degrades independently (S5-T6 pattern — a throwing dep drops fields, never rows). Probe also exposes `netplanSummary()` returning `{files, world_config_hash, xinas_file_hash, duplicates}` for the collector.

- [ ] **Step 2: implement probe enrichment** (one `readNetplanDir` + `parseNetplanFiles` + `netplanHashes` call per sweep, shared across rows).

- [ ] **Step 3: failing collector tests.** `initialSweep` emits the per-iface upserts PLUS one `{kind: 'NetworkConfig', id: 'default', op: 'upsert', value: {kind, id, status: {...summary, observed_at}}}`; **compare-and-skip**: a second `_poll` with identical summary emits NO NetworkConfig delta; changing one file's text re-emits.

- [ ] **Step 4: implement collector** (cache `lastSummaryKey = JSON.stringify({world_config_hash, duplicates})` on the instance).

- [ ] **Step 5: fixture passthroughs.** `createFixtureNetworkProbe(dir?)` reads `netplan-files.json` (`Record<path, text>`), `sys-class-net.json`, `rdma-links.json`, runs the SAME parse/hash/enrich code; convergence passes `fdir`. Existing no-fixture behavior unchanged (empty maps).

- [ ] **Step 6: gate + commit** (`feat(agent): S6 T5 — network observe enrichment + NetworkConfig singleton (compare-and-skip)`).

---

### Task T6: `net.iface.update` provider + PATCH route + merged GET reads

**Files:**
- Create: `xiNAS-MCP/src/api/plan/providers/network.ts`
- Modify: `xiNAS-MCP/src/api/routes/network.ts` (merged GETs + PATCH), `xiNAS-MCP/src/api/app.ts` (stub-loop exclusion for PATCH `/network/interfaces/:id`), `xiNAS-MCP/src/api/tasks/build.ts` (register)
- Test: `xiNAS-MCP/src/__tests__/api/plan/network-provider.test.ts`, extend `src/__tests__/api/routes-network.test.ts` (or create)

- [ ] **Step 1: failing provider tests.** Seed observed NetworkInterfaces (2 managed w/ stanzas + 1 ethernet) + `NetworkConfig/default`; cases: (a) happy update → blockers `[]`, `lease_resources = [{NetworkConfig,99-xinas},{NetworkInterface,target},{NetworkInterface,other-adopted}]`, `affected_resources = [{kind:'NetworkInterface', id: target, revision: 0}]` (pre-adoption), `state_revision_expected === 0`, `desired_mutations` seed BOTH managed ifaces (adoption) with stanza-preserved `pbr_table_id`s + the target's overlay, enriched spec carries `{render, world_config_hash, surgical}` and the render parses back with both stanzas; (b) duplicates without cleanup → `duplicate_netplan_definition`; with `cleanup: true` → warning `netplan_cleanup_planned` + `cleanup_files` in enriched spec + diff; (c) post-adoption update pins `revision` = current desired row revision; (d) ethernet target → ApiException UNSUPPORTED `iface_not_managed`; unknown → NOT_FOUND; (e) `pbr_table_id` in the PATCH spec → UNSUPPORTED `net_identity_immutable` (provider-level; the route also pre-rejects).

- [ ] **Step 2: implement the provider** (`gatherNetFacts(ctx)` reads observed NetworkInterface + NetworkConfig + desired rows; allocation via T3; render via T2; `risk_level: 'changing_access'`, `rollback_model: 'non_disruptive'`).

- [ ] **Step 3: failing route tests.** Merged GET (`spec` + desired revision present only after a desired row exists); PATCH plan → 200 with blockers/warnings; apply (custom S4-style): `expected_revision` must echo `state_revision_expected`; **world-hash gate**: bump `NetworkConfig/default` (changed `world_config_hash`) between plan and apply → 412 `{reason: 'netplan_changed'}`; filtered preflight re-check (a duplicate appearing after plan blocks); 202 → `task.begin` spec carries the enriched render. PATCH `/network/interfaces/:id` leaves the stub loop.

- [ ] **Step 4: implement route + registrations.** Apply order: NOT_FOUND/UNSUPPORTED pre-checks → `expected_revision` echo check → re-run preflight (filter `dangerous_flag_required` only, per S4 §8) → world-hash compare → `taskEngine.apply` (per-resource pins do the desired-staleness work) → dispatch.

- [ ] **Step 5: gate + commit** (`feat(api): S6 T6 — net.iface.update provider + PATCH route + merged reads (adoption, singleton lease, world-hash gate)`).

---

### Task T7: `net.iface.update` executor

**Files:**
- Create: `xiNAS-MCP/src/agent/task/net-executor.ts`
- Modify: `xiNAS-MCP/src/agent/task/wiring.ts` (register; fixture-aware NetHost like FsHost)
- Test: `xiNAS-MCP/src/__tests__/agent/task/net-executor.test.ts`

- [ ] **Step 1: failing tests** against the fake NetHost. Happy path stage walk (`preflight → render_write → flush_target → apply → verify`): preflight re-hashes live files and REJECTS on `world_config_hash` mismatch with the enriched pin; stashes `{files}` into `ctx.stash`; `render_write` writes 99-xinas (ops show the atomic write), performs `cleanup_files` removals (foreign file rewritten without the iface key; removed stanza emitted via `emitOutput`), then `netplanGenerate`; generate failure (seed `INVALID-NETPLAN` foreign file edit post-plan... simpler: a `-fail` render hook is NOT possible — instead seed the fake so the WRITE makes generate fail via an `APPLY-FAIL`-free `INVALID-NETPLAN` injection in a foreign file) → stage throws BEFORE any flush; rollback restores the stashed files byte-identical + re-applies; `flush_target` ops are SURGICAL only (`ip rule del` for the target's table, `route flush table <id>`, `addr flush dev <target>` — and nothing for the other iface); `verify` re-reads `ipAddrShow` for the desired CIDR + `ipRuleShow` for the table; `netplanApply` `-fail` hook (`APPLY-FAIL` file content) → rollback restores files, re-generates, re-flushes the target, re-applies.

- [ ] **Step 2: implement** `makeNetIfaceUpdateExecutor({host})` narrowing the enriched spec `{id, desired, render, world_config_hash, cleanup_files, surgical: {addresses, pbr_table_id}}`.

- [ ] **Step 3: wiring** — build one NetHost per subsystem (`fdir ? createFakeNetHost(fdir) : createRealNetHost()`), register.

- [ ] **Step 4: gate + commit** (`feat(agent): S6 T7 — net.iface.update executor (live hash gate, surgical flush, file-restore rollback)`).

---

### Task T8: `net.pool.apply` provider + route + executor

**Files:**
- Modify: `xiNAS-MCP/src/api/plan/providers/network.ts` (+`netPoolApplyProvider`), `xiNAS-MCP/src/api/routes/network.ts` (+POST `/network/ip-pool`), `xiNAS-MCP/src/api/app.ts` (exclusion), `xiNAS-MCP/src/api/tasks/build.ts`, `xiNAS-MCP/src/agent/task/net-executor.ts` (+`makeNetPoolApplyExecutor`), `xiNAS-MCP/src/agent/task/wiring.ts`
- Test: extend the T6/T7 test files

- [ ] **Step 1: failing provider tests.** Mixed pool: iface A adopted earlier (desired rev 3, table 100), iface B fresh (rev 0, stanza table 105): plan pins `affected_resources = [{A, revision: 3}, {B, revision: 0}]` (sorted; primary first), addresses follow the day-1 formula, **A keeps table 100 and B keeps 105** (no reallocation); `pool_overflow` and `no_managed_interfaces` blockers; `state_revision_expected` = primary's pin.

- [ ] **Step 2: failing executor test.** GLOBAL flush ops: every table in 100–199 present in fake `kernel.rules` flushed, `addr flush` for EVERY mlx iface, then apply + verify all desired CIDRs live.

- [ ] **Step 3: implement both + route** (the route mirrors T6's apply pipeline; engine enforces the per-resource pins — add a route test where B's desired row was bumped post-plan and the apply 412s with the engine's stale envelope while A alone would have passed).

- [ ] **Step 4: gate + commit** (`feat(control-path): S6 T8 — net.pool.apply (addresses-only reallocation, per-resource pins, global flush)`).

---

### Task T9: Health checks

**Files:**
- Modify: `xiNAS-MCP/src/api/routes/health.ts`
- Test: `xiNAS-MCP/src/__tests__/api/routes-health.test.ts` (create or extend)

- [ ] **Step 1: failing tests.** With seeded KV: duplicates present → check `network.duplicate-netplan` `status: 'critical'`, `category: 'network'`, evidence = the duplicate map, remediation mentions `cleanup: true`, `overall: 'critical'`; no duplicates → check `ok`. RDMA: managed iface with `rdma_capable && rdma_link_state === 'up' && current_addresses.length > 0` → `ok`; any managed iface failing a leg → `degraded` with per-iface evidence; no managed ifaces → `skipped`. The stub `xinas-api.alive` check remains first.

- [ ] **Step 2: implement** — pure KV reads (`/xinas/v1/observed/NetworkInterface/`, `/xinas/v1/observed/NetworkConfig/default`); `overall` = worst status (`critical > degraded > warning > ok`; `skipped` ignored).

- [ ] **Step 3: gate + commit** (`feat(api): S6 T9 — first real health checks (duplicate-netplan critical, rdma-readiness)`).

---

### Task T10: e2e + full verification gate

**Files:**
- Create: `xiNAS-MCP/src/__tests__/e2e/network-adapter.test.ts` (clone the S5 e2e harness boot)

- [ ] **Step 1: seeds.** `netplan-files.json`: 99-xinas with `ibp65s0` (10.10.1.1/24, table 100) + `ibp9s0f0` (10.10.2.1/24, table 101); `50-cloud-init.yaml` defining `ibp65s0` AND the mgmt `eno1`. `sys-class-net.json`: two mlx + eno1 (`igb`). `rdma-links.json`: both LINK_UP. `net-host-state.json` mirroring files + kernel state.

- [ ] **Step 2: scenarios** (sequential, the spec §8 chain): (1) duplicate blocker + health `critical`; (2) `cleanup: true` update of `ibp65s0` to `10.10.5.1/24` → 202 → success; fake host: re-rendered file contains BOTH stanzas (adoption) with tables 100/101 intact, cleaned cloud-init (eno1 untouched in it), surgical flush ops only for `ibp65s0`, `generate` ordered before any flush; merged GET shows `spec` + revision; (3) identity 422 (`pbr_table_id`) + `iface_not_managed` (eno1) + NOT_FOUND (ghost); (4) `netplan_changed` 412 (rewrite `netplan-files.json`, wait one sweep poll — boot the agent with a short network poll env if needed, else re-trigger via the 30 s `pollIntervalMs` being too slow: write the fixture BEFORE planning the stale case instead: plan, mutate fixture, wait for the singleton's re-emit, apply → 412); (5) pool apply `{start: '10.10.1.1', prefix: 24}` → success; addresses re-allocated, tables UNCHANGED, global flush ops; health rdma-readiness `ok`; (6) rollback: seed `APPLY-FAIL` → task `failed`, files byte-identical to pre-task, desired rows reverted (merged GET shows pre-task spec — Model R proof through the real api).

- [ ] **Step 3: full gate.** From `xiNAS-MCP/`: `npm run build`, `npm test`, `npm run test:e2e`, `npm run test:contracts`, `npx tsc --noEmit`, `npm run lint` — all green (lint = warnings-only baseline).

- [ ] **Step 4: commit** (`test(e2e): S6 T10 — network adapter end-to-end (adoption, surgical flush, world-hash gate, pool, Model R rollback)`).

---

## Self-review notes (resolved inline)

- Spec coverage: every s6 spec §1 bullet maps to a task (T0…T10 one-to-one); the WS8 requirement set is covered by T6 (duplicate blocker + lockout hard-block), T8 (pool), T5/T9 (RDMA evidence + checks), T2 (99-xinas centralization).
- The e2e `netplan_changed` scenario depends on the singleton re-emitting after a fixture edit; the network collector polls at 30 s — boot the agent with the existing `pollIntervalMs` and structure the scenario to tolerate one sweep, or add `XINAS_AGENT_NETWORK_POLL_MS` (mirroring `XINAS_AGENT_XIRAID_POLL_MS`) in T5 if the wait proves flaky. T5 includes the env knob; the e2e uses it (`'500'`).
- Types used across tasks: `DesiredIfaceSpec` (T2) is consumed by T3 facts and T6 provider; `NetplanStanza`/`ParsedNetplan` (T2) by T5/T6; `NetHost` (T4) by T7/T8 — names locked as written.
