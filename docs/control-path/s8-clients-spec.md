# xiNAS S8 — MCP / CLI / TUI clients on the control-path core (design spec)

**Status:** design (2026-06-12; conforms to **ADR-0010**). Closes WS12
("same operation through CLI/TUI/MCP produces the same plan and task;
MCP cannot apply by default"). Implementation plan:
`docs/plans/2026-06-12-s8-clients-plan.md`.

**Goal.** The MCP transport rehosts inside `xinas-api.service` as a
loopback dispatcher over the api's own middleware spine; `xinasctl`
and the Python TUI become plain REST clients of the same routes; the
legacy `xinas-mcp.service` is retired. MCP apply is blocked by default
(`mcp.allow_apply: false`).

**Verified integration facts (truth-checked this round).**

- `xinas_api` preflights on `dist/api-server.js` and names `xinas_mcp`
  as the producer (`collection/roles/xinas_api/tasks/main.yml:5`);
  `xinas_mcp` owns `npm ci`/build AND the `xinas-nfs-helper`
  install/restart (`collection/roles/xinas_mcp/tasks/main.yml:70,97,127`)
  → role decomposition (T-A0) must precede retirement.
- `POST /support-bundle` plans+applies internally; `POST
  /tasks/{id}/cancel` mutates with no `mode` → the gate is
  catalog-metadata-driven, never body-inferred.
- `audit-query.ts` and the config-history snapshots/show/diff/rollback
  routes return warning-stub envelopes → those catalog entries ship
  `status: 'degraded'` with the warning passed through.
- `screens/raid.py` delete is a composite teardown (find-mounts → NFS
  share removal with re-add rollback → unmount → `raid_destroy
  force`); create/modify wizards call `pool_show` → the retarget maps
  the composite to an API-operation SEQUENCE and keeps gRPC only for
  pool lookups.
- The api has ONE listener today (`config.listen`: unix | tcp) — S8
  adds the optional `mcp.http` TCP listener serving the same app.
- `req.context.client_type` is the literal `'rest'` and already
  threads into plan args and audit rows → widen to `'rest' | 'mcp'`.
- **The api has NO role enforcement on public routes (review P0):**
  middleware order is request-id → audit → json → auth; auth resolves
  `ctx.role` but only `/internal` checks it. T2 adds `rbacMiddleware`
  BEFORE any retirement — otherwise retiring the legacy MCP RBAC
  removes the only role gate in the system.
- **`auditMiddleware` logs every HTTP response (review P1):** without
  a skip rule, one MCP tool call would produce TWO rows (the `/mcp`
  frame and the loopback `/api/v1` call). The middleware skips `/mcp`;
  the loopback row is the audit record.
- **`screens/filesystem.py` mutates directly (review P0):** create
  runs `mkfs.xfs` via `xfs_helpers`, delete walks findmnt → NFS helper
  → unmount helpers — in scope for the retarget (T13b).
- Legacy MCP: `@modelcontextprotocol/sdk` ^1.12; stdio + SSE +
  Streamable HTTP; RBAC `TOOL_PERMISSIONS` map + `checkPermission`;
  hash-chained audit at `/var/log/xinas/mcp-audit.jsonl` (retired with
  the service — the api's audit chain is the survivor).

---

## 1. Scope

### In scope — S8a: MCP transport (T0–T6)

- **T0 contracts:** this spec + ADR-0010; api-v1.yaml description note
  on the MCP gate; `client_type` union widening.
- **T1 role decomposition (review P0):** new `xinas_node_build` and
  `xinas_nfs_helper` roles extracted from `xinas_mcp`; `xinas_api`
  preflight message repointed; `site.yml` order
  `xinas_node_build → xinas_nfs_helper → xinas_api → xinas_agent →
  xinas_mcp`. `Requires-Rebuild: all` (role boundaries move).
- **T2 REST RBAC enforcement (review P0):** `rbacMiddleware` after
  auth — matches method+path against the catalog's `min_role` (ported
  from the legacy TOOL_PERMISSIONS matrix: reads → viewer,
  share/task ops → operator, RAID/fs/network mutation → admin),
  rejects `PERMISSION_DENIED` below rank; unmatched public routes
  default admin. Tested: viewer token vs mutating route → 403 (today
  it succeeds).
- **T2b loopback auth:** ephemeral loopback token minted at boot;
  auth middleware honors `X-Xinas-Forwarded-Principal/Role` +
  `X-Xinas-Client-Type` ONLY under that bearer; forwarded headers from
  any other caller ignored + warn-logged. `auditMiddleware` gains the
  `/mcp` skip rule (single row per operation).
- **T3 catalog:** `src/api/mcp/catalog.ts` — the declarative table
  (§3); unit tests pin every entry's `{method, path, mutability,
  requires_mcp_apply, status}`.
- **T4 read-route promotion (review P1):** the carried legacy read
  handlers become REAL additive `/api/v1` routes — `GET /system/logs`,
  `GET /system/performance`, `GET /quotas`, `GET /pools`,
  `GET /mail/settings`, `GET /mail/recipients`, `GET /auth/modes`
  (api-v1.yaml additions; the gRPC-backed ones carry the
  deprecated-until-agent-coverage marker). No `legacy/` layer exists.
- **T4b dispatcher + gate:** tool call → catalog lookup → gate (§4) →
  loopback HTTP request → envelope → MCP result (warnings passed
  through).
- **T5 transports:** `/mcp` Streamable HTTP endpoint on the express
  app; optional `config.mcp.http` TCP listener (multi-listener support
  in `server.ts`); the `xinas-mcp-stdio` SDK transport adapter binary.
  When the adapter cannot reach the api socket it returns a `-32603`
  JSON-RPC error whose message names the socket path and the raw errno,
  and — for `EACCES`/`ENOENT`/`ECONNREFUSED` — appends an actionable
  hint (join `xinas-admin` + re-login, or check
  `systemctl status xinas-api`). An `EACCES` from a non-root operator is
  finding N4's "socket is 0660 root:xinas-admin, caller isn't a member"
  case; the hint names the `usermod -aG xinas-admin` fix.
- **T6 MCP integration tests:** real SDK client against the in-process
  endpoint; gate matrix; RBAC parity (same token via REST and MCP →
  same authorization outcome + audit principal).

### In scope — S8b: xinasctl (T7–T9)

- **T7:** argv parser + UDS/TCP client + envelope rendering
  (`--json` and human tables).
- **T8:** command tree generated from the catalog; `--plan/--apply`,
  `-f spec.json`, `--wait` task polling with stage progress.
- **T9:** e2e: xinasctl against the fixture-harness api (list, plan,
  apply, wait; UDS peer trust + token paths).

### In scope — S8c: TUI + retirement + parity (T10–T15)

- **T10:** `xinas_menu/api/control_client.py` (stdlib HTTP-over-UDS,
  envelope parsing, `plan_apply_wait()`); pytest against a stub server.
  `ApiError` also carries the first error's `details` dict and exposes
  `reason` / `holder_task_id`, so screens can distinguish a transient
  lock from a hard failure.
- **T11:** shares/NFS screens retarget (`nfs.py`, `configure/
  nfs_config.py`).

**Lock-conflict UX.** A mutating apply can return `CONFLICT` with
`details.reason == "lease_held"` when another task holds the resource's
lease (the periodic lease sweep, S2 §9, bounds how long this can persist
after a leak; a live in-flight op on the same resource is the normal
case). Share/NFS screens map that specific error to a friendly,
non-alarming dialog — "temporarily locked by another operation
(task `<holder_task_id>`); wait a few seconds and try again" — instead of
the raw `Failed: CONFLICT: resource is locked by another task`. All other
`ControlPathError`s keep the existing `Failed: <exc>` rendering.

**Task-failure detail.** `plan_apply_wait` polls `GET /tasks/{id}`; when
the terminal state is non-success it raises `TaskFailed` carrying, besides
`task_id` / `state` / `error_code`, an `error_message` with the best
human-readable cause from the final task record: the task row's
`error_message` when set (the `FAILED_BEFORE_CHANGE` /
`FAILED_MANUAL_RECOVERY_REQUIRED` terminals), else the first failed
non-rollback stage's `error_message` (the stage-failure path — a
`FAILED_PARTIAL_ROLLED_BACK` terminal carries no task-level message,
s2-task-envelope-spec §6), else a failed rollback stage's message. The
stage name is prefixed when the message doesn't already start with it
(`preflight: …`). `str(exc)` includes the detail —
`task <id> ended failed (FAILED_PARTIAL_ROLLED_BACK): preflight: /mnt/data
is already a live mountpoint` — so every screen that renders
`Failed: <exc>` shows the cause without code changes. `TaskCancelled`
carries the same field (usually empty — a cancelled terminal has no
error).
- **T12:** network screens retarget — `netplan apply|try` subprocess
  calls REMOVED in favor of the API (`network.py`,
  `configure/network_config.py`). *(Follow-up, post-S11: `screens/
  ip_pool.py` — the IP-pool allocator — was the one direct-netplan day-2
  consumer T12 left behind, deferred in the S9 spec. It now plan/applies
  `POST /api/v1/network/ip-pool` (`net.pool.apply`, ADR-0008) and does no
  interface detection, allocation, netplan rendering, PBR flushing, or
  `netplan apply` of its own; `/etc/xinas/network-pool.json` survives only
  as a dialog prefill cache. This closes the last direct-netplan day-2
  path.)*
- **T13:** RAID screens retarget — list/create/**modify**/delete incl.
  the composite teardown as an API sequence (§6); wizard pool lookups
  stay on gRPC.
- **T13b:** filesystem screens retarget (review P0) —
  `screens/filesystem.py` create/mount/delete onto `/filesystems`
  plan/apply (+ `/shares` for delete-time export cleanup); the direct
  `xfs_helpers`/findmnt/unmount calls leave the screen.
- **T14:** retirement — `xinas_mcp` role shrinks to the shim
  (stop/disable legacy service, endpoint config, token-migration doc);
  legacy server code under `src/server/`, `src/registry/`,
  `src/tools/` (minus carried read-only handlers) deleted.
- **T15:** parity e2e + full gate + runbook §5b (on-node MCP/CLI/TUI
  checks).

### Out of scope (ADR-0010 deferrals)

TUI pool screens, SSE, audit/config-history backends, removing the
read-only gRPC passthrough, MCP resources/prompts.

---

## 2. Component map

```
 MCP client (HTTP)──┐                ┌──────────── xinas-api.service ────────────┐
 MCP client (stdio)─┤ xinas-mcp-     │ /mcp StreamableHTTP ── src/api/mcp/       │
                    │ stdio adapter ─┤   dispatcher: catalog lookup → GATE →     │
                    └────────────────│   loopback HTTP (ephemeral token,         │
 xinasctl ──────── REST (UDS/TCP) ──│   forwarded principal, client_type=mcp)   │
 TUI control_client.py ── REST UDS ─│ express spine: auth→rbac→audit→routes     │
                                    │ promoted read routes (logs/perf/pools/…)  │
                                    └──────────────┬─────────────────────────────┘
                                                   │ plan/apply tasks (unchanged)
                                                   ▼
                                            xinas-agent.service
```

## 3. Catalog (T3)

```ts
interface CatalogEntry {
  name: string;                       // REST-shaped: 'arrays.create'
  description: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;                       // '/api/v1/arrays/{id}'
  input_schema: JsonSchema;           // path params + query + body
  mutability: 'read' | 'plan_apply' | 'direct';
  requires_mcp_apply: boolean;        // explicit; no inference
  min_role: 'viewer' | 'operator' | 'admin';  // REST rbacMiddleware + MCP share it
  status: 'live' | 'degraded';
}
```

Namespaces (≈40 entries): `arrays.*` (list/get/create/modify/delete/
import), `disks.*` (list/get), `filesystems.*` (list/get/create/
update/delete), `shares.*` (list/get/create/update/delete),
`nfs_profiles.*` (list/get/update), `nfs_sessions.list`,
`nfs_idmap.get/set`, `network.interfaces.*` (list/get/update),
`network.pool.apply`, `health.check`, `drift.report`,
`config_history.*` (snapshots/show/diff/drift/rollback — snapshots/
show/diff/rollback **degraded**), `tasks.*` (list/get/cancel),
`support.bundle` (create + download pointer), `system.*` (get/
capabilities/inventory), `audit.query` (**degraded**), `users.list`,
`groups.list`.

Generation invariant: the MCP tools/list, the call dispatcher, AND the
xinasctl command tree derive from this one table — a new route reaches
all three clients by adding one entry.

## 4. The gate (T4)

In the MCP dispatch layer (REST untouched):

| entry mutability | request | verdict |
|---|---|---|
| read | any | allow |
| plan_apply | `mode: 'plan'` | allow |
| plan_apply | `mode: 'apply'` | `config.mcp.allow_apply ? allow : MCP_APPLY_DISABLED` |
| direct | — | `requires_mcp_apply ? gate : allow` |

Locked direct entries: `support.bundle` (allow — read-style
diagnostic), `tasks.cancel` (allow — emergency stop cannot apply new
state). `MCP_APPLY_DISABLED` is a structured tool error naming
`mcp.allow_apply` and the REST/CLI alternative.

## 5. Read-route promotion (T4)

Per ADR-0010 §read-route promotion: the carried legacy reads are
ordinary API routes (§1 T4 list), so the corresponding tools
(`system.get_logs`, `system.get_performance`, `quotas.list`,
`pools.list`, `mail.settings`, `mail.recipients`, `auth.modes`) are
ordinary catalog entries — full spine, one audit chain, RBAC by
`min_role`. `users.list` and `disks.get` (with `status.health`) cover
the old `auth.list_users` / `disk.get_smart`. Everything else
uncovered → `NOT_IMPLEMENTED` + replacement pointer.

### 5.1 Observed-read degraded honesty

The first-class observed-read **list** routes — `GET /api/v1/arrays`,
`/disks`, `/filesystems` — are pure reads of the observed-state store
(`/xinas/v1/observed/<Kind>/`). When the backing collector has errored, no
rows are flushed and the route returns `[]` with HTTP 200. Silent, that is
indistinguishable from "genuinely none" and lets a stale/unreachable backend
read as an empty inventory (the PR #243 class of confusion).

So each of these three routes attaches a `DEGRADED_BACKEND_UNAVAILABLE`
warning to its envelope when its backing collector is errored, while leaving
the `result` list unchanged (it may be empty or stale):

| Route | Collector kind |
|---|---|
| `GET /api/v1/arrays` | `XiraidArray` |
| `GET /api/v1/disks` | `Disk` |
| `GET /api/v1/filesystems` | `Filesystem` |

The signal is the captured per-collector health map
(`HeartbeatTracker.currentSnapshot().collectors[kind]`, the same map the node
already degrades on via `#hasCollectorError`): a value beginning `error`
degrades; `running` and `stubbed` do not. `DEGRADED_BACKEND_UNAVAILABLE` is the SAME code the
promoted legacy reads already emit (§5), so consumers see one honesty
convention. The warning propagates unchanged to MCP results and `xinasctl`
(§1 T4), and clients render it (the TUI degraded banner — Storage specs).
Additive only: `warnings[]` is already in every envelope, so `api-v1.yaml`
does not change.

## 6. TUI composite teardown (T13)

`raid.py` delete becomes, in the existing teardown progress view:

1. for each affected share: `shares.delete` plan → apply → wait;
2. for each affected filesystem: unmount/unmanage plan → apply → wait;
3. `arrays.delete` plan → apply (dangerous gate satisfied by the
   confirm dialog) → wait.

A step failure STOPS the sequence with the task error surfaced; no
cross-step auto-rollback (today's semantics; each step has task-level
rollback inside it). The progress view renders task stage events.

**Id path-segment encoding.** A Share id mirrors `encExportId(path)` —
the exported directory minus its leading slash (`/mnt/data` →
`mnt/data`) — so it can contain internal `/`. Every client that
addresses a resource by id (`DELETE /shares/{id}`, `PATCH
/filesystems/{id}`, `DELETE /arrays/{id}`, `PATCH /pools/{id}`, …) MUST
percent-encode the id as a single path segment (`mnt/data` →
`mnt%2Fdata`); the api's routes match a single non-slash segment and 404
with `NOT_FOUND: no such API route` on a raw slash. The TUI does this via
`control_client.quote_id()` (a no-op for slash-free UUID / mount-unit /
array / pool ids). Regression: the un-encoded form aborted the whole
"Delete Array" teardown on step 1.

## 6b. Break-glass control-plane restart (TUI, post-S8)

The MCP Server screen (`xinas_menu/screens/mcp.py`, reached via
Integrations → MCP Server) offers a single **break-glass** action to
restart the two control-plane daemons — `xinas-api` and `xinas-agent`.

- **Menu item:** `[R] Restart Control-Plane (api+agent)` (letter key —
  the numbered slots are full). It sits above `Back`.
- **Order matters.** `xinas-agent` declares `Requires=`/`After=
  xinas-api`, so restarting `xinas-api` alone stops the agent (Requires
  propagates the stop) and nothing pulls it back up. The action restarts
  **`xinas-api` first, then `xinas-agent`**, so the agent rebinds to a
  healthy api. The ordering is enforced by the pure helper
  `_restart_control_plane(restart_fn)` (dependency-ordered restart tuple
  `_CONTROL_PLANE_SERVICES = ("xinas-api", "xinas-agent")`), which is
  unit-tested independent of the Textual worker.
- **Guarded, not routine.** A `ConfirmDialog` states that the restart
  briefly interrupts the REST/MCP API, disconnects active remote MCP/API
  sessions (including the TUI's own `control_client` UDS connection), and
  may interrupt in-flight operations — "use only to recover a hung
  daemon." systemd already recovers both units on failure
  (`Restart=on-failure`), so this is a manual recovery lever, not a
  day-2 button.
- **No bare stop.** The action only ever *restarts*; it never stops or
  disables either daemon, and never targets `xinas-agent` in isolation.
- **Audit.** Emits `mcp.control_plane_restart` with target
  `xinas-api,xinas-agent` and result `OK`/`FAILED`; per-service results
  are rendered in the content pane.

## 6c. TUI MCP Server screen — transport + token config (post-retirement)

The Python TUI's **MCP Server** screen (`xinas_menu/screens/mcp.py`:
`MCPScreen`, `RemoteAccessScreen`, `TokenManagementScreen`) predates
retirement (T14) and still spoke to the standalone `xinas-mcp` daemon —
it restarted `xinas-mcp` after every write and read/wrote MCP settings
from `/etc/xinas-mcp/config.json` in the legacy shape (`http_enabled`,
`http_port`, `tls`, `tokens: {token: role}`, `token_labels`). None of
that exists post-S8. This section is the live contract for what the
screen manages now.

**Config surface.** MCP transport + bearer tokens live in the api
config, `/etc/xinas-api/config.json` (schema: `src/api/config.ts`,
`ApiConfig`; env override `XINAS_API_CONFIG`). Until a runtime auth API
lands (ADR-0010 §deferred; the `xinas_api` role README documents manual
rotation as the Phase-0 mechanism), the screen edits that file **in
place** as a bridge. Writes MUST:

- preserve the file's existing mode + owner — Ansible templates it
  `0640 root:xinas-admin` so the unprivileged `xinas-api` user keeps
  read access; a naive `0600 root:root` rewrite would lock the service
  out of its own config;
- preserve every unrelated key (`controller_id`, `listen`, `state`,
  `agent`, `internalTokensPath`, `tasks`, `seed`) untouched — the screen
  only ever mutates `mcp.*` and `tokens`;
- restart `xinas-api` (not the retired `xinas-mcp`), because
  `loadConfig()` reads the file once at boot (no hot reload).

If `/etc/xinas-api/config.json` is absent, the screen shows a clear
"xinas-api config not found" state and offers no edits — it never
writes a partial config that would break the service on next start.

The TUI's OWN local settings (`email`, `healthcheck_schedule`,
`retention`, menu polling) stay in `/etc/xinas-mcp/config.json` via
`xinas_menu/utils/config.py` — that file is the TUI settings store, not
the retired daemon's config, and is untouched by this reconciliation.

**Schema mapping.** The screen adapts between its view model and
`ApiConfig` via pure, unit-tested helpers in
`xinas_menu/utils/api_config.py`:

| screen concept | legacy key (removed) | api-config location |
|---|---|---|
| HTTP transport enabled | `http_enabled: bool` | presence of `mcp.http` |
| listener host/port | `http_port: int` | `mcp.http: {host, port}` |
| allow MCP apply | — | `mcp.allow_apply: bool` (default false) |
| token → role | `tokens: {token: role}` | `tokens: {token: {principal, role}}` |
| token label | `token_labels: {token: name}` | the token's `principal` string |
| TLS | `tls: {cert, key, ca}` | **not supported** — removed |

- **Enable/disable HTTP** = set / delete `mcp.http` (`{host, port}`;
  host defaults `0.0.0.0`, port `8080`). Deleting `mcp.http` prunes an
  otherwise-empty `mcp` object but keeps `mcp.allow_apply` if set.
- **Tokens.** A new token is `secrets.token_hex(32)` mapped to
  `{principal: <operator-entered name>, role: <viewer|operator|admin>}`.
  `principal` carries the human label (there is no separate label map).
  Assignable roles are `viewer|operator|admin`; `local_admin` (UDS peer
  trust) and `internal_agent` (agent bearer, kept in the separate
  `internalTokensPath` file so never in this map) are never
  hand-assigned. The bootstrap token (`principal == "admin:bootstrap"`,
  mirrored to `/etc/xinas-api/admin-token`) is **protected**: shown but
  not removable from the TUI, so an operator cannot lock themselves out.
- **allow_apply.** A toggle flips `mcp.allow_apply`. Default false ⇒
  remote MCP is plan/read-only (the WS12 exit posture, ADR-0010 §gate,
  §4 above); enabling warns that remote MCP clients may then mutate host
  state.
- **TLS is dropped.** `ApiConfig` has no TLS field (`mcp.http` and the
  tcp `ListenSpec` are `{host, port}` only); the connection command
  shows `http://…/mcp`. TLS, if required, is terminated by a front proxy
  outside the api's config model.
- **Redaction.** "View MCP Config" renders the api config with token
  keys masked (principal + role kept), so bearer values are not dumped
  to the panel.

**Local stdio registration.** The install ships
`/usr/local/bin/xinas-mcp-stdio` (the SDK transport adapter, §1 T5 /
ADR-0010); there is no `xinas-mcp` binary. The screen's Claude Code
registration hint uses `… -- ssh -T root@<ip> xinas-mcp-stdio`.

## 7. e2e parity scenarios (T15)

1. **Same plan everywhere:** one share spec via REST, MCP tool call,
   and `xinasctl shares create --plan` → identical `plan_hash`.
2. **Exit criterion:** MCP `shares.create mode=apply` → 403
   `MCP_APPLY_DISABLED` by default; REST/CLI apply succeeds; with
   `mcp.allow_apply: true` the same MCP call runs plan→apply→task to
   success.
3. **Audit parity:** the REST and MCP rows for the same principal
   differ only in `client_type`, and one MCP tool call produces
   exactly ONE audit row (the `/mcp` frame is skipped).
3b. **RBAC parity:** a viewer token hitting a mutating route → 403
   via REST AND the same tool via MCP → PERMISSION_DENIED (today the
   REST call would succeed — T2's regression pin).
4. **Direct entries:** `support.bundle` + `tasks.cancel` allowed via
   MCP under the default gate.
5. **Degraded honesty:** `config_history.snapshots` via MCP returns the
   stub result WITH the `CONFIG_HISTORY_NOT_INTEGRATED` warning.
6. **stdio adapter:** spawn `xinas-mcp-stdio` against the harness api;
   tools/list + a read call succeed under UDS peer trust.

## 8. Risks

- **Multi-listener regression** (the new MCP TCP listener): mitigated
  by keeping the primary listener path untouched and testing both.
- **Loopback latency** on chatty MCP sessions: acceptable (UDS,
  in-process); revisit only if profiling demands.
- **TUI behavioral drift** in the composite teardown: the API path
  enforces blockers the old flow bypassed with `force=True` — surfaced
  to the user as plan blockers instead of silent force; documented in
  the screen.
- **Demo continuity:** the endpoint moves to the api's `/mcp`; the
  `xinas_mcp` shim writes the new client config and the runbook gains
  the re-point step.
