# TP: xinas-agent — privileged observation & execution daemon (Phase 0)

> QA Test Plan + Test Cases for the `xinas-agent` daemon as it runs on a
> xiNAS node. Designed with the **test-designer** skill (read-only analysis —
> no source changed, no tests executed). Companion machine-readable artifact:
> [`xinas-agent-test-cases.json`](xinas-agent-test-cases.json).
>
> **Component:** MCP / `xinas-agent` · **Commit:** `3d8eb6d` · **PR:** —

---

## 1. Scope

**Covered** — behavior of the running `xinas-agent.service`
(`node /opt/xiNAS/xiNAS-MCP/dist/agent-server.js`, `User=root`,
`Requires=xinas-api.service`):

- **Boot & lifecycle** — RPC-server-binds-before-boot-sweep ordering, UDS
  socket permissions / fail-closed, signal handling & graceful shutdown,
  fatal-startup exit code.
- **Convergence / boot sweep** — best-effort per-collector sweep, the
  "failed sweep must not reconcile-delete" invariant, one-shot `agent_started`.
- **RPC dispatch** (`agent/rpc/dispatch.ts`) — JSON-RPC 2.0 envelope
  validation, allow-list routing incl. prototype-pollution rejection, error
  code mapping, the 1 MB per-line DoS guard.
- **Task subsystem** — progress-event taxonomy & ordering, stage-failure
  rollback, `requires_manual_recovery`, cooperative cancel, idempotent
  `task.begin`, the `config.rollback` executor.
- **Publisher** (`agent/publisher.ts`) — retry/backoff, 4xx-no-retry visible
  drop, retry-exhaustion → `pendingReconcile` recovery.
- **Health** (`agent.health`) — `starting`/`healthy`/`degraded` derivation.

**Excluded (and why):**

- xiRAID gRPC internals, `xinas-api` REST/RBAC, `xinas-nfs-helper` — separate
  components with their own suites; exercised here only at the agent boundary.
- The published-observation *schema* correctness on the api side (the agent's
  job is to POST facts; the api validates/persists — its own test surface).
- Exhaustive per-collector parsing (already covered by the vitest unit suite
  under `xiNAS-MCP/src/__tests__/agent/`); this plan targets **daemon-level,
  on-a-running-box behavior**.

## 2. Risk Analysis

| # | Risk | Severity | Notes |
|---|------|----------|-------|
| R1 | **Privilege boundary** — the agent runs as **root** and its UDS is the *only* auth gate. A world-connectable / wrong-group socket lets any local user drive privileged RPC. | **high** | `agent/rpc/server.ts` chmod 0660 + chown root:xinas-api; must **fail closed** as root. |
| R2 | **Silent observed-data loss** — a transient probe failure that reconcile-*deletes* good api-side observed rows, or a 4xx batch that vanishes with no log. | **high** | `boot.ts` skips failed sweeps; `publisher.ts` `onPublishError` makes 4xx visible. |
| R3 | **Task rollback integrity** — a failed stage that is not rolled back, or a rollback failure mis-reported as `failed` (auto-heal implied) instead of `requires_manual_recovery`. | **high** | `task/runner.ts` terminal-state taxonomy. |
| R4 | **Startup wedging** — an unavailable `xinas-api` blocking agent startup, so `agent.health` never answers and systemd flaps. | medium | Server binds *before* the (backgrounded) boot sweep. |
| R5 | **DoS on the root daemon** — an unbounded RPC line growing the read buffer until OOM. | medium | 1 MB `MAX_LINE_BYTES` guard. |
| R6 | **Prototype-pollution routing** — `__proto__`/`constructor` resolving to an inherited handler. | medium | `hasOwnProperty` own-property routing. |
| R7 | **Idempotency** — a re-dispatched `task.begin` (api reconcile) starting a *second* run of the same `task_id`. | medium | Accept-record map keyed by `task_id`. |
| R8 | **Shutdown hang** — a held-open client blocking `server.close()` past systemd's stop timeout. | low | 3 s forced-exit backstop. |

## 3. Strategy

`functional` · `negative` · `boundary` · `resilience` · `security` · `stability`

Emphasis on **resilience** (failure injection: api down, probe throw, 5xx
storms) and **security** (socket perms, prototype pollution, oversize line),
because the agent is a root daemon whose correctness is mostly about *how it
behaves when its dependencies misbehave*.

## 4. Environment

- Ubuntu 22.04/24.04 xiNAS node with `xinas-api.service` **active** and
  `xinas-agent.service` installed (`/opt/xiNAS/xiNAS-MCP/dist/agent-server.js`).
- Config at `/etc/xinas-agent/config.json` (+ `agent-token`, `controller-id`);
  agent UDS `/run/xinas/agent.sock` (0660 root:xinas-api); api UDS the agent
  POSTs to (`config.api_socket`).
- Tools on the box: `systemctl`, `journalctl`, `socat` **or** `nc -U`, `getent`,
  and `jq` for asserting JSON-RPC replies / structured log lines.
- For hermetic / failure-injection cases: **fixture probe mode**
  (`XINAS_AGENT_PROBE_MODE=fixture:<dir>`) and the retry/poll env overrides
  (`XINAS_AGENT_*_POLL_MS`) so cases run fast and spawn no host subprocesses.
- A JSON-RPC helper, e.g.:
  `rpc() { printf '%s\n' "$1" | socat -t5 - UNIX-CONNECT:/run/xinas/agent.sock; }`

## 5. Entry Criteria

`dist/` built from the commit under test; `xinas-api` active; agent socket
present and reachable by a member of `xinas-api` (or root); a clean api
observed-state baseline captured for the reconcile cases.

## 6. Exit Criteria

All **P0** cases pass; no **high**-severity risk (R1–R3) has an open failing
case; every negative/error case returns the *exact* JSON-RPC code specified;
no case leaves `xinas-agent` in `failed`/`activating (auto-restart)` at teardown.

## 7. Traceability

- **Components:** MCP, `xinas-agent`
- **Commit:** `3d8eb6d`
- **Key sources:** `agent-server.ts`, `agent/convergence.ts`, `agent/boot.ts`,
  `agent/rpc/{server,dispatch}.ts`, `agent/rpc/methods/{health,task}.ts`,
  `agent/task/{runner,config-rollback-executor}.ts`, `agent/publisher.ts`
- **Existing automated coverage:** `xiNAS-MCP/src/__tests__/agent/**`,
  `.../api/*agent*`, `.../e2e/agent-api-roundtrip.test.ts`

---

## 8. Test Cases

### P0 — critical path / security / data integrity

#### TC-001 — agent.health answers while xinas-api is down (bind-before-sweep)
- **Component:** xinas-agent / lifecycle · **Type:** functional · **Priority:** P0
- **Preconditions:** agent installed; `xinas-api` **stopped** (`systemctl stop xinas-api`).
- **Input:** `{"jsonrpc":"2.0","id":1,"method":"agent.health"}`
- **Steps:**
  1. Stop `xinas-api`, then start `xinas-agent`. → agent reaches `active (running)`; journal shows `event:"listening"` with the socket path.
  2. Within ~1 s, send the `agent.health` RPC over the socket. → a `result` is returned, **not** a timeout; `status` is `"starting"` (or `"degraded"` if a probe already errored), and the reply carries `version`, `uptime_seconds`, `controller_id`, `collectors`.
- **Expected:** Health responds independently of api availability; the boot sweep runs in the background and its api-POST failures are logged, not fatal (`convergence.ts runConvergence` absorbs them).
- **Observability:** `journalctl -u xinas-agent` (`listening`, `boot_sequence_failed`); RPC reply JSON.
- **Refs:** `agent-server.ts:185` (bind) & `:199` (`void runConvergence`); `rpc/methods/health.ts`.

#### TC-002 — Agent UDS is 0660 root:xinas-api and fails closed on perm error
- **Component:** xinas-agent / rpc-server · **Type:** security · **Priority:** P0
- **Preconditions:** agent active as root.
- **Input:** filesystem inspection + a fault-injected chown target.
- **Steps:**
  1. `stat -c '%a %U %G' /run/xinas/agent.sock`. → `660 root xinas-api`.
  2. As an unprivileged user **not** in `xinas-api`, attempt to connect and send `agent.health`. → connection refused/`EACCES`; no RPC served.
  3. Fault-inject an unresolvable `socket_group` (so chown fails) and restart as root. → journal logs `event:"socket_perm_failed"`, the bind **rejects**, the process exits non-zero, and systemd `Restart=on-failure` retries (unit enters auto-restart) — it does **not** serve on a mis-permissioned socket.
- **Expected:** The socket is the auth gate; as root a chmod/chown failure is fatal (fail closed). (As non-root dev/test it degrades to `socket_perm_skipped` warn — verify that path does **not** run in production.)
- **Observability:** `stat`; `journalctl` (`socket_perm_failed`); `systemctl status xinas-agent` (Result/restart count).
- **Refs:** `agent/rpc/server.ts:104-124`.

#### TC-003 — RPC rejects non-allow-listed & prototype-pollution methods (-32601)
- **Component:** xinas-agent / rpc-dispatch · **Type:** security · **Priority:** P0
- **Preconditions:** agent active.
- **Input:** methods `"agent.nope"`, `"__proto__"`, `"constructor"`, `"hasOwnProperty"`, `"toString"`.
- **Steps:**
  1. Send each as `{"jsonrpc":"2.0","id":N,"method":"<m>"}`. → every reply is an `error` with `code:-32601` and a "not in the agent's RPC surface" message; **no** handler runs.
- **Expected:** Only own-property allow-listed methods route; inherited `Object.prototype` keys never resolve.
- **Observability:** RPC reply `error.code` via `jq`.
- **Refs:** `agent/rpc/dispatch.ts:68`.

#### TC-004 — Oversized RPC line (>1 MB) → -32600 and connection destroyed
- **Component:** xinas-agent / rpc-server · **Type:** security/boundary · **Priority:** P0
- **Preconditions:** agent active.
- **Input:** a single line of ~1.1 MB with no `\n`.
- **Steps:**
  1. Stream >1 MB without a newline into the socket. → server replies `error.code:-32600` "request too large" and destroys the socket; agent stays `active` (no OOM, no crash).
  2. Send a normal `agent.health` on a fresh connection. → served normally.
- **Expected:** The per-connection read buffer is capped (`MAX_LINE_BYTES`); a slow-loris/large-line client cannot grow memory unbounded.
- **Observability:** RPC reply; `systemctl status` (agent still active); RSS unchanged.
- **Refs:** `agent/rpc/server.ts:25,51-63`.

#### TC-005 — Task happy-path emits the full progress taxonomy in order
- **Component:** xinas-agent / task-runner · **Type:** functional · **Priority:** P0
- **Preconditions:** agent active; a registered executor (e.g. the reference executor) available; capture progress via the api-side task view (or a `publish` sink in fixture mode).
- **Input:** `task.begin` `{task_id:"t-happy", kind:"reference", spec:{...}}`.
- **Steps:**
  1. Dispatch `task.begin`. → returns `{accepted:true, agent_acceptance_id:<uuid>}`.
  2. Collect the emitted `TaskProgressEvent`s. → ordering is exactly `accepted → stage_succeeded(snapshot_before, snapshot_id) → (stage_started → stage_succeeded)* → stage_succeeded(snapshot_after) → terminal(success, snapshot_id)`; `sequence` is per-task monotonic from 1; each distinct stage has a unique `stage_index`.
- **Expected:** Real `xinas_history` `snapshot_before`/`snapshot_after` bracket the stages; terminal is `success` with the after-snapshot id.
- **Observability:** api task_stages rows / progress-event stream; `snapshot_id`s resolvable via `xinas_history`.
- **Refs:** `agent/task/runner.ts:133-204`.

#### TC-006 — Failed initialSweep must NOT reconcile-delete existing observed rows
- **Component:** xinas-agent / boot-sweep · **Type:** resilience/data-integrity · **Priority:** P0
- **Preconditions:** api holds a known-good observed snapshot for a kind (e.g. `Disk`); inject a probe that **throws** on `initialSweep` for that kind (fixture with a malformed file, or a stubbed throwing probe).
- **Input:** agent restart with the throwing probe for one kind.
- **Steps:**
  1. Restart the agent. → journal logs `event:"initial_sweep_failed"` for that kind.
  2. Query api observed rows for the kind. → the **existing rows are still present** (no `complete_snapshots:[kind]` reconcile-delete was sent for the failed kind).
  3. Let the poll backstop recover the probe. → the kind re-sweeps and reconciles normally.
- **Expected:** An empty result from a *failed* sweep means "unknown", not "none"; the collector is skipped, its health = `error` surfaces via `agent.health`, and no good data is wiped.
- **Observability:** `journalctl` (`initial_sweep_failed`); api observed-row count before/after; `agent.health.collectors[kind]` = `error:*`.
- **Refs:** `agent/boot.ts:36-58`.

#### TC-007 — task.begin is idempotent by task_id (no double run)
- **Component:** xinas-agent / task-rpc · **Type:** functional/data-integrity · **Priority:** P0
- **Preconditions:** agent active; an executor whose first stage blocks long enough to send a second begin while in-flight.
- **Input:** two `task.begin` calls with the **same** `task_id:"t-idem"`.
- **Steps:**
  1. Send begin #1. → `{accepted:true, agent_acceptance_id:A}`; task appears in `task.list_inflight`.
  2. While still in-flight, send begin #2 with the same `task_id`. → returns the **same** `agent_acceptance_id:A`; `task.list_inflight` still shows exactly one entry; only one run's progress events are emitted.
- **Expected:** Re-dispatch (api reconcile, §9) is safe; a repeated begin never starts a second run.
- **Observability:** the two RPC replies (equal `agent_acceptance_id`); `task.list_inflight` count; progress-event stream (single run).
- **Refs:** `agent/rpc/methods/task.ts:129-165`.

### P1 — negative / boundary / failure

#### TC-008 — Malformed envelope → -32600 (parse / missing method)
- **Component:** xinas-agent / rpc-dispatch · **Type:** negative · **Priority:** P1
- **Preconditions:** agent active.
- **Input:** (a) `not json`; (b) `[]` (array); (c) `{"jsonrpc":"2.0","id":5}` (no method); (d) `{"jsonrpc":"2.0","id":6,"method":""}`.
- **Steps:**
  1. Send each. → (a) `-32600` "Parse error"; (b) `-32600` "envelope must be a JSON object"; (c)/(d) `-32600` "missing or non-string method", with `id` echoed as `5`/`6`.
- **Expected:** Envelope validation precedes routing; `id` is echoed when present, else `null`.
- **Observability:** RPC reply `error.code` + `id`.
- **Refs:** `agent/rpc/dispatch.ts:41-60`.

#### TC-009 — Handler error mapping: EXECUTOR_UNSUPPORTED → -32000, INVALID_PARAMS → -32602
- **Component:** xinas-agent / rpc-dispatch · **Type:** negative · **Priority:** P1
- **Preconditions:** agent active.
- **Input:** (a) `task.begin` with `kind:"does.not.exist"`; (b) `task.begin` with no `task_id`.
- **Steps:**
  1. (a) → `error.code:-32000`, `error.data:{code:"EXECUTOR_UNSUPPORTED", method:"task.begin"}`.
  2. (b) → `error.code:-32602` "task.begin requires task_id + operation_kind".
- **Expected:** Unknown operation kind is a distinct custom code (api maps to 422); bad params are -32602.
- **Observability:** RPC reply `error.code`/`error.data`.
- **Refs:** `agent/rpc/dispatch.ts:86-95`, `agent/rpc/methods/task.ts:118-139`.

#### TC-010 — Stage failure → rollback → terminal(failed, FAILED_PARTIAL_ROLLED_BACK)
- **Component:** xinas-agent / task-runner · **Type:** resilience · **Priority:** P1
- **Preconditions:** an executor whose 2nd stage throws and whose `rollback()` succeeds.
- **Input:** `task.begin` for that operation kind.
- **Steps:**
  1. Run the task. → events: `accepted → snapshot_before → stage_started(s1) → stage_succeeded(s1) → stage_started(s2) → stage_failed(s2, error_message) → rollback_started → rollback_succeeded → terminal(failed)`.
  2. Inspect the terminal event. → `status:"failed"`, `error_code:"FAILED_PARTIAL_ROLLED_BACK"`; **no** stage after the failed one ran.
- **Expected:** First failure stops the sequence; the executor's own `rollback()` runs; drained `output_inline` is attached to `stage_failed`/`rollback_*`.
- **Observability:** progress-event stream; api task terminal row.
- **Refs:** `agent/task/runner.ts:163-194,247-256`.

#### TC-011 — Rollback throws → terminal(requires_manual_recovery)
- **Component:** xinas-agent / task-runner · **Type:** resilience · **Priority:** P1
- **Preconditions:** an executor whose stage throws **and** whose `rollback()` throws.
- **Input:** `task.begin` for that kind.
- **Steps:**
  1. Run the task. → `… stage_failed → rollback_started → rollback_failed(error_message) → terminal(requires_manual_recovery)`.
  2. Terminal event. → `status:"requires_manual_recovery"`, `error_code:"FAILED_MANUAL_RECOVERY_REQUIRED"`.
- **Expected:** A rollback failure is never reported as a plain `failed` (which implies auto-heal); it escalates to manual recovery so an operator/api is alerted.
- **Observability:** progress-event stream; api terminal state.
- **Refs:** `agent/task/runner.ts:231-245`.

#### TC-012 — Cooperative cancel honored at a stage boundary → terminal(cancelled)
- **Component:** xinas-agent / task-runner · **Type:** functional · **Priority:** P1
- **Preconditions:** an executor with a stage that checks `ctx.isCancelRequested()` (e.g. fs/xiraid).
- **Input:** `task.begin` then `task.cancel` for the same `task_id` before the next stage boundary.
- **Steps:**
  1. Begin a multi-stage task; send `task.cancel {task_id}`. → `{cancel_requested:true}`.
  2. Observe terminal. → rollback runs, terminal `status:"cancelled"` with **no** `error_code`.
  3. Cancel a **fast** reference task (no mid-stage check) after it finished. → cancel is a no-op; task terminates `success`.
- **Expected:** Cancel is cooperative, honored only at safe points (before each stage); a cancel landing after the last stage is ignored (→ success).
- **Observability:** `task.cancel` reply; progress-event terminal.
- **Refs:** `agent/task/runner.ts:150-186`, `agent/rpc/methods/task.ts:167-180`.

#### TC-013 — Publisher retry/backoff exhaustion → pendingReconcile, then recovery re-sweeps
- **Component:** xinas-agent / publisher · **Type:** resilience · **Priority:** P1
- **Preconditions:** fixture/failure harness where the api returns `503` for N calls then `200`; `retryBaseMs` small.
- **Input:** a steady-state observation delta for a kind while the api 5xxs.
- **Steps:**
  1. Emit a delta while api returns 503. → 5 attempts with exponential backoff (250ms→500→…, capped 30 s); on exhaustion the kind is added to `pendingReconcile`.
  2. Restore api to 200; next collector tick sees `needsReconcile(kind)`. → the collector runs `initialSweep` (full reconcile) instead of an incremental delta; on the 2xx the kind is cleared from `pendingReconcile`.
- **Expected:** 5xx/network errors retry then reconcile-recover; no observation is permanently lost on a transient api outage.
- **Observability:** journal retry/`pendingReconcile`; api observed rows converge after recovery.
- **Refs:** `agent/publisher.ts:186-235,152-154`.

#### TC-014 — Publisher 4xx → no retry, drop is made visible
- **Component:** xinas-agent / publisher · **Type:** negative · **Priority:** P1
- **Preconditions:** harness where the api returns `400` for an observation batch (e.g. a schema-invalid observed row).
- **Input:** a delta batch the api rejects with 400.
- **Steps:**
  1. Emit the batch. → **exactly one** POST (no retries); `onPublishError` fires → a structured stderr/journal line `event:"observation_batch_rejected"` with `status:400` and the affected `kinds`.
- **Expected:** A structurally-wrong payload is dropped without retry, but **never silently** — the reject is logged so a whole kind can't vanish unnoticed.
- **Observability:** `journalctl -u xinas-agent | jq 'select(.event=="observation_batch_rejected")'`.
- **Refs:** `agent/publisher.ts:206-215,84-95`.

#### TC-015 — One bad collector doesn't abort boot; agent_started still POSTed once
- **Component:** xinas-agent / convergence · **Type:** resilience · **Priority:** P1
- **Preconditions:** one collector's probe throws; all others healthy; api up.
- **Input:** agent restart.
- **Steps:**
  1. Restart. → the throwing kind logs `initial_sweep_failed` and is skipped; every **other** kind is swept and reconciled (`flushWithSnapshot([kind])`).
  2. Confirm the one-shot startup POST. → exactly one `POST /internal/v1/agent_started {controller_id}` is sent after the sweep loop, clearing the api heartbeat startup grace.
- **Expected:** Boot is best-effort per collector; a single failure neither aborts convergence nor blocks the `agent_started` signal.
- **Observability:** journal (`initial_sweep_failed`); api heartbeat leaving startup-grace; api observed rows for healthy kinds.
- **Refs:** `agent/boot.ts:25-69`, `agent/convergence.ts:420-446`.

#### TC-016 — config.rollback executor: baseline vs snapshot-id, drift caveat, no-op rollback
- **Component:** xinas-agent / config-rollback-executor · **Type:** functional · **Priority:** P1
- **Preconditions:** `xinas_history` bridge reachable (or fixture); a known snapshot id present.
- **Input:** (a) spec `{reason:"revert", to:"baseline", baseline_id:"baseline"}`; (b) spec `{reason:"revert", to:"<snap-id>"}`; (c) spec missing `reason`.
- **Steps:**
  1. (a) → stage `restore` calls `bridge.resetToBaseline("revert")`; output includes `reset-to-baseline (baseline): revert` then `baseline reset completed`; terminal `success`.
  2. (b) → calls `bridge.restoreSnapshot("<snap-id>","revert")`; output includes the **drift caveat** ("recovery applied — desired state unchanged; re-apply or adopt to make it durable").
  3. (c) → stage throws `config.rollback: enriched spec missing reason` → `stage_failed` → `terminal(...)`.
  4. Force the bridge to return `success:false`. → stage throws "runner auto-rollback applies"; note the executor's own `rollback()` is a **no-op** (the python transactional runner already rolled back — the agent must not fight it).
- **Expected:** `to` routes baseline-reset vs targeted-restore; targeted restore emits the durability caveat; the executor never runs a compensating rollback of its own.
- **Observability:** progress-event `output_inline`; `xinas_history` state; terminal status/error.
- **Refs:** `agent/task/config-rollback-executor.ts:26-81`.

#### TC-017 — agent.health status derivation (starting / healthy / degraded)
- **Component:** xinas-agent / health · **Type:** functional · **Priority:** P1
- **Preconditions:** controllable collector health snapshot (fixture or targeted probe fault).
- **Input:** `agent.health` under three registry states.
- **Steps:**
  1. No collector reported yet (all `stubbed` / empty). → `status:"starting"`.
  2. All collectors `running`/`stubbed` (≥1 real). → `status:"healthy"`.
  3. Inject one probe error so a collector reports `error:<msg>`. → `status:"degraded"`; `collectors` map names the erroring kind; `uptime_seconds` increases monotonically.
- **Expected:** Status is derived purely from the live snapshot; a single `error:` collector degrades the whole agent (the api maps `degraded` → `EXECUTOR_DEGRADED`).
- **Observability:** `agent.health` reply `status`/`collectors`.
- **Refs:** `agent/rpc/methods/health.ts:31-49`.

#### TC-018 — Graceful shutdown on SIGTERM (before and after bind) → exit 0
- **Component:** xinas-agent / lifecycle · **Type:** resilience · **Priority:** P1
- **Preconditions:** agent installed.
- **Input:** `systemctl stop xinas-agent` (SIGTERM); and a race variant delivering SIGTERM immediately after the socket file appears.
- **Steps:**
  1. `systemctl stop`. → journal `event:"shutdown", signal:"SIGTERM"`; poll driver + publisher debounce stopped first, then collectors (`registry.stop`, allSettled), then `server.close()`; process exits 0; socket removed.
  2. Hold a client connection open and stop. → shutdown does not hang past ~3 s: the forced-exit backstop logs `shutdown_forced` and exits 0.
  3. Deliver SIGTERM right after bind (before post-bind work). → still runs `shutdown()` (handlers registered before bind) and exits cleanly.
- **Expected:** Clean teardown ordering; no hang past systemd stop timeout; SIGTERM always reaches `shutdown()`.
- **Observability:** `journalctl` (`shutdown`, `shutdown_forced`); `systemctl status` Result=; socket absence.
- **Refs:** `agent-server.ts:134-183`.

### P2 — stability / hardening

#### TC-019 — Fixture probe mode spawns no host subprocesses (hermetic)
- **Component:** xinas-agent / convergence · **Type:** stability · **Priority:** P2
- **Preconditions:** `XINAS_AGENT_PROBE_MODE=fixture:<dir>` with sample fixture files.
- **Input:** agent start in fixture mode under `strace -f -e trace=execve` (or equivalent).
- **Steps:**
  1. Start the agent in fixture mode. → no `execve` of `udevadm`/`ip`/`systemctl`/`getent` from the probes; disks/users/nfs-idmap populate from `<dir>/*.json`; other kinds are empty.
- **Expected:** Fixture mode is fully file-backed — safe for CI / a machine where privileged probes must not run.
- **Observability:** `strace` execve count; `agent.health.collectors`.
- **Refs:** `agent/convergence.ts:118-128`.

#### TC-020 — Restart hygiene: stale socket removed; auto-restart loop bounded
- **Component:** xinas-agent / rpc-server · **Type:** stability · **Priority:** P2
- **Preconditions:** a leftover socket file at the agent path from a prior unclean exit.
- **Input:** start the agent with a pre-existing `agent.sock` file.
- **Steps:**
  1. Create a dummy file at the socket path, then start the agent. → the stale file is unlinked and re-bound; agent reaches `active`.
  2. Force repeated bind failures (e.g. keep the perm fault) and confirm `Restart=on-failure`/`RestartSec=5s` retries without a tight crash-loop.
- **Expected:** A stale socket never blocks startup; failed starts back off per the unit, not a hot loop.
- **Observability:** `stat` on the socket; `systemctl show xinas-agent -p NRestarts`.
- **Refs:** `agent/rpc/server.ts:42-45`; `xinas-agent.service` (`Restart=on-failure`, `RestartSec=5s`).

---

### Publishing

To publish to TestQuality: `node scripts/tq-publish.mjs --input tests/qa/xinas-agent-test-cases.json`
(add `--dry-run` to preview).
