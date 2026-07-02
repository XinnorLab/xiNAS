# ADR-0016: Infrastructure bootstrap — xinas-api self-seeds Cluster + Node

- **Status:** accepted
- **Date:** 2026-07-02
- **Stream:** install-loop finding #32 (S8 follow-on; PR #236 documented, deferred)
- **Supersedes / amends:** fills the seeding gap ADR-0003 left open — the
  key layout defines `/xinas/v1/cluster` and `/xinas/v1/nodes/<node_id>`
  and says "Phase 0 sets mode=single_node", but names no component that
  writes the rows. Does NOT touch desired-state publishing
  (phase0-requirements §5, S12/ADR-0015 adoption).

## Context

The first real install of the api/agent stack (finding #28) surfaced that
the two infrastructure singletons are never created. Four facts, each
verified against the code:

1. **The api hard-fails without the rows.** `GET /system` throws
   `NOT_FOUND "cluster not initialized"` when `/xinas/v1/cluster` is
   absent and `NOT_FOUND "no node registered"` when no
   `/xinas/v1/nodes/` row exists (`api/routes/system.ts`); `GET
   /capabilities` needs only the Cluster row and fails the same way
   when it is absent. Catalog-generated MCP reads
   (`system.get` and everything gated on the singletons) surface these
   errors verbatim to clients.

2. **Nothing seeds them.** `openStateStore()` creates schema only, zero
   rows (`api/server.ts`). The `xinas_api` Ansible role writes the
   controller-id file and tokens but never touches the store; the
   `xinas_agent` role only templates config and starts the unit. The
   agent pushes observations to `/xinas/v1/observed/*` — a separate
   keyspace that works fine without the singletons.

3. **Tests mask the gap.** Every api test seeds both rows via
   `seedCluster()`/`seedNode()` (`__tests__/api/_helpers.ts`) before
   exercising routes, so the uninitialized path never ran until a real
   install.

4. **Everything needed to seed is already local to the api.** The api
   loads `controller_id` from config (persisted at
   `/var/lib/xinas/controller-id` by the `xinas_api` role — see
   `docs/Installer/xinas-api-role-spec.md` §6a; ADR-0001's table still
   names the legacy `/etc/xinas-mcp/config.json` location and is
   superseded on this point), knows its hostname, and owns
   `mcp.allow_apply` in its config. No fact required for the ADR-0003
   shapes lives anywhere else.

## Decision

**`xinas-api` seeds the infrastructure singletons at startup**, in
`startServer()` immediately after `openStateStore()` and before task
engines, heartbeat tracker, or listeners are built. A dedicated module
(`api/bootstrap.ts`, `seedInfrastructure(state, config)`) applies three
idempotent rules:

1. **Cluster — create if absent.** When `/xinas/v1/cluster` has no row,
   write the ADR-0003 Phase 0 singleton:

   ```jsonc
   {
     "kind": "Cluster",
     "id": "default",
     "spec": { "display_name": "<os.hostname()>" },
     "status": {
       "mode": "single_node",
       "capabilities": {
         "ha": "not_enabled",
         "quorum": "not_enabled",
         "witness": "not_enabled",
         "nfs.v3_locking_managed": false,
         "nfs.recovery_state_managed": false,
         "mcp.allow_apply": <config.mcp.allow_apply === true>
       },
       "member_node_ids": ["<config.controller_id>"]
     }
   }
   ```

2. **Node — create if absent.** When
   `/xinas/v1/nodes/<config.controller_id>` has no row, write:

   ```jsonc
   {
     "kind": "Node",
     "id": "<config.controller_id>",
     "spec": { "hostname": "<os.hostname()>" },
     "status": { "agent_state": "offline", "observation_age_seconds": 0 }
   }
   ```

   The stored flat `agent_state: "offline"` is a static cold default,
   not a live field: `GET /system` preserves it as-is and surfaces live
   heartbeat state under the separate `node.status.agent` sub-object
   (`api/routes/system.ts`; `routes-system-agent.test.ts` pins the
   coexistence). The seed must NOT attempt to keep the flat field
   current — nothing writes it after creation, so no writer race exists.

3. **Config-mirror refresh.** When the cluster row EXISTS but
   `status.capabilities["mcp.allow_apply"]` differs from the current
   config value, update that one field (read-modify-write of the row).
   The MCP dispatcher reads config directly, so the gate itself never
   goes stale — this keeps the *advertised* capability truthful for
   clients that plan UI around `/capabilities`. No other field of an
   existing row is ever touched: operator edits (e.g. `display_name`)
   survive restarts.

Startup order guarantees single-writer: the seed runs before any
listener binds, so no CAS/expected-revision handling is needed.

### Why the api and not the installer or the agent

- The rows must exist whenever the api serves — including after a state
  DB wipe/restore or a manual `xinas.db` deletion, when no Ansible run
  is in sight. Startup self-seed heals all of those for free.
- The seed derives entirely from facts the api already holds (fact 4);
  an installer seed would add HTTP choreography against the
  just-started service and break the role's hermetic "provision OS +
  services" posture.
- The agent is an observer/executor under ADR-0002's privilege model;
  cluster shape and membership are control-plane concerns it must not
  own.

## Alternatives considered

1. **`xinas_api` Ansible role PUTs the rows after starting the
   service.** Rejected: single-shot (dies with the DB), needs the api
   up + admin auth mid-role, non-hermetic, and leaves test/dev servers
   (started outside Ansible) uninitialized — the exact trap that hid
   this bug.

2. **Agent registers its node (and cluster) before first observation.**
   Rejected: privilege-model violation (ADR-0002); also leaves the api
   erroring until an agent connects, which is wrong for api-only
   deployments and for the window before the agent's first push.

3. **Lazy seed on first read (inside `GET /system`).** Rejected: hides
   a write inside read handlers (audit/metadata semantics get murky),
   and every gated route would need the same hook. Startup is one place
   and provably runs first.

## Consequences

- Fresh install: `GET /system` and `GET /capabilities` return 200 with
  `mode=single_node` immediately after `xinas-api.service` starts; MCP
  `system.get` works with the agent not yet up.
- `seedCluster()`/`seedNode()` remain in tests that want bespoke shapes,
  but a new test exercises the real path: build the app with NO manual
  seeding and assert the reads succeed; assert restart-over-existing-DB
  preserves a modified `display_name`; assert flipping
  `config.mcp.allow_apply` updates the advertised capability on next
  startup.
- `arrays.list` returning `[]` on a fresh box is NOT fixed here and is
  not a bug in this scope: desired-state population is
  phase0-requirements §5 / S12-adoption territory.
- Multi-node phases will replace rule 1 with explicit cluster
  formation; the create-if-absent seed stays valid for the first node
  and this ADR gets amended then.
