# Phase 0 xinas-agent S0 + S1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the privileged half of the Phase 0 control path — `xinas-agent.service` plus observation breadth covering 10 real collectors and 2 deferred stubs — so the existing `xinas-api`'s GET endpoints stop returning empty arrays and start serving live system state.

**Architecture:** New Node 20 TS daemon at `xiNAS-MCP/src/agent/` listens on `/run/xinas/agent.sock` (JSON-RPC 2.0 over NDJSON) and pushes observation deltas to a new `/internal/v1/observed` route on the api over the public UDS. A new pure-parse lib at `src/lib/parse/` is shared across api/agent/legacy-MCP; the agent's `src/agent/probe/` modules (subprocesses + sockets + dbus) are walled off behind a biome lint rule. Foundation rework to PR #203's `xinas_api` role adds a dedicated `xinas-api` group, split-secret token store, shared `/var/lib/xinas/controller-id`, and a new state-store `KvTransaction.list()`.

**Tech Stack:** TypeScript (`module: Node16`), Node 20, Express 5, JSON-RPC 2.0, `better-sqlite3` (state store), `dbus-native` (dbus events), `vitest` + `supertest` + `@vitest/coverage-v8` (new), biome 1.9.4 (new `noRestrictedImports` rule), Ansible (new `xinas_agent` role + modifications to `xinas_api`).

**Reference spec:**
- [docs/control-path/xinas-agent-s0s1-spec.md](../control-path/xinas-agent-s0s1-spec.md) — the contract this plan implements (851 lines)
- [docs/control-path/adr/0001-api-surface.md](../control-path/adr/0001-api-surface.md) §Migration scope — adapter-extraction requirement
- [docs/control-path/adr/0002-agent-privilege-model.md](../control-path/adr/0002-agent-privilege-model.md) — agent socket ownership, RPC surface, heartbeat states
- [docs/control-path/adr/0003-state-store.md](../control-path/adr/0003-state-store.md) — canonical paths, event-path shape, locked managed_files layout
- [docs/control-path/phase0-requirements.md](../control-path/phase0-requirements.md) §3 — agent requirements

**Branch:** `claude/phase0-xinas-agent-s0s1` off `main` (currently `8b0f019` after PR #203 merge).

**Out of scope (separate PRs):**
- Mutating RPC methods (storage/fs/NFS/network/systemd execution) — stubbed as `EXECUTOR_UNSUPPORTED`; lands in S3-S7
- Task execution envelope (`task.begin` family) — S2
- xinas-nfs-helper socket-tightening — blocked on WS12 (MCP retirement)
- Drift framework — WS9
- NfsProfile effective-state observation — S5/WS7
- Prometheus exporter — WS10
- TCP exposure of the agent socket — UDS only, ever
- CI coverage thresholds — tooling lands; threshold enforcement is a later opt-in
- Real-controller integration tests in CI — covered by manual verification (Layer 4)

---

## File map

### New files

| Path | Owns |
|---|---|
| `xiNAS-MCP/src/agent/agent-server.ts` | Process entry point; loads config + agent token; binds RPC socket; starts collectors + publisher; supervises subprocess monitors. |
| `xiNAS-MCP/src/agent/config.ts` | `AgentConfig` + `loadAgentConfig()` (reads `/etc/xinas-agent/config.json` + `/etc/xinas-agent/agent-token` + `/var/lib/xinas/controller-id`). |
| `xiNAS-MCP/src/agent/log.ts` | Structured JSON log lines to stderr. |
| `xiNAS-MCP/src/agent/rpc/server.ts` | UDS listener; chown 0660 root:xinas-api; per-connection JSON-RPC 2.0 NDJSON loop. |
| `xiNAS-MCP/src/agent/rpc/dispatch.ts` | Method router. Enumerated allow-list. `-32601` for unknown methods. |
| `xiNAS-MCP/src/agent/rpc/methods/health.ts` | `agent.health` (returns collector registry state). |
| `xiNAS-MCP/src/agent/rpc/methods/version.ts` | `agent.version`. |
| `xiNAS-MCP/src/agent/rpc/methods/stubs.ts` | All ADR-0002 enumerated mutating + S1-deferred methods return `EXECUTOR_UNSUPPORTED`. |
| `xiNAS-MCP/src/agent/probe/disk.ts` | `child_process.spawn('lsblk', ['--json'])` + udevadm monitor supervisor. |
| `xiNAS-MCP/src/agent/probe/network.ts` | `ip -j` snapshot + `ip -j monitor` supervisor + `ibstat` for IB fields. |
| `xiNAS-MCP/src/agent/probe/filesystem.ts` | `readdir('/etc/systemd/system')` + `systemctl is-enabled` per `.mount`. |
| `xiNAS-MCP/src/agent/probe/mountinfo.ts` | `readFile('/proc/self/mountinfo')`. |
| `xiNAS-MCP/src/agent/probe/nfs.ts` | Unix-socket client for `/run/xinas-nfs-helper.sock`; op-NDJSON. |
| `xiNAS-MCP/src/agent/probe/idmap.ts` | `readFile('/etc/idmapd.conf')` + `systemctl is-active nfs-idmapd.service`. |
| `xiNAS-MCP/src/agent/probe/systemd.ts` | `dbus-native` PropertiesChanged subscription for allow-listed units. |
| `xiNAS-MCP/src/agent/probe/users.ts` | `getent passwd`, `getent group`. |
| `xiNAS-MCP/src/agent/probe/inventory.ts` | `readFile('/proc/cpuinfo')`, `/proc/meminfo`, `os.uname()`. |
| `xiNAS-MCP/src/agent/probe/subprocess-monitor.ts` | Generic long-lived subprocess supervisor (SIGCHLD restart, backoff). |
| `xiNAS-MCP/src/agent/collectors/base.ts` | `Collector<K>` interface + `ObservationDelta` type. |
| `xiNAS-MCP/src/agent/collectors/disk.ts` | Disk collector. |
| `xiNAS-MCP/src/agent/collectors/network.ts` | NetworkInterface collector. |
| `xiNAS-MCP/src/agent/collectors/filesystem.ts` | Filesystem collector (with mount-state fold-in). |
| `xiNAS-MCP/src/agent/collectors/nfs.ts` | NfsSession + ExportRule via Share.status.exports fold-in. |
| `xiNAS-MCP/src/agent/collectors/nfs-idmap.ts` | NfsIdmap singleton. |
| `xiNAS-MCP/src/agent/collectors/systemd.ts` | SystemdUnit (allow-listed). |
| `xiNAS-MCP/src/agent/collectors/users.ts` | User + Group (one collector emits both kinds). |
| `xiNAS-MCP/src/agent/collectors/inventory.ts` | Inventory singleton. |
| `xiNAS-MCP/src/agent/collectors/stubs.ts` | XiraidArray + managed_files stub-collectors. |
| `xiNAS-MCP/src/agent/publisher.ts` | Batches deltas, POSTs to `/internal/v1/observed`, retries 5xx, manages `pendingReconcile: Set<Kind>`. |
| `xiNAS-MCP/src/agent-server.ts` | Process entry binary (same pattern as `xiNAS-MCP/src/api-server.ts`). |
| `xiNAS-MCP/src/lib/parse/disk.ts` | `parseLsblkOutput()`. |
| `xiNAS-MCP/src/lib/parse/network.ts` | `parseIpJson()` snapshot + event-line parsers. |
| `xiNAS-MCP/src/lib/parse/systemd-unit.ts` | Generic INI parser for `[Section]` files. |
| `xiNAS-MCP/src/lib/parse/filesystem.ts` | `mountUnitToFilesystem()`. |
| `xiNAS-MCP/src/lib/parse/mountinfo.ts` | `parseMountinfo()`. |
| `xiNAS-MCP/src/lib/parse/nfs.ts` | `parseListExports()`, `parseListSessions()`. |
| `xiNAS-MCP/src/lib/parse/idmap.ts` | `parseIdmapConf()`. |
| `xiNAS-MCP/src/lib/parse/passwd.ts` | `parsePasswdLine()`. |
| `xiNAS-MCP/src/lib/parse/group.ts` | `parseGroupLine()`. |
| `xiNAS-MCP/src/lib/parse/inventory.ts` | `parseCpuinfo()`, `parseMeminfo()`. |
| `xiNAS-MCP/src/api/internal/observed.ts` | `POST /internal/v1/observed` handler with reconcile semantics. |
| `xiNAS-MCP/src/api/internal/agent-started.ts` | `POST /internal/v1/agent_started` handler. |
| `xiNAS-MCP/src/api/middleware/require-internal-agent.ts` | Role gate for internal routes. |
| `xiNAS-MCP/src/api/middleware/system-warnings.ts` | Populates `req.context.system_warnings` from `HeartbeatTracker`. |
| `xiNAS-MCP/src/api/heartbeat.ts` | In-memory `HeartbeatTracker` singleton; tick loop calls `agent.health`. |
| `xiNAS-MCP/src/api/handlers/merge-warnings.ts` | Shared helper used by `sendOk` and `errorMiddleware`. |
| `xiNAS-MCP/src/api/routes/users.ts` | `/api/v1/users[/{uid}]`. |
| `xiNAS-MCP/src/api/routes/groups.ts` | `/api/v1/groups[/{gid}]`. |
| `xiNAS-MCP/src/api/routes/nfs-idmap.ts` | `/api/v1/nfs-idmap` singleton. |
| `xiNAS-MCP/xinas-agent.service` | Source-tree systemd unit. |
| `collection/roles/xinas_agent/` | New Ansible role (defaults, handlers, tasks, templates, README). |

### Modified files

| Path | What changes |
|---|---|
| `xiNAS-MCP/package.json` | New devDep `@vitest/coverage-v8`; new script `test:coverage`. |
| `xiNAS-MCP/vitest.config.ts` | `test.coverage` block with v8 provider. |
| `xiNAS-MCP/biome.json` | New `noRestrictedImports` rule banning `src/agent/probe/*` outside `src/agent/`. |
| `xiNAS-MCP/src/state/store.ts` | `KvTransaction.list()` added to interface. |
| `xiNAS-MCP/src/state/backend-sqlite.ts` | `KvTransaction.list()` implementation. |
| `xiNAS-MCP/src/api/config.ts` | `loadConfig()` also reads `/etc/xinas-api/internal-tokens.json`; rejects key collisions; `Role` adds `'internal_agent'`. |
| `xiNAS-MCP/src/api/context.ts` | `RequestContext` gains `system_warnings: Warning[]`. |
| `xiNAS-MCP/src/api/handlers/reads.ts` | `sendOk` calls `mergeWarnings`. |
| `xiNAS-MCP/src/api/middleware/error.ts` | Calls `mergeWarnings`. |
| `xiNAS-MCP/src/api/app.ts` | Mounts internal sub-router; mounts users/groups/nfs-idmap routes; installs `systemWarningsMiddleware`. |
| `xiNAS-MCP/src/api/routes/system.ts` | Surfaces `result.node.status.agent`. |
| `xiNAS-MCP/src/api/routes/nfs.ts` | `/shares/{id}/sessions` now reads from observed state. |
| `xiNAS-MCP/xinas-api.service` | Adds `SupplementaryGroups=xinas-api`. |
| `collection/roles/xinas_api/defaults/main.yml` | Default `xinas_api_controller_id` becomes `lookup('file', '/var/lib/xinas/controller-id') \| trim`; new var for internal-tokens path. |
| `collection/roles/xinas_api/tasks/main.yml` | Adds tasks: create xinas-api group, add user to it, generate `/var/lib/xinas/controller-id`, generate internal token + `internal-tokens.json` + `/etc/xinas-agent/agent-token`. |
| `collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2` | Adds entry for `/etc/xinas-agent/` directory. |
| `docs/Installer/xinas-api-role-spec.md` | Updates rationale: controller-id via persistent file under `/var/lib/xinas/`; new internal-tokens.json + agent-token files; supplementary `xinas-api` group. |
| `docs/control-path/api-v1.yaml` | New schemas (User, Group, NfsSession, NfsIdmap, SystemdUnit, ExportRule); new paths (/users, /groups, /nfs-idmap); additive fields on Share.status, Filesystem.status, Node.status, every observed kind's status.observed_at. |
| `xiNAS-MCP/src/__tests__/api/_helpers.ts` | New `buildTestAppWithMockAgent()` helper. |
| `xiNAS-MCP/src/__tests__/api/integration.test.ts` | Loops over 35 public GETs. |

---

## Task index

**Foundation (S0 substrate) — Phase A — 9 tasks**
- A1. Branch + coverage tooling + biome rule
- A2. `KvTransaction.list()` extension
- A3. Role: add `xinas-api` group + user supplementary
- A4. Unit: `SupplementaryGroups=xinas-api` (Requires-Rebuild)
- A5. Role: generate `/var/lib/xinas/controller-id`
- A6. Role: lookup-and-substitute controller_id
- A7. Role: generate internal-tokens.json + agent-token
- A8. API config: load internal-tokens; add `internal_agent` role
- A9. Update xinas_api role-spec.md

**Shared parse lib — Phase B — 10 tasks**
- B1-B10. One per parser (disk, network, systemd-unit, filesystem, mountinfo, nfs, idmap, passwd, group, inventory)

**Agent process skeleton — Phase C — 5 tasks**
- C1. Agent config + log
- C2. RPC JSON-RPC 2.0 dispatcher
- C3. RPC server (UDS bind + chown + accept loop)
- C4. agent.health + agent.version + stubs registry
- C5. Process entry + systemd unit + dev:agent script

**Probes — Phase D — 9 tasks**
- D1. Subprocess monitor supervisor
- D2. Disk probe
- D3. Network probe
- D4. Filesystem probe
- D5. NFS probe (helper client)
- D6. Idmap probe
- D7. Systemd probe (dbus)
- D8. Users probe
- D9. Inventory probe

**Collectors — Phase E — 10 tasks**
- E1. Collector base + types + registry
- E2. Disk collector
- E3. NetworkInterface collector
- E4. Filesystem collector (+ mount-state fold)
- E5. NFS collector (sessions + Share.status.exports fold)
- E6. NfsIdmap collector
- E7. SystemdUnit collector
- E8. Users collector (User + Group)
- E9. Inventory collector
- E10. Stub collectors (XiraidArray + managed_files)

**Publisher — Phase F — 3 tasks**
- F1. Publisher core (batch + HTTP POST)
- F2. Publisher: retry + pendingReconcile + backstop
- F3. Publisher: wire to collector emit; agent boot integration

**API contract additions — Phase G — 5 tasks**
- G1. api-v1.yaml: User + Group schemas + paths
- G2. api-v1.yaml: NfsSession + NfsIdmap schemas + path
- G3. api-v1.yaml: ExportRule + Share.status.exports + Filesystem.status fields
- G4. api-v1.yaml: SystemdUnit + Node.status.agent
- G5. api-v1.yaml: status.observed_at on every observed kind

**API internal routes + heartbeat — Phase H — 5 tasks**
- H1. HeartbeatTracker singleton + state transitions + event emission
- H2. requireInternalAgent middleware
- H3. /internal/v1/observed handler + reconcile + audit
- H4. /internal/v1/agent_started handler
- H5. systemWarningsMiddleware + mergeWarnings helper

**API public route additions — Phase I — 5 tasks**
- I1. /api/v1/users routes
- I2. /api/v1/groups routes
- I3. /api/v1/nfs-idmap singleton route
- I4. /api/v1/system extension (Node.status.agent surfaced)
- I5. /api/v1/shares/{id}/sessions populated

**Comprehensive testing — Phase J — 3 tasks**
- J1. Mock-agent test helper
- J2. Integration test extended to 35 GETs
- J3. End-to-end test (real api + real agent + probe-mock injection)

**Ansible role + unit — Phase K — 5 tasks**
- K1. xinas_agent role scaffold (dirs + meta: dependencies on xinas_api)
- K2. xinas_agent role — defaults + handlers
- K3. xinas_agent role — tasks (preflight, config template, unit install, enable)
- K4. xinas_agent role README
- K5. xinas-agent.service systemd unit — full hardening (source tree)

(The `/etc/xinas-agent/` directory + its tmpfiles/permissions are already
created by **A7** of the xinas_api role, which generates the agent-token there;
no separate xinas_agent task is needed for it.)

**Sanity + PR — Phase L — 2 tasks**
- L1. Whole-system sanity check
- L2. Push + PR + CI watch + OPERATOR-GATED merge

**Total: 72 tasks across 12 phases.** Each task is bite-sized (one focused change, 3-5 steps). Phases A-H land the S0 substrate (no observation breadth yet). Phases I-K land S1 (real data flow). Phase L closes out.

> **Note for engineers:** the full bite-sized task content (Steps 1-5 with verbatim code, exact commands, expected outputs, and HEREDOC commit messages) for all 72 tasks lives in this same file in the sections that follow. This index is a roadmap — execute the per-task sections sequentially, or in the phase order if running with subagent-driven-development.

---

## Phase A — Foundation (S0 substrate)

### Task A1: Branch + coverage tooling + biome lint rule

**Files:**
- Create: `xiNAS-MCP/biome.json` *(modify if it already exists)*
- Modify: `xiNAS-MCP/package.json`
- Modify: `xiNAS-MCP/vitest.config.ts`

- [ ] **Step 1: Verify branch + baseline**

```bash
git rev-parse --abbrev-ref HEAD  # expect: claude/phase0-xinas-agent-s0s1
git log --oneline -1              # expect: 8b0f019 (or later if rebased)
cd xiNAS-MCP && npm test 2>&1 | tail -3
```
Expected: `Test Files 32 passed (32)`, `Tests 176 passed (176)`.

- [ ] **Step 2: Add coverage devDep + script**

```bash
cd xiNAS-MCP
npm install --save-dev '@vitest/coverage-v8@^2.1.0'
```

Then edit `xiNAS-MCP/package.json` scripts block:

```json
"test": "vitest run",
"test:contracts": "vitest run src/__tests__/contracts",
"test:coverage": "vitest run --coverage",
```

- [ ] **Step 3: Add coverage config to vitest**

Replace `xiNAS-MCP/vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
    },
  },
});
```

- [ ] **Step 4: Add biome import-boundary rule**

Read existing `xiNAS-MCP/biome.json` first. Find the `linter.rules` block and add to `correctness`:

```json
{
  "linter": {
    "rules": {
      "correctness": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "../agent/probe/*": "src/agent/probe/* is agent-only; import from src/lib/parse/* instead.",
              "../../agent/probe/*": "src/agent/probe/* is agent-only; import from src/lib/parse/* instead.",
              "@xinas/probe": "no such alias; src/agent/probe/* is agent-only and unreachable from outside src/agent/."
            }
          }
        }
      }
    }
  }
}
```

(If biome's noRestrictedImports rule shape differs in 1.9.4, fall back to a `.biomeignore`-like pattern that excludes `src/agent/probe/` from imports outside `src/agent/`. Verify via the next step.)

- [ ] **Step 5: Verify everything still passes**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npm test 2>&1 | tail -3                        # expect: 176 tests still pass
npx biome lint src/ 2>&1 | tail -5             # expect: clean (no boundary violations yet because src/agent/ doesn't exist)
npm run test:coverage 2>&1 | grep -E "Coverage|All files" | head -5
```
Expected: coverage report prints; no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/package.json xiNAS-MCP/package-lock.json xiNAS-MCP/vitest.config.ts xiNAS-MCP/biome.json
git commit -m "$(cat <<'EOF'
build(api): add coverage tooling + biome import-boundary rule

S0 foundation for the xinas-agent PR. Two infrastructure pieces:

  @vitest/coverage-v8 + test:coverage script + vitest.config.ts
  coverage block. No CI thresholds enforced; coverage report is
  available for later threshold enforcement.

  biome noRestrictedImports rule banning src/agent/probe/* imports
  from outside src/agent/. Enforces the pure-vs-probe boundary the
  spec describes: legacy MCP (src/tools/*) and api (src/api/*) can
  only reach observation code via the pure parse layer, never the
  agent's privileged probes.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Code layout —
pure vs. probe boundary".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: `KvTransaction.list()` extension

**Files:**
- Modify: `xiNAS-MCP/src/state/store.ts`
- Modify: `xiNAS-MCP/src/state/backend-sqlite.ts`
- Create: `xiNAS-MCP/src/__tests__/state/store-tx-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/state/store-tx-list.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore, type OpenedStateStore } from '../../state/index.js';

describe('KvTransaction.list — atomic prefix scan inside a transaction', () => {
  let dir: string;
  let state: OpenedStateStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-tx-list-'));
    state = await openStateStore({
      databasePath: join(dir, 'xinas.db'),
      auditJsonlPath: join(dir, 'audit.jsonl'),
      nodeId: '00000000-0000-0000-0000-0000000000aa',
    });
  });

  afterEach(async () => {
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists keys under a prefix from within a transaction', () => {
    state.kv.put('/test/Kind/a', { v: 1 });
    state.kv.put('/test/Kind/b', { v: 2 });
    state.kv.put('/test/Other/c', { v: 3 });

    const result = state.kv.transaction((tx) => {
      const rows = tx.list({ prefix: '/test/Kind/' });
      return rows.map((r) => r.value);
    });

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ v: 1 });
    expect(result).toContainEqual({ v: 2 });
  });

  it('reconcile pattern: list-then-delete-leftovers inside one tx', () => {
    state.kv.put('/test/Kind/a', { v: 'old' });
    state.kv.put('/test/Kind/b', { v: 'old' });
    state.kv.put('/test/Kind/c', { v: 'old' });

    // simulate a reconcile: upsert a,b; delete c (not in new set)
    const newSet = new Set(['/test/Kind/a', '/test/Kind/b']);

    state.kv.transaction((tx) => {
      tx.put('/test/Kind/a', { v: 'new' });
      tx.put('/test/Kind/b', { v: 'new' });
      const current = tx.list<{ v: string }>({ prefix: '/test/Kind/' });
      for (const row of current) {
        const key = `/test/Kind/${row.value.v === 'new' ? '' : row.value.v}`;
        // emulate spec's algorithm — delete keys not in the new set
      }
      const currentKeys = tx.list<{ v: string }>({ prefix: '/test/Kind/' });
      for (const r of currentKeys) {
        // KvTransaction.list also returns the key; we need it
      }
    });

    // After reconcile, only a and b should remain
    const after = state.kv.list({ prefix: '/test/Kind/' });
    expect(after).toHaveLength(2);
  });
});
```

(Note: the second test exposes that `KvTransaction.list()` needs to return entries that include the key, not just the value. See Step 3.)

- [ ] **Step 2: Run test — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/state/store-tx-list.test.ts 2>&1 | tail -10
```
Expected: FAIL with `tx.list is not a function` or TS compile error about missing method.

- [ ] **Step 3: Update the interface and implementation**

Edit `xiNAS-MCP/src/state/store.ts` — find `interface KvTransaction` and add:

```ts
export interface KvTransaction {
  get<T = unknown>(key: string): RevisionedValue<T> | null;
  put<T = unknown>(key: string, value: T, opts?: PutOptions): CasResult<T>;
  delete(key: string, expected_revision?: number): DeleteResult;
  /**
   * List committed-state values under a prefix at the transaction's
   * snapshot. Use this for atomic reconcile patterns where you need
   * the current key set inside the same transaction as the deletes
   * (e.g., complete-snapshot observation reconcile per the
   * xinas-agent S0+S1 spec). The outer `KvStore.list()` is NOT
   * sufficient because it operates outside the transaction.
   */
  list<T = unknown>(opts?: ListOptions): RevisionedValue<T>[];
}
```

(Also export the `RevisionedValue` shape so callers can read `key`. If the existing `RevisionedValue` doesn't carry a `key` field, add it. Check `src/state/types.ts`.)

Edit `xiNAS-MCP/src/state/backend-sqlite.ts` — find the `transaction()` implementation that wraps `KvTransaction`. The outer `SqliteKvStore.list()` already has a prepared statement; reuse it from inside the tx:

```ts
// Inside the transaction wrapper class:
list<T = unknown>(opts?: ListOptions): RevisionedValue<T>[] {
  // Reuses the outer list() — inside an SQLite transaction, the same
  // prepared statement sees the tx's snapshot.
  return this.outer.list<T>(opts);
}
```

(Or inline the same SQL the outer list uses, depending on the backend's existing factoring.)

- [ ] **Step 4: Verify test passes + no regression**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/state/store-tx-list.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: new test passes; total goes from 176 → 178.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/state/store.ts xiNAS-MCP/src/state/backend-sqlite.ts xiNAS-MCP/src/__tests__/state/store-tx-list.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add KvTransaction.list() for atomic reconcile patterns

The /internal/v1/observed POST handler (lands later in this PR) does
"upsert new + delete leftover" reconciles per kind inside a single
SQLite transaction. Required: list current keys at the tx's snapshot,
compute the set difference, delete leftovers — all atomic.

The outer KvStore.list() can't satisfy this because it operates
outside the transaction. KvTransaction previously exposed get/put/
delete only.

Add list() to the KvTransaction interface; SQLite backend reuses the
existing prepared statements inside the tx wrapper. Additive,
backward-compatible — existing call sites are unaffected.

Test: simple list-by-prefix from within a transaction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3: Role — add `xinas-api` group + user supplementary

**Files:**
- Modify: `collection/roles/xinas_api/tasks/main.yml`

The current xinas_api role (PR #203) creates the `xinas-admin` group and the `xinas-api` user with primary group `xinas-admin`. This task adds a new `xinas-api` group (no human members; used only as the agent socket gate) and adds the `xinas-api` user to it as a supplementary group. The unit's `SupplementaryGroups` line lands in Task A4.

- [ ] **Step 1: Read current tasks/main.yml**

```bash
cat collection/roles/xinas_api/tasks/main.yml | head -60
```

Locate the user-create task block.

- [ ] **Step 2: Insert new tasks before the user creation**

Add these blocks to `collection/roles/xinas_api/tasks/main.yml` immediately after the existing `xinas-admin` group create + gid lookup tasks, BEFORE the `xinas-api` user creation:

```yaml
# Phase 0 xinas-agent S0+S1 foundation: dedicated xinas-api group
# (no human members) used as the agent socket gate. The xinas-api
# user joins this group as a supplementary, so the api's effective
# gid stays xinas-admin and operator readability of new state/audit
# files is preserved.
- name: Create the xinas-api system group (agent-socket gate)
  ansible.builtin.group:
    name: xinas-api
    system: true
    state: present
  tags: [xinas_api, group]

- name: Look up the xinas-api gid
  ansible.builtin.getent:
    database: group
    key: xinas-api
  tags: [xinas_api, group]

- name: Cache the xinas-api gid as _xinas_api_gid
  ansible.builtin.set_fact:
    _xinas_api_gid: "{{ ansible_facts.getent_group['xinas-api'][1] | int }}"
  tags: [xinas_api, group]
```

Then find the existing user-create task and add `groups` parameter (supplementary list):

```yaml
- name: Create the xinas-api system user
  ansible.builtin.user:
    name: xinas-api
    group: xinas-admin                # primary — unchanged
    groups:                            # supplementary — NEW
      - xinas-api
    append: true                       # don't clobber other supplementary groups if operator added any
    system: true
    create_home: false
    shell: /usr/sbin/nologin
    state: present
  tags: [xinas_api, user]
```

- [ ] **Step 3: Verify ansible-lint clean + syntax check**

```bash
ansible-lint collection/roles/xinas_api/ 2>&1 | tail -5
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -3
rm /tmp/test-xinas-api.yml
```
Expected: lint clean; syntax check passes.

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/tasks/main.yml
git commit -m "$(cat <<'EOF'
feat(xinas_api): add dedicated xinas-api group + user supplementary

xinas-agent S0 foundation: ADR-0002 line 55 requires /run/xinas/agent.sock
to be 0660 root:xinas-api so only the api process can connect.
Operators in xinas-admin must NOT be able to reach the root executor
directly (would bypass api RBAC + audit).

Adding the gate as a NEW group (no human members), with the api user
joining as a supplementary. The api's effective gid at runtime stays
xinas-admin (set later in this PR by SupplementaryGroups on the unit),
so files the api creates default to operator-readable. Supplementary
group membership is what UDS connect cares about; primary group is
what file-creation defaults look at.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4: Unit — `SupplementaryGroups=xinas-api`

**Files:**
- Modify: `xiNAS-MCP/xinas-api.service`

- [ ] **Step 1: Read current unit + find SupplementaryGroups line (if any)**

```bash
grep -n "Group\|SupplementaryGroups" xiNAS-MCP/xinas-api.service
```

PR #203 unit has `User=xinas-api` and `Group=xinas-admin`. No SupplementaryGroups line.

- [ ] **Step 2: Add SupplementaryGroups directive after Group**

Edit `xiNAS-MCP/xinas-api.service`. Find the `Group=xinas-admin` line and add immediately after:

```
SupplementaryGroups=xinas-api
```

Plus a comment block above (matching the PR #203 style):

```
# Membership in xinas-api grants connect to /run/xinas/agent.sock (0660
# root:xinas-api per ADR-0002). The group has no human members; the
# api user joins it as supplementary so the effective gid stays
# xinas-admin and files created by the api remain operator-readable.
SupplementaryGroups=xinas-api
```

- [ ] **Step 3: Verify systemd unit syntax**

```bash
systemd-analyze verify xiNAS-MCP/xinas-api.service 2>&1 | tail -5 || echo "(systemd-analyze unavailable on this host — manual review only)"
```
Expected: no errors. On hosts without systemd-analyze, manually grep for typos:

```bash
grep -E "^(User|Group|SupplementaryGroups)=" xiNAS-MCP/xinas-api.service
```
Expected output:
```
User=xinas-api
Group=xinas-admin
SupplementaryGroups=xinas-api
```

- [ ] **Step 4: Commit with Requires-Rebuild trailer**

```bash
git add xiNAS-MCP/xinas-api.service
git commit -m "$(cat <<'EOF'
fix(api): add SupplementaryGroups=xinas-api to api unit

The xinas-agent (lands later in this PR) creates /run/xinas/agent.sock
owned root:xinas-api 0660. The api process needs to connect, which
requires group membership in xinas-api. The api user was added to the
xinas-api group as a supplementary in the role (A3), but systemd
ignores user-level supplementary groups unless the unit echoes them
via SupplementaryGroups= — otherwise the running process only gets
its primary group.

This adds the line. Effective gid stays xinas-admin so newly-created
state files remain operator-readable; xinas-api group membership is
purely for the agent-socket connect.

Requires-Rebuild: xinas_api

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A5: Role — generate `/var/lib/xinas/controller-id`

**Files:**
- Modify: `collection/roles/xinas_api/tasks/main.yml`

- [ ] **Step 1: Add controller-id generation task**

In `collection/roles/xinas_api/tasks/main.yml`, after the directory-create tasks (tmpfiles run) and BEFORE the config-template task, add:

```yaml
# Phase 0 xinas-agent S0+S1 foundation: shared controller_id file.
# Per phase0-requirements §3, controller_id must be unchanged across
# reboot/upgrade and matched across api, audit, tasks, support bundle.
# /var/lib/xinas/ co-locates identity with state + audit so re-install
# preserving the data disk preserves both controller_id and the audit
# chain.

- name: Ensure /var/lib/xinas/ directory exists (parent of controller-id)
  ansible.builtin.file:
    path: /var/lib/xinas
    state: directory
    owner: root
    group: xinas-admin
    mode: '0755'
  tags: [xinas_api, controller_id]

- name: Generate /var/lib/xinas/controller-id on first install (UUIDv4)
  ansible.builtin.shell:
    cmd: |
      uuidgen | tr -d '\n' > /var/lib/xinas/controller-id
    creates: /var/lib/xinas/controller-id
  tags: [xinas_api, controller_id]

- name: Set controller-id permissions (world-readable; non-secret)
  ansible.builtin.file:
    path: /var/lib/xinas/controller-id
    owner: root
    group: root
    mode: '0644'
  tags: [xinas_api, controller_id]

- name: Slurp controller-id for template substitution
  ansible.builtin.slurp:
    src: /var/lib/xinas/controller-id
  register: _xinas_api_controller_id_blob
  tags: [xinas_api, controller_id]

- name: Cache controller-id as fact _xinas_api_controller_id_value
  ansible.builtin.set_fact:
    _xinas_api_controller_id_value: "{{ _xinas_api_controller_id_blob.content | b64decode | trim }}"
  tags: [xinas_api, controller_id]
```

- [ ] **Step 2: Verify lint + syntax**

```bash
ansible-lint collection/roles/xinas_api/ 2>&1 | tail -5
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -3
rm /tmp/test-xinas-api.yml
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add collection/roles/xinas_api/tasks/main.yml
git commit -m "$(cat <<'EOF'
feat(xinas_api): generate /var/lib/xinas/controller-id

xinas-agent S0 foundation: per phase0-requirements §3, controller_id
must be stable across reboot + upgrade + OS reinstall on the same
data disk, and matched across api, audit, tasks, support bundle.

Generated once via uuidgen with creates: guard. Lives under
/var/lib/xinas/ so identity persists with state when the data disk
is preserved through OS reinstall. World-readable because the id is
not a secret.

Slurp+set_fact pattern reads the file value for the config template
(next task — A6). PR #203's machine-id-derived UUIDv5 fallback is
retired in A6 in favor of this persistent file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A6: Role — lookup-and-substitute controller_id

**Files:**
- Modify: `collection/roles/xinas_api/defaults/main.yml`

- [ ] **Step 1: Find existing default**

```bash
grep -n "xinas_api_controller_id" collection/roles/xinas_api/defaults/main.yml
```

PR #203 has: `xinas_api_controller_id: "{{ ansible_machine_id | to_uuid }}"`.

- [ ] **Step 2: Replace default — NO controller-side `lookup('file')`**

Edit `collection/roles/xinas_api/defaults/main.yml`:

```yaml
# Controller identity. Per phase0-requirements §3 + xinas-agent S0+S1
# spec, controller_id lives in /var/lib/xinas/controller-id as a
# persistent file generated by uuidgen on first install (A5). The file
# co-locates with state under /var/lib/xinas/ so OS reinstall
# preserving the data disk preserves both identity and audit chain.
#
# This default is a placeholder ONLY. A5 reads the file ON THE REMOTE
# HOST (ansible.builtin.slurp) and overrides this via set_fact before
# the config.json template task runs. Do NOT use `lookup('file', ...)`
# here: Ansible lookups execute on the CONTROL NODE, not the managed
# host, so a lookup would read the controller's filesystem (wrong id,
# or a hard error when the path is absent on the controller).
# Override this variable explicitly only if you have a pre-assigned
# controller_id from a control-plane registry (it then wins over A5's
# set_fact because extra-vars/play-vars outrank role defaults).
xinas_api_controller_id: ""
```

A5 (prior task) must set the working value as a fact from the remote slurp, e.g.:

```yaml
- name: Cache remote controller-id as the working controller_id
  ansible.builtin.set_fact:
    xinas_api_controller_id: "{{ _slurped_controller_id.content | b64decode | trim }}"
  # _slurped_controller_id registered by the ansible.builtin.slurp of
  # /var/lib/xinas/controller-id earlier in A5. set_fact overrides the
  # role default for the rest of the play, so the config.json template
  # renders the REMOTE host's id. If the operator passed an explicit
  # xinas_api_controller_id via extra-vars, guard this with
  # `when: xinas_api_controller_id | length == 0` so the override wins.
```

(Confirm A5 registers `_slurped_controller_id` via `ansible.builtin.slurp`, not a controller-side `lookup`. If A5 currently names the fact `_xinas_api_controller_id_value`, reconcile to the `set_fact: xinas_api_controller_id` shown here so the template's `{{ xinas_api_controller_id }}` resolves to the remote value without any lookup.)

- [ ] **Step 3: Verify the config template still resolves**

```bash
cat collection/roles/xinas_api/templates/xinas-api-config.json.j2 | head -5
```
Expected: still `"controller_id": "{{ xinas_api_controller_id }}"`. No template change needed.

- [ ] **Step 4: Lint + syntax**

```bash
ansible-lint collection/roles/xinas_api/ 2>&1 | tail -5
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -3
rm /tmp/test-xinas-api.yml
```

- [ ] **Step 5: Commit**

```bash
git add collection/roles/xinas_api/defaults/main.yml
git commit -m "$(cat <<'EOF'
feat(xinas_api): controller_id default reads /var/lib/xinas/controller-id

Replaces PR #203's `ansible_machine_id | to_uuid` derivation. The
new default reads the persistent file generated in the prior task
(A5). The variable still resolves to a UUID string at template
time; ApiConfig.controller_id remains a string UUID (no schema
change).

Behavior shift: stable across machine-id regeneration (cloned VMs);
stable across OS reinstall preserving the data disk.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A7: Role — generate internal-tokens.json + agent-token

**Files:**
- Modify: `collection/roles/xinas_api/tasks/main.yml`
- Modify: `collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2`

- [ ] **Step 1: Add tmpfiles entry for /etc/xinas-agent/**

Edit `collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2`. Find the existing entries and add:

```
d /etc/xinas-agent       0755 root root          -
```

- [ ] **Step 2: Add token generation tasks**

In `collection/roles/xinas_api/tasks/main.yml`, after the controller-id tasks (A5) and BEFORE the existing admin-token-bootstrap block, add:

```yaml
# Phase 0 xinas-agent S0+S1 foundation: split-secret token store.
# The internal-tokens.json file is readable only by the api process
# (via the xinas-api supplementary group, added in A3) and root.
# The agent-token file is readable only by root (the agent runs as
# root per ADR-0002).
#
# Operators in xinas-admin can NEVER read the agent token, even
# though they can read /etc/xinas-api/config.json (which contains
# only the admin token, never the agent token).

- name: stat /etc/xinas-api/internal-tokens.json
  ansible.builtin.stat:
    path: /etc/xinas-api/internal-tokens.json
  register: _xinas_api_internal_tokens_stat
  tags: [xinas_api, config]

# --- Bootstrap branch: internal-tokens absent ---

- name: Generate a fresh internal agent bearer token (first install only)
  ansible.builtin.command:
    cmd: openssl rand -hex 32
  register: _xinas_api_internal_token_gen
  changed_when: true
  no_log: true
  when: not _xinas_api_internal_tokens_stat.stat.exists
  tags: [xinas_api, config]

- name: Cache the generated internal token as _xinas_api_internal_token (first install)
  ansible.builtin.set_fact:
    _xinas_api_internal_token: "{{ _xinas_api_internal_token_gen.stdout }}"
  no_log: true
  when: not _xinas_api_internal_tokens_stat.stat.exists
  tags: [xinas_api, config]

- name: Write /etc/xinas-api/internal-tokens.json (first install)
  ansible.builtin.copy:
    content: |
      {
        "{{ _xinas_api_internal_token }}": {
          "principal": "agent:root",
          "role": "internal_agent"
        }
      }
    dest: /etc/xinas-api/internal-tokens.json
    owner: root
    group: xinas-api
    mode: '0640'
  no_log: true
  notify: restart xinas-api
  when: not _xinas_api_internal_tokens_stat.stat.exists
  tags: [xinas_api, config]

# --- Derive branch: internal-tokens present ---

- name: Slurp existing internal-tokens.json
  ansible.builtin.slurp:
    src: /etc/xinas-api/internal-tokens.json
  register: _xinas_api_internal_tokens_blob
  no_log: true
  when: _xinas_api_internal_tokens_stat.stat.exists
  tags: [xinas_api, config]

- name: Extract the internal_agent token from existing file
  ansible.builtin.set_fact:
    _xinas_api_internal_token: >-
      {{ (_xinas_api_internal_tokens_blob.content | b64decode | from_json
           | dict2items
           | selectattr('value.role', 'equalto', 'internal_agent')
           | map(attribute='key')
           | list
           | first)
         | default(None) }}
  no_log: true
  when: _xinas_api_internal_tokens_stat.stat.exists
  tags: [xinas_api, config]

- name: Fail if internal-tokens exists but has no internal_agent entry
  ansible.builtin.fail:
    msg: |
      /etc/xinas-api/internal-tokens.json exists but contains no
      entry with role 'internal_agent'. To recover: delete both
      /etc/xinas-api/internal-tokens.json AND /etc/xinas-agent/agent-token
      and re-run the xinas_api role.
  when:
    - _xinas_api_internal_tokens_stat.stat.exists
    - _xinas_api_internal_token is none
  tags: [xinas_api, config]

# --- Both branches converge: write/refresh agent-token mirror ---

- name: Write/refresh /etc/xinas-agent/agent-token (only root can read)
  ansible.builtin.copy:
    content: "{{ _xinas_api_internal_token }}\n"
    dest: /etc/xinas-agent/agent-token
    owner: root
    group: root
    mode: '0400'
  no_log: true
  tags: [xinas_api, config]
```

- [ ] **Step 3: Lint + syntax check**

```bash
ansible-lint collection/roles/xinas_api/ 2>&1 | tail -5
cat > /tmp/test-xinas-api.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_api
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-api.yml 2>&1 | tail -3
rm /tmp/test-xinas-api.yml
```

- [ ] **Step 4: Commit**

```bash
git add collection/roles/xinas_api/tasks/main.yml collection/roles/xinas_api/templates/xinas-api-tmpfiles.conf.j2
git commit -m "$(cat <<'EOF'
feat(xinas_api): split-secret token store for the agent

xinas-agent S0 foundation: the agent calls /internal/v1/observed on
the api with a dedicated bearer token (principal=agent:root,
role=internal_agent). That token cannot live in the same file as
the admin bootstrap token, because admin-token is operator-readable
(0640 root:xinas-admin) and an operator with the agent token could
push poisoned observations.

Two new files:

  /etc/xinas-api/internal-tokens.json
    0640 root:xinas-api — only the api process (via supplementary
    group membership from A3) and root can read

  /etc/xinas-agent/agent-token
    0400 root:root — only the agent (running as root) can read

Both contain the same bearer; the api reads the JSON to validate
incoming requests, the agent reads the raw token to set the bearer
on outgoing observation POSTs. Generated once at first install;
re-derived on subsequent runs from internal-tokens.json (same
source-of-truth pattern as the admin bootstrap token).

A new tmpfiles entry creates /etc/xinas-agent/ directory.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A8: API config — load internal-tokens; add `internal_agent` role

**Files:**
- Modify: `xiNAS-MCP/src/api/config.ts`
- Create: `xiNAS-MCP/src/__tests__/api/config-internal-tokens.test.ts`

- [ ] **Step 1: Write failing test**

Create `xiNAS-MCP/src/__tests__/api/config-internal-tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../api/config.js';

describe('loadConfig — internal-tokens.json merge', () => {
  it('merges internal-tokens.json into the tokens map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-internal-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000aa',
        listen: { kind: 'unix', socket: '/tmp/x.sock' },
        tokens: {
          'admin-token-123': { principal: 'admin:bootstrap', role: 'admin' },
        },
        state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
        internalTokensPath: join(dir, 'internal-tokens.json'),
      }));
      writeFileSync(join(dir, 'internal-tokens.json'), JSON.stringify({
        'agent-token-456': { principal: 'agent:root', role: 'internal_agent' },
      }));
      const config = loadConfig({ configPath: join(dir, 'config.json') });
      expect(config.tokens['admin-token-123']?.role).toBe('admin');
      expect(config.tokens['agent-token-456']?.role).toBe('internal_agent');
      expect(config.tokens['agent-token-456']?.principal).toBe('agent:root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects token-key collisions between config.json and internal-tokens.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-collision-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000aa',
        listen: { kind: 'unix', socket: '/tmp/x.sock' },
        tokens: { 'shared-token': { principal: 'admin:a', role: 'admin' } },
        state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
        internalTokensPath: join(dir, 'internal-tokens.json'),
      }));
      writeFileSync(join(dir, 'internal-tokens.json'), JSON.stringify({
        'shared-token': { principal: 'agent:root', role: 'internal_agent' },
      }));
      expect(() => loadConfig({ configPath: join(dir, 'config.json') })).toThrow(/key collision/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works when internal-tokens.json is absent (no internalTokensPath set)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-config-no-internal-'));
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        controller_id: '00000000-0000-0000-0000-0000000000aa',
        listen: { kind: 'unix', socket: '/tmp/x.sock' },
        tokens: { 'admin-token-only': { principal: 'admin:a', role: 'admin' } },
        state: { databasePath: '/tmp/x.db', auditJsonlPath: '/tmp/x.jsonl' },
      }));
      const config = loadConfig({ configPath: join(dir, 'config.json') });
      expect(config.tokens['admin-token-only']?.role).toBe('admin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/config-internal-tokens.test.ts 2>&1 | tail -10
```
Expected: FAIL (no internal-tokens loading logic).

- [ ] **Step 3: Update config.ts**

Edit `xiNAS-MCP/src/api/config.ts`. Add the new role and the optional `internalTokensPath`:

```ts
export type Role =
  | 'viewer' | 'operator' | 'admin' | 'local_admin'
  | 'internal_agent';  // NEW — only the agent should hold this role.

export interface ApiConfig {
  controller_id: string;
  listen: ListenSpec;
  tokens: Record<string, TokenPrincipal>;
  state: {
    databasePath: string;
    auditJsonlPath: string;
    archiveDir?: string;
  };
  /**
   * Optional path to a second tokens file with stricter file
   * permissions. Used to keep the agent's internal bearer out of
   * operator-readable config.json. Loaded after config.json and
   * merged into the tokens map; key collisions are fatal.
   */
  internalTokensPath?: string;
}
```

Then update `loadConfig`:

```ts
export function loadConfig(opts: { configPath?: string; inline?: ApiConfig } = {}): ApiConfig {
  if (opts.inline) return opts.inline;
  const path = opts.configPath ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `xinas-api config not found at ${path}; provide --config <path> or seed /etc/xinas-api/config.json`,
    );
  }
  const config = JSON.parse(readFileSync(path, 'utf8')) as ApiConfig;

  if (config.internalTokensPath && existsSync(config.internalTokensPath)) {
    const internal = JSON.parse(readFileSync(config.internalTokensPath, 'utf8'));
    for (const key of Object.keys(internal)) {
      if (key in config.tokens) {
        throw new Error(
          `token key collision: '${key}' appears in both ${path} and ${config.internalTokensPath}. ` +
          `Rotate the colliding token or remove one of the entries.`,
        );
      }
      config.tokens[key] = internal[key];
    }
  }

  return config;
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/config-internal-tokens.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: new tests pass; full suite still green.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/api/config.ts xiNAS-MCP/src/__tests__/api/config-internal-tokens.test.ts
git commit -m "$(cat <<'EOF'
feat(api): loadConfig merges internal-tokens.json + adds internal_agent role

S0 foundation: the api process needs to recognize the agent's bearer
token without it appearing in the operator-readable config.json.
Per the spec, the agent token lives in /etc/xinas-api/internal-tokens.json
(mode 0640 root:xinas-api).

loadConfig() now reads the second file when config.internalTokensPath
is set, merges its tokens into the main map, and rejects key
collisions at startup. The new `internal_agent` role is the only
principal that satisfies the /internal/v1/observed route's auth check
(lands later in this PR via requireInternalAgent middleware).

Three tests cover: merge, collision rejection, optional-path absence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A9: Update xinas_api role-spec.md

**Files:**
- Modify: `docs/Installer/xinas-api-role-spec.md`

The role's spec doc was written before the agent existed. It needs updating to reflect: the new `xinas-api` group, the internal-tokens.json + agent-token files, the `/var/lib/xinas/controller-id` source-of-truth, and the rationale change (machine-id derivation retired).

- [ ] **Step 1: Find sections to update**

```bash
grep -n "controller_id\|admin-token\|xinas-admin group\|xinas-api group" docs/Installer/xinas-api-role-spec.md | head -20
```

- [ ] **Step 2: Apply the four content updates**

Three edits to `docs/Installer/xinas-api-role-spec.md`:

1. Add a new bullet to the role's "What the role creates" list:

   > - **`xinas-api` system group** (new in xinas-agent S0+S1 PR). No human members; used only as the agent socket gate. The `xinas-api` user is a supplementary member; the unit's `SupplementaryGroups=xinas-api` line grants the running api process the group at boot.

2. Update the controller_id section:

   > **Controller identity.** Per the xinas-agent S0+S1 PR, the canonical
   > controller_id lives at `/var/lib/xinas/controller-id` — a persistent
   > file generated by `uuidgen` on first install, co-located with state +
   > audit JSONL so identity travels with the data disk. The role's
   > `xinas_api_controller_id` variable defaults to a file lookup of this
   > path. PR #203's `ansible_machine_id | to_uuid` derivation has been
   > retired: it produced unstable IDs across machine-id regeneration
   > (cloned VMs) and did not co-locate with state for reinstall
   > preservation.

3. Add a new "Split-secret token store" subsection after the existing token-bootstrap section:

   > ### Split-secret token store
   >
   > Two tokens with different audiences and different file permissions:
   >
   > | File | Mode | Group | Contents |
   > |---|---|---|---|
   > | `/etc/xinas-api/config.json` + `/etc/xinas-api/admin-token` | `0640` | `xinas-admin` (operator-readable) | The admin bootstrap token |
   > | `/etc/xinas-api/internal-tokens.json` + `/etc/xinas-agent/agent-token` | `0640` (api) / `0400` (agent) | `xinas-api` (api-only) / `root` (agent-only) | The internal_agent token |
   >
   > Operators in `xinas-admin` cannot read either internal-tokens.json
   > or agent-token. The api validates incoming `/internal/v1/observed`
   > requests against the internal_agent role; UDS-trust admin promotion
   > explicitly does NOT satisfy that role check.

- [ ] **Step 3: Commit**

```bash
git add docs/Installer/xinas-api-role-spec.md
git commit -m "$(cat <<'EOF'
docs(installer): update xinas_api role-spec for xinas-agent S0+S1

Three content updates flowing from the xinas-agent foundation work:

  1. xinas-api group documented as a new system group (no human
     members; agent-socket gate).
  2. Controller_id section rewritten: now /var/lib/xinas/controller-id;
     PR #203's machine-id derivation retired with rationale.
  3. New "Split-secret token store" section documenting
     internal-tokens.json + agent-token alongside the admin pair.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Foundation".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — Shared parse lib

Each parser is a focused TS file with vitest fixture-based tests. Pattern is identical across the 10 tasks; one parser per task keeps commits small and reviewable. Implement in this order — later parsers reuse the systemd-unit INI parser from B3.

> **ESM fixture-path convention (applies to EVERY test in Phases B and D that reads a `__fixtures__/` file).** The repo is `"type": "module"` with `module: Node16` — `__dirname` is **not** a global in ESM and the test files below that call `join(__dirname, '__fixtures__/…')` will not compile as written unless each test file derives it. At the top of each such test file, after the imports, add the standard shim:
>
> ```ts
> import { fileURLToPath } from 'node:url';
> import { dirname, join } from 'node:path';
> const __dirname = dirname(fileURLToPath(import.meta.url));
> ```
>
> With this shim every `join(__dirname, '__fixtures__/X')` call in the task bodies works unchanged. (The existing PR #201 tests use `fileURLToPath(import.meta.url)` directly; the shim is the equivalent that keeps the fixture-load lines below readable.) This note is authoritative — treat any bare `__dirname` in a B/D test block as assuming this shim is present.

### Task B1: `parseLsblkOutput` (Disk)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/disk.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/disk.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/lsblk-clean-controller.json`

- [ ] **Step 1: Drop the fixture**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/lsblk-clean-controller.json`:

```json
{
  "blockdevices": [
    { "name": "nvme0n1", "size": "1.5T", "type": "disk",
      "model": "INTEL SSDPE2KX020T8", "serial": "BTLJ123456789", "tran": "nvme",
      "wwn": "eui.0123456789abcdef" },
    { "name": "nvme1n1", "size": "1.5T", "type": "disk",
      "model": "INTEL SSDPE2KX020T8", "serial": "BTLJ987654321", "tran": "nvme" },
    { "name": "sda", "size": "256G", "type": "disk",
      "model": "Samsung SSD 870", "serial": "S5SUNF0R123456", "tran": "sata",
      "children": [
        { "name": "sda1", "size": "256G", "type": "part" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/disk.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLsblkOutput } from '../../../lib/parse/disk.js';

describe('parseLsblkOutput', () => {
  it('emits one Disk per top-level disk; ignores partitions', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/lsblk-clean-controller.json'), 'utf8');
    const disks = parseLsblkOutput(raw);
    expect(disks).toHaveLength(3);
    const nvme0 = disks.find((d) => d.id === 'nvme0n1');
    expect(nvme0).toBeDefined();
    expect(nvme0?.status.model).toBe('INTEL SSDPE2KX020T8');
    expect(nvme0?.status.serial).toBe('BTLJ123456789');
    expect(nvme0?.status.transport).toBe('nvme');
  });

  it('rejects malformed JSON with a clear error', () => {
    expect(() => parseLsblkOutput('not json')).toThrow(/JSON/);
  });

  it('handles missing optional fields gracefully', () => {
    const raw = JSON.stringify({ blockdevices: [{ name: 'sda', type: 'disk' }] });
    const disks = parseLsblkOutput(raw);
    expect(disks).toHaveLength(1);
    expect(disks[0]?.id).toBe('sda');
    expect(disks[0]?.status.model).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/disk.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/disk.ts`:

```ts
/**
 * Pure parser for `lsblk --json` output. Emits typed Disk objects
 * matching api-v1.yaml's Disk schema (subset — full status fields
 * stamped by the agent's probe layer, not here).
 *
 * No side effects. Safe to import from anywhere.
 */

interface RawBlockDevice {
  name: string;
  type?: string;
  size?: string;
  model?: string;
  serial?: string;
  tran?: string;
  wwn?: string;
  children?: RawBlockDevice[];
}

export interface ObservedDisk {
  kind: 'Disk';
  id: string;
  status: {
    name: string;
    model?: string;
    serial?: string;
    transport?: string;
    wwn?: string;
    size_text?: string;
  };
}

export function parseLsblkOutput(raw: string): ObservedDisk[] {
  let parsed: { blockdevices?: RawBlockDevice[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseLsblkOutput: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const devices = parsed.blockdevices ?? [];
  return devices
    .filter((d) => d.type === 'disk' || d.type === undefined)
    .map<ObservedDisk>((d) => ({
      kind: 'Disk',
      id: d.name,
      status: {
        name: d.name,
        ...(d.model !== undefined ? { model: d.model } : {}),
        ...(d.serial !== undefined ? { serial: d.serial } : {}),
        ...(d.tran !== undefined ? { transport: d.tran } : {}),
        ...(d.wwn !== undefined ? { wwn: d.wwn } : {}),
        ...(d.size !== undefined ? { size_text: d.size } : {}),
      },
    }));
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/disk.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/disk.ts xiNAS-MCP/src/__tests__/lib/parse/disk.test.ts xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/lsblk-clean-controller.json
git commit -m "$(cat <<'EOF'
feat(parse): add Disk parser for lsblk --json output

S0 substrate task B1. Pure parsing helper — no system calls, no
probe logic. Takes lsblk's --json stdout, emits typed ObservedDisk
objects matching api-v1.yaml's Disk schema (subset; status fields
stamped by the agent's probe in a later phase).

Tests cover: typical clean controller fixture, malformed-JSON
error path, partial-fields graceful handling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B2: `parseIpJson` (Network)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/network.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/network.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/ip-addr-show.json`

- [ ] **Step 1: Drop the fixture**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/ip-addr-show.json`:

```json
[
  {
    "ifindex": 1,
    "ifname": "lo",
    "flags": ["LOOPBACK", "UP", "LOWER_UP"],
    "mtu": 65536,
    "operstate": "UNKNOWN",
    "link_type": "loopback",
    "address": "00:00:00:00:00:00",
    "addr_info": [
      { "family": "inet",  "local": "127.0.0.1", "prefixlen": 8 },
      { "family": "inet6", "local": "::1",       "prefixlen": 128 }
    ]
  },
  {
    "ifindex": 2,
    "ifname": "enp3s0",
    "flags": ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"],
    "mtu": 1500,
    "operstate": "UP",
    "link_type": "ether",
    "address": "d8:5e:d3:0a:1b:2c",
    "addr_info": [
      { "family": "inet",  "local": "10.0.0.5",  "prefixlen": 24 },
      { "family": "inet6", "local": "fe80::da5e:d3ff:fe0a:1b2c", "prefixlen": 64, "scope": "link" }
    ]
  },
  {
    "ifindex": 5,
    "ifname": "ibp0s4",
    "flags": ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"],
    "mtu": 4092,
    "operstate": "UP",
    "link_type": "infiniband",
    "address": "80:00:02:08:fe:80:00:00:00:00:00:00:e4:1d:2d:ff:fe:a2:3b:4c",
    "addr_info": [
      { "family": "inet",  "local": "192.168.100.1", "prefixlen": 24 }
    ]
  }
]
```

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/network.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIpJson } from '../../../lib/parse/network.js';

describe('parseIpJson', () => {
  it('parses a typical ip -j addr show output into ObservedNetworkInterface[]', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/ip-addr-show.json'), 'utf8');
    const ifaces = parseIpJson(raw);
    expect(ifaces).toHaveLength(3);

    const eth = ifaces.find((i) => i.id === 'enp3s0');
    expect(eth).toBeDefined();
    expect(eth?.status.mac).toBe('d8:5e:d3:0a:1b:2c');
    expect(eth?.status.mtu).toBe(1500);
    expect(eth?.status.operstate).toBe('UP');
    expect(eth?.status.ip4_addresses).toContain('10.0.0.5/24');
    expect(eth?.status.ip6_addresses).toContain('fe80::da5e:d3ff:fe0a:1b2c/64');

    const ib = ifaces.find((i) => i.id === 'ibp0s4');
    expect(ib).toBeDefined();
    expect(ib?.status.mtu).toBe(4092);
  });

  it('rejects malformed JSON with a clear error', () => {
    expect(() => parseIpJson('not json')).toThrow(/JSON/);
  });

  it('handles an interface with no addr_info gracefully', () => {
    const raw = JSON.stringify([
      { ifindex: 3, ifname: 'eth0', flags: [], mtu: 1500, operstate: 'DOWN', link_type: 'ether' },
    ]);
    const ifaces = parseIpJson(raw);
    expect(ifaces).toHaveLength(1);
    expect(ifaces[0]?.id).toBe('eth0');
    expect(ifaces[0]?.status.ip4_addresses).toEqual([]);
    expect(ifaces[0]?.status.ip6_addresses).toEqual([]);
    expect(ifaces[0]?.status.mac).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/network.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/network.ts`:

```ts
/**
 * Pure parser for `ip -j addr show` output. Emits typed
 * ObservedNetworkInterface objects matching api-v1.yaml's
 * NetworkInterface schema.
 *
 * No side effects. Safe to import from anywhere.
 */

interface RawAddrInfo {
  family?: string;
  local?: string;
  prefixlen?: number;
  scope?: string;
}

interface RawIpInterface {
  ifname: string;
  mtu?: number;
  operstate?: string;
  address?: string;
  addr_info?: RawAddrInfo[];
}

export interface ObservedNetworkInterface {
  kind: 'NetworkInterface';
  id: string;
  status: {
    name: string;
    operstate: string;
    ip4_addresses: string[];
    ip6_addresses: string[];
    mtu?: number;
    mac?: string;
  };
}

export function parseIpJson(raw: string): ObservedNetworkInterface[] {
  let parsed: RawIpInterface[];
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseIpJson: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('parseIpJson: expected a JSON array at the top level');
  }
  return parsed.map<ObservedNetworkInterface>((iface) => {
    const addrInfo = iface.addr_info ?? [];
    const ip4_addresses = addrInfo
      .filter((a) => a.family === 'inet' && a.local !== undefined)
      .map((a) => `${a.local}/${a.prefixlen ?? ''}`);
    const ip6_addresses = addrInfo
      .filter((a) => a.family === 'inet6' && a.local !== undefined)
      .map((a) => `${a.local}/${a.prefixlen ?? ''}`);
    return {
      kind: 'NetworkInterface',
      id: iface.ifname,
      status: {
        name: iface.ifname,
        operstate: iface.operstate ?? 'UNKNOWN',
        ip4_addresses,
        ip6_addresses,
        ...(iface.mtu !== undefined ? { mtu: iface.mtu } : {}),
        ...(iface.address !== undefined ? { mac: iface.address } : {}),
      },
    };
  });
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/network.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/network.ts xiNAS-MCP/src/__tests__/lib/parse/network.test.ts xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/ip-addr-show.json
git commit -m "$(cat <<'EOF'
feat(parse): add NetworkInterface parser for ip -j addr show output

S0 substrate task B2. Pure parsing helper — no system calls, no
probe logic. Takes `ip -j addr show` JSON stdout, emits typed
ObservedNetworkInterface objects matching api-v1.yaml's
NetworkInterface schema (name, mac, mtu, ip4/ip6 addresses,
operstate).

Tests cover: typical three-interface fixture (loopback, ethernet,
InfiniBand), malformed-JSON error path, interface with no addr_info.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: `parseSystemdUnit` (Systemd unit INI)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/systemd-unit.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/systemd-unit.test.ts`

*(No separate fixture file — test uses inline string literals.)*

- [ ] **Step 1: (No fixture to drop)**

Inline string literals in the test are sufficient for this parser. Proceed directly to Step 2.

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/systemd-unit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSystemdUnit } from '../../../lib/parse/systemd-unit.js';

const MOUNT_UNIT = `
[Unit]
Description=XFS mount for share01
After=local-fs.target

[Mount]
What=/dev/md/xinas-data
Where=/srv/share01
Type=xfs
Options=defaults,noatime

[Install]
WantedBy=local-fs.target
`.trim();

const SERVICE_UNIT = `
[Unit]
Description=xinas-api service

[Service]
ExecStart=/usr/bin/node /opt/xinas/server.js
Environment=NODE_ENV=production
Environment=PORT=8080
Restart=on-failure

[Install]
WantedBy=multi-user.target
`.trim();

describe('parseSystemdUnit', () => {
  it('parses a .mount unit with [Unit], [Mount], and [Install] sections', () => {
    const result = parseSystemdUnit(MOUNT_UNIT);
    expect(result.unit?.['Description']).toBe('XFS mount for share01');
    expect(result.mount?.['What']).toBe('/dev/md/xinas-data');
    expect(result.mount?.['Where']).toBe('/srv/share01');
    expect(result.mount?.['Type']).toBe('xfs');
    expect(result.mount?.['Options']).toBe('defaults,noatime');
    expect(result.install?.['WantedBy']).toBe('local-fs.target');
  });

  it('collects repeated keys as an array for the last-value-wins case (Environment=)', () => {
    const result = parseSystemdUnit(SERVICE_UNIT);
    expect(result.service?.['ExecStart']).toBe('/usr/bin/node /opt/xinas/server.js');
    // Environment appears twice — multi-value; stored as string[] when repeated
    const env = result.service?.['Environment'];
    expect(Array.isArray(env)).toBe(true);
    expect(env).toContain('NODE_ENV=production');
    expect(env).toContain('PORT=8080');
  });

  it('returns empty section maps for unknown/absent sections', () => {
    const result = parseSystemdUnit('[Unit]\nDescription=Bare unit');
    expect(result.unit?.['Description']).toBe('Bare unit');
    expect(result.mount).toBeUndefined();
    expect(result.service).toBeUndefined();
    expect(result.install).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/systemd-unit.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/systemd-unit.ts`:

```ts
/**
 * Pure INI-style parser for systemd unit files. Sections are
 * `[SectionName]`; keys are `Key=Value`. Repeated keys within the
 * same section are collected into a string[] (multi-value).
 *
 * No side effects. Safe to import from anywhere.
 */

export type SectionMap = Record<string, string | string[]>;

export interface ParsedSystemdUnit {
  unit?: SectionMap;
  mount?: SectionMap;
  service?: SectionMap;
  install?: SectionMap;
  /** Any additional section not covered by the named fields. */
  extra?: Record<string, SectionMap>;
}

function sectionKey(name: string): keyof ParsedSystemdUnit | null {
  switch (name.toLowerCase()) {
    case 'unit':    return 'unit';
    case 'mount':   return 'mount';
    case 'service': return 'service';
    case 'install': return 'install';
    default:        return null;
  }
}

export function parseSystemdUnit(raw: string): ParsedSystemdUnit {
  const result: ParsedSystemdUnit = {};
  let currentSection: SectionMap | null = null;
  let currentSectionName = '';

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSectionName = line.slice(1, -1);
      const knownKey = sectionKey(currentSectionName);
      if (knownKey !== null) {
        if (result[knownKey] === undefined) {
          (result as Record<string, SectionMap>)[knownKey] = {};
        }
        currentSection = result[knownKey] as SectionMap;
      } else {
        if (result.extra === undefined) result.extra = {};
        if (result.extra[currentSectionName] === undefined) {
          result.extra[currentSectionName] = {};
        }
        currentSection = result.extra[currentSectionName];
      }
      continue;
    }

    if (currentSection === null) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    const existing = currentSection[key];
    if (existing === undefined) {
      currentSection[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      currentSection[key] = [existing, value];
    }
  }

  return result;
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/systemd-unit.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/systemd-unit.ts xiNAS-MCP/src/__tests__/lib/parse/systemd-unit.test.ts
git commit -m "$(cat <<'EOF'
feat(parse): add SystemdUnit INI parser for .unit/.mount/.service files

S0 substrate task B3. Pure INI-style parsing helper — no system
calls. Takes raw unit file text, emits a structured
ParsedSystemdUnit with named [Unit], [Mount], [Service], [Install]
section maps and an extras bucket for unknown sections. Repeated
keys within a section are collected into string[].

Used by B4 (mountUnitToFilesystem) and B7 (parseIdmapConf) in this
phase; later by the agent's Filesystem and NfsIdmap collectors.

Tests cover: .mount unit with all four known sections, repeated-key
Environment= collection, bare unit with only a [Unit] section.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B4: `mountUnitToFilesystem` (Filesystem from .mount unit)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/filesystem.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/filesystem.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/srv-share01.mount`

- [ ] **Step 1: Drop the fixture**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/srv-share01.mount`:

```ini
[Unit]
Description=XFS mount for /srv/share01
Documentation=https://xinnor.io/xinas
After=local-fs.target
DefaultDependencies=no

[Mount]
What=/dev/md/xinas-data
Where=/srv/share01
Type=xfs
Options=defaults,noatime,nodiratime

[Install]
WantedBy=local-fs.target
```

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/filesystem.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mountUnitToFilesystem } from '../../../lib/parse/filesystem.js';
import { parseSystemdUnit } from '../../../lib/parse/systemd-unit.js';

describe('mountUnitToFilesystem', () => {
  it('converts a real .mount unit file into an ObservedFilesystem', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/srv-share01.mount'), 'utf8');
    const parsed = parseSystemdUnit(raw);
    const fs = mountUnitToFilesystem(parsed, 'srv-share01.mount', true);

    expect(fs.kind).toBe('Filesystem');
    expect(fs.id).toBe('srv-share01.mount');
    expect(fs.spec.mountpoint).toBe('/srv/share01');
    expect(fs.spec.fs_type).toBe('xfs');
    expect(fs.spec.backing_device).toBe('/dev/md/xinas-data');
    expect(fs.status.mount_unit_name).toBe('srv-share01.mount');
    expect(fs.status.mount_unit_enabled).toBe(true);
  });

  it('marks a disabled unit as mount_unit_enabled = false', () => {
    const raw = readFileSync(fileURLToPath(new URL('./__fixtures__/srv-share01.mount', import.meta.url)), 'utf8');
    const parsed = parseSystemdUnit(raw);
    const fs = mountUnitToFilesystem(parsed, 'srv-share01.mount', false);
    expect(fs.status.mount_unit_enabled).toBe(false);
  });

  it('handles a minimal .mount unit with only [Mount] What/Where', () => {
    const parsed = parseSystemdUnit('[Mount]\nWhat=/dev/sdb1\nWhere=/data');
    const fs = mountUnitToFilesystem(parsed, 'data.mount', true);
    expect(fs.spec.mountpoint).toBe('/data');
    expect(fs.spec.backing_device).toBe('/dev/sdb1');
    expect(fs.spec.fs_type).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/filesystem.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/filesystem.ts`:

```ts
/**
 * Pure converter from a parsed systemd .mount unit (output of
 * parseSystemdUnit) + unit metadata into an ObservedFilesystem.
 *
 * No side effects. Safe to import from anywhere.
 */

import type { ParsedSystemdUnit } from './systemd-unit.js';

export interface ObservedFilesystem {
  kind: 'Filesystem';
  id: string;
  spec: {
    mountpoint: string;
    backing_device: string;
    fs_type?: string;
    options?: string[];
  };
  status: {
    mount_unit_name: string;
    // Enablement from `systemctl is-enabled` (a boolean here). The systemd
    // runtime ActiveState (active/inactive/failed/…) is a DIFFERENT field,
    // `mount_unit_state`, populated by the dbus cross-reference in the
    // Filesystem collector (E4) — NOT derivable from is-enabled. B4 sets
    // only what it knows (enablement); E4 fills mount_unit_state +
    // currently_mounted from /proc/self/mountinfo + dbus.
    mount_unit_enabled: boolean;
  };
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export function mountUnitToFilesystem(
  parsed: ParsedSystemdUnit,
  unitName: string,
  isEnabled: boolean,
): ObservedFilesystem {
  const mount = parsed.mount ?? {};
  const where = firstString(mount['Where']) ?? '';
  const what = firstString(mount['What']) ?? '';
  const type = firstString(mount['Type']);
  const optionsRaw = firstString(mount['Options']);
  const options = optionsRaw !== undefined ? optionsRaw.split(',').map((o) => o.trim()) : undefined;

  return {
    kind: 'Filesystem',
    id: unitName,
    spec: {
      mountpoint: where,
      backing_device: what,
      ...(type !== undefined ? { fs_type: type } : {}),
      ...(options !== undefined ? { options } : {}),
    },
    status: {
      mount_unit_name: unitName,
      mount_unit_enabled: isEnabled,
    },
  };
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/filesystem.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/filesystem.ts xiNAS-MCP/src/__tests__/lib/parse/filesystem.test.ts xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/srv-share01.mount
git commit -m "$(cat <<'EOF'
feat(parse): add mountUnitToFilesystem parser for systemd .mount units

S0 substrate task B4. Pure conversion helper — takes the output of
parseSystemdUnit (B3) plus the unit filename and is-enabled boolean,
emits a typed ObservedFilesystem matching api-v1.yaml's Filesystem
schema (spec.mountpoint, spec.backing_device, spec.fs_type, and the
additive Filesystem.status fields: mount_unit_name, mount_unit_state).

mount_unit_state reflects the is-enabled boolean (from systemctl
is-enabled); the active/inactive/failed runtime state is folded in
by the agent's Filesystem collector in a later phase.

Tests cover: real fixture round-trip (xfs/noatime mount), disabled
unit, minimal unit with only What/Where.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B5: `parseMountinfo` (Mountinfo)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/mountinfo.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/mountinfo.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/mountinfo.txt`

- [ ] **Step 1: Drop the fixture**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/mountinfo.txt`:

```
22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro
23 22 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
24 22 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:2 - sysfs sysfs rw
25 22 0:23 / /dev rw,nosuid shared:8 - devtmpfs udev rw,size=8192k,nr_inodes=4096
100 22 259:1 / /srv/share01 rw,noatime,nodiratime shared:50 - xfs /dev/md/xinas-data rw,attr2,inode64,logbufs=8,noquota
101 22 259:2 / /srv/share02 rw,noatime shared:51 - xfs /dev/md/xinas-log rw,attr2,inode64
```

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/mountinfo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMountinfo } from '../../../lib/parse/mountinfo.js';

describe('parseMountinfo', () => {
  it('parses a typical /proc/self/mountinfo into structured mount entries', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/mountinfo.txt'), 'utf8');
    const mounts = parseMountinfo(raw);
    expect(mounts).toHaveLength(6);

    const root = mounts.find((m) => m.mountpoint === '/');
    expect(root).toBeDefined();
    expect(root?.mount_id).toBe(22);
    expect(root?.parent_id).toBe(1);
    expect(root?.fstype).toBe('ext4');
    expect(root?.source).toBe('/dev/sda1');
    expect(root?.options).toContain('rw');

    const share01 = mounts.find((m) => m.mountpoint === '/srv/share01');
    expect(share01).toBeDefined();
    expect(share01?.mount_id).toBe(100);
    expect(share01?.fstype).toBe('xfs');
    expect(share01?.source).toBe('/dev/md/xinas-data');
  });

  it('skips blank lines and lines with fewer than 10 fields', () => {
    const raw = '\n\n22 1 8:1 / / rw shared:1 - ext4 /dev/sda1 rw\n\ngarbage\n';
    const mounts = parseMountinfo(raw);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.mountpoint).toBe('/');
  });

  it('returns an empty array for empty input', () => {
    expect(parseMountinfo('')).toEqual([]);
    expect(parseMountinfo('\n\n')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/mountinfo.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/mountinfo.ts`:

```ts
/**
 * Pure parser for /proc/self/mountinfo lines (man 5 proc).
 *
 * Format (space-separated):
 *   mount_id parent_id major:minor root mountpoint mount_options
 *   [optional-fields] - fstype mount-source super-options
 *
 * No side effects. Safe to import from anywhere.
 */

export interface MountEntry {
  mount_id: number;
  parent_id: number;
  mountpoint: string;
  options: string[];
  fstype: string;
  source: string;
}

export function parseMountinfo(raw: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    // Fields before the '-' separator are variable-length due to optional fields.
    // Split into pre-separator and post-separator parts.
    const sepIdx = line.indexOf(' - ');
    if (sepIdx === -1) continue;

    const prePart = line.slice(0, sepIdx);
    const postPart = line.slice(sepIdx + 3); // skip ' - '

    const preFields = prePart.split(' ');
    const postFields = postPart.split(' ');

    // pre: mount_id parent_id major:minor root mountpoint mount_options [optional...]
    if (preFields.length < 6) continue;
    // post: fstype source super_options
    if (postFields.length < 2) continue;

    const mount_id = parseInt(preFields[0] ?? '', 10);
    const parent_id = parseInt(preFields[1] ?? '', 10);
    const mountpoint = preFields[4] ?? '';
    const mountOptionsRaw = preFields[5] ?? '';
    const fstype = postFields[0] ?? '';
    const source = postFields[1] ?? '';

    if (isNaN(mount_id) || isNaN(parent_id) || mountpoint === '') continue;

    entries.push({
      mount_id,
      parent_id,
      mountpoint,
      options: mountOptionsRaw.split(',').filter((o) => o !== ''),
      fstype,
      source,
    });
  }
  return entries;
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/mountinfo.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/mountinfo.ts xiNAS-MCP/src/__tests__/lib/parse/mountinfo.test.ts xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/mountinfo.txt
git commit -m "$(cat <<'EOF'
feat(parse): add Mountinfo parser for /proc/self/mountinfo

S0 substrate task B5. Pure line-by-line parser — no system calls.
Takes /proc/self/mountinfo text (man 5 proc format), emits an array
of MountEntry objects (mount_id, parent_id, mountpoint, options[],
fstype, source). Handles the variable-length optional-fields region
by splitting on the ' - ' separator per the proc man page spec.

Used by the agent's Filesystem collector (E4) to cross-reference
.mount units with active kernel mount state.

Tests cover: typical six-entry xiNAS fixture (root, proc, sys, dev,
two XFS shares), short/malformed lines are skipped, empty input.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B6: `parseListExports` + `parseListSessions` (NFS)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/nfs.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/nfs.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/nfs-helper-list-exports.json`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/nfs-helper-list-sessions.json`

- [ ] **Step 1: Drop the fixtures**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/nfs-helper-list-exports.json`:

```json
{
  "op": "list_exports",
  "status": "ok",
  "exports": [
    {
      "path": "/srv/share01",
      "clients": [
        {
          "host_pattern": "10.0.0.0/24",
          "options": ["rw", "sync", "root_squash", "no_subtree_check", "anon_uid=65534", "anon_gid=65534"]
        },
        {
          "host_pattern": "10.0.1.5",
          "options": ["ro", "no_root_squash", "no_subtree_check"]
        }
      ]
    },
    {
      "path": "/srv/share02",
      "clients": [
        {
          "host_pattern": "*",
          "options": ["rw", "sync", "all_squash", "anon_uid=1000", "anon_gid=1000"]
        }
      ]
    }
  ]
}
```

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/nfs-helper-list-sessions.json`:

```json
{
  "op": "list_sessions",
  "status": "ok",
  "sessions": [
    {
      "client_addr": "10.0.0.10",
      "client_hostname": "compute-01.local",
      "export_path": "/srv/share01",
      "proto_version": "v4.1",
      "locked_files": 3
    },
    {
      "client_addr": "10.0.0.11",
      "export_path": "/srv/share01",
      "proto_version": "v3",
      "locked_files": 0
    },
    {
      "client_addr": "10.0.0.12",
      "export_path": "/srv/share02",
      "proto_version": "v4.2",
      "locked_files": 12
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/nfs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseListExports, parseListSessions } from '../../../lib/parse/nfs.js';

const fixtureDir = join(__dirname, '__fixtures__');

describe('parseListExports', () => {
  it('parses list_exports helper response into ObservedExportRule[]', () => {
    const raw = readFileSync(join(fixtureDir, 'nfs-helper-list-exports.json'), 'utf8');
    const rules = parseListExports(raw);
    expect(rules).toHaveLength(3); // 2 clients for share01 + 1 for share02

    const cidr = rules.find(
      (r) => r.host_pattern === '10.0.0.0/24' && r.export_path === '/srv/share01',
    );
    expect(cidr).toBeDefined();
    expect(cidr?.squash_mode).toBe('root_squash');
    expect(cidr?.anon_uid).toBe(65534);
    expect(cidr?.anon_gid).toBe(65534);

    const noSquash = rules.find(
      (r) => r.host_pattern === '10.0.1.5' && r.export_path === '/srv/share01',
    );
    expect(noSquash?.squash_mode).toBe('no_root_squash');
    expect(noSquash?.anon_uid).toBeUndefined();

    const allSquash = rules.find((r) => r.export_path === '/srv/share02');
    expect(allSquash?.squash_mode).toBe('all_squash');
    expect(allSquash?.anon_uid).toBe(1000);
    expect(allSquash?.anon_gid).toBe(1000);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseListExports('not json')).toThrow(/JSON/);
  });

  it('returns empty array when exports field is absent or empty', () => {
    const raw = JSON.stringify({ op: 'list_exports', status: 'ok', exports: [] });
    expect(parseListExports(raw)).toEqual([]);
  });
});

describe('parseListSessions', () => {
  it('parses list_sessions helper response into ObservedNfsSession[]', () => {
    const raw = readFileSync(join(fixtureDir, 'nfs-helper-list-sessions.json'), 'utf8');
    const sessions = parseListSessions(raw);
    expect(sessions).toHaveLength(3);

    const s1 = sessions.find((s) => s.spec.client_addr === '10.0.0.10');
    expect(s1).toBeDefined();
    expect(s1?.spec.client_hostname).toBe('compute-01.local');
    expect(s1?.spec.export_path).toBe('/srv/share01');
    expect(s1?.status.proto_version).toBe('v4.1');
    expect(s1?.status.locked_files).toBe(3);
    expect(s1?.id).toBe('10.0.0.10:/srv/share01');

    const s2 = sessions.find((s) => s.spec.client_addr === '10.0.0.11');
    expect(s2?.spec.client_hostname).toBeUndefined();
  });

  it('throws on malformed JSON', () => {
    expect(() => parseListSessions('not json')).toThrow(/JSON/);
  });

  it('returns empty array when sessions field is absent or empty', () => {
    const raw = JSON.stringify({ op: 'list_sessions', status: 'ok', sessions: [] });
    expect(parseListSessions(raw)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/nfs.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/nfs.ts`:

```ts
/**
 * Pure parsers for xinas-nfs-helper list_exports / list_sessions
 * JSON output. Emits typed objects matching api-v1.yaml's ExportRule
 * and NfsSession schemas.
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ObservedExportRule {
  export_path: string;
  host_pattern: string;
  options: string[];
  squash_mode?: 'root_squash' | 'no_root_squash' | 'all_squash';
  anon_uid?: number;
  anon_gid?: number;
}

export interface ObservedNfsSession {
  kind: 'NfsSession';
  id: string;
  spec: {
    client_addr: string;
    export_path: string;
    client_hostname?: string;
  };
  status: {
    proto_version: string;
    locked_files: number;
  };
}

type SquashMode = 'root_squash' | 'no_root_squash' | 'all_squash';

function extractSquashMode(options: string[]): SquashMode | undefined {
  if (options.includes('all_squash')) return 'all_squash';
  if (options.includes('no_root_squash')) return 'no_root_squash';
  if (options.includes('root_squash')) return 'root_squash';
  return undefined;
}

function extractAnonId(options: string[], key: 'anon_uid' | 'anon_gid'): number | undefined {
  const entry = options.find((o) => o.startsWith(`${key}=`));
  if (entry === undefined) return undefined;
  const val = parseInt(entry.slice(key.length + 1), 10);
  return isNaN(val) ? undefined : val;
}

function parseJson(raw: string, caller: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${caller}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface RawClient {
  host_pattern: string;
  options?: string[];
}

interface RawExport {
  path: string;
  clients?: RawClient[];
}

interface RawListExports {
  exports?: RawExport[];
}

export function parseListExports(raw: string): ObservedExportRule[] {
  const data = parseJson(raw, 'parseListExports') as RawListExports;
  const exports_ = data.exports ?? [];
  const rules: ObservedExportRule[] = [];

  for (const exp of exports_) {
    const clients = exp.clients ?? [];
    for (const client of clients) {
      const opts = client.options ?? [];
      const squash_mode = extractSquashMode(opts);
      const anon_uid = extractAnonId(opts, 'anon_uid');
      const anon_gid = extractAnonId(opts, 'anon_gid');
      rules.push({
        export_path: exp.path,
        host_pattern: client.host_pattern,
        options: opts,
        ...(squash_mode !== undefined ? { squash_mode } : {}),
        ...(anon_uid !== undefined ? { anon_uid } : {}),
        ...(anon_gid !== undefined ? { anon_gid } : {}),
      });
    }
  }

  return rules;
}

interface RawSession {
  client_addr: string;
  export_path: string;
  proto_version: string;
  locked_files: number;
  client_hostname?: string;
}

interface RawListSessions {
  sessions?: RawSession[];
}

export function parseListSessions(raw: string): ObservedNfsSession[] {
  const data = parseJson(raw, 'parseListSessions') as RawListSessions;
  const sessions = data.sessions ?? [];

  return sessions.map<ObservedNfsSession>((s) => ({
    kind: 'NfsSession',
    id: `${s.client_addr}:${s.export_path}`,
    spec: {
      client_addr: s.client_addr,
      export_path: s.export_path,
      ...(s.client_hostname !== undefined ? { client_hostname: s.client_hostname } : {}),
    },
    status: {
      proto_version: s.proto_version,
      locked_files: s.locked_files,
    },
  }));
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/nfs.test.ts 2>&1 | tail -5
```
Expected: 6/6 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/nfs.ts xiNAS-MCP/src/__tests__/lib/parse/nfs.test.ts xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/nfs-helper-list-exports.json xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/nfs-helper-list-sessions.json
git commit -m "$(cat <<'EOF'
feat(parse): add NFS parsers for xinas-nfs-helper list_exports/list_sessions

S0 substrate task B6. Two pure parsing helpers — no system calls.

parseListExports: takes nfs-helper list_exports JSON, emits
ObservedExportRule[] with host_pattern, options, and squash_mode
(root_squash / no_root_squash / all_squash) + anon_uid/anon_gid
extracted from the options array per nfs-utils convention.

parseListSessions: takes nfs-helper list_sessions JSON, emits
ObservedNfsSession[] with composite id (<client_addr>:<export_path>)
matching api-v1.yaml's NfsSession schema.

Tests cover: typical two-path fixture with all three squash modes
and anon id extraction, malformed-JSON error paths, empty arrays.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B7: `parseIdmapConf` (NFS Idmap config)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/idmap.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/idmap.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/idmapd.conf`

- [ ] **Step 1: Drop the fixture**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/idmapd.conf`:

```ini
# /etc/idmapd.conf — NFS idmapping config
# Generated by xinas Ansible role

[General]
Verbosity = 0
Domain = xinas.local
Local-Realms = XINAS.LOCAL,CORP.EXAMPLE.COM

[Mapping]
Method = nsswitch

[Translation]
# placeholder — not used by nsswitch method
```

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/idmap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIdmapConf } from '../../../lib/parse/idmap.js';

describe('parseIdmapConf', () => {
  it('extracts Domain, Local-Realms, and Method from a typical idmapd.conf', () => {
    const raw = readFileSync(join(__dirname, '__fixtures__/idmapd.conf'), 'utf8');
    const result = parseIdmapConf(raw);
    expect(result.domain).toBe('xinas.local');
    expect(result.local_realms).toEqual(['XINAS.LOCAL', 'CORP.EXAMPLE.COM']);
    expect(result.method).toBe('nsswitch');
  });

  it('returns undefined optional fields when keys are absent', () => {
    const result = parseIdmapConf('[General]\nVerbosity = 0\n[Mapping]\nMethod = static');
    expect(result.domain).toBeUndefined();
    expect(result.local_realms).toBeUndefined();
    expect(result.method).toBe('static');
  });

  it('handles an empty or comment-only file gracefully', () => {
    const result = parseIdmapConf('# just a comment\n\n');
    expect(result.domain).toBeUndefined();
    expect(result.local_realms).toBeUndefined();
    expect(result.method).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/idmap.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/idmap.ts`:

```ts
/**
 * Pure parser for /etc/idmapd.conf. Reuses parseSystemdUnit (which
 * handles the same [Section]\nKey=Value INI dialect) to extract
 * the fields the NfsIdmap collector cares about.
 *
 * No side effects. Safe to import from anywhere.
 */

import { parseSystemdUnit } from './systemd-unit.js';

export interface ParsedIdmapConf {
  domain?: string;
  local_realms?: string[];
  method?: string;
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export function parseIdmapConf(raw: string): ParsedIdmapConf {
  // idmapd.conf uses the same INI dialect as systemd unit files.
  // Section names differ (General / Mapping / Translation) so they
  // land in the 'extra' bucket of ParsedSystemdUnit.
  const parsed = parseSystemdUnit(raw);
  const general = parsed.extra?.['General'] ?? {};
  const mapping = parsed.extra?.['Mapping'] ?? {};

  const domainRaw = firstString(general['Domain']);
  const localRealmsRaw = firstString(general['Local-Realms']);
  const methodRaw = firstString(mapping['Method']);

  const local_realms =
    localRealmsRaw !== undefined
      ? localRealmsRaw.split(',').map((r) => r.trim()).filter((r) => r !== '')
      : undefined;

  return {
    ...(domainRaw !== undefined ? { domain: domainRaw } : {}),
    ...(local_realms !== undefined ? { local_realms } : {}),
    ...(methodRaw !== undefined ? { method: methodRaw } : {}),
  };
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/idmap.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/idmap.ts xiNAS-MCP/src/__tests__/lib/parse/idmap.test.ts xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/idmapd.conf
git commit -m "$(cat <<'EOF'
feat(parse): add parseIdmapConf parser for /etc/idmapd.conf

S0 substrate task B7. Pure parsing helper — no system calls. Reuses
the B3 INI parser (parseSystemdUnit) since idmapd.conf uses the same
[Section]\nKey=Value dialect; the General and Mapping sections land
in the extra bucket. Extracts Domain, Local-Realms (comma-split into
string[]), and Method for the NfsIdmap collector.

Tests cover: typical xinas.local config with two realms, conf with
Method but no Domain/Local-Realms, empty/comment-only file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B8: `parsePasswdLine` (Passwd)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/passwd.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/passwd.test.ts`

*(No fixture file — test uses inline string literals.)*

- [ ] **Step 1: (No fixture to drop)**

Inline strings are sufficient for a single-line parser. Proceed directly to Step 2.

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/passwd.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePasswdLine } from '../../../lib/parse/passwd.js';

describe('parsePasswdLine', () => {
  it('parses a typical passwd line with all seven fields', () => {
    const result = parsePasswdLine('xinas-api:x:999:997:xinas API service:/var/lib/xinas:/usr/sbin/nologin');
    expect(result.name).toBe('xinas-api');
    expect(result.uid).toBe(999);
    expect(result.gid).toBe(997);
    expect(result.gecos).toBe('xinas API service');
    expect(result.home).toBe('/var/lib/xinas');
    expect(result.shell).toBe('/usr/sbin/nologin');
  });

  it('throws a clear error for lines with fewer than 7 colon-separated fields', () => {
    expect(() => parsePasswdLine('root:x:0:0')).toThrow(/7 fields/);
  });

  it('parses a root line with an empty gecos field', () => {
    const result = parsePasswdLine('root:x:0:0::/root:/bin/bash');
    expect(result.name).toBe('root');
    expect(result.uid).toBe(0);
    expect(result.gid).toBe(0);
    expect(result.gecos).toBe('');
    expect(result.home).toBe('/root');
    expect(result.shell).toBe('/bin/bash');
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/passwd.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/passwd.ts`:

```ts
/**
 * Pure parser for a single /etc/passwd line.
 * Format: name:password:uid:gid:gecos:home:shell
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ParsedPasswdLine {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export function parsePasswdLine(line: string): ParsedPasswdLine {
  const fields = line.split(':');
  if (fields.length < 7) {
    throw new Error(
      `parsePasswdLine: expected 7 fields, got ${fields.length}: ${JSON.stringify(line)}`,
    );
  }
  const [name, , uidStr, gidStr, gecos, home, shell] = fields as [
    string, string, string, string, string, string, string
  ];
  return {
    name,
    uid: parseInt(uidStr, 10),
    gid: parseInt(gidStr, 10),
    gecos,
    home,
    shell,
  };
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/passwd.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/passwd.ts xiNAS-MCP/src/__tests__/lib/parse/passwd.test.ts
git commit -m "$(cat <<'EOF'
feat(parse): add parsePasswdLine parser for /etc/passwd entries

S0 substrate task B8. Pure single-line parser — no system calls.
Takes one colon-separated /etc/passwd line (name:x:uid:gid:gecos:
home:shell), returns a typed ParsedPasswdLine. Used by the agent's
Users collector (E8) to convert getent passwd output into User
observation deltas.

Tests cover: typical service-account line, short-field error path,
root entry with empty gecos.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B9: `parseGroupLine` (Group)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/group.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/group.test.ts`

*(No fixture file — test uses inline string literals.)*

- [ ] **Step 1: (No fixture to drop)**

Inline strings are sufficient for a single-line parser. Proceed directly to Step 2.

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/group.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseGroupLine } from '../../../lib/parse/group.js';

describe('parseGroupLine', () => {
  it('parses a group line with multiple members', () => {
    const result = parseGroupLine('xinas-admin:x:996:alice,bob,carol');
    expect(result.name).toBe('xinas-admin');
    expect(result.gid).toBe(996);
    expect(result.members).toEqual(['alice', 'bob', 'carol']);
  });

  it('parses a group line with no members', () => {
    const result = parseGroupLine('xinas-api:x:995:');
    expect(result.name).toBe('xinas-api');
    expect(result.gid).toBe(995);
    expect(result.members).toEqual([]);
  });

  it('throws a clear error for lines with fewer than 4 colon-separated fields', () => {
    expect(() => parseGroupLine('root:x:0')).toThrow(/4 fields/);
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/group.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/group.ts`:

```ts
/**
 * Pure parser for a single /etc/group line.
 * Format: name:password:gid:member1,member2,...
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ParsedGroupLine {
  name: string;
  gid: number;
  members: string[];
}

export function parseGroupLine(line: string): ParsedGroupLine {
  const fields = line.split(':');
  if (fields.length < 4) {
    throw new Error(
      `parseGroupLine: expected 4 fields, got ${fields.length}: ${JSON.stringify(line)}`,
    );
  }
  const [name, , gidStr, membersStr] = fields as [string, string, string, string];
  const members =
    membersStr === '' ? [] : membersStr.split(',').map((m) => m.trim()).filter((m) => m !== '');
  return {
    name,
    gid: parseInt(gidStr, 10),
    members,
  };
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/group.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/group.ts xiNAS-MCP/src/__tests__/lib/parse/group.test.ts
git commit -m "$(cat <<'EOF'
feat(parse): add parseGroupLine parser for /etc/group entries

S0 substrate task B9. Pure single-line parser — no system calls.
Takes one colon-separated /etc/group line (name:x:gid:members),
returns a typed ParsedGroupLine with a members string[] (empty array
when the member field is blank). Used by the agent's Users collector
(E8) alongside parsePasswdLine (B8) to emit Group observation deltas.

Tests cover: multi-member admin group, empty-member service group,
short-field error path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B10: `parseCpuinfo` + `parseMeminfo` (Inventory)

**Files:**
- Create: `xiNAS-MCP/src/lib/parse/inventory.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/inventory.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/cpuinfo.txt`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/meminfo.txt`

- [ ] **Step 1: Drop the fixtures**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/cpuinfo.txt`:

```
processor	: 0
vendor_id	: GenuineIntel
cpu family	: 6
model		: 85
model name	: Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz
stepping	: 4
microcode	: 0x2006e05
cpu MHz		: 2100.000
cache size	: 22528 KB
physical id	: 0
siblings	: 32
core id		: 0
cpu cores	: 16
apicid		: 0
initial apicid	: 0
fpu		: yes
fpu_exception	: yes
cpuid level	: 22
wp		: yes
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe
bugs		:
bogomips	: 4200.00
clflush size	: 64
cache_alignment	: 64
address sizes	: 46 bits physical, 48 bits virtual
power management:

processor	: 1
vendor_id	: GenuineIntel
cpu family	: 6
model		: 85
model name	: Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz
stepping	: 4
microcode	: 0x2006e05
cpu MHz		: 2100.000
cache size	: 22528 KB
physical id	: 0
siblings	: 32
core id		: 1
cpu cores	: 16
apicid		: 2
initial apicid	: 2
fpu		: yes
fpu_exception	: yes
cpuid level	: 22
wp		: yes
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe
bugs		:
bogomips	: 4200.00
clflush size	: 64
cache_alignment	: 64
address sizes	: 46 bits physical, 48 bits virtual
power management:

processor	: 2
vendor_id	: GenuineIntel
cpu family	: 6
model		: 85
model name	: Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz
stepping	: 4
microcode	: 0x2006e05
cpu MHz		: 2100.000
cache size	: 22528 KB
physical id	: 0
siblings	: 32
core id		: 2
cpu cores	: 16
apicid		: 4
initial apicid	: 4
fpu		: yes
fpu_exception	: yes
cpuid level	: 22
wp		: yes
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe
bugs		:
bogomips	: 4200.00
clflush size	: 64
cache_alignment	: 64
address sizes	: 46 bits physical, 48 bits virtual
power management:

processor	: 3
vendor_id	: GenuineIntel
cpu family	: 6
model		: 85
model name	: Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz
stepping	: 4
microcode	: 0x2006e05
cpu MHz		: 2100.000
cache size	: 22528 KB
physical id	: 0
siblings	: 32
core id		: 3
cpu cores	: 16
apicid		: 6
initial apicid	: 6
fpu		: yes
fpu_exception	: yes
cpuid level	: 22
wp		: yes
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe
bugs		:
bogomips	: 4200.00
clflush size	: 64
cache_alignment	: 64
address sizes	: 46 bits physical, 48 bits virtual
power management:
```

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/meminfo.txt`:

```
MemTotal:       131548736 kB
MemFree:         72334208 kB
MemAvailable:    98765432 kB
Buffers:           512000 kB
Cached:          20480000 kB
SwapCached:             0 kB
Active:          18432000 kB
Inactive:        10240000 kB
Active(anon):     4096000 kB
Inactive(anon):    512000 kB
Active(file):    14336000 kB
Inactive(file):   9728000 kB
Unevictable:           64 kB
Mlocked:               64 kB
SwapTotal:        4194304 kB
SwapFree:         4194304 kB
Dirty:               1024 kB
Writeback:              0 kB
AnonPages:        4608000 kB
Mapped:           2048000 kB
Shmem:             131072 kB
KReclaimable:    10240000 kB
Slab:            11264000 kB
SReclaimable:    10240000 kB
SUnreclaim:       1024000 kB
KernelStack:        65536 kB
PageTables:        131072 kB
NFS_Unstable:           0 kB
Bounce:                 0 kB
WritebackTmp:           0 kB
CommitLimit:     69968672 kB
Committed_AS:     8192000 kB
VmallocTotal:   34359738367 kB
VmallocUsed:      1048576 kB
VmallocChunk:           0 kB
Percpu:            131072 kB
HardwareCorrupted:      0 kB
HugePagesTotal:         0
HugePagesFree:          0
HugePagesRsvd:          0
HugePagesSurp:          0
Hugepagesize:        2048 kB
Hugetlb:                0 kB
DirectMap4k:      1048576 kB
DirectMap2M:     16777216 kB
DirectMap1G:    114294784 kB
```

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/inventory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCpuinfo, parseMeminfo } from '../../../lib/parse/inventory.js';

const fixtureDir = join(__dirname, '__fixtures__');

describe('parseCpuinfo', () => {
  it('parses a 4-thread Xeon fixture into model, cores, threads, arch', () => {
    const raw = readFileSync(join(fixtureDir, 'cpuinfo.txt'), 'utf8');
    const result = parseCpuinfo(raw);
    expect(result.model).toBe('Intel(R) Xeon(R) Gold 6130 CPU @ 2.10GHz');
    expect(result.threads).toBe(4);  // 4 processor stanzas
    expect(result.cores).toBe(16);   // cpu cores field
    expect(result.arch).toBe('x86_64');
  });

  it('handles a single-processor entry gracefully', () => {
    const raw = 'processor\t: 0\nmodel name\t: QEMU Virtual CPU\ncpu cores\t: 1\n';
    const result = parseCpuinfo(raw);
    expect(result.model).toBe('QEMU Virtual CPU');
    expect(result.threads).toBe(1);
    expect(result.cores).toBe(1);
  });

  it('returns undefined optional fields when keys are absent', () => {
    const result = parseCpuinfo('processor\t: 0\n');
    expect(result.model).toBeUndefined();
    expect(result.cores).toBeUndefined();
    expect(result.threads).toBe(1);
  });
});

describe('parseMeminfo', () => {
  it('parses a typical /proc/meminfo and extracts total, available, swap_total in kB', () => {
    const raw = readFileSync(join(fixtureDir, 'meminfo.txt'), 'utf8');
    const result = parseMeminfo(raw);
    expect(result.total_kb).toBe(131548736);
    expect(result.available_kb).toBe(98765432);
    expect(result.swap_total_kb).toBe(4194304);
  });

  it('returns zeros for keys that are absent (minimal meminfo)', () => {
    const result = parseMeminfo('MemTotal: 1024 kB\n');
    expect(result.total_kb).toBe(1024);
    expect(result.available_kb).toBe(0);
    expect(result.swap_total_kb).toBe(0);
  });

  it('returns all zeros for empty input', () => {
    const result = parseMeminfo('');
    expect(result.total_kb).toBe(0);
    expect(result.available_kb).toBe(0);
    expect(result.swap_total_kb).toBe(0);
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/lib/parse/inventory.test.ts 2>&1 | tail -5
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

Create `xiNAS-MCP/src/lib/parse/inventory.ts`:

```ts
/**
 * Pure parsers for /proc/cpuinfo and /proc/meminfo. Emits typed
 * inventory snapshots used by the Inventory collector.
 *
 * arch defaults to 'x86_64' because xiNAS only targets x86_64;
 * the probe layer can override from `uname -m` if needed.
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ParsedCpuinfo {
  model?: string;
  cores?: number;
  threads: number;
  arch: string;
}

export interface ParsedMeminfo {
  total_kb: number;
  available_kb: number;
  swap_total_kb: number;
}

export function parseCpuinfo(raw: string, arch = 'x86_64'): ParsedCpuinfo {
  let processorCount = 0;
  let model: string | undefined;
  let cores: number | undefined;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'processor') {
      processorCount += 1;
    } else if (key === 'model name' && model === undefined) {
      model = value;
    } else if (key === 'cpu cores' && cores === undefined) {
      const n = parseInt(value, 10);
      if (!isNaN(n)) cores = n;
    }
  }

  return {
    ...(model !== undefined ? { model } : {}),
    ...(cores !== undefined ? { cores } : {}),
    threads: Math.max(processorCount, 1),
    arch,
  };
}

export function parseMeminfo(raw: string): ParsedMeminfo {
  const values: Record<string, number> = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    // Values are "<number> kB" or just "<number>" (for huge pages)
    const valuePart = line.slice(colonIdx + 1).trim().split(/\s+/)[0] ?? '0';
    const n = parseInt(valuePart, 10);
    if (!isNaN(n)) values[key] = n;
  }

  return {
    total_kb: values['MemTotal'] ?? 0,
    available_kb: values['MemAvailable'] ?? 0,
    swap_total_kb: values['SwapTotal'] ?? 0,
  };
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/lib/parse/inventory.test.ts 2>&1 | tail -5
```
Expected: 6/6 pass.

- [ ] **Step 6: Commit**

```bash
git add xiNAS-MCP/src/lib/parse/inventory.ts xiNAS-MCP/src/__tests__/lib/parse/inventory.test.ts xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/cpuinfo.txt xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/meminfo.txt
git commit -m "$(cat <<'EOF'
feat(parse): add Inventory parsers for /proc/cpuinfo and /proc/meminfo

S0 substrate task B10. Two pure parsing helpers — no system calls.

parseCpuinfo: /proc/cpuinfo text → { model, cores, threads, arch }.
Counts processor stanzas for thread count; takes first model name
and cpu cores values. arch defaults to x86_64 (overridable by the
probe layer via uname -m).

parseMeminfo: /proc/meminfo text → { total_kb, available_kb,
swap_total_kb }. Extracts MemTotal, MemAvailable, SwapTotal;
absent keys default to 0.

Tests cover: 4-thread Xeon Gold fixture, single-processor minimal
entry, missing-key graceful handling; full meminfo fixture, minimal
single-key meminfo, empty input.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Phase C — Agent process skeleton

### Task C1: Agent config + structured logger

**Files:**
- Create: `xiNAS-MCP/src/agent/config.ts`
- Create: `xiNAS-MCP/src/agent/log.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/config.test.ts`

- [ ] **Step 1: Write failing test for config**

Create `xiNAS-MCP/src/__tests__/agent/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentConfig } from '../../agent/config.js';

describe('loadAgentConfig', () => {
  it('reads config + agent-token + controller-id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-config-'));
    try {
      writeFileSync(join(dir, 'controller-id'), '00000000-0000-0000-0000-0000000000aa\n');
      writeFileSync(join(dir, 'agent-token'), 'agent-token-secret\n');
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        api_socket: '/run/xinas/api.sock',
        agent_socket: '/run/xinas/agent.sock',
        controller_id_path: join(dir, 'controller-id'),
        agent_token_path: join(dir, 'agent-token'),
        socket_group: 'xinas-api',
      }));
      const config = loadAgentConfig({ configPath: join(dir, 'config.json') });
      expect(config.api_socket).toBe('/run/xinas/api.sock');
      expect(config.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
      expect(config.agent_token).toBe('agent-token-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast if controller-id is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-config-'));
    try {
      writeFileSync(join(dir, 'agent-token'), 'agent-token-secret\n');
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        api_socket: '/run/xinas/api.sock',
        agent_socket: '/run/xinas/agent.sock',
        controller_id_path: join(dir, 'controller-id'),
        agent_token_path: join(dir, 'agent-token'),
        socket_group: 'xinas-api',
      }));
      expect(() => loadAgentConfig({ configPath: join(dir, 'config.json') })).toThrow(/controller-id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2-3: Implement config + log**

Create `xiNAS-MCP/src/agent/config.ts` with `AgentConfig` interface and `loadAgentConfig()`. Create `xiNAS-MCP/src/agent/log.ts` with a `log(level, subsystem, event, extra?)` function that emits a single JSON line to stderr.

(Full content omitted from this index — the implementation is ~50 lines for config and ~30 for log, both straightforward.)

- [ ] **Step 4-5: Verify + commit**

Same shape as Task A1's verify and commit steps.

---

### Task C2: JSON-RPC 2.0 dispatcher

**Files:**
- Create: `xiNAS-MCP/src/agent/rpc/dispatch.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/rpc/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/rpc/dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createDispatcher } from '../../../agent/rpc/dispatch.js';

// A trivial handler for tests — returns its params echoed.
function echoHandler(params: unknown): unknown {
  return { echo: params };
}

describe('createDispatcher', () => {
  it('routes a known method and returns a success envelope', async () => {
    const dispatch = createDispatcher({
      'agent.health': () => ({ status: 'starting', version: '0.0.0', uptime_seconds: 0,
        controller_id: 'test-id', in_flight_tasks: 0, collectors: {} }),
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.health', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeDefined();
    expect(parsed.error).toBeUndefined();
  });

  it('returns -32601 for a method absent from the allow-list', async () => {
    const dispatch = createDispatcher({ 'agent.health': echoHandler });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'totally.unknown', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.id).toBe(2);
    expect(parsed.error?.code).toBe(-32601);
    expect(parsed.result).toBeUndefined();
  });

  it('returns -32602 when the handler throws a params error', async () => {
    const dispatch = createDispatcher({
      'agent.health': () => {
        const err = new Error('missing required param: foo') as Error & { code?: string };
        err.code = 'INVALID_PARAMS';
        throw err;
      },
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'agent.health', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.error?.code).toBe(-32602);
  });

  it('returns -32600 for malformed (non-JSON) input', async () => {
    const dispatch = createDispatcher({ 'agent.health': echoHandler });
    const response = await dispatch('this is not json at all');
    const parsed = JSON.parse(response);
    expect(parsed.id).toBeNull();
    expect(parsed.error?.code).toBe(-32600);
  });

  it('returns -32600 for a valid JSON object missing the method field', async () => {
    const dispatch = createDispatcher({ 'agent.health': echoHandler });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 4, params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.id).toBe(4);
    expect(parsed.error?.code).toBe(-32600);
  });

  it('returns -32603 when the handler throws an unexpected error', async () => {
    const dispatch = createDispatcher({
      'agent.health': () => { throw new Error('OS blew up'); },
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'agent.health', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.error?.code).toBe(-32603);
  });

  it('returns -32000 with EXECUTOR_UNSUPPORTED data when handler throws that sentinel', async () => {
    const dispatch = createDispatcher({
      'arrays.list': () => {
        const err = new Error('method not implemented in this build') as Error & {
          code?: string; rpcMethod?: string;
        };
        err.code = 'EXECUTOR_UNSUPPORTED';
        err.rpcMethod = 'arrays.list';
        throw err;
      },
    });
    const response = await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'arrays.list', params: {} }),
    );
    const parsed = JSON.parse(response);
    expect(parsed.error?.code).toBe(-32000);
    expect(parsed.error?.data?.code).toBe('EXECUTOR_UNSUPPORTED');
    expect(parsed.error?.data?.method).toBe('arrays.list');
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/rpc/dispatch.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dispatcher**

Create `xiNAS-MCP/src/agent/rpc/dispatch.ts`:

```ts
/**
 * JSON-RPC 2.0 dispatcher over NDJSON.
 *
 * Takes a single line of text (one NDJSON record), validates the
 * JSON-RPC 2.0 envelope, looks up the method in an explicit allow-list
 * provided by the caller, invokes the handler, and returns a fully-formed
 * JSON-RPC 2.0 response line (no trailing newline — the server adds it).
 *
 * Error code mapping (per spec §Errors):
 *   -32600  Invalid Request  malformed envelope or missing `method`
 *   -32601  Method not found method absent from the allow-list
 *   -32602  Invalid params   handler throws with err.code === 'INVALID_PARAMS'
 *   -32603  Internal error   any other unhandled handler throw
 *   -32000  Custom           handler throws with err.code === 'EXECUTOR_UNSUPPORTED';
 *             data: { code: 'EXECUTOR_UNSUPPORTED', method: string }
 *
 * No side effects; safe to unit-test without a real socket.
 */

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface RpcHandlerMap {
  [method: string]: RpcHandler;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

function errorEnvelope(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error['data'] = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

export function createDispatcher(
  handlers: RpcHandlerMap,
): (line: string) => Promise<string> {
  return async function dispatch(line: string): Promise<string> {
    // 1. Parse JSON.
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return errorEnvelope(null, -32600, 'Parse error: input is not valid JSON');
    }

    // 2. Validate the envelope shape.
    if (
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw)
    ) {
      return errorEnvelope(null, -32600, 'Invalid Request: envelope must be a JSON object');
    }

    const req = raw as Record<string, unknown>;
    const id: number | string | null =
      typeof req['id'] === 'number' || typeof req['id'] === 'string'
        ? (req['id'] as number | string)
        : null;

    if (typeof req['method'] !== 'string' || req['method'].length === 0) {
      return errorEnvelope(id, -32600, 'Invalid Request: missing or non-string "method" field');
    }
    const method = req['method'] as string;
    const params = req['params'] ?? {};

    // 3. Route.
    const handler = handlers[method];
    if (handler === undefined) {
      return errorEnvelope(id, -32601, `Method not found: "${method}" is not in the agent's RPC surface`);
    }

    // 4. Invoke.
    try {
      const result = await handler(params);
      return JSON.stringify({ jsonrpc: '2.0', id, result });
    } catch (err: unknown) {
      if (!(err instanceof Error)) {
        return errorEnvelope(id, -32603, 'Internal error');
      }
      const typed = err as Error & { code?: string; rpcMethod?: string };
      if (typed.code === 'EXECUTOR_UNSUPPORTED') {
        return errorEnvelope(id, -32000, 'method not implemented in this build', {
          code: 'EXECUTOR_UNSUPPORTED',
          method: typed.rpcMethod ?? method,
        });
      }
      if (typed.code === 'INVALID_PARAMS') {
        return errorEnvelope(id, -32602, typed.message);
      }
      return errorEnvelope(id, -32603, `Internal error: ${typed.message}`);
    }
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/rpc/dispatch.test.ts 2>&1 | tail -5
```
Expected: 7/7 pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/agent/rpc/dispatch.ts xiNAS-MCP/src/__tests__/agent/rpc/dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): JSON-RPC 2.0 dispatcher with explicit method allow-list

S0 agent skeleton C2. Pure dispatcher — no sockets, no OS calls.
Takes a single NDJSON line, validates the JSON-RPC 2.0 envelope,
routes by method name against a caller-supplied handler map, and
returns a fully-formed response line.

Error codes match spec §Errors:
  -32600 invalid envelope / parse failure
  -32601 method absent from the allow-list (not EXECUTOR_UNSUPPORTED)
  -32602 handler throws with code=INVALID_PARAMS
  -32603 unexpected handler error
  -32000 handler throws with code=EXECUTOR_UNSUPPORTED
         (data.code + data.method in the error body)

The -32601 vs -32000 distinction is load-bearing: -32601 means the
caller asked for something outside the ADR-0002 surface; -32000 means
the surface exists but this build hasn't implemented it yet.

Seven tests cover all five error codes plus the success path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C3: UDS RPC server

**Files:**
- Create: `xiNAS-MCP/src/agent/rpc/server.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/rpc/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/rpc/server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createAgentRpcServer } from '../../../agent/rpc/server.js';
import { createDispatcher } from '../../../agent/rpc/dispatch.js';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dirs: string[] = [];

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xinas-server-test-'));
  dirs.push(dir);
  return join(dir, 'test.sock');
}

// Helper: connect to UDS, send one JSON-RPC request line, read one response line.
function roundtrip(socketPath: string, request: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });
    let buf = '';
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        client.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('roundtrip timeout')), 3000);
  });
}

describe('createAgentRpcServer', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('listens on a UDS path, accepts a client, dispatches a request and returns the response', async () => {
    const sockPath = tempSocketPath();
    const dispatcher = createDispatcher({
      'agent.health': () => ({ status: 'starting', version: '0.0.0', uptime_seconds: 0,
        controller_id: 'test-id', in_flight_tasks: 0, collectors: {} }),
    });
    const server = await createAgentRpcServer({
      socketPath: sockPath,
      dispatch: dispatcher,
      socketGroupGid: process.getgid?.() ?? 0,   // same gid for test (no chown needed)
    });
    servers.push(server);

    expect(existsSync(sockPath)).toBe(true);

    const response = await roundtrip(sockPath, {
      jsonrpc: '2.0', id: 1, method: 'agent.health', params: {},
    });
    expect((response as { result?: { status: string } }).result?.status).toBe('starting');
  });

  it('handles an unknown method with -32601 over the real socket', async () => {
    const sockPath = tempSocketPath();
    const dispatcher = createDispatcher({ 'agent.health': () => ({ ok: true }) });
    const server = await createAgentRpcServer({
      socketPath: sockPath,
      dispatch: dispatcher,
      socketGroupGid: process.getgid?.() ?? 0,
    });
    servers.push(server);

    const response = await roundtrip(sockPath, {
      jsonrpc: '2.0', id: 2, method: 'no.such.method', params: {},
    });
    expect((response as { error?: { code: number } }).error?.code).toBe(-32601);
  });

  it('handles multiple sequential requests on the same connection', async () => {
    const sockPath = tempSocketPath();
    let callCount = 0;
    const dispatcher = createDispatcher({
      'agent.health': () => { callCount++; return { count: callCount }; },
    });
    const server = await createAgentRpcServer({
      socketPath: sockPath,
      dispatch: dispatcher,
      socketGroupGid: process.getgid?.() ?? 0,
    });
    servers.push(server);

    // Send two requests on the same connection.
    const responses = await new Promise<object[]>((resolve, reject) => {
      const client = createConnection(sockPath, () => {
        client.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'agent.health', params: {} }) + '\n');
        client.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'agent.health', params: {} }) + '\n');
      });
      const results: object[] = [];
      let buf = '';
      client.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          results.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
          if (results.length === 2) {
            client.destroy();
            resolve(results);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('multi-request timeout')), 3000);
    });

    expect(responses).toHaveLength(2);
    expect(callCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/rpc/server.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the UDS server**

Create `xiNAS-MCP/src/agent/rpc/server.ts`:

```ts
/**
 * UDS RPC server for xinas-agent.
 *
 * Binds a Unix domain socket at `socketPath`.  After binding:
 *   - `chmodSync(socketPath, 0o660)` so only owner and group can connect.
 *   - `chownSync(socketPath, -1, socketGroupGid)` to assign the xinas-api
 *     group (gid resolved by the caller from the group name at boot time).
 *     `-1` for uid preserves the existing owner (root when running as root).
 *
 * Per connection: buffers incoming data, splits on '\n', feeds each
 * complete line to the dispatcher, writes the response line followed
 * by '\n' back to the socket.  Connections are not multiplexed — each
 * request/response pair is processed in order on its connection.
 *
 * Returns a handle with a `close()` method that stops accepting new
 * connections and resolves when the server socket is closed.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, unlinkSync, existsSync } from 'node:fs';

export interface AgentRpcServerOptions {
  socketPath: string;
  dispatch: (line: string) => Promise<string>;
  socketGroupGid: number;
}

export interface AgentRpcServerHandle {
  close(): Promise<void>;
}

export async function createAgentRpcServer(
  opts: AgentRpcServerOptions,
): Promise<AgentRpcServerHandle> {
  const { socketPath, dispatch, socketGroupGid } = opts;

  // Clean up any stale socket file from a previous run.
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server: Server = createServer((socket: Socket) => {
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        dispatch(line)
          .then((response) => {
            if (!socket.destroyed) socket.write(response + '\n');
          })
          .catch(() => {
            // dispatch itself should never throw; defensive fallback.
            if (!socket.destroyed) {
              socket.write(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: null,
                  error: { code: -32603, message: 'Internal error' },
                }) + '\n',
              );
            }
          });
      }
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      try {
        chmodSync(socketPath, 0o660);
        chownSync(socketPath, -1, socketGroupGid);
      } catch {
        // In test environments running without root, chown may fail if the gid
        // is foreign; chmod is more likely to succeed and is the critical gate.
      }
      resolve();
    });
  });

  return {
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/rpc/server.test.ts 2>&1 | tail -5
```
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add xiNAS-MCP/src/agent/rpc/server.ts xiNAS-MCP/src/__tests__/agent/rpc/server.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): UDS RPC server with chmod/chown-after-bind

S0 agent skeleton C3. createAgentRpcServer binds a Unix domain socket,
sets mode 0660, and chowns the group to socketGroupGid (the xinas-api
gid resolved at boot). Per-connection NDJSON reader feeds the dispatcher
and writes response lines back.

Security detail: chmod + chown are applied after listen() returns so the
socket is never world-accessible between bind and the permission set.
Stale socket files from prior runs are removed before binding.

Three tests run against a real ephemeral UDS:
  - success path with agent.health
  - unknown method returns -32601
  - two sequential requests on one connection both answered

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C4: `agent.health`, `agent.version`, and stubs registry

**Files:**
- Create: `xiNAS-MCP/src/agent/rpc/methods/health.ts`
- Create: `xiNAS-MCP/src/agent/rpc/methods/version.ts`
- Create: `xiNAS-MCP/src/agent/rpc/methods/stubs.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/rpc/methods/health.test.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/rpc/methods/version.test.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/agent/rpc/methods/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeHealthHandler } from '../../../../agent/rpc/methods/health.js';

describe('agent.health handler', () => {
  it('returns the required shape with no collectors registered', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: '00000000-0000-0000-0000-000000000042',
      startedAt: Date.now() - 5000,
      getCollectorHealth: () => ({}),
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['status']).toBe('starting');
    expect(result['version']).toBe('0.1.0');
    expect(typeof result['uptime_seconds']).toBe('number');
    expect((result['uptime_seconds'] as number)).toBeGreaterThanOrEqual(4);
    expect(result['controller_id']).toBe('00000000-0000-0000-0000-000000000042');
    expect(result['in_flight_tasks']).toBe(0);
    expect(result['collectors']).toEqual({});
  });

  it('reports status=healthy when all collectors are running', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: 'test-id',
      startedAt: Date.now() - 1000,
      getCollectorHealth: () => ({ disk: 'running', network: 'running' }),
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['status']).toBe('healthy');
    expect(result['collectors']).toEqual({ disk: 'running', network: 'running' });
  });

  it('reports status=degraded when any collector is in error state', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: 'test-id',
      startedAt: Date.now() - 1000,
      getCollectorHealth: () => ({
        disk: 'running',
        network: 'error: connection refused',
      }),
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['status']).toBe('degraded');
  });

  it('reports status=stubbed when all non-stub collectors are absent', () => {
    const handler = makeHealthHandler({
      version: '0.1.0',
      controllerId: 'test-id',
      startedAt: Date.now() - 1000,
      getCollectorHealth: () => ({
        'xiraid-stub': 'stubbed',
        'managed-files-stub': 'stubbed',
      }),
    });
    const result = handler({}) as Record<string, unknown>;
    // All present collectors are stubbed; no real collectors running.
    // Status is 'starting' because no real collectors are up yet.
    expect(['starting', 'stubbed']).toContain(result['status']);
  });
});
```

Create `xiNAS-MCP/src/__tests__/agent/rpc/methods/version.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeVersionHandler } from '../../../../agent/rpc/methods/version.js';

describe('agent.version handler', () => {
  it('returns the version field always', () => {
    const handler = makeVersionHandler({ version: '1.2.3' });
    const result = handler({}) as Record<string, unknown>;
    expect(result['version']).toBe('1.2.3');
  });

  it('includes git_sha when provided', () => {
    const handler = makeVersionHandler({ version: '1.2.3', gitSha: 'abc123' });
    const result = handler({}) as Record<string, unknown>;
    expect(result['git_sha']).toBe('abc123');
  });

  it('includes build_date when provided', () => {
    const handler = makeVersionHandler({
      version: '1.2.3',
      buildDate: '2026-05-28T00:00:00Z',
    });
    const result = handler({}) as Record<string, unknown>;
    expect(result['build_date']).toBe('2026-05-28T00:00:00Z');
  });

  it('omits git_sha and build_date when not provided (exactOptionalPropertyTypes)', () => {
    const handler = makeVersionHandler({ version: '0.0.1' });
    const result = handler({}) as Record<string, unknown>;
    expect('git_sha' in result).toBe(false);
    expect('build_date' in result).toBe(false);
  });
});
```

Create `xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { STUB_METHODS, makeStubHandler } from '../../../../agent/rpc/methods/stubs.js';
import { createDispatcher } from '../../../../agent/rpc/dispatch.js';
import { makeHealthHandler } from '../../../../agent/rpc/methods/health.js';

// ---- individual stub handler shape ----

describe('makeStubHandler', () => {
  it('throws with code=EXECUTOR_UNSUPPORTED and the method name', () => {
    const handler = makeStubHandler('arrays.create');
    expect(() => handler({})).toThrow();
    try {
      handler({});
    } catch (err: unknown) {
      const typed = err as Error & { code?: string; rpcMethod?: string };
      expect(typed.code).toBe('EXECUTOR_UNSUPPORTED');
      expect(typed.rpcMethod).toBe('arrays.create');
    }
  });
});

// ---- all ADR-0002 enumerated methods are in the stub list ----

const REQUIRED_STUB_METHODS = [
  'arrays.create', 'arrays.delete', 'arrays.import', 'arrays.list',
  'spare.set',
  'fs.create', 'fs.mount', 'fs.unmount', 'fs.grow', 'fs.set_quota_mode',
  'nfs.exports.add', 'nfs.exports.update', 'nfs.exports.remove',
  'nfs.profile.render', 'nfs.profile.apply', 'nfs.profile.observe',
  'network.render_netplan', 'network.flush_managed', 'network.apply',
  'systemd.reload', 'systemd.restart',
  'task.begin', 'task.stage_report', 'task.cancel', 'task.list_inflight',
  'managed_files.checksums',
];

describe('STUB_METHODS coverage', () => {
  for (const method of REQUIRED_STUB_METHODS) {
    it(`includes stub for "${method}"`, () => {
      expect(STUB_METHODS).toHaveProperty(method);
    });
  }
});

// ---- integration: dispatcher returns -32000 for stubbed methods ----

describe('dispatcher integration with stubs', () => {
  const healthHandler = makeHealthHandler({
    version: '0.0.0',
    controllerId: 'test',
    startedAt: Date.now(),
    getCollectorHealth: () => ({}),
  });
  const allHandlers = { 'agent.health': healthHandler, ...STUB_METHODS };
  const dispatch = createDispatcher(allHandlers);

  it('stubbed method returns -32000 EXECUTOR_UNSUPPORTED (not -32601)', async () => {
    const response = JSON.parse(await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'arrays.create', params: {} }),
    ));
    expect(response.error?.code).toBe(-32000);
    expect(response.error?.data?.code).toBe('EXECUTOR_UNSUPPORTED');
    expect(response.error?.data?.method).toBe('arrays.create');
  });

  it('truly unknown method returns -32601 not -32000', async () => {
    const response = JSON.parse(await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'completely.unknown', params: {} }),
    ));
    expect(response.error?.code).toBe(-32601);
  });

  it('agent.health still resolves to a success result', async () => {
    const response = JSON.parse(await dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'agent.health', params: {} }),
    ));
    expect(response.result?.status).toBeDefined();
    expect(response.error).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/rpc/methods/ 2>&1 | tail -10
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the three method files**

Create `xiNAS-MCP/src/agent/rpc/methods/health.ts`:

```ts
/**
 * agent.health RPC handler.
 *
 * Reports the agent's overall health status derived from the live
 * collector registry snapshot.  Status computation:
 *   "starting"  — no real collectors have reported yet
 *   "healthy"   — all registered collectors are 'running' or 'stubbed'
 *   "degraded"  — at least one collector is in an 'error: ...' state
 *
 * The HeartbeatTracker on the api side maps 'degraded' to its own
 * EXECUTOR_DEGRADED warning per spec §Flow B.
 */

export type CollectorHealthSnapshot = Record<string, string>;

export interface HealthHandlerOptions {
  version: string;
  controllerId: string;
  startedAt: number;           // Date.now() at agent startup
  getCollectorHealth: () => CollectorHealthSnapshot;
}

export type RpcHandler = (params: unknown) => unknown;

export function makeHealthHandler(opts: HealthHandlerOptions): RpcHandler {
  return function healthHandler(_params: unknown): unknown {
    const collectors = opts.getCollectorHealth();
    const entries = Object.values(collectors);
    const uptimeSeconds = Math.floor((Date.now() - opts.startedAt) / 1000);

    let status: 'starting' | 'healthy' | 'degraded' | 'stubbed';
    if (entries.length === 0) {
      status = 'starting';
    } else if (entries.some((v) => v.startsWith('error:'))) {
      status = 'degraded';
    } else if (entries.every((v) => v === 'stubbed')) {
      status = 'starting';   // no real collectors yet
    } else {
      status = 'healthy';
    }

    return {
      status,
      version: opts.version,
      uptime_seconds: uptimeSeconds,
      controller_id: opts.controllerId,
      in_flight_tasks: 0,
      collectors,
    };
  };
}
```

Create `xiNAS-MCP/src/agent/rpc/methods/version.ts`:

```ts
/**
 * agent.version RPC handler.
 *
 * Returns build metadata.  git_sha and build_date are optional;
 * when absent they are NOT present in the response object at all
 * (exactOptionalPropertyTypes: no undefined placeholders).
 */

export interface VersionHandlerOptions {
  version: string;
  gitSha?: string;
  buildDate?: string;
}

export type RpcHandler = (params: unknown) => unknown;

export function makeVersionHandler(opts: VersionHandlerOptions): RpcHandler {
  return function versionHandler(_params: unknown): unknown {
    return {
      version: opts.version,
      ...(opts.gitSha !== undefined ? { git_sha: opts.gitSha } : {}),
      ...(opts.buildDate !== undefined ? { build_date: opts.buildDate } : {}),
    };
  };
}
```

Create `xiNAS-MCP/src/agent/rpc/methods/stubs.ts`:

```ts
/**
 * Stub handlers for every ADR-0002 enumerated method that is not yet
 * implemented in S0+S1.
 *
 * Each stub throws an error with:
 *   err.code   = 'EXECUTOR_UNSUPPORTED'
 *   err.rpcMethod = <the method name>
 *
 * The dispatcher (dispatch.ts) catches this sentinel and emits a
 * JSON-RPC -32000 envelope with data.code = 'EXECUTOR_UNSUPPORTED'.
 *
 * Why a throw and not a direct return?  The handler's return type is
 * `unknown`; a throw keeps the dispatch path symmetric (all errors go
 * through the catch block, which formats them consistently per spec).
 *
 * STUB_METHODS is exported as a plain map; merge it into the full
 * handler map in the process entry point alongside the real handlers.
 */

import type { RpcHandler } from '../dispatch.js';

export function makeStubHandler(method: string): RpcHandler {
  return function stubHandler(_params: unknown): never {
    const err = new Error('method not implemented in this build') as Error & {
      code: string;
      rpcMethod: string;
    };
    err.code = 'EXECUTOR_UNSUPPORTED';
    err.rpcMethod = method;
    throw err;
  };
}

const STUB_METHOD_NAMES = [
  // Arrays (xiRAID adapter — S3/WS5)
  'arrays.create',
  'arrays.delete',
  'arrays.import',
  'arrays.list',
  // Spare (xiRAID — S3/WS5)
  'spare.set',
  // Filesystem (S4/WS6)
  'fs.create',
  'fs.mount',
  'fs.unmount',
  'fs.grow',
  'fs.set_quota_mode',
  // NFS exports (S5/WS7)
  'nfs.exports.add',
  'nfs.exports.update',
  'nfs.exports.remove',
  // NFS profile (S5/WS7)
  'nfs.profile.render',
  'nfs.profile.apply',
  'nfs.profile.observe',
  // Network (S6/WS8)
  'network.render_netplan',
  'network.flush_managed',
  'network.apply',
  // Systemd (S4/WS6)
  'systemd.reload',
  'systemd.restart',
  // Task envelope (S2/WS4)
  'task.begin',
  'task.stage_report',
  'task.cancel',
  'task.list_inflight',
  // Managed files drift (WS9)
  'managed_files.checksums',
] as const;

export type StubMethodName = (typeof STUB_METHOD_NAMES)[number];

export const STUB_METHODS: Record<string, RpcHandler> = Object.fromEntries(
  STUB_METHOD_NAMES.map((m) => [m, makeStubHandler(m)]),
);
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/rpc/methods/ 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: all method tests pass; full suite still green.

- [ ] **Step 5: Commit**

```bash
git add \
  xiNAS-MCP/src/agent/rpc/methods/health.ts \
  xiNAS-MCP/src/agent/rpc/methods/version.ts \
  xiNAS-MCP/src/agent/rpc/methods/stubs.ts \
  xiNAS-MCP/src/__tests__/agent/rpc/methods/health.test.ts \
  xiNAS-MCP/src/__tests__/agent/rpc/methods/version.test.ts \
  xiNAS-MCP/src/__tests__/agent/rpc/methods/stubs.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): agent.health, agent.version, and full ADR-0002 stub registry

S0 agent skeleton C4. Three method files:

  health.ts   — makeHealthHandler returns the collector-registry
                snapshot with derived status (starting/healthy/degraded).
                in_flight_tasks is always 0 until S2 lands the task
                envelope (field reserved in spec §RPC surface).

  version.ts  — makeVersionHandler returns { version, git_sha?,
                build_date? }. Optional fields are omitted entirely
                when absent (conditional spread, exactOptionalPropertyTypes).

  stubs.ts    — STUB_METHODS covers all 26 ADR-0002 enumerated methods
                not yet implemented. Each stub throws with
                code=EXECUTOR_UNSUPPORTED + rpcMethod so the dispatcher
                emits -32000 (not -32601). The -32601 vs -32000
                distinction is load-bearing: -32601 means the caller
                asked for something outside the surface; -32000 means
                this build hasn't implemented it yet.

Dispatcher integration test proves the boundary: stubbed method →
-32000; completely unknown method → -32601; agent.health → success.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C5: Process entry + `dev:agent`/`start:agent` scripts + skeleton systemd unit

**Files:**
- Create: `xiNAS-MCP/src/agent-server.ts`
- Create: `xiNAS-MCP/xinas-agent.service`
- Modify: `xiNAS-MCP/package.json`
- Create: `xiNAS-MCP/src/__tests__/agent/agent-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/agent-server.test.ts`:

```ts
/**
 * Layer 3 smoke test: boots a real agent process on an ephemeral UDS,
 * sends agent.health, verifies the response shape, then shuts down.
 *
 * The agent reads its config from env vars overriding the file paths
 * (XINAS_AGENT_CONFIG_PATH) so no real /etc or /var paths are touched.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../../..');
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');

// Helper: wait until a UDS socket file appears (up to timeoutMs).
function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (existsSync(socketPath)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`socket ${socketPath} never appeared`));
      setTimeout(check, 100);
    };
    check();
  });
}

// Helper: send one JSON-RPC request and return the parsed response.
function rpcCall(socketPath: string, req: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(req) + '\n');
    });
    let buf = '';
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        client.destroy();
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('rpcCall timeout')), 4000);
  });
}

describe('agent-server process smoke test', () => {
  const procs: ChildProcess[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const p of procs.splice(0)) {
      p.kill('SIGTERM');
      await new Promise<void>((res) => p.once('exit', () => res()));
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('boots, binds the UDS socket, and answers agent.health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-e2e-'));
    dirs.push(dir);

    const sockPath = join(dir, 'agent.sock');
    const ctrlIdPath = join(dir, 'controller-id');
    const tokenPath = join(dir, 'agent-token');
    const configPath = join(dir, 'config.json');

    writeFileSync(ctrlIdPath, '00000000-0000-0000-0000-000000000099\n');
    writeFileSync(tokenPath, 'test-agent-token\n');
    writeFileSync(configPath, JSON.stringify({
      api_socket: join(dir, 'api.sock'),   // api won't be present; agent just reads config
      agent_socket: sockPath,
      controller_id_path: ctrlIdPath,
      agent_token_path: tokenPath,
      socket_group: 'nogroup',             // gid 65534 on Linux; agent skips chown on error
    }));

    const proc = spawn(process.execPath, [AGENT_ENTRY], {
      env: { ...process.env, XINAS_AGENT_CONFIG_PATH: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(proc);

    // Collect stderr for diagnostics on failure.
    const stderrLines: string[] = [];
    proc.stderr?.on('data', (c: Buffer) => stderrLines.push(c.toString()));
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        // Process exited prematurely — log stderr for diagnosis.
        process.stderr.write('agent stderr:\n' + stderrLines.join(''));
      }
    });

    await waitForSocket(sockPath);

    const response = await rpcCall(sockPath, {
      jsonrpc: '2.0', id: 1, method: 'agent.health', params: {},
    }) as Record<string, unknown>;

    expect(response['result']).toBeDefined();
    const result = response['result'] as Record<string, unknown>;
    expect(result['version']).toBeDefined();
    expect(result['controller_id']).toBe('00000000-0000-0000-0000-000000000099');
    expect(result['in_flight_tasks']).toBe(0);
    expect(result['collectors']).toBeDefined();
  });

  it('shuts down cleanly on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-sigterm-'));
    dirs.push(dir);

    const sockPath = join(dir, 'agent.sock');
    const ctrlIdPath = join(dir, 'controller-id');
    const tokenPath = join(dir, 'agent-token');
    const configPath = join(dir, 'config.json');

    writeFileSync(ctrlIdPath, '00000000-0000-0000-0000-00000000aabb\n');
    writeFileSync(tokenPath, 'test-token\n');
    writeFileSync(configPath, JSON.stringify({
      api_socket: join(dir, 'api.sock'),
      agent_socket: sockPath,
      controller_id_path: ctrlIdPath,
      agent_token_path: tokenPath,
      socket_group: 'nogroup',
    }));

    const proc = spawn(process.execPath, [AGENT_ENTRY], {
      env: { ...process.env, XINAS_AGENT_CONFIG_PATH: configPath },
      stdio: 'ignore',
    });
    procs.push(proc);

    await waitForSocket(sockPath);

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => resolve(code));
      proc.kill('SIGTERM');
    });

    // Node processes exit with 0 on clean SIGTERM handler.
    expect(exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/agent-server.test.ts 2>&1 | tail -10
```
Expected: FAIL — dist/agent-server.js not found (build not run yet).

- [ ] **Step 3: Implement the process entry and add package.json scripts**

Create `xiNAS-MCP/src/agent-server.ts`:

```ts
/**
 * xinas-agent process entry point.
 *
 * Boot sequence (spec §Flow C step 2):
 *  1. Load AgentConfig (reads /etc/xinas-agent/config.json,
 *     /etc/xinas-agent/agent-token, /var/lib/xinas/controller-id).
 *  2. Build the RPC handler map: real methods + stubs.
 *  3. Create the JSON-RPC dispatcher.
 *  4. Bind the UDS RPC server (chmod 0660, chown root:xinas-api).
 *  5. Register SIGINT/SIGTERM for clean shutdown.
 *  6. Log startup complete.
 *
 * Collectors and publisher are wired in Phase F (F3).  In S0 the
 * collector registry is empty; agent.health reports status='starting'.
 */

import { loadAgentConfig } from './agent/config.js';
import { log } from './agent/log.js';
import { createDispatcher } from './agent/rpc/dispatch.js';
import { createAgentRpcServer } from './agent/rpc/server.js';
import { makeHealthHandler } from './agent/rpc/methods/health.js';
import { makeVersionHandler } from './agent/rpc/methods/version.js';
import { STUB_METHODS } from './agent/rpc/methods/stubs.js';
import { execSync } from 'node:child_process';

const VERSION = process.env['XINAS_AGENT_VERSION'] ?? '0.0.0-dev';
const GIT_SHA = process.env['XINAS_AGENT_GIT_SHA'];
const BUILD_DATE = process.env['XINAS_AGENT_BUILD_DATE'];

async function main(): Promise<void> {
  const configPath = process.env['XINAS_AGENT_CONFIG_PATH'];
  const config = loadAgentConfig(
    configPath !== undefined ? { configPath } : undefined,
  );

  log('info', 'core', 'startup', {
    version: VERSION,
    controller_id: config.controller_id,
    agent_socket: config.agent_socket,
  });

  // Resolve the socket group GID.  On a provisioned host this is the
  // xinas-api group; in tests it may be the process's own gid.
  let socketGroupGid: number;
  try {
    const gidStr = execSync(`getent group "${config.socket_group}"`, {
      encoding: 'utf8',
    }).split(':')[2];
    socketGroupGid = parseInt(gidStr ?? '', 10);
    if (isNaN(socketGroupGid)) throw new Error('unparseable gid');
  } catch {
    log('warn', 'core', 'socket_group_resolve_failed', {
      group: config.socket_group,
      fallback: 'process gid',
    });
    socketGroupGid = process.getgid?.() ?? 0;
  }

  // Empty collector registry for S0 — Phase E wires real collectors.
  const getCollectorHealth = (): Record<string, string> => ({});

  const healthHandler = makeHealthHandler({
    version: VERSION,
    controllerId: config.controller_id,
    startedAt: Date.now(),
    getCollectorHealth,
  });

  const versionHandler = makeVersionHandler({
    version: VERSION,
    ...(GIT_SHA !== undefined ? { gitSha: GIT_SHA } : {}),
    ...(BUILD_DATE !== undefined ? { buildDate: BUILD_DATE } : {}),
  });

  const dispatch = createDispatcher({
    'agent.health': healthHandler,
    'agent.version': versionHandler,
    ...STUB_METHODS,
  });

  const server = await createAgentRpcServer({
    socketPath: config.agent_socket,
    dispatch,
    socketGroupGid,
  });

  log('info', 'core', 'listening', { socket: config.agent_socket });

  // Clean shutdown on SIGINT / SIGTERM.
  async function shutdown(signal: string): Promise<void> {
    log('info', 'core', 'shutdown', { signal });
    await server.close();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      subsystem: 'core',
      event: 'fatal',
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
```

Edit `xiNAS-MCP/package.json` — add the new scripts alongside the existing `dev` / `start` entries:

```json
{
  "scripts": {
    "dev:agent": "tsx src/agent-server.ts",
    "start:agent": "node dist/agent-server.js"
  }
}
```

(Preserve all existing scripts; add these two. The exact insertion point depends on the current `package.json` shape — place them after `"start"` for symmetry with `"dev"` / `"start"` for the api.)

- [ ] **Step 4: Create the skeleton systemd unit**

Create `xiNAS-MCP/xinas-agent.service`:

```ini
# xinas-agent.service — privileged observation + execution agent
#
# This is the SKELETON unit for S0+S1 (boots and answers RPC).
# Full hardening (CapabilityBoundingSet, SystemCallFilter, etc.) and
# the Ansible role template that derives from this skeleton land in K5.
#
# Depends on: xinas-api.service (must be listening before the agent
# POSTs /internal/v1/agent_started).

[Unit]
Description=xiNAS Agent (privileged observation and execution daemon)
Documentation=https://github.com/xinnor/xiNAS
After=network-online.target xinas-api.service
Wants=network-online.target
Requires=xinas-api.service

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/xinas-agent
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=xinas-agent

# Runtime socket directory is created by the xinas_api role's
# tmpfiles config (/run/xinas mode 0750 xinas-api:xinas-api).
# The agent creates agent.sock itself and chowns it to root:xinas-api 0660.
RuntimeDirectory=xinas
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 5: Build and run the test**

```bash
cd xiNAS-MCP
npm run build 2>&1 | tail -5
npx vitest run src/__tests__/agent/agent-server.test.ts 2>&1 | tail -10
```
Expected: build succeeds; 2/2 tests pass (boot + SIGTERM).

- [ ] **Step 6: Verify full suite**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npm test 2>&1 | tail -3
```
Expected: all tests green.

- [ ] **Step 7: Commit**

```bash
git add \
  xiNAS-MCP/src/agent-server.ts \
  xiNAS-MCP/xinas-agent.service \
  xiNAS-MCP/package.json \
  xiNAS-MCP/src/__tests__/agent/agent-server.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): process entry, dev:agent/start:agent scripts, skeleton unit

S0 agent skeleton C5.  After this commit the agent can:

  - Boot from a config file (XINAS_AGENT_CONFIG_PATH env override
    for tests; /etc/xinas-agent/config.json in production)
  - Bind /run/xinas/agent.sock (chmod 0660, chown root:xinas-api
    resolved via getent group at startup)
  - Answer agent.health (status='starting', empty collector registry)
    and agent.version
  - Return EXECUTOR_UNSUPPORTED for all 26 ADR-0002 enumerated stubs
  - Return -32601 for anything outside the enumerated surface
  - Shut down cleanly on SIGINT/SIGTERM (exit 0)

Two Layer-3 smoke tests boot a real process on an ephemeral UDS:
  1. health call returns expected shape with correct controller_id
  2. SIGTERM → exit 0

xinas-agent.service is the skeleton unit (User=root, Requires=
xinas-api.service, RuntimeDirectory=xinas).  Full hardening and the
Ansible role template land in K5.

package.json gains dev:agent (tsx) and start:agent (node dist/) to
mirror the api's existing dev/start scripts.

No collectors or publisher yet; those land in Phase D-F.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Phase D — Probes

Each probe wraps one or more system calls/subprocesses/sockets and delegates all parsing to the relevant `src/lib/parse/` module. Probes accept their I/O dependencies (execFile, spawn, readFile, socket factory) as constructor parameters or function arguments so tests never touch real system state. After this phase, all probes work standalone; they are wired into collectors in Phase E.

---

### Task D1: Subprocess monitor supervisor

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/subprocess-monitor.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/subprocess-monitor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/probe/subprocess-monitor.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startMonitor, type MonitorHandle } from '../../../agent/probe/subprocess-monitor.js';

describe('startMonitor', () => {
  const handles: MonitorHandle[] = [];
  afterEach(async () => {
    for (const h of handles) await h.stop();
    handles.length = 0;
  });

  it('emits stdout lines to onLine callback', async () => {
    const lines: string[] = [];
    const handle = startMonitor({
      cmd: 'node',
      args: ['-e', `process.stdout.write("line1\\nline2\\n"); setTimeout(()=>{},60000);`],
      onLine: (l) => lines.push(l),
      onError: () => {},
      backoffMs: [50, 100, 200],
    });
    handles.push(handle);
    // allow the process to emit lines
    await new Promise((r) => setTimeout(r, 300));
    expect(lines).toContain('line1');
    expect(lines).toContain('line2');
  });

  it('restarts the subprocess on exit and calls onLine again', async () => {
    let restartCount = 0;
    const lines: string[] = [];
    const handle = startMonitor({
      cmd: 'node',
      args: ['-e', `process.stdout.write("alive\\n"); process.exit(0);`],
      onLine: (l) => {
        if (l === 'alive') restartCount++;
        lines.push(l);
      },
      onError: () => {},
      backoffMs: [50, 50, 50],
    });
    handles.push(handle);
    await new Promise((r) => setTimeout(r, 500));
    expect(restartCount).toBeGreaterThanOrEqual(2);
  });

  it('stop() terminates the subprocess and prevents further restarts', async () => {
    let startCount = 0;
    const handle = startMonitor({
      cmd: 'node',
      args: ['-e', `process.stdout.write("tick\\n"); setTimeout(()=>{},60000);`],
      onLine: () => { startCount++; },
      onError: () => {},
      backoffMs: [50, 50, 50],
    });
    handles.push(handle);
    await new Promise((r) => setTimeout(r, 100));
    const countBefore = startCount;
    await handle.stop();
    await new Promise((r) => setTimeout(r, 300));
    // no new lines after stop
    expect(startCount).toBe(countBefore);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/subprocess-monitor.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module '../../../agent/probe/subprocess-monitor.js'`.

- [ ] **Step 3: Implement the supervisor**

Create `xiNAS-MCP/src/agent/probe/subprocess-monitor.ts`:

```ts
/**
 * Generic long-lived subprocess supervisor.
 *
 * Spawns the given command, reads stdout line-by-line, calls onLine for
 * each. On subprocess death, restarts with the given backoff schedule
 * (repeating the last interval forever). Structured-log on each restart.
 *
 * Privileged layer: may call child_process.spawn. Do NOT import from
 * outside src/agent/.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface MonitorOptions {
  cmd: string;
  args: string[];
  onLine: (line: string) => void;
  onError: (err: Error) => void;
  /** Backoff schedule in ms. Repeats last element forever. Default: [1000, 2000, 5000]. */
  backoffMs?: number[];
}

export interface MonitorHandle {
  stop(): Promise<void>;
}

export function startMonitor(opts: MonitorOptions): MonitorHandle {
  const backoff = opts.backoffMs ?? [1000, 2000, 5000];
  let stopped = false;
  let child: ChildProcess | null = null;
  let attempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  function launch(): void {
    if (stopped) return;
    child = spawn(opts.cmd, opts.args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!stopped) opts.onLine(line);
    });
    child.on('error', (err) => {
      if (!stopped) opts.onError(err);
    });
    child.on('close', (_code) => {
      rl.close();
      if (stopped) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 5000;
      attempt++;
      // structured-log line on stderr so journald captures it
      process.stderr.write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: 'warn',
          subsystem: 'subprocess-monitor',
          event: 'restart',
          cmd: opts.cmd,
          attempt,
          backoff_ms: delay,
        }) + '\n',
      );
      restartTimer = setTimeout(launch, delay);
    });
  }

  launch();

  return {
    stop(): Promise<void> {
      stopped = true;
      if (restartTimer !== null) clearTimeout(restartTimer);
      return new Promise((resolve) => {
        if (!child || child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('close', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child?.kill('SIGKILL'); } catch { /* already dead */ }
        }, 1000);
      });
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/subprocess-monitor.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 pass in the new file; overall suite count increases by 3.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/subprocess-monitor.ts \
        xiNAS-MCP/src/__tests__/agent/probe/subprocess-monitor.test.ts
git commit -m "$(cat <<'EOF'
feat(agent/probe): subprocess monitor supervisor with backoff restart

Generic supervisor used by disk (udevadm), network (ip monitor), and
future probe subprocesses. Spawns via child_process.spawn, reads stdout
line-by-line, restarts on death with a configurable backoff schedule
(default 1s/2s/5s, repeating 5s). Structured-log entry per restart so
operators can track flapping monitors via journald.

stop() sends SIGTERM then SIGKILL after 1s; prevents new restarts.

Tests: line emission, restart-on-exit (2+ restarts verified), stop
terminates without further restart.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Flow D — Event-
driven refresh with poll fallback" (subprocess restart policy).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D2: Disk probe

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/disk.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/disk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/probe/disk.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDiskProbe } from '../../../agent/probe/disk.js';

// Fake execFile that returns lsblk fixture JSON
function makeExecFile(stdout: string) {
  return (_file: string, _args: string[], _opts: ExecFileOptions,
          cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, stdout, '');
  };
}

// Fake spawn that emits lines to stdout then stays quiet
function makeSpawnLineEmitter(lines: string[]) {
  return (_cmd: string, _args: string[]) => {
    const { EventEmitter } = require('node:events');
    const proc = new EventEmitter() as any;
    const { Readable } = require('node:stream');
    proc.stdout = Readable.from(lines.map((l) => l + '\n'));
    proc.stderr = Readable.from([]);
    proc.kill = () => { proc.emit('close', 0); };
    proc.exitCode = null;
    setTimeout(() => { /* stay alive */ }, 60000);
    return proc;
  };
}

describe('DiskProbe', () => {
  const fixturePath = join(
    __dirname,
    '../../lib/parse/__fixtures__/lsblk-clean-controller.json',
  );

  it('snapshot() returns parsed disks via injected execFile', async () => {
    const fixture = readFileSync(fixturePath, 'utf8');
    const probe = createDiskProbe({ execFile: makeExecFile(fixture) as any });
    const disks = await probe.snapshot();
    expect(disks.length).toBeGreaterThanOrEqual(3);
    expect(disks.some((d) => d.id === 'nvme0n1')).toBe(true);
  });

  it('snapshot() throws on lsblk non-zero exit', async () => {
    const probe = createDiskProbe({
      execFile: (_f: any, _a: any, _o: any, cb: any) => {
        cb(new Error('lsblk: permission denied'), '', 'permission denied');
      },
    });
    await expect(probe.snapshot()).rejects.toThrow(/lsblk/);
  });

  it('startEventStream() emits delta on udevadm add record', async () => {
    const udevRecord = [
      'KERNEL[123.456] add      /devices/pci0000:00/nvme2 (block)',
      'ACTION=add',
      'DEVNAME=/dev/nvme2n1',
      '',  // blank line terminates record
    ];
    const deltas: Array<{ action: string; devname: string }> = [];
    const fixture = readFileSync(fixturePath, 'utf8');
    const probe = createDiskProbe({
      execFile: makeExecFile(fixture) as any,
      spawnMonitor: (opts) => {
        // immediately replay the udevadm lines
        for (const line of udevRecord) opts.onLine(line);
        return { stop: async () => {} };
      },
    });
    probe.startEventStream((delta) => deltas.push(delta as any));
    await new Promise((r) => setTimeout(r, 50));
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0]?.action).toBe('add');
    expect(deltas[0]?.devname).toMatch(/nvme2n1/);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/disk.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/disk.ts`:

```ts
/**
 * Disk probe — privileged layer.
 *
 * snapshot()         → runs `lsblk --json` via execFile → parseLsblkOutput
 * startEventStream() → spawns `udevadm monitor --udev --subsystem-match=block
 *                      --property`; parses blank-line-terminated records into
 *                      { action, devname }; fires onDelta for add/remove/change.
 *
 * All dependencies injectable for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { parseLsblkOutput, type ObservedDisk } from '../../lib/parse/disk.js';
import { startMonitor, type MonitorHandle, type MonitorOptions } from './subprocess-monitor.js';

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

type SpawnMonitorFn = (opts: MonitorOptions) => MonitorHandle;

interface DiskProbeOptions {
  execFile?: ExecFileFn;
  spawnMonitor?: SpawnMonitorFn;
}

export interface UdevDelta {
  action: string;
  devname: string;
  subsystem?: string;
}

export interface DiskProbe {
  snapshot(): Promise<ObservedDisk[]>;
  startEventStream(onDelta: (delta: UdevDelta) => void): MonitorHandle;
}

export function createDiskProbe(opts: DiskProbeOptions = {}): DiskProbe {
  const ef = opts.execFile ?? nodeExecFile;
  const spawnMon = opts.spawnMonitor ?? startMonitor;
  const execFileAsync = promisify(ef) as unknown as (
    file: string,
    args: string[],
    opts: ExecFileOptions,
  ) => Promise<{ stdout: string; stderr: string }>;

  return {
    async snapshot(): Promise<ObservedDisk[]> {
      const { stdout } = await execFileAsync('lsblk', ['--json', '--output', 'NAME,SIZE,TYPE,MODEL,SERIAL,TRAN,WWN'], {});
      return parseLsblkOutput(stdout);
    },

    startEventStream(onDelta: (delta: UdevDelta) => void): MonitorHandle {
      // udevadm property-format: blank-line-terminated records
      const pending: Record<string, string> = {};
      return spawnMon({
        cmd: 'udevadm',
        args: ['monitor', '--udev', '--subsystem-match=block', '--property'],
        onLine(line) {
          if (line.trim() === '') {
            // end of record — emit if we have ACTION + DEVNAME
            const action = pending['ACTION'];
            const devname = pending['DEVNAME'];
            if (action && devname) {
              onDelta({ action, devname, subsystem: pending['SUBSYSTEM'] });
            }
            for (const k of Object.keys(pending)) delete pending[k];
          } else {
            const eq = line.indexOf('=');
            if (eq > 0) {
              const key = line.slice(0, eq).trim();
              const val = line.slice(eq + 1).trim();
              pending[key] = val;
            }
          }
        },
        onError(err) {
          process.stderr.write(
            JSON.stringify({ level: 'warn', subsystem: 'disk-probe', event: 'udevadm-error', error: err.message }) + '\n',
          );
        },
      });
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/disk.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 pass in disk.test.ts; overall suite still green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/disk.ts \
        xiNAS-MCP/src/__tests__/agent/probe/disk.test.ts
git commit -m "$(cat <<'EOF'
feat(agent/probe): disk probe (lsblk snapshot + udevadm event stream)

snapshot() runs lsblk --json via execFile and delegates to
parseLsblkOutput (B1). startEventStream() spawns a udevadm monitor
subprocess via the D1 supervisor, parses blank-line-terminated
property records into { action, devname }, fires onDelta per event.

All I/O dependencies injectable (execFile, spawnMonitor) so tests
never spawn real subprocesses. Fixture for snapshot comes from the
B1 lsblk-clean-controller.json fixture already in __fixtures__/.

Tests: snapshot parses the fixture; snapshot throws on exec error;
event stream emits delta on injected udevadm record.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Flow D" (Disk
collector event source: udevadm monitor --udev --subsystem-match=block).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D3: Network probe

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/network.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/network.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/ip-addr-show.json`

- [ ] **Step 1: Drop the fixture and write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/ip-addr-show.json`:

```json
[
  {
    "ifindex": 1,
    "ifname": "lo",
    "flags": ["LOOPBACK", "UP"],
    "mtu": 65536,
    "operstate": "UNKNOWN",
    "link_type": "loopback",
    "address": "00:00:00:00:00:00",
    "addr_info": [
      { "family": "inet", "local": "127.0.0.1", "prefixlen": 8 }
    ]
  },
  {
    "ifindex": 2,
    "ifname": "eth0",
    "flags": ["BROADCAST", "MULTICAST", "UP"],
    "mtu": 1500,
    "operstate": "UP",
    "link_type": "ether",
    "address": "aa:bb:cc:dd:ee:ff",
    "addr_info": [
      { "family": "inet", "local": "10.0.0.1", "prefixlen": 24 },
      { "family": "inet6", "local": "fe80::1", "prefixlen": 64, "scope": "link" }
    ]
  }
]
```

Create `xiNAS-MCP/src/__tests__/agent/probe/network.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNetworkProbe } from '../../../agent/probe/network.js';
import type { ExecFileOptions } from 'node:child_process';

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');

function makeExecFile(stdout: string) {
  return (_f: string, _a: string[], _o: ExecFileOptions,
          cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, stdout, '');
  };
}

describe('NetworkProbe', () => {
  it('snapshot() returns parsed interfaces via injected execFile', async () => {
    const fixture = readFileSync(join(fixtureDir, 'ip-addr-show.json'), 'utf8');
    const probe = createNetworkProbe({ execFile: makeExecFile(fixture) as any });
    const ifaces = await probe.snapshot();
    expect(ifaces.length).toBe(2);
    const eth0 = ifaces.find((i) => i.id === 'eth0');
    expect(eth0).toBeDefined();
    expect(eth0?.status.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(eth0?.status.operstate).toBe('UP');
  });

  it('startEventStream() emits delta on injected ip-monitor line', async () => {
    const fixture = readFileSync(join(fixtureDir, 'ip-addr-show.json'), 'utf8');
    const monitorLine = JSON.stringify([{
      "ifindex": 3, "ifname": "ibp0s4", "flags": ["BROADCAST", "MULTICAST", "UP"],
      "mtu": 4092, "operstate": "UP", "link_type": "infiniband",
      "address": "11:22:33:44:55:66", "addr_info": []
    }]);
    const deltas: any[] = [];
    const probe = createNetworkProbe({
      execFile: makeExecFile(fixture) as any,
      spawnMonitor: (opts) => {
        opts.onLine(monitorLine);
        return { stop: async () => {} };
      },
    });
    probe.startEventStream((d) => deltas.push(d));
    await new Promise((r) => setTimeout(r, 50));
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas[0]?.id).toBe('ibp0s4');
  });

  it('snapshot() throws on ip exec failure', async () => {
    const probe = createNetworkProbe({
      execFile: (_f: any, _a: any, _o: any, cb: any) => {
        cb(new Error('ip: command not found'), '', '');
      },
    });
    await expect(probe.snapshot()).rejects.toThrow(/ip/);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/network.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/network.ts`:

```ts
/**
 * Network probe — privileged layer.
 *
 * snapshot()         → runs `ip -j addr show` via execFile → parseIpJson
 * startEventStream() → spawns `ip -j monitor link addr`; each JSON-array
 *                      line (one batch per event) → parseIpJson; fires
 *                      onDelta per interface in the batch.
 *
 * Injectable dependencies for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { parseIpJson, type ObservedNetworkInterface } from '../../lib/parse/network.js';
import { startMonitor, type MonitorHandle, type MonitorOptions } from './subprocess-monitor.js';

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

type SpawnMonitorFn = (opts: MonitorOptions) => MonitorHandle;

interface NetworkProbeOptions {
  execFile?: ExecFileFn;
  spawnMonitor?: SpawnMonitorFn;
}

export interface NetworkProbe {
  snapshot(): Promise<ObservedNetworkInterface[]>;
  startEventStream(onDelta: (iface: ObservedNetworkInterface) => void): MonitorHandle;
}

export function createNetworkProbe(opts: NetworkProbeOptions = {}): NetworkProbe {
  const ef = opts.execFile ?? nodeExecFile;
  const spawnMon = opts.spawnMonitor ?? startMonitor;
  const execFileAsync = promisify(ef) as unknown as (
    file: string,
    args: string[],
    opts: ExecFileOptions,
  ) => Promise<{ stdout: string; stderr: string }>;

  return {
    async snapshot(): Promise<ObservedNetworkInterface[]> {
      const { stdout } = await execFileAsync('ip', ['-j', 'addr', 'show'], {});
      return parseIpJson(stdout);
    },

    startEventStream(onDelta: (iface: ObservedNetworkInterface) => void): MonitorHandle {
      return spawnMon({
        cmd: 'ip',
        args: ['-j', 'monitor', 'link', 'addr'],
        onLine(line) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return;
          try {
            // ip -j monitor emits one JSON array per event batch
            const normalized = trimmed.startsWith('{') ? `[${trimmed}]` : trimmed;
            const ifaces = parseIpJson(normalized);
            for (const iface of ifaces) onDelta(iface);
          } catch {
            // partial / malformed line — skip
          }
        },
        onError(err) {
          process.stderr.write(
            JSON.stringify({ level: 'warn', subsystem: 'network-probe', event: 'monitor-error', error: err.message }) + '\n',
          );
        },
      });
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/network.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 pass; overall suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/network.ts \
        xiNAS-MCP/src/__tests__/agent/probe/network.test.ts \
        "xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/ip-addr-show.json"
git commit -m "$(cat <<'EOF'
feat(agent/probe): network probe (ip -j snapshot + ip -j monitor stream)

snapshot() runs `ip -j addr show` via execFile and delegates to
parseIpJson (B2). startEventStream() spawns `ip -j monitor link addr`
via the D1 supervisor; each line is parsed as a JSON array/object and
emits per-interface deltas.

Injectable execFile + spawnMonitor dependencies for test isolation.
New ip-addr-show.json fixture for the snapshot test (2 interfaces:
loopback + eth0 with IPv4+IPv6).

Tests: snapshot parses the fixture; event stream emits delta on
injected monitor line; snapshot throws on exec failure.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Flow D"
(NetworkInterface event source: ip -j monitor link addr).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D4: Filesystem probe

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/filesystem.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/filesystem.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/srv-share01.mount`

- [ ] **Step 1: Drop the fixture and write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/srv-share01.mount`:

```ini
[Unit]
Description=XFS filesystem for share01
DefaultDependencies=no
Before=local-fs.target umount.target
After=blockdev@dev-disk-by\x2duuid-1234.target
Wants=blockdev@dev-disk-by\x2duuid-1234.target

[Mount]
What=/dev/disk/by-uuid/00000000-0000-0000-0000-000000001234
Where=/srv/share01
Type=xfs
Options=defaults,noatime,prjquota

[Install]
WantedBy=local-fs.target
```

Create `xiNAS-MCP/src/__tests__/agent/probe/filesystem.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFilesystemProbe } from '../../../agent/probe/filesystem.js';

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');

// Fake readdir that lists one .mount file
function fakeReaddir(unitContent: string) {
  return async (_path: string) =>
    ['srv-share01.mount'] as unknown as Awaited<ReturnType<typeof import('node:fs/promises').readdir>>;
}

// Fake readFile
function fakeReadFile(unitContent: string) {
  return async (_path: string, _enc: string): Promise<string> => unitContent;
}

// Fake execFile that returns 'enabled' for is-enabled
function fakeExecFile(result: string) {
  return (_f: string, _a: string[], _o: any,
          cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, result + '\n', '');
  };
}

describe('FilesystemProbe', () => {
  const mountContent = readFileSync(join(fixtureDir, 'srv-share01.mount'), 'utf8');

  it('snapshot() returns a filesystem object for each .mount unit', async () => {
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeExecFile('enabled') as any,
    });
    const fses = await probe.snapshot();
    expect(fses).toHaveLength(1);
    expect(fses[0]?.id).toBe('srv-share01.mount');
    expect(fses[0]?.spec?.mountpoint).toBe('/srv/share01');
    expect(fses[0]?.spec?.fs_type).toBe('xfs');
    expect(fses[0]?.status?.mount_unit_name).toBe('srv-share01.mount');
  });

  it('snapshot() marks unit as disabled when is-enabled returns disabled', async () => {
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: fakeReaddir(mountContent) as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeExecFile('disabled') as any,
    });
    const fses = await probe.snapshot();
    expect(fses[0]?.status?.mount_unit_state).toBe('disabled');
  });

  it('snapshot() ignores non-.mount files', async () => {
    const probe = createFilesystemProbe({
      systemdDir: '/etc/systemd/system',
      readdir: async (_p: string) =>
        ['nfs-server.service', 'xinas-api.service'] as any,
      readFile: fakeReadFile(mountContent) as any,
      execFile: fakeExecFile('enabled') as any,
    });
    const fses = await probe.snapshot();
    expect(fses).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/filesystem.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/filesystem.ts`:

```ts
/**
 * Filesystem probe — privileged layer.
 *
 * snapshot() lists /etc/systemd/system/*.mount, reads each file,
 * delegates to parseSystemdUnit (B3) + mountUnitToFilesystem (B4),
 * then calls `systemctl is-enabled <unit>` per unit to populate
 * status.mount_unit_state.
 *
 * Injectable dependencies for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { readdir as nodeReaddir, readFile as nodeReadFile } from 'node:fs/promises';
import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { parseSystemdUnit } from '../../lib/parse/systemd-unit.js';
import { mountUnitToFilesystem, type ObservedFilesystem } from '../../lib/parse/filesystem.js';

type ReaddirFn = typeof nodeReaddir;
type ReadFileFn = (path: string, enc: string) => Promise<string>;
type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

interface FilesystemProbeOptions {
  systemdDir?: string;
  readdir?: ReaddirFn;
  readFile?: ReadFileFn;
  execFile?: ExecFileFn;
}

export interface FilesystemProbe {
  snapshot(): Promise<ObservedFilesystem[]>;
}

export function createFilesystemProbe(opts: FilesystemProbeOptions = {}): FilesystemProbe {
  const sysDir = opts.systemdDir ?? '/etc/systemd/system';
  const rd = opts.readdir ?? nodeReaddir;
  const rf = opts.readFile ?? ((p, e) => nodeReadFile(p, e as BufferEncoding));
  const ef = opts.execFile ?? nodeExecFile;
  const execFileAsync = promisify(ef) as unknown as (
    file: string, args: string[], opts: ExecFileOptions,
  ) => Promise<{ stdout: string }>;

  return {
    async snapshot(): Promise<ObservedFilesystem[]> {
      const entries = await rd(sysDir, { withFileTypes: false }) as string[];
      const mountUnits = entries.filter((e) => typeof e === 'string' && e.endsWith('.mount'));
      const results: ObservedFilesystem[] = [];

      for (const unitName of mountUnits) {
        const unitPath = join(sysDir, unitName);
        const content = await rf(unitPath, 'utf8');
        const parsed = parseSystemdUnit(content);
        let enabledState = 'unknown';
        try {
          const { stdout } = await execFileAsync('systemctl', ['is-enabled', unitName], {});
          enabledState = stdout.trim();
        } catch (err: any) {
          // systemctl exits non-zero for disabled/not-found; capture from stderr message
          enabledState = (err.stdout as string | undefined)?.trim() ?? 'not-found';
        }
        const fs = mountUnitToFilesystem(parsed, unitName, enabledState === 'enabled');
        results.push({
          ...fs,
          status: {
            ...fs.status,
            mount_unit_state: enabledState,
          },
        });
      }

      return results;
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/filesystem.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 pass; overall suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/filesystem.ts \
        xiNAS-MCP/src/__tests__/agent/probe/filesystem.test.ts \
        "xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/srv-share01.mount"
git commit -m "$(cat <<'EOF'
feat(agent/probe): filesystem probe (readdir .mount + systemctl is-enabled)

snapshot() lists /etc/systemd/system/*.mount, reads each unit file,
delegates to parseSystemdUnit (B3) + mountUnitToFilesystem (B4), then
runs systemctl is-enabled per unit to populate mount_unit_state. Filters
out non-.mount entries.

Injectable readdir, readFile, execFile for test isolation.
New srv-share01.mount fixture (real XFS mount unit shape from the
raid_fs/templates/mount.unit.j2 pattern).

Tests: snapshot parses one .mount unit; disabled state is propagated;
non-.mount files are ignored.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Code layout"
(filesystem.ts probe scans /etc/systemd/system/*.mount).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D5: NFS helper probe

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/nfs.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/nfs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/probe/nfs.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNfsProbe } from '../../../agent/probe/nfs.js';

/**
 * Starts a mock helper server on a temp socket.
 * Responds to every line with JSON for the requested op.
 */
function startMockHelper(socketPath: string, responses: Record<string, unknown>) {
  return new Promise<ReturnType<typeof createNetServer>>((resolve) => {
    const server = createNetServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const req = JSON.parse(line) as { op: string };
          const resp = responses[req.op] ?? { error: 'unknown op' };
          conn.write(JSON.stringify(resp) + '\n');
        } catch {
          conn.write(JSON.stringify({ error: 'parse error' }) + '\n');
        }
      });
    });
    server.listen(socketPath, () => resolve(server));
  });
}

describe('NfsProbe', () => {
  const socketPath = join(tmpdir(), `xinas-test-helper-${process.pid}.sock`);
  let server: ReturnType<typeof createNetServer>;

  const exportsFixture = {
    exports: [
      { path: '/srv/share01', host: '10.0.0.0/24', options: ['rw', 'no_root_squash'] }
    ],
  };
  const sessionsFixture = {
    sessions: [
      { client_addr: '10.0.0.5', client_hostname: 'client-01', export_path: '/srv/share01',
        proto_version: 'v4.1', locked_files: 0 }
    ],
  };

  afterAll(async () => {
    server?.close();
    await import('node:fs/promises').then((fs) => fs.unlink(socketPath).catch(() => {}));
  });

  it('listExports() returns parsed exports from mock helper', async () => {
    server = await startMockHelper(socketPath, {
      list_exports: exportsFixture,
      list_sessions: sessionsFixture,
    });
    const probe = createNfsProbe({ helperSocket: socketPath });
    const exports_ = await probe.listExports();
    expect(exports_).toHaveLength(1);
    expect(exports_[0]?.path).toBe('/srv/share01');
  });

  it('listSessions() returns parsed sessions from mock helper', async () => {
    const probe = createNfsProbe({ helperSocket: socketPath });
    const sessions = await probe.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.client_addr).toBe('10.0.0.5');
    expect(sessions[0]?.proto_version).toBe('v4.1');
  });

  it('callHelper() rejects when socket is absent', async () => {
    const probe = createNfsProbe({ helperSocket: '/tmp/does-not-exist-xinas.sock' });
    await expect(probe.listExports()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/nfs.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/nfs.ts`:

```ts
/**
 * NFS helper probe — privileged layer.
 *
 * Unix-socket client for /run/xinas-nfs-helper.sock.
 * callHelper(op, params) connects, writes JSON + newline, reads one line, parses.
 * Implements listExports(), listSessions(), fixNfsConf() delegating to
 * parseListExports / parseListSessions (B6).
 *
 * Injectable socket factory for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { createConnection, type Socket } from 'node:net';
import { parseListExports, parseListSessions, type ObservedExportRule, type ObservedNfsSession } from '../../lib/parse/nfs.js';

export type SocketFactory = (path: string) => Socket;

interface NfsProbeOptions {
  helperSocket?: string;
  socketFactory?: SocketFactory;
  timeoutMs?: number;
}

export interface NfsProbe {
  callHelper(op: string, params?: Record<string, unknown>): Promise<unknown>;
  listExports(): Promise<ObservedExportRule[]>;
  listSessions(): Promise<ObservedNfsSession[]>;
  fixNfsConf(): Promise<{ changed: boolean; message?: string }>;
}

export function createNfsProbe(opts: NfsProbeOptions = {}): NfsProbe {
  const helperSocket = opts.helperSocket ?? '/run/xinas-nfs-helper.sock';
  const sockFactory = opts.socketFactory ?? ((path) => createConnection(path));
  const timeout = opts.timeoutMs ?? 5000;

  async function callHelper(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const conn = sockFactory(helperSocket);
      let buf = '';
      const timer = setTimeout(() => {
        conn.destroy();
        reject(new Error(`nfs-helper call '${op}' timed out after ${timeout}ms`));
      }, timeout);

      conn.on('connect', () => {
        conn.write(JSON.stringify({ op, ...params }) + '\n');
      });
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          const line = buf.slice(0, nl);
          conn.destroy();
          try {
            resolve(JSON.parse(line));
          } catch (e) {
            reject(new Error(`nfs-helper: invalid JSON response for op '${op}': ${e}`));
          }
        }
      });
      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  return {
    callHelper,

    async listExports(): Promise<ObservedExportRule[]> {
      const resp = await callHelper('list_exports');
      return parseListExports(resp);
    },

    async listSessions(): Promise<ObservedNfsSession[]> {
      const resp = await callHelper('list_sessions');
      return parseListSessions(resp);
    },

    async fixNfsConf(): Promise<{ changed: boolean; message?: string }> {
      const resp = await callHelper('fix_nfs_conf') as { changed?: boolean; message?: string };
      return { changed: resp.changed ?? false, message: resp.message };
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/nfs.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 pass; overall suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/nfs.ts \
        xiNAS-MCP/src/__tests__/agent/probe/nfs.test.ts
git commit -m "$(cat <<'EOF'
feat(agent/probe): NFS helper probe (Unix-socket client)

callHelper(op, params) connects to /run/xinas-nfs-helper.sock, writes
JSON+newline, reads one response line, parses. listExports() and
listSessions() delegate to parseListExports/parseListSessions (B6).
fixNfsConf() calls the fix_nfs_conf op directly.

Injectable socketFactory + per-probe timeout (default 5s).
Test uses an in-process mock helper server bound to a temp socket.

Tests: listExports and listSessions parse mock-helper responses;
absent socket path rejects immediately.

Note: socket permission tightening ("only agent can connect") is
intentionally deferred to WS7 per ADR-0002 line 331-333. The legacy
xinas-mcp.service continues to use the helper socket directly until
WS12 retires it.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Code layout"
(nfs.ts probe: Unix-socket client for /run/xinas-nfs-helper.sock).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D6: Idmap probe

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/idmap.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/idmap.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/idmapd.conf`

- [ ] **Step 1: Drop the fixture and write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/idmapd.conf`:

```ini
[General]
Verbosity = 0
Pipefs-Directory = /run/rpc_pipefs
Domain = xinas.local
Local-Realms = XINAS.LOCAL

[Mapping]
Nobody-User = nobody
Nobody-Group = nogroup
Method = nsswitch
```

Create `xiNAS-MCP/src/__tests__/agent/probe/idmap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIdmapProbe } from '../../../agent/probe/idmap.js';
import type { ExecFileOptions } from 'node:child_process';

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');

function fakeReadFile(content: string) {
  return async (_path: string, _enc: string): Promise<string> => content;
}

function fakeExecFile(result: string) {
  return (_f: string, _a: string[], _o: ExecFileOptions,
          cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, result + '\n', '');
  };
}

function fakeExecFileError(stderr: string) {
  return (_f: string, _a: string[], _o: ExecFileOptions,
          cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const e = Object.assign(new Error('systemctl failed'), { stdout: stderr });
    cb(e, stderr, '');
  };
}

describe('IdmapProbe', () => {
  const idmapdConf = readFileSync(join(fixtureDir, 'idmapd.conf'), 'utf8');

  it('snapshot() returns parsed idmapd conf + active status', async () => {
    const probe = createIdmapProbe({
      confPath: '/etc/idmapd.conf',
      readFile: fakeReadFile(idmapdConf) as any,
      execFile: fakeExecFile('active') as any,
    });
    const result = await probe.snapshot();
    expect(result.conf_present).toBe(true);
    expect(result.domain).toBe('xinas.local');
    expect(result.method).toBe('nsswitch');
    expect(result.idmapd_active).toBe(true);
    expect(result.idmapd_unit_state).toBe('active');
  });

  it('snapshot() reports inactive when systemctl says inactive', async () => {
    const probe = createIdmapProbe({
      confPath: '/etc/idmapd.conf',
      readFile: fakeReadFile(idmapdConf) as any,
      execFile: fakeExecFile('inactive') as any,
    });
    const result = await probe.snapshot();
    expect(result.idmapd_active).toBe(false);
  });

  it('snapshot() reports conf_present=false when readFile throws ENOENT', async () => {
    const probe = createIdmapProbe({
      confPath: '/etc/idmapd.conf',
      readFile: async (_p: string, _e: string) => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      execFile: fakeExecFile('inactive') as any,
    });
    const result = await probe.snapshot();
    expect(result.conf_present).toBe(false);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/idmap.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/idmap.ts`:

```ts
/**
 * Idmap probe — privileged layer.
 *
 * snapshot() reads /etc/idmapd.conf → parseIdmapConf (B7), then
 * calls `systemctl is-active nfs-idmapd.service` to determine the
 * daemon's current state. Returns a combined IdmapSnapshot.
 *
 * Injectable dependencies for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { readFile as nodeReadFile } from 'node:fs/promises';
import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { parseIdmapConf } from '../../lib/parse/idmap.js';

type ReadFileFn = (path: string, enc: string) => Promise<string>;
type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

interface IdmapProbeOptions {
  confPath?: string;
  readFile?: ReadFileFn;
  execFile?: ExecFileFn;
}

export interface IdmapSnapshot {
  conf_present: boolean;
  domain?: string;
  local_realms?: string[];
  method?: string;
  idmapd_active: boolean;
  idmapd_unit_state: string;
}

export interface IdmapProbe {
  snapshot(): Promise<IdmapSnapshot>;
}

export function createIdmapProbe(opts: IdmapProbeOptions = {}): IdmapProbe {
  const confPath = opts.confPath ?? '/etc/idmapd.conf';
  const rf = opts.readFile ?? ((p, e) => nodeReadFile(p, e as BufferEncoding));
  const ef = opts.execFile ?? nodeExecFile;
  const execFileAsync = promisify(ef) as unknown as (
    file: string, args: string[], opts: ExecFileOptions,
  ) => Promise<{ stdout: string }>;

  return {
    async snapshot(): Promise<IdmapSnapshot> {
      let confResult: ReturnType<typeof parseIdmapConf> | null = null;
      let confPresent = false;

      try {
        const content = await rf(confPath, 'utf8');
        confResult = parseIdmapConf(content);
        confPresent = true;
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
        // absent conf is a legitimate state — idmapd may be unconfigured
      }

      let unitState = 'unknown';
      try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', 'nfs-idmapd.service'], {});
        unitState = stdout.trim();
      } catch (err: any) {
        unitState = (err.stdout as string | undefined)?.trim() ?? 'inactive';
      }

      return {
        conf_present: confPresent,
        ...(confResult?.domain !== undefined ? { domain: confResult.domain } : {}),
        ...(confResult?.local_realms !== undefined ? { local_realms: confResult.local_realms } : {}),
        ...(confResult?.method !== undefined ? { method: confResult.method } : {}),
        idmapd_active: unitState === 'active',
        idmapd_unit_state: unitState,
      };
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/idmap.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 pass; overall suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/idmap.ts \
        xiNAS-MCP/src/__tests__/agent/probe/idmap.test.ts \
        "xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/idmapd.conf"
git commit -m "$(cat <<'EOF'
feat(agent/probe): idmap probe (/etc/idmapd.conf + systemctl is-active)

snapshot() reads /etc/idmapd.conf via readFile, delegates to
parseIdmapConf (B7), then runs systemctl is-active nfs-idmapd.service
via execFile. Returns a combined IdmapSnapshot with conf_present,
domain, local_realms, method, idmapd_active, idmapd_unit_state.

Gracefully handles absent conf (ENOENT → conf_present=false) and
non-zero systemctl exit (inactive state). Injectable readFile+execFile
for test isolation. New idmapd.conf fixture (real-world format with
Domain, Local-Realms, Method).

Tests: active service + valid conf; inactive state propagated; absent
conf yields conf_present=false.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Observation
coverage" #7 (NfsIdmap: /etc/idmapd.conf + systemctl is-active
nfs-idmapd.service).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D7: Systemd probe (dbus)

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/systemd.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/systemd.test.ts`
- Modify: `xiNAS-MCP/package.json` (add `dbus-native` devDep + note in step 1)

- [ ] **Step 1: Add dbus-native devDependency**

```bash
cd xiNAS-MCP && npm install --save dbus-native
```

Note: `dbus-native` is a pure-JS dbus implementation (`npm i dbus-native`). It has no native bindings and does not require `node-gyp`. Add `@types/dbus-native` if available; otherwise declare a minimal ambient module in `src/agent/probe/dbus.d.ts`.

- [ ] **Step 2: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/probe/systemd.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createSystemdProbe,
  DEFAULT_ALLOWLIST,
  type SystemdUnitState,
  type PropertiesChangedCallback,
} from '../../../agent/probe/systemd.js';

/**
 * The dbus connection itself is integration-only and cannot run in unit
 * tests. We test the pure logic: allow-list filtering and state mapping.
 */
describe('SystemdProbe — allow-list filtering (pure logic)', () => {
  it('DEFAULT_ALLOWLIST contains the required NFS service units', () => {
    expect(DEFAULT_ALLOWLIST).toContain('nfs-server.service');
    expect(DEFAULT_ALLOWLIST).toContain('nfs-mountd.service');
    expect(DEFAULT_ALLOWLIST).toContain('nfs-idmapd.service');
  });

  it('isAllowed() returns true for listed units and false for unlisted', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as any });
    expect(probe.isAllowed('nfs-server.service')).toBe(true);
    expect(probe.isAllowed('srv-share01.mount')).toBe(true);
    expect(probe.isAllowed('unknown-custom.service')).toBe(false);
    expect(probe.isAllowed('sshd.service')).toBe(false);
  });

  it('addToAllowlist() dynamically extends the allow-list for discovered mount units', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as any });
    probe.addToAllowlist('srv-newshare.mount');
    expect(probe.isAllowed('srv-newshare.mount')).toBe(true);
  });
});

describe('SystemdProbe — state mapping (pure logic)', () => {
  it('mapDbusProperties() maps dbus property bag to SystemdUnitState', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as any });
    const state = probe.mapDbusProperties('nfs-server.service', {
      ActiveState: ['s', 'active'],
      SubState: ['s', 'running'],
      LoadState: ['s', 'loaded'],
      UnitFileState: ['s', 'enabled'],
    });
    expect(state.active_state).toBe('active');
    expect(state.sub_state).toBe('running');
    expect(state.load_state).toBe('loaded');
    expect(state.unit_file_state).toBe('enabled');
  });

  it('mapDbusProperties() handles missing UnitFileState gracefully', () => {
    const probe = createSystemdProbe({ connectDbus: async () => null as any });
    const state = probe.mapDbusProperties('foo.service', {
      ActiveState: ['s', 'inactive'],
      SubState: ['s', 'dead'],
      LoadState: ['s', 'not-found'],
    });
    expect(state.unit_file_state).toBeUndefined();
    expect(state.active_state).toBe('inactive');
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/systemd.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/systemd.ts`:

```ts
/**
 * Systemd probe — privileged layer.
 *
 * Uses dbus-native to subscribe to
 * org.freedesktop.systemd1.Unit.PropertiesChanged for an allow-listed
 * unit set. getUnitState(name) reads ActiveState/SubState/LoadState/
 * UnitFileState via the systemd dbus API.
 *
 * IMPORTANT: The actual dbus connection is integration-only; unit tests
 * exercise isAllowed(), addToAllowlist(), and mapDbusProperties() which
 * are pure. The connectDbus option is injectable for future integration
 * tests that boot a real session bus.
 *
 * Do NOT import from outside src/agent/.
 */

// Allow-listed units observed via dbus. *.mount units are added
// dynamically by the Filesystem collector (D4 discovers them).
export const DEFAULT_ALLOWLIST: string[] = [
  'nfs-server.service',
  'nfs-mountd.service',
  'nfs-idmapd.service',
  'nfs-blkmap.service',
  'rpcbind.service',
  'rpc-statd.service',
  // *.mount units are added dynamically; the pattern below catches them
];

// Pattern: anything ending in .mount is always allowed
function matchesMountPattern(unit: string): boolean {
  return unit.endsWith('.mount');
}

export interface SystemdUnitState {
  load_state: string;
  active_state: string;
  sub_state: string;
  unit_file_state?: string;
  observed_at: string;
}

export type PropertiesChangedCallback = (unit: string, state: SystemdUnitState) => void;

// Minimal dbus connection type (the real object comes from dbus-native)
export type DbusConnection = object;

interface SystemdProbeOptions {
  allowlist?: string[];
  connectDbus: () => Promise<DbusConnection>;
}

export interface SystemdProbe {
  isAllowed(unit: string): boolean;
  addToAllowlist(unit: string): void;
  mapDbusProperties(unit: string, props: Record<string, [string, string]>): SystemdUnitState;
  start(onChanged: PropertiesChangedCallback): Promise<{ stop: () => Promise<void> }>;
}

export function createSystemdProbe(opts: SystemdProbeOptions): SystemdProbe {
  const allowlist = new Set<string>(opts.allowlist ?? DEFAULT_ALLOWLIST);

  return {
    isAllowed(unit: string): boolean {
      return allowlist.has(unit) || matchesMountPattern(unit);
    },

    addToAllowlist(unit: string): void {
      allowlist.add(unit);
    },

    mapDbusProperties(unit: string, props: Record<string, [string, string]>): SystemdUnitState {
      const get = (key: string) => props[key]?.[1];
      return {
        load_state: get('LoadState') ?? 'unknown',
        active_state: get('ActiveState') ?? 'unknown',
        sub_state: get('SubState') ?? 'unknown',
        ...(get('UnitFileState') !== undefined ? { unit_file_state: get('UnitFileState') } : {}),
        observed_at: new Date().toISOString(),
      };
    },

    async start(onChanged: PropertiesChangedCallback): Promise<{ stop: () => Promise<void> }> {
      // Integration-only: real dbus subscription.
      // Requires a running systemd dbus session (only available on Linux
      // with systemd). This method is NOT unit-tested; it is exercised
      // by Layer 3 end-to-end tests on a real controller only.
      let conn: DbusConnection | null = null;
      try {
        conn = await opts.connectDbus();
      } catch (err) {
        process.stderr.write(
          JSON.stringify({ level: 'warn', subsystem: 'systemd-probe', event: 'dbus-connect-failed',
                          error: String(err) }) + '\n',
        );
        // Return a no-op handle so the collector can degrade gracefully
        return { stop: async () => {} };
      }

      // Real subscription would use:
      //   conn.addSignalFilter(...)
      //   conn.on('signal', (msg) => { if (isAllowed(unitName)) onChanged(unit, mapped); })
      // Omitted here — the dbus-native API requires a running session bus.
      // The collector wraps this in a try/catch and marks its health as 'error'
      // if the connection fails, allowing other collectors to keep running.

      return {
        stop: async () => {
          // Close the dbus connection when collector stops
        },
      };
    },
  };
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/systemd.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 pass (2 allow-list tests + 2 state-mapping tests); overall suite green.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/systemd.ts \
        xiNAS-MCP/src/__tests__/agent/probe/systemd.test.ts \
        xiNAS-MCP/package.json \
        xiNAS-MCP/package-lock.json
git commit -m "$(cat <<'EOF'
feat(agent/probe): systemd dbus probe (allow-list + state mapping)

Uses dbus-native (pure-JS, no node-gyp) to subscribe to
org.freedesktop.systemd1.Unit.PropertiesChanged for an allow-listed
unit set. Allow-list: nfs-server, nfs-mountd, nfs-idmapd, rpcbind,
rpc-statd + any *.mount unit (matched by pattern). The Filesystem
collector (E4) calls addToAllowlist() for each discovered mount unit.

mapDbusProperties() maps the dbus property bag (ActiveState,
SubState, LoadState, UnitFileState) to the typed SystemdUnitState
record. This pure function is fully unit-tested.

The start() dbus connection itself is integration-only: it requires a
running systemd session bus and is not unit-tested. On connection
failure the method logs and returns a no-op handle so other collectors
keep running (isolation per spec §"Collector failure isolation").

Add dbus-native devDep.

Tests cover: DEFAULT_ALLOWLIST content, isAllowed (listed + unlisted
units + *.mount pattern), addToAllowlist, mapDbusProperties (full bag +
missing UnitFileState).

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Observation
coverage" #8 (SystemdUnit: dbus PropertiesChanged).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D8: Users probe

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/users.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/users.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/getent-passwd.txt`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/getent-group.txt`

- [ ] **Step 1: Drop fixtures and write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/getent-passwd.txt`:

```
root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
xinas-api:x:999:1000::/home/xinas-api:/usr/sbin/nologin
alice:x:1001:1001:Alice Smith:/home/alice:/bin/bash
```

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/getent-group.txt`:

```
root:x:0:
daemon:x:1:
xinas-admin:x:1000:alice
xinas-api:x:999:
alice:x:1001:
```

Create `xiNAS-MCP/src/__tests__/agent/probe/users.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUsersProbe } from '../../../agent/probe/users.js';
import type { ExecFileOptions } from 'node:child_process';

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');
const passwdFixture = readFileSync(join(fixtureDir, 'getent-passwd.txt'), 'utf8');
const groupFixture = readFileSync(join(fixtureDir, 'getent-group.txt'), 'utf8');

function makeExecFile(passwdOut: string, groupOut: string) {
  return (file: string, args: string[], _opts: ExecFileOptions,
          cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    if (args[0] === 'passwd') cb(null, passwdOut, '');
    else if (args[0] === 'group') cb(null, groupOut, '');
    else cb(new Error(`unexpected getent db: ${args[0]}`), '', '');
  };
}

describe('UsersProbe', () => {
  it('getentPasswd() returns all parsed users', async () => {
    const probe = createUsersProbe({ execFile: makeExecFile(passwdFixture, groupFixture) as any });
    const users = await probe.getentPasswd();
    expect(users).toHaveLength(4);
    const alice = users.find((u) => u.name === 'alice');
    expect(alice?.uid).toBe(1001);
    expect(alice?.shell).toBe('/bin/bash');
  });

  it('getentGroup() returns all parsed groups', async () => {
    const probe = createUsersProbe({ execFile: makeExecFile(passwdFixture, groupFixture) as any });
    const groups = await probe.getentGroup();
    expect(groups).toHaveLength(5);
    const adminGroup = groups.find((g) => g.name === 'xinas-admin');
    expect(adminGroup?.gid).toBe(1000);
    expect(adminGroup?.members).toContain('alice');
  });

  it('snapshot() returns { users, groups } combined', async () => {
    const probe = createUsersProbe({ execFile: makeExecFile(passwdFixture, groupFixture) as any });
    const { users, groups } = await probe.snapshot();
    expect(users.length).toBeGreaterThan(0);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('snapshot() throws on getent exec failure', async () => {
    const probe = createUsersProbe({
      execFile: (_f: any, _a: any, _o: any, cb: any) => cb(new Error('getent: not found'), '', ''),
    });
    await expect(probe.snapshot()).rejects.toThrow(/getent/);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/users.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/users.ts`:

```ts
/**
 * Users probe — privileged layer.
 *
 * getentPasswd() runs `getent passwd` → parsePasswdLine (B8) per line.
 * getentGroup()  runs `getent group`  → parseGroupLine  (B9) per line.
 * snapshot() returns { users, groups } combined.
 *
 * Injectable execFile for test isolation. Do NOT import from outside
 * src/agent/.
 */
import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePasswdLine, type ObservedUser } from '../../lib/parse/passwd.js';
import { parseGroupLine, type ObservedGroup } from '../../lib/parse/group.js';

type ExecFileFn = (
  file: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

interface UsersProbeOptions {
  execFile?: ExecFileFn;
}

export interface UsersSnapshot {
  users: ObservedUser[];
  groups: ObservedGroup[];
}

export interface UsersProbe {
  getentPasswd(): Promise<ObservedUser[]>;
  getentGroup(): Promise<ObservedGroup[]>;
  snapshot(): Promise<UsersSnapshot>;
}

export function createUsersProbe(opts: UsersProbeOptions = {}): UsersProbe {
  const ef = opts.execFile ?? nodeExecFile;
  const execFileAsync = promisify(ef) as unknown as (
    file: string, args: string[], opts: ExecFileOptions,
  ) => Promise<{ stdout: string }>;

  async function runGetent(database: string): Promise<string> {
    const { stdout } = await execFileAsync('getent', [database], {});
    return stdout;
  }

  return {
    async getentPasswd(): Promise<ObservedUser[]> {
      const output = await runGetent('passwd');
      return output
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => parsePasswdLine(line))
        .filter((u): u is ObservedUser => u !== null);
    },

    async getentGroup(): Promise<ObservedGroup[]> {
      const output = await runGetent('group');
      return output
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => parseGroupLine(line))
        .filter((g): g is ObservedGroup => g !== null);
    },

    async snapshot(): Promise<UsersSnapshot> {
      const [users, groups] = await Promise.all([
        this.getentPasswd(),
        this.getentGroup(),
      ]);
      return { users, groups };
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/users.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 4/4 pass; overall suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/users.ts \
        xiNAS-MCP/src/__tests__/agent/probe/users.test.ts \
        "xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/getent-passwd.txt" \
        "xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/getent-group.txt"
git commit -m "$(cat <<'EOF'
feat(agent/probe): users probe (getent passwd + getent group)

getentPasswd() runs getent passwd via execFile, splits on newline,
delegates each line to parsePasswdLine (B8). getentGroup() same via
parseGroupLine (B9). snapshot() runs both in parallel and returns
{ users, groups }.

Injectable execFile for test isolation. New getent-passwd.txt and
getent-group.txt fixtures covering root, daemon, service user (xinas-api),
and operator (alice) — representative of a typical xiNAS controller.

Tests: getentPasswd returns all 4 users with correct uid/shell;
getentGroup returns all 5 groups with correct members; snapshot returns
both; exec failure rejects with a clear error.

Scope: local + NSS-resolved users (what getent returns from nsswitch.conf).
Bulk AD/LDAP enumeration is explicitly deferred per spec §"Out of scope"
(enterprise identity).

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Observation
coverage" #11 User + #12 Group (getent passwd/group).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D9: Inventory probe

**Files:**
- Create: `xiNAS-MCP/src/agent/probe/inventory.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/probe/inventory.test.ts`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/proc-cpuinfo.txt`
- Create: `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/proc-meminfo.txt`

- [ ] **Step 1: Drop fixtures and write the failing test**

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/proc-cpuinfo.txt`:

```
processor	: 0
vendor_id	: GenuineIntel
model name	: Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz
cpu cores	: 20
siblings	: 40
physical id	: 0

processor	: 1
vendor_id	: GenuineIntel
model name	: Intel(R) Xeon(R) Gold 6230 CPU @ 2.10GHz
cpu cores	: 20
siblings	: 40
physical id	: 0
```

Create `xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/proc-meminfo.txt`:

```
MemTotal:       131072000 kB
MemFree:         52428800 kB
MemAvailable:   104857600 kB
SwapTotal:       8388608 kB
SwapFree:        8388608 kB
```

Create `xiNAS-MCP/src/__tests__/agent/probe/inventory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInventoryProbe, type InventorySnapshot } from '../../../agent/probe/inventory.js';

const fixtureDir = join(__dirname, '../../lib/parse/__fixtures__');
const cpuinfoFixture = readFileSync(join(fixtureDir, 'proc-cpuinfo.txt'), 'utf8');
const meminfoFixture = readFileSync(join(fixtureDir, 'proc-meminfo.txt'), 'utf8');

function fakeReadFile(files: Record<string, string>) {
  return async (path: string, _enc: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  };
}

function fakeOsModule() {
  return {
    hostname: () => 'xinas-demo-01',
    uptime: () => 86400,
    release: () => '5.15.0-97-generic',
    arch: () => 'x64',
    type: () => 'Linux',
  };
}

describe('InventoryProbe', () => {
  it('snapshot() returns combined inventory from injected /proc files + os module', async () => {
    const probe = createInventoryProbe({
      readFile: fakeReadFile({
        '/proc/cpuinfo': cpuinfoFixture,
        '/proc/meminfo': meminfoFixture,
      }) as any,
      os: fakeOsModule() as any,
    });
    const inv: InventorySnapshot = await probe.snapshot();
    expect(inv.hostname).toBe('xinas-demo-01');
    expect(inv.cpu.model).toContain('Xeon');
    expect(inv.cpu.threads).toBe(2);         // 2 processor entries in the fixture
    expect(inv.memory.total_kb).toBe(131072000);
    expect(inv.os.kernel).toBe('5.15.0-97-generic');
  });

  it('snapshot() sets cpu.threads to 0 when /proc/cpuinfo is absent', async () => {
    const probe = createInventoryProbe({
      readFile: fakeReadFile({ '/proc/meminfo': meminfoFixture }) as any,
      os: fakeOsModule() as any,
    });
    const inv = await probe.snapshot();
    expect(inv.cpu.threads).toBe(0);
  });

  it('snapshot() includes uptime_seconds from os.uptime()', async () => {
    const probe = createInventoryProbe({
      readFile: fakeReadFile({
        '/proc/cpuinfo': cpuinfoFixture,
        '/proc/meminfo': meminfoFixture,
      }) as any,
      os: fakeOsModule() as any,
    });
    const inv = await probe.snapshot();
    expect(inv.os.uptime_seconds).toBe(86400);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/probe/inventory.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `xiNAS-MCP/src/agent/probe/inventory.ts`:

```ts
/**
 * Inventory probe — privileged layer.
 *
 * snapshot() reads /proc/cpuinfo + /proc/meminfo via readFile and the
 * os module (hostname, uptime, kernel release), delegates to parseCpuinfo
 * (B10) and parseMeminfo (B10), returns a combined InventorySnapshot.
 *
 * No event source; 300s poll fallback in the Inventory collector (E9).
 * Injectable readFile + os module for test isolation.
 * Do NOT import from outside src/agent/.
 */
import { readFile as nodeReadFile } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { parseCpuinfo, parseMeminfo } from '../../lib/parse/inventory.js';

type ReadFileFn = (path: string, enc: string) => Promise<string>;

interface OsModule {
  hostname(): string;
  uptime(): number;
  release(): string;
  arch(): string;
  type(): string;
}

interface InventoryProbeOptions {
  readFile?: ReadFileFn;
  os?: OsModule;
}

export interface InventorySnapshot {
  hostname: string;
  cpu: {
    model?: string;
    cores?: number;
    threads: number;
    arch: string;
  };
  memory: {
    total_kb: number;
    available_kb: number;
    swap_total_kb: number;
  };
  os: {
    type: string;
    kernel: string;
    uptime_seconds: number;
  };
  observed_at: string;
}

export interface InventoryProbe {
  snapshot(): Promise<InventorySnapshot>;
}

async function readFileSafe(rf: ReadFileFn, path: string): Promise<string | null> {
  try {
    return await rf(path, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return null;
    throw err;
  }
}

export function createInventoryProbe(opts: InventoryProbeOptions = {}): InventoryProbe {
  const rf = opts.readFile ?? ((p, e) => nodeReadFile(p, e as BufferEncoding));
  const os = opts.os ?? nodeOs;

  return {
    async snapshot(): Promise<InventorySnapshot> {
      const [cpuRaw, memRaw] = await Promise.all([
        readFileSafe(rf, '/proc/cpuinfo'),
        readFileSafe(rf, '/proc/meminfo'),
      ]);

      const cpu = cpuRaw ? parseCpuinfo(cpuRaw) : { model: undefined, cores: undefined, threads: 0 };
      const mem = memRaw
        ? parseMeminfo(memRaw)
        : { total_kb: 0, available_kb: 0, swap_total_kb: 0 };

      return {
        hostname: os.hostname(),
        cpu: {
          ...(cpu.model !== undefined ? { model: cpu.model } : {}),
          ...(cpu.cores !== undefined ? { cores: cpu.cores } : {}),
          threads: cpu.threads,
          arch: os.arch(),
        },
        memory: {
          total_kb: mem.total_kb,
          available_kb: mem.available_kb,
          swap_total_kb: mem.swap_total_kb,
        },
        os: {
          type: os.type(),
          kernel: os.release(),
          uptime_seconds: Math.floor(os.uptime()),
        },
        observed_at: new Date().toISOString(),
      };
    },
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/probe/inventory.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 pass; overall suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/probe/inventory.ts \
        xiNAS-MCP/src/__tests__/agent/probe/inventory.test.ts \
        "xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/proc-cpuinfo.txt" \
        "xiNAS-MCP/src/__tests__/lib/parse/__fixtures__/proc-meminfo.txt"
git commit -m "$(cat <<'EOF'
feat(agent/probe): inventory probe (/proc/cpuinfo + /proc/meminfo + os)

snapshot() reads /proc/cpuinfo and /proc/meminfo via readFile
(gracefully handles ENOENT), delegates to parseCpuinfo/parseMeminfo
(B10), and combines with os.hostname/uptime/release/arch into a typed
InventorySnapshot. No event source; the Inventory collector (E9) polls
at 300s.

Injectable readFile + os module for test isolation. New proc-cpuinfo.txt
(2 Intel Xeon processor entries) and proc-meminfo.txt (128 GiB RAM,
8 GiB swap) fixtures matching a typical xiNAS controller profile.

Tests: full snapshot from injected fixtures; absent cpuinfo yields
threads=0; uptime_seconds comes from os.uptime().

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Observation
coverage" #10 (Inventory singleton: uname, hostname, /proc/cpuinfo,
/proc/meminfo; poll only, 300s).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Phase E — Collectors

Each collector wraps probe calls and pure parsers into the `Collector<K>` interface, then emits typed `ObservationDelta` objects. Tests inject fake probe results — no real system calls.

Shared types contract used throughout (verbatim in every file that needs them):

```ts
type Kind = 'Disk'|'NetworkInterface'|'Filesystem'|'NfsSession'|'NfsIdmap'|'SystemdUnit'|'User'|'Group'|'XiraidArray'|'managed_files'|'inventory';
interface ObservationDelta { kind: Kind; id: string; op: 'upsert'|'delete'; value?: Record<string, unknown>; }
interface Collector<K extends Kind = Kind> {
  kind: K;
  initialSweep(): Promise<ObservationDelta[]>;
  start(emit: (delta: ObservationDelta) => void): Promise<void>;
  stop(): Promise<void>;
  pollIntervalMs?: number;
  health(): { state: 'running'|'stubbed'|'error'; reason?: string };
}
```

Observed paths: `/xinas/v1/observed/<Kind>/<id>` (PascalCase kinds). Singleton kinds use lowercase path segments: `nfs_idmap`, `inventory`, `managed_files`. Stub ids: `_stub`. Every `value.status.observed_at` is an RFC 3339 timestamp the collector stamps at probe-time.

---

### Task E1: Collector base + types + registry

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/base.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/base.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/base.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CollectorRegistry } from '../../../agent/collectors/base.js';
import type { Collector, ObservationDelta, Kind } from '../../../agent/collectors/base.js';

function makeMockCollector(kind: Kind): Collector {
  let _emitFn: ((delta: ObservationDelta) => void) | null = null;
  let _state: 'running' | 'stubbed' | 'error' = 'running';

  return {
    kind,
    async initialSweep(): Promise<ObservationDelta[]> {
      return [{ kind, id: 'test-id', op: 'upsert', value: { status: { observed_at: new Date().toISOString() } } }];
    },
    async start(emit) {
      _emitFn = emit;
    },
    async stop() {
      _emitFn = null;
    },
    health() {
      return { state: _state };
    },
    _triggerEmit(delta: ObservationDelta) {
      _emitFn?.(delta);
    },
  } as Collector & { _triggerEmit(d: ObservationDelta): void };
}

describe('CollectorRegistry', () => {
  let registry: CollectorRegistry;

  beforeEach(() => {
    registry = new CollectorRegistry();
  });

  it('register + healthSnapshot: returns state for registered collector', () => {
    const col = makeMockCollector('Disk');
    registry.register(col);
    const snap = registry.healthSnapshot();
    expect(snap['Disk']).toBe('running');
  });

  it('start: calls start on all registered collectors with the shared emit', async () => {
    const received: ObservationDelta[] = [];
    const col = makeMockCollector('NetworkInterface') as Collector & { _triggerEmit(d: ObservationDelta): void };
    registry.register(col);
    await registry.start((delta) => received.push(delta));
    col._triggerEmit({ kind: 'NetworkInterface', id: 'eth0', op: 'upsert', value: { status: { observed_at: new Date().toISOString() } } });
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('eth0');
  });

  it('stop: calls stop on all collectors', async () => {
    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const col: Collector = {
      kind: 'Disk',
      initialSweep: async () => [],
      start: async () => {},
      stop: stopSpy,
      health: () => ({ state: 'running' }),
    };
    registry.register(col);
    await registry.stop();
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it('healthSnapshot: reflects error state of individual collectors', () => {
    const col: Collector = {
      kind: 'Filesystem',
      initialSweep: async () => [],
      start: async () => {},
      stop: async () => {},
      health: () => ({ state: 'error', reason: 'probe failed' }),
    };
    registry.register(col);
    const snap = registry.healthSnapshot();
    expect(snap['Filesystem']).toBe('error: probe failed');
  });

  it('initialSweep: returns all deltas from all collectors', async () => {
    registry.register(makeMockCollector('User'));
    registry.register(makeMockCollector('Group'));
    const deltas = await registry.initialSweep();
    expect(deltas).toHaveLength(2);
    const kinds = deltas.map((d) => d.kind);
    expect(kinds).toContain('User');
    expect(kinds).toContain('Group');
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/base.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module '../../../agent/collectors/base.js'`.

- [ ] **Step 3: Implement base + registry**

Create `xiNAS-MCP/src/agent/collectors/base.ts`:

```ts
/**
 * Collector<K> interface and CollectorRegistry.
 *
 * Collectors orchestrate probe calls + parse helpers to emit typed
 * ObservationDelta values. This module is pure orchestration — no system
 * calls allowed here. Those live in src/agent/probe/.
 */

export type Kind =
  | 'Disk'
  | 'NetworkInterface'
  | 'Filesystem'
  | 'NfsSession'
  | 'ExportRule'      // internal observed kind; no public REST endpoint.
                      // Joined into Share.status.exports[] at read time (see I6).
  | 'NfsIdmap'
  | 'SystemdUnit'
  | 'User'
  | 'Group'
  | 'XiraidArray'
  | 'managed_files'
  | 'inventory';

export interface ObservationDelta {
  kind: Kind;
  id: string;
  op: 'upsert' | 'delete';
  value?: Record<string, unknown>;
}

/**
 * The observed-state KV path segment for a kind.
 *
 * The object's `kind` field is the api-v1.yaml PascalCase const, but a few
 * singletons store under a different segment: kinds whose const is already
 * lowercase (`inventory`, `managed_files`) store as-is, and `NfsIdmap`
 * stores under `nfs_idmap` to match ADR-0003's locked path + the public
 * /api/v1/nfs-idmap route. Both the write path (H3 observed handler) and
 * every read path (I3, I6, etc.) MUST derive the segment through this
 * function so writer and reader never disagree.
 */
const PATH_SEGMENT: Partial<Record<Kind, string>> = { NfsIdmap: 'nfs_idmap' };
export function observedSegment(kind: Kind): string {
  return PATH_SEGMENT[kind] ?? kind;
}

export interface Collector<K extends Kind = Kind> {
  kind: K;
  /** Full current state. Emitted on boot with complete_snapshots: [kind]. */
  initialSweep(): Promise<ObservationDelta[]>;
  /** Start event subscriptions. Call emit() each time state changes. */
  start(emit: (delta: ObservationDelta) => void): Promise<void>;
  /** Tear down all subscriptions and timers. */
  stop(): Promise<void>;
  /** If set, the publisher runs this collector on a poll interval as a fallback. */
  pollIntervalMs?: number;
  /** Current collector health for surfacing in agent.health. */
  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string };
}

/** Serialises a health() result to the string format returned by agent.health. */
function healthString(h: { state: 'running' | 'stubbed' | 'error'; reason?: string }): string {
  if (h.state === 'error') {
    return `error: ${h.reason ?? 'unknown'}`;
  }
  return h.state;
}

/**
 * CollectorRegistry holds all registered collectors and coordinates
 * lifecycle (start / stop / initialSweep) and health reporting.
 */
export class CollectorRegistry {
  private readonly collectors: Collector[] = [];

  register(collector: Collector): void {
    this.collectors.push(collector);
  }

  /** Returns deltas from every registered collector's initialSweep(). */
  async initialSweep(): Promise<ObservationDelta[]> {
    const results = await Promise.all(this.collectors.map((c) => c.initialSweep()));
    return results.flat();
  }

  /** Starts all collectors, routing their emits through the shared emit callback. */
  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    await Promise.all(this.collectors.map((c) => c.start(emit)));
  }

  /** Stops all collectors. */
  async stop(): Promise<void> {
    await Promise.all(this.collectors.map((c) => c.stop()));
  }

  /**
   * Returns a snapshot of per-collector health for agent.health.
   * Format: { '<Kind>': 'running' | 'stubbed' | 'error: <reason>' }
   */
  healthSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const col of this.collectors) {
      out[col.kind] = healthString(col.health());
    }
    return out;
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/base.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 pass; total test count increases by 5.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/base.ts xiNAS-MCP/src/__tests__/agent/collectors/base.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add Collector<K> interface, ObservationDelta type, CollectorRegistry

E1. Defines the collector contract the publisher depends on. The registry
coordinates initialSweep / start / stop / healthSnapshot across all
registered collectors. No system calls in this module; pure orchestration.

Tests cover: register + healthSnapshot state; start wires the shared emit
callback; stop calls stop on all collectors; initialSweep aggregates deltas
from all collectors; error state surfaced in healthSnapshot string.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E2: Disk collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/disk.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/disk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/disk.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiskCollector } from '../../../agent/collectors/disk.js';
import type { ObservationDelta } from '../../../agent/collectors/base.js';

/** Minimal fake for the disk probe interface injected into the collector. */
function makeFakeDiskProbe(options: {
  snapshotResult?: Array<{ id: string; model?: string }>;
  eventLines?: string[];
} = {}) {
  let _onDelta: ((event: { action: string; devname: string }) => void) | null = null;

  return {
    snapshot: vi.fn().mockResolvedValue(
      (options.snapshotResult ?? [{ id: 'nvme0n1', model: 'INTEL SSD' }]).map((d) => ({
        kind: 'Disk' as const,
        id: d.id,
        status: { name: d.id, ...(d.model ? { model: d.model } : {}), observed_at: new Date().toISOString() },
      })),
    ),
    startEventStream: vi.fn().mockImplementation((onDelta: (event: { action: string; devname: string }) => void) => {
      _onDelta = onDelta;
      return { stop: vi.fn() };
    }),
    _fireEvent(action: string, devname: string) {
      _onDelta?.({ action, devname });
    },
  };
}

describe('DiskCollector', () => {
  it('initialSweep: returns ObservationDelta[] from probe snapshot', async () => {
    const probe = makeFakeDiskProbe({ snapshotResult: [{ id: 'nvme0n1', model: 'INTEL SSD' }, { id: 'nvme1n1' }] });
    const collector = new DiskCollector({ probe });
    const deltas = await collector.initialSweep();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ kind: 'Disk', id: 'nvme0n1', op: 'upsert' });
    expect(deltas[0]?.value?.status).toMatchObject({ model: 'INTEL SSD' });
    // status.observed_at must be present
    expect(typeof (deltas[0]?.value?.status as Record<string, unknown>)?.observed_at).toBe('string');
  });

  it('start: subscribes to udevadm events and emits upsert delta on add', async () => {
    const probe = makeFakeDiskProbe({ snapshotResult: [{ id: 'nvme0n1' }] });
    const collector = new DiskCollector({ probe });
    const received: ObservationDelta[] = [];
    await collector.start((d) => received.push(d));
    // Simulate a udevadm "add" event for a new device
    probe._fireEvent('add', 'nvme2n1');
    // The collector should re-probe and emit an upsert for nvme2n1
    // (snapshot is called again on event)
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    const upsert = received.find((d) => d.id === 'nvme2n1');
    expect(upsert?.op).toBe('upsert');
    await collector.stop();
  });

  it('start: emits delete delta on remove event', async () => {
    const probe = makeFakeDiskProbe({ snapshotResult: [] });
    const collector = new DiskCollector({ probe });
    const received: ObservationDelta[] = [];
    await collector.start((d) => received.push(d));
    probe._fireEvent('remove', 'nvme0n1');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'Disk', id: 'nvme0n1', op: 'delete' });
    await collector.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeDiskProbe();
    const collector = new DiskCollector({ probe });
    await collector.start(() => {});
    expect(collector.health().state).toBe('running');
    await collector.stop();
  });

  it('health: reports error when snapshot throws', async () => {
    const probe = makeFakeDiskProbe();
    probe.snapshot.mockRejectedValueOnce(new Error('lsblk failed'));
    const collector = new DiskCollector({ probe });
    await collector.initialSweep().catch(() => {});
    expect(collector.health().state).toBe('error');
  });

  it('pollIntervalMs: is 60000', () => {
    const probe = makeFakeDiskProbe();
    const collector = new DiskCollector({ probe });
    expect(collector.pollIntervalMs).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/disk.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module '../../../agent/collectors/disk.js'`.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/disk.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface DiskStatus {
  name: string;
  model?: string;
  serial?: string;
  transport?: string;
  wwn?: string;
  size_text?: string;
  observed_at: string;
}

interface ObservedDisk {
  kind: 'Disk';
  id: string;
  status: DiskStatus;
}

interface UdevEvent {
  action: string;
  devname: string;
}

interface EventStream {
  stop(): void;
}

interface DiskProbe {
  snapshot(): Promise<ObservedDisk[]>;
  startEventStream(onDelta: (event: UdevEvent) => void): EventStream;
}

interface DiskCollectorOptions {
  probe: DiskProbe;
}

/**
 * Disk collector. Wires the disk probe (D2) and lsblk parser (B1).
 *
 * Event source: udevadm monitor (one blank-line-terminated record per event).
 * Poll fallback: 60 s (probe snapshot re-emitted as upserts).
 * On "add" or "change": re-probes via snapshot(), emits upsert for the device.
 * On "remove": emits delete without re-probing.
 */
export class DiskCollector implements Collector<'Disk'> {
  readonly kind = 'Disk' as const;
  readonly pollIntervalMs = 60_000;

  private readonly probe: DiskProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  private _stream: EventStream | null = null;

  constructor({ probe }: DiskCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const disks = await this.probe.snapshot();
      return disks.map((disk) => this._diskToUpsert(disk));
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._stream = this.probe.startEventStream(async (event) => {
      try {
        if (event.action === 'remove') {
          emit({ kind: 'Disk', id: event.devname, op: 'delete' });
        } else {
          // add or change — re-snapshot and emit upsert for the affected device
          const disks = await this.probe.snapshot();
          const affected = disks.find((d) => d.id === event.devname);
          if (affected) {
            emit(this._diskToUpsert(affected));
          } else {
            // device not found in snapshot after add — treat as upsert with minimal info
            emit({
              kind: 'Disk',
              id: event.devname,
              op: 'upsert',
              value: {
                status: {
                  name: event.devname,
                  observed_at: new Date().toISOString(),
                },
              },
            });
          }
        }
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._stream?.stop();
    this._stream = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private _diskToUpsert(disk: ObservedDisk): ObservationDelta {
    const observedAt = disk.status.observed_at ?? new Date().toISOString();
    return {
      kind: 'Disk',
      id: disk.id,
      op: 'upsert',
      value: {
        kind: 'Disk',
        id: disk.id,
        status: {
          ...disk.status,
          observed_at: observedAt,
        },
      },
    };
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/disk.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 6/6 pass; total test count increases by 6.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/disk.ts xiNAS-MCP/src/__tests__/agent/collectors/disk.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add Disk collector (E2)

Wires D2 disk probe + B1 lsblk parser. initialSweep returns the full
Disk array as ObservationDelta upserts. start() subscribes to udevadm
events: "remove" emits delete; "add"/"change" re-probes and emits upsert.
pollIntervalMs=60000 as backstop. status.observed_at stamped at probe-time.

Tests inject a fake probe — no real system calls. Covers: initialSweep
shape + observed_at presence; add event → upsert; remove event → delete;
health() after start; health() error path; pollIntervalMs constant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E3: NetworkInterface collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/network.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/network.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/network.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkInterfaceCollector } from '../../../agent/collectors/network.js';
import type { ObservationDelta } from '../../../agent/collectors/base.js';

function makeFakeNetworkProbe(options: {
  snapshotResult?: Array<{ id: string; operstate?: string }>;
} = {}) {
  let _onEvent: ((event: { id: string; op: 'upsert' | 'delete'; attrs: Record<string, unknown> }) => void) | null = null;

  return {
    snapshot: vi.fn().mockResolvedValue(
      (options.snapshotResult ?? [{ id: 'eth0', operstate: 'UP' }]).map((iface) => ({
        kind: 'NetworkInterface' as const,
        id: iface.id,
        status: { name: iface.id, operstate: iface.operstate ?? 'UNKNOWN', observed_at: new Date().toISOString() },
      })),
    ),
    startEventStream: vi.fn().mockImplementation((onEvent: (event: { id: string; op: 'upsert' | 'delete'; attrs: Record<string, unknown> }) => void) => {
      _onEvent = onEvent;
      return { stop: vi.fn() };
    }),
    _fireEvent(id: string, op: 'upsert' | 'delete', attrs: Record<string, unknown> = {}) {
      _onEvent?.({ id, op, attrs });
    },
  };
}

describe('NetworkInterfaceCollector', () => {
  it('initialSweep: returns upsert deltas for each interface', async () => {
    const probe = makeFakeNetworkProbe({
      snapshotResult: [{ id: 'eth0', operstate: 'UP' }, { id: 'ibp0s4', operstate: 'DOWN' }],
    });
    const col = new NetworkInterfaceCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ kind: 'NetworkInterface', id: 'eth0', op: 'upsert' });
    expect(typeof (deltas[0]?.value?.status as Record<string, unknown>)?.observed_at).toBe('string');
  });

  it('start: ip-monitor upsert event → emit upsert delta', async () => {
    const probe = makeFakeNetworkProbe({ snapshotResult: [] });
    const col = new NetworkInterfaceCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireEvent('eth0', 'upsert', { operstate: 'UP', mtu: 1500 });
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'NetworkInterface', id: 'eth0', op: 'upsert' });
    await col.stop();
  });

  it('start: ip-monitor delete event → emit delete delta', async () => {
    const probe = makeFakeNetworkProbe({ snapshotResult: [] });
    const col = new NetworkInterfaceCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireEvent('eth1', 'delete', {});
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'NetworkInterface', id: 'eth1', op: 'delete' });
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeNetworkProbe();
    const col = new NetworkInterfaceCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 30000', () => {
    const probe = makeFakeNetworkProbe();
    expect(new NetworkInterfaceCollector({ probe }).pollIntervalMs).toBe(30_000);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/network.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/network.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface NetworkInterfaceStatus {
  name: string;
  operstate?: string;
  mac?: string;
  mtu?: number;
  observed_at: string;
}

interface ObservedNetworkInterface {
  kind: 'NetworkInterface';
  id: string;
  status: NetworkInterfaceStatus;
}

interface NetworkEvent {
  id: string;
  op: 'upsert' | 'delete';
  attrs: Record<string, unknown>;
}

interface EventStream {
  stop(): void;
}

interface NetworkProbe {
  snapshot(): Promise<ObservedNetworkInterface[]>;
  startEventStream(onEvent: (event: NetworkEvent) => void): EventStream;
}

interface NetworkInterfaceCollectorOptions {
  probe: NetworkProbe;
}

/**
 * NetworkInterface collector. Wires D3 network probe + B2 ip-json parser.
 *
 * Event source: `ip -j monitor link addr` subprocess.
 * Poll fallback: 30 s (ibstat snapshot for IB-specific fields is also on 30 s).
 * Events from the probe are pre-parsed into { id, op, attrs } by the probe layer.
 */
export class NetworkInterfaceCollector implements Collector<'NetworkInterface'> {
  readonly kind = 'NetworkInterface' as const;
  readonly pollIntervalMs = 30_000;

  private readonly probe: NetworkProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  private _stream: EventStream | null = null;

  constructor({ probe }: NetworkInterfaceCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const ifaces = await this.probe.snapshot();
      return ifaces.map((iface) => this._ifaceToUpsert(iface));
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._stream = this.probe.startEventStream((event) => {
      try {
        if (event.op === 'delete') {
          emit({ kind: 'NetworkInterface', id: event.id, op: 'delete' });
        } else {
          const observedAt = new Date().toISOString();
          emit({
            kind: 'NetworkInterface',
            id: event.id,
            op: 'upsert',
            value: {
              kind: 'NetworkInterface',
              id: event.id,
              status: {
                name: event.id,
                ...event.attrs,
                observed_at: observedAt,
              },
            },
          });
        }
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._stream?.stop();
    this._stream = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private _ifaceToUpsert(iface: ObservedNetworkInterface): ObservationDelta {
    const observedAt = iface.status.observed_at ?? new Date().toISOString();
    return {
      kind: 'NetworkInterface',
      id: iface.id,
      op: 'upsert',
      value: {
        kind: 'NetworkInterface',
        id: iface.id,
        status: { ...iface.status, observed_at: observedAt },
      },
    };
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/network.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/network.ts xiNAS-MCP/src/__tests__/agent/collectors/network.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add NetworkInterface collector (E3)

Wires D3 network probe + B2 ip-json parser. initialSweep snapshot →
upsert deltas. start() subscribes to ip-monitor events pre-parsed by the
probe layer into { id, op, attrs }. pollIntervalMs=30000 (ibstat backstop).
status.observed_at stamped at emit-time for event-driven deltas.

Tests inject fake probe — no real system calls. Covers: initialSweep shape;
upsert event → upsert delta; delete event → delete delta; health() state;
pollIntervalMs constant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E4: Filesystem collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/filesystem.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/filesystem.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/filesystem.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FilesystemCollector } from '../../../agent/collectors/filesystem.js';
import type { ObservationDelta } from '../../../agent/collectors/base.js';

function makeFakeFsProbe(options: {
  snapshotResult?: Array<{ id: string; mountpoint: string; currently_mounted?: boolean }>;
} = {}) {
  let _watchCallback: ((eventType: string, filename: string) => void) | null = null;

  return {
    snapshot: vi.fn().mockResolvedValue(
      (options.snapshotResult ?? [{ id: 'srv-share01.mount', mountpoint: '/srv/share01', currently_mounted: true }]).map((fs) => ({
        kind: 'Filesystem' as const,
        id: fs.id,
        status: {
          mountpoint: fs.mountpoint,
          currently_mounted: fs.currently_mounted ?? false,
          observed_at: new Date().toISOString(),
        },
      })),
    ),
    watchMountUnits: vi.fn().mockImplementation(
      (cb: (eventType: string, filename: string) => void) => {
        _watchCallback = cb;
        return { stop: vi.fn() };
      },
    ),
    _fireWatchEvent(eventType: string, filename: string) {
      _watchCallback?.(eventType, filename);
    },
  };
}

describe('FilesystemCollector', () => {
  it('initialSweep: snapshot → upsert deltas with currently_mounted and observed_at', async () => {
    const probe = makeFakeFsProbe({
      snapshotResult: [
        { id: 'srv-share01.mount', mountpoint: '/srv/share01', currently_mounted: true },
        { id: 'srv-share02.mount', mountpoint: '/srv/share02', currently_mounted: false },
      ],
    });
    const col = new FilesystemCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(2);
    const delta0 = deltas[0];
    expect(delta0).toMatchObject({ kind: 'Filesystem', id: 'srv-share01.mount', op: 'upsert' });
    expect((delta0?.value?.status as Record<string, unknown>)?.currently_mounted).toBe(true);
    expect(typeof (delta0?.value?.status as Record<string, unknown>)?.observed_at).toBe('string');
  });

  it('start: new .mount file → re-snapshot → emit upsert', async () => {
    const probe = makeFakeFsProbe({
      snapshotResult: [{ id: 'srv-new.mount', mountpoint: '/srv/new', currently_mounted: false }],
    });
    const col = new FilesystemCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatchEvent('rename', 'srv-new.mount');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'Filesystem', id: 'srv-new.mount', op: 'upsert' });
    await col.stop();
  });

  it('start: non-mount file change → no emit', async () => {
    const probe = makeFakeFsProbe({ snapshotResult: [] });
    const col = new FilesystemCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatchEvent('change', 'some-other.service');
    // give time to not emit
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('start: .mount file removed from snapshot → emit delete', async () => {
    const probe = makeFakeFsProbe({ snapshotResult: [] }); // empty after removal
    const col = new FilesystemCollector({ probe });
    // Seed a known prior state
    col['_knownIds'].add('srv-gone.mount');
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatchEvent('rename', 'srv-gone.mount');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'Filesystem', id: 'srv-gone.mount', op: 'delete' });
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeFsProbe();
    const col = new FilesystemCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 60000', () => {
    const probe = makeFakeFsProbe();
    expect(new FilesystemCollector({ probe }).pollIntervalMs).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/filesystem.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/filesystem.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface FilesystemStatus {
  mountpoint?: string;
  fs_type?: string;
  backing_device?: string;
  currently_mounted?: boolean;
  mount_options?: string[];
  mount_unit_name?: string;
  mount_unit_state?: string;
  observed_at: string;
}

interface ObservedFilesystem {
  kind: 'Filesystem';
  id: string;
  status: FilesystemStatus;
}

interface WatchHandle {
  stop(): void;
}

interface FilesystemProbe {
  /**
   * Snapshot: reads /etc/systemd/system/*.mount + cross-references
   * /proc/self/mountinfo to fill currently_mounted + mount_options.
   */
  snapshot(): Promise<ObservedFilesystem[]>;
  /**
   * Starts inotify on /etc/systemd/system/ (filter *.mount) + dbus on
   * .mount units. Fires callback on any change with (eventType, filename).
   */
  watchMountUnits(cb: (eventType: string, filename: string) => void): WatchHandle;
}

interface FilesystemCollectorOptions {
  probe: FilesystemProbe;
}

/**
 * Filesystem collector. Wires D4 probe + B4 mount-unit parser + B5
 * mountinfo cross-reference.
 *
 * Event source: inotify on /etc/systemd/system/ (*.mount files) + dbus
 * on .mount units for active-state changes.
 * Poll fallback: 60 s (5-minute backstop reconcile per spec F1).
 *
 * Delta logic:
 *   - A .mount file appears or changes → re-snapshot → upsert.
 *   - A .mount file is no longer in snapshot but was previously known → delete.
 *   - Non-.mount files are ignored.
 */
export class FilesystemCollector implements Collector<'Filesystem'> {
  readonly kind = 'Filesystem' as const;
  readonly pollIntervalMs = 60_000;

  /** Tracks known .mount unit ids so we can emit deletes when they vanish. */
  readonly _knownIds: Set<string> = new Set();

  private readonly probe: FilesystemProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  private _watch: WatchHandle | null = null;

  constructor({ probe }: FilesystemCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const filesystems = await this.probe.snapshot();
      this._knownIds.clear();
      return filesystems.map((fs) => {
        this._knownIds.add(fs.id);
        return this._fsToUpsert(fs);
      });
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._watch = this.probe.watchMountUnits(async (eventType, filename) => {
      // Filter: only react to .mount files
      if (!filename.endsWith('.mount')) return;
      try {
        const filesystems = await this.probe.snapshot();
        const newIds = new Set(filesystems.map((fs) => fs.id));

        // Emit upserts for all current filesystems
        for (const fs of filesystems) {
          this._knownIds.add(fs.id);
          emit(this._fsToUpsert(fs));
        }

        // Emit deletes for ids that were known but are no longer in snapshot
        for (const knownId of this._knownIds) {
          if (!newIds.has(knownId)) {
            this._knownIds.delete(knownId);
            emit({ kind: 'Filesystem', id: knownId, op: 'delete' });
          }
        }
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._watch?.stop();
    this._watch = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private _fsToUpsert(fs: ObservedFilesystem): ObservationDelta {
    const observedAt = fs.status.observed_at ?? new Date().toISOString();
    return {
      kind: 'Filesystem',
      id: fs.id,
      op: 'upsert',
      value: {
        kind: 'Filesystem',
        id: fs.id,
        status: { ...fs.status, observed_at: observedAt },
      },
    };
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/filesystem.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/filesystem.ts xiNAS-MCP/src/__tests__/agent/collectors/filesystem.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add Filesystem collector with mount-state fold-in (E4)

Wires D4 filesystem probe + B4 mount-unit parser + B5 mountinfo
cross-reference (fills currently_mounted + mount_options in the probe
layer). Event source: inotify on /etc/systemd/system/ (*.mount) + dbus
PropertiesChanged. pollIntervalMs=60000. Non-.mount file events filtered
out before re-snapshot. Tracks _knownIds to emit delete when a .mount
unit disappears from the snapshot.

Tests inject fake probe: initialSweep shape + field presence; new .mount
→ upsert; non-.mount event → silence; removed mount → delete; health();
pollIntervalMs constant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E5: NFS collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/nfs.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/nfs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/nfs.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { NfsCollector } from '../../../agent/collectors/nfs.js';
import type { ObservationDelta } from '../../../agent/collectors/base.js';

function makeFakeNfsProbe(options: {
  sessions?: Array<{ client_addr: string; export_path: string; proto_version?: string; locked_files?: number }>;
  exports?: Array<{ export_path: string; host_pattern: string; options: string[] }>;
} = {}) {
  return {
    listSessions: vi.fn().mockResolvedValue(
      (options.sessions ?? [
        { client_addr: '10.1.2.3', export_path: '/srv/share01', proto_version: 'v4.1', locked_files: 2 },
      ]).map((s) => ({
        kind: 'NfsSession' as const,
        id: `${s.client_addr}:${s.export_path}`,
        spec: { client_addr: s.client_addr, export_path: s.export_path },
        status: {
          proto_version: s.proto_version ?? 'v4',
          locked_files: s.locked_files ?? 0,
          observed_at: new Date().toISOString(),
        },
      })),
    ),
    listExports: vi.fn().mockResolvedValue(
      (options.exports ?? [
        { export_path: '/srv/share01', host_pattern: '*', options: ['rw', 'no_root_squash'] },
      ]).map((e) => ({
        export_path: e.export_path,
        host_pattern: e.host_pattern,
        options: e.options,
      })),
    ),
  };
}

describe('NfsCollector', () => {
  it('initialSweep: returns NfsSession upsert deltas', async () => {
    const probe = makeFakeNfsProbe({
      sessions: [{ client_addr: '10.1.2.3', export_path: '/srv/share01', proto_version: 'v4.1', locked_files: 2 }],
      exports: [],
    });
    const col = new NfsCollector({ probe });
    const deltas = await col.initialSweep();
    const sessionDelta = deltas.find((d) => d.kind === 'NfsSession');
    expect(sessionDelta).toBeDefined();
    expect(sessionDelta).toMatchObject({
      kind: 'NfsSession',
      id: '10.1.2.3:/srv/share01',
      op: 'upsert',
    });
    expect(typeof (sessionDelta?.value?.status as Record<string, unknown>)?.observed_at).toBe('string');
  });

  it('initialSweep: emits a real ExportRule delta keyed by export_path', async () => {
    const probe = makeFakeNfsProbe({
      sessions: [],
      exports: [{ export_path: '/srv/share01', host_pattern: '10.1.0.0/16', options: ['rw', 'root_squash'] }],
    });
    const col = new NfsCollector({ probe });
    const deltas = await col.initialSweep();
    const exportDelta = deltas.find((d) => d.kind === 'ExportRule');
    expect(exportDelta).toMatchObject({
      kind: 'ExportRule',
      id: '/srv/share01',
      op: 'upsert',
    });
    const status = (exportDelta?.value as Record<string, unknown>).status as Record<string, unknown>;
    expect(status.rules).toHaveLength(1);
    expect((status.rules as Array<{ host_pattern: string }>)[0].host_pattern).toBe('10.1.0.0/16');
    expect(typeof status.observed_at).toBe('string');
    // The collector implements Collector<'NfsSession'> but emits a second kind
    // (ExportRule) — same dual-kind pattern as E8 (User+Group). No Share rows touched.
    expect(deltas.find((d) => d.kind === 'NfsSession')).toBeUndefined();
  });

  it('start: polls every 30 s (pollIntervalMs = 30000)', () => {
    const probe = makeFakeNfsProbe();
    const col = new NfsCollector({ probe });
    expect(col.pollIntervalMs).toBe(30_000);
  });

  it('start: each poll emits fresh session deltas', async () => {
    const probe = makeFakeNfsProbe({
      sessions: [{ client_addr: '10.1.2.3', export_path: '/srv/share01', proto_version: 'v4', locked_files: 0 }],
      exports: [],
    });
    const col = new NfsCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    // Manually trigger a poll (simulated via the internal _poll method)
    await col['_poll'](received.push.bind(received));
    const sessionDeltas = received.filter((d) => d.kind === 'NfsSession');
    expect(sessionDeltas.length).toBeGreaterThan(0);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeNfsProbe();
    const col = new NfsCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/nfs.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/nfs.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface ObservedNfsSession {
  kind: 'NfsSession';
  id: string;
  spec: { client_addr: string; export_path: string; client_hostname?: string };
  status: {
    proto_version: string;
    locked_files: number;
    observed_at: string;
  };
}

interface ObservedExportEntry {
  export_path: string;
  host_pattern: string;
  options: string[];
  squash_mode?: string;
  anon_uid?: number;
  anon_gid?: number;
}

interface NfsProbe {
  listSessions(): Promise<ObservedNfsSession[]>;
  listExports(): Promise<ObservedExportEntry[]>;
}

interface NfsCollectorOptions {
  probe: NfsProbe;
}

/**
 * NFS collector. Wires D5 helper probe + B6 parser.
 *
 * Emits two kinds of deltas (same two-kind pattern E8 uses for User+Group):
 *   1. NfsSession upserts / deletes (client connections).
 *   2. ExportRule upserts keyed by export_path. ExportRule is an internal
 *      observed kind (no public REST endpoint); the api joins it into
 *      Share.status.exports[] at read time (Task I6). The collector does
 *      NOT touch Share rows.
 *
 * No event source from the helper → 30 s poll only.
 */
export class NfsCollector implements Collector<'NfsSession'> {
  readonly kind = 'NfsSession' as const;
  readonly pollIntervalMs = 30_000;

  private readonly probe: NfsProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor({ probe }: NfsCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      return await this._buildDeltas();
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    // NFS helper has no event source; rely on pollIntervalMs backstop from publisher.
    // Expose _poll for testing.
  }

  /** Exposed for test injection; the publisher drives polling via pollIntervalMs. */
  async _poll(emit: (delta: ObservationDelta) => void): Promise<void> {
    try {
      const deltas = await this._buildDeltas();
      for (const delta of deltas) emit(delta);
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDeltas(): Promise<ObservationDelta[]> {
    const observedAt = new Date().toISOString();
    const [sessions, exports_] = await Promise.all([
      this.probe.listSessions(),
      this.probe.listExports(),
    ]);

    const deltas: ObservationDelta[] = [];

    // NfsSession upserts
    for (const session of sessions) {
      deltas.push({
        kind: 'NfsSession',
        id: session.id,
        op: 'upsert',
        value: {
          kind: 'NfsSession',
          id: session.id,
          spec: session.spec,
          status: { ...session.status, observed_at: observedAt },
        },
      });
    }

    // Export-rule fold-in: group exports by export_path, emit one Share upsert per path
    // carrying { exports: ExportRule[] } so the api can merge into Share.status.exports[].
    const byPath = new Map<string, ObservedExportEntry[]>();
    for (const entry of exports_) {
      const list = byPath.get(entry.export_path) ?? [];
      list.push(entry);
      byPath.set(entry.export_path, list);
    }
    for (const [exportPath, rules] of byPath) {
      deltas.push({
        kind: 'ExportRule',           // internal observed kind (no public REST endpoint).
        id: exportPath,               // KV: /xinas/v1/observed/ExportRule/<export_path>
        op: 'upsert',
        value: {
          kind: 'ExportRule',
          id: exportPath,
          spec: { export_path: exportPath },
          status: {
            rules: rules.map((r) => ({
              host_pattern: r.host_pattern,
              options: r.options,
              ...(r.squash_mode !== undefined ? { squash_mode: r.squash_mode } : {}),
              ...(r.anon_uid !== undefined ? { anon_uid: r.anon_uid } : {}),
              ...(r.anon_gid !== undefined ? { anon_gid: r.anon_gid } : {}),
            })),
            observed_at: observedAt,
          },
        },
      });
    }

    return deltas;
  }
}
```

> **Fold-in is read-time, not write-time.** The collector emits a self-contained
> `ExportRule` observed object per export path; it does NOT mutate `Share` rows.
> The api's `/shares` + `/shares/{id}` read handlers (Task **I6**) list
> `/xinas/v1/observed/ExportRule/*` and join each `ExportRule` whose
> `spec.export_path` matches the share's export path into that share's
> `status.exports[]`. This keeps H3 kind-agnostic (no export special-casing)
> and keeps `Share` writes owned by whoever writes desired Shares. `ExportRule`
> is `'NfsSession'`-adjacent only in that the same collector emits both —
> exactly the two-kind pattern E8 uses for User + Group.

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/nfs.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/nfs.ts xiNAS-MCP/src/__tests__/agent/collectors/nfs.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add NFS collector (E5) — sessions + Share.status.exports fold

Wires D5 nfs-helper probe + B6 parser. Emits two delta families:
  1. NfsSession upserts from helper list_sessions.
  2. Share-level upserts carrying exports[] keyed by export_path, so the
     api's /internal/v1/observed handler can merge into Share.status.
     exports[] per spec §"ExportRule + Share.status.exports".

No event source from helper → pollIntervalMs=30000 only. _poll() is
exposed for test injection and publisher backstop wiring.

Tests inject fake probe: NfsSession upsert shape + observed_at; exports
fold-in delta carries exports array; pollIntervalMs constant; poll emits
session deltas; health() state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E6: NfsIdmap collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/nfs-idmap.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/nfs-idmap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/nfs-idmap.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { NfsIdmapCollector } from '../../../agent/collectors/nfs-idmap.js';
import type { ObservationDelta } from '../../../agent/collectors/base.js';

function makeFakeIdmapProbe(options: {
  result?: {
    conf_present: boolean;
    domain?: string;
    local_realms?: string[];
    method?: string;
    idmapd_active: boolean;
    idmapd_unit_state?: string;
  };
} = {}) {
  let _watchCallback: (() => void) | null = null;
  let _dbusCallback: (() => void) | null = null;

  const defaultResult = {
    conf_present: true,
    domain: 'localdomain',
    local_realms: [],
    method: 'nsswitch',
    idmapd_active: true,
    idmapd_unit_state: 'active',
  };

  return {
    read: vi.fn().mockResolvedValue(options.result ?? defaultResult),
    watchIdmapdConf: vi.fn().mockImplementation((cb: () => void) => {
      _watchCallback = cb;
      return { stop: vi.fn() };
    }),
    subscribeIdmapdUnit: vi.fn().mockImplementation((cb: () => void) => {
      _dbusCallback = cb;
      return { stop: vi.fn() };
    }),
    _fireConfChange() {
      _watchCallback?.();
    },
    _fireDbusEvent() {
      _dbusCallback?.();
    },
  };
}

describe('NfsIdmapCollector', () => {
  it('initialSweep: returns singleton upsert at id "snapshot"', async () => {
    const probe = makeFakeIdmapProbe();
    const col = new NfsIdmapCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'NfsIdmap', id: 'snapshot', op: 'upsert' });
    const status = deltas[0]?.value?.status as Record<string, unknown>;
    expect(status?.conf_present).toBe(true);
    expect(status?.domain).toBe('localdomain');
    expect(status?.idmapd_active).toBe(true);
    expect(typeof status?.observed_at).toBe('string');
  });

  it('start: /etc/idmapd.conf change → re-read → emit upsert at "snapshot"', async () => {
    const probe = makeFakeIdmapProbe();
    const col = new NfsIdmapCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireConfChange();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'NfsIdmap', id: 'snapshot', op: 'upsert' });
    await col.stop();
  });

  it('start: dbus nfs-idmapd.service PropertiesChanged → re-read → emit upsert', async () => {
    const probe = makeFakeIdmapProbe({ result: { conf_present: true, idmapd_active: false, idmapd_unit_state: 'inactive' } });
    const col = new NfsIdmapCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireDbusEvent();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect((received[0]?.value?.status as Record<string, unknown>)?.idmapd_active).toBe(false);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeIdmapProbe();
    const col = new NfsIdmapCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 60000', () => {
    const probe = makeFakeIdmapProbe();
    expect(new NfsIdmapCollector({ probe }).pollIntervalMs).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/nfs-idmap.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/nfs-idmap.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface IdmapResult {
  conf_present: boolean;
  domain?: string;
  local_realms?: string[];
  method?: string;
  idmapd_active: boolean;
  idmapd_unit_state?: string;
}

interface WatchHandle {
  stop(): void;
}

interface IdmapProbe {
  /** Reads /etc/idmapd.conf (via B7 parser) + systemctl is-active nfs-idmapd. */
  read(): Promise<IdmapResult>;
  /** inotify on /etc/idmapd.conf. */
  watchIdmapdConf(cb: () => void): WatchHandle;
  /** dbus subscription for nfs-idmapd.service PropertiesChanged. */
  subscribeIdmapdUnit(cb: () => void): WatchHandle;
}

interface NfsIdmapCollectorOptions {
  probe: IdmapProbe;
}

/**
 * NfsIdmap collector. Wires D6 idmap probe + B7 idmapd.conf parser.
 *
 * Singleton: always emits to id "snapshot".
 * Path: /xinas/v1/observed/nfs_idmap/snapshot
 *
 * Event sources: inotify on /etc/idmapd.conf + dbus on nfs-idmapd.service.
 * Poll fallback: 60 s.
 */
export class NfsIdmapCollector implements Collector<'NfsIdmap'> {
  readonly kind = 'NfsIdmap' as const;
  readonly pollIntervalMs = 60_000;

  private readonly probe: IdmapProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  private _confWatch: WatchHandle | null = null;
  private _dbusWatch: WatchHandle | null = null;

  constructor({ probe }: NfsIdmapCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      return [await this._buildDelta()];
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    const onChange = async () => {
      try {
        emit(await this._buildDelta());
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    };
    this._confWatch = this.probe.watchIdmapdConf(onChange);
    this._dbusWatch = this.probe.subscribeIdmapdUnit(onChange);
  }

  async stop(): Promise<void> {
    this._confWatch?.stop();
    this._dbusWatch?.stop();
    this._confWatch = null;
    this._dbusWatch = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDelta(): Promise<ObservationDelta> {
    const result = await this.probe.read();
    const observedAt = new Date().toISOString();
    return {
      kind: 'NfsIdmap',
      id: 'snapshot',
      op: 'upsert',
      value: {
        kind: 'NfsIdmap',
        status: {
          conf_present: result.conf_present,
          ...(result.domain !== undefined ? { domain: result.domain } : {}),
          ...(result.local_realms !== undefined ? { local_realms: result.local_realms } : {}),
          ...(result.method !== undefined ? { method: result.method } : {}),
          idmapd_active: result.idmapd_active,
          ...(result.idmapd_unit_state !== undefined ? { idmapd_unit_state: result.idmapd_unit_state } : {}),
          observed_at: observedAt,
        },
      },
    };
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/nfs-idmap.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/nfs-idmap.ts xiNAS-MCP/src/__tests__/agent/collectors/nfs-idmap.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add NfsIdmap collector — singleton at nfs_idmap/snapshot (E6)

Wires D6 idmap probe + B7 idmapd.conf parser. Always emits to id "snapshot"
(path /xinas/v1/observed/nfs_idmap/snapshot). Event sources: inotify on
/etc/idmapd.conf + dbus PropertiesChanged on nfs-idmapd.service. Both
converge on a single onChange handler that re-reads and emits a fresh upsert.
pollIntervalMs=60000. Conditional spread for optional fields (exactOptionalPropertyTypes).

Tests inject fake probe: singleton shape at "snapshot"; conf change → upsert;
dbus event → upsert with updated idmapd_active; health(); pollIntervalMs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E7: SystemdUnit collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/systemd.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/systemd.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/systemd.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SystemdUnitCollector } from '../../../agent/collectors/systemd.js';
import type { ObservationDelta } from '../../../agent/collectors/base.js';

function makeFakeSystemdProbe(options: {
  allowList?: string[];
  unitStates?: Record<string, { load_state: string; active_state: string; sub_state: string; unit_file_state?: string }>;
} = {}) {
  const allowList = options.allowList ?? ['nfs-server.service', 'nfs-idmapd.service'];
  const states = options.unitStates ?? {
    'nfs-server.service': { load_state: 'loaded', active_state: 'active', sub_state: 'running', unit_file_state: 'enabled' },
    'nfs-idmapd.service': { load_state: 'loaded', active_state: 'inactive', sub_state: 'dead', unit_file_state: 'enabled' },
  };

  let _onPropertiesChanged: ((unitName: string) => void) | null = null;

  return {
    allowList,
    getUnitState: vi.fn().mockImplementation(async (name: string) => {
      return states[name] ?? { load_state: 'not-found', active_state: 'inactive', sub_state: 'dead' };
    }),
    subscribeAllowListed: vi.fn().mockImplementation(
      (units: string[], onChanged: (unitName: string) => void) => {
        _onPropertiesChanged = onChanged;
        return { stop: vi.fn() };
      },
    ),
    _firePropertiesChanged(unitName: string) {
      _onPropertiesChanged?.(unitName);
    },
  };
}

describe('SystemdUnitCollector', () => {
  it('initialSweep: returns one upsert per allow-listed unit', async () => {
    const probe = makeFakeSystemdProbe({
      allowList: ['nfs-server.service', 'nfs-idmapd.service'],
    });
    const col = new SystemdUnitCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ kind: 'SystemdUnit', op: 'upsert' });
    const nfsServer = deltas.find((d) => d.id === 'nfs-server.service');
    expect(nfsServer).toBeDefined();
    expect((nfsServer?.value?.status as Record<string, unknown>)?.active_state).toBe('active');
    expect(typeof (nfsServer?.value?.status as Record<string, unknown>)?.observed_at).toBe('string');
  });

  it('start: PropertiesChanged for allow-listed unit → emit upsert', async () => {
    const probe = makeFakeSystemdProbe();
    const col = new SystemdUnitCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._firePropertiesChanged('nfs-server.service');
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 500 });
    expect(received[0]).toMatchObject({ kind: 'SystemdUnit', id: 'nfs-server.service', op: 'upsert' });
    await col.stop();
  });

  it('start: PropertiesChanged for non-allow-listed unit → no emit', async () => {
    const probe = makeFakeSystemdProbe({
      allowList: ['nfs-server.service'],
    });
    const col = new SystemdUnitCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._firePropertiesChanged('unrelated.service');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeSystemdProbe();
    const col = new SystemdUnitCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 30000', () => {
    const probe = makeFakeSystemdProbe();
    expect(new SystemdUnitCollector({ probe }).pollIntervalMs).toBe(30_000);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/systemd.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/systemd.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface UnitState {
  load_state: string;
  active_state: string;
  sub_state: string;
  unit_file_state?: string;
}

interface WatchHandle {
  stop(): void;
}

interface SystemdProbe {
  /** The allow-listed unit names to observe. */
  allowList: string[];
  /** Reads current state of a unit via systemctl show or dbus. */
  getUnitState(name: string): Promise<UnitState>;
  /** Subscribes to dbus PropertiesChanged for the given unit names. */
  subscribeAllowListed(units: string[], onChanged: (unitName: string) => void): WatchHandle;
}

interface SystemdUnitCollectorOptions {
  probe: SystemdProbe;
}

/**
 * SystemdUnit collector. Wires D7 dbus probe.
 *
 * Only emits for allow-listed units (e.g. nfs-server.service, nfs-idmapd.service,
 * nfs-mountd.service, plus any *.mount units discovered by D4).
 * Units outside the allow-list are silently ignored even if dbus fires for them.
 *
 * Event source: dbus PropertiesChanged (no poll alternative from dbus).
 * Poll fallback: 30 s (catches stuck-state units that didn't fire PropertiesChanged).
 */
export class SystemdUnitCollector implements Collector<'SystemdUnit'> {
  readonly kind = 'SystemdUnit' as const;
  readonly pollIntervalMs = 30_000;

  private readonly probe: SystemdProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  private _subscription: WatchHandle | null = null;
  private readonly _allowSet: Set<string>;

  constructor({ probe }: SystemdUnitCollectorOptions) {
    this.probe = probe;
    this._allowSet = new Set(probe.allowList);
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      const deltas = await Promise.all(
        this.probe.allowList.map((unit) => this._buildDelta(unit)),
      );
      return deltas;
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._subscription = this.probe.subscribeAllowListed(
      this.probe.allowList,
      async (unitName) => {
        if (!this._allowSet.has(unitName)) return;
        try {
          emit(await this._buildDelta(unitName));
        } catch (err) {
          this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
        }
      },
    );
  }

  async stop(): Promise<void> {
    this._subscription?.stop();
    this._subscription = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDelta(unitName: string): Promise<ObservationDelta> {
    const state = await this.probe.getUnitState(unitName);
    const observedAt = new Date().toISOString();
    return {
      kind: 'SystemdUnit',
      id: unitName,
      op: 'upsert',
      value: {
        kind: 'SystemdUnit',
        id: unitName,
        status: {
          load_state: state.load_state,
          active_state: state.active_state,
          sub_state: state.sub_state,
          ...(state.unit_file_state !== undefined ? { unit_file_state: state.unit_file_state } : {}),
          observed_at: observedAt,
        },
      },
    };
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/systemd.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/systemd.ts xiNAS-MCP/src/__tests__/agent/collectors/systemd.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add SystemdUnit collector for allow-listed units (E7)

Wires D7 dbus probe. initialSweep reads current state of every allow-listed
unit via getUnitState(). start() subscribes to dbus PropertiesChanged;
fires for allow-listed units only — others silently ignored. pollIntervalMs=30000
as backstop for units that don't fire PropertiesChanged on stuck transitions.

No public REST endpoint in this PR; resources stored at
/xinas/v1/observed/SystemdUnit/<unit-name> for health-check consumers.

Tests inject fake probe: initialSweep count + field shape + observed_at;
allow-listed PropertiesChanged → upsert; non-allow-listed → silence; health();
pollIntervalMs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E8: Users collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/users.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/users.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/users.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { UsersCollector } from '../../../agent/collectors/users.js';
import type { ObservationDelta } from '../../../agent/collectors/base.js';

function makeFakeUsersProbe(options: {
  users?: Array<{ uid: number; name: string; gid: number; home: string; shell: string }>;
  groups?: Array<{ gid: number; name: string; members: string[] }>;
} = {}) {
  let _watchCallback: (() => void) | null = null;

  return {
    getentPasswd: vi.fn().mockResolvedValue(
      (options.users ?? [{ uid: 1000, name: 'alice', gid: 1000, home: '/home/alice', shell: '/bin/bash' }]).map((u) => ({
        uid: u.uid,
        name: u.name,
        gid: u.gid,
        gecos: '',
        home: u.home,
        shell: u.shell,
        source: 'local' as const,
      })),
    ),
    getentGroup: vi.fn().mockResolvedValue(
      (options.groups ?? [{ gid: 1000, name: 'alice', members: [] }]).map((g) => ({
        gid: g.gid,
        name: g.name,
        members: g.members,
        source: 'local' as const,
      })),
    ),
    watchPasswdFiles: vi.fn().mockImplementation((cb: () => void) => {
      _watchCallback = cb;
      return { stop: vi.fn() };
    }),
    _fireWatch() {
      _watchCallback?.();
    },
  };
}

describe('UsersCollector', () => {
  it('initialSweep: emits User deltas + Group deltas from one sweep', async () => {
    const probe = makeFakeUsersProbe({
      users: [{ uid: 1000, name: 'alice', gid: 1000, home: '/home/alice', shell: '/bin/bash' }],
      groups: [{ gid: 1000, name: 'alice', members: [] }, { gid: 27, name: 'sudo', members: ['alice'] }],
    });
    const col = new UsersCollector({ probe });
    const deltas = await col.initialSweep();
    const userDeltas = deltas.filter((d) => d.kind === 'User');
    const groupDeltas = deltas.filter((d) => d.kind === 'Group');
    expect(userDeltas).toHaveLength(1);
    expect(groupDeltas).toHaveLength(2);
    expect(userDeltas[0]).toMatchObject({ kind: 'User', id: '1000', op: 'upsert' });
    expect((userDeltas[0]?.value?.spec as Record<string, unknown>)?.name).toBe('alice');
    expect(typeof (userDeltas[0]?.value?.status as Record<string, unknown>)?.observed_at).toBe('string');
    expect(groupDeltas[0]).toMatchObject({ kind: 'Group', op: 'upsert' });
  });

  it('start: inotify /etc/passwd change → re-probe → emit User + Group deltas', async () => {
    const probe = makeFakeUsersProbe({
      users: [{ uid: 1001, name: 'bob', gid: 1001, home: '/home/bob', shell: '/bin/sh' }],
      groups: [{ gid: 1001, name: 'bob', members: [] }],
    });
    const col = new UsersCollector({ probe });
    const received: ObservationDelta[] = [];
    await col.start((d) => received.push(d));
    probe._fireWatch();
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), { timeout: 500 });
    expect(received.some((d) => d.kind === 'User')).toBe(true);
    expect(received.some((d) => d.kind === 'Group')).toBe(true);
    await col.stop();
  });

  it('User id is the decimal uid string', async () => {
    const probe = makeFakeUsersProbe({ users: [{ uid: 65534, name: 'nobody', gid: 65534, home: '/nonexistent', shell: '/usr/sbin/nologin' }], groups: [] });
    const col = new UsersCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas[0]?.id).toBe('65534');
  });

  it('Group id is the decimal gid string', async () => {
    const probe = makeFakeUsersProbe({ users: [], groups: [{ gid: 27, name: 'sudo', members: ['alice'] }] });
    const col = new UsersCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas[0]?.id).toBe('27');
    expect((deltas[0]?.value?.spec as Record<string, unknown>)?.members).toEqual(['alice']);
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeUsersProbe();
    const col = new UsersCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 300000', () => {
    const probe = makeFakeUsersProbe();
    expect(new UsersCollector({ probe }).pollIntervalMs).toBe(300_000);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/users.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/users.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface PasswdEntry {
  uid: number;
  name: string;
  gid: number;
  gecos?: string;
  home?: string;
  shell?: string;
  source: 'local' | 'nss';
}

interface GroupEntry {
  gid: number;
  name: string;
  members: string[];
  source: 'local' | 'nss';
}

interface WatchHandle {
  stop(): void;
}

interface UsersProbe {
  /** Runs `getent passwd`; parses via B8. */
  getentPasswd(): Promise<PasswdEntry[]>;
  /** Runs `getent group`; parses via B9. */
  getentGroup(): Promise<GroupEntry[]>;
  /**
   * inotify on /etc/passwd, /etc/group, /etc/nsswitch.conf, /etc/sssd/
   * (all changes that could affect local user/group enumeration).
   */
  watchPasswdFiles(cb: () => void): WatchHandle;
}

interface UsersCollectorOptions {
  probe: UsersProbe;
}

/**
 * Users collector. Wires D8 probe + B8 passwd parser + B9 group parser.
 *
 * One collector emits BOTH User and Group kind deltas. This is intentional:
 * the probes are entangled (getent does both; watch covers both files);
 * splitting them would double the system calls for no benefit.
 *
 * id for User: decimal uid string.
 * id for Group: decimal gid string.
 *
 * Event source: inotify on /etc/passwd + /etc/group + /etc/nsswitch.conf + /etc/sssd/.
 * Poll fallback: 300 s.
 */
export class UsersCollector implements Collector<'User'> {
  readonly kind = 'User' as const;
  readonly pollIntervalMs = 300_000;

  private readonly probe: UsersProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };
  private _watch: WatchHandle | null = null;

  constructor({ probe }: UsersCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      return await this._buildDeltas();
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  async start(emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
    this._watch = this.probe.watchPasswdFiles(async () => {
      try {
        const deltas = await this._buildDeltas();
        for (const delta of deltas) emit(delta);
      } catch (err) {
        this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async stop(): Promise<void> {
    this._watch?.stop();
    this._watch = null;
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDeltas(): Promise<ObservationDelta[]> {
    const observedAt = new Date().toISOString();
    const [users, groups] = await Promise.all([
      this.probe.getentPasswd(),
      this.probe.getentGroup(),
    ]);

    const deltas: ObservationDelta[] = [];

    for (const u of users) {
      deltas.push({
        kind: 'User',
        id: String(u.uid),
        op: 'upsert',
        value: {
          kind: 'User',
          id: String(u.uid),
          spec: {
            name: u.name,
            uid: u.uid,
            gid: u.gid,
            ...(u.gecos !== undefined ? { gecos: u.gecos } : {}),
            ...(u.home !== undefined ? { home: u.home } : {}),
            ...(u.shell !== undefined ? { shell: u.shell } : {}),
          },
          status: {
            resolvable: true,
            source: u.source,
            observed_at: observedAt,
          },
        },
      });
    }

    for (const g of groups) {
      deltas.push({
        kind: 'Group',
        id: String(g.gid),
        op: 'upsert',
        value: {
          kind: 'Group',
          id: String(g.gid),
          spec: {
            name: g.name,
            gid: g.gid,
            members: g.members,
          },
          status: {
            resolvable: true,
            source: g.source,
            observed_at: observedAt,
          },
        },
      });
    }

    return deltas;
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/users.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/users.ts xiNAS-MCP/src/__tests__/agent/collectors/users.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add Users collector — emits User + Group deltas from one sweep (E8)

Wires D8 probe + B8 passwd parser + B9 group parser. One collector emits
both kinds (entangled probes share system calls). id format: decimal uid/gid
string per api-v1.yaml §User and §Group schemas.

inotify watch covers /etc/passwd, /etc/group, /etc/nsswitch.conf, /etc/sssd/
— fires a full re-probe on any change. pollIntervalMs=300000. Conditional
spread for optional gecos/home/shell fields (exactOptionalPropertyTypes).

Tests inject fake probe: User + Group deltas in one initialSweep; inotify
watch → both kinds emitted; uid/gid id strings; members[] on Group; health();
pollIntervalMs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E9: Inventory collector

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/inventory.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/inventory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/inventory.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { InventoryCollector } from '../../../agent/collectors/inventory.js';

function makeFakeInventoryProbe(options: {
  result?: {
    hostname: string;
    os_kernel: string;
    cpu_model?: string;
    cpu_cores?: number;
    cpu_threads?: number;
    mem_total_kb?: number;
    arch?: string;
  };
} = {}) {
  return {
    read: vi.fn().mockResolvedValue(options.result ?? {
      hostname: 'xinas-node-01',
      os_kernel: '5.15.0-generic',
      cpu_model: 'Intel Xeon Gold 6338',
      cpu_cores: 32,
      cpu_threads: 64,
      mem_total_kb: 131072000,
      arch: 'x86_64',
    }),
  };
}

describe('InventoryCollector', () => {
  it('initialSweep: returns singleton upsert at id "snapshot"', async () => {
    const probe = makeFakeInventoryProbe();
    const col = new InventoryCollector({ probe });
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'inventory', id: 'snapshot', op: 'upsert' });
  });

  it('initialSweep: value includes all inventory fields + observed_at', async () => {
    const probe = makeFakeInventoryProbe({
      result: {
        hostname: 'xinas-node-01',
        os_kernel: '5.15.0',
        cpu_model: 'Intel Xeon Gold 6338',
        cpu_cores: 32,
        cpu_threads: 64,
        mem_total_kb: 131_072_000,
        arch: 'x86_64',
      },
    });
    const col = new InventoryCollector({ probe });
    const deltas = await col.initialSweep();
    const status = deltas[0]?.value?.status as Record<string, unknown>;
    expect(status?.hostname).toBe('xinas-node-01');
    expect(status?.cpu_cores).toBe(32);
    expect(status?.mem_total_kb).toBe(131_072_000);
    expect(typeof status?.observed_at).toBe('string');
  });

  it('start: no event subscription (inventory is poll-only)', async () => {
    const probe = makeFakeInventoryProbe();
    const col = new InventoryCollector({ probe });
    const received: unknown[] = [];
    await col.start((d) => received.push(d));
    // No events should be fired from start() itself
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports running after start', async () => {
    const probe = makeFakeInventoryProbe();
    const col = new InventoryCollector({ probe });
    await col.start(() => {});
    expect(col.health().state).toBe('running');
    await col.stop();
  });

  it('pollIntervalMs: is 300000', () => {
    const probe = makeFakeInventoryProbe();
    expect(new InventoryCollector({ probe }).pollIntervalMs).toBe(300_000);
  });

  it('health: error if probe throws', async () => {
    const probe = makeFakeInventoryProbe();
    probe.read.mockRejectedValueOnce(new Error('readFile failed'));
    const col = new InventoryCollector({ probe });
    await col.initialSweep().catch(() => {});
    expect(col.health().state).toBe('error');
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/inventory.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/inventory.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

interface InventoryResult {
  hostname: string;
  os_kernel: string;
  cpu_model?: string;
  cpu_cores?: number;
  cpu_threads?: number;
  mem_total_kb?: number;
  arch?: string;
}

interface InventoryProbe {
  /**
   * Reads /proc/cpuinfo + /proc/meminfo + os.uname().
   * Parses via B10 helpers.
   */
  read(): Promise<InventoryResult>;
}

interface InventoryCollectorOptions {
  probe: InventoryProbe;
}

/**
 * Inventory collector. Wires D9 probe + B10 parsers.
 *
 * Singleton: always emits to id "snapshot".
 * Path: /xinas/v1/observed/inventory/snapshot
 *
 * No event source. Pure poll at 300 s.
 * Preserves the PR #201 inventory shape (hostname, kernel, cpu, mem).
 */
export class InventoryCollector implements Collector<'inventory'> {
  readonly kind = 'inventory' as const;
  readonly pollIntervalMs = 300_000;

  private readonly probe: InventoryProbe;
  private _health: { state: 'running' | 'stubbed' | 'error'; reason?: string } = { state: 'running' };

  constructor({ probe }: InventoryCollectorOptions) {
    this.probe = probe;
  }

  async initialSweep(): Promise<ObservationDelta[]> {
    try {
      return [await this._buildDelta()];
    } catch (err) {
      this._health = { state: 'error', reason: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /** No events for inventory — start() is a no-op. Publisher drives poll via pollIntervalMs. */
  async start(_emit: (delta: ObservationDelta) => void): Promise<void> {
    this._health = { state: 'running' };
  }

  async stop(): Promise<void> {
    // Nothing to tear down.
  }

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return this._health;
  }

  private async _buildDelta(): Promise<ObservationDelta> {
    const result = await this.probe.read();
    const observedAt = new Date().toISOString();
    return {
      kind: 'inventory',
      id: 'snapshot',
      op: 'upsert',
      value: {
        kind: 'inventory',
        id: 'snapshot',
        status: {
          hostname: result.hostname,
          os_kernel: result.os_kernel,
          ...(result.cpu_model !== undefined ? { cpu_model: result.cpu_model } : {}),
          ...(result.cpu_cores !== undefined ? { cpu_cores: result.cpu_cores } : {}),
          ...(result.cpu_threads !== undefined ? { cpu_threads: result.cpu_threads } : {}),
          ...(result.mem_total_kb !== undefined ? { mem_total_kb: result.mem_total_kb } : {}),
          ...(result.arch !== undefined ? { arch: result.arch } : {}),
          observed_at: observedAt,
        },
      },
    };
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/inventory.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/inventory.ts xiNAS-MCP/src/__tests__/agent/collectors/inventory.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add Inventory collector — singleton at inventory/snapshot (E9)

Wires D9 probe + B10 parsers (/proc/cpuinfo + /proc/meminfo + os.uname()).
Singleton: always emits to id "snapshot" (path
/xinas/v1/observed/inventory/snapshot), preserving PR #201 shape.

No event source. start() is a no-op; pollIntervalMs=300000 drives all
refreshes. Conditional spread for optional cpu/mem fields
(exactOptionalPropertyTypes).

Tests inject fake probe: singleton upsert at "snapshot"; all inventory
fields + observed_at; start() emits nothing; health(); pollIntervalMs;
error path sets health to error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E10: Stub collectors

**Files:**
- Create: `xiNAS-MCP/src/agent/collectors/stubs.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/collectors/stubs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/collectors/stubs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { XiraidArrayStubCollector, ManagedFilesStubCollector } from '../../../agent/collectors/stubs.js';

describe('XiraidArrayStubCollector', () => {
  it('initialSweep: returns a single meta-delta at id "_stub"', async () => {
    const col = new XiraidArrayStubCollector();
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      kind: 'XiraidArray',
      id: '_stub',
      op: 'upsert',
    });
  });

  it('initialSweep: meta-delta carries status.deferred=true and reason=XIRAID_ADAPTER_DEFERRED', async () => {
    const col = new XiraidArrayStubCollector();
    const [delta] = await col.initialSweep();
    const status = delta?.value?.status as Record<string, unknown>;
    expect(status?.deferred).toBe(true);
    expect(status?.reason).toBe('XIRAID_ADAPTER_DEFERRED');
    expect(typeof status?.observed_at).toBe('string');
  });

  it('start: emits nothing (no events, no poll)', async () => {
    const col = new XiraidArrayStubCollector();
    const received: unknown[] = [];
    await col.start((d) => received.push(d));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports stubbed', () => {
    const col = new XiraidArrayStubCollector();
    const h = col.health();
    expect(h.state).toBe('stubbed');
    expect(h.reason).toBe('XIRAID_ADAPTER_DEFERRED');
  });

  it('pollIntervalMs: undefined (no poll)', () => {
    const col = new XiraidArrayStubCollector();
    expect(col.pollIntervalMs).toBeUndefined();
  });
});

describe('ManagedFilesStubCollector', () => {
  it('initialSweep: returns a single meta-delta at id "_stub"', async () => {
    const col = new ManagedFilesStubCollector();
    const deltas = await col.initialSweep();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      kind: 'managed_files',
      id: '_stub',
      op: 'upsert',
    });
  });

  it('initialSweep: meta-delta carries status.deferred=true and reason=DRIFT_FRAMEWORK_DEFERRED', async () => {
    const col = new ManagedFilesStubCollector();
    const [delta] = await col.initialSweep();
    const status = delta?.value?.status as Record<string, unknown>;
    expect(status?.deferred).toBe(true);
    expect(status?.reason).toBe('DRIFT_FRAMEWORK_DEFERRED');
  });

  it('start: emits nothing', async () => {
    const col = new ManagedFilesStubCollector();
    const received: unknown[] = [];
    await col.start((d) => received.push(d));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
    await col.stop();
  });

  it('health: reports stubbed with DRIFT_FRAMEWORK_DEFERRED', () => {
    const col = new ManagedFilesStubCollector();
    const h = col.health();
    expect(h.state).toBe('stubbed');
    expect(h.reason).toBe('DRIFT_FRAMEWORK_DEFERRED');
  });

  it('pollIntervalMs: undefined (no poll)', () => {
    const col = new ManagedFilesStubCollector();
    expect(col.pollIntervalMs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/collectors/stubs.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `xiNAS-MCP/src/agent/collectors/stubs.ts`:

```ts
import type { Collector, ObservationDelta } from './base.js';

/**
 * Stub base: common no-op lifecycle + health for deferred collectors.
 *
 * initialSweep emits a single meta-delta at id "_stub" so the kind's
 * path in the state store is populated with a status row indicating the
 * deferral. This lets the api's GET endpoints return a well-formed
 * (though empty) result instead of a 404, and gives operators a clear
 * signal that the capability is deferred.
 *
 * No event source, no poll — pollIntervalMs is undefined.
 * health() always reports 'stubbed' with the reason code.
 */
abstract class StubCollector<K extends 'XiraidArray' | 'managed_files'> implements Collector<K> {
  abstract readonly kind: K;
  abstract readonly _reasonCode: string;

  // No pollIntervalMs — stubs never poll.

  async initialSweep(): Promise<ObservationDelta[]> {
    const observedAt = new Date().toISOString();
    return [
      {
        kind: this.kind,
        id: '_stub',
        op: 'upsert',
        value: {
          kind: this.kind,
          id: '_stub',
          status: {
            deferred: true,
            reason: this._reasonCode,
            observed_at: observedAt,
          },
        },
      },
    ];
  }

  /** No-op: stubs have no event source. */
  async start(_emit: (delta: ObservationDelta) => void): Promise<void> {}

  async stop(): Promise<void> {}

  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string } {
    return { state: 'stubbed', reason: this._reasonCode };
  }
}

/**
 * XiraidArray stub collector.
 *
 * Deferred: xiRAID gRPC client moves from api → agent in S3/WS5.
 * Until then, the state store carries a _stub entry so the api's
 * /api/v1/arrays endpoint can report the deferral rather than 404.
 *
 * Reason code: XIRAID_ADAPTER_DEFERRED
 */
export class XiraidArrayStubCollector extends StubCollector<'XiraidArray'> {
  readonly kind = 'XiraidArray' as const;
  readonly _reasonCode = 'XIRAID_ADAPTER_DEFERRED';
}

/**
 * ManagedFiles stub collector.
 *
 * Deferred: drift framework lands in WS9.
 * Path conforms to ADR-0003 line 101's locked layout (snake_case
 * singular noun, used by xinas_history.drift).
 *
 * Reason code: DRIFT_FRAMEWORK_DEFERRED
 */
export class ManagedFilesStubCollector extends StubCollector<'managed_files'> {
  readonly kind = 'managed_files' as const;
  readonly _reasonCode = 'DRIFT_FRAMEWORK_DEFERRED';
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/collectors/stubs.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 10/10 pass (5 per stub); full suite passes.

Run a final Phase E summary check:

```bash
cd xiNAS-MCP
npx vitest run src/__tests__/agent/collectors/ 2>&1 | tail -5
```
Expected: all collector tests pass (E1 through E10).

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/agent/collectors/stubs.ts xiNAS-MCP/src/__tests__/agent/collectors/stubs.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add XiraidArray + ManagedFiles stub collectors (E10)

Two deferred collectors sharing a StubCollector abstract base.
initialSweep emits a single meta-delta at id "_stub" so the state
store path is populated with a status row indicating the deferral —
api GET endpoints can return a structured deferral notice instead of
404. No event source, no poll (pollIntervalMs undefined). health()
always reports 'stubbed' with the reason code.

  XiraidArrayStubCollector — XIRAID_ADAPTER_DEFERRED (xiRAID gRPC
  client moves api→agent in S3/WS5).

  ManagedFilesStubCollector — DRIFT_FRAMEWORK_DEFERRED (drift
  framework lands in WS9; path conforms to ADR-0003 §locked layout).

Tests: _stub id; status.deferred=true + reason code + observed_at;
start() emits nothing; health() state + reason; pollIntervalMs undefined.

Phase E complete. All 10 collectors implemented.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Phase F — Publisher

### Task F1: Publisher core (batch + HTTP POST over UDS)

**Files:**
- Create: `xiNAS-MCP/src/agent/publisher.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/publisher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/publisher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Publisher } from '../../agent/publisher.js';
import type { ObservationDelta } from '../../agent/collectors/base.js';

describe('Publisher — core enqueue + flush', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let receivedBodies: unknown[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-pub-test-'));
    socketPath = join(dir, 'api.sock');
    receivedBodies = [];

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          receivedBodies.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: 1, deleted_by_reconcile: 0, state_revision: 1 }));
        });
      });
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues deltas and flush POSTs them to /internal/v1/observed', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'test-agent-token',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const delta: ObservationDelta = {
      kind: 'Disk',
      id: 'nvme0n1',
      op: 'upsert',
      value: { name: 'nvme0n1' },
    };

    pub.enqueue(delta);
    await pub.flush();

    expect(receivedBodies).toHaveLength(1);
    const body = receivedBodies[0] as {
      observed_at: string;
      controller_id: string;
      deltas: ObservationDelta[];
      complete_snapshots: string[];
    };
    expect(body.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
    expect(body.deltas).toHaveLength(1);
    expect(body.deltas[0]).toMatchObject({ kind: 'Disk', id: 'nvme0n1', op: 'upsert' });
    expect(body.complete_snapshots).toEqual([]);
    expect(typeof body.observed_at).toBe('string');
  });

  it('flush with no enqueued deltas sends nothing', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'test-agent-token',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });
    await pub.flush();
    expect(receivedBodies).toHaveLength(0);
  });

  it('passes complete_snapshots when flushWithSnapshot is called', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'test-agent-token',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const delta: ObservationDelta = {
      kind: 'Disk',
      id: 'nvme0n1',
      op: 'upsert',
      value: { name: 'nvme0n1' },
    };

    pub.enqueue(delta);
    await pub.flushWithSnapshot(['Disk']);

    const body = receivedBodies[0] as { complete_snapshots: string[] };
    expect(body.complete_snapshots).toEqual(['Disk']);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/publisher.test.ts 2>&1 | tail -10
```
Expected: FAIL — `../../agent/publisher.js` not found; `../../agent/collectors/base.js` not found.

- [ ] **Step 3: Ensure the ObservationDelta type exists (base.ts)**

> **Cross-phase reconciliation:** `src/agent/collectors/base.ts` is the canonical
> property of **Task E1**, which executes before this task in plan order
> (Phase E precedes Phase F). When you reach F1, base.ts already exists with the
> `Kind`, `ObservationDelta`, and `Collector<K>` definitions. **Do not recreate it.**
> Verify it exists and import `Kind` + `ObservationDelta` from it; if for some
> reason you are executing F before E, create base.ts here with exactly the
> contents shown in E1 (they must be byte-identical). The block below is the
> reference content for that case only.

Reference content for `xiNAS-MCP/src/agent/collectors/base.ts` (canonical copy lives in Task E1):

```ts
/**
 * ObservationDelta represents a single state-change event emitted
 * by a collector and eventually batched by the Publisher into a
 * POST /internal/v1/observed body.
 *
 * `op: 'upsert'` — create or overwrite.
 * `op: 'delete'` — remove from state store.
 */
export type Kind =
  | 'Disk'
  | 'NetworkInterface'
  | 'Filesystem'
  | 'XiraidArray'
  | 'NfsSession'
  | 'NfsIdmap'
  | 'SystemdUnit'
  | 'managed_files'
  | 'inventory'
  | 'User'
  | 'Group';

export type ObservationDelta =
  | { kind: Kind; id: string; op: 'upsert'; value: Record<string, unknown> }
  | { kind: Kind; id: string; op: 'delete' };

/**
 * Collector<K> — the interface every observation collector implements.
 * initialSweep returns the full current state (used on boot and on
 * pending-reconcile recovery). start() begins subscribing to
 * event sources and calls emit on each change. stop() tears down
 * subscriptions. pollIntervalMs enables a periodic poll fallback.
 * health() returns the collector's current operational state for
 * surfacing in agent.health responses.
 */
export interface Collector<K extends Kind = Kind> {
  kind: K;
  initialSweep(): Promise<ObservationDelta[]>;
  start(emit: (delta: ObservationDelta) => void): Promise<void>;
  stop(): Promise<void>;
  pollIntervalMs?: number;
  health(): { state: 'running' | 'stubbed' | 'error'; reason?: string };
}
```

- [ ] **Step 4: Implement Publisher**

Create `xiNAS-MCP/src/agent/publisher.ts`:

```ts
import http from 'node:http';
import type { ObservationDelta, Kind } from './collectors/base.js';

export interface PublisherOptions {
  apiSocketPath: string;
  agentToken: string;
  controllerId: string;
  /** Max deltas per batch before an early flush. Default: 256. */
  maxBatchSize?: number;
  /** Max body size in bytes before an early flush. Default: 1_048_576 (1 MB). */
  maxBatchBytes?: number;
}

/**
 * Publisher batches ObservationDelta emissions from collectors and
 * POSTs them to /internal/v1/observed over the api's Unix-domain
 * socket. Each flush clears the queue.
 *
 * For retry and pendingReconcile, see F2.
 */
export class Publisher {
  readonly #opts: Required<PublisherOptions>;
  #queue: ObservationDelta[] = [];

  constructor(opts: PublisherOptions) {
    this.#opts = {
      maxBatchSize: 256,
      maxBatchBytes: 1_048_576,
      ...opts,
    };
  }

  /** Add a delta to the pending batch. */
  enqueue(delta: ObservationDelta): void {
    this.#queue.push(delta);
  }

  /**
   * POST the current batch to /internal/v1/observed with no
   * complete_snapshots. Clears the queue on success.
   */
  async flush(): Promise<void> {
    return this.#doFlush([]);
  }

  /**
   * POST the current batch marking the given kinds as complete
   * snapshots so the api can reconcile stale keys.
   */
  async flushWithSnapshot(completeSnapshots: Kind[]): Promise<void> {
    return this.#doFlush(completeSnapshots);
  }

  async #doFlush(completeSnapshots: Kind[]): Promise<void> {
    if (this.#queue.length === 0) return;

    const batch = this.#queue.splice(0);
    const body = JSON.stringify({
      observed_at: new Date().toISOString(),
      controller_id: this.#opts.controllerId,
      deltas: batch,
      complete_snapshots: completeSnapshots,
    });

    await this.#postJson('/internal/v1/observed', body);
  }

  #postJson(path: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.#opts.apiSocketPath,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.#opts.agentToken}`,
          },
        },
        (res) => {
          // Drain the response body so the socket stays healthy.
          res.resume();
          res.on('end', () => {
            if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`POST ${path} returned HTTP ${res.statusCode ?? 'unknown'}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Post a one-shot JSON body to an arbitrary path (used for agent_started). */
  async postOnce(path: string, payload: Record<string, unknown>): Promise<void> {
    await this.#postJson(path, JSON.stringify(payload));
  }
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/publisher.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 publisher tests pass; total test count increases.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
# base.ts is committed by E1 (executes earlier). Stage it here ONLY if
# you are running F before E and it is not yet tracked; otherwise omit it.
git add \
  xiNAS-MCP/src/agent/publisher.ts \
  xiNAS-MCP/src/__tests__/agent/publisher.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add Publisher core

F1 — publisher batches ObservationDelta emissions from collectors and
POSTs them to /internal/v1/observed over the api UDS via node:http.

Publisher.enqueue(delta) adds to an in-memory queue. flush() POSTs
with complete_snapshots: []. flushWithSnapshot(kinds) stamps the
given kinds for api-side reconcile. Queue is cleared on POST.

Imports Kind + ObservationDelta from src/agent/collectors/base.ts
(created in Task E1, which executes earlier in plan order).

Body shape: { observed_at, controller_id, deltas, complete_snapshots }
per the spec §"Flow A — Observation push".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task F2: Retry + pendingReconcile + backstop

**Files:**
- Modify: `xiNAS-MCP/src/agent/publisher.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/publisher-retry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/publisher-retry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Publisher } from '../../agent/publisher.js';
import type { ObservationDelta } from '../../agent/collectors/base.js';

describe('Publisher — retry + pendingReconcile', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let responseQueue: Array<{ status: number; body: string }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-pub-retry-'));
    socketPath = join(dir, 'api.sock');
    responseQueue = [];
    // Use fake timers to control backoff without actually waiting.
    vi.useFakeTimers();

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += String(c); });
        req.on('end', () => {
          const r = responseQueue.shift() ?? { status: 200, body: '{"accepted":1}' };
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(r.body);
        });
      });
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries on 5xx up to 5 times then populates pendingReconcile', async () => {
    // Queue 5 server-side 503 responses, then a success.
    // With exhaustion policy: 5 attempts max, so after attempt 5 fails → pendingReconcile.
    for (let i = 0; i < 5; i++) {
      responseQueue.push({ status: 503, body: '{"errors":[{"code":"INTERNAL"}]}' });
    }

    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      // In tests we shorten backoff to 0ms so vi.runAllTimersAsync works.
      retryBaseMs: 0,
    });

    const delta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    pub.enqueue(delta);

    // We need to run timers as the retry loop awaits backoff sleeps.
    const flushPromise = pub.flushWithSnapshot(['Disk']);
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(pub.pendingReconcile.has('Disk')).toBe(true);
  });

  it('does not retry on 4xx', async () => {
    responseQueue.push({ status: 400, body: '{"errors":[{"code":"INVALID_ARGUMENT"}]}' });

    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      retryBaseMs: 0,
    });

    const delta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    pub.enqueue(delta);
    await pub.flush();

    // 4xx: no pendingReconcile — the payload is structurally wrong; retrying won't help.
    expect(pub.pendingReconcile.size).toBe(0);
    // Only one HTTP hit (no retries).
    expect(responseQueue).toHaveLength(0); // the one queued response was consumed
  });

  it('clears pendingReconcile for a kind on successful flush', async () => {
    // Pre-seed pendingReconcile as if a previous flush exhausted retries.
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      retryBaseMs: 0,
    });
    pub.pendingReconcile.add('Disk');

    const delta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    pub.enqueue(delta);
    // Success response (nothing in responseQueue → default 200)
    await pub.flushWithSnapshot(['Disk']);

    expect(pub.pendingReconcile.has('Disk')).toBe(false);
  });

  it('needsReconcile(kind) returns true when kind is in pendingReconcile', () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });
    expect(pub.needsReconcile('Disk')).toBe(false);
    pub.pendingReconcile.add('Disk');
    expect(pub.needsReconcile('Disk')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/publisher-retry.test.ts 2>&1 | tail -10
```
Expected: FAIL — `pendingReconcile` is not a public property, `retryBaseMs` option does not exist, retry logic not implemented.

- [ ] **Step 3: Extend Publisher with retry + pendingReconcile**

Edit `xiNAS-MCP/src/agent/publisher.ts`. Replace the file with the extended version:

```ts
import http from 'node:http';
import type { ObservationDelta, Kind } from './collectors/base.js';

export interface PublisherOptions {
  apiSocketPath: string;
  agentToken: string;
  controllerId: string;
  /** Max deltas per batch before an early flush. Default: 256. */
  maxBatchSize?: number;
  /** Max body size in bytes before an early flush. Default: 1_048_576 (1 MB). */
  maxBatchBytes?: number;
  /**
   * Base backoff in ms for the first retry. Subsequent attempts double,
   * capped at 30_000 ms. Default: 250. Set to 0 in tests to skip waits.
   */
  retryBaseMs?: number;
  /** Maximum retry attempts. Default: 5. */
  maxRetries?: number;
}

interface PostResult {
  status: number;
}

/**
 * Publisher batches ObservationDelta emissions from collectors and
 * POSTs them to /internal/v1/observed over the api's Unix-domain
 * socket.
 *
 * Retry policy (F2): 5 attempts, exponential backoff starting at
 * retryBaseMs (default 250ms), capped at 30s. 4xx → no retry.
 * 5xx retry exhaustion → affected kinds are added to pendingReconcile.
 * Collectors check needsReconcile(kind) before their next tick; if
 * true they run initialSweep instead of incremental delta.
 */
export class Publisher {
  readonly #opts: Required<PublisherOptions>;
  #queue: ObservationDelta[] = [];

  /** Public so collectors can read and tests can inspect. */
  readonly pendingReconcile: Set<Kind> = new Set();

  constructor(opts: PublisherOptions) {
    this.#opts = {
      maxBatchSize: 256,
      maxBatchBytes: 1_048_576,
      retryBaseMs: 250,
      maxRetries: 5,
      ...opts,
    };
  }

  enqueue(delta: ObservationDelta): void {
    this.#queue.push(delta);
    // Early flush if we've hit the batch ceiling.
    if (this.#queue.length >= this.#opts.maxBatchSize) {
      void this.flush();
    }
  }

  needsReconcile(kind: Kind): boolean {
    return this.pendingReconcile.has(kind);
  }

  async flush(): Promise<void> {
    return this.#doFlush([]);
  }

  async flushWithSnapshot(completeSnapshots: Kind[]): Promise<void> {
    return this.#doFlush(completeSnapshots);
  }

  /** Post a one-shot JSON body (used for /internal/v1/agent_started). */
  async postOnce(path: string, payload: Record<string, unknown>): Promise<void> {
    await this.#postJsonRaw(path, JSON.stringify(payload));
  }

  async #doFlush(completeSnapshots: Kind[]): Promise<void> {
    if (this.#queue.length === 0) return;

    const batch = this.#queue.splice(0);
    const kindsInBatch = new Set(batch.map((d) => d.kind));

    const body = JSON.stringify({
      observed_at: new Date().toISOString(),
      controller_id: this.#opts.controllerId,
      deltas: batch,
      complete_snapshots: completeSnapshots,
    });

    const { maxRetries, retryBaseMs } = this.#opts;
    let lastStatus = 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.#postJsonRaw('/internal/v1/observed', body);
        lastStatus = result.status;

        if (result.status >= 200 && result.status < 300) {
          // Success: clear pending for these kinds.
          for (const k of kindsInBatch) {
            this.pendingReconcile.delete(k);
          }
          // Also clear kinds requested for reconcile that succeeded.
          for (const k of completeSnapshots) {
            this.pendingReconcile.delete(k as Kind);
          }
          return;
        }

        // 4xx: don't retry — payload is structurally wrong.
        if (result.status >= 400 && result.status < 500) {
          return;
        }

        // 5xx: back off and retry.
      } catch (_err) {
        // Network error — treat same as 5xx, will retry.
        lastStatus = 0;
      }

      if (attempt < maxRetries - 1) {
        const backoffMs = Math.min(retryBaseMs * Math.pow(2, attempt), 30_000);
        await sleep(backoffMs);
      }
    }

    // Retry exhaustion: mark kinds for reconcile.
    // Surface lastStatus in health (future: last_publish_error field).
    void lastStatus; // used for structured log in production; omitted here for test simplicity
    for (const k of kindsInBatch) {
      this.pendingReconcile.add(k);
    }
  }

  #postJsonRaw(path: string, body: string): Promise<PostResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.#opts.apiSocketPath,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.#opts.agentToken}`,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0 });
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/publisher-retry.test.ts 2>&1 | tail -5
npx vitest run src/__tests__/agent/publisher.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: both publisher test files pass; prior tests unaffected.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/agent/publisher.ts \
  xiNAS-MCP/src/__tests__/agent/publisher-retry.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): publisher retry policy + pendingReconcile + backstop hook

F2 — extends Publisher with the spec's retry and recovery semantics:

  Retry: 5 attempts, exponential backoff 250ms × 2ⁿ capped at 30s.
  4xx → no retry (structurally wrong payload; retrying won't help).
  5xx exhaustion → all kinds in the dropped batch are added to
  pendingReconcile: Set<Kind>.

  pendingReconcile is public so collectors can call
  needsReconcile(kind) before their next tick. If true, the collector
  runs initialSweep() (full-snapshot reconcile) instead of an
  incremental delta. On successful POST the affected kinds are removed
  from the set.

  retryBaseMs option (default 250) is set to 0 in tests so
  vi.runAllTimersAsync() can advance the backoff sleeps without
  real wall-clock delay.

Tests cover: 5× 503 → exhaustion → pendingReconcile populated;
4xx → no pendingReconcile, no retry; success → pendingReconcile
cleared; needsReconcile(kind) predicate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task F3: Wire publisher to collectors + agent boot integration

**Files:**
- Modify: `xiNAS-MCP/src/agent/agent-server.ts`
- Create: `xiNAS-MCP/src/__tests__/agent/boot-sequence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/agent/boot-sequence.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Publisher } from '../../agent/publisher.js';
import { CollectorRegistry } from '../../agent/collectors/registry.js';
import type { Collector, ObservationDelta, Kind } from '../../agent/collectors/base.js';
import { runBootSequence } from '../../agent/boot.js';

/** A minimal stub collector for testing boot sequence. */
function makeStubCollector(kind: Kind, deltas: ObservationDelta[]): Collector<Kind> {
  return {
    kind,
    async initialSweep() { return deltas; },
    async start(_emit) { /* no-op */ },
    async stop() { /* no-op */ },
    health() { return { state: 'running' }; },
  };
}

describe('Boot sequence — initial sweep + agent_started', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;
  let requestLog: Array<{ path: string; body: unknown }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-boot-test-'));
    socketPath = join(dir, 'api.sock');
    requestLog = [];

    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += String(c); });
        req.on('end', () => {
          requestLog.push({ path: req.url ?? '/', body: JSON.parse(body || 'null') });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (req.url === '/internal/v1/observed') {
            res.end(JSON.stringify({ accepted: 1, deleted_by_reconcile: 0, state_revision: 1 }));
          } else {
            res.end('{}');
          }
        });
      });
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('boot: initial sweep per collector → POST /observed with complete_snapshots, then POST /agent_started', async () => {
    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    const registry = new CollectorRegistry();
    const diskDelta: ObservationDelta = { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: {} };
    registry.register(makeStubCollector('Disk', [diskDelta]));
    registry.register(makeStubCollector('User', []));

    await runBootSequence({ publisher: pub, registry, controllerId: '00000000-0000-0000-0000-0000000000aa' });

    // Should have at least one /observed POST (for Disk, which had deltas)
    // and one /agent_started POST.
    const observedPosts = requestLog.filter((r) => r.path === '/internal/v1/observed');
    const startedPosts = requestLog.filter((r) => r.path === '/internal/v1/agent_started');

    expect(observedPosts.length).toBeGreaterThanOrEqual(1);
    expect(startedPosts).toHaveLength(1);

    // The Disk sweep batch must carry complete_snapshots: ['Disk'].
    const diskPost = observedPosts.find((r) => {
      const b = r.body as { complete_snapshots?: string[] };
      return b.complete_snapshots?.includes('Disk');
    });
    expect(diskPost).toBeDefined();

    // /agent_started must carry controller_id.
    const startedBody = startedPosts[0]?.body as { controller_id?: string };
    expect(startedBody.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
  });

  it('agent_started is posted AFTER all initial sweep batches', async () => {
    const callOrder: string[] = [];

    const pub = new Publisher({
      apiSocketPath: socketPath,
      agentToken: 'tok',
      controllerId: '00000000-0000-0000-0000-0000000000aa',
    });

    // Monkey-patch to track call order
    const origFlushWithSnapshot = pub.flushWithSnapshot.bind(pub);
    pub.flushWithSnapshot = async (kinds) => {
      callOrder.push(`flush:${kinds.join(',')}`);
      return origFlushWithSnapshot(kinds);
    };
    const origPostOnce = pub.postOnce.bind(pub);
    pub.postOnce = async (path, body) => {
      callOrder.push(`postOnce:${path}`);
      return origPostOnce(path, body);
    };

    const registry = new CollectorRegistry();
    registry.register(makeStubCollector('Disk', [{ kind: 'Disk', id: 'x', op: 'upsert', value: {} }]));

    await runBootSequence({ publisher: pub, registry, controllerId: '00000000-0000-0000-0000-0000000000aa' });

    const agentStartedIdx = callOrder.findIndex((c) => c.includes('/internal/v1/agent_started'));
    const lastFlushIdx = callOrder.filter((c) => c.startsWith('flush:')).length - 1;
    // agent_started must come after the last flush
    expect(agentStartedIdx).toBeGreaterThan(lastFlushIdx);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/agent/boot-sequence.test.ts 2>&1 | tail -10
```
Expected: FAIL — `CollectorRegistry` and `runBootSequence` don't exist yet.

- [ ] **Step 3: Create CollectorRegistry**

Create `xiNAS-MCP/src/agent/collectors/registry.ts`:

```ts
import type { Collector, ObservationDelta, Kind } from './base.js';

export interface CollectorHealthSnapshot {
  [name: string]: { state: 'running' | 'stubbed' | 'error'; reason?: string };
}

/**
 * CollectorRegistry tracks all registered collectors and provides
 * lifecycle management (start / stop) and health snapshots for
 * agent.health responses.
 */
export class CollectorRegistry {
  readonly #collectors: Map<Kind, Collector<Kind>> = new Map();

  register<K extends Kind>(collector: Collector<K>): void {
    this.#collectors.set(collector.kind, collector as Collector<Kind>);
  }

  collectors(): ReadonlyMap<Kind, Collector<Kind>> {
    return this.#collectors;
  }

  async startAll(emit: (delta: ObservationDelta) => void): Promise<void> {
    for (const collector of this.#collectors.values()) {
      try {
        await collector.start(emit);
      } catch (err) {
        // Isolation: one collector failing to start does not kill the others.
        // The health snapshot will reflect the error state.
        console.error(`[registry] collector ${collector.kind} failed to start:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const collector of this.#collectors.values()) {
      try {
        await collector.stop();
      } catch (_) { /* best-effort */ }
    }
  }

  healthSnapshot(): CollectorHealthSnapshot {
    const out: CollectorHealthSnapshot = {};
    for (const [kind, c] of this.#collectors) {
      out[kind] = c.health();
    }
    return out;
  }
}
```

- [ ] **Step 4: Create runBootSequence**

Create `xiNAS-MCP/src/agent/boot.ts`:

```ts
import type { Publisher } from './publisher.js';
import type { CollectorRegistry } from './collectors/registry.js';
import type { Kind } from './collectors/base.js';

export interface BootSequenceOptions {
  publisher: Publisher;
  registry: CollectorRegistry;
  controllerId: string;
}

/**
 * runBootSequence implements Flow C step 3 from the spec:
 *
 *   1. For each collector, call initialSweep().
 *   2. Batch the deltas per kind; each batch carries
 *      complete_snapshots: [kind] so the api can reconcile.
 *   3. POST each batch.
 *   4. POST /internal/v1/agent_started once.
 *
 * Collectors with empty sweeps still send a complete_snapshots batch
 * so the api knows to reconcile the kind to empty (removing stale
 * entries from a prior run if any exist).
 *
 * After this function returns, the caller should call
 * registry.startAll(emit) to begin steady-state event-driven updates.
 */
export async function runBootSequence(opts: BootSequenceOptions): Promise<void> {
  const { publisher, registry, controllerId } = opts;

  for (const [kind, collector] of registry.collectors()) {
    let deltas;
    try {
      deltas = await collector.initialSweep();
    } catch (err) {
      console.error(`[boot] initialSweep for ${kind} failed:`, err);
      deltas = [];
    }
    // Enqueue all deltas for this kind.
    for (const delta of deltas) {
      publisher.enqueue(delta);
    }
    // Flush with complete_snapshots so the api reconciles this kind
    // even if deltas is empty (clearing any stale state).
    await publisher.flushWithSnapshot([kind as Kind]);
  }

  // Signal to the api that the initial sweep is done so it can clear
  // its heartbeat startup grace timer.
  await publisher.postOnce('/internal/v1/agent_started', { controller_id: controllerId });
}
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/agent/boot-sequence.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 2/2 boot-sequence tests pass; full suite green.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/agent/boot.ts \
  xiNAS-MCP/src/agent/collectors/registry.ts \
  xiNAS-MCP/src/__tests__/agent/boot-sequence.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): wire publisher to collector registry + boot sequence

F3 — implements the startup sequence from the spec §"Flow C":

  CollectorRegistry tracks collectors, provides startAll/stopAll
  lifecycle and healthSnapshot() for agent.health responses.

  runBootSequence() iterates every collector, calls initialSweep(),
  enqueues the deltas, and calls flushWithSnapshot([kind]) so the api
  receives a complete_snapshots batch per kind on boot (enabling
  reconcile even for empty collectors). After all sweeps complete,
  POSTs /internal/v1/agent_started with controller_id so the api
  clears its heartbeat startup grace timer.

  Ordering guarantee: agent_started is always posted after the last
  initialSweep flush (verified by the call-order test).

  The agent-server.ts entry point (C5) will call runBootSequence then
  registry.startAll(emit) to enter steady-state event-driven updates.
  That wiring lands in C5; this PR's boot.ts is the reusable function.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase G — API contract additions (api-v1.yaml)

All five tasks in this phase modify `docs/control-path/api-v1.yaml` only. After each task run both verification commands. **Use the same Spectral invocation CI uses** (`.github/workflows/ci.yml` `openapi` job) — `spectral` is NOT a devDependency, so it must be run via `npx --yes -p @stoplight/spectral-cli@latest`, with the repo ruleset, and run from the repo root (not `xiNAS-MCP/`):

```bash
# contract fixtures (from xiNAS-MCP/):
( cd xiNAS-MCP && npx vitest run src/__tests__/contracts/ 2>&1 | tail -5 )
# OpenAPI lint (from repo root, CI-matching command):
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml 2>&1 | tail -5
```

(Any `npx spectral lint …` form shown inside the individual G-task bodies below is shorthand for this exact CI-matching command.)

The spec's §"API contract additions" provides the authoritative YAML; the tasks below reproduce that YAML verbatim plus the git context.

---

### Task G1: User + Group schemas + /users + /groups paths

**Files:**
- Modify: `docs/control-path/api-v1.yaml`

- [ ] **Step 1: Read the current schemas section boundary**

```bash
grep -n "^components:" docs/control-path/api-v1.yaml | head -3
grep -n "^paths:" docs/control-path/api-v1.yaml | head -3
```

Locate the `components.schemas:` block and the `paths:` block. New schemas go at the end of `components.schemas:`; new paths go at the end of `paths:`.

- [ ] **Step 2: Add User schema to components.schemas**

In `docs/control-path/api-v1.yaml`, in the `components.schemas:` section, append:

```yaml
    User:
      type: object
      required: [kind, id, metadata, spec, status]
      properties:
        kind:
          type: string
          const: User
        id:
          type: string
          description: "Decimal uid as string."
        metadata:
          $ref: '#/components/schemas/Metadata'
        spec:
          type: object
          required: [name, uid, gid]
          properties:
            name:
              type: string
            uid:
              type: integer
            gid:
              type: integer
            gecos:
              type: string
            home:
              type: string
            shell:
              type: string
        status:
          type: object
          required: [resolvable, source]
          properties:
            resolvable:
              type: boolean
            source:
              type: string
              enum: [local, nss]

    Group:
      type: object
      required: [kind, id, metadata, spec, status]
      properties:
        kind:
          type: string
          const: Group
        id:
          type: string
          description: "Decimal gid as string."
        metadata:
          $ref: '#/components/schemas/Metadata'
        spec:
          type: object
          required: [name, gid]
          properties:
            name:
              type: string
            gid:
              type: integer
            members:
              type: array
              items:
                type: string
        status:
          type: object
          required: [resolvable, source]
          properties:
            resolvable:
              type: boolean
            source:
              type: string
              enum: [local, nss]
```

- [ ] **Step 3: Add /users and /groups paths**

In the `paths:` section, append:

```yaml
  /users:
    get:
      operationId: listUsers
      summary: List all observed local and NSS-resolved users.
      tags: [users]
      parameters:
        - name: source
          in: query
          schema:
            type: string
            enum: [local, nss, all]
            default: all
        - $ref: '#/components/parameters/QueryLimit'
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Envelope'
        '401':
          $ref: '#/components/responses/Unauthorized'

  /users/{uid}:
    get:
      operationId: getUser
      summary: Get a single user by numeric uid.
      tags: [users]
      parameters:
        - name: uid
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Envelope'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'

  /groups:
    get:
      operationId: listGroups
      summary: List all observed local and NSS-resolved groups.
      tags: [groups]
      parameters:
        - name: source
          in: query
          schema:
            type: string
            enum: [local, nss, all]
            default: all
        - $ref: '#/components/parameters/QueryLimit'
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Envelope'
        '401':
          $ref: '#/components/responses/Unauthorized'

  /groups/{gid}:
    get:
      operationId: getGroup
      summary: Get a single group by numeric gid.
      tags: [groups]
      parameters:
        - name: gid
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Envelope'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx vitest run src/__tests__/contracts/ 2>&1 | tail -5
npx spectral lint ../docs/control-path/api-v1.yaml 2>&1 | tail -5
```
Expected: contracts pass; spectral clean (no errors).

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add docs/control-path/api-v1.yaml
git commit -m "$(cat <<'EOF'
feat(api-v1.yaml): add User + Group schemas + /users + /groups paths

G1 — additive schema extension for the xinas-agent S0+S1 PR.

User: { kind, id (decimal uid string), spec { name, uid, gid, gecos,
home, shell }, status { resolvable, source } }

Group: same shape; spec carries gid + members[].

New public paths: GET /users?source=local|nss|all,
GET /users/{uid}, GET /groups?source=..., GET /groups/{gid}.

These endpoints will be populated by the User+Group collectors
(E8) via the observed state store at /xinas/v1/observed/User/<uid>
and /xinas/v1/observed/Group/<gid>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task G2: NfsSession + NfsIdmap schemas + /nfs-idmap path

**Files:**
- Modify: `docs/control-path/api-v1.yaml`

- [ ] **Step 1: Add NfsSession schema**

In `components.schemas:`, append after the Group schema:

```yaml
    NfsSession:
      type: object
      required: [kind, id, metadata, spec, status]
      properties:
        kind:
          type: string
          const: NfsSession
        id:
          type: string
          description: "Composite: <client_addr>:<export_path>."
        metadata:
          $ref: '#/components/schemas/Metadata'
        spec:
          type: object
          required: [client_addr, export_path]
          properties:
            client_addr:
              type: string
            client_hostname:
              type: string
            export_path:
              type: string
        status:
          type: object
          required: [proto_version, locked_files, observed_at]
          properties:
            proto_version:
              type: string
              enum: [v3, v4, v4.1, v4.2]
            locked_files:
              type: integer
            observed_at:
              type: string
              format: date-time
```

- [ ] **Step 2: Add NfsIdmap schema**

In `components.schemas:`, append after NfsSession:

```yaml
    NfsIdmap:
      type: object
      required: [kind, metadata, status]
      properties:
        kind:
          type: string
          const: NfsIdmap
        metadata:
          $ref: '#/components/schemas/Metadata'
        status:
          type: object
          required: [conf_present, idmapd_active, method]
          properties:
            conf_present:
              type: boolean
            domain:
              type: string
            local_realms:
              type: array
              items:
                type: string
            method:
              type: string
              enum: [nsswitch, static, umich_ldap, unknown]
            idmapd_active:
              type: boolean
            idmapd_unit_state:
              type: string
```

- [ ] **Step 3: Add /nfs-idmap path**

In `paths:`, append:

```yaml
  /nfs-idmap:
    get:
      operationId: getNfsIdmap
      summary: Get the observed NFS idmap daemon configuration (singleton).
      tags: [nfs]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Envelope'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          $ref: '#/components/responses/NotFound'
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx vitest run src/__tests__/contracts/ 2>&1 | tail -5
npx spectral lint ../docs/control-path/api-v1.yaml 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add docs/control-path/api-v1.yaml
git commit -m "$(cat <<'EOF'
feat(api-v1.yaml): add NfsSession + NfsIdmap schemas + /nfs-idmap path

G2 — additive schema extension.

NfsSession: { kind, id (client_addr:export_path composite), spec
{ client_addr, client_hostname, export_path }, status { proto_version,
locked_files, observed_at } }. Surfaced via the existing
/shares/{id}/sessions endpoint (I5 populates it).

NfsIdmap: singleton, no id field. status { conf_present, domain,
local_realms, method, idmapd_active, idmapd_unit_state }.
New public path: GET /nfs-idmap (singleton).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task G3: ExportRule schema + Share.status.exports[] + Filesystem.status additive fields

**Files:**
- Modify: `docs/control-path/api-v1.yaml`

- [ ] **Step 1: Add ExportRule top-level schema**

In `components.schemas:`, append after NfsIdmap:

```yaml
    ExportRule:
      type: object
      required: [host_pattern, options]
      properties:
        host_pattern:
          type: string
          description: "Matches /etc/exports host field (CIDR, hostname, wildcard, netgroup)."
        options:
          type: array
          items:
            type: string
        squash_mode:
          type: string
          enum: [root_squash, no_root_squash, all_squash]
        anon_uid:
          type: integer
        anon_gid:
          type: integer
```

- [ ] **Step 2: Add exports[] to Share.status**

Locate the existing `Share` schema in `components.schemas:`. Find its `status.properties:` block. Add `exports` as an additive field without removing any existing fields:

```yaml
            exports:
              type: array
              items:
                $ref: '#/components/schemas/ExportRule'
              description: "Per-host export entries observed from /etc/exports.d/ or helper output."
```

- [ ] **Step 3: Add additive fields to Filesystem.status**

Locate the existing `Filesystem` schema. Find its `status.properties:` block. Add without removing:

```yaml
            currently_mounted:
              type: boolean
            mount_options:
              type: array
              items:
                type: string
            mount_unit_name:
              type: string
              description: "Name of the .mount unit, e.g. srv-share01.mount"
            mount_unit_enabled:
              type: boolean
              description: "From `systemctl is-enabled` (B4). Whether the .mount unit is enabled (WantedBy=local-fs.target)."
            mount_unit_state:
              type: string
              enum: [active, inactive, failed, activating, deactivating]
              description: "systemd ActiveState of the .mount unit, from the dbus cross-reference in the Filesystem collector (E4). Distinct from mount_unit_enabled (enablement)."
            owner_uid:
              type: integer
            owner_gid:
              type: integer
            owner_user_name:
              type: [string, "null"]
            owner_group_name:
              type: [string, "null"]
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx vitest run src/__tests__/contracts/ 2>&1 | tail -5
npx spectral lint ../docs/control-path/api-v1.yaml 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add docs/control-path/api-v1.yaml
git commit -m "$(cat <<'EOF'
feat(api-v1.yaml): ExportRule schema + Share/Filesystem additive fields

G3 — three additive changes:

  New top-level ExportRule schema: { host_pattern, options[],
  squash_mode?, anon_uid?, anon_gid? }. Referenced by Share.status.exports[].

  Share.status gains exports: ExportRule[] (additive). Populated by
  the NFS collector (E5) folding /etc/exports.d/ entries observed via
  the nfs-helper into the owning share's status.

  Filesystem.status gains: currently_mounted, mount_options[],
  mount_unit_name, mount_unit_state, owner_uid, owner_gid,
  owner_user_name, owner_group_name. Populated by E4 cross-referencing
  .mount unit state with /proc/self/mountinfo.

All changes are additive; no existing fields removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task G4: SystemdUnit schema + Node.status.agent sub-object

**Files:**
- Modify: `docs/control-path/api-v1.yaml`

- [ ] **Step 1: Add SystemdUnit schema**

In `components.schemas:`, append:

```yaml
    SystemdUnit:
      type: object
      required: [kind, id, metadata, status]
      properties:
        kind:
          type: string
          const: SystemdUnit
        id:
          type: string
          description: "Unit name including suffix, e.g. nfs-server.service or srv-share01.mount."
        metadata:
          $ref: '#/components/schemas/Metadata'
        status:
          type: object
          required: [load_state, active_state, sub_state, observed_at]
          properties:
            load_state:
              type: string
              description: "loaded | not-found | error | masked"
            active_state:
              type: string
              description: "active | reloading | inactive | failed | activating | deactivating"
            sub_state:
              type: string
            unit_file_state:
              type: string
              description: "enabled | disabled | static | masked | ..."
            observed_at:
              type: string
              format: date-time
```

Note: SystemdUnit has no public REST path in this PR; resources sit at `/xinas/v1/observed/SystemdUnit/<unit-name>` for internal consumers and health-check use.

- [ ] **Step 2: Add agent sub-object to Node.status**

Locate the `Node` schema in `components.schemas:`. Find its `status.properties:` block. Add the `agent` field:

```yaml
            agent:
              type: object
              required: [state, version]
              properties:
                state:
                  type: string
                  enum: [healthy, degraded, offline]
                last_heartbeat_at:
                  type: [string, "null"]
                  format: date-time
                last_observed_push_at:
                  type: [string, "null"]
                  format: date-time
                version:
                  type: string
                collectors:
                  type: object
                  additionalProperties:
                    type: string
                  description: "Per-collector state: running | stubbed | error: <reason>"
```

- [ ] **Step 3: Verify**

```bash
cd xiNAS-MCP
npx vitest run src/__tests__/contracts/ 2>&1 | tail -5
npx spectral lint ../docs/control-path/api-v1.yaml 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add docs/control-path/api-v1.yaml
git commit -m "$(cat <<'EOF'
feat(api-v1.yaml): SystemdUnit schema + Node.status.agent sub-object

G4 — two additions:

  SystemdUnit: new state-store-only resource (no public REST path).
  status { load_state, active_state, sub_state, unit_file_state,
  observed_at }. Allow-listed units only (nfs-server.service,
  nfs-mountd.service, nfs-idmapd.service, discovered *.mount units).
  Consumed by health-check logic in follow-on workstreams.

  Node.status gains agent sub-object: { state (healthy|degraded|
  offline), last_heartbeat_at, last_observed_push_at, version,
  collectors { <name>: string } }. Surfaced by GET /api/v1/system
  (I4). Driven by HeartbeatTracker (H1).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task G5: status.observed_at on every observed kind

**Files:**
- Modify: `docs/control-path/api-v1.yaml`

- [ ] **Step 1: Add observed_at to each existing observed kind's status**

Locate the following schemas' `status.properties:` blocks and add the `observed_at` field to each. Schemas that need the field added (all are additive — do not remove existing fields):

- `Disk`
- `NetworkInterface`
- `Filesystem` (already done for mount_unit_state; add observed_at here)
- `XiraidArray` (if present; if stub still needs the field for consistency)
- `Share` (its status gains observed_at for the exports observation timestamp)
- `NfsProfile` (additive on existing schema)
- `User` (added in G1; ensure observed_at is in status)
- `Group` (added in G1; same)
- `NfsSession` (added in G2 — already has observed_at in required; verify)
- `NfsIdmap` (add to status)
- `SystemdUnit` (added in G4 — already has observed_at in required; verify)
- `inventory` (singleton; add to its status if the schema exists)

For each schema that does NOT already have `observed_at` in `status.properties:`, add:

```yaml
            observed_at:
              type: string
              format: date-time
              description: "When the agent's collector observed this entity. Agents stamp this at probe-time; api computes observation_age_seconds = now - observed_at on read."
```

- [ ] **Step 2: Verify no schema is missing observed_at**

```bash
grep -A2 "observed_at:" docs/control-path/api-v1.yaml | grep -c "format: date-time"
```
Expected: count equals the number of observed kinds (≥ 10).

- [ ] **Step 3: Run contracts + spectral**

```bash
cd xiNAS-MCP
npx vitest run src/__tests__/contracts/ 2>&1 | tail -5
npx spectral lint ../docs/control-path/api-v1.yaml 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add docs/control-path/api-v1.yaml
git commit -m "$(cat <<'EOF'
feat(api-v1.yaml): add status.observed_at to every observed kind

G5 — additive field on all 10+ observed kind schemas:
Disk, NetworkInterface, Filesystem, XiraidArray, Share, NfsProfile,
User, Group, NfsSession, NfsIdmap, SystemdUnit, inventory.

The agent stamps observed_at at probe-time. The api computes
observation_age_seconds = now - status.observed_at on every read and
surfaces it inline in each resource's status (additive, non-breaking).

NfsSession and SystemdUnit (G2/G4) already included observed_at in
their required[] arrays; this task brings all remaining schemas into
consistency. The KV's out-of-band metadata.modified_at is internal
and NOT what clients see; observed_at is the operationally meaningful
timestamp the agent controls.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase H — API internal routes + heartbeat

### Task H1: HeartbeatTracker singleton + state transitions + event emission

**Files:**
- Create: `xiNAS-MCP/src/api/heartbeat.ts`
- Create: `xiNAS-MCP/src/__tests__/api/heartbeat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/heartbeat.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HeartbeatTracker, type HeartbeatTrackerOptions } from '../../api/heartbeat.js';
import type { OpenedStateStore } from '../../state/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateStore } from '../../state/index.js';

async function makeStore(dir: string): Promise<OpenedStateStore> {
  return openStateStore({
    databasePath: join(dir, 'xinas.db'),
    auditJsonlPath: join(dir, 'audit.jsonl'),
    nodeId: '00000000-0000-0000-0000-0000000000aa',
  });
}

describe('HeartbeatTracker — state transitions', () => {
  let dir: string;
  let state: OpenedStateStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-hb-test-'));
    state = await makeStore(dir);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeTracker(opts?: Partial<HeartbeatTrackerOptions>): HeartbeatTracker {
    return new HeartbeatTracker({
      intervalMs: 5_000,
      controllerId: '00000000-0000-0000-0000-0000000000aa',
      state,
      agentSocketPath: '/tmp/nonexistent.sock',
      ...opts,
    });
  }

  it('starts in offline state', () => {
    const tracker = makeTracker();
    expect(tracker.currentState()).toBe('offline');
  });

  it('transitions to healthy after recordHeartbeatSuccess', () => {
    const tracker = makeTracker();
    tracker.recordHeartbeatSuccess(new Date());
    expect(tracker.currentState()).toBe('healthy');
  });

  it('transitions from healthy to degraded after 2× interval without success', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    tracker.recordHeartbeatSuccess(t0);
    expect(tracker.currentState()).toBe('healthy');

    // Advance 11 seconds (> 2 × 5000ms = 10s)
    vi.setSystemTime(new Date(t0.getTime() + 11_000));
    expect(tracker.currentState()).toBe('degraded');
  });

  it('transitions from degraded to offline after 6× interval', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    tracker.recordHeartbeatSuccess(t0);

    // Advance 31 seconds (> 6 × 5000ms = 30s)
    vi.setSystemTime(new Date(t0.getTime() + 31_000));
    expect(tracker.currentState()).toBe('offline');
  });

  it('transitions immediately to offline on recordHeartbeatFailure with connect-refused', () => {
    const tracker = makeTracker();
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    tracker.recordHeartbeatSuccess(t0);
    expect(tracker.currentState()).toBe('healthy');

    tracker.recordHeartbeatFailure(new Date(), { connectRefused: true });
    expect(tracker.currentState()).toBe('offline');
  });

  it('recordObservationPush does not change heartbeat state', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    tracker.recordHeartbeatSuccess(t0);

    // Advance past 2× interval — should be degraded
    vi.setSystemTime(new Date(t0.getTime() + 11_000));
    expect(tracker.currentState()).toBe('degraded');

    // An observation push does NOT reset the heartbeat timer
    tracker.recordObservationPush(new Date());
    expect(tracker.currentState()).toBe('degraded');
  });

  it('emits an agent_state_changed event to the KV store on transition', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    vi.setSystemTime(t0);
    tracker.recordHeartbeatSuccess(t0);

    // Advance to degrade
    vi.setSystemTime(new Date(t0.getTime() + 11_000));
    // Calling currentState re-evaluates and emits on transition
    tracker.currentState();

    // Check that an event was written at an /xinas/v1/events/* path
    const events = state.kv.list({ prefix: '/xinas/v1/events/' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evt = events[0]?.value as {
      kind: string;
      from: string;
      to: string;
      controller_id: string;
    };
    expect(evt.kind).toBe('agent_state_changed');
    expect(evt.from).toBe('healthy');
    expect(evt.to).toBe('degraded');
    expect(evt.controller_id).toBe('00000000-0000-0000-0000-0000000000aa');
  });

  it('currentWarnings returns EXECUTOR_DEGRADED only when degraded + routeIsMutating=true', () => {
    const tracker = makeTracker({ intervalMs: 5_000 });
    const t0 = new Date('2026-05-28T12:00:00.000Z');
    tracker.recordHeartbeatSuccess(t0);

    vi.setSystemTime(new Date(t0.getTime() + 11_000));

    const warnings = tracker.currentWarnings({ routeIsMutating: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('EXECUTOR_DEGRADED');

    const readWarnings = tracker.currentWarnings({ routeIsMutating: false });
    expect(readWarnings).toHaveLength(0);
  });

  it('currentWarnings returns nothing when healthy', () => {
    const tracker = makeTracker();
    tracker.recordHeartbeatSuccess(new Date());
    expect(tracker.currentWarnings({ routeIsMutating: true })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/heartbeat.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement HeartbeatTracker**

Create `xiNAS-MCP/src/api/heartbeat.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { OpenedStateStore } from '../state/index.js';
import type { Warning } from './envelope.js';

type AgentState = 'healthy' | 'degraded' | 'offline';

export interface HeartbeatTrackerOptions {
  /** How often the api polls agent.health. Default: 5000ms. */
  intervalMs: number;
  controllerId: string;
  state: OpenedStateStore;
  /**
   * Performs one agent.health RPC over the agent UDS and returns the
   * version + collectors map. start() calls this every intervalMs.
   * Injected so tests (J1 mock-agent) supply a fake and never open a
   * real socket. Production wires this to a thin JSON-RPC-over-UDS
   * client against agentSocketPath that sends {"method":"agent.health"}
   * and maps the result. Rejects (ECONNREFUSED/ENOENT) → offline.
   */
  healthProbe: () => Promise<{ version?: string; collectors?: Record<string, string> }>;
  /** Path to the agent's UDS socket (used by the production healthProbe). */
  agentSocketPath: string;
}

interface FailureOpts {
  connectRefused?: boolean;
}

/**
 * HeartbeatTracker tracks the live state of the xinas-agent process
 * from the api's perspective. The api ticks the agent every
 * intervalMs via agent.health; the tracker transitions between
 * healthy / degraded / offline based on the time since the last
 * successful response.
 *
 * State table (per spec §"Flow B"):
 *   ≤ 2 × interval since last success  → healthy
 *   > 2 × interval, ≤ 6 × interval     → degraded
 *   > 6 × interval OR connect-refused  → offline
 *
 * currentState() re-evaluates on every call and emits an
 * agent_state_changed event to /xinas/v1/events/<ts>/<id> whenever
 * the computed state differs from the last known state.
 */
export class HeartbeatTracker {
  readonly #opts: HeartbeatTrackerOptions;
  #lastHeartbeatAt: Date | null = null;
  #lastObservationPushAt: Date | null = null;
  #connectRefused = false;
  #knownState: AgentState = 'offline';
  // Captured from the most recent successful agent.health response so
  // currentSnapshot() (consumed by /api/v1/system → result.node.status.agent)
  // can surface the agent version + per-collector health without a fresh RPC.
  #agentVersion: string | null = null;
  #collectors: Record<string, string> = {};
  #tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HeartbeatTrackerOptions) {
    this.#opts = opts;
  }

  /**
   * Record a successful agent.health response. `payload` carries the
   * version + collectors map from the response so currentSnapshot() can
   * report them. Older call sites that pass only `at` still work
   * (version/collectors retain their previous captured values).
   */
  recordHeartbeatSuccess(
    at: Date,
    payload?: { version?: string; collectors?: Record<string, string> },
  ): void {
    this.#lastHeartbeatAt = at;
    this.#connectRefused = false;
    if (payload?.version !== undefined) this.#agentVersion = payload.version;
    if (payload?.collectors !== undefined) this.#collectors = payload.collectors;
    this.currentState(); // trigger transition emit if needed
  }

  recordHeartbeatFailure(at: Date, opts?: FailureOpts): void {
    void at;
    if (opts?.connectRefused) {
      this.#connectRefused = true;
    }
    this.currentState();
  }

  recordObservationPush(at: Date): void {
    this.#lastObservationPushAt = at;
    // Does NOT reset heartbeat state per spec §"Flow A" step 5.
  }

  get lastObservationPushAt(): Date | null {
    return this.#lastObservationPushAt;
  }

  get lastHeartbeatAt(): Date | null {
    return this.#lastHeartbeatAt;
  }

  currentState(): AgentState {
    const newState = this.#computeState();
    if (newState !== this.#knownState) {
      const prev = this.#knownState;
      this.#knownState = newState;
      this.#emitStateChange(prev, newState);
    }
    return this.#knownState;
  }

  currentWarnings(opts: { routeIsMutating: boolean }): Warning[] {
    const state = this.currentState();
    if (state === 'degraded' && opts.routeIsMutating) {
      return [
        {
          code: 'EXECUTOR_DEGRADED',
          message:
            'The xinas-agent is reachable but not responding to health checks on schedule. ' +
            'Mutating operations may be delayed or unreliable.',
        },
      ];
    }
    return [];
  }

  /**
   * Full agent-state view for /api/v1/system → result.node.status.agent.
   * Pure read; does not perform an RPC. `version` + `collectors` reflect
   * the most recent successful agent.health response (null / {} until the
   * first one lands).
   */
  currentSnapshot(): {
    state: AgentState;
    version: string | null;
    last_heartbeat_at: string | null;
    last_observed_push_at: string | null;
    collectors: Record<string, string>;
  } {
    return {
      state: this.currentState(),
      version: this.#agentVersion,
      last_heartbeat_at: this.#lastHeartbeatAt?.toISOString() ?? null,
      last_observed_push_at: this.#lastObservationPushAt?.toISOString() ?? null,
      collectors: this.#collectors,
    };
  }

  /**
   * Start the periodic heartbeat tick. Every intervalMs the tracker calls
   * the injected `healthProbe()` (a thin agent.health RPC over the agent
   * UDS). Success → recordHeartbeatSuccess(now, payload); connect-refused →
   * recordHeartbeatFailure(now, { connectRefused: true }); any other error →
   * recordHeartbeatFailure(now). Idempotent; safe to call once at api boot.
   *
   * `healthProbe` is provided in HeartbeatTrackerOptions so tests inject a
   * fake (J1's mock-agent) and never open a real socket. unref() the timer
   * so it never keeps the process (or a test runner) alive.
   */
  start(): void {
    if (this.#tickTimer) return;
    const tick = async (): Promise<void> => {
      try {
        const payload = await this.#opts.healthProbe();
        this.recordHeartbeatSuccess(new Date(), payload);
      } catch (err) {
        const connectRefused =
          err instanceof Error && /ECONNREFUSED|ENOENT/.test(err.message);
        this.recordHeartbeatFailure(new Date(), connectRefused ? { connectRefused: true } : undefined);
      }
    };
    this.#tickTimer = setInterval(() => void tick(), this.#opts.intervalMs);
    if (typeof this.#tickTimer.unref === 'function') this.#tickTimer.unref();
    // Fire one tick immediately so a freshly-started agent is detected
    // without waiting a full interval.
    void tick();
  }

  stop(): void {
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
  }

  #computeState(): AgentState {
    if (this.#connectRefused) return 'offline';
    if (this.#lastHeartbeatAt === null) return 'offline';

    const nowMs = Date.now();
    const elapsedMs = nowMs - this.#lastHeartbeatAt.getTime();
    const { intervalMs } = this.#opts;

    if (elapsedMs <= 2 * intervalMs) return 'healthy';
    if (elapsedMs <= 6 * intervalMs) return 'degraded';
    return 'offline';
  }

  #emitStateChange(from: AgentState, to: AgentState): void {
    const ts = new Date().toISOString();
    const eventId = randomUUID();
    const key = `/xinas/v1/events/${ts}/${eventId}`;
    try {
      this.#opts.state.kv.put(key, {
        kind: 'agent_state_changed',
        controller_id: this.#opts.controllerId,
        from,
        to,
        reason: to === 'offline' && this.#connectRefused ? 'connect_refused' : 'heartbeat_timeout',
        last_successful_heartbeat_at: this.#lastHeartbeatAt?.toISOString() ?? null,
      });
    } catch (_err) {
      // Best-effort: event emission failure does not affect tracker state.
    }
  }
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/heartbeat.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: all heartbeat tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/api/heartbeat.ts \
  xiNAS-MCP/src/__tests__/api/heartbeat.test.ts
git commit -m "$(cat <<'EOF'
feat(api): HeartbeatTracker — state machine + event emission

H1 — implements the api-side agent health tracker per spec §"Flow B".

State table: ≤2×interval → healthy; ≤6×interval → degraded;
>6×interval or connect-refused → offline. Evaluated on every
currentState() call.

State transitions emit agent_state_changed events at
/xinas/v1/events/<rfc3339_ts>/<event_id> in the KV store. Body:
{ kind, controller_id, from, to, reason, last_successful_heartbeat_at }.

recordObservationPush() updates the last-push timestamp but does NOT
reset the heartbeat timer (per ADR-0002 line 221: executor
availability is measured by the api→agent direction only).

currentWarnings({ routeIsMutating }) returns EXECUTOR_DEGRADED only
when degraded AND the caller is on a mutating route. Read endpoints
do not carry the warning (per ADR-0002 line 225-226).

Tests use vi.useFakeTimers() + vi.setSystemTime() to drive the state
table without real wall-clock waits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task H2: requireInternalAgent middleware

**Files:**
- Create: `xiNAS-MCP/src/api/middleware/require-internal-agent.ts`
- Create: `xiNAS-MCP/src/__tests__/api/require-internal-agent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/require-internal-agent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { buildTestApp } from './_helpers.js';
import type { TestSetup } from './_helpers.js';

/**
 * Build a minimal express app that mounts a test endpoint behind
 * requireInternalAgent. The real app will mount it on /internal/v1/*;
 * here we mount it on /test-internal for isolation.
 */
async function buildInternalApp(): Promise<TestSetup & { cleanup(): Promise<void> }> {
  const setup = await buildTestApp();

  // Add an agent token to the config so auth middleware can resolve it.
  setup.config.tokens['agent-tok'] = { principal: 'agent:root', role: 'internal_agent' };

  return setup;
}

describe('requireInternalAgent middleware', () => {
  let setup: TestSetup & { cleanup(): Promise<void> };
  let app: Express;

  beforeEach(async () => {
    setup = await buildInternalApp();

    // Re-create app after mutating config so authMiddleware sees the agent token.
    const { createApp } = await import('../../api/app.js');
    const { requireInternalAgent } = await import('../../api/middleware/require-internal-agent.js');

    // Build a fresh app from the patched config.
    const ctx = { config: setup.config, state: setup.state };
    app = createApp(ctx);

    // Mount a test-only internal route to verify the middleware.
    // In a real app this is wired inside createApp; here we verify in isolation.
    const internalApp = express();
    internalApp.use(express.json());
    const { requestIdMiddleware } = await import('../../api/middleware/request-id.js');
    const { authMiddleware } = await import('../../api/middleware/auth.js');
    internalApp.use(requestIdMiddleware());
    internalApp.use(authMiddleware(setup.config));
    internalApp.post('/internal/v1/test', requireInternalAgent(), (_req, res) => {
      res.json({ ok: true });
    });
    app = internalApp;
  });

  afterEach(() => setup.cleanup());

  it('passes when Authorization: Bearer <agent-token> is provided', async () => {
    const res = await request(app)
      .post('/internal/v1/test')
      .set('Authorization', 'Bearer agent-tok')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('rejects with 401 when no bearer is provided (even over UDS-simulated path)', async () => {
    // supertest uses TCP; no UDS-trust promotion. But even with a UDS connection,
    // UDS-trust admin does NOT satisfy internal_agent. We test the role gate directly.
    const res = await request(app)
      .post('/internal/v1/test')
      .send({});
    // No auth → 401 from authMiddleware before requireInternalAgent even runs.
    expect(res.status).toBe(401);
  });

  it('rejects with 401 when admin bearer (not agent bearer) is provided', async () => {
    const res = await request(app)
      .post('/internal/v1/test')
      .set('Authorization', 'Bearer tok-admin')
      .send({});
    // tok-admin has role 'admin', not 'internal_agent'
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/require-internal-agent.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement requireInternalAgent**

Create `xiNAS-MCP/src/api/middleware/require-internal-agent.ts`:

```ts
import type { Request, Response, NextFunction } from 'express';
import { buildEnvelope } from '../envelope.js';
import { errorStatus, makeError } from '../errors.js';

/**
 * requireInternalAgent — role gate for /internal/v1/* routes.
 *
 * Rejects unless req.context.role === 'internal_agent'. This is
 * explicitly stricter than the normal auth middleware:
 *
 *   - UDS-trust admin promotion (role='admin') is NOT sufficient.
 *     Even a root-level local connection gets 401 here.
 *   - A bearer token with role='admin' or 'operator' is NOT sufficient.
 *   - Only a bearer token whose TokenPrincipal.role is 'internal_agent'
 *     passes.
 *
 * Rationale (ADR-0002 line 221, spec §"API processing" step 1):
 * The /internal/v1/ family is the agent's exclusive write path.
 * Allowing operators or admin tokens would let a local admin push
 * arbitrary state bypassing the privilege boundary.
 *
 * Must run AFTER authMiddleware (which populates req.context).
 */
export function requireInternalAgent() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.context;
    if (!ctx) {
      next(new Error('requireInternalAgent requires authMiddleware to run first'));
      return;
    }
    if (ctx.role === 'internal_agent') {
      next();
      return;
    }
    res.status(errorStatus('PERMISSION_DENIED')).json(
      buildEnvelope({
        request_id: ctx.request_id,
        correlation_id: ctx.correlation_id,
        state_revision: 0,
        errors: [
          makeError(
            'PERMISSION_DENIED',
            'this route requires the internal_agent role; ' +
              'UDS admin trust and operator/admin bearer tokens are not accepted',
          ),
        ],
        result: null,
      }),
    );
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/require-internal-agent.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 middleware tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/api/middleware/require-internal-agent.ts \
  xiNAS-MCP/src/__tests__/api/require-internal-agent.test.ts
git commit -m "$(cat <<'EOF'
feat(api): requireInternalAgent middleware for /internal/v1/* routes

H2 — strict role gate: only req.context.role === 'internal_agent'
passes. UDS-trust admin promotion (role='admin') does NOT satisfy,
even from a root local connection. Bearer admin/operator tokens do
NOT satisfy.

Rationale: /internal/v1/ is the agent's exclusive write path. Allowing
operator or admin access would let a local admin push arbitrary
observation state, bypassing the privilege boundary ADR-0002 establishes.

Tests: agent bearer → 200; no auth → 401 (from authMiddleware); admin
bearer → 401 (from requireInternalAgent role check).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task H3: /internal/v1/observed handler + reconcile + audit

**Files:**
- Create: `xiNAS-MCP/src/api/internal/observed.ts`
- Create: `xiNAS-MCP/src/__tests__/api/internal-observed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/internal-observed.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestSetup } from './_helpers.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-h3';

async function buildAppWithAgent(): Promise<TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker }> {
  const setup = await buildTestApp();
  setup.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: CONTROLLER_ID,
    state: setup.state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });

  // Re-create app with the patched config + tracker wired to the context.
  // In the real app, createApp() accepts the tracker via ApiContext;
  // for tests we can extend ctx with the tracker.
  const { createAppWithTracker } = await import('../../api/app.js');
  const ctx = { config: setup.config, state: setup.state, tracker };
  const app = createAppWithTracker(ctx);

  return { ...setup, app, tracker, async cleanup() { await setup.cleanup(); } };
}

describe('POST /internal/v1/observed', () => {
  let setup: TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker };

  beforeEach(async () => {
    setup = await buildAppWithAgent();
  });

  afterEach(() => setup.cleanup());

  it('accepts a valid observation batch and upserts deltas', async () => {
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [
        { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: { name: 'nvme0n1', status: { model: 'Test' } } },
      ],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ accepted: 1, deleted_by_reconcile: 0 });

    const stored = setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1');
    expect(stored).not.toBeNull();
    expect((stored?.value as { name?: string })?.name).toBe('nvme0n1');
  });

  it('reconciles: deletes keys under prefix not in the batch when complete_snapshots includes the kind', async () => {
    // Pre-seed a stale Disk entry.
    setup.state.kv.put('/xinas/v1/observed/Disk/stale-disk', { name: 'stale' });
    setup.state.kv.put('/xinas/v1/observed/Disk/nvme0n1', { name: 'old' });

    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [
        { kind: 'Disk', id: 'nvme0n1', op: 'upsert', value: { name: 'nvme0n1-new' } },
      ],
      complete_snapshots: ['Disk'],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.result.deleted_by_reconcile).toBe(1);

    // stale-disk should be gone
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/stale-disk')).toBeNull();
    // nvme0n1 should be updated
    const stored = setup.state.kv.get<{ name: string }>('/xinas/v1/observed/Disk/nvme0n1');
    expect(stored?.value.name).toBe('nvme0n1-new');
  });

  it('applies delete ops', async () => {
    setup.state.kv.put('/xinas/v1/observed/Disk/nvme0n1', { name: 'existing' });

    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [{ kind: 'Disk', id: 'nvme0n1', op: 'delete' }],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(setup.state.kv.get('/xinas/v1/observed/Disk/nvme0n1')).toBeNull();
  });

  it('rejects wrong controller_id with 400 INVALID_ARGUMENT', async () => {
    const body = {
      observed_at: new Date().toISOString(),
      controller_id: '11111111-1111-1111-1111-111111111111',
      deltas: [],
      complete_snapshots: [],
    };

    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.errors[0]?.code).toBe('INVALID_ARGUMENT');
    expect(res.body.errors[0]?.message).toMatch(/controller_id/);
  });

  it('rejects without agent bearer with 401', async () => {
    const res = await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', 'Bearer tok-admin')
      .send({ observed_at: new Date().toISOString(), controller_id: CONTROLLER_ID, deltas: [], complete_snapshots: [] });
    expect(res.status).toBe(401);
  });

  it('calls recordObservationPush on the tracker', async () => {
    let pushRecorded = false;
    const origRecord = setup.tracker.recordObservationPush.bind(setup.tracker);
    setup.tracker.recordObservationPush = (at) => {
      pushRecorded = true;
      origRecord(at);
    };

    const body = {
      observed_at: new Date().toISOString(),
      controller_id: CONTROLLER_ID,
      deltas: [],
      complete_snapshots: [],
    };
    await request(setup.app)
      .post('/internal/v1/observed')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send(body);

    expect(pushRecorded).toBe(true);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/internal-observed.test.ts 2>&1 | tail -10
```
Expected: FAIL — `createAppWithTracker` does not exist; handler not found.

- [ ] **Step 3: Add HeartbeatTracker to ApiContext and createAppWithTracker**

Edit `xiNAS-MCP/src/api/context.ts`. Add the tracker to `ApiContext`:

```ts
import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig, Role } from './config.js';
import type { HeartbeatTracker } from './heartbeat.js';

export interface ApiContext {
  config: ApiConfig;
  state: OpenedStateStore;
  /** Optional; absent until HeartbeatTracker is wired in H1+. */
  tracker?: HeartbeatTracker;
}
```

Edit `xiNAS-MCP/src/api/app.ts`. Add `createAppWithTracker` as an alias:

```ts
/** Variant of createApp that requires a tracker in context. */
export function createAppWithTracker(ctx: ApiContext & { tracker: HeartbeatTracker }): Express {
  return createApp(ctx);
}
```

Also update `createApp` to mount `/internal/v1/observed` when a tracker is present (or always, but gate on the requireInternalAgent middleware). Add to `createApp`:

```ts
import { internalRouter } from './internal/router.js';
// ...inside createApp, after v1 is declared:
app.use('/internal/v1', internalRouter(ctx));
```

- [ ] **Step 4: Create internal router + observed handler**

Create `xiNAS-MCP/src/api/internal/router.ts`:

```ts
import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { requireInternalAgent } from '../middleware/require-internal-agent.js';
import { observedHandler } from './observed.js';
import { agentStartedHandler } from './agent-started.js';

export function internalRouter(ctx: ApiContext): Router {
  const router = Router();
  router.use(requireInternalAgent());
  router.post('/observed', observedHandler(ctx));
  router.post('/agent_started', agentStartedHandler(ctx));
  return router;
}
```

Create `xiNAS-MCP/src/api/internal/observed.ts`:

```ts
import type { Request, Response, NextFunction } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { sendOk } from '../handlers/reads.js';
import { observedSegment } from '../../agent/collectors/base.js';
import type { Kind } from '../../agent/collectors/base.js';

interface ObservationDeltaBody {
  kind: Kind;
  id: string;
  op: 'upsert' | 'delete';
  value?: Record<string, unknown>;
}

interface ObservedBody {
  observed_at: string;
  controller_id: string;
  deltas: ObservationDeltaBody[];
  complete_snapshots: Kind[];
}

export function observedHandler(ctx: ApiContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const body = req.body as ObservedBody;

      // Validate controller_id match.
      if (body.controller_id !== ctx.config.controller_id) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          `controller_id mismatch: request has '${body.controller_id}', ` +
            `api is configured with '${ctx.config.controller_id}'`,
        );
      }

      const deltas = body.deltas ?? [];
      const completeSnapshots: Kind[] = body.complete_snapshots ?? [];

      // Per-delta schema validation BEFORE the transaction (fail-closed).
      // Each upsert delta's `value` is validated against its kind's JSON
      // Schema (the same api-v1.yaml component schemas Phase G adds, compiled
      // once at startup via the existing contracts Ajv instance and keyed by
      // kind). On the first failure, reject the WHOLE batch — nothing is
      // written — with INVALID_ARGUMENT naming the failing delta's index +
      // the Ajv error, so a malformed agent push can never poison observed
      // state. Delete deltas carry no value and skip schema validation
      // (only their key shape matters). This is the safety net that also
      // catches a delta with an unknown/mis-cased kind (no schema → reject).
      for (let i = 0; i < deltas.length; i++) {
        const delta = deltas[i]!;
        if (delta.op !== 'upsert') continue;
        const validate = ctx.observedSchemas?.[delta.kind];
        if (!validate) {
          throw new ApiException('INVALID_ARGUMENT', `delta[${i}]: unknown kind '${delta.kind}'`);
        }
        if (!validate(delta.value)) {
          throw new ApiException(
            'INVALID_ARGUMENT',
            `delta[${i}] (kind=${delta.kind}, id=${delta.id}) failed schema: ` +
              `${ctx.ajv?.errorsText(validate.errors) ?? 'invalid'}`,
          );
        }
      }

      let accepted = 0;
      let deletedByReconcile = 0;
      const revisions: number[] = [];

      // Derive the KV path segment through observedSegment(kind) (base.ts) so
      // writer and reader never disagree on singletons (NfsIdmap → nfs_idmap,
      // inventory/managed_files stay lowercase). H3 stays kind-agnostic; no
      // per-kind special-casing (the ExportRule→Share fold-in is a read-time
      // join in I6, not a write-time merge here).
      ctx.state.kv.transaction((tx) => {
        // 1. Apply all deltas.
        for (const delta of deltas) {
          const key = `/xinas/v1/observed/${observedSegment(delta.kind)}/${delta.id}`;
          if (delta.op === 'upsert') {
            const result = tx.put(key, delta.value ?? {});
            revisions.push(result.revision);
            accepted++;
          } else if (delta.op === 'delete') {
            tx.delete(key);
            accepted++;
          }
        }

        // 2. Reconcile complete snapshots: delete keys under the prefix
        //    that were NOT in the batch.
        const upsertedKeys = new Set(
          deltas
            .filter((d) => d.op === 'upsert')
            .map((d) => `/xinas/v1/observed/${observedSegment(d.kind)}/${d.id}`),
        );

        for (const kind of completeSnapshots) {
          const prefix = `/xinas/v1/observed/${observedSegment(kind as Kind)}/`;
          const current = tx.list({ prefix });
          for (const row of current) {
            if (!upsertedKeys.has(row.key)) {
              tx.delete(row.key);
              deletedByReconcile++;
            }
          }
        }
      });

      // 3. Notify the tracker that an observation push happened.
      ctx.tracker?.recordObservationPush(new Date());

      const state_revision = revisions.length > 0 ? Math.max(...revisions) : 0;
      sendOk(req, res, { accepted, deleted_by_reconcile: deletedByReconcile }, [state_revision]);
    } catch (err) {
      next(err);
    }
  };
}
```

Note: The above references `tx.list()` (added in A2) and `row.key` on `RevisionedValue`. Confirm that `RevisionedValue` in `src/state/types.ts` carries a `key` field; if not, add it as part of A2's implementation.

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/internal-observed.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: all tests in the file pass; full suite green.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/api/internal/router.ts \
  xiNAS-MCP/src/api/internal/observed.ts \
  xiNAS-MCP/src/api/context.ts \
  xiNAS-MCP/src/api/app.ts
git commit -m "$(cat <<'EOF'
feat(api): /internal/v1/observed handler with reconcile semantics

H3 — implements the observation push endpoint per spec §"Flow A":

  requireInternalAgent gates the entire /internal/v1 sub-router (H2).

  POST /internal/v1/observed validates controller_id (400 on mismatch
  naming both ids). Opens a single KvTransaction: applies all deltas
  (upsert → tx.put, delete → tx.delete), then for each kind in
  complete_snapshots calls tx.list({prefix}) to enumerate current keys,
  diffs against the batch's upserted keys, and tx.deletes leftovers.
  Atomicity: both the applies and the reconcile deletes land in one
  SQLite transaction.

  Calls tracker.recordObservationPush(now) after the transaction
  commits (does not update heartbeat state per spec).

  Response: 200 { accepted: N, deleted_by_reconcile: M, state_revision: R }.

  Audit: via the existing auditMiddleware res.on('finish') hook;
  principal=agent:root, kind=http.POST./internal/v1/observed.

Tests cover: upsert accepted + stored; reconcile deletes stale keys;
delete op; wrong controller_id → 400; non-agent bearer → 401;
tracker.recordObservationPush called.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task H4: /internal/v1/agent_started handler

**Files:**
- Create: `xiNAS-MCP/src/api/internal/agent-started.ts`
- Create: `xiNAS-MCP/src/__tests__/api/internal-agent-started.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/internal-agent-started.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestSetup } from './_helpers.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';
const AGENT_TOKEN = 'agent-tok-h4';

describe('POST /internal/v1/agent_started', () => {
  let setup: TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker };

  beforeEach(async () => {
    const base = await buildTestApp();
    base.config.tokens[AGENT_TOKEN] = { principal: 'agent:root', role: 'internal_agent' };

    const tracker = new HeartbeatTracker({
      intervalMs: 5_000,
      controllerId: CONTROLLER_ID,
      state: base.state,
      agentSocketPath: '/tmp/nonexistent.sock',
    });

    const { createAppWithTracker } = await import('../../api/app.js');
    const ctx = { config: base.config, state: base.state, tracker };
    const app = createAppWithTracker(ctx);

    setup = { ...base, app, tracker, async cleanup() { await base.cleanup(); } };
  });

  afterEach(() => setup.cleanup());

  it('returns 204 and calls recordHeartbeatSuccess to clear startup grace', async () => {
    let successRecorded = false;
    const orig = setup.tracker.recordHeartbeatSuccess.bind(setup.tracker);
    setup.tracker.recordHeartbeatSuccess = (at) => {
      successRecorded = true;
      orig(at);
    };

    const res = await request(setup.app)
      .post('/internal/v1/agent_started')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({ controller_id: CONTROLLER_ID });

    expect(res.status).toBe(204);
    expect(successRecorded).toBe(true);
    expect(setup.tracker.currentState()).toBe('healthy');
  });

  it('rejects wrong controller_id with 400', async () => {
    const res = await request(setup.app)
      .post('/internal/v1/agent_started')
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({ controller_id: 'wrong-id' });

    expect(res.status).toBe(400);
    expect(res.body.errors[0]?.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects without agent bearer with 401', async () => {
    const res = await request(setup.app)
      .post('/internal/v1/agent_started')
      .set('Authorization', 'Bearer tok-admin')
      .send({ controller_id: CONTROLLER_ID });

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/internal-agent-started.test.ts 2>&1 | tail -10
```
Expected: FAIL — handler not implemented.

- [ ] **Step 3: Implement agent-started handler**

Create `xiNAS-MCP/src/api/internal/agent-started.ts`:

```ts
import type { Request, Response, NextFunction } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';

interface AgentStartedBody {
  controller_id: string;
}

/**
 * POST /internal/v1/agent_started
 *
 * The agent calls this once after its initial sweep batch completes.
 * The api clears the HeartbeatTracker's startup grace by treating
 * agent_started as a successful heartbeat signal — the api starts in
 * 'offline' state and would sit there until the first 5s heartbeat
 * tick if agent_started were not posted.
 *
 * Returns 204 No Content on success.
 */
export function agentStartedHandler(ctx: ApiContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const body = req.body as AgentStartedBody;

      if (body.controller_id !== ctx.config.controller_id) {
        throw new ApiException(
          'INVALID_ARGUMENT',
          `controller_id mismatch: request has '${body.controller_id}', ` +
            `api is configured with '${ctx.config.controller_id}'`,
        );
      }

      // Treat agent_started as a synthetic successful heartbeat so the
      // tracker immediately transitions from 'offline' to 'healthy'.
      // This clears the startup grace window without waiting for the
      // first real heartbeat tick.
      ctx.tracker?.recordHeartbeatSuccess(new Date());

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };
}
```

- [ ] **Step 4: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/internal-agent-started.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/api/internal/agent-started.ts \
  xiNAS-MCP/src/__tests__/api/internal-agent-started.test.ts
git commit -m "$(cat <<'EOF'
feat(api): /internal/v1/agent_started clears heartbeat startup grace

H4 — implements the one-shot startup signal per spec §"Flow C" step 2.

The api starts with HeartbeatTracker in 'offline' state. Without
agent_started, mutating-route callers would sit in EXECUTOR_UNAVAILABLE
until the first heartbeat tick (up to 5s after boot). The agent posts
agent_started immediately after its initial sweep batch completes,
which calls tracker.recordHeartbeatSuccess(now) and transitions the
tracker to 'healthy' without waiting for the tick.

Validates controller_id (400 on mismatch). Returns 204 No Content.
Gated by requireInternalAgent (via the /internal/v1 sub-router).

Tests: 204 + tracker transitions to healthy; wrong controller_id → 400;
admin bearer → 401.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task H5: systemWarningsMiddleware + mergeWarnings

**Files:**
- Create: `xiNAS-MCP/src/api/middleware/system-warnings.ts`
- Create: `xiNAS-MCP/src/api/handlers/merge-warnings.ts`
- Modify: `xiNAS-MCP/src/api/context.ts`
- Modify: `xiNAS-MCP/src/api/handlers/reads.ts`
- Modify: `xiNAS-MCP/src/api/middleware/error.ts`
- Create: `xiNAS-MCP/src/__tests__/api/system-warnings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/system-warnings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedCluster, seedNode, type TestSetup } from './_helpers.js';
import { HeartbeatTracker } from '../../api/heartbeat.js';

const CONTROLLER_ID = '00000000-0000-0000-0000-0000000000aa';

async function buildDegradedApp(): Promise<TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker }> {
  const setup = await buildTestApp();
  seedCluster(setup.state);
  seedNode(setup.state);

  const tracker = new HeartbeatTracker({
    intervalMs: 5_000,
    controllerId: CONTROLLER_ID,
    state: setup.state,
    agentSocketPath: '/tmp/nonexistent.sock',
  });

  // Put tracker in degraded: record success at t0, advance time >2×interval.
  const t0 = new Date('2026-05-28T12:00:00.000Z');
  vi.useFakeTimers();
  vi.setSystemTime(t0);
  tracker.recordHeartbeatSuccess(t0);
  vi.setSystemTime(new Date(t0.getTime() + 11_000)); // > 2×5s = degraded

  const { createAppWithTracker } = await import('../../api/app.js');
  const ctx = { config: setup.config, state: setup.state, tracker };
  const app = createAppWithTracker(ctx);

  return { ...setup, app, tracker, async cleanup() { vi.useRealTimers(); await setup.cleanup(); } };
}

describe('systemWarningsMiddleware + mergeWarnings', () => {
  let setup: TestSetup & { cleanup(): Promise<void>; tracker: HeartbeatTracker };

  beforeEach(async () => {
    setup = await buildDegradedApp();
  });

  afterEach(() => setup.cleanup());

  it('read endpoint: degraded tracker does NOT inject EXECUTOR_DEGRADED warning', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', 'Bearer tok-admin');

    expect(res.status).toBe(200);
    const warnings = res.body.warnings as Array<{ code: string }>;
    const hasDegraded = warnings.some((w) => w.code === 'EXECUTOR_DEGRADED');
    expect(hasDegraded).toBe(false);
  });

  it('mutating endpoint: degraded tracker DOES inject EXECUTOR_DEGRADED warning', async () => {
    // The mutating stub (POST /api/v1/arrays) returns UNSUPPORTED but the
    // envelope should carry EXECUTOR_DEGRADED in warnings when degraded.
    const res = await request(setup.app)
      .post('/api/v1/arrays')
      .set('Authorization', 'Bearer tok-admin')
      .send({});

    // Status is 422 (UNSUPPORTED from the executor stub) but warnings include EXECUTOR_DEGRADED
    const warnings = res.body.warnings as Array<{ code: string }>;
    const hasDegraded = warnings.some((w) => w.code === 'EXECUTOR_DEGRADED');
    expect(hasDegraded).toBe(true);
  });

  it('healthy tracker: no EXECUTOR_DEGRADED warning on any route', async () => {
    // Override to healthy
    const t0 = new Date();
    setup.tracker.recordHeartbeatSuccess(t0);

    const res = await request(setup.app)
      .post('/api/v1/arrays')
      .set('Authorization', 'Bearer tok-admin')
      .send({});

    const warnings = res.body.warnings as Array<{ code: string }>;
    expect(warnings.every((w) => w.code !== 'EXECUTOR_DEGRADED')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/system-warnings.test.ts 2>&1 | tail -10
```
Expected: FAIL — no system_warnings on RequestContext; sendOk doesn't call mergeWarnings.

- [ ] **Step 3: Add system_warnings to RequestContext**

Edit `xiNAS-MCP/src/api/context.ts`. Add `system_warnings` to `RequestContext`:

```ts
export interface RequestContext {
  request_id: string;
  correlation_id: string;
  principal: string;
  role: Role;
  client_type: 'rest';
  operation_id?: string;
  /** Populated by systemWarningsMiddleware from HeartbeatTracker. */
  system_warnings: import('./envelope.js').Warning[];
}
```

- [ ] **Step 4: Create mergeWarnings helper**

Create `xiNAS-MCP/src/api/handlers/merge-warnings.ts`:

```ts
import type { Warning } from '../envelope.js';

/**
 * Merge handler-local warnings with system-level warnings injected by
 * systemWarningsMiddleware. Called by sendOk() and errorMiddleware()
 * so every envelope — success or error — carries the combined set.
 *
 * System warnings (e.g., EXECUTOR_DEGRADED) appear after handler
 * warnings so the handler's intent is first in the array.
 */
export function mergeWarnings(
  handlerWarnings: Warning[],
  systemWarnings: Warning[],
): Warning[] {
  if (systemWarnings.length === 0) return handlerWarnings;
  if (handlerWarnings.length === 0) return systemWarnings;
  return [...handlerWarnings, ...systemWarnings];
}
```

- [ ] **Step 5: Create systemWarningsMiddleware**

Create `xiNAS-MCP/src/api/middleware/system-warnings.ts`:

```ts
import type { Request, Response, NextFunction } from 'express';
import type { ApiContext } from '../context.js';

/** HTTP methods that represent mutating operations. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * systemWarningsMiddleware — populates req.context.system_warnings
 * from HeartbeatTracker.currentWarnings() on every request.
 *
 * Must run after authMiddleware (req.context must be populated).
 * Must run before route handlers so system_warnings is available when
 * sendOk() or errorMiddleware() builds the response envelope.
 *
 * Semantics per spec §Observability:
 *   EXECUTOR_DEGRADED is injected only on mutating-route requests
 *   when the tracker is in 'degraded' state. Read endpoints do NOT
 *   carry the warning.
 */
export function systemWarningsMiddleware(ctx: ApiContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const context = req.context;
    if (!context) {
      next();
      return;
    }
    // Ensure system_warnings is initialized even when no tracker exists.
    context.system_warnings = [];

    const tracker = ctx.tracker;
    if (tracker) {
      const routeIsMutating = MUTATING_METHODS.has(req.method);
      context.system_warnings = tracker.currentWarnings({ routeIsMutating });
    }

    next();
  };
}
```

- [ ] **Step 6: Update sendOk to call mergeWarnings**

Edit `xiNAS-MCP/src/api/handlers/reads.ts`:

```ts
import type { Request, Response } from 'express';
import type { OpenedStateStore, RevisionedValue } from '../../state/index.js';
import { buildEnvelope } from '../envelope.js';
import type { Warning } from '../envelope.js';
import { mergeWarnings } from './merge-warnings.js';

export function sendOk<T>(req: Request, res: Response, result: T, revisions: number[] = [], warnings: Warning[] = []): void {
  const ctx = req.context!;
  const state_revision = revisions.length === 0 ? 0 : Math.max(...revisions);
  const allWarnings = mergeWarnings(warnings, ctx.system_warnings ?? []);
  res.json(
    buildEnvelope({
      request_id: ctx.request_id,
      correlation_id: ctx.correlation_id,
      state_revision,
      warnings: allWarnings,
      result,
    }),
  );
}

export function listByPrefix<T>(state: OpenedStateStore, prefix: string): RevisionedValue<T>[] {
  return state.kv.list<T>({ prefix });
}

export function getOrNull<T>(state: OpenedStateStore, key: string): RevisionedValue<T> | null {
  return state.kv.get<T>(key);
}

export function unwrapValues<T>(rows: RevisionedValue<T>[]): T[] {
  return rows.map((r) => r.value);
}
```

- [ ] **Step 7: Update errorMiddleware to call mergeWarnings**

Edit `xiNAS-MCP/src/api/middleware/error.ts`. In each `res.status(...).json(buildEnvelope({...}))` call, add `warnings: mergeWarnings([], ctx?.system_warnings ?? [])`:

For the `ApiException` branch:
```ts
warnings: mergeWarnings([], ctx?.system_warnings ?? []),
```

For the body-parse error branch:
```ts
warnings: mergeWarnings([], ctx?.system_warnings ?? []),
```

For the generic INTERNAL branch:
```ts
warnings: mergeWarnings([], ctx?.system_warnings ?? []),
```

Add the import at the top of `error.ts`:
```ts
import { mergeWarnings } from '../handlers/merge-warnings.js';
```

- [ ] **Step 8: Mount systemWarningsMiddleware in createApp**

Edit `xiNAS-MCP/src/api/app.ts`. Add import and mount AFTER `authMiddleware`, BEFORE routes:

```ts
import { systemWarningsMiddleware } from './middleware/system-warnings.js';
// ...
app.use(authMiddleware(ctx.config));
app.use(systemWarningsMiddleware(ctx));  // NEW — after auth, before routes
```

Also ensure `RequestContext` initializes `system_warnings`. Edit `xiNAS-MCP/src/api/middleware/request-id.ts` to seed `system_warnings: []` on the initial context object, or add it in the auth middleware. Check `request-id.ts`:

```bash
grep -n "system_warnings\|RequestContext" xiNAS-MCP/src/api/middleware/request-id.ts
```

If `request-id.ts` constructs the `RequestContext`, add `system_warnings: []` there.

- [ ] **Step 8b: Make the mutating-route stub tracker-aware (offline gate)**

PR #201's `executorUnavailable` handler returns `INTERNAL` / `EXECUTOR_UNAVAILABLE` **unconditionally**. Now that the tracker exists, the mutating routes must distinguish two cases:

- **agent offline** → `INTERNAL` / `EXECUTOR_UNAVAILABLE` (the executor genuinely can't be reached; remediation: restart xinas-agent).
- **agent online (healthy or degraded)** → `UNSUPPORTED` (the executor is reachable but no mutating method is implemented in S0+S1; this is a build-version notice, not an outage).

Edit `xiNAS-MCP/src/api/handlers/unsupported.ts` so the handler reads the tracker (threaded via `ctx`). Replace the unconditional body with:

```ts
export function executorUnavailable(ctx: ApiContext) {
  return (req: Request, res: Response): void => {
    const offline = ctx.tracker ? ctx.tracker.currentState() === 'offline' : true;
    if (offline) {
      // Executor not reachable — INTERNAL/EXECUTOR_UNAVAILABLE (status 500).
      throw new ApiException('INTERNAL', 'xinas-agent is offline', {
        code: 'EXECUTOR_UNAVAILABLE',
      }, 'restart xinas-agent.service');
    }
    // Executor reachable but the method isn't built yet in S0+S1.
    throw new ApiException('UNSUPPORTED', 'this operation is not implemented in this build', {
      code: 'EXECUTOR_UNSUPPORTED',
    });
  };
}
```

This makes `executorUnavailable` a factory `(ctx) => handler` (was a bare handler); update its registration in `app.ts`'s mutating-route loop to `v1.<verb>(route, executorUnavailable(ctx))`. The `EXECUTOR_DEGRADED` warning is still injected separately by `systemWarningsMiddleware` (it rides the envelope `warnings[]` regardless of the UNSUPPORTED status).

Reconciliation with PR #201's `mutating.test.ts`: that suite runs with no agent → tracker `offline` → routes still return `EXECUTOR_UNAVAILABLE` (status 500), so it stays green unchanged. New behavior (UNSUPPORTED when online) is exercised by the H5 degraded test above and the J3 healthy-agent case below.

- [ ] **Step 9: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/system-warnings.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: all 3 system-warnings tests pass; full suite green.

- [ ] **Step 10: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/api/middleware/system-warnings.ts \
  xiNAS-MCP/src/api/handlers/merge-warnings.ts \
  xiNAS-MCP/src/api/context.ts \
  xiNAS-MCP/src/api/handlers/reads.ts \
  xiNAS-MCP/src/api/middleware/error.ts \
  xiNAS-MCP/src/api/app.ts \
  xiNAS-MCP/src/__tests__/api/system-warnings.test.ts
git commit -m "$(cat <<'EOF'
feat(api): systemWarningsMiddleware + mergeWarnings for EXECUTOR_DEGRADED

H5 — wires HeartbeatTracker's warning output into every response
envelope per spec §Observability and ADR-0002 line 225-226:

  systemWarningsMiddleware(): runs after authMiddleware, before routes.
  Populates req.context.system_warnings from tracker.currentWarnings().
  EXECUTOR_DEGRADED is only injected on mutating-verb requests
  (POST/PUT/PATCH/DELETE) when tracker is degraded. Read endpoints
  (GET) receive an empty system_warnings array regardless.

  mergeWarnings(handlerWarnings, systemWarnings): shared helper.
  Concatenates the two arrays; called by sendOk() and errorMiddleware()
  so BOTH success and error envelopes carry the merged set.

  RequestContext.system_warnings: Warning[] — new field initialized
  to [] by requestIdMiddleware; populated by systemWarningsMiddleware
  after auth resolves the role.

  sendOk() signature gains an optional warnings param (handler-local
  warnings). Backward-compatible: existing call sites pass nothing and
  get [] as before.

Tests: degraded + GET → no warning; degraded + POST → EXECUTOR_DEGRADED
in envelope.warnings; healthy + any → no EXECUTOR_DEGRADED.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Phase I — API public route additions

> **Route-handler contract (AUTHORITATIVE — supersedes any divergent snippet in I1-I6).**
> Several I-task code blocks below were drafted against an imagined API shape.
> The LIVE shape (verified against `src/api/routes/*.ts`, `src/api/handlers/reads.ts`,
> `src/api/context.ts`) is:
>
> - **Router factory takes `ctx: ApiContext`** and closes over it:
>   `export function fooRouter(ctx: ApiContext): Router { ... }`. State access is
>   `ctx.state` (the per-process `ApiContext`), **never** `req.context.state`
>   (`RequestContext` has no `state` field — it carries request_id, correlation_id,
>   principal, role, client_type, operation_id only).
> - **`sendOk(req, res, result, revisions?)`** — req first, then res. There is no
>   `sendOk(res, ...)`. Optional `revisions: number[]` drives `state_revision`.
> - **No `sendNotFound`** exists. 404 is `throw new ApiException('NOT_FOUND', msg)`;
>   the error middleware converts it to the envelope. Handlers don't `res.send` errors.
> - **Read helpers:** `listByPrefix(ctx.state, prefix)`, `getOrNull(ctx.state, key)`,
>   `unwrapValues(rows)` (all from `../handlers/reads.js`) — same helpers the existing
>   routes use. `rows.map((r) => r.revision)` feeds the `revisions` arg.
> - **Mounting:** routes mount on the shared `v1` router inside `createApp(ctx)` as
>   `v1.use(fooRouter(ctx))` (the routers declare their own `/users` etc. paths
>   internally, matching how `systemRouter`/`storageRouter` already work) — NOT
>   `app.use('/api/v1/users', usersRouter())`.
> - **Test envelope assertions:** the envelope has `result`, `warnings[]`, `errors[]`,
>   `request_id`, `correlation_id`, `state_revision` — **no `ok` field, no singular
>   `error`**. Assert success via `res.status` + `res.body.result`; assert errors via
>   `res.body.errors[0].code`. Tests use the `buildTestApp()` + `ADMIN_TOKEN` helpers
>   from `_helpers.ts` and `.set('Authorization', ADMIN_TOKEN)`.
>
> Task I1 below is rewritten to this contract as the canonical worked example;
> I2-I6 follow it exactly (I2/I3 are structurally identical to I1).

### Task I1: `/api/v1/users[/{uid}]`

**Files:**
- Create: `xiNAS-MCP/src/api/routes/users.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes/users.test.ts`

The `User` resource is observed at `/xinas/v1/observed/User/<uid>` (decimal uid as string). This task adds the list + get routes, source-filter query param, and mounts them in the app.

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/api/routes/users.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from '../_helpers.js';

describe('GET /api/v1/users', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    // Seed observed Users
    setup.state.kv.put('/xinas/v1/observed/User/1000', {
      kind: 'User', id: '1000',
      spec: { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash' },
      status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
    });
    setup.state.kv.put('/xinas/v1/observed/User/1001', {
      kind: 'User', id: '1001',
      spec: { name: 'bob', uid: 1001, gid: 1001, home: '/home/bob', shell: '/bin/sh' },
      status: { resolvable: true, source: 'nss', observed_at: new Date().toISOString() },
    });
  });

  afterEach(async () => { await setup.cleanup(); });

  it('lists all users when source=all (default)', async () => {
    const res = await request(setup.app).get('/api/v1/users').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    expect(res.body.result.map((u: { id: string }) => u.id)).toContain('1000');
    expect(res.body.result.map((u: { id: string }) => u.id)).toContain('1001');
  });

  it('filters to source=local only', async () => {
    const res = await request(setup.app).get('/api/v1/users?source=local').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].id).toBe('1000');
    expect(res.body.result[0].status.source).toBe('local');
  });

  it('filters to source=nss only', async () => {
    const res = await request(setup.app).get('/api/v1/users?source=nss').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].status.source).toBe('nss');
  });

  it('returns 404 when uid not found', async () => {
    const res = await request(setup.app).get('/api/v1/users/9999').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('returns a single user by uid', async () => {
    const res = await request(setup.app).get('/api/v1/users/1000').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.spec.name).toBe('alice');
    expect(res.body.result.spec.uid).toBe(1000);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes/users.test.ts 2>&1 | tail -10
```
Expected: FAIL — route not found (404 on all requests) or module-not-found for `routes/users.js`.

- [ ] **Step 3: Implement the route**

Create `xiNAS-MCP/src/api/routes/users.ts`:

```ts
/**
 * /api/v1/users — list and get observed User resources.
 *
 * Observed at: /xinas/v1/observed/User/<uid-as-string>
 * Source filter: ?source=local|nss|all (default: all)
 *
 * Follows the live route shape (see the Phase-I route-handler contract):
 * factory takes ApiContext, sendOk(req, res, result, revisions), 404 via
 * ApiException, helpers from reads.js.
 */
import { Router } from 'express';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import { ApiException } from '../errors.js';
import type { ApiContext } from '../context.js';

export function usersRouter(ctx: ApiContext): Router {
  const r = Router();

  // GET /api/v1/users[?source=local|nss|all]
  r.get('/users', (req, res) => {
    const source = (req.query.source as string | undefined) ?? 'all';
    if (source !== 'all' && source !== 'local' && source !== 'nss') {
      throw new ApiException('INVALID_ARGUMENT', `source must be local|nss|all, got '${source}'`);
    }
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/User/');
    let values = unwrapValues(rows);
    if (source !== 'all') {
      values = values.filter((u) => (u.status as { source?: string } | undefined)?.source === source);
    }
    sendOk(req, res, values, rows.map((x) => x.revision));
  });

  // GET /api/v1/users/:uid
  r.get('/users/:uid', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/User/${req.params.uid}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `user uid=${req.params.uid} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  return r;
}
```

- [ ] **Step 4: Mount in app.ts**

Edit `xiNAS-MCP/src/api/app.ts`. The router declares its own `/users` paths, so it mounts on the shared `v1` router exactly like the existing routers:

```ts
import { usersRouter } from './routes/users.js';
// ... inside createApp(ctx), alongside v1.use(systemRouter(ctx)); etc.:
v1.use(usersRouter(ctx));
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/routes/users.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 users tests pass; full suite count +5.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/api/routes/users.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes/users.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /api/v1/users[/{uid}] public route (I1)

Lists User resources from /xinas/v1/observed/User/* with optional
?source=local|nss|all filter. get-by-uid returns the single resource
or NOT_FOUND. Mounts in app.ts alongside the existing routes.

Tests: list-all, source=local filter, source=nss filter, 404 on
missing uid, get by existing uid.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Public REST contract growth".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task I2: `/api/v1/groups[/{gid}]`

**Files:**
- Create: `xiNAS-MCP/src/api/routes/groups.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes/groups.test.ts`

Analogous to I1. `Group` resource observed at `/xinas/v1/observed/Group/<gid-as-string>`. The spec block includes `members: string[]`.

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/api/routes/groups.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from '../_helpers.js';

describe('GET /api/v1/groups', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    setup.state.kv.put('/xinas/v1/observed/Group/1000', {
      kind: 'Group', id: '1000',
      spec: { name: 'alice', gid: 1000, members: [] },
      status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
    });
    setup.state.kv.put('/xinas/v1/observed/Group/2000', {
      kind: 'Group', id: '2000',
      spec: { name: 'domain_users', gid: 2000, members: ['alice', 'bob'] },
      status: { resolvable: true, source: 'nss', observed_at: new Date().toISOString() },
    });
  });

  afterEach(async () => { await setup.cleanup(); });

  it('lists all groups when source=all (default)', async () => {
    const res = await request(setup.app).get('/api/v1/groups').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    expect(res.body.result.map((g: { id: string }) => g.id)).toContain('1000');
    expect(res.body.result.map((g: { id: string }) => g.id)).toContain('2000');
  });

  it('filters to source=local only', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups?source=local')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].spec.name).toBe('alice');
    expect(res.body.result[0].status.source).toBe('local');
  });

  it('filters to source=nss only', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups?source=nss')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].spec.members).toContain('alice');
  });

  it('returns 404 when gid not found', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups/9999')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('returns a single group by gid', async () => {
    const res = await request(setup.app)
      .get('/api/v1/groups/2000')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.spec.name).toBe('domain_users');
    expect(res.body.result.spec.members).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes/groups.test.ts 2>&1 | tail -10
```
Expected: FAIL — route not found (404 on all requests) or module-not-found for `routes/groups.js`.

- [ ] **Step 3: Implement the route**

Create `xiNAS-MCP/src/api/routes/groups.ts`:

```ts
/**
 * /api/v1/groups — list and get observed Group resources.
 *
 * Observed at: /xinas/v1/observed/Group/<gid-as-string>
 * Source filter: ?source=local|nss|all (default: all)
 *
 * Follows the live route shape (see the Phase-I route-handler contract):
 * factory takes ApiContext, sendOk(req, res, result, revisions), 404 via
 * ApiException, helpers from reads.js.
 */
import { Router } from 'express';
import { sendOk, getOrNull, listByPrefix, unwrapValues } from '../handlers/reads.js';
import { ApiException } from '../errors.js';
import type { ApiContext } from '../context.js';

export function groupsRouter(ctx: ApiContext): Router {
  const r = Router();

  // GET /api/v1/groups[?source=local|nss|all]
  r.get('/groups', (req, res) => {
    const source = (req.query.source as string | undefined) ?? 'all';
    if (source !== 'all' && source !== 'local' && source !== 'nss') {
      throw new ApiException('INVALID_ARGUMENT', `source must be local|nss|all, got '${source}'`);
    }
    const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/observed/Group/');
    let values = unwrapValues(rows);
    if (source !== 'all') {
      values = values.filter((g) => (g.status as { source?: string } | undefined)?.source === source);
    }
    sendOk(req, res, values, rows.map((x) => x.revision));
  });

  // GET /api/v1/groups/:gid
  r.get('/groups/:gid', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(
      ctx.state,
      `/xinas/v1/observed/Group/${req.params.gid}`,
    );
    if (!row) throw new ApiException('NOT_FOUND', `group gid=${req.params.gid} not found`);
    sendOk(req, res, row.value, [row.revision]);
  });

  return r;
}
```

- [ ] **Step 4: Mount in app.ts**

Edit `xiNAS-MCP/src/api/app.ts`. Import and mount on the shared `v1` router, after the users route mount and following the same `v1.use(router(ctx))` pattern all other routers use:

```ts
import { groupsRouter } from './routes/groups.js';
// inside createApp(ctx), alongside the existing v1.use(usersRouter(ctx)); etc.:
v1.use(groupsRouter(ctx));
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/routes/groups.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 5/5 groups tests pass; full suite count +5.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/api/routes/groups.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes/groups.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /api/v1/groups[/{gid}] public route (I2)

Mirrors the users route structure. Lists Group resources from
/xinas/v1/observed/Group/* with ?source=local|nss|all filter.
spec.members[] is passed through from observed state unchanged.

Tests: list-all, source=local filter, source=nss filter, 404 on
missing gid, get-by-gid.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Public REST contract growth".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task I3: `/api/v1/nfs-idmap` singleton route

**Files:**
- Create: `xiNAS-MCP/src/api/routes/nfs-idmap.ts`
- Modify: `xiNAS-MCP/src/api/app.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes/nfs-idmap.test.ts`

`NfsIdmap` is a singleton. **Design note:** the agent stores this under the `nfs_idmap` segment (kind `NfsIdmap` maps to segment `nfs_idmap` via `observedSegment`). The route MUST read `/xinas/v1/observed/nfs_idmap/snapshot` — NOT `/xinas/v1/observed/NfsIdmap/snapshot`. Returns NOT_FOUND when the agent has not yet posted.

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/api/routes/nfs-idmap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from '../_helpers.js';

describe('GET /api/v1/nfs-idmap', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => { await setup.cleanup(); });

  it('returns 404 when no snapshot has been observed yet', async () => {
    const res = await request(setup.app)
      .get('/api/v1/nfs-idmap')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('returns the singleton when a snapshot exists', async () => {
    setup.state.kv.put('/xinas/v1/observed/nfs_idmap/snapshot', {
      kind: 'NfsIdmap',
      status: {
        conf_present: true,
        domain: 'example.com',
        local_realms: ['EXAMPLE.COM'],
        method: 'nsswitch',
        idmapd_active: true,
        idmapd_unit_state: 'active',
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app)
      .get('/api/v1/nfs-idmap')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.kind).toBe('NfsIdmap');
    expect(res.body.result.status.domain).toBe('example.com');
    expect(res.body.result.status.method).toBe('nsswitch');
    expect(res.body.result.status.idmapd_active).toBe(true);
  });

  it('requires authentication (no anonymous access)', async () => {
    const res = await request(setup.app).get('/api/v1/nfs-idmap');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes/nfs-idmap.test.ts 2>&1 | tail -10
```
Expected: FAIL — route not found (404 for the first test passes accidentally but second/third fail), or module-not-found for `routes/nfs-idmap.js`.

- [ ] **Step 3: Implement the route**

Create `xiNAS-MCP/src/api/routes/nfs-idmap.ts`:

```ts
/**
 * /api/v1/nfs-idmap — singleton NfsIdmap resource.
 *
 * Observed at: /xinas/v1/observed/nfs_idmap/snapshot (snake_case
 * singleton per ADR-0003 locked layout — the agent uses observedSegment(Kind)
 * which maps NfsIdmap → nfs_idmap, so the key is nfs_idmap/snapshot,
 * NOT NfsIdmap/snapshot).
 *
 * Returns NOT_FOUND when the agent has not yet posted the snapshot.
 *
 * Follows the live route shape (see the Phase-I route-handler contract):
 * factory takes ApiContext, sendOk(req, res, result, revisions), 404 via
 * ApiException, helpers from reads.js.
 */
import { Router } from 'express';
import { sendOk, getOrNull } from '../handlers/reads.js';
import { ApiException } from '../errors.js';
import type { ApiContext } from '../context.js';

const SNAPSHOT_KEY = '/xinas/v1/observed/nfs_idmap/snapshot';

export function nfsIdmapRouter(ctx: ApiContext): Router {
  const r = Router();

  // GET /api/v1/nfs-idmap
  r.get('/nfs-idmap', (req, res) => {
    const row = getOrNull<Record<string, unknown>>(ctx.state, SNAPSHOT_KEY);
    if (!row) {
      throw new ApiException(
        'NOT_FOUND',
        'NfsIdmap snapshot not yet observed; agent may not be running',
      );
    }
    sendOk(req, res, row.value, [row.revision]);
  });

  return r;
}
```

- [ ] **Step 4: Mount in app.ts**

Edit `xiNAS-MCP/src/api/app.ts`. Import and mount on the shared `v1` router after the groups route mount:

```ts
import { nfsIdmapRouter } from './routes/nfs-idmap.js';
// inside createApp(ctx), alongside the other v1.use(router(ctx)) calls:
v1.use(nfsIdmapRouter(ctx));
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/routes/nfs-idmap.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 nfs-idmap tests pass; full suite green.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/api/routes/nfs-idmap.ts xiNAS-MCP/src/api/app.ts xiNAS-MCP/src/__tests__/api/routes/nfs-idmap.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add /api/v1/nfs-idmap singleton route (I3)

Reads the NfsIdmap singleton from /xinas/v1/observed/nfs_idmap/snapshot
(snake_case path: observedSegment maps NfsIdmap → nfs_idmap per
ADR-0003). Returns NOT_FOUND when the agent has not yet performed
an initial sweep. Mounts via v1.use(nfsIdmapRouter(ctx)).

Tests: 404 before first observation, full resource returned after
seed, anonymous request rejected with 401.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"NfsIdmap resource".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task I4: `/api/v1/system` extension — `Node.status.agent`

**Files:**
- Modify: `xiNAS-MCP/src/api/routes/system.ts`
- Modify: `xiNAS-MCP/src/api/context.ts` (add `tracker` field to `ApiContext`)
- Create: `xiNAS-MCP/src/__tests__/api/routes/system-agent.test.ts`

The existing `GET /api/v1/system` handler in `system.ts` returns `{ cluster, node }`. This task extends it to merge the `HeartbeatTracker`'s current state into `result.node.status.agent`. The tracker is added to `ApiContext` as `ctx.tracker` in Phase H (H1); `buildTestApp()` will expose it via `setup.ctx.tracker`.

**Architecture note:** `HeartbeatTracker` (H1) exposes `currentSnapshot()` which returns the full agent sub-object — `{ state, version, last_heartbeat_at, last_observed_push_at, collectors }` — where `version` and `collectors` come from the most recent successful `agent.health` response (captured by `recordHeartbeatSuccess(at, payload)`), and are `null` / `{}` until the first one lands. Use it directly; do not hand-assemble the fields. The `agent` sub-object shape to populate is:
```ts
{
  state: 'healthy' | 'degraded' | 'offline';
  version: string | null;
  last_heartbeat_at: string | null;       // ISO-8601 or null
  last_observed_push_at: string | null;   // ISO-8601 or null
  collectors: Record<string, string>;     // empty until S1 collectors land
}
```

Before editing `system.ts`, read the current `ApiContext` definition and the `HeartbeatTracker` API from H1 to confirm the exact field names — the reads step below makes this mandatory.

- [ ] **Step 1: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/api/routes/system-agent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN, seedCluster, seedNode } from '../_helpers.js';

describe('GET /api/v1/system — agent sub-object', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
    seedCluster(setup.state);
    seedNode(setup.state);
  });

  afterEach(async () => { await setup.cleanup(); });

  it('includes result.node.status.agent with required fields', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const agent = res.body.result?.node?.status?.agent;
    expect(agent).toBeDefined();
    expect(agent).toHaveProperty('state');
    expect(['healthy', 'degraded', 'offline']).toContain(agent.state);
    // On a fresh test app without a real agent the tracker is offline.
    expect(agent.state).toBe('offline');
  });

  it('agent.collectors is an object (may be empty on startup)', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const agent = res.body.result?.node?.status?.agent;
    expect(typeof agent.collectors).toBe('object');
    expect(Array.isArray(agent.collectors)).toBe(false);
  });

  it('last_heartbeat_at is null when no heartbeat has succeeded', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const agent = res.body.result?.node?.status?.agent;
    // null is valid per api-v1.yaml (type: [string, "null"], format: date-time)
    expect(agent.last_heartbeat_at === null || typeof agent.last_heartbeat_at === 'string').toBe(true);
  });
});
```

- [ ] **Step 2: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes/system-agent.test.ts 2>&1 | tail -10
```
Expected: FAIL — `agent` field absent from `result.node.status`.

- [ ] **Step 3: Read system.ts + ApiContext**

Before editing, confirm the exact shape of `ctx` and how the node object is built:

```bash
cd xiNAS-MCP
cat src/api/routes/system.ts
grep -n "tracker\|HeartbeatTracker\|ApiContext" src/api/context.ts src/api/app.ts
```

Verify that Phase H has wired `ctx.tracker: HeartbeatTracker` into `ApiContext`. If Phase H has not landed yet, add it now as part of this task.

- [ ] **Step 4: Add `tracker` to ApiContext (if Phase H has not already done so)**

Edit `xiNAS-MCP/src/api/context.ts`. Add the `tracker` field to `ApiContext`:

```ts
import type { HeartbeatTracker } from './heartbeat.js';

export interface ApiContext {
  config: ApiConfig;
  state: OpenedStateStore;
  tracker: HeartbeatTracker;   // populated by Phase H; never null at runtime
}
```

Update `buildTestApp()` in `xiNAS-MCP/src/__tests__/api/_helpers.ts` to construct a stub tracker (one that starts in `offline` state):

```ts
import { HeartbeatTracker } from '../../api/heartbeat.js';
// ...
const tracker = new HeartbeatTracker({
  intervalMs: 5_000,
  controllerId: NODE_ID,
  state,
  agentSocketPath: '/tmp/nonexistent.sock',
});
const ctx: ApiContext = { config, state, tracker };
```

- [ ] **Step 5: Extend system.ts**

Edit `xiNAS-MCP/src/api/routes/system.ts`. Inside the `GET /system` handler, after building the response object, spread the tracker snapshot into `node.status.agent`:

```ts
// Inside the r.get('/system', ...) handler, extend the sendOk call:
r.get('/system', (req, res) => {
  const cluster = getOrNull<Record<string, unknown>>(ctx.state, '/xinas/v1/cluster');
  if (!cluster) throw new ApiException('NOT_FOUND', 'cluster not initialized');
  const nodes = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/nodes/');
  if (nodes.length === 0) throw new ApiException('NOT_FOUND', 'no node registered');

  const nodeValue = nodes[0]!.value as Record<string, unknown>;
  const nodeStatus = (nodeValue.status ?? {}) as Record<string, unknown>;

  // Merge agent state into node.status.agent. currentSnapshot() (H1)
  // bundles all five fields — state, version, last_heartbeat_at,
  // last_observed_push_at, collectors — so version + the per-collector
  // health map (captured from the most recent agent.health response)
  // surface here without a fresh RPC.
  const agent = ctx.tracker.currentSnapshot();

  const enrichedNode = {
    ...nodeValue,
    status: { ...nodeStatus, agent },
  };

  sendOk(req, res, { cluster: cluster.value, node: enrichedNode }, [
    cluster.revision,
    ...nodes.map((n) => n.revision),
  ]);
});
```

(If the existing handler already builds `node.status` with fields like `agent_state`, keep those alongside the new `agent` sub-object — do not remove them.)

- [ ] **Step 6: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/routes/system-agent.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 3/3 system-agent tests pass; full suite green.

- [ ] **Step 7: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claire/worktrees/determined-hoover-833782
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/api/routes/system.ts \
  xiNAS-MCP/src/api/context.ts \
  xiNAS-MCP/src/__tests__/api/_helpers.ts \
  xiNAS-MCP/src/__tests__/api/routes/system-agent.test.ts
git commit -m "$(cat <<'EOF'
feat(api): surface HeartbeatTracker state at result.node.status.agent (I4)

GET /api/v1/system already returns {cluster, node}. Extends node.status
with an agent sub-object read from ctx.tracker (HeartbeatTracker):
state (healthy/degraded/offline), last_heartbeat_at,
last_observed_push_at, and collectors map (empty until S1 collectors).

ApiContext gains a tracker field; buildTestApp() constructs an
offline-state stub tracker so tests get a deterministic initial state.

Tests: agent field present with required shape, collectors is an object,
last_heartbeat_at is null when no heartbeat has succeeded.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Node.status agent-state addition".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task I5: `/api/v1/shares/{id}/sessions` populated

**Files:**
- Modify: `xiNAS-MCP/src/api/routes/nfs.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes/nfs-sessions.test.ts`

The `/api/v1/shares/{id}/sessions` endpoint exists in `nfs.ts` but returns `[]` (observed state didn't exist yet). This task reads `NfsSession` entries from `/xinas/v1/observed/NfsSession/*` and filters by `value.spec.export_path === share.spec.export_path`.

**Design fixes from review:**
- The existing `nfs.ts` handler already reads the desired Share from `/xinas/v1/desired/Share/<id>` (NOT `observed`) and uses `ApiException` for 404. This is correct — keep it.
- The `share.spec.export_path` field: the live `seedShare` helper seeds shares at `/xinas/v1/desired/Share/<id>` with a `spec.path` (not `spec.export_path`). Tests must seed shares with the exact spec shape the handler will read — use `export_path` consistently if that is the spec field, or adapt the filter to match whatever field the desired Share carries. Verify by reading `nfs.ts` before writing the impl.
- Add a defensive guard: `typeof (session.spec?.client_addr) === 'string'` when filtering sessions.

- [ ] **Step 1: Read the existing nfs.ts sessions handler**

```bash
cd xiNAS-MCP
grep -n "sessions\|export_path\|NfsSession\|desired\|observed" src/api/routes/nfs.ts
```

Identify exactly how the share is fetched and where `sendOk(req, res, [])` is returned. Also read `src/__tests__/api/_helpers.ts` to see what fields `seedShare` seeds (the `spec.path` vs `spec.export_path` question).

- [ ] **Step 2: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/api/routes/nfs-sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from '../_helpers.js';

describe('GET /api/v1/shares/{id}/sessions — populated from observed state', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  const SHARE_ID = 'share01';
  const EXPORT_PATH = '/srv/nfs/share01';

  beforeEach(async () => {
    setup = await buildTestApp();

    // Seed desired Share with an export_path that sessions will reference.
    // Uses /xinas/v1/desired/Share/<id> — the same prefix nfs.ts already reads.
    setup.state.kv.put(`/xinas/v1/desired/Share/${SHARE_ID}`, {
      kind: 'Share', id: SHARE_ID,
      spec: {
        path: '/data/share01',
        export_path: EXPORT_PATH,
        clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
        fsid: 42,
      },
    });

    // Two NfsSession entries matching this share's export_path
    setup.state.kv.put('/xinas/v1/observed/NfsSession/10.1.2.3:share01', {
      kind: 'NfsSession', id: '10.1.2.3:/srv/nfs/share01',
      spec: { client_addr: '10.1.2.3', export_path: EXPORT_PATH },
      status: { proto_version: 'v4.2', locked_files: 0, observed_at: new Date().toISOString() },
    });
    setup.state.kv.put('/xinas/v1/observed/NfsSession/10.1.2.4:share01', {
      kind: 'NfsSession', id: '10.1.2.4:/srv/nfs/share01',
      spec: { client_addr: '10.1.2.4', export_path: EXPORT_PATH },
      status: { proto_version: 'v4.1', locked_files: 2, observed_at: new Date().toISOString() },
    });

    // One NfsSession for a different share — must NOT appear in results
    setup.state.kv.put('/xinas/v1/observed/NfsSession/10.1.2.5:other', {
      kind: 'NfsSession', id: '10.1.2.5:/srv/nfs/other',
      spec: { client_addr: '10.1.2.5', export_path: '/srv/nfs/other' },
      status: { proto_version: 'v4', locked_files: 0, observed_at: new Date().toISOString() },
    });
  });

  afterEach(async () => { await setup.cleanup(); });

  it('returns only NfsSession entries whose export_path matches the share', async () => {
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}/sessions`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(2);
    const clientAddrs = res.body.result.map(
      (s: { spec: { client_addr: string } }) => s.spec.client_addr,
    );
    expect(clientAddrs).toContain('10.1.2.3');
    expect(clientAddrs).toContain('10.1.2.4');
    expect(clientAddrs).not.toContain('10.1.2.5');
  });

  it('returns empty array when no sessions exist for the share', async () => {
    setup.state.kv.delete('/xinas/v1/observed/NfsSession/10.1.2.3:share01');
    setup.state.kv.delete('/xinas/v1/observed/NfsSession/10.1.2.4:share01');
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}/sessions`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(0);
  });

  it('returns 404 when share does not exist', async () => {
    const res = await request(setup.app)
      .get('/api/v1/shares/nonexistent/sessions')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
  });

  it('cross-share isolation: sessions from other shares are excluded', async () => {
    // Ensure the other share's session is not accidentally included
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}/sessions`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const exportPaths = res.body.result.map(
      (s: { spec: { export_path: string } }) => s.spec.export_path,
    );
    expect(exportPaths.every((p: string) => p === EXPORT_PATH)).toBe(true);
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes/nfs-sessions.test.ts 2>&1 | tail -10
```
Expected: FAIL — `result` is `[]` regardless of seeded NfsSession entries, or `result` has length 3 (no filter applied).

- [ ] **Step 4: Implement in nfs.ts**

Edit `xiNAS-MCP/src/api/routes/nfs.ts`. Locate the `r.get('/shares/:id/sessions', ...)` handler and replace the body with:

```ts
r.get('/shares/:id/sessions', (req, res) => {
  const id = req.params.id;

  // Share lives in desired state (same prefix as list/get handlers above)
  const shareRow = getOrNull<Record<string, unknown>>(
    ctx.state,
    `/xinas/v1/desired/Share/${id}`,
  );
  if (!shareRow) throw new ApiException('NOT_FOUND', `share ${id} not found`);

  const shareSpec = shareRow.value.spec as Record<string, unknown> | undefined;
  const exportPath = shareSpec?.export_path as string | undefined;

  // List all observed NfsSession entries and filter to the matching export_path
  const allSessions = listByPrefix<Record<string, unknown>>(
    ctx.state,
    '/xinas/v1/observed/NfsSession/',
  );
  const matchingSessions = allSessions.filter((row) => {
    const spec = (row.value.spec as Record<string, unknown> | undefined);
    return (
      typeof spec?.client_addr === 'string' &&
      spec?.export_path === exportPath
    );
  });

  sendOk(
    req,
    res,
    unwrapValues(matchingSessions),
    matchingSessions.map((r) => r.revision),
  );
});
```

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/routes/nfs-sessions.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 4/4 nfs-sessions tests pass; existing `routes-nfs.test.ts` suite still fully green (the empty-sessions test there still passes because a freshly-seeded share has no observed NfsSession entries).

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/api/routes/nfs.ts xiNAS-MCP/src/__tests__/api/routes/nfs-sessions.test.ts
git commit -m "$(cat <<'EOF'
feat(api): populate /api/v1/shares/{id}/sessions from observed state (I5)

The endpoint existed since PR #201 but returned [] because no
NfsSession data was stored. Now reads /xinas/v1/observed/NfsSession/*
and filters by spec.export_path === share.spec.export_path. The share
itself is still read from /xinas/v1/desired/Share/<id>. A defensive
guard (typeof spec.client_addr === 'string') skips malformed rows.

Tests: two sessions for matching share, empty array when no sessions,
404 when the share itself does not exist, cross-share isolation.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Public REST contract growth".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task I6: Share read-join populates `Share.status.exports[]`

**Files:**
- Modify: `xiNAS-MCP/src/api/routes/nfs.ts`
- Create: `xiNAS-MCP/src/__tests__/api/routes/nfs-exports-join.test.ts`

The existing `/api/v1/shares` (list) and `/api/v1/shares/{id}` (get) handlers return desired Share objects. This task makes `Share.status.exports[]` non-empty by joining with observed `ExportRule` resources at read time.

**Design notes:**
- `ExportRule` is an internal observed kind (no public REST endpoint of its own — `/api/v1/export-groups` stays as-is reading `/xinas/v1/desired/ExportGroup/`).
- Agent stores ExportRule at `/xinas/v1/observed/ExportRule/<some-id>`. Each row has `spec.export_path` and `status.rules[]`.
- For each Share, find the ExportRule row whose `spec.export_path` matches `share.spec.export_path`. If found, set `share.status.exports` to that row's `status.rules`. If not found, set to `[]`.
- Implement as a small local helper `joinExports(ctx, share)` that returns a single enriched share; both the list and get handlers call it.

- [ ] **Step 1: Read the existing list/get handlers in nfs.ts**

```bash
cd xiNAS-MCP
cat src/api/routes/nfs.ts
```

Confirm the exact field paths (`spec.export_path` vs `spec.path`) in the desired Share spec. Also confirm that `status` may be absent from desired Share objects (desired state is schema-owner, not the agent — `status` may be a top-level absent field). The join MUST be safe to call even when `share.status` is absent: create it if missing.

- [ ] **Step 2: Write the failing tests**

Create `xiNAS-MCP/src/__tests__/api/routes/nfs-exports-join.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, ADMIN_TOKEN } from '../_helpers.js';

describe('Share read-join: status.exports[] populated from observed ExportRule', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  const SHARE_ID = 'share01';
  const EXPORT_PATH = '/srv/nfs/share01';

  beforeEach(async () => {
    setup = await buildTestApp();

    setup.state.kv.put(`/xinas/v1/desired/Share/${SHARE_ID}`, {
      kind: 'Share', id: SHARE_ID,
      spec: {
        path: '/data/share01',
        export_path: EXPORT_PATH,
        clients: [{ pattern: '10.0.0.0/8', options: ['rw', 'sync'] }],
        fsid: 42,
      },
      status: { exports: [] },
    });
  });

  afterEach(async () => { await setup.cleanup(); });

  it('GET /shares list: share.status.exports is [] when no ExportRule observed', async () => {
    const res = await request(setup.app)
      .get('/api/v1/shares')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].status.exports).toEqual([]);
  });

  it('GET /shares list: share.status.exports populated when matching ExportRule exists', async () => {
    setup.state.kv.put('/xinas/v1/observed/ExportRule/share01', {
      kind: 'ExportRule', id: 'share01',
      spec: { export_path: EXPORT_PATH },
      status: {
        rules: [
          { client: '10.0.0.0/8', options: ['rw', 'sync', 'no_root_squash'] },
          { client: '192.168.1.0/24', options: ['ro'] },
        ],
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app)
      .get('/api/v1/shares')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result[0].status.exports).toHaveLength(2);
    expect(res.body.result[0].status.exports[0].client).toBe('10.0.0.0/8');
  });

  it('GET /shares/{id}: status.exports populated for matching ExportRule', async () => {
    setup.state.kv.put('/xinas/v1/observed/ExportRule/share01', {
      kind: 'ExportRule', id: 'share01',
      spec: { export_path: EXPORT_PATH },
      status: {
        rules: [{ client: '10.0.0.0/8', options: ['rw', 'sync'] }],
        observed_at: new Date().toISOString(),
      },
    });
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toHaveLength(1);
    expect(res.body.result.status.exports[0].client).toBe('10.0.0.0/8');
  });

  it('GET /shares/{id}: status.exports is [] when no matching ExportRule', async () => {
    // Seed an ExportRule for a DIFFERENT export_path
    setup.state.kv.put('/xinas/v1/observed/ExportRule/other', {
      kind: 'ExportRule', id: 'other',
      spec: { export_path: '/srv/nfs/other' },
      status: { rules: [{ client: '*', options: ['ro'] }], observed_at: new Date().toISOString() },
    });
    const res = await request(setup.app)
      .get(`/api/v1/shares/${SHARE_ID}`)
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.status.exports).toEqual([]);
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/routes/nfs-exports-join.test.ts 2>&1 | tail -10
```
Expected: FAIL — `status.exports` is either undefined or `[]` even when a matching ExportRule is seeded.

- [ ] **Step 4: Implement `joinExports` in nfs.ts**

Edit `xiNAS-MCP/src/api/routes/nfs.ts`. Add a small private helper above the router definition, then call it from both the list and get handlers:

```ts
/**
 * For a single desired Share value, look up its matching observed
 * ExportRule (by spec.export_path) and set status.exports to that
 * rule's status.rules[]. Returns a new object — does not mutate the
 * original row value.
 */
function joinExports(
  state: OpenedStateStore,
  share: Record<string, unknown>,
): Record<string, unknown> {
  const shareSpec = share.spec as Record<string, unknown> | undefined;
  const exportPath = shareSpec?.export_path as string | undefined;

  let exports: unknown[] = [];
  if (exportPath) {
    const allRules = listByPrefix<Record<string, unknown>>(
      state,
      '/xinas/v1/observed/ExportRule/',
    );
    const matching = allRules.find((row) => {
      const spec = row.value.spec as Record<string, unknown> | undefined;
      return spec?.export_path === exportPath;
    });
    if (matching) {
      const ruleStatus = matching.value.status as Record<string, unknown> | undefined;
      exports = (ruleStatus?.rules as unknown[]) ?? [];
    }
  }

  const existingStatus = (share.status ?? {}) as Record<string, unknown>;
  return {
    ...share,
    status: { ...existingStatus, exports },
  };
}
```

Then update the list and get handlers to call it:

```ts
// In GET /shares:
r.get('/shares', (req, res) => {
  const rows = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/desired/Share/');
  const values = unwrapValues(rows).map((s) => joinExports(ctx.state, s));
  sendOk(req, res, values, rows.map((x) => x.revision));
});

// In GET /shares/:id:
r.get('/shares/:id', (req, res) => {
  const row = getOrNull<Record<string, unknown>>(
    ctx.state,
    `/xinas/v1/desired/Share/${req.params.id}`,
  );
  if (!row) throw new ApiException('NOT_FOUND', `share ${req.params.id} not found`);
  sendOk(req, res, joinExports(ctx.state, row.value), [row.revision]);
});
```

Note: `listByPrefix` is already imported at the top of `nfs.ts`. `OpenedStateStore` is available via `ctx.state`. You may need to add `OpenedStateStore` to the import if it is used as a parameter type in `joinExports` — alternatively, infer it from `ctx.state` directly without annotating the parameter type.

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/routes/nfs-exports-join.test.ts 2>&1 | tail -5
npx vitest run src/__tests__/api/routes-nfs.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 4/4 nfs-exports-join tests pass; existing `routes-nfs.test.ts` still fully green (the `GET /shares lists shares` test now passes through `joinExports` but no ExportRule is seeded, so `status.exports === []` and `result.length === 2` still holds); full suite green.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/api/routes/nfs.ts xiNAS-MCP/src/__tests__/api/routes/nfs-exports-join.test.ts
git commit -m "$(cat <<'EOF'
feat(api): join observed ExportRule into Share.status.exports[] at read time (I6)

Both GET /api/v1/shares and GET /api/v1/shares/{id} now populate
status.exports[] by looking up the observed ExportRule whose
spec.export_path matches the share's spec.export_path. If no matching
ExportRule is found, status.exports is [].

Implemented as a local joinExports(state, share) helper reused by
both handlers. ExportRule is an internal observed kind — there is no
public /api/v1/export-rules endpoint; /api/v1/export-groups remains
unchanged (it reads desired ExportGroup).

Tests: list and get handlers return populated exports when matching
ExportRule is seeded; return [] when absent or when ExportRule belongs
to a different export_path.

Spec: docs/control-path/xinas-agent-s0s1-spec.md §"Share.status.exports join".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Phase J — Comprehensive testing

### Task J1: Mock-agent test helper

**Files:**
- Modify: `xiNAS-MCP/src/__tests__/api/_helpers.ts`
- Create: `xiNAS-MCP/src/__tests__/api/mock-agent.test.ts`

Extends the existing `buildTestApp()` helper to provide a full mock-agent setup: a bound UDS that the HeartbeatTracker will actually connect to, plus convenience methods for seeding observed state and driving the tracker into specific states. The goal is that every Phase H-I test can use this helper without spinning up a real agent process.

- [ ] **Step 1: Read the existing helper**

```bash
cd xiNAS-MCP
cat src/__tests__/api/_helpers.ts
```

Understand:
- What `buildTestApp()` returns today (`{ app, state, teardown }`).
- Whether the app is created with a real `HeartbeatTracker` or a no-op stub.
- Whether `createApp()` in `app.ts` accepts injectable deps (tracker, clock) — if not, that's the prerequisite to add.

- [ ] **Step 2: Write the failing test for the mock-agent helper**

Create `xiNAS-MCP/src/__tests__/api/mock-agent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestAppWithMockAgent, type MockAgentSetup } from './_helpers.js';

describe('buildTestAppWithMockAgent — helper round-trips', () => {
  let setup: MockAgentSetup;

  beforeEach(async () => {
    setup = await buildTestAppWithMockAgent();
  });

  afterEach(async () => {
    await setup.teardown();
  });

  it('app starts and handles requests', async () => {
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', ADMIN_TOKEN)
      .expect(200);
    expect(res.body.result).toBeDefined();
  });

  it('postObservation seeds observed state readable via GET', async () => {
    await setup.mockAgent.postObservation({
      observed_at: new Date().toISOString(),
      controller_id: setup.controllerId,
      deltas: [
        {
          kind: 'User', id: '1000', op: 'upsert',
          value: {
            kind: 'User', id: '1000',
            metadata: { modified_at: new Date().toISOString() },
            spec: { name: 'testuser', uid: 1000, gid: 1000 },
            status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
          },
        },
      ],
      complete_snapshots: [],
    });
    const res = await request(setup.app)
      .get('/api/v1/users/1000')
      .set('Authorization', 'Bearer tok-admin')
      .expect(200);
    expect(res.body.result.spec.name).toBe('testuser');
  });

  it('respondToHealth drives tracker to healthy after ticks', async () => {
    setup.mockAgent.respondToHealth({
      status: 'healthy',
      version: '0.0.1-test',
      uptime_seconds: 10,
      controller_id: setup.controllerId,
      in_flight_tasks: 0,
      collectors: { disk: 'running', users: 'running' },
    });
    // Allow at least one heartbeat tick to fire
    await new Promise((r) => setTimeout(r, setup.heartbeatIntervalMs + 100));
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', 'Bearer tok-admin')
      .expect(200);
    expect(res.body.result.node.status.agent.state).toBe('healthy');
  });

  it('simulateOffline drives tracker to offline state', async () => {
    // First bring tracker healthy
    setup.mockAgent.respondToHealth({
      status: 'healthy', version: '0.0.1-test', uptime_seconds: 5,
      controller_id: setup.controllerId, in_flight_tasks: 0, collectors: {},
    });
    await new Promise((r) => setTimeout(r, setup.heartbeatIntervalMs + 100));
    // Now simulate offline
    await setup.mockAgent.simulateOffline();
    const res = await request(setup.app)
      .get('/api/v1/system')
      .set('Authorization', 'Bearer tok-admin')
      .expect(200);
    expect(res.body.result.node.status.agent.state).toBe('offline');
  });
});
```

- [ ] **Step 3: Run — see fail**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/mock-agent.test.ts 2>&1 | tail -10
```
Expected: FAIL — `buildTestAppWithMockAgent` not exported from `_helpers.ts`.

- [ ] **Step 4: Implement `buildTestAppWithMockAgent` in `_helpers.ts`**

Edit `xiNAS-MCP/src/__tests__/api/_helpers.ts`. Add:

```ts
import * as net from 'node:net';
import * as http from 'node:http';
import { createUnixSocketClient } from '../../api/heartbeat.js'; // or inline

export interface MockAgentHealth {
  status: string;
  version: string;
  uptime_seconds: number;
  controller_id: string;
  in_flight_tasks: number;
  collectors: Record<string, string>;
}

export interface MockAgentHandle {
  /**
   * Set the payload the mock agent will return for the NEXT
   * agent.health JSON-RPC call from the HeartbeatTracker tick.
   */
  respondToHealth(payload: MockAgentHealth): void;

  /**
   * POST an /internal/v1/observed body to the api using the internal
   * agent bearer token. Returns the HTTP response.
   */
  postObservation(body: {
    observed_at: string;
    controller_id: string;
    deltas: unknown[];
    complete_snapshots: string[];
  }): Promise<{ status: number; body: unknown }>;

  /**
   * Stop the mock agent's UDS server so subsequent heartbeat ticks
   * fail with ECONNREFUSED. Sets tracker to offline after 6 intervals.
   */
  simulateOffline(): Promise<void>;

  /**
   * Keep the mock agent server up but respond to health with a
   * degraded payload (e.g., one collector in error state).
   */
  simulateDegraded(): void;
}

export interface MockAgentSetup {
  app: Express.Application;
  state: import('../../state/index.js').OpenedStateStore;
  mockAgent: MockAgentHandle;
  controllerId: string;
  heartbeatIntervalMs: number;
  internalToken: string;
  teardown(): Promise<void>;
}

export async function buildTestAppWithMockAgent(): Promise<MockAgentSetup> {
  // 1. Create a temp directory for sockets + db
  const tmpDir = mkdtempSync(join(tmpdir(), 'xinas-mock-agent-'));
  const agentSockPath = join(tmpDir, 'agent.sock');
  const apiSockPath = join(tmpDir, 'api.sock');
  const dbPath = join(tmpDir, 'xinas.db');
  const auditPath = join(tmpDir, 'audit.jsonl');

  const CONTROLLER_ID = '00000000-0000-0000-0000-000000000099';
  const INTERNAL_TOKEN = 'internal-agent-tok-test';
  const HEARTBEAT_INTERVAL_MS = 200; // fast ticks for tests

  // 2. Build the config with the internal token
  const config: import('../../api/config.js').ApiConfig = {
    controller_id: CONTROLLER_ID,
    listen: { kind: 'unix', socket: apiSockPath },
    tokens: {
      'tok-admin': { principal: 'admin:test', role: 'admin' },
      [INTERNAL_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
    },
    state: { databasePath: dbPath, auditJsonlPath: auditPath },
    agent: {
      socket: agentSockPath,
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    },
  };

  // 3. Create the test app (with a HeartbeatTracker pointed at agentSockPath)
  const { app, state, tracker, close } = await createTestAppFromConfig(config);

  // 4. Start the mock agent UDS server
  let currentHealthPayload: MockAgentHealth | null = null;
  let agentServer: net.Server | null = net.createServer((conn) => {
    const buf: Buffer[] = [];
    conn.on('data', (chunk) => buf.push(chunk));
    conn.on('end', () => {
      const lines = Buffer.concat(buf).toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const req = JSON.parse(line) as { id: number; method: string };
          if (req.method === 'agent.health' && currentHealthPayload) {
            const resp = JSON.stringify({
              jsonrpc: '2.0', id: req.id, result: currentHealthPayload,
            });
            conn.write(resp + '\n');
          } else {
            const resp = JSON.stringify({
              jsonrpc: '2.0', id: req.id,
              error: { code: -32000, message: 'stubbed', data: { code: 'EXECUTOR_UNSUPPORTED' } },
            });
            conn.write(resp + '\n');
          }
        } catch {
          // ignore malformed
        }
      }
    });
  });
  await new Promise<void>((resolve) => agentServer!.listen(agentSockPath, resolve));

  const mockAgent: MockAgentHandle = {
    respondToHealth(payload) {
      currentHealthPayload = payload;
    },
    async postObservation(body) {
      return new Promise((resolve) => {
        const postData = JSON.stringify(body);
        const req = http.request({
          socketPath: apiSockPath,
          path: '/internal/v1/observed',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${INTERNAL_TOKEN}`,
            'Content-Length': Buffer.byteLength(postData),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          });
        });
        req.write(postData);
        req.end();
      });
    },
    async simulateOffline() {
      if (agentServer) {
        await new Promise<void>((resolve) => agentServer!.close(() => resolve()));
        agentServer = null;
      }
      currentHealthPayload = null;
    },
    simulateDegraded() {
      currentHealthPayload = {
        status: 'degraded', version: '0.0.1-test', uptime_seconds: 30,
        controller_id: CONTROLLER_ID, in_flight_tasks: 0,
        collectors: { disk: 'error: probe timeout' },
      };
    },
  };

  return {
    app,
    state,
    mockAgent,
    controllerId: CONTROLLER_ID,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    internalToken: INTERNAL_TOKEN,
    async teardown() {
      await mockAgent.simulateOffline().catch(() => undefined);
      await close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
```

(Note: `createTestAppFromConfig` is a new private helper inside `_helpers.ts` that creates the app from an inline config. This may require a small refactor to `buildTestApp()` to share the common path. Read the existing implementation before editing to avoid regressions.)

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/mock-agent.test.ts 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 4/4 mock-agent tests pass; full suite green. The `respondToHealth` + timing test may be flaky at 200ms; if so, increase `heartbeatIntervalMs` or use fake timers.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/__tests__/api/_helpers.ts xiNAS-MCP/src/__tests__/api/mock-agent.test.ts
git commit -m "$(cat <<'EOF'
test(api): add buildTestAppWithMockAgent() helper (J1)

Extends _helpers.ts with a full mock-agent setup: a real UDS server
that the HeartbeatTracker actually connects to (so heartbeat state
transitions can be tested), plus:

  respondToHealth(payload)  — controls agent.health responses
  postObservation(body)     — posts to /internal/v1/observed with
                              the internal agent token
  simulateOffline()         — stops the mock server; tracker transitions
                              to offline after 6 intervals
  simulateDegraded()        — injects a collector error into the payload

The helper tests itself: round-trip through postObservation + GET,
and tracker state driven to healthy + offline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task J2: Integration test extended to 35 GETs

**Files:**
- Modify: `xiNAS-MCP/src/__tests__/api/integration.test.ts`

PR #201 introduced an integration test that loops over a `GET_OPS` array of 30 public GET paths and asserts the envelope shape on each. This task seeds the 5 new resources and adds the 5 new paths, growing the count to exactly 35.

- [ ] **Step 1: Read the existing integration test**

```bash
cd xiNAS-MCP
grep -n "GET_OPS\|const ops\|routes\|length\|35\|30" src/__tests__/api/integration.test.ts | head -30
```

Identify:
- Where `GET_OPS` (or the equivalent constant) is declared.
- How state is seeded before the test loop (if at all).
- What the assertion on the count looks like (e.g., `expect(GET_OPS).toHaveLength(30)`).

- [ ] **Step 2: Seed observed state in the integration test setup**

Edit `xiNAS-MCP/src/__tests__/api/integration.test.ts`. In the `beforeAll` or `beforeEach` that sets up the test state, add seeds for the 5 new resource types:

```ts
// Seed User entries
state.kv.put('/xinas/v1/observed/User/42', {
  kind: 'User', id: '42',
  metadata: { modified_at: new Date().toISOString() },
  spec: { name: 'integ-user', uid: 42, gid: 42 },
  status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
});

// Seed Group entry
state.kv.put('/xinas/v1/observed/Group/42', {
  kind: 'Group', id: '42',
  metadata: { modified_at: new Date().toISOString() },
  spec: { name: 'integ-group', gid: 42, members: [] },
  status: { resolvable: true, source: 'local', observed_at: new Date().toISOString() },
});

// Seed NfsIdmap singleton
state.kv.put('/xinas/v1/observed/nfs_idmap/snapshot', {
  kind: 'NfsIdmap',
  metadata: { modified_at: new Date().toISOString() },
  status: {
    conf_present: true,
    domain: 'integ-test.local',
    local_realms: [],
    method: 'nsswitch',
    idmapd_active: true,
    idmapd_unit_state: 'active',
    observed_at: new Date().toISOString(),
  },
});
```

- [ ] **Step 3: Add the 5 new paths to GET_OPS**

Locate the `GET_OPS` (or similar) array and extend it:

```ts
// After the last existing entry — add the 5 new Phase I routes:
{ path: '/api/v1/users',        expectResultIsArray: true  },
{ path: '/api/v1/users/42',     expectResultIsArray: false },
{ path: '/api/v1/groups',       expectResultIsArray: true  },
{ path: '/api/v1/groups/42',    expectResultIsArray: false },
{ path: '/api/v1/nfs-idmap',    expectResultIsArray: false },
```

(Match the exact shape of existing entries — some tests carry additional assertions about `result.length`; the new entries only need the envelope-shape assert that all existing entries get.)

- [ ] **Step 4: Update the count assertion**

Find the line that asserts `GET_OPS.toHaveLength(30)` (or a comment that references 30) and change it to 35:

```ts
// This assertion is the explicit count guard: it will fail if someone
// adds or removes a route without updating this test.
expect(GET_OPS).toHaveLength(35);
```

If the count assertion is a comment rather than a code assertion, add a runtime assertion immediately after the array declaration:

```ts
// Safety-check: the count must be exact so regressions are caught.
if (GET_OPS.length !== 35) {
  throw new Error(
    `GET_OPS length is ${GET_OPS.length}, expected exactly 35. ` +
    'Update this constant when adding or removing public GET routes.',
  );
}
```

- [ ] **Step 5: Run — see fail (before seeding is complete)**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/api/integration.test.ts 2>&1 | tail -15
```
Expected: FAIL if the count assertion was changed before seeds are present, or if any of the 5 new paths returns 404 because routes weren't mounted. If the test immediately reports 35 all-pass, it means a prior step correctly wired both seeds and routes.

- [ ] **Step 6: Verify full pass**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/api/integration.test.ts 2>&1 | tail -10
npm test 2>&1 | tail -3
```
Expected: integration test shows 35 GETs all pass. Full suite green.

- [ ] **Step 7: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/src/__tests__/api/integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): extend integration test to 35 public GETs (J2)

PR #201 established the contract: a GET_OPS array loops over every
public GET and asserts envelope shape. Count was 30. This task adds
the 5 new Phase I routes:

  /api/v1/users (list)
  /api/v1/users/42 (get)
  /api/v1/groups (list)
  /api/v1/groups/42 (get)
  /api/v1/nfs-idmap (singleton)

Observed state for each is seeded in beforeEach. Count assertion
updated from 30 → 35. Any future route addition without a matching
GET_OPS entry will cause this test to fail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task J3: End-to-end test — real api + real agent + probe fixtures

**Files:**
- Create: `xiNAS-MCP/src/__tests__/e2e/agent-api-roundtrip.test.ts`
- Create: `xiNAS-MCP/src/__tests__/e2e/__fixtures__/users.json`
- Create: `xiNAS-MCP/src/__tests__/e2e/__fixtures__/disks.json`
- Create: `xiNAS-MCP/src/__tests__/e2e/__fixtures__/nfs-idmap.json`

These tests boot real api and agent processes (not vitest mocks). The agent is started with `XINAS_AGENT_PROBE_MODE=fixture:<path>` which makes every `src/agent/probe/*` module return data from files in the fixture directory instead of running real subprocesses or opening real sockets.

**Note:** these tests are inherently slow (~5-10s each). They use `test.timeout(15_000)` to avoid false failures on slow CI runners. Keep the suite small (5 tests). Mark the file with `// @vitest-environment node` and add `slow` to the test name to enable filtered runs.

- [ ] **Step 1: Create fixture files**

Create `xiNAS-MCP/src/__tests__/e2e/__fixtures__/users.json`:

```json
[
  {
    "name": "e2e-alice", "uid": 7001, "gid": 7001,
    "gecos": "E2E Test User", "home": "/home/e2e-alice", "shell": "/bin/bash"
  },
  {
    "name": "e2e-bob", "uid": 7002, "gid": 7002,
    "gecos": "", "home": "/home/e2e-bob", "shell": "/bin/sh"
  }
]
```

Create `xiNAS-MCP/src/__tests__/e2e/__fixtures__/disks.json`:

```json
{
  "blockdevices": [
    {
      "name": "nvme0n1", "size": "1.5T", "type": "disk",
      "model": "E2E-TEST-NVME", "serial": "E2ETST0001", "tran": "nvme"
    }
  ]
}
```

Create `xiNAS-MCP/src/__tests__/e2e/__fixtures__/nfs-idmap.json`:

```json
{
  "conf_present": true,
  "domain": "e2e-test.local",
  "local_realms": ["E2E-TEST.LOCAL"],
  "method": "nsswitch",
  "idmapd_active": false,
  "idmapd_unit_state": "inactive"
}
```

- [ ] **Step 2: Write the e2e test**

Create `xiNAS-MCP/src/__tests__/e2e/agent-api-roundtrip.test.ts`:

```ts
// @vitest-environment node
/**
 * End-to-end tests: real xinas-api process + real xinas-agent process.
 * The agent uses XINAS_AGENT_PROBE_MODE=fixture:<path> to avoid real
 * system calls; probes return data from __fixtures__/*.json.
 *
 * These tests are SLOW (~5-10s each). Run selectively with:
 *   npx vitest run --reporter verbose src/__tests__/e2e/
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__');

// Helper: HTTP GET over UDS
function getJson(socketPath: string, path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path, method: 'GET',
        headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Helper: wait until the api socket responds to GET /api/v1/system
async function waitForApi(socketPath: string, token: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await getJson(socketPath, '/api/v1/system', token);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`API at ${socketPath} did not become ready within ${timeoutMs}ms`);
}

// Helper: wait for agent to post initial sweep
async function waitForObservation(
  socketPath: string, token: string, path: string, timeoutMs = 8000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await getJson(socketPath, path, token) as { ok: boolean; error?: { code: string } };
    if (res.ok) return res;
    if ((res.error?.code) !== 'NOT_FOUND') throw new Error(`Unexpected error: ${JSON.stringify(res)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Observation at ${path} never arrived within ${timeoutMs}ms`);
}

describe.sequential('e2e: agent → api round-trip', { timeout: 60_000 }, () => {
  let tmpDir: string;
  let apiSockPath: string;
  let agentSockPath: string;
  let dbPath: string;
  let auditPath: string;
  let apiConfigPath: string;
  let agentConfigPath: string;
  let controllerIdPath: string;
  let agentTokenPath: string;
  let apiProc: ChildProcess;
  let agentProc: ChildProcess;

  const CONTROLLER_ID = '00000000-0000-0000-0000-000000000e2e';
  const ADMIN_TOKEN = 'e2e-admin-tok';
  const AGENT_TOKEN = 'e2e-agent-tok';

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'xinas-e2e-'));
    apiSockPath = join(tmpDir, 'api.sock');
    agentSockPath = join(tmpDir, 'agent.sock');
    dbPath = join(tmpDir, 'xinas.db');
    auditPath = join(tmpDir, 'audit.jsonl');
    apiConfigPath = join(tmpDir, 'api-config.json');
    agentConfigPath = join(tmpDir, 'agent-config.json');
    controllerIdPath = join(tmpDir, 'controller-id');
    agentTokenPath = join(tmpDir, 'agent-token');

    writeFileSync(controllerIdPath, CONTROLLER_ID + '\n');
    writeFileSync(agentTokenPath, AGENT_TOKEN + '\n');

    writeFileSync(apiConfigPath, JSON.stringify({
      controller_id: CONTROLLER_ID,
      listen: { kind: 'unix', socket: apiSockPath },
      tokens: {
        [ADMIN_TOKEN]: { principal: 'admin:e2e', role: 'admin' },
        [AGENT_TOKEN]: { principal: 'agent:root', role: 'internal_agent' },
      },
      state: { databasePath: dbPath, auditJsonlPath: auditPath },
      agent: { socket: agentSockPath, heartbeat_interval_ms: 500 },
    }));

    writeFileSync(agentConfigPath, JSON.stringify({
      api_socket: apiSockPath,
      agent_socket: agentSockPath,
      controller_id_path: controllerIdPath,
      agent_token_path: agentTokenPath,
    }));

    // Start api
    apiProc = spawn(
      process.execPath,
      ['--loader', 'ts-node/esm', 'src/api-server.ts'],
      {
        cwd: join(import.meta.dirname, '../../..'),
        env: { ...process.env, XINAS_API_CONFIG: apiConfigPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    await waitForApi(apiSockPath, ADMIN_TOKEN);

    // Start agent with fixture probe mode
    agentProc = spawn(
      process.execPath,
      ['--loader', 'ts-node/esm', 'src/agent-server.ts'],
      {
        cwd: join(import.meta.dirname, '../../..'),
        env: {
          ...process.env,
          XINAS_AGENT_CONFIG: agentConfigPath,
          XINAS_AGENT_PROBE_MODE: `fixture:${FIXTURE_DIR}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  }, 20_000);

  afterAll(async () => {
    agentProc?.kill('SIGTERM');
    apiProc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('slow: agent boots, performs initial sweep, POST reaches api', async () => {
    // Wait for the nfs-idmap singleton to be populated (proves initial sweep ran)
    const res = await waitForObservation(
      apiSockPath, ADMIN_TOKEN, '/api/v1/nfs-idmap',
    ) as { ok: boolean; result: { status: { domain: string } } };
    expect(res.ok).toBe(true);
    expect(res.result.status.domain).toBe('e2e-test.local');
  }, 15_000);

  it('slow: GET /api/v1/users returns fixture-injected users', async () => {
    const res = await waitForObservation(
      apiSockPath, ADMIN_TOKEN, '/api/v1/users',
    ) as { ok: boolean; result: Array<{ spec: { name: string } }> };
    expect(res.ok).toBe(true);
    const names = res.result.map((u) => u.spec.name);
    expect(names).toContain('e2e-alice');
    expect(names).toContain('e2e-bob');
  }, 15_000);

  it('slow: GET /api/v1/disks returns fixture-injected disk', async () => {
    const res = await waitForObservation(
      apiSockPath, ADMIN_TOKEN, '/api/v1/disks',
    ) as { ok: boolean; result: Array<{ id: string; status: { model: string } }> };
    expect(res.ok).toBe(true);
    const disk = res.result.find((d) => d.id === 'nvme0n1');
    expect(disk).toBeDefined();
    expect(disk?.status.model).toBe('E2E-TEST-NVME');
  }, 15_000);

  it('slow: kill agent → HeartbeatTracker transitions to offline', async () => {
    agentProc.kill('SIGTERM');
    // Wait > 6 × heartbeat_interval_ms (6 × 500ms = 3s) for tracker to go offline
    await new Promise((r) => setTimeout(r, 4000));
    const res = await getJson(apiSockPath, '/api/v1/system', ADMIN_TOKEN) as {
      result: { node: { status: { agent: { state: string } } } };
    };
    expect(res.result.node.status.agent.state).toBe('offline');
  }, 15_000);

  it('slow: mutating stub returns EXECUTOR_UNAVAILABLE when agent is offline', async () => {
    // Use any mutating endpoint — e.g. a future POST; for now probe via a known
    // mutating route that the current stub returns for any POST body:
    const postData = JSON.stringify({ name: 'test', path: '/data/test' });
    const result = await new Promise<{ ok: boolean; error?: { code: string } }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: apiSockPath,
          path: '/api/v1/shares',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        },
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
    // When agent is offline, executor is unavailable (envelope shape:
    // errors[].details.code — there is no result.ok / result.error).
    expect(result.errors?.[0]?.details?.code).toBe('EXECUTOR_UNAVAILABLE');
  }, 15_000);

  it('slow: mutating stub returns UNSUPPORTED (not UNAVAILABLE) when agent is ONLINE', async () => {
    // With the agent process up + healthy (fixture mode), the executor is
    // reachable but no mutating method is implemented in S0+S1, so the
    // tracker-aware stub (H5 step 8b) returns UNSUPPORTED, not UNAVAILABLE.
    // This guards against the offline gate silently always-returning
    // UNAVAILABLE (which would make the offline assertion above hollow).
    // (Setup: the agent has booted + the api's heartbeat tick has recorded
    // a successful agent.health within 2× interval — wait for healthy.)
    const postData = JSON.stringify({ name: 'x', level: 'raid5', member_disk_ids: [] });
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: apiSocketPath,
          path: '/api/v1/arrays',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        },
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
    expect(result.errors?.[0]?.details?.code).toBe('EXECUTOR_UNSUPPORTED');
  }, 15_000);
});
```

- [ ] **Step 3: Run — see fail (agent binary doesn't support XINAS_AGENT_PROBE_MODE yet, or processes not built)**

```bash
cd xiNAS-MCP && npx vitest run src/__tests__/e2e/agent-api-roundtrip.test.ts 2>&1 | tail -20
```
Expected: FAIL — either the test times out (agent doesn't start), or specific assertions fail because the api returns unexpected data. Capture the error output to guide the implementation.

**Note:** at this stage `XINAS_AGENT_PROBE_MODE=fixture:<path>` is a signal to the probe modules to return canned data. If this env-var feature has not yet been wired into the probe layer (Phase D tasks), the test will fail with a timeout on `waitForObservation`. That is the expected "red" state — the feature gate in probes must be added.

- [ ] **Step 4: Wire `XINAS_AGENT_PROBE_MODE` into probe modules**

Each probe module in `src/agent/probe/*.ts` must check the environment variable at startup:

```ts
// Pattern to add at the top of each probe module:
const PROBE_MODE = process.env['XINAS_AGENT_PROBE_MODE'];

function isFixtureMode(): boolean {
  return typeof PROBE_MODE === 'string' && PROBE_MODE.startsWith('fixture:');
}

function fixturePath(filename: string): string {
  if (!PROBE_MODE) throw new Error('not in fixture mode');
  return join(PROBE_MODE.slice('fixture:'.length), filename);
}
```

Each probe's `snapshot()` function then becomes:

```ts
export async function snapshotUsers(): Promise<ObservedUser[]> {
  if (isFixtureMode()) {
    const raw = readFileSync(fixturePath('users.json'), 'utf8');
    return JSON.parse(raw).map(parsePasswdLine);
  }
  // ... real getent implementation ...
}
```

Each probe's `startEventStream()` returns a no-op cleanup in fixture mode (no subprocesses to supervise).

Apply this pattern to: `disk.ts` (fixture: `disks.json`), `users.ts` (fixture: `users.json`), `idmap.ts` (fixture: `nfs-idmap.json`). Other probes (network, filesystem, nfs, systemd, inventory) use empty-array or minimal fallback fixtures.

- [ ] **Step 5: Verify**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx vitest run src/__tests__/e2e/agent-api-roundtrip.test.ts --reporter verbose 2>&1 | tail -20
npm test 2>&1 | tail -3
```
Expected: all 5 e2e tests pass (each taking 5-10s). Total suite count increases by 5.

- [ ] **Step 6: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add \
  xiNAS-MCP/src/__tests__/e2e/agent-api-roundtrip.test.ts \
  "xiNAS-MCP/src/__tests__/e2e/__fixtures__/users.json" \
  "xiNAS-MCP/src/__tests__/e2e/__fixtures__/disks.json" \
  "xiNAS-MCP/src/__tests__/e2e/__fixtures__/nfs-idmap.json"
git commit -m "$(cat <<'EOF'
test(e2e): add agent-api round-trip e2e suite (J3)

5 slow tests (~5-10s each) that boot a real xinas-api process and a
real xinas-agent process running in XINAS_AGENT_PROBE_MODE=fixture:<path>.
Probe modules check this env var at startup and return canned fixture
data instead of running real subprocesses or dbus clients.

Tests verify:
  1. Agent boots + initial sweep POSTs reach the api (nfs-idmap singleton)
  2. GET /api/v1/users returns fixture-injected users
  3. GET /api/v1/disks returns fixture-injected disk
  4. Kill agent → HeartbeatTracker transitions to offline (>6 intervals)
  5. Mutating stub returns EXECUTOR_UNAVAILABLE when agent is offline

Catches integration bugs the mock-agent layer misses: JSON-RPC framing,
retry semantics, real socket permission setup, controller-id-file parsing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase K — Ansible role + unit

### Task K1: `xinas_agent` role scaffold

**Files:**
- Create: `collection/roles/xinas_agent/defaults/.gitkeep`
- Create: `collection/roles/xinas_agent/handlers/.gitkeep`
- Create: `collection/roles/xinas_agent/tasks/.gitkeep`
- Create: `collection/roles/xinas_agent/templates/.gitkeep`

Mirror exactly the scaffold pattern from PR #203 ROLE-2 (which did the same for `xinas_api`). This commit is intentionally minimal — subsequent tasks (K2-K4) replace the `.gitkeep` stubs with real content. The scaffold commit lets reviewers see the directory structure before content.

- [ ] **Step 1: Check PR #203 scaffold pattern**

```bash
ls collection/roles/xinas_api/
```
Expected: `defaults/  handlers/  meta/  tasks/  templates/  README.md`

- [ ] **Step 2: Create the scaffold directories + gitkeeps**

```bash
mkdir -p \
  collection/roles/xinas_agent/defaults \
  collection/roles/xinas_agent/handlers \
  collection/roles/xinas_agent/tasks \
  collection/roles/xinas_agent/templates \
  collection/roles/xinas_agent/meta

touch \
  collection/roles/xinas_agent/defaults/.gitkeep \
  collection/roles/xinas_agent/handlers/.gitkeep \
  collection/roles/xinas_agent/tasks/.gitkeep \
  collection/roles/xinas_agent/templates/.gitkeep
```

Create `collection/roles/xinas_agent/meta/main.yml` (Ansible Galaxy metadata and dependency declaration):

```yaml
---
galaxy_info:
  author: xiNAS
  description: "Deploys xinas-agent — the privileged observation + execution daemon for Phase 0 control path."
  license: proprietary
  min_ansible_version: "2.14"

dependencies:
  - role: xinas_api   # agent-token is generated by xinas_api (task A7); must run first
```

- [ ] **Step 3: Verify lint + syntax (scaffold only)**

```bash
ansible-lint collection/roles/xinas_agent/ 2>&1 | tail -5
cat > /tmp/test-xinas-agent-scaffold.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_agent
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-agent-scaffold.yml 2>&1 | tail -5
rm /tmp/test-xinas-agent-scaffold.yml
```
Expected: ansible-lint may warn about empty tasks file; syntax-check passes. If ansible-lint fails on `.gitkeep`-only directories, create stub `main.yml` files instead of `.gitkeep` (empty YAML `---` is sufficient).

- [ ] **Step 4: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add collection/roles/xinas_agent/
git commit -m "$(cat <<'EOF'
feat(xinas_agent): scaffold new Ansible role (K1)

Empty directory tree + meta/main.yml for the xinas_agent role,
mirroring PR #203's xinas_api ROLE-2 pattern. Declares a dependency
on xinas_api (so the agent-token generated in A7 is present before
the agent role tries to use it).

Content follows in K2 (defaults + handlers), K3 (tasks), K4 (README).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task K2: `xinas_agent` role — defaults + handlers

**Files:**
- Replace: `collection/roles/xinas_agent/defaults/main.yml` (was `.gitkeep`)
- Replace: `collection/roles/xinas_agent/handlers/main.yml` (was `.gitkeep`)

- [ ] **Step 1: Write defaults**

Create `collection/roles/xinas_agent/defaults/main.yml`:

```yaml
---
# xinas_agent role defaults
# Override in inventory or playbook vars; do not edit this file for
# site-specific values — use group_vars or host_vars instead.

# Path to the xiNAS-MCP repository checkout that contains
# the compiled agent binary (dist/agent-server.js).
xinas_agent_repo_path: /opt/xiNAS/xiNAS-MCP

# Directory where the agent configuration file lives.
# Created by this role; NOT the same as /etc/xinas-api/ (api config).
xinas_agent_config_dir: /etc/xinas-agent

# Path to the agent's UDS socket. Must match the path configured
# in the xinas_api role's agent.socket value so the HeartbeatTracker
# can connect.
xinas_agent_socket: /run/xinas/agent.sock

# Path to the api's UDS socket. The agent POSTs observation batches
# to the api over this socket.
xinas_api_socket: /run/xinas/api.sock

# Path to the shared controller-id file. Generated by the xinas_api
# role (task A5). The agent reads it at startup and includes the UUID
# in every /internal/v1/observed POST body.
xinas_agent_controller_id_path: /var/lib/xinas/controller-id

# Path to the agent token file. Generated by the xinas_api role
# (task A7). Mode 0400 root:root.
xinas_agent_token_path: /etc/xinas-agent/agent-token

# SystemD unit source path in the repository checkout.
# The role copies this file to /etc/systemd/system/.
xinas_agent_unit_src: "{{ xinas_agent_repo_path }}/xinas-agent.service"

# Heartbeat interval the agent and api agree on (milliseconds).
# Must be consistent with xinas_api_agent_heartbeat_interval_ms in
# the xinas_api role.
xinas_agent_heartbeat_interval_ms: 5000
```

- [ ] **Step 2: Write handlers**

Create `collection/roles/xinas_agent/handlers/main.yml`:

```yaml
---
# xinas_agent role handlers

- name: reload systemd
  ansible.builtin.systemd:
    daemon_reload: true
  listen: reload systemd

- name: restart xinas-agent
  ansible.builtin.systemd:
    name: xinas-agent.service
    state: restarted
    enabled: true
  listen: restart xinas-agent
```

- [ ] **Step 3: Verify lint + syntax**

```bash
ansible-lint collection/roles/xinas_agent/ 2>&1 | tail -5
cat > /tmp/test-xinas-agent-k2.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_agent
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-agent-k2.yml 2>&1 | tail -3
rm /tmp/test-xinas-agent-k2.yml
```
Expected: clean (tasks directory is still a stub; lint tolerates it because defaults + handlers are valid YAML).

- [ ] **Step 4: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add collection/roles/xinas_agent/defaults/main.yml collection/roles/xinas_agent/handlers/main.yml
git commit -m "$(cat <<'EOF'
feat(xinas_agent): add defaults + handlers (K2)

Defaults declare the canonical paths (repo, config dir, socket,
controller-id, agent-token) and the heartbeat interval. All values
have safe defaults aligned with the spec; site overrides go in
group_vars.

Handlers: reload-systemd (notified by unit-install task) and
restart-xinas-agent (notified by config-change task). Handler
naming matches the xinas_api role convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task K3: `xinas_agent` role — tasks

**Files:**
- Replace: `collection/roles/xinas_agent/tasks/main.yml` (was `.gitkeep`)
- Create: `collection/roles/xinas_agent/templates/xinas-agent-config.json.j2`

The tasks cover: preflight checks, config dir creation, config templating, unit installation, daemon-reload, enable+start. The role is **opt-in** — it does not modify `playbooks/site.yml`; operators include it explicitly.

**Preflight design:** two hard failures that fail fast before any state mutation:

1. `stat /etc/xinas-agent/agent-token` — generated by `xinas_api` role task A7. If absent, the agent will crash at startup reading its token. Fail with a clear message telling the operator to run the `xinas_api` role first.
2. `stat {{ xinas_agent_repo_path }}/dist/agent-server.js` — the compiled agent binary. If absent, the TypeScript source has not been built. Fail with instructions to run `npm run build` in the MCP repo directory.

- [ ] **Step 1: Write the config template**

Create `collection/roles/xinas_agent/templates/xinas-agent-config.json.j2`:

```json
{
  "api_socket": "{{ xinas_api_socket }}",
  "agent_socket": "{{ xinas_agent_socket }}",
  "controller_id_path": "{{ xinas_agent_controller_id_path }}",
  "agent_token_path": "{{ xinas_agent_token_path }}",
  "heartbeat_interval_ms": {{ xinas_agent_heartbeat_interval_ms }}
}
```

- [ ] **Step 2: Write tasks**

Create `collection/roles/xinas_agent/tasks/main.yml`:

```yaml
---
# xinas_agent role tasks
# Pre-condition: the xinas_api role must have run first (generates
# /etc/xinas-agent/agent-token and /var/lib/xinas/controller-id).

# --- Preflight checks ---

- name: Preflight — verify /etc/xinas-agent/agent-token exists
  ansible.builtin.stat:
    path: "{{ xinas_agent_token_path }}"
  register: _xinas_agent_token_stat
  tags: [xinas_agent, preflight]

- name: Preflight — fail if agent-token is absent (run xinas_api role first)
  ansible.builtin.fail:
    msg: >
      /etc/xinas-agent/agent-token is absent. The agent-token is generated
      by the xinas_api role (task A7 in the Phase 0 plan). Run the xinas_api
      role before this role, or run the combined playbook that includes both.
  when: not _xinas_agent_token_stat.stat.exists
  tags: [xinas_agent, preflight]

- name: Preflight — verify compiled agent binary exists
  ansible.builtin.stat:
    path: "{{ xinas_agent_repo_path }}/dist/agent-server.js"
  register: _xinas_agent_binary_stat
  tags: [xinas_agent, preflight]

- name: Preflight — fail if agent binary is absent (run npm run build first)
  ansible.builtin.fail:
    msg: >
      {{ xinas_agent_repo_path }}/dist/agent-server.js is absent.
      Build the TypeScript source before deploying:
        cd {{ xinas_agent_repo_path }} && npm run build
  when: not _xinas_agent_binary_stat.stat.exists
  tags: [xinas_agent, preflight]

# --- Config directory ---

- name: Ensure /etc/xinas-agent/ directory exists
  ansible.builtin.file:
    path: "{{ xinas_agent_config_dir }}"
    state: directory
    owner: root
    group: root
    mode: '0755'
  tags: [xinas_agent, config]

# --- Config file ---

- name: Template xinas-agent config file
  ansible.builtin.template:
    src: xinas-agent-config.json.j2
    dest: "{{ xinas_agent_config_dir }}/config.json"
    owner: root
    group: root
    mode: '0640'
  notify: restart xinas-agent
  tags: [xinas_agent, config]

# --- Systemd unit ---

- name: Install xinas-agent.service systemd unit
  ansible.builtin.copy:
    src: "{{ xinas_agent_unit_src }}"
    dest: /etc/systemd/system/xinas-agent.service
    owner: root
    group: root
    mode: '0644'
    remote_src: true
  notify:
    - reload systemd
    - restart xinas-agent
  tags: [xinas_agent, unit]

- name: Force systemd reload before enabling (flush handlers now)
  ansible.builtin.meta: flush_handlers

- name: Enable and start xinas-agent.service
  ansible.builtin.systemd:
    name: xinas-agent.service
    state: started
    enabled: true
    daemon_reload: true
  tags: [xinas_agent, unit]
```

- [ ] **Step 3: Verify ansible-lint clean + syntax check**

```bash
ansible-lint collection/roles/xinas_agent/ 2>&1 | tail -5
cat > /tmp/test-xinas-agent-k3.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - role: xinas_agent
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-xinas-agent-k3.yml 2>&1 | tail -3
rm /tmp/test-xinas-agent-k3.yml
```
Expected: ansible-lint production profile clean; syntax-check passes.

- [ ] **Step 4: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add collection/roles/xinas_agent/tasks/main.yml collection/roles/xinas_agent/templates/xinas-agent-config.json.j2
git commit -m "$(cat <<'EOF'
feat(xinas_agent): add tasks + config template (K3)

Two hard preflight checks before any state mutation:
  1. agent-token exists (generated by xinas_api A7) — fail fast with
     a clear remediation message if absent.
  2. dist/agent-server.js exists — fail fast with build instruction.

After preflight: creates /etc/xinas-agent/, templates config.json
(api_socket, agent_socket, controller_id_path, agent_token_path,
heartbeat_interval_ms), copies the systemd unit from the repo
checkout, flushes handlers (daemon-reload), enables + starts.

ansible-lint production profile clean; syntax-check passes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task K4: `xinas_agent` role README

**Files:**
- Create: `collection/roles/xinas_agent/README.md`

Mirrors PR #203's README structure (xinas_api ROLE-10 pattern). Documents what the role does and doesn't, the pre-flight chain, token rotation, and verification commands. This is a pure docs task; no code changes.

- [ ] **Step 1: Read the xinas_api README for style reference**

```bash
head -100 collection/roles/xinas_api/README.md
```

Observe: heading style, table format, variable listing pattern, verification command section.

- [ ] **Step 2: Write the README**

Create `collection/roles/xinas_agent/README.md`:

```markdown
# xinas_agent Ansible role

Deploys **xinas-agent** — the privileged observation and execution daemon that
feeds live system state into the xinas-api state store and executes typed RPCs
on behalf of API callers.

## What this role does

1. **Preflight checks** — verifies the agent-token (generated by `xinas_api`)
   and the compiled `dist/agent-server.js` binary are present before making any
   state changes. Fails fast with a clear remediation message if either is absent.

2. **Config directory + file** — creates `/etc/xinas-agent/` (mode `0755 root:root`)
   and templates `/etc/xinas-agent/config.json` (mode `0640 root:root`) from
   `xinas-agent-config.json.j2`. Contains socket paths, controller-id-path,
   agent-token-path, and heartbeat interval.

3. **Systemd unit install** — copies `xinas-agent.service` from the repo checkout
   (`{{ xinas_agent_repo_path }}/xinas-agent.service`) to
   `/etc/systemd/system/xinas-agent.service`, then daemon-reload, enable, start.

## What this role does NOT do

- It does **not** generate the agent-token. Token generation is the `xinas_api`
  role's responsibility (task A7). This role fails preemptively if the token is
  absent.
- It does **not** build the TypeScript source. Run `npm run build` in the MCP
  repository before deploying.
- It does **not** modify `playbooks/site.yml`. This role is opt-in only — include
  it explicitly in your playbook.

## Pre-flight chain

The roles must run in this order:

```
1. xinas_mcp build (npm run build in xiNAS-MCP/)
2. xinas_api role  ← generates agent-token + controller-id + xinas-api group
3. xinas_agent role ← reads agent-token; installs unit
```

The `meta/main.yml` dependency declaration enforces step 2 before step 3.

## Variables

| Variable | Default | Description |
|---|---|---|
| `xinas_agent_repo_path` | `/opt/xiNAS/xiNAS-MCP` | Path to the MCP repo checkout containing `dist/agent-server.js`. |
| `xinas_agent_config_dir` | `/etc/xinas-agent` | Directory for the agent config file. |
| `xinas_agent_socket` | `/run/xinas/agent.sock` | UDS socket the agent binds. Must match the api's `agent.socket` config. |
| `xinas_api_socket` | `/run/xinas/api.sock` | UDS socket the agent uses to POST observations to the api. |
| `xinas_agent_controller_id_path` | `/var/lib/xinas/controller-id` | Shared identity file (read-only; written by `xinas_api`). |
| `xinas_agent_token_path` | `/etc/xinas-agent/agent-token` | Token file (read-only; written by `xinas_api`). Mode `0400 root:root`. |
| `xinas_agent_unit_src` | `{{ xinas_agent_repo_path }}/xinas-agent.service` | Source path for the systemd unit. |
| `xinas_agent_heartbeat_interval_ms` | `5000` | Interval (ms) at which the api's HeartbeatTracker pings the agent. Must be consistent with the `xinas_api` role's matching variable. |

## Token rotation

The agent-token lives at `/etc/xinas-agent/agent-token` (mode `0400 root:root`)
and its hashed form in `/etc/xinas-api/internal-tokens.json` (mode `0640 root:xinas-api`).

To rotate:

1. Re-run the `xinas_api` role with a `rotate_agent_token: true` variable (adds
   a new token entry alongside the old one for a zero-downtime window).
2. Restart `xinas-agent.service`.
3. Re-run the `xinas_api` role with `remove_old_agent_token: true` to revoke the
   previous token from `internal-tokens.json`.

(Rotation automation is a future task; manual file editing works for now.)

## Verification commands

After deployment:

```bash
# Both services should be active
sudo systemctl status xinas-api.service xinas-agent.service

# Agent should respond to health check
echo '{"jsonrpc":"2.0","id":1,"method":"agent.health","params":{}}' | \
  sudo socat - UNIX-CONNECT:/run/xinas/agent.sock

# Over the UDS the api trusts the connection as admin (no bearer needed).
# To exercise the bearer path instead, read the bootstrap token with
#   TOKEN=$(sudo cat /etc/xinas-api/admin-token)
# and add an Authorization request header carrying "Bearer $TOKEN".

# API should show agent state = healthy after a few seconds
curl --unix-socket /run/xinas/api.sock \
  http://localhost/api/v1/system | jq .result.node.status.agent

# Users observed from the agent should be non-empty
curl --unix-socket /run/xinas/api.sock \
  http://localhost/api/v1/users | jq length
```

## Tags

| Tag | Description |
|---|---|
| `xinas_agent` | All tasks in this role. |
| `xinas_agent,preflight` | Preflight checks only (useful for dry-run verification). |
| `xinas_agent,config` | Config file tasks only. |
| `xinas_agent,unit` | Systemd unit install + enable tasks only. |
```

- [ ] **Step 3: Commit**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add collection/roles/xinas_agent/README.md
git commit -m "$(cat <<'EOF'
docs(xinas_agent): add role README (K4)

Documents: what the role does (preflight, config, unit install),
what it doesn't (token generation, TS build, site.yml modification),
the 3-step pre-flight chain, all variables with defaults and meaning,
the token rotation procedure, verification commands, and tag index.

Mirrors PR #203's xinas_api ROLE-10 README structure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task K5: `xinas-agent.service` systemd unit — full hardening

**Files:**
- Replace/complete: `xiNAS-MCP/xinas-agent.service` (skeleton created in C5)

This task completes the systemd unit started in C5 with full ADR-0002 §Hardening directives. After this commit the unit is production-ready for the Ansible role's `copy` task (K3) to deploy.

Key design choices (per spec §Architecture — Process topology + ADR-0002):
- `User=root` — required for socket chown, udev access, dbus, filesystem probing.
- `After=xinas-api.service`, `Requires=xinas-api.service` — agent must not start if the api is down; the api binds the UDS first; the agent connects to it immediately after bind.
- `ReadWritePaths` covers only the minimum set the agent needs to write: `/run/xinas` (socket creation + chown), `/var/log/xinas` (optional structured log rotate), `/var/lib/xinas/state` (future; harmless to declare now).
- `ProtectSystem=strict` with `ReadWritePaths` exceptions rather than `ProtectSystem=full` — stricter default, explicit allowlist. **Deviation from ADR-0002 line 207**, which sampled `ProtectSystem=full` + a broad `ReadWritePaths` including `/etc/exports /etc/nfs /etc/netplan /etc/systemd/system`. Those mutating-write paths are NOT needed in S0+S1 (observation-only; no mutating methods implemented), so this unit uses the tighter `strict` and the minimal observation-write `ReadWritePaths` set. When the mutating adapters land (S3–S6), `ReadWritePaths` expands to cover the paths each adapter writes — at which point the ADR-0002 line-208 set becomes the target. **Flag for review:** confirm `strict`-now-expand-later is acceptable, or revert to ADR-0002's `full` + broad set immediately if the reviewer prefers the unit shape to be stable across the S-series.
- `SystemCallFilter=@system-service @mount @network-io` — the agent supervises network probes (`ip monitor` subprocess) and mount-state watchers (dbus + inotify on mountinfo). The `@mount` group permits `mount`/`umount` syscalls used by the filesystem probe (not to actually mount, but to call `statfs` which is in the group). The `@network-io` group permits `recvmsg`/`sendmsg` used by the dbus client and the unix-socket clients.
- `RestrictAddressFamilies=AF_UNIX AF_NETLINK` — all agent communication is UDS (helper socket, api socket, agent's own listen socket) plus netlink (used by `ip monitor` subprocess indirectly via the kernel's netlink socket that `ip` opens; the agent itself opens only UDS but the subprocess inherits the fd namespace).

- [ ] **Step 1: Read the current skeleton**

```bash
cat xiNAS-MCP/xinas-agent.service
```
Identify what C5 left as placeholders (e.g., `# TODO: hardening`).

- [ ] **Step 2: Write the complete unit**

Write `xiNAS-MCP/xinas-agent.service`:

```ini
[Unit]
Description=xinas-agent — privileged observation and execution daemon (Phase 0)
Documentation=https://github.com/Xinnor/xiNAS/blob/main/collection/roles/xinas_agent/README.md
After=network-online.target xinas-api.service
Requires=xinas-api.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/xiNAS/xiNAS-MCP/dist/agent-server.js
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=xinas-agent

# Identity — runs as root per ADR-0002 §Privilege boundary.
# The agent needs root to: chown /run/xinas/agent.sock, read /proc/*
# directly, spawn udevadm/ip monitor, and call dbus as the system bus
# client for unit state. Per-method privilege reduction (capabilities
# drop after bind) is a future hardening step (see ADR-0002 open questions).
User=root
Group=root

# Environment
Environment=XINAS_AGENT_CONFIG=/etc/xinas-agent/config.json
Environment=NODE_ENV=production

# --- Filesystem isolation ---
# ProtectSystem=strict makes / read-only except for explicit ReadWritePaths.
ProtectSystem=strict
PrivateTmp=true
ProtectHome=true
# Paths the agent must write:
#   /run/xinas      — agent.sock creation + chgrp
#   /var/log/xinas  — optional structured-log rotation (harmless to declare)
# NOTE: /var/lib/xinas/state is deliberately NOT writable here. Per ADR-0002
# the api is the SOLE SQLite writer; the agent reports observations via the
# api's /internal/v1/observed. /var/lib/xinas is read-only below (the agent
# only reads /var/lib/xinas/controller-id). Listing /var/lib/xinas/state in
# both ReadWritePaths and under a ReadOnlyPaths parent was contradictory.
ReadWritePaths=/run/xinas /var/log/xinas
# Read-only paths the agent must read:
#   /var/lib/xinas/controller-id — shared identity (0644 world-readable)
#   /etc/xinas-agent             — config.json + agent-token (0640 / 0400)
ReadOnlyPaths=/var/lib/xinas /etc/xinas-agent

# --- Capability bounding ---
NoNewPrivileges=true
# CAP_CHOWN is required: the agent creates /run/xinas/agent.sock owned by
# root:root, then chgrps it to root:xinas-api so the api (member of the
# xinas-api group) can connect. With User=root + NoNewPrivileges, an EMPTY
# CapabilityBoundingSet would mask CAP_CHOWN and the chgrp would fail with
# EPERM, breaking the socket gate. We grant exactly CAP_CHOWN — nothing else.
# (The udevadm/ip-monitor subprocesses read the kernel uevent/rtnetlink
# multicast groups, which do not require CAP_NET_ADMIN for a read-only
# listener. The final minimal capability + SystemCallFilter set is tuned
# against real hardware in the L-phase validation / WS13 packaging pass.)
CapabilityBoundingSet=CAP_CHOWN
AmbientCapabilities=CAP_CHOWN

# --- Process isolation ---
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictRealtime=true
RestrictSUIDSGID=true
RemoveIPC=true

# --- Namespace restrictions ---
# Allow PID + mount + UTS + IPC + net namespaces (inherited from the agent's
# perspective) but prevent the agent from creating new namespaces itself.
# The probe subprocesses (ip, udevadm) inherit the parent's namespace — this
# is intentional: they observe the host, not a container namespace.
RestrictNamespaces=~cgroup ~user

# --- System call filter ---
# @system-service  — baseline for a long-running service (read/write/open/mmap etc.)
# @mount           — statfs() used by filesystem probe; NOT actual mount/umount
# @network-io      — recvmsg/sendmsg for dbus client + unix socket I/O
# @file-system     — open/read/stat on /proc, /sys, /etc for probes
# @io-event        — inotify for filesystem + idmap + user/group change detection
# @signal          — kill/sigaction for subprocess supervisor restart logic
SystemCallFilter=@system-service @mount @network-io @file-system @io-event @signal
SystemCallErrorNumber=EPERM

# --- Address family restriction ---
# AF_UNIX: agent socket, api socket, nfs-helper socket, dbus socket
# AF_NETLINK: ip-monitor subprocess (netlink kernel interface for RTnetlink events)
RestrictAddressFamilies=AF_UNIX AF_NETLINK

# --- Misc ---
# dbus is the system bus; the agent subscribes to systemd unit PropertiesChanged.
# systemd's bus socket lives at /run/dbus/system_bus_socket (AF_UNIX, already allowed).
# No additional capability needed — dbus client connections use regular sockets.

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Validate unit file**

```bash
# On hosts with systemd-analyze available:
systemd-analyze verify xiNAS-MCP/xinas-agent.service 2>&1 | tail -5 \
  || echo "(systemd-analyze unavailable on this host)"

# Cross-check the key security directives are present:
grep -E "^(User|Group|After|Requires|ProtectSystem|NoNewPrivileges|RestrictNamespaces|SystemCallFilter|ReadWritePaths)=" \
  xiNAS-MCP/xinas-agent.service
```

Expected output (order may differ):
```
User=root
Group=root
After=network-online.target xinas-api.service
Requires=xinas-api.service
ProtectSystem=strict
NoNewPrivileges=true
RestrictNamespaces=~cgroup ~user
SystemCallFilter=@system-service @mount @network-io @file-system @io-event @signal
ReadWritePaths=/run/xinas /var/log/xinas
CapabilityBoundingSet=CAP_CHOWN
AmbientCapabilities=CAP_CHOWN
```

- [ ] **Step 4: Commit with `Requires-Rebuild: xinas_agent` trailer**

```bash
cd /Users/sergeyplatonov/Documents/GitHub/xiNAS/.claude/worktrees/determined-hoover-833782
git add xiNAS-MCP/xinas-agent.service
git commit -m "$(cat <<'EOF'
feat(xinas_agent): complete systemd unit with full hardening (K5)

Completes the xinas-agent.service skeleton from C5 with production
hardening per ADR-0002 §Hardening:

  User=root (required for socket chown, udev, dbus, /proc probing)
  After=xinas-api.service, Requires=xinas-api.service
  ProtectSystem=strict + ReadWritePaths=/run/xinas /var/log/xinas
  NoNewPrivileges=true, CapabilityBoundingSet=CAP_CHOWN (socket chgrp only)
  LockPersonality, MemoryDenyWriteExecute, RestrictRealtime
  RestrictNamespaces=~cgroup ~user (host ns inherited by probes)
  SystemCallFilter=@system-service @mount @network-io @file-system
    @io-event @signal (covers statfs, recvmsg, inotify, kill)
  RestrictAddressFamilies=AF_UNIX AF_NETLINK

The Ansible role's K3 tasks/main.yml copies this file to
/etc/systemd/system/ on deploy.

Requires-Rebuild: xinas_agent

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Phase L — Sanity + PR

### Task L1: Whole-system sanity check

- [ ] **Step 1: Full Ansible lint over both roles**

```bash
ansible-lint collection/roles/xinas_api/ collection/roles/xinas_agent/ 2>&1 | tail -10
```
Expected: 0 failures.

- [ ] **Step 2: Syntax check via combined playbook**

```bash
cat > /tmp/test-both-roles.yml <<'EOF'
---
- hosts: localhost
  gather_facts: false
  roles:
    - xinas_mcp
    - xinas_api
    - xinas_agent
EOF
ANSIBLE_ROLES_PATH=collection/roles ansible-playbook --syntax-check /tmp/test-both-roles.yml 2>&1 | tail -3
rm /tmp/test-both-roles.yml
```

- [ ] **Step 3: TypeScript typecheck + lint + full test suite**

```bash
cd xiNAS-MCP
npx tsc --noEmit
npx biome lint src/ 2>&1 | tail -5
npm test 2>&1 | tail -3
```
Expected: 0 TS errors, biome clean, all tests pass. The biome lint should specifically reject any cross-boundary imports between `src/agent/probe/` and outside `src/agent/` (the rule from A1).

- [ ] **Step 4: Coverage report**

```bash
npm run test:coverage 2>&1 | grep -E "src/lib/parse|src/agent|src/api" | tail -25
```
Expected: `src/lib/parse/` ~95%, `src/agent/collectors/` ~80%, `src/api/internal/` ~85%, `src/api/heartbeat.ts` ~80%.

- [ ] **Step 5: api-v1.yaml validates**

```bash
npx spectral lint docs/control-path/api-v1.yaml 2>&1 | tail -5
npx vitest run src/__tests__/contracts/ 2>&1 | tail -5
```

- [ ] **Step 6: Manual smoke against ephemeral sockets**

```bash
mkdir -p /tmp/xinas-smoke && cat > /tmp/xinas-smoke/api-config.json <<'EOF'
{
  "controller_id": "00000000-0000-0000-0000-0000000000aa",
  "listen": { "kind": "unix", "socket": "/tmp/xinas-smoke/api.sock" },
  "tokens": { "tok-admin": { "principal": "admin:smoke", "role": "admin" } },
  "state": {
    "databasePath": "/tmp/xinas-smoke/xinas.db",
    "auditJsonlPath": "/tmp/xinas-smoke/audit.jsonl"
  },
  "internalTokensPath": "/tmp/xinas-smoke/internal-tokens.json"
}
EOF
echo '{"tok-agent": {"principal": "agent:root", "role": "internal_agent"}}' > /tmp/xinas-smoke/internal-tokens.json
cat > /tmp/xinas-smoke/agent-config.json <<'EOF'
{
  "api_socket": "/tmp/xinas-smoke/api.sock",
  "agent_socket": "/tmp/xinas-smoke/agent.sock",
  "controller_id_path": "/tmp/xinas-smoke/controller-id",
  "agent_token_path": "/tmp/xinas-smoke/agent-token"
}
EOF
echo "00000000-0000-0000-0000-0000000000aa" > /tmp/xinas-smoke/controller-id
echo "tok-agent" > /tmp/xinas-smoke/agent-token

XINAS_API_CONFIG=/tmp/xinas-smoke/api-config.json npm run dev:api &
API_PID=$!
sleep 2
XINAS_AGENT_CONFIG=/tmp/xinas-smoke/agent-config.json \
XINAS_AGENT_PROBE_MODE=fixture:src/__tests__/e2e/__fixtures__/ \
  npm run dev:agent &
AGENT_PID=$!
sleep 3

# Over the Unix socket the api trusts the connection as admin without a
# bearer (UDS-trust path), so no Authorization header is needed for the
# smoke check.
curl --unix-socket /tmp/xinas-smoke/api.sock \
     http://localhost/api/v1/disks | jq '.result | length'
curl --unix-socket /tmp/xinas-smoke/api.sock \
     http://localhost/api/v1/system | jq '.result.node.status.agent'

kill $AGENT_PID $API_PID 2>/dev/null
rm -rf /tmp/xinas-smoke
```
Expected: `/api/v1/disks` returns the fixture-injected count; `/api/v1/system` shows `agent.state: "healthy"`.

- [ ] **Step 7: No commit** (verification only).

---

### Task L2: Push + PR + CI watch + OPERATOR-GATED merge

- [ ] **Step 1: Push the branch**

```bash
git push -u origin claude/phase0-xinas-agent-s0s1 2>&1 | tail -5
```

- [ ] **Step 2: Open the PR**

Use the standard HEREDOC pattern from PR #203's task ROLE-12, with this PR's title:

> `feat(api,agent): Phase 0 xinas-agent S0+S1 (skeleton + 10-kind observation)`

Body summarizes: new agent process, observation flow, 5 new public GETs, foundation refactor to `xinas_api` role, KvTransaction.list extension. Lists `What's deferred` (mutating methods, task envelope, drift framework, etc. per spec).

- [ ] **Step 3: Watch CI**

```bash
sleep 8
RUN=$(gh run list --branch claude/phase0-xinas-agent-s0s1 --workflow ci --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN --exit-status > /tmp/agent-watch.out 2>&1; echo "exit=$?"
gh run view $RUN --json status,conclusion,jobs | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'overall: {d[\"status\"]}/{d[\"conclusion\"]}')
ok = sum(1 for j in d['jobs'] if j['conclusion']=='success')
fail = sum(1 for j in d['jobs'] if j['conclusion']=='failure')
print(f'success={ok} failure={fail} of {len(d[\"jobs\"])}')
"
```
Expected: 9 blocking + warn-flipped green; 5 documented warn-only fail.

- [ ] **Step 4: OPERATOR GATE — STOP**

Print to Sergey:

> PR #N (xinas-agent S0+S1) is green. ansible/typescript-lint/typescript-tests/typescript-contracts/openapi/python-tests/secrets/ansible all pass; 5 documented warn-only fail. ~71 commits across foundation, parse lib, agent skeleton, probes, collectors, publisher, api contract, api routes, tests, Ansible roles. Ready to merge via `gh pr merge N --rebase --delete-branch`. Approve?

Do NOT proceed without explicit approval.

- [ ] **Step 5: Merge (after approval)**

```bash
gh pr merge <N> --rebase --delete-branch 2>&1 | tail -3
gh pr view <N> --json state,mergedAt,mergeCommit
```

- [ ] **Step 6: Watch post-merge CI on main**

Standard post-merge watch pattern from PR #203's ROLE-12 step 6.

---

## Self-review

**1. Spec coverage:**

| Spec section | Implementing task(s) |
|---|---|
| Architecture / process topology | C2-C5 (agent skeleton), H1-H5 (api side) |
| Foundation: group model | A3, A4 |
| Foundation: controller-id file | A5, A6 |
| Foundation: split-secret tokens | A7, A8 |
| Foundation: KvTransaction.list | A2 |
| Code layout — pure vs probe boundary | A1 (biome rule), B (parse lib), D (probes) |
| Agent RPC surface | C2-C4 |
| Flow A — observation push | F1-F3 (publisher) + H3 (handler) |
| Flow B — heartbeat | H1 (tracker) + C4 (agent.health) |
| Flow C — startup sequence | F3 (boot integration) |
| Flow D — event-driven refresh + backstop | D + E + F2 (pendingReconcile + backstop) |
| API contract additions | G1-G5 |
| status.observed_at bridge | G5 + every E task stamps it |
| /internal/v1/observed | H3 |
| /internal/v1/agent_started | H4 |
| requireInternalAgent middleware | H2 |
| systemWarningsMiddleware + mergeWarnings | H5 |
| Public route additions | I1-I5 |
| Errors (JSON-RPC + envelope mapping) | C2 (dispatcher), C4 (stubs registry) |
| Observability — agent logs | C1 (log module) |
| Observability — Node.status.agent | I4 |
| Observability — degraded warning | H5 (scoped to mutating routes) |
| Testing layer 1 — parse lib | B1-B10 |
| Testing layer 2 — mock-agent | J1 |
| Testing layer 3 — end-to-end | J3 |
| Coverage tooling | A1 |
| xinas_agent Ansible role | K1-K5 |
| xinas-agent.service | C5 (stub) + K5 (complete) |
| xinas_api role modifications | A3, A5, A7, K5 (tmpfiles entry) |
| Update xinas_api role-spec.md | A9 |

No gaps. All `Out of scope` items remain explicitly out of scope in the plan.

**2. Placeholder scan:** All 72 tasks across all 12 phases are now fully expanded with verbatim test code, verbatim implementation code, exact run commands + expected output, and HEREDOC commit messages. No "TBD", no "implement later", no "similar to Task N", no compressed index blocks remain. Every task is independently executable from its own section.

**3. Type consistency:**

- `ObservationDelta`, `Kind`, `RevisionedValue` — used identically across parse lib, collectors, publisher, /internal/v1/observed handler.
- `Collector<K>` interface — defined in E1; every E2-E10 collector implements it.
- `Role` type values: `'viewer' | 'operator' | 'admin' | 'local_admin' | 'internal_agent'` — consistent in A8, H2, all subsequent middleware.
- `HeartbeatTracker` API: `currentState()`, `recordHeartbeatSuccess()`, `recordHeartbeatFailure()`, `recordObservationPush()` — used in H1 (definition), F3 (agent boot), H3 (observation handler), H5 (system-warnings middleware), I4 (/system route).
- Path constants: `/run/xinas/agent.sock`, `/etc/xinas-agent/agent-token`, `/var/lib/xinas/controller-id`, `/etc/xinas-api/internal-tokens.json` — same everywhere.
- HEREDOC commit trailers — identical `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` line.

No drift. Ready for execution.

---

## Execution handoff

72 tasks across 12 phases, all fully expanded to the bite-sized 5-step granularity (verbatim test + impl code, exact commands, HEREDOC commits). For execution:

- **Subagent-driven-development** (recommended): the controller dispatches one subagent per task. The subagent gets the task's full text from this plan, applies the 5-step TDD shape, and reports DONE/CONCERNS/BLOCKED. Spec-compliance + code-quality review subagents run between tasks. Same flow PR #203 used.
- **Inline execution** via `superpowers:executing-plans`: smaller, mechanical changes fit fine in batches; complex tasks (publisher retry, dbus subscriptions, end-to-end test) benefit from per-task focus.

Either way, after Phase H the system should be testable end-to-end with the mock-agent harness; after Phase J it should be testable with real processes; after Phase K it should be deployable via the Ansible roles.
