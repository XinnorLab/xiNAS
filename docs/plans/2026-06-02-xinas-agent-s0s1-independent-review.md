# xinas-agent S0+S1 — Independent multi-agent review

_24-agent separated review of PRs #205-#215 vs the plan + spec + ADRs + api-v1.yaml._

I'll synthesize the per-phase review data into a decisive final report. The data is already verified, so my job is to weight confirmed findings and present a clear cross-check. Let me produce the report directly.

## xiNAS xinas-agent S0+S1 — Lead Review Report

**Scope:** Phases A–K/L, PRs #205–#215 (~90 commits), reviewed against `docs/plans/2026-05-28-xinas-agent-s0s1-plan.md`, `docs/control-path/xinas-agent-s0s1-spec.md`, the ADRs, and `api-v1.yaml`. All findings below carry an adversarial verification verdict; refuted findings are dropped.

---

## 1. Overall verdict

**FIX-FIRST.**

The architecture is sound and the per-phase craftsmanship is genuinely high — clean layering (pure parsers → probes → collectors → publisher → api receiver), correct security model on the file/socket boundary, and disciplined error-code semantics. But the end-to-end observation path is broken in production by a confirmed P0 plus a cluster of P1s that all share one root cause: **the wiring that connects deliberately-built mechanisms was never closed, and the test suite was shaped to pass around the gaps rather than through them.** Concretely, on a real Ansible-deployed root node today: the agent socket is mis-chowned so the api↔agent heartbeat never connects (agent stuck `offline`), and even if it did, steady-state observations never flush, three emitted kinds are rejected 400, and two read-path joins always return empty. None of this is caught by the 459 unit + 5 e2e tests because the gaps live precisely in the rendered-template / real-Share-shape / quiet-node paths the tests don't exercise. This is not shippable as-is, but every confirmed defect is narrowly scoped with a clear fix — this is a focused fix pass, not a redesign.

---

## 2. Per-phase conformance

| Phase | PR | Conformance | Confirmed findings (real=true) |
|-------|-----|-------------|-------------------------------|
| A — Foundation (groups, controller-id, split-secret tokens) | 205 | partial | 1 (P1) |
| B — Shared parse library (10 pure parsers) | 206 | full | 0 |
| C — Agent process skeleton | 207 | full | 0 |
| D — Probe layer (supervisor + 9 probes) | 208 | full | 0 |
| E — Collectors (base + registry + 9 + stubs) | 209 | full | 1 (P1) |
| F — Publisher (batch, retry, reconcile, boot) | 210 | partial | 4 (P1×4) |
| G — API contract additions to api-v1.yaml | 211 | deviation-justified | 0 |
| H — API internal routes + HeartbeatTracker | 212 | full | 0 |
| I — API public read routes | 213 | deviation-concern | 1 (P1) |
| J — Convergence wiring + integration + e2e | 214 | partial | 2 (P1×2) |
| K/L — xinas_agent role + hardened unit | 215 | partial | 3 (P0×1, P1×2) |

**Totals:** 1 P0, 12 P1 confirmed real. **0 findings were refuted** — every P0/P1 raised survived adversarial verification (several were found to *understate* the blast radius). All P2s stand as minor/defensive.

---

## 3. Confirmed findings

### P0

**[KL] Deployed agent config template omits `socket_group` → socket chowned `root:root`, api heartbeat gets EACCES, agent stuck `offline` forever**
- **Location:** `collection/roles/xinas_agent/templates/xinas-agent-config.json.j2:1-7`; no `xinas_agent_socket_group` var in `defaults/main.yml`
- **What's wrong:** The rendered config emits `api_socket`/`agent_socket`/`controller_id_path`/`agent_token_path`/`heartbeat_interval_ms` but **not** `socket_group`, which `src/agent/config.ts:16,39` requires and `agent-server.ts:49` feeds to `getent group`. Undefined → `getent` throws → caught at `:54` → falls back to `process.getgid()` = 0 (unit runs `User=root`). Socket ends up `root:root 0660`. The api runs `Group=xinas-admin` + `SupplementaryGroups=xinas-api` (not in root group) → EACCES on connect → `agent.health` never succeeds → state pinned `offline`. This defeats the entire purpose of Phase KL. No override path exists. The correct gid *does* exist (`xinas_api` role creates the group and adds the api user) — the agent config just never names it.
- **Fix:** Add `"socket_group": "{{ xinas_agent_socket_group }}"` to the template and a `xinas_agent_socket_group: xinas-api` default. Add a rendered-template key-set assertion so this can't regress.

### P1

**[A] Rendered `config.json` never sets `internalTokensPath` → agent token never loaded by the api in a real deployment**
- **Location:** `collection/roles/xinas_api/templates/xinas-api-config.json.j2` (no key); consumer `xiNAS-MCP/src/api/config.ts:74`
- **What's wrong:** `loadConfig()` reads `internal-tokens.json` only when `config.internalTokensPath` is truthy; there is no default/env fallback. The A7 task writes the token files, but A8 wired only the consumer code, never the config field that activates it. Net on a real install: api loads only the admin token → the agent's `Bearer <agent-token>` on `POST /internal/v1/observed` is unrecognized → every push 401s. Tests mask it (e2e inlines the agent token into `config.json`'s `tokens` map; the A8 unit test hand-writes `internalTokensPath`). Directly contradicts spec lines 162/321 and the role-spec doc the same PR added.
- **Fix:** Emit `"internalTokensPath": "/etc/xinas-api/internal-tokens.json"` in the api config template; add an e2e fixture built the way the role builds config.json (path set, agent token absent from inline map).

**[E + J] Type-only validator rejects 3+ kinds the agent's own collectors emit (XiraidArray, managed_files, inventory — and ExportRule) → 400, batch fail-closed, observations silently dropped**
- **Location:** `xiNAS-MCP/src/api/observed-schemas.ts:32-43` (OBSERVED_KINDS); `xiNAS-MCP/src/api/internal/observed.ts:94-110`
- **What's wrong:** `OBSERVED_KINDS` omits `XiraidArray` and `managed_files`, and lists `inventory` which has no api-v1.yaml schema (skipped at compile → undefined validator). The convergence registers and boot-sweeps all three collectors. Each upsert whose kind is absent throws `INVALID_ARGUMENT 'unknown kind'` and **fail-closes the entire batch**; `publisher.ts:122-124` treats 4xx as non-retryable and drops silently. Verification found this **understated**: `ExportRule` is *also* absent from OBSERVED_KINDS despite having a schema and being emitted in the *same NFS batch as NfsSession* — so on any node with NFS exports, live session state is dropped too. This is a Phase-J-introduced regression (pre-J, `ctx.observedSchemas` was undefined so all kinds were accepted). The stub collectors' documented purpose (return a deferral `_stub` row instead of 404) is defeated.
- **Fix:** Add `XiraidArray`, `managed_files`, `inventory`, `ExportRule` to `OBSERVED_KINDS`; provide type-only validators (or an explicit "kind-without-schema accepted" path) for the two schema-less kinds. Note the E10 finding and the J3 finding are the same defect surfacing at two phases — fix once.

**[F] No debounce / timed flush — steady-state deltas never flush on a quiet node**
- **Location:** `xiNAS-MCP/src/agent/publisher.ts:55-69`; `xiNAS-MCP/src/agent/convergence.ts:344`
- **What's wrong:** `enqueue()` auto-flushes only at the 256-entry / 1 MB ceiling. There is no timer-driven flush anywhere in `src/agent/`. The sole steady-state driver just enqueues. A single hot-plug/NIC event enqueues 1 delta that sits in `#queue` forever. On a low-event node, observed state in the api KV store freezes after the boot sweep. Spec line 217/249 explicitly require a ~50–100ms debounce. (The plan's F1 sketch omitted it; the impl faithfully reproduced an under-specified sketch but diverged from the durable spec.)
- **Fix:** Add a debounced flush timer (50–100ms) armed on every `enqueue`, cleared on flush.

**[F] Poll-fallback / 5-minute backstop reconcile unwired — `pollIntervalMs` has no consumer**
- **Location:** `xiNAS-MCP/src/agent/publisher.ts` (no poll driver); collectors `nfs.ts:69`, `inventory.ts:56`, `users.ts:55`
- **What's wrong:** Every collector declares `pollIntervalMs` and comments say "the publisher drives polling via pollIntervalMs," but **no non-test code reads it**. Collectors with no event source (NFS, NfsIdmap, Inventory, Users) and the 5-min backstops for event-only kinds (ExportRule, Mount) are swept exactly once at boot and never again. Spec §Flow C/D (lines 346–350, 374–389) mandate this and it is in *neither* the "Out of scope" nor the "deferred" lists. The F2 commit's "backstop hook" is only the `pendingReconcile` set, which nothing fires.
- **Fix:** Add a per-collector poll loop (`setInterval(pollIntervalMs)` calling the collector's snapshot/flush) plus a 5-min full-reconcile backstop tick.

**[F] `pendingReconcile` populated on retry-exhaustion but never consumed — recovery path dead-ended**
- **Location:** `xiNAS-MCP/src/agent/publisher.ts:71-73,142-143` (`needsReconcile` defined, zero callers)
- **What's wrong:** On 5xx exhaustion the publisher adds the kind to `pendingReconcile` and exposes `needsReconcile(kind)`, but nothing ever calls it. Spec line 391/674 require that the next collector tick of an affected kind re-runs `initialSweep()`. After a sustained api outage drops a batch, the set is marked but no collector ever re-sweeps — recovery tracks state nothing acts on. Strictly worse given the poll backstop is also unwired (no "next tick" ever fires for event-only kinds).
- **Fix:** Make the (newly added) poll/backstop loop consult `needsReconcile(kind)` and escalate to a full `initialSweep()` + `flushWithSnapshot([kind])`; clear on success.

**[F] Boot sweep > 256 deltas (or > 1 MB) for one kind loses data to the api reconcile**
- **Location:** `xiNAS-MCP/src/agent/publisher.ts:63-68`; `boot.ts:45-49`; `xiNAS-MCP/src/api/internal/observed.ts:149-164`
- **What's wrong:** `runBootSequence` enqueues all of one kind's deltas synchronously then calls `flushWithSnapshot([kind])`. If the kind exceeds the ceiling, the early `void this.flush()` POSTs the first 256 with `complete_snapshots:[]` (no reconcile); the trailing `flushWithSnapshot` POSTs the remainder *with* `complete_snapshots:[kind]`. The api reconcile builds `upsertedKeys` from the current request only, so it **deletes every key the first batch wrote** → only the last <256 entries survive. Violates the per-kind-complete invariant (spec 340–341). **Bounded today** (S0/S1 cardinalities are far below 256), latent for any future high-cardinality kind (un-stubbed XiraidArray/ManagedFile).
- **Fix:** Suppress the early ceiling-flush during the boot sweep (boot-mode flag), or serialize: never emit a `complete_snapshots:[]` partial for a kind that will be reconciled in the same sweep.

**[I] Share join keys off non-existent `share.spec.export_path` → `/sessions` and `status.exports[]` always empty against real data**
- **Location:** `xiNAS-MCP/src/api/routes/nfs.ts:19,76`
- **What's wrong:** Both join handlers read `share.spec.export_path`, but the Share schema has no `export_path` (it requires `[path, clients, fsid]`; `seedShare()` writes `spec.path`). For a real Share, `exportPath` resolves `undefined`, so `/shares/{id}/sessions` and `Share.status.exports[]` always return `[]`. The agent's `export_path` (the `/etc/exports` dir) equals `share.spec.path` — that's the intended key. The plan called out this exact `spec.path`-vs-`export_path` trap *twice* (plan 13717, 13931); the impl chose `export_path` anyway and shaped the fixtures to the wrong key (the fixtures even use two *different* values for `path` vs `export_path`, so a correct join would have failed them). This nullifies the two headline deliverables of I5 and I6 in production.
- **Fix:** Join on `share.spec.path`. Re-seed tests with the real single-field Share shape (`spec.path` only) and real-shaped ExportRule/NfsSession rows.

**[J] `agent.health` collector-in-error never maps to `degraded` — tracker is purely time-based**
- **Location:** `xiNAS-MCP/src/api/heartbeat.ts:297-308` (`#computeState` ignores `#collectors`); `convergence.ts:243-254` (forces systemd collector to error)
- **What's wrong:** Spec §668 requires the tracker to interpret a collector-in-error `agent.health` as `degraded`. The agent *does* compute `status='degraded'` (`health.ts:34`), but the probe discards the `status` field and `#computeState()` only uses elapsed time — it never inspects `#collectors`. Phase J's own convergence wires the systemd collector to always reject (`'systemd dbus probe unavailable'`), *unconditionally* (outside the fixture branch), so on every real boot the agent reports `degraded` but the api reports `healthy` and mutating routes return UNSUPPORTED with **no** `EXECUTOR_DEGRADED` warning (spec §312/§702). The contract and the captured data are both present but disconnected. Not deferred (§668 carries no S2 marker, unlike line 655).
- **Fix:** In `#computeState()`, OR the time-based state with a collector-error check (`degraded` if any `#collectors` entry starts with `error:`). Restore `simulateDegraded()` in the mock-agent helper and add a heartbeat unit test for the mapping.

**[KL] `MemoryDenyWriteExecute=true` on a Node service risks crashing V8 JIT (or forcing no-JIT) — the api unit deliberately omits it**
- **Location:** `xiNAS-MCP/xinas-agent.service:64`
- **What's wrong:** V8's JIT must `mprotect` code pages to `PROT_EXEC`; MDWE installs a seccomp filter (returning EPERM) that blocks exactly that. Default non-jitless Node 20 (the confirmed target) will abort or degrade when V8 arms a JIT code page. The sibling `xinas-api.service` runs the identical Node runtime and **deliberately omits** MDWE while keeping the rest of the hardening stack — strong evidence the team already knows Node + MDWE conflict. `systemd-analyze verify` (the plan's only gate) cannot catch a runtime JIT abort.
- **Fix:** Drop `MemoryDenyWriteExecute=true` to match the api unit (or prove safe on the exact target Node build with a real start test).

**[KL] No test exercises the missing-`socket_group` path; L1 smoke is non-root so it masks the P0**
- **Location:** `collection/roles/xinas_agent` (no test dir); `src/__tests__/agent/config.test.ts:20,43`; plan L15780-15811
- **What's wrong:** The P0 has zero coverage at every layer: no molecule/ansible test renders the template and asserts its keys; the TS config test always supplies `socket_group:'xinas-api'`; and the L1 manual smoke both omits the field *and* runs the agent as a normal user, so `server.ts` takes the `isRoot===false` warn-only branch and passes green while production-as-root mis-chowns. The phase's own verification is structurally incapable of catching the defect.
- **Fix:** Add a rendered-template key-set assertion (ansible/molecule) and a root-mode (or injected-uid) integration test that exercises the getent-fallback branch.

---

## 4. Cross-cutting themes

1. **"Built but not wired" is the dominant failure mode.** The P0 and most P1s are not logic bugs in isolated functions — they are *disconnected* mechanisms. The split-secret store (A), the `pendingReconcile` set (F), `pollIntervalMs` (F), the captured `#collectors` map (J), and the `socket_group` field (KL) are all *implemented* but never activated by the config field / driver / consumer that would make them live. The producer side and the consumer side each landed correctly; the connecting hop was repeatedly the casualty.

2. **The test suite was shaped around the gaps, not through them.** Every confirmed P0/P1 is invisible to the 459 unit + 5 e2e tests because the fixtures encode the *wrong* shape that makes the broken code pass: e2e inlines the agent token into `config.json` (hiding A1); e2e/schema tests assert only kinds that *are* in OBSERVED_KINDS (hiding E/J1); I-phase fixtures bake `export_path` onto the Share (hiding I1); KL's smoke runs non-root and omits the field (hiding the P0). This is the single most important systemic finding: **no test renders an Ansible template or drives a real producer-shaped value end-to-end.** The recurring P2 "tests are seed-and-echo / never render the template" is the leading indicator of the P0/P1 class.

3. **Inbound schema-validation strictness is a sharp edge.** The type-only validator strips `required` but keeps `enum`/`const` and fail-closes the *whole batch* on any single bad delta or unknown kind. Combined with per-kind batching at boot, one rejected kind (ExportRule) poisons its co-batched real kinds (NfsSession). The design is defensible but the OBSERVED_KINDS list must be kept exhaustively in sync with what collectors emit, and out-of-enum probe values are an unguarded batch-kill risk (P2, E).

4. **Intermediate-shape vs public-schema name collisions are accumulating as adapter debt.** Disk, ExportRule, NfsSession observed values diverge from their identically-named public read schemas (B/E/G P2s), relying on type-only validation passing vacuously. This is intentional and documented, but the `export_path` vs `path` confusion (I1) is exactly the failure that this naming collision invites — a maintainer assumed the observed and desired shapes shared a field they don't.

5. **`observed_at` required on non-agent-emitted kinds** (Share, NfsProfile, XiraidArray) and `metadata` required while the producer never sets it (G P2) rely on the api stamping fields before any consumer validates the full kind. Currently fine because inbound validation is type-only and the KV layer injects metadata, but it is a standing assumption worth a single tracking note.

---

## 5. Spec/plan coverage gaps (specced/planned, not built or only stubbed)

- **Steady-state observation refresh** (debounce flush + poll backstop + reconcile consumption) — specced in §Flow A/C/D, *not built* (F P1s ×3). After boot, a quiet node's observed state is permanently static and outage-recovery never fires. This is the largest behavioral gap.
- **Collector-error → degraded mapping** — specced §668/§312/§702, *not built* (J P1). The agent computes it; the api ignores it.
- **`XiraidArray` and `managed_files` stub deferral rows** — specced (spec 271: "every observation kind is a public schema… including managed_files"), built as collectors but *rejected by the validator* (E/J P1), so the `_stub` deferral row never persists; `managed_files` has no schema in api-v1.yaml at all.
- **`last_publish_error` on `agent.health` + structured drop log** — specced line 674, *not built* (F P2): retry exhaustion discards `lastStatus` with a `// omitted for test simplicity` comment. For a root daemon, the missing drop-log is the operator's only window into silent batch loss.
- **dbus subscription for the systemd collector** — intentionally stubbed (`start()` is a commented-out stub; `dbus-native` dep is orphaned, D P2). This is an *accepted* deferral (spec §coverage #8) but currently *forces* the degraded state in convergence (the trigger for J P1), so it is coupled to a real bug.
- **`/users` and `/groups` `?limit`** — declared in the contract (QueryLimit), *ignored* by the handlers (I P2): contract-vs-impl divergence.

---

## 6. Carried-forward items (confirmed / refined)

| Item | Verdict |
|------|---------|
| **(a) 8 collector↔probe adapters as debt** | **Confirmed, refine to a tracking note.** Real (NFS double-parse, intermediate-shape renames, mount_unit_state field reuse). Mostly benign P2 debt — *except* it is the breeding ground for I1's `export_path`/`path` confusion. Keep as debt but add a single doc mapping observed-shape ↔ public-schema field names per kind. |
| **(b) `pollIntervalMs` backstop poll driver unwired** | **Confirmed P1, NOT a deferral.** This is finding F2/F3 — promote out of "carried-forward" and into the FIX-FIRST set. Spec mandates it; nothing reads `pollIntervalMs`; event-only and no-event kinds go stale after boot. |
| **(c) ProtectSystem=strict-vs-full on the agent unit** | **Confirmed accepted deviation, leave as-is.** Documented and justified against ADR-0002. Not a defect. (Distinct from the MDWE P1 on the same unit, which *must* be fixed.) |
| **(d) `observed_at` required on Share/NfsProfile/XiraidArray** | **Confirmed standing assumption, low risk.** Safe while inbound validation is type-only and the api stamps the field. Add one tracking note; revisit if validation tightens. |
| **(e) Heartbeat bootstrap-event suppression** | **Confirmed intentional, leave as-is.** The `#bootstrapped` flag suppressing the first offline→live event is a documented, sound H-review fix. Not a defect. |
| **(f) I6 join O(shares×rules)** | **Confirmed, acceptable at S0/S1 scale, leave as debt.** Note this is moot until I1 is fixed (the join currently returns `[]` for all real shares). After the fix, the O(n×m) cost is real but bounded by small cardinalities. |

---

## 7. Top 5 recommended next actions (prioritized)

1. **Fix the P0 socket-group break (KL).** Add `socket_group` to the agent config template + a `xinas_agent_socket_group: xinas-api` default, and add a rendered-template key-set assertion. Without this, nothing downstream works on a real node — the heartbeat never connects.

2. **Close the observation-path rejections (E/J).** Add `XiraidArray`, `managed_files`, `inventory`, **and `ExportRule`** to `OBSERVED_KINDS` with type-only validators for the schema-less kinds. This is one fix resolving two phase findings and prevents NFS-session data loss via batch fail-close. Add an e2e assertion that `GET /api/v1/arrays` returns the deferral `_stub` after boot.

3. **Wire steady-state publishing (F).** Add the debounce flush timer, the per-collector `pollIntervalMs` poll loop, the 5-min backstop reconcile, and make the loop consume `pendingReconcile`. These four are one coherent change to the publisher/convergence and together restore live observation + outage recovery. While here, populate `last_publish_error` and log retry-exhaustion drops.

4. **Fix the read-path join key (I) and the degraded mapping (J).** Change both joins to `share.spec.path` and re-seed tests with the real Share shape. Wire collector-error → `degraded` in `#computeState()` and restore `simulateDegraded()`. Both are small, high-value correctness fixes on already-shipped read/heartbeat surfaces.

5. **Activate the split-secret token + drop MDWE, then add the missing template/integration tests (A/KL).** Emit `internalTokensPath` in the api config template; drop `MemoryDenyWriteExecute=true` from the agent unit to match the api unit. Critically, add the **rendered-template and root-mode integration tests** that were absent across A and KL — this is the structural gap that let the P0 and three P1s ship green, and it must be closed so the fixes above can't silently regress.
