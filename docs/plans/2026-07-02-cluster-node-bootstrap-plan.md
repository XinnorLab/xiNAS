# Cluster/Node Infrastructure Bootstrap (ADR-0016) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `xinas-api` seeds `/xinas/v1/cluster` and `/xinas/v1/nodes/<controller_id>` at startup so `GET /system` / `GET /capabilities` (and MCP `system.get`) work on a fresh install with no manual seeding (bug #32).

**Architecture:** A single new module `src/api/bootstrap.ts` exporting `seedInfrastructure(state, config)`, called from `startServer()` immediately after the state store opens and before any listener binds (single writer — no CAS needed). Create-if-absent for both rows; the one exception is the advertised `mcp.allow_apply` capability, which is refreshed to match the api config on every startup. Spec: `docs/control-path/adr/0016-infrastructure-bootstrap.md` + phase0-requirements §5 (already written, uncommitted).

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Node 20, vitest + supertest, biome. All commands run from `xiNAS-MCP/`.

---

### Task 0: Commit the spec

**Files:**
- Commit (already written): `docs/control-path/adr/0016-infrastructure-bootstrap.md`
- Commit (already edited): `docs/control-path/phase0-requirements.md`

- [ ] **Step 1: Commit the spec files** (from the repo root, not `xiNAS-MCP/`)

```bash
git add docs/control-path/adr/0016-infrastructure-bootstrap.md docs/control-path/phase0-requirements.md
git commit -m "docs(control-path): ADR-0016 — xinas-api self-seeds cluster + node singletons (#32)

Fills the seeding gap ADR-0003 left open: the api creates
/xinas/v1/cluster and /xinas/v1/nodes/<controller_id> at startup when
absent. phase0-requirements §5 gains the matching requirement + verify
criterion.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: `seedInfrastructure()` module + tests

**Files:**
- Create: `xiNAS-MCP/src/__tests__/api/bootstrap.test.ts`
- Create: `xiNAS-MCP/src/api/bootstrap.ts`

Background for the implementer:
- `buildTestApp()` (`src/__tests__/api/_helpers.ts`) returns `{ dir, config, state, app, ctx, cleanup }` with a temp SQLite store and **no** cluster/node rows — exactly the fresh-install state. `config.controller_id` is `'00000000-0000-0000-0000-0000000000aa'`.
- `state.kv.get<T>(key)` returns `{ value: T, revision: number, ... } | null`; `state.kv.put(key, value)` writes (no CAS opts needed here).
- Response envelope: route payloads are under `res.body.result`.
- The routes under test: `src/api/routes/system.ts` — `GET /api/v1/system` needs the cluster row AND ≥1 node row; `GET /api/v1/capabilities` needs only the cluster row.

- [ ] **Step 1: Write the failing test**

Create `xiNAS-MCP/src/__tests__/api/bootstrap.test.ts`:

```typescript
import os from 'node:os';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedInfrastructure } from '../../api/bootstrap.js';
import { ADMIN_TOKEN, buildTestApp } from './_helpers.js';

// ADR-0016: the api self-seeds the infrastructure singletons at startup.
// These tests run against an UNSEEDED store — the fresh-install state that
// bug #32 hit — with no seedCluster()/seedNode() helper calls.
describe('ADR-0016 infrastructure bootstrap', () => {
  let setup: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    setup = await buildTestApp();
  });

  afterEach(async () => {
    await setup.cleanup();
  });

  it('unseeded store still 404s (pins the pre-bootstrap failure mode)', async () => {
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  it('seeds cluster + node so GET /system returns 200 with the ADR-0003 shapes', async () => {
    seedInfrastructure(setup.state, setup.config);
    const res = await request(setup.app).get('/api/v1/system').set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const { cluster, node } = res.body.result;
    expect(cluster.status.mode).toBe('single_node');
    expect(cluster.status.member_node_ids).toEqual([setup.config.controller_id]);
    expect(cluster.spec.display_name).toBe(os.hostname());
    expect(node.id).toBe(setup.config.controller_id);
    expect(node.spec.hostname).toBe(os.hostname());
    expect(node.status.agent_state).toBe('offline');
  });

  it('GET /capabilities returns the Phase 0 flags, mcp.allow_apply mirrors config (absent → false)', async () => {
    seedInfrastructure(setup.state, setup.config); // test config has no mcp block
    const res = await request(setup.app)
      .get('/api/v1/capabilities')
      .set('Authorization', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.result.ha).toBe('not_enabled');
    expect(res.body.result.quorum).toBe('not_enabled');
    expect(res.body.result.witness).toBe('not_enabled');
    expect(res.body.result['nfs.v3_locking_managed']).toBe(false);
    expect(res.body.result['nfs.recovery_state_managed']).toBe(false);
    expect(res.body.result['mcp.allow_apply']).toBe(false);
  });

  it('re-run is a no-op that preserves operator edits (restart over existing DB)', async () => {
    seedInfrastructure(setup.state, setup.config);
    const row = setup.state.kv.get<{ spec: { display_name: string } }>('/xinas/v1/cluster');
    expect(row).not.toBeNull();
    const edited = structuredClone(row!.value);
    edited.spec.display_name = 'operator-named';
    setup.state.kv.put('/xinas/v1/cluster', edited);

    seedInfrastructure(setup.state, setup.config); // simulated restart

    const after = setup.state.kv.get<{ spec: { display_name: string } }>('/xinas/v1/cluster');
    expect(after!.value.spec.display_name).toBe('operator-named');
  });

  it('refreshes ONLY the mcp.allow_apply mirror when the config flag flips', async () => {
    seedInfrastructure(setup.state, setup.config); // allow_apply false
    const nodeKey = `/xinas/v1/nodes/${setup.config.controller_id}`;
    const nodeBefore = setup.state.kv.get(nodeKey);

    seedInfrastructure(setup.state, { ...setup.config, mcp: { allow_apply: true } });

    const cluster = setup.state.kv.get<{
      spec: { display_name: string };
      status: { capabilities: Record<string, unknown> };
    }>('/xinas/v1/cluster');
    expect(cluster!.value.status.capabilities['mcp.allow_apply']).toBe(true);
    expect(cluster!.value.spec.display_name).toBe(os.hostname()); // untouched
    const nodeAfter = setup.state.kv.get(nodeKey);
    expect(nodeAfter!.revision).toBe(nodeBefore!.revision); // node row not rewritten
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `xiNAS-MCP/`): `npx vitest run src/__tests__/api/bootstrap.test.ts`
Expected: FAIL — cannot resolve `../../api/bootstrap.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `xiNAS-MCP/src/api/bootstrap.ts`:

```typescript
import os from 'node:os';
import type { OpenedStateStore } from '../state/index.js';
import type { ApiConfig } from './config.js';

const CLUSTER_KEY = '/xinas/v1/cluster';

interface ClusterRow {
  kind: string;
  id: string;
  spec: Record<string, unknown>;
  status: {
    mode: string;
    capabilities: Record<string, unknown>;
    member_node_ids: string[];
  };
}

/**
 * ADR-0016: seed the infrastructure singletons the read routes hard-require
 * (/xinas/v1/cluster + /xinas/v1/nodes/<controller_id>) so a fresh install —
 * or a wiped/restored state DB — serves GET /system and /capabilities without
 * any installer or agent involvement.
 *
 * Called from startServer() before any listener binds, so there is exactly
 * one writer and plain put() (no CAS) is safe. Existing rows are never
 * overwritten, with one exception: the advertised `mcp.allow_apply`
 * capability is refreshed to match the current api config (the MCP
 * dispatcher reads the config directly — this keeps /capabilities truthful,
 * it is not the gate itself).
 */
export function seedInfrastructure(state: OpenedStateStore, config: ApiConfig): void {
  const allowApply = config.mcp?.allow_apply === true;

  const cluster = state.kv.get<ClusterRow>(CLUSTER_KEY);
  if (cluster === null) {
    state.kv.put(CLUSTER_KEY, {
      kind: 'Cluster',
      id: 'default',
      spec: { display_name: os.hostname() },
      status: {
        mode: 'single_node',
        capabilities: {
          ha: 'not_enabled',
          quorum: 'not_enabled',
          witness: 'not_enabled',
          'nfs.v3_locking_managed': false,
          'nfs.recovery_state_managed': false,
          'mcp.allow_apply': allowApply,
        },
        member_node_ids: [config.controller_id],
      },
    } satisfies ClusterRow);
  } else if (cluster.value.status.capabilities['mcp.allow_apply'] !== allowApply) {
    const next = structuredClone(cluster.value);
    next.status.capabilities['mcp.allow_apply'] = allowApply;
    state.kv.put(CLUSTER_KEY, next);
  }

  const nodeKey = `/xinas/v1/nodes/${config.controller_id}`;
  if (state.kv.get(nodeKey) === null) {
    state.kv.put(nodeKey, {
      kind: 'Node',
      id: config.controller_id,
      spec: { hostname: os.hostname() },
      // Static cold default — GET /system surfaces live heartbeat state
      // under node.status.agent; nothing keeps this flat field current
      // (ADR-0016 decision 2).
      status: { agent_state: 'offline', observation_age_seconds: 0 },
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/api/bootstrap.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Lint + typecheck the new files**

Run: `npm run lint && npm run typecheck`
Expected: no errors (biome + tsc are strict; fix any complaint before committing).

- [ ] **Step 6: Commit**

```bash
git add src/api/bootstrap.ts src/__tests__/api/bootstrap.test.ts
git commit -m "feat(api): seedInfrastructure() — cluster + node singleton bootstrap (ADR-0016, #32)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire into `startServer()` and verify the suite

**Files:**
- Modify: `xiNAS-MCP/src/api/server.ts` (import block ~line 4-12; call site directly after `state.drainer.start()` at ~line 37)

- [ ] **Step 1: Add the import and the call**

In `xiNAS-MCP/src/api/server.ts`, add to the imports:

```typescript
import { seedInfrastructure } from './bootstrap.js';
```

and directly after `state.drainer.start();`:

```typescript
  // ADR-0016: seed /xinas/v1/cluster + /xinas/v1/nodes/<controller_id>
  // (create-if-absent; allow_apply mirror refresh) before anything can
  // serve reads — the routes hard-require both rows.
  seedInfrastructure(state, config);
```

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: PASS, no regressions. (Tests build apps via `createApp()` and seed
manually with `seedCluster()`/`seedNode()`, so they don't hit this path;
`startServer`-based tests get valid rows seeded, which existing manual seeds
either match or deliberately overwrite.)

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS. If an e2e test fails on cluster/node shape, it means it
asserted on the unseeded 404 or seeded AFTER `startServer` with a conflicting
shape — inspect before changing anything; per ADR-0016 the seed must lose to
explicit test seeds (they overwrite it), so a failure here is a real bug in
the wiring, not the test.

- [ ] **Step 4: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit (with rebuild trailer — this is the behavior-activating commit)**

```bash
git add src/api/server.ts
git commit -m "fix(api): self-seed cluster + node at startup — system.get works on fresh install (#32)

Requires-Rebuild: xinas_node_build, xinas_api

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`xinas_node_build` rebuilds `dist/` from the changed TS; `xinas_api` restarts
the service — same precedent as d13fe94.)

---

### Task 3: On-host verification criterion (manual, from phase0-requirements §5)

Not executable in this repo checkout — record for the next install loop:

- [ ] Fresh install → `curl --unix-socket /run/xinas/api.sock http://x/api/v1/system` returns 200 with `mode=single_node` and one node; MCP `system.get` no longer returns "cluster not initialized".
- [ ] `systemctl stop xinas-api && rm /var/lib/xinas/state/xinas.db* && systemctl start xinas-api` → same 200 (wiped-DB recovery, the ADR-0016 verify criterion).
