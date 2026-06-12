# S8 Clients (MCP/CLI/TUI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WS12 exit — the MCP transport rehosts inside `xinas-api.service` as a loopback dispatcher; `xinasctl` and the Python TUI become REST clients of the same routes; legacy `xinas-mcp.service` retires; MCP cannot apply by default. Contract: ADR-0010 + `docs/control-path/s8-clients-spec.md` (review locks: REST RBAC prerequisite, read-route promotion, audit `/mcp` skip, filesystem.py in scope, role decomposition before retirement).

**Tech stack:** TS (xiNAS-MCP, vitest, @modelcontextprotocol/sdk ^1.12), Python (xinas_menu Textual + pytest), Ansible.

**Conventions (every task):** TDD; `.js` ESM suffixes; conditional spreads; per-task HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; gate per task = named tests + `npx tsc --noEmit`; full gate at the end (npm test, build, test:e2e, test:contracts, biome format:write+check, markdownlint, pytest, ruff, ansible-lint, spectral, oasdiff-additive).

Execution order differs from the spec's T-labels where dependencies demand (the catalog precedes the RBAC middleware); the mapping is noted per task.

---

### T0 — Contracts (spec T0)

- [ ] api-v1.yaml `info`/tag description note: MCP transport gate semantics (`mcp.allow_apply`, default false; plan/read always allowed; support-bundle + task-cancel exempt with rationale).
- [ ] `client_type` union widens to `'rest' | 'mcp'` (context.ts; request-id default stays `'rest'`).
- [ ] Gate (contracts) + commit `feat(control-path): S8 T0 — contracts (client_type union, MCP gate semantics)`.

### T1 — Ansible role decomposition (spec T1)

- [ ] New `collection/roles/xinas_node_build`: repo build tasks (`npm ci` + `npm run build`) extracted verbatim from `xinas_mcp` (vars: repo path, node bin). README.
- [ ] New `collection/roles/xinas_nfs_helper`: helper file copy + systemd unit + enable/restart extracted from `xinas_mcp`. README.
- [ ] `xinas_mcp` loses those tasks (keeps legacy service install until T15); `xinas_api` preflight failure message names `xinas_node_build`; `playbooks/site.yml` order `xinas_node_build → xinas_nfs_helper → xinas_api → xinas_agent → xinas_mcp`.
- [ ] ansible-lint + commit with trailer `Requires-Rebuild: all`.

### T2 — Catalog (spec T3)

- [ ] `src/api/mcp/catalog.ts`: `CatalogEntry {name, description, method, path, input_schema, mutability, requires_mcp_apply, min_role, status}`; ~40 REST-shaped entries per spec §3 (config-history snapshots/show/diff/rollback + audit.query `degraded`); `matchCatalog(method, path)` route matcher ({id} patterns).
- [ ] Tests: every entry resolves to a mounted express route (walk the app router); min_role spot-pins (arrays.create admin, shares.create operator, *.list viewer); the matcher.
- [ ] Commit `feat(api): S8 T2 — the declarative client catalog (tools/commands/authz from one table)`.

### T3 — REST RBAC enforcement (spec T2, review P0)

- [ ] `rbacMiddleware` after auth on /api/v1: matchCatalog → rank check (viewer<operator<admin) → `PERMISSION_DENIED` 403; unmatched public routes default admin; /internal untouched.
- [ ] Add viewer/operator tokens to test helpers. Regression pins: viewer POST /arrays → 403 (passes TODAY — pin the fix), viewer GET /arrays → 200, operator shares create → allowed, operator arrays.create → 403.
- [ ] Full suite (existing tests use admin tokens — fix fallout) + commit `feat(api): S8 T3 — REST RBAC enforcement (catalog min_role)`.

### T4 — Loopback auth + audit skip (spec T2b, review P1)

- [ ] Ephemeral loopback token minted in createApp/ctx; auth middleware honors `X-Xinas-Forwarded-{Principal,Role}` + `X-Xinas-Client-Type` ONLY under that bearer (else ignored + warn). audit middleware skips `/mcp*` paths.
- [ ] Tests: forwarded headers with wrong bearer ignored; with loopback bearer → principal/role/client_type land in context + audit row; /mcp path produces no audit row.
- [ ] Commit `feat(api): S8 T4 — loopback identity forwarding + /mcp audit dedupe`.

### T5 — Read-route promotion (spec T4, review P1)

- [ ] New read routes + api-v1.yaml additions: `GET /system/logs` (journalctl seam), `GET /system/performance` (prometheus HTTP seam), `GET /quotas` (repquota seam, degrades), `GET /pools`, `GET /mail/settings`, `GET /mail/recipients`, `GET /auth/modes` (read-only gRPC seam, deprecated marker, degrades to warning envelope when unreachable). All injectable seams; all in the catalog (viewer).
- [ ] Tests per route (seam-faked + degraded paths). Spectral + oasdiff stay green.
- [ ] Commit `feat(api): S8 T5 — read-route promotion (logs/perf/quotas/pools/mail/auth-modes)`.

### T6 — MCP dispatcher + gate (spec T4b)

- [ ] `src/api/mcp/dispatch.ts`: SDK `Server` with tools/list + tools/call from the catalog; per-entry gate (§4 verdict table: read allow; plan allow; apply ⇒ `mcp.allow_apply`; direct ⇒ explicit flag) → `MCP_APPLY_DISABLED` structured error; loopback seam `(req) => {status, body}` (production: node http against the api's own primary listener; tests: injected).
- [ ] Tests: gate matrix; envelope warnings → MCP result; NOT_IMPLEMENTED for uncovered legacy names.
- [ ] Commit `feat(api): S8 T6 — MCP dispatcher + catalog-driven apply gate`.

### T7 — Transports (spec T5)

- [ ] `/mcp` StreamableHTTP endpoint on the express app (session map per legacy pattern); optional `config.mcp.http {host, port}` extra TCP listener (multi-listener in server.ts, primary path untouched); `src/mcp-stdio.ts` → `dist` + bin: SDK Server(stdio) proxying tools/list+call as raw HTTP-over-UDS posts to `/mcp` (transport adapter per ADR; UDS peer trust → local_admin).
- [ ] Tests: boot with mcp.http → both listeners answer; stdio adapter smoke (spawn against a UDS harness).
- [ ] Commit `feat(api): S8 T7 — MCP transports (streamable HTTP in-process, stdio adapter, extra listener)`.

### T8 — MCP integration tests (spec T6)

- [ ] Real SDK client against a listening test instance: tools/list (names/status), read call end-to-end, gate matrix over the wire, RBAC parity (viewer token via MCP vs REST), exactly ONE audit row per tool call.
- [ ] Commit `test(api): S8 T8 — MCP integration (SDK client, gate, RBAC + audit parity)`.

### T9 — xinasctl (spec T7+T8)

- [ ] `src/cli/xinasctl.ts` (+ package.json bin): catalog-generated command tree (`xinasctl <resource> <verb>`), `--json`, `-f spec.json`, `--plan/--apply`, `--wait` task polling, UDS default + `--url/--token`/`XINAS_TOKEN`.
- [ ] Unit tests: argv→request building (seam), output rendering, --wait state machine.
- [ ] Commit `feat(cli): S8 T9 — xinasctl (catalog-generated REST client)`.

### T10 — xinasctl e2e (spec T9)

- [ ] Harness e2e: spawn dist/xinasctl.js against the fixture api — list, plan, apply, --wait to success; token + UDS paths.
- [ ] Commit `test(e2e): S8 T10 — xinasctl end-to-end`.

### T11 — control_client.py (spec T10)

- [ ] `xinas_menu/api/control_client.py`: stdlib HTTP-over-UDS, envelope parsing, errors, `plan_apply_wait()` (poll to terminal, stage callbacks). pytest against a stub UDS server (incl. failure surfaces).
- [ ] Commit `feat(tui): S8 T11 — control-path client (HTTP-over-UDS + plan_apply_wait)`.

### T12 — TUI shares screens (spec T11)

- [ ] `screens/nfs.py` + `screens/configure/nfs_config.py`: list/create/update/delete via control_client `/shares`; nfs_client usage leaves these screens.
- [ ] ruff + pyright + pytest; commit (no Requires-Rebuild — Python-only... include `Requires-Rebuild: xinas_menu`? No — code-only TUI changes need no Ansible re-run; plain update suffices).

### T13 — TUI network screens (spec T12)

- [ ] `screens/network.py` + `screens/configure/network_config.py`: `netplan apply|try` subprocess REMOVED → `PATCH /network/interfaces/{id}` / pool apply via control_client.
- [ ] Gate + commit.

### T14 — TUI RAID screens (spec T13)

- [ ] `screens/raid.py` + `configure/raid_config.py`: list/create/modify/delete via `/arrays`; composite delete teardown re-expressed per spec §6 (shares delete → fs unmount/unmanage → arrays delete; stop-on-failure; progress view renders task stages); wizard pool lookups stay on grpc.
- [ ] Gate + commit.

### T14b — TUI filesystem screens (spec T13b, review P0)

- [ ] `screens/filesystem.py`: create (mkfs path) / mount / delete onto `/filesystems` plan/apply + `/shares` cleanup; xfs_helpers/findmnt direct calls leave the screen.
- [ ] Gate + commit.

### T15 — Retirement (spec T14)

- [ ] `xinas_mcp` role → shim (stop/disable `xinas-mcp.service`, endpoint config, token-migration README step); delete legacy `src/server/`, `src/registry/`, `src/tools/`, legacy middleware/config not consumed by the api; remove `xinas-mcp.service` unit file + legacy bin; prune package.json scripts; CLAUDE.md + docs/MCP pointer note (superseded by ADR-0010).
- [ ] Full suite + commit with `Requires-Rebuild: xinas_mcp, xinas_api`.

### T16 — Parity e2e + full gate (spec T15)

- [ ] e2e: spec §7 scenarios — same plan_hash via REST/MCP/xinasctl; MCP apply 403 default / success with allow_apply; audit parity incl. single-row; direct-entry exemptions; degraded honesty; stdio adapter.
- [ ] Runbook §5b (MCP/CLI/TUI on-node checks + demo re-point step). FULL verification gate (all suites + linters + python + ansible).
- [ ] Commit `test(e2e): S8 T16 — client parity end-to-end + runbook`.
