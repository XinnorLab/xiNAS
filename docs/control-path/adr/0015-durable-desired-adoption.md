# ADR-0015: Durable desired-state adoption (capture desired KV, adopt on restore)

- **Status:** accepted
- **Date:** 2026-06-13
- **Stream:** S12 (S11 follow-on)
- **Supersedes / amends:** completes the "durable desired-KV adoption"
  follow-on ADR-0013 §4 deferred; amends ADR-0013's "observed recovery"
  contract to add an opt-in durable path. Does NOT change baseline reset.

## Context

S11 (ADR-0013) ships targeted restore as **observed recovery**: it writes a
snapshot's captured config-file bytes back to disk and reconverges services,
but does NOT touch desired KV. So the existing drift checks fire, and the next
`apply` for that domain RE-RENDERS from desired and overwrites the restore.
The deferred follow-on (this ADR) makes a restore optionally ADOPT the restored
config as the new desired state so it survives. Four facts, each **verified
against the code**, shape the decision:

1. **Reversibility is asymmetric.** The netplan render↔parse round-trip is
   ~bijective (`lib/net/render.ts` ↔ `lib/parse/netplan.ts`): a restored
   `99-xinas.yaml` yields every desired `NetworkInterface` field
   (`addresses`, `mtu`, `pbr_table_id`). But `/etc/exports` does NOT contain
   `fsid` (a REQUIRED `Share` field, user-supplied, never rendered into the
   file) nor the Share-level defaults (`nfs_versions`, `rdma_enabled`,
   `quota_policy`, the `security_mode`/`sync` defaults that fold into
   per-client options non-bijectively). Reconstructing desired `Share` rows
   from the restored file alone is therefore lossy, and a changed `fsid`
   disrupts NFSv4 client mounts. **Reverse-parse is rejected; capture the
   desired rows instead.**

2. **Desired KV is API-only; snapshots are created agent-side.** `api-server`
   opens the state store (`api/server.ts`); `agent-server` does not. The
   agent's `TaskRunner` creates `snapshot_before` + `snapshot_after` on every
   mutating task via `bridge.snapshotCreate`, but the agent cannot read desired
   KV.

3. **Desired writes already have a clean API-side seam.** Plan providers emit
   `desired_mutations` (`{key,value} | {key,delete}`); the apply txn applies
   them atomically with the task + lease insert, capturing each key's prior
   value into `desired_rollback` so a failed task reverts the intent
   (`api/tasks/engine.ts`).

4. **Adopt needs the captured rows at PLAN time.** `desired_mutations` are
   declared in the plan and persisted plan→apply, so the captured desired rows
   must be readable **API-side at plan time** — without a cross-process hop to
   the agent/Python snapshot store.

The API already records the `snapshot_after` id per task as a first-class
column (`api/tasks/store.ts`, persisted from the agent's `stage_succeeded`
detail) — so the API can bind a captured-desired payload to the snapshot a task
produced, in-process.

## Decision

Adoption is a **desired-state rollback** — the twin of S11's file rollback.
S11 restores observed *files*; S12 restores desired *intent*. Two parts:
capture desired KV per snapshot, and an **opt-in** adopt on restore that
re-asserts it. Default behavior (no adopt) is exactly S11.

### 1. Capture — API-side, in KV, keyed by snapshot id

The capture hook is the **`terminal` progress-event handler**
(`api/tasks/progress.ts`) — the same place that records `snapshot_after` and,
on non-success, reverts the desired-KV write. On `finalState === 'success'`
(and `operation_kind !== 'config.rollback'`), the handler writes the desired
rows for the in-scope kinds to `/xinas/v1/snapshot-desired/{event.snapshot_id}`
(the terminal event carries the `snapshot_after` id directly) as a single
payload (`{ captured_at, kinds: { Share: [...], ExportGroup: [...], NfsProfile:
[...], NetworkInterface: [...] } }`, each the desired row's `spec`/`id`). It runs
**synchronously in that handler**, reading desired KV at that instant — before
lease-release lets any queued task's apply mutate desired — so the payload
matches the snapshot.

- **Entirely API-side: no agent / Python / bridge change.** The agent's
  existing snapshot creation is reused unchanged; the API adds a desired blob
  keyed to the resulting snapshot id.
- **Captured only on `snapshot_after` of a successful mutating task whose
  `operation_kind` is not `config.rollback`** — the one moment desired KV
  (post-eager-`desired_mutations`) renders to the snapshot's `system/` files.
  The invariant: *a `snapshot-desired` payload renders to that snapshot's
  `system/` files.* A non-adopt restore breaks that invariant (it restores
  files without changing desired — the very drift adopt fixes), so
  `config.rollback` is skipped; an adopt restore's desired already equals its
  target's payload (redundant). `snapshot_before`, baseline, installer, and
  pre-S12 snapshots have no payload and are **not adoptable**.
- **GC:** the blob is reconciled against observed `ConfigSnapshot` rows — when a
  snapshot leaves history (Python-side GC), the API drops its `snapshot-desired`
  key. Orphan blobs are pruned on the same sweep.

### 2. Adoptable gate (read enrichment)

The config-history read enriches each projected `ConfigSnapshot` with
`adoptable: boolean` = presence of its `snapshot-desired` payload (an API-side
join, mirroring S11's `restorable`). Surfaced in `api-v1` + the TUI.

### 3. Adopt — opt-in flag on `config.rollback`

The `config.rollback` request gains `adopt?: boolean` (default `false`). When
`adopt: true` on a **targeted** restore (`to !== 'baseline'`):

- **Provider** (`targetedPlan`): reads the target's `snapshot-desired` payload
  from KV; blocks with `not_adoptable` when the payload is **absent entirely**
  (pre-S12 / non-success snapshot). Adoption is **per domain, gated on the
  payload** — a domain is adopted iff the payload captured ≥1 row of its primary
  kind (`Share` → NFS, `NetworkInterface` → network). For each adopted domain it
  builds `desired_mutations` to make that domain's desired EXACTLY the captured
  set:
  - `put` each captured row of the domain's kinds (NFS: `Share` +
    `ExportGroup` + `NfsProfile`; network: `NetworkInterface`);
  - `delete` current desired rows of those kinds NOT in the captured set
    (orphans created after the snapshot) — S11 restored the single per-domain
    file (`/etc/exports`, `99-xinas.yaml`) WHOLESALE, so dropping the orphans'
    intent matches the restored file.
  - A domain **absent from the payload is left untouched** (no puts, no
    deletes): a no-tombstone restore (S11) does not remove a live file the
    target lacked, so deleting that domain's desired would *create* drift, not
    fix it — that case waits on the tombstone follow-on. `NfsIdmap` (no desired
    model) and storage topology (`XiraidArray`/`Pool`/`Filesystem`) stay out of
    scope (ADR-0013).
- **Revision pins (TOCTOU).** Every put/deleted desired row gets an
  `affected_resources` entry with a revision pin, because the apply freshness
  guard (`api/tasks/engine.ts`) protects a desired row ONLY when its
  `affected_resources` revision is set — the `desired_mutations` themselves
  apply with plain put/delete: an existing row → its current desired revision;
  a captured row absent now (create) → revision `0`; an orphan delete → the
  row's current revision.
- **Risk:** stays `destructive` + `dangerous_flag_required` (adopt changes
  intent and can DELETE desired rows). The plan `diff` lists the
  `desired_mutations` so the operator sees exactly which desired rows change or
  delete before confirming.
- **Executor unchanged:** restore writes files (S11); the API apply txn applies
  the `desired_mutations` atomically via the existing path. On task failure the
  mutations revert through the existing `desired_rollback`.
- **Adopt without a usable restore:** `adopt: true` with `to === 'baseline'` is
  rejected at plan (`INVALID_ARGUMENT`) — baseline reset already re-runs
  Ansible from desired; there is nothing to adopt.

### 4. Result — drift goes clean for the adopted domains

After an adopt, the **adopted domains'** desired renders to the restored files,
so `drift.nfs-exports` / `drift.netplan` go clean for those domains and the next
`apply` REINFORCES the restore. A domain the target did NOT capture is left
untouched — it stays whatever it was (observed-recovery drift if the restore
left it diverged); making *that* clean requires removing a now-orphan live file,
which is the tombstone follow-on (the OTHER S11 deferral), not this slice. The
"drift clean" guarantee is therefore scoped to the captured domains. Without
`adopt` (the default), behavior is byte-for-byte S11 — observed recovery with
surfaced drift and the "re-apply to persist" warning.

This also assumes S11 captures the COMPLETE set of files each domain renders to;
if S11's `CHECKSUM_TARGETS` miss a rendered file, adopt inherits that gap (see
Consequences).

### 5. Clients

- **api-v1:** `config.rollback` request adds `adopt`; `ConfigSnapshot` adds
  `adoptable`.
- **catalog:** `config_history.rollback` description notes adopt; it is a
  `planApply` entry, so `requires_mcp_apply` stays **true**.
- **TUI:** the snapshot Restore action gains a "make durable (adopt)" choice →
  `plan_apply_wait` with `adopt: true` + `dangerous`, using the S10
  `TaskWaitDialog`; the confirm names that desired rows may be deleted.

## Alternatives considered

- **Reverse-parse files → desired rows** — rejected: lossy for NFS (`fsid` +
  Share-level defaults absent from `/etc/exports`; `fsid` churn breaks NFSv4
  mounts). Network alone would be reversible, but a uniform capture model is
  simpler and lossless for both.
- **`desired/` payload inside the Python snapshot (agent-couriered)** —
  rejected for this slice: adopt needs the rows at PLAN time (API-side), which
  would force a new plan-time agent RPC (or bloat observed rows with the blob).
  An API-side KV payload keeps capture and adopt both in-process with zero
  agent/Python change. The cost — snapshot self-containment + unified GC — is
  handled by reconciling the blob against observed `ConfigSnapshot` rows.
- **Separate `config.adopt` verb (staged restore→review→adopt)** — considered;
  the atomic `adopt: true` flag was chosen (one operation / consent / audit
  row; the plan preview still shows the mutations and risk before confirm).
- **Merge instead of replace** — rejected: orphan desired rows not in the
  restored file keep drift alive; replace-within-restored-domains is required
  for "durable."

## Consequences

- Each successful mutating task writes a small `snapshot-desired` blob (a
  handful of rows); its lifetime is tied to snapshot history via GC.
- **Only post-S12 success snapshots are adoptable.** Older snapshots restore as
  S11 observed-recovery — an honest gate (`adoptable: false`), exactly like
  S11's `restorable`.
- **Adopt can DELETE desired rows** (shares/interfaces created after the
  snapshot) to make desired consistent with the restored files — destructive to
  intent, gated by `dangerous` and shown in the plan diff.
- **Adopt is per-domain.** A domain the target did not capture is left
  untouched; the "drift clean" guarantee is scoped to the captured domains.
  Cleanly adopting a snapshot that REMOVED a domain (so a now-orphan live file
  must be deleted) needs the tombstone follow-on — the other S11 deferral.
- **Adopt inherits S11's capture completeness.** The drift-clean claim holds
  only if S11's `CHECKSUM_TARGETS`/`collect_system_files` captured every file a
  domain renders to. If S11 misses a rendered file (e.g. a per-share
  `/etc/exports.d/*`), restore won't bring it back and adopt can't make that
  domain clean — a captured-set gap to close in S11, not S12.
- Storage topology stays out of scope; adopting a snapshot never touches
  RAID/pool/filesystem desired, and `NfsIdmap` (no desired model) stays
  observed-recovery.
- The capture keys on `snapshot_after`; `snapshot_before` and externally-created
  snapshots are not adoptable by construction.
- `config.rollback` route, the `ConfigHistory/default` lease, the destructive
  dangerous-gate, and the local-runner connectivity argument all carry over from
  S11 unchanged.
