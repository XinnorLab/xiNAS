# xiNAS S12 — Durable desired-state adoption (design spec)

**Status:** design (2026-06-13). Implements ADR-0015. Closes the "durable
desired-KV adoption" follow-on ADR-0013 §4 deferred. Companion plan (written
next, after spec approval): `docs/plans/2026-06-13-s12-durable-adoption-plan.md`.

**Goal.** Let a targeted `config.rollback` optionally ADOPT the restored
config as the new desired state, so a restore survives the next `apply` instead
of being overwritten. Adoption is the **desired-state twin** of S11's
file-level restore: S11 restores observed *files*, S12 restores desired
*intent*. Default (no `adopt`) behavior is byte-for-byte S11.

This spec assumes ADR-0015's verified facts: `/etc/exports` omits `fsid` +
Share-level defaults (reverse-parse is lossy → capture the desired rows
instead); desired KV is API-only while snapshots are created agent-side;
`desired_mutations` are the existing atomic API-side desired-write seam and are
declared at PLAN time; and the API records each task's `snapshot_after` id as a
first-class column.

---

## 1. Scope

### In scope
- **Capture:** on each successful mutating task, an API-side
  `snapshot-desired` KV payload (the desired rows of the in-scope kinds) keyed
  by the task's `snapshot_after` id. No agent/Python change.
- **Adoptable gate:** `ConfigSnapshot.adoptable` read-enrichment (payload
  presence), mirroring S11 `restorable`.
- **Adopt:** an opt-in `adopt: boolean` on the `config.rollback` request; the
  targeted provider branch emits `desired_mutations` that replace the desired
  rows of the restored domains to exactly the captured set.
- **Clients:** api-v1 deltas, catalog description, TUI Restore "make durable".

### Out of scope (deferred / excluded)
- **Storage topology** (`XiraidArray`/`Pool`/`Filesystem`) — desired untouched
  by adopt (ADR-0013 scope).
- **`NfsIdmap`** — no desired model, so it stays S11 observed-recovery even
  under adopt (its `/etc/idmapd.conf` bytes are restored by S11, not adopted).
- **Baseline adopt** — `adopt: true` with `to: 'baseline'` is rejected at plan
  (`INVALID_ARGUMENT`): baseline reset already re-runs Ansible from desired.
- **Pre-S12 snapshots** — no `snapshot-desired` payload → `not_adoptable`; they
  restore as S11 observed-recovery.
- **Separate `config.adopt` verb** — superseded by the atomic flag (ADR-0015).

## 2. Component map

```
 apply success (api/tasks/engine.ts) ──► capture: put /xinas/v1/snapshot-desired/{snapshot_after}
 config-history read (api) ───────────► enrich ConfigSnapshot.adoptable (payload presence)
 POST /config-history/rollback {to,reason,adopt} ─► config-rollback provider
        adopt=true ► read snapshot-desired/{to} ► desired_mutations (put captured / delete orphans)
        apply txn (api/tasks/engine.ts) ► atomically put/delete desired rows + restore files
 TUI snapshot_detail ► Restore ► "make durable (adopt)" ► plan_apply_wait {adopt:true, dangerous}
```

## 3. Part 1 — capture (API-side, keyed by snapshot id)

### 3.1 KV payload
- **Key:** `/xinas/v1/snapshot-desired/{snapshot_id}`.
- **Value:** `{ captured_at: <iso>, snapshot_id, kinds: { Share: Row[],
  ExportGroup: Row[], NfsProfile: Row[], NetworkInterface: Row[] } }`, where
  each `Row` is `{ id, spec }` copied from the desired row at capture time.
- **In-scope kinds:** `Share`, `ExportGroup`, `NfsProfile`, `NetworkInterface`
  (the kinds whose rendered files S11 restores). A `KINDS` constant pins the
  list in one place.

### 3.2 Capture hook (P2 #4 — exact placement)
- The hook is the **`terminal` case of the progress-event handler**
  (`api/tasks/progress.ts`), the same handler that sets `snapshot_after` from
  `event.snapshot_id` and, on non-success, calls `revertDesired()`. On
  `finalState === 'success'` AND `operation_kind !== 'config.rollback'`, an
  injected `deps.captureDesired(event.snapshot_id)` reads the in-scope desired
  rows (`state.list({ prefix: '/xinas/v1/desired/<Kind>/' })`) and `put`s the
  payload keyed by `event.snapshot_id` (the `snapshot_after` id, carried
  directly on the terminal event — no task re-read needed).
- **Synchronous, before lease-release.** Capture runs inline in the handler
  before `deps.releaseLeases()` so no queued task's `apply()` (which eagerly
  writes `desired_mutations` — `engine.ts`) can mutate desired KV between the
  snapshot and the capture. Best-effort: a capture failure logs a warning and
  does NOT fail the task (the snapshot is simply not adoptable).
- `operation_kind` for the skip-check is read from the task row (the handler has
  `taskId`).
- **Why skip `config.rollback`:** a NON-adopt restore leaves desired unchanged
  while restoring files (the very drift adopt fixes), so its `snapshot_after`
  desired may NOT render to its files — capturing it would create a
  false-`adoptable` payload that violates the §3.1 invariant. An ADOPT restore's
  desired already equals its target's captured payload, so capturing it is
  redundant. Every other mutating op is safe: a normal NFS/network mutate
  rendered its files from desired, and a non-NFS/network op (RAID/pool/fs) left
  the NFS/network files AND their desired both unchanged (still consistent).
- The invariant (ADR-0015): a `snapshot-desired` payload renders to that
  snapshot's `system/` files, because at success desired KV is the
  post-`desired_mutations` intent the executor just rendered.

### 3.3 GC
- A reconcile sweep (the existing config-history/observed reconcile) drops
  `snapshot-desired/{id}` whose `{id}` is no longer present in observed
  `ConfigSnapshot` rows. Keeps the payload set bounded to live history.

## 4. Part 2 — adopt

### 4.1 Adoptable enrichment (read)
- The config-history read (`api/routes/config-history.ts` projection) sets
  `adoptable: true` on a projected `ConfigSnapshot` iff
  `/xinas/v1/snapshot-desired/{id}` exists. Independent of `restorable` (a
  snapshot can be restorable-but-not-adoptable: pre-S12).

### 4.2 Provider (`api/plan/providers/config-rollback.ts`)
- Request spec widens to `{ to, reason, adopt?: boolean }`.
- `adopt` is ignored for `to: 'baseline'`; `adopt: true` + `to: 'baseline'` →
  `INVALID_ARGUMENT` at preflight.
- In `targetedPlan`, when `adopt: true`:
  - Read `snapshot-desired/{to}`; if the payload is **absent entirely** →
    blocker `not_adoptable`.
  - **Per-domain gating (P1 #1).** Adoption is per domain; a domain is adopted
    iff the captured payload holds ≥1 row of its primary kind (`Share` → NFS,
    `NetworkInterface` → network). A domain whose primary kind is empty in the
    payload is **left untouched** — no puts, no deletes — because S11's
    no-tombstone restore can't remove a live file the target lacked, so deleting
    that domain's desired would create drift, not fix it. This makes the adopt
    set **plan-time derivable from the payload alone** (no apply-time restore set
    — P1 #2): adopt the full captured in-scope set of the adopted domains.
  - For each **adopted** domain, build `desired_mutations`:
    - `put` every captured row of the domain's kinds (NFS: `Share` +
      `ExportGroup` + `NfsProfile`; network: `NetworkInterface`) —
      `{ key: '/xinas/v1/desired/<Kind>/<id>', value: { kind, id, spec } }`;
    - `delete` every CURRENT desired row of those kinds whose id is NOT in the
      captured set (orphan prune) — `{ key, delete: true }`.
  - **Revision pins (P1 #3).** For EVERY put/deleted row, add an
    `affected_resources` entry `{ kind, id, revision }` — the apply freshness
    guard (`api/tasks/engine.ts`) protects a desired row only when its
    `affected_resources` revision is set (the `desired_mutations` apply with
    plain put/delete). Pins: an existing row → its current desired revision; a
    captured row absent now (create) → `revision: 0`; an orphan delete → the
    row's current revision. The `ConfigSnapshot` ref stays in
    `affected_resources` too; the lease stays `ConfigHistory/default`.
  - The `diff` lists every put/delete explicitly so the operator sees exactly
    which desired rows change/delete. `risk_level: 'destructive'`,
    `dangerous_flag_required` (unchanged from the targeted restore).
- Blocker set (targeted): existing `snapshot_not_found`,
  `no_restorable_payload`, `dangerous_flag_required` + new `not_adoptable`
  (only when `adopt: true` and the payload is wholly absent).

### 4.3 Executor / apply
- **No executor change.** The restore stage runs as in S11 (file restore via
  the bridge). The `desired_mutations` are applied by the API apply txn
  atomically with the task, with prior-value `desired_rollback` — so a restore
  failure reverts both files (runner auto-rollback, S11) and intent (existing
  desired_rollback).

### 4.4 Contracts (api-v1.yaml)
- `config.rollback` request body: add `adopt: { type: boolean, default: false,
  description: "Adopt the restored config as desired (durable). Targeted
  restores only." }`.
- `ConfigSnapshot` schema: add `adoptable: { type: boolean }`.

## 5. Clients
- **catalog** (`api/mcp/catalog.ts`): `config_history.rollback` description
  notes the `adopt` option; `requires_mcp_apply` stays `true`.
- **TUI** (`xinas_menu/screens/snapshot_detail.py`): the Restore action gains a
  "make durable (adopt)" path — a second confirm naming that desired rows may be
  DELETED, then `plan_apply_wait` with `{to:<id>, reason, adopt:true}` +
  `dangerous`. The action is offered only when the snapshot is `adoptable`;
  non-adoptable snapshots keep the plain S11 Restore. `adoptable` shown in the
  snapshot detail.

## 6. Testing strategy
- **Capture (TS unit):** a successful mutating task captures
  `snapshot-desired/{event.snapshot_id}` with the in-scope desired rows; a
  failed task does not; `config.rollback`'s own success does not capture;
  capture failure logs but doesn't fail the task. **Timing:** capture reads
  desired KV BEFORE `releaseLeases()` — a test interleaving a queued apply must
  see the pre-drain desired snapshot, not the contaminated one.
- **Adoptable (TS unit):** read projection sets `adoptable` from payload
  presence, independent of `restorable`.
- **Provider (TS unit):**
  - `adopt:true` builds the correct put/delete `desired_mutations` (puts
    captured, deletes orphan) for an adopted domain;
  - **per-domain gating (P1 #1):** a payload with `Share` rows but no
    `NetworkInterface` rows adopts NFS only — current `NetworkInterface` desired
    is NOT deleted (left untouched); the reverse for a network-only payload;
  - **revision pins (P1 #3):** every put/delete carries an `affected_resources`
    entry — current revision for existing rows, `revision: 0` for a captured row
    absent now, current revision for an orphan delete;
  - `not_adoptable` when the payload is wholly absent; `INVALID_ARGUMENT` for
    baseline+adopt; `adopt:false`/absent is byte-for-byte the S11 plan.
- **Apply (TS unit/integration):** the apply txn puts/deletes the desired rows
  guarded by the pinned revisions (a concurrent desired bump → `stale`); task
  failure reverts them via `desired_rollback`.
- **Drift (TS unit):** after adopt, `drift.nfs-exports` + `drift.netplan` are
  clean against the captured/restored state for the **adopted** domains; a
  non-adopted (uncaptured) domain's drift is unchanged by adopt.
- **e2e:** real api+agent — create share A (snapshot S captures desired),
  create share B, restore S with `adopt:true` + dangerous → success; assert
  desired Share B deleted, Share A present, NFS drift clean. Non-adoptable
  snapshot → `not_adoptable` blocker. Baseline+adopt → INVALID_ARGUMENT.
- **TUI (pytest):** the adopt path posts `{to,reason,adopt:true}`+dangerous;
  the non-adoptable snapshot hides the adopt option.

## 7. Decomposition (T0–T8)
- **T0 Contracts:** api-v1 (`adopt`, `adoptable`), KV-path + kind registry
  notes; spec/ADR cross-refs.
- **T1 Capture payload + KINDS constant** (api): the `snapshot-desired` writer
  and row serialization; unit.
- **T2 Capture hook** (`progress.ts` `terminal`-success handler via
  `deps.captureDesired(event.snapshot_id)`): guard rollback-op + best-effort +
  synchronous-before-`releaseLeases`; unit incl. the drain-interleave timing
  test.
- **T3 Adoptable enrichment** (api config-history read): payload-presence join;
  unit.
- **T4 Provider adopt branch** (config-rollback): desired_mutations build,
  blockers, baseline guard; unit.
- **T5 Apply wiring + revert** verification (engine): adopt mutations applied +
  reverted on failure; unit/integration.
- **T6 GC reconcile**: drop orphan `snapshot-desired` blobs; unit.
- **T7 Clients:** catalog description + TUI adopt action; pytest.
- **T8 e2e + runbook + full gate.**

## 8. Open risks
- **Capture timing (P2 #4, resolved).** Capture runs in the `terminal`-success
  handler via `event.snapshot_id`, synchronously before `releaseLeases()` — so
  the desired snapshot can't be contaminated by a queued task's eager
  `desired_mutations`. If a later refactor moves `desired_mutations` off the
  apply-time path or makes lease-release re-entrant, revisit the hook.
- **Tombstone gap (P1 #1, scoped not solved).** A domain the target snapshot
  did NOT capture is left untouched by adopt — S11's no-tombstone restore can't
  remove the now-orphan live file, so adopt can't make that domain clean. The
  drift-clean guarantee is scoped to the captured (adopted) domains; the full
  "removed domain" case waits on the tombstone follow-on.
- **S11 capture completeness.** Adopt's drift-clean claim assumes S11 captured
  every file a domain renders to; a per-share `/etc/exports.d/*` not in
  `CHECKSUM_TARGETS` would be an S11 gap adopt inherits — flag if S11's capture
  set is incomplete.
- **Orphan-delete blast radius.** Adopt deletes desired rows created after the
  snapshot; the plan diff must make this explicit so an operator never adopts a
  stale snapshot blind. Mitigated by `dangerous` + the diff listing deletes +
  the per-row revision pins (a concurrent change → `stale`, forcing a re-plan).
- **GC coupling.** The `snapshot-desired` blob lives outside the Python
  snapshot; the reconcile against observed `ConfigSnapshot` rows is the only
  thing preventing leaks — it must run on the same cadence as snapshot GC.
