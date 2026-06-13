# ADR-0010: MCP / CLI / TUI on the control-path core (S8, WS12)

**Status:** accepted (2026-06-12). Implements ADR-0001's locked "MCP is
a transport on the same Control API core" decision; extends ADR-0002
(no new privilege; the api stays unprivileged).

## Context

WS12's exit criterion: *same operation through CLI/TUI/MCP produces the
same plan and task; MCP cannot apply by default*
(phase0-sequencing.md §5). Requirement §12: MCP must not be an
independent executor, must preserve RBAC/audit/idempotency/plan-apply,
and the same principal via MCP or REST must produce identical
authorization and audit records. Verified facts this ADR is designed
against:

- The legacy `xinas-mcp` server registers **69 tools in 11 namespaces**
  (`src/registry/toolRegistry.ts`) over `@modelcontextprotocol/sdk`
  ^1.12, serving stdio + SSE + Streamable HTTP, and executes host
  changes **in-process** (xiRAID gRPC, nfs-helper UDS, `netplan`
  subprocess) — the exact privileged-adapter coupling ADR-0001
  §Migration requires extracting.
- The api's express middleware order is request-id → audit → json →
  auth; `authMiddleware` RESOLVES `ctx.role` but **nothing enforces it
  on public routes** (only `/internal` checks role) — a viewer token
  can hit mutating routes today (review P0). Idempotency lives in the
  task-engine apply txn, not middleware. `req.context` carries
  `client_type` (today the literal `'rest'`), which plan args and
  audit rows already thread through.
- The api listens on ONE listener (`config.listen`: unix | tcp) —
  `server.ts` has no simultaneous-listener support yet.
- **Role coupling (review P0):** `xinas_api` preflights on
  `dist/api-server.js` and instructs operators to run `xinas_mcp`
  first; `xinas_mcp` owns the Node build (`npm ci` + build) AND the
  `xinas-nfs-helper` install/restart. The legacy role cannot become a
  retirement shim until those responsibilities move.
- **Mode-less mutators exist (review P1):** `POST /support-bundle`
  internally plans+applies a task; `POST /tasks/{id}/cancel` mutates
  with no `mode` field. A gate inferring "apply" from `body.mode` would
  miss both.
- **Placeholder routes exist (review P1):** `audit.query` and
  `config-history` snapshots/show/diff/rollback return warning-stub
  envelopes (`CONFIG_HISTORY_NOT_INTEGRATED`); only `drift` is live.
- **The TUI's riskiest flow is composite (review P1):**
  `xinas_menu/screens/raid.py` delete orchestrates
  find-mounts → NFS share removal (with re-add rollback) → unmount →
  `raid_destroy(force)`; create/modify wizards call `pool_show`.
- Scope locks from the design round: S8 delivers **all three clients**
  (MCP + xinasctl + TUI retarget); uncovered legacy namespaces keep
  **read-only passthrough**; the legacy `xinas-mcp.service` is
  **replaced in S8**; tool names are **renamed to REST shapes**.

## Decision — architecture: in-process loopback dispatch

The MCP transport becomes `src/api/mcp/` **inside `xinas-api.service`**.
Every tool call is translated into an HTTP request against the api's
OWN express app over its UDS — same URL, same middleware spine — so
"same handler, identical audit records" holds by construction. There is
no second auth/RBAC/audit implementation anywhere.

Transports:

- **Streamable HTTP** at `/mcp` mounted on the api express app (served
  by every listener). The api gains an **optional additional TCP
  listener** (`config.mcp.http: { host, port }`) serving the same app —
  the existing demo endpoint re-points here. (This adds the
  multi-listener support `server.ts` lacks; the primary listener config
  is unchanged.)
- **stdio** via a `xinas-mcp-stdio` **SDK transport adapter** binary
  (review P2): a `StdioServerTransport` facing the spawning client,
  bridged to a `StreamableHTTPClientTransport` session against the api
  UDS `/mcp` endpoint — an SDK Client+Server pair with managed session
  lifecycle (~150–200 lines), NOT a byte proxy. Authenticated by UDS
  peer trust → ADR-0001's `local_admin`.
- SSE (legacy `/sse`) is dropped; Streamable HTTP supersedes it
  (ADR-0001 lists SSE as optional; the SDK marks it deprecated).

## Decision — REST RBAC enforcement (review P0 — S8 prerequisite)

S8 adds the missing role ENFORCEMENT before anything is retired: the
catalog (below) carries `min_role: 'viewer' | 'operator' | 'admin'`
per entry (ported from the legacy `TOOL_PERMISSIONS` matrix in
docs/MCP/spec-middleware.md — reads → viewer, share/task operations →
operator, RAID/filesystem/network mutation → admin), and a new
`rbacMiddleware` mounted after auth matches the request
(method + path pattern) against that SAME table and rejects
`PERMISSION_DENIED` when `ctx.role` ranks below `min_role`.
Internal routes keep `requireInternalAgent`; unmatched public routes
default to admin. One authorization table feeds REST and MCP alike —
retiring the legacy MCP RBAC without this would have REMOVED the only
role gate in the system.

## Decision — loopback auth (one spine, honest principals)

At boot the api mints an **ephemeral loopback token** (random,
in-memory only, never persisted). The MCP layer resolves the caller's
principal itself — HTTP bearer → `config.tokens`; stdio adapter →
`local_admin` — and forwards it on the loopback request via
`X-Xinas-Forwarded-Principal` / `X-Xinas-Forwarded-Role` /
`X-Xinas-Client-Type: mcp` headers. The auth middleware honors those
headers **only when the bearer equals the loopback token**; from any
other caller they are ignored (and audited as suspicious). Audit rows
therefore carry the REAL principal and `client_type: 'mcp'`; the
`client_type` union widens from `'rest'` to `'rest' | 'mcp'`.

**Single audit row per operation (review P1):** `auditMiddleware`
records every HTTP response, which would log the `/mcp` transport
frame AND the loopback `/api/v1` call. The audit middleware therefore
SKIPS the `/mcp` path — the transport frame is not an operation; the
loopback row (real principal, `client_type: 'mcp'`) is THE audit
record. The parity test asserts exactly one row per tool call.

## Decision — the apply gate (catalog-metadata-driven, review P1)

The gate lives **in the MCP dispatch layer**, where the tool's catalog
entry is known — REST is never gated, and nothing infers intent from
request bodies. Each catalog entry declares:

```ts
mutability: 'read' | 'plan_apply' | 'direct';
requires_mcp_apply: boolean;   // explicit per entry, no inference
```

Gate logic: `read` → always allowed. `plan_apply` with `mode: 'plan'` →
always allowed. `mode: 'apply'` → allowed only when
`config.mcp.allow_apply === true` (default **false**), else
`MCP_APPLY_DISABLED` naming the config key. `direct` entries follow
their explicit flag:

| entry | mutability | requires_mcp_apply | rationale |
|---|---|---|---|
| `support.bundle` | direct | false | read-style diagnostic (non-disruptive, lease-serialized, redacted) — §12's "read-only diagnostics" intent |
| `tasks.cancel` | direct | false | an emergency stop cannot apply new state; blocking it would make MCP *less* safe |
| every other mutator | plan_apply | true (apply mode) | the exit criterion |

## Decision — one declarative catalog → MCP tools AND CLI commands

`src/api/mcp/catalog.ts`: one table of
`{ name, description, method, path, input_schema, mutability,
requires_mcp_apply, min_role, status }`. REST-shaped names (scope lock):
`arrays.list/get/create/modify/delete/import`, `disks.list/get`,
`filesystems.*`, `shares.*`, `nfs_profiles.*`, `nfs_sessions.list`,
`network.interfaces.list/get/update`, `network.pool.apply`,
`health.check`, `drift.report`, `config_history.*`,
`tasks.get/list/cancel`, `support.bundle`, `system.*`, `audit.query`.
The MCP tools/list, the MCP call dispatcher, and `xinasctl`'s command
tree are ALL generated from this table — parity across clients is
structural.

**Coverage honesty (review P1):** entries carry
`status: 'live' | 'degraded'`. `audit.query` and
`config_history.snapshots/show/diff/rollback` ship `degraded`: present
in the tree, descriptions state the limitation, and the envelope's
`CONFIG_HISTORY_NOT_INTEGRATED` warning passes through to the MCP
result verbatim. `drift.report` is live (S7).

## Decision — read-route promotion (review P1; supersedes "passthrough")

The carried read-only legacy handlers do NOT live beside the catalog
as a special `legacy/` layer — that would be a second, unaudited path.
Instead they become REAL additive `/api/v1` read routes, so every tool
is an ordinary catalog entry traversing the full spine:

| new route | handler (carried legacy code) | note |
|---|---|---|
| `GET /system/logs` | `journalctl` subprocess | needs the `systemd-journal` supplementary group (below) |
| `GET /system/performance` | Prometheus HTTP read | unprivileged |
| `GET /quotas` | `repquota -a` subprocess | best-effort: degrades with a clear error when unprivileged |
| `GET /pools` | read-only localhost xiRAID gRPC | **deprecated-until-agent-coverage** — the one explicitly-marked exception to the adapter extraction; read-only, removed when pools observe via the agent |
| `GET /mail/settings`, `GET /mail/recipients` | read-only xiRAID gRPC | ~~same deprecation marker~~ → **blessed as a permanent live read-through (ADR-0014)** — not promoted to observed |
| `GET /auth/modes` | static + gRPC read | ~~same~~ → **blessed as a permanent live read-through (ADR-0014)** |

`auth.list_users` maps to the EXISTING `/users`; `disks.get_smart`
maps to the existing `GET /disks/{id}` (`status.health` — the S7
field), degrading with a note when the health block is absent;
`share.get_active_sessions` is replaced by `nfs_sessions.list`. Every
other uncovered tool (all mutating auth/mail tools, pool mutators,
`disk.secure_erase/set_led/run_selftest`) returns `NOT_IMPLEMENTED`
naming the replacement or "returns in a later phase".

## Decision — xinasctl

A TS binary in xiNAS-MCP (`bin/xinasctl` → `dist/xinasctl.js`, plain
argv parsing, no new dependencies). Command tree generated from the
catalog: `xinasctl <resource> <verb> [--json] [-f spec.json]
[--plan|--apply] [--wait]`; `--wait` polls the task to terminal and
prints stage progress. Defaults to the api UDS (peer trust — root or
the `xinas-admin` group); `--url` + `--token`/`XINAS_TOKEN` for TCP.
The CLI is a plain REST client: `client_type` stays `'rest'`, no MCP
gate applies.

## Decision — TUI retarget (review P1 scope correction)

New `xinas_menu/api/control_client.py`: stdlib `http.client` over the
api UDS (no new Python deps), envelope parsing, and a
`plan_apply_wait()` helper (plan → apply → poll task, surfacing stage
progress). Retargeted call sites:

- `screens/raid.py` — arrays **list/create/modify/delete**, including
  the composite delete teardown re-expressed as a SEQUENCE of API
  operations: shares delete (plan/apply) → filesystem unmount/unmanage
  (plan/apply) → arrays delete (plan/apply), driven from the existing
  teardown progress view. A step failure STOPS the sequence — each step
  is independently audited with task-level rollback inside it; there is
  no cross-step auto-rollback (same best-effort semantics the screen
  has today). Pool lookups inside the create/modify wizards keep
  `grpc.pool_show` (consistent with pool passthrough).
- `screens/filesystem.py` (review P0) — create (`mkfs.xfs` via
  `xfs_helpers`), mount, and the findmnt/NFS/unmount delete flow all
  retarget to `/filesystems` plan/apply (+ `/shares` for the delete's
  export cleanup); the direct XFS/systemd helper calls are removed
  from the screen.
- `screens/nfs.py` + `screens/configure/nfs_config.py` — shares CRUD
  via `/shares`.
- `screens/network.py` + `screens/configure/network_config.py` — the
  direct `netplan apply|try` subprocess calls are REMOVED in favor of
  `PATCH /network/interfaces/{id}` / `network.pool.apply` — this
  deletes the TUI's last direct-root mutation path for networking.
- `screens/configure/raid_config.py` — the create wizard plans/applies
  via the API.

`grpc_client.py` / `nfs_client.py` remain ONLY for pool screens and
wizard pool lookups.

## Decision — deployment and retirement (review P0)

Role decomposition lands BEFORE retirement:

1. **`xinas_node_build`** (new): repo clone/refresh + `npm ci` +
   `npm run build` — produces the `dist/` artifacts `xinas_api`
   preflights on (its failure message repoints here).
2. **`xinas_nfs_helper`** (new): helper file copy + systemd unit +
   enable/restart, extracted from `xinas_mcp`.
3. **`xinas_mcp`** (shrunk to the true shim): stop + disable the legacy
   `xinas-mcp.service`, write the demo/client endpoint config pointing
   at the new `/mcp`. Token migration from `/etc/xinas-mcp/config.json`
   into the api token store is a documented operator step.

`site.yml` order: `xinas_node_build → xinas_nfs_helper → xinas_api →
xinas_agent → xinas_mcp`. The `xinas_api` unit and role gain
`SupplementaryGroups=xinas-api systemd-journal` (unit template + role
task — review P2); `system.get_logs` degrades with a clear error on
hosts not yet rebuilt. The role-decomposition commit carries
`Requires-Rebuild: all` (provisioning boundaries move); later S8
commits carry the specific tags (`xinas_api`, `xinas_mcp`,
`xinas_menu`).

## Security

- The api gains NO privilege: every mutator still flows
  plan → apply → task → agent. The only adapter exception is the
  read-only localhost gRPC client (explicitly deprecated above).
- The loopback token never leaves the process; forwarded-principal
  headers from any other bearer are ignored and logged.
- The MCP TCP listener serves the same RBAC'd app; an unknown bearer is
  401 exactly as on REST. `mcp.allow_apply` defaults to false — the
  Phase 0 exit criterion is the default posture.

## Testing

Unit: catalog→request translation; the gate matrix (read/plan/apply ×
allow_apply × direct flags); loopback auth (forwarded headers rejected
without the token). Integration: a real MCP SDK client against the
in-process Streamable HTTP endpoint. e2e (fixture harness): the
**parity scenario** — the same share create via REST, MCP, and
`xinasctl` produces the same `plan_hash`; MCP apply → 403 by default;
`allow_apply: true` → full plan/apply/task success via MCP; audit rows
show the same principal with `client_type` rest vs mcp. Python: pytest
for `control_client.py` against a stub HTTP server.

## Deferred

TUI pool screens (no API surface), SSE transport, audit/config-history
backend integration (the degraded entries go live when the bridges
land), removal of the read-only gRPC passthrough (tracked to the
API gaining pools/mail/auth-settings resources), MCP resource/prompt
capabilities (tools only in Phase 0).
