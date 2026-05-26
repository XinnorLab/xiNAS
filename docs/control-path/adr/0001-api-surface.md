# ADR-0001: Control API surface — promote xinas-mcp to xinas-api

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Sergey Platonov
- **Supersedes:** —
- **Related requirements:** [phase0-requirements.md](../phase0-requirements.md) §1, §12, §14, §17

## Context

The Phase 0 plan ([docs/plans/2026-05-26-phase0-control-path-plan.md](../../plans/2026-05-26-phase0-control-path-plan.md))
calls for a new `xinas-api` service exposing a typed REST API as the single
entry point for day-2 operations, with MCP demoted to a "Phase 0 MCP client of
the Control API."

The existing `xinas-mcp` server already provides most of what `xinas-api` is
meant to do:

| Capability                              | Where it lives today                                                  |
|----------------------------------------|-----------------------------------------------------------------------|
| gRPC client to `xiraid-server` (:6066) | [xiNAS-MCP/src/](../../../xiNAS-MCP/src/)                             |
| Unix-socket client of `xinas-nfs-helper` | [xiNAS-MCP/nfs-helper/](../../../xiNAS-MCP/nfs-helper/)              |
| 3-role RBAC (viewer/operator/admin)    | [xiNAS-MCP/src/middleware/rbac.ts](../../../xiNAS-MCP/src/middleware/rbac.ts) |
| Append-only audit log                  | `/var/log/xinas/mcp-audit.jsonl`                                      |
| `controller_id` persistence            | `/etc/xinas-mcp/config.json`                                          |
| Netplan rendering                      | [xiNAS-MCP/src/tools/network.ts](../../../xiNAS-MCP/src/tools/network.ts) |
| ~33 tools across 11 namespaces         | `xiNAS-MCP/src/tools/`                                                |
| Job/task model                         | `xiNAS-MCP/src/`                                                      |

Building a parallel Python `xinas-api` next to MCP duplicates roughly six
months of work for zero new functional capability in Phase 0. It also creates
two control planes during the transition, with a real risk that safety
policies diverge between them.

## Decision

The existing `xinas-mcp` codebase is renamed and refactored into
**`xinas-api`**. Its business logic becomes the shared **core**. Two
**transports** sit on top:

- **MCP transport** (stdio/SSE) — for agentic clients.
- **REST transport** (HTTP/JSON, `/api/v1/*`) — for the TUI, `xinasctl`, and
  automation.

Both transports invoke the same handlers. There is **one** implementation of
every safety check, every adapter call, every audit record, and every RBAC
decision.

### Component layout

```
xinas-api.service  (TypeScript, formerly xinas-mcp)
├── core/         RBAC, audit, locks, plan/apply, state, adapters
├── transports/
│   ├── mcp/      stdio/SSE — agentic clients
│   └── rest/     HTTP/JSON — /api/v1/* (TUI, xinasctl, automation)
└── adapters/    xiraid gRPC, nfs-helper socket, netplan, systemd
```

### Service rename

The systemd unit `xinas-mcp.service` is renamed to `xinas-api.service`.
Upgrade path:

1. Install `xinas-api.service` and mask `xinas-mcp.service`.
2. Migrate `/etc/xinas-mcp/config.json` → `/etc/xinas-api/config.json` with
   a symlink at the old path for one release.
3. Remove the masked unit in the following release.

### Principal mapping and transport policy

Existing MCP behavior gives stdio clients with no token the `admin` role
(see `xiNAS-MCP/src/mcpServer.ts` and `docs/MCP/spec-middleware.md`). That
behavior interacts with the "MCP is plan-only by default" requirement, so
Phase 0 must define how the transport gates interact with the principal's
role. The model is **principal × transport**, with the transport applying a
post-RBAC gate.

Principal sources are unchanged from current behavior; what is new is the
explicit per-transport apply gate.

| Principal source                                  | Default role                              | `apply` allowed in Phase 0?                                                                                  |
|---------------------------------------------------|-------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| REST + token                                      | as token says                             | Yes if role permits.                                                                                         |
| REST over loopback Unix socket, root peer creds   | `admin`                                   | Yes (operator log-in path; same as current sudo'd menu use).                                                 |
| CLI (`xinasctl`) via loopback Unix socket         | local Linux user mapped to a role         | Yes if role permits.                                                                                         |
| TUI (`xinas-menu`) via loopback Unix socket       | local Linux user mapped to a role         | Yes if role permits.                                                                                         |
| **MCP stdio, no token**                           | `local_admin` (preserves current default) | **No, unless `mcp.allow_apply: true`** in `/etc/xinas-api/config.json`. Read-only and plan-only otherwise.   |
| **MCP stdio + token**                             | as token says                             | **No, unless `mcp.allow_apply: true`**. Plan-only otherwise, regardless of token's role.                     |
| **MCP SSE / TCP**                                 | as token says                             | **No, unless `mcp.allow_apply: true`**.                                                                      |

Per [reqs §12](../phase0-requirements.md#12-mcp) and
[reqs §17](../phase0-requirements.md#17-explicit-non-goals-for-phase-0):

- The MCP transport applies an apply-gate **after** RBAC. A principal that
  would be allowed to apply via REST is still blocked from applying via
  MCP unless `mcp.allow_apply: true`.
- The MCP transport rejects mutating tool calls with `UNSUPPORTED`
  (`reason: mcp_apply_disabled`) when the gate is closed. Plan-only
  variants of the same tools remain available.
- Read-only diagnostic tools are always available subject to RBAC, on every
  transport.
- The same principal hitting the same handler via MCP and REST therefore
  produces **identical authorization for reads and plans**, and a
  **strictly narrower set of writes via MCP** unless the operator opts in.

This is enforced in the transport layer, not in the handlers, so the core
business logic does not need to know which transport called it.

### Single audit sink

The two existing audit sinks (`/var/log/xinas/audit.log` from the TUI and
`/var/log/xinas/mcp-audit.jsonl` from MCP) are consolidated to one canonical
log under `xinas-api`. The old paths are kept as symlinks for one release to
preserve existing support bundles.

## Consequences

### Pros

- **Zero divergence** between MCP and REST: one core can't disagree with
  itself.
- **Schema reuse**: existing tool input/output schemas, the gRPC stubs
  under `xiNAS-MCP/proto/`, the helper client, and the RBAC/audit
  middleware all survive intact and inform the REST contracts.
- **Single audit sink, single RBAC enforcement point** (reqs §14).
- **TUI's existing direct-gRPC-to-xiraid path** ([xinas_menu/api/grpc_client.py](../../../xinas_menu/api/grpc_client.py))
  has to be retargeted to the API regardless of language choice — this option
  has the smallest *server-side* delta.

### Migration scope after ADR-0002

This ADR was drafted before ADR-0002 locked the privilege boundary. With
ADR-0002 accepted, the migration is **not** a rename. The privileged
adapters that today live inline in API handlers — `xiNAS-MCP/src/tools/raid.ts`
calling the xiRAID gRPC client, `xiNAS-MCP/src/tools/share.ts` calling
`xinas-nfs-helper`, `xiNAS-MCP/src/tools/network.ts` running `netplan` —
all have to be **extracted out of the API process and moved behind the
agent RPC** before the REST transport can be exposed. Concretely:

1. Identify every site in `xiNAS-MCP/src/tools/*.ts` that calls a
   privileged adapter (xiRAID gRPC, `xinas-nfs-helper`, subprocess for
   `mount`/`umount`/`netplan`/`systemctl`).
2. Move those adapter calls into the agent process; replace the inline
   call sites with calls to the new agent RPC methods enumerated in
   ADR-0002.
3. Strip the API process of file-mutation, mount, and subprocess
   capabilities (handled by systemd hardening per ADR-0002).
4. Keep handler shape and tool schemas — that is the part this ADR was
   right to claim as low-cost.

The summary: **reuse schemas, planning logic, RBAC, audit, and the tool
catalog. Extract privileged adapters into agent RPC before exposing REST.**
This is still cheaper than a Python rewrite (option B), but it is not
free; it is a real refactor of the privileged sites listed above.

### Cons

- **TypeScript stays on the controller.** `xinas_menu`, `xinas_history`, and
  `xinas-nfs-helper` remain Python. The split is durable from now on.
- **TypeScript expertise required** for backend work going forward.
- **Existing token format and audit-log format must be migrated** rather than
  starting clean.

### What this ADR does NOT decide

- The internal core-to-transport API shape (function-call vs in-process RPC).
  Decided during implementation.
- The full canonical schema for the `NfsProfile` object (writable vs
  Phase-0-`UNSUPPORTED` fields, effective-config rendering targets).
  Tracked as **ADR-0005**.

Decisions that depended on this ADR and are now accepted:

- `xinas-agent` privilege model → [ADR-0002](0002-agent-privilege-model.md).
- State-store implementation → [ADR-0003](0003-state-store.md).
- Task engine persistence → [ADR-0004](0004-task-engine.md).

## Rejected alternatives

### Option B — Build Python `xinas-api`, MCP becomes a thin client

Rejected: roughly six months of duplicated work; two control planes during
the transition; real risk of MCP and API drifting on safety policy. The only
durable benefit (language consistency) is mostly a hiring/onboarding
argument — the TypeScript code is not going away regardless, since proto
stubs and MCP runtime stay version-controlled in `xiNAS-MCP/`.

### Option C — Python REST adapter forwards to TypeScript MCP via IPC

Rejected: extra hop, extra daemon, second failure domain, solves no real
problem. The TUI is Python; that does not require the server to be Python.

### Option D — Defer until an ADR is written

Not an alternative; this is that ADR.

## Implementation notes for downstream workstreams

- **WS0 (Architecture freeze)**: this ADR resolves the largest item in
  WS0.2's ADR list. The remaining ADRs there (state store, agent privilege
  model, task persistence) are now ADR-0002 and ADR-0003.
- **WS1 (API contracts)**: the OpenAPI v1 schema describes the REST
  transport. MCP tool definitions remain authoritative for the MCP
  transport and are kept in sync by codegen or convention.
- **WS12 (Client convergence)**: TUI retargeting to REST is unchanged in
  scope. MCP refactor is reduced to "expose the existing tools through the
  shared core" rather than "rewrite MCP as a REST client."
- **WS13 (Packaging)**: the unit rename `xinas-mcp.service` →
  `xinas-api.service` must be handled by the `xinas_mcp` (soon
  `xinas_api`) Ansible role with a `Requires-Rebuild: xinas_api` trailer
  per CLAUDE.md so the in-TUI updater re-runs the role on upgrade.
