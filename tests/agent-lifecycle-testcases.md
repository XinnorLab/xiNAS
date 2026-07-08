# TP: On-node xiNAS agent lifecycle — boot + poll + publish

QA Test Plan and Test Cases for the on-node agent lifecycle. Designed by the
`test-designer` skill (read-only analysis; no code changed, no tests executed).

- **Machine-readable artifact:** [`agent-lifecycle-testcases.json`](agent-lifecycle-testcases.json)
  (publish with `node scripts/tq-publish.mjs --input tests/agent-lifecycle-testcases.json`)
- **Change type:** Refactor / Feature (lifecycle hardening) · **Subsystem:** MCP (agent)
- **Traceability:** commit `e64e50f` · components: `agent/config`, `agent/boot`, `agent/publisher`, `agent/poll`, `agent/convergence`

## Scope

Covers the steady-state lifecycle of the on-node agent (`xiNAS-MCP/src/agent`):

| Module | Behavior under test |
|--------|--------------------|
| [`config.ts`](../xiNAS-MCP/src/agent/config.ts) | config resolution: inline override, path default, missing-file errors, secret trimming, optional helper socket |
| [`boot.ts`](../xiNAS-MCP/src/agent/boot.ts) | Flow C boot sweep: per-collector reconcile, failed-sweep skip, dual/empty kinds, `agent_started` once, boot-mode restore |
| [`publisher.ts`](../xiNAS-MCP/src/agent/publisher.ts) | batching, ceiling/debounce flush, 5xx/4xx/network retry policy, `pendingReconcile`, wire envelope + auth |
| [`poll.ts`](../xiNAS-MCP/src/agent/poll.ts) | per-collector interval vs 5-min backstop, idempotent start/stop, fault isolation, reconcile consumption |
| [`convergence.ts`](../xiNAS-MCP/src/agent/convergence.ts) | wiring, fixture probe mode, `runConvergence` never rejects |

**Excluded:** individual collector/probe parsing (own suites), the RPC/task-apply
path, xiRAID gRPC transport, and api-side ingestion of observations.

## Risk analysis

| # | Risk | Severity |
|---|------|----------|
| 1 | Failed `initialSweep` reconciling an empty snapshot → api **reconcile-DELETEs** every observed row for that kind, wiping good data on a transient probe failure | **High** |
| 2 | Retry-exhaustion (api down) that does **not** mark `pendingReconcile` → observed state permanently stale until restart (silent freeze) | **High** |
| 3 | Boot mode not restored → partial `complete_snapshots:[]` ceiling flush → boot-time data loss for kinds > 256 entries / 1 MB | **High** |
| 4 | `runConvergence` throwing on a startup boot failure → unhandled rejection, event streams + poll never start, node never recovers | **High** |
| 5 | Retrying a 4xx (structurally-wrong payload) wastes backoff / amplifies a bad batch | Medium |
| 6 | `PollDriver.start` not idempotent → double-armed intervals, doubled observation traffic | Medium |
| 7 | Debounce reset-on-each-enqueue instead of leading-arm → continuous stream starves the flush | Medium |
| 8 | Config silently accepting a missing controller-id/token file → agent that can't authenticate (401s, no clear cause) | Medium |
| 9 | One throwing collector aborting the whole boot/poll loop → observation down for all kinds | Medium |

## Strategy

Functional · Negative · Boundary · Resilience (failure injection) · Stability.

## Environment

Node.js (agent runtime) + `vitest` (`xiNAS-MCP`). A **fake api over a Unix-domain
socket** records POST bodies, statuses, and headers; **fake collectors/probes**
with scripted `initialSweep()` results and injectable throws. Publisher built
with `retryBaseMs=0`/`debounceMs=0` for deterministic retry/flush; debounce cases
use an explicit `debounceMs` with fake timers. `PollDriver` uses a `backstopMs`
override. Fixture probe mode via `XINAS_AGENT_PROBE_MODE=fixture:<dir>`. No
privileged host access; no real xiRAID/NFS.

## Entry / Exit criteria

- **Entry:** agent builds (`tsc`), existing `vitest run` green; fake-api UDS harness
  and fake-collector helpers available; probe fixtures present.
- **Exit:** all P0 + P1 pass; no case demonstrates observed-data loss
  (reconcile-delete on failed sweep, boot ceiling partial) or a silent freeze
  (missing `pendingReconcile` on exhaustion); `runConvergence` resolves under
  injected boot/registry/poll failures. P2 misses logged with a follow-up.

## Test cases

| ID | Pri | Type | Title |
|----|-----|------|-------|
| TC-001 | P0 | functional | Boot sweep sends one reconcile batch per collector and posts `agent_started` exactly once |
| TC-002 | P0 | resilience | Failed `initialSweep` is skipped — no reconcile, existing rows NOT wiped |
| TC-003 | P0 | resilience | Publisher retries 5xx with backoff, then marks kinds `pendingReconcile` on exhaustion |
| TC-004 | P0 | functional | Successful (2xx) flush clears `pendingReconcile` for batch + snapshot kinds |
| TC-005 | P0 | functional | `loadAgentConfig` resolves/trims controller_id/token; inline config short-circuits |
| TC-006 | P0 | resilience | Poll backstop re-sweeps and consumes `pendingReconcile` after the api recovers |
| TC-007 | P1 | negative | 4xx is not retried and does not mark the kind for reconcile |
| TC-008 | P1 | resilience | Network error (api socket down) treated as 5xx — retried, then `pendingReconcile` |
| TC-009 | P1 | negative | `loadAgentConfig` throws a clear error on missing config / controller-id / token file |
| TC-010 | P1 | boundary | Boot mode suppresses ceiling/debounce so an oversized kind is one reconcile batch |
| TC-011 | P1 | resilience | Boot mode restored (`finally`) even when a mid-boot flush throws |
| TC-012 | P1 | boundary | Empty collector still reconciles its primary kind to empty |
| TC-013 | P1 | functional | Dual-kind collector marks ALL its kinds complete in one boot batch |
| TC-014 | P1 | functional | `PollDriver` arms one interval per collector; start idempotent; stop clears timers |
| TC-015 | P1 | resilience | A throwing collector in a poll tick is absorbed; other timers unaffected |
| TC-016 | P1 | resilience | `runConvergence` never rejects when the boot sweep fails at startup |
| TC-017 | P2 | stability | Steady-state debounce is leading-arm — a burst produces a single flush |
| TC-018 | P2 | functional | Fixture probe mode spawns no subprocesses; populates disks/users/nfs-idmap |
| TC-019 | P2 | functional | Observation POST body + headers carry the correct envelope and bearer auth |

Full preconditions / input data / numbered steps / expected results / observability
for every case are in the JSON artifact. Highlights of the P0 critical path:

### TC-001 — Boot sweep reconcile + single `agent_started` (P0, functional)
Given 3 collectors (Disk 2Δ, Users 2 User+1 Group, Filesystem 0Δ) and a 200 api:
each kind arrives as one `complete_snapshots` batch (Users covers `['User','Group']`,
Filesystem sends `deltas:[]` with `['Filesystem']`), then exactly one
`POST /internal/v1/agent_started {controller_id}` fires last. — `boot.ts:35-69`

### TC-002 — Failed sweep must not wipe good data (P0, resilience)
A rejecting `NfsCollector.initialSweep()` logs `initial_sweep_failed` to stderr and
is **skipped** — no `complete_snapshots:['NfsSession']` is ever sent, so the api
does not reconcile-delete existing NFS rows. The healthy Disk collector still
reconciles and `agent_started` still posts once. — `boot.ts:37-58`

### TC-003 — 5xx retry → `pendingReconcile` (P0, resilience)
With `retryBaseMs=0` and a 503-always api: exactly 5 attempts, `flush()` resolves
(no throw), and `needsReconcile('Disk') === true`. — `publisher.ts:166-205`

### TC-004 — 2xx clears reconcile debt (P0, functional)
Pre-seed `pendingReconcile` with Disk + NfsSession; `flushWithSnapshot(['NfsSession'])`
with a Disk delta at 200 clears **both** (batch kind + requested snapshot kind).
— `publisher.ts:171-180`

### TC-005 — Config resolution (P0, functional)
Trailing-whitespace controller-id/token files resolve **trimmed**; `{inline}`
short-circuits the filesystem; absent `nfs_helper_socket` is **omitted**, not
`undefined`. — `config.ts:23-50`

### TC-006 — Backstop heals a dropped batch (P0, resilience)
After exhaustion leaves `Network` in `pendingReconcile`, one `PollDriver` tick
re-sweeps + `flushWithSnapshot(['Network'])` at 200 and clears the debt — recovery
with no process restart. — `poll.ts:38-77` + `publisher.ts:200-205`

## Publishing

To publish to TestQuality:

```bash
node scripts/tq-publish.mjs --input tests/agent-lifecycle-testcases.json [--pr <number>]
```
