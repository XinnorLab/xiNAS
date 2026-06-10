# S3 — Real NFS executor (shares · nfs-profiles · idmapd)

> First **real** PlanProvider + Executor pair on the S2 task engine. Replaces the
> inert `reference.echo` proof with imperative, per-verb NFS export management.
> Reuses the existing `xinas-nfs-helper` daemon as the privileged file-writer.

**Status:** design (brainstormed 2026-06-05; revised after review — see §12). Extends
`s2-task-envelope-spec.md`. Companion plan: `docs/plans/2026-06-05-s3-nfs-executor-plan.md`.

**Cross-refs:** `s2-task-envelope-spec.md` (engine), `adr/0002-agent-privilege-model.md`
(api unprivileged / agent root), `adr/0004-task-engine.md` (SQLite tasks/leases),
**`adr/0005-nfs-profile.md` (the authoritative NFS effective-config targets — see §3.4/§6)**,
`docs/MCP/spec-nfs-helper.md` (helper wire contract — extended here),
`docs/config-history/specs.md` (checksum targets — extended here),
`docs/Storage/fs-shares-management-spec.md` §4 (behavior contract).

---

## 1. Scope & goals

Make the NFS desired-state surface **real** through the S2 engine: a request to
add/change/remove an NFS export, tune the NFS service profile, or set the idmapd
domain runs as a tracked task (plan → apply → dispatch → execute → progress →
terminal) with freshness, per-resource leasing, and rollback.

**In scope (full NFS surface, per the brainstorm):**
- `share.create` / `share.update` / `share.delete`
- `nfs-profile.update` (mutable fields: threads, rdma, service_policy) — **note the
  ADR-0005 weight, §3.4; this phase is a candidate to split out, §12.**
- `nfs-idmap.set` (idmapd `Domain=`)

**Out of scope (YAGNI / deferred):** ExportGroup mutation (its only mutable field
`service_ip_ids` is Phase-1 HA); NfsProfile readOnly-in-Phase-0 fields (`v3_locking`,
`v4_recovery`); quotas + active-session management; a desired-state reconcile/drift
controller (xiNAS has none — see §5, Model R).

---

## 2. Topology — who does what

```
REST client ─▶ xinas-api (unprivileged)
                 │  routes/nfs-mutate.ts  (POST/PATCH/DELETE)
                 │  plan/providers/nfs.ts (PlanProvider per kind; uses lib/nfs-exports)
                 │  tasks/engine.ts       (apply txn: desired write + leases + task)
                 ▼  task.begin(task_id, kind, spec=RAW request spec, plan)  [agent UDS]
              xinas-agent (root)
                 │  task/nfs-executor.ts  (Executor per kind; recompiles via lib/nfs-exports)
                 ▼  add_export / update_export / remove_export /
                    render_nfs_profile / set_idmapd_domain   [helper UDS]
              xinas-nfs-helper (root, Python)
                 ▼  atomic write + lock
              /etc/exports · /etc/nfs/nfsd.conf + ADR-0005 defaults · /etc/idmapd.conf
                 +  exportfs -r / service reload|restart
```

- The agent **already** calls the helper for reads (`NfsCollector` → `list_exports` /
  `list_sessions`); the executor **reuses that same UDS client** for writes — no new transport.
- The helper stays the **sole writer** of NFS config files. This work **adds two helper
  ops**: `set_idmapd_domain` (§6.1) and an ADR-0005-correct `render_nfs_profile` (§6.2,
  replacing the legacy `fix_nfs_conf`→`/etc/nfs.conf` path that ADR-0005 supersedes).
- **The api dispatches the RAW request spec** (per S2/T9b — `tasks.spec` is the raw
  operation input, forwarded verbatim; `plan_hash`/`input_hash` are over the raw spec).
  The **agent executor recompiles** the helper payload from that raw spec via the shared,
  layer-neutral **`src/lib/nfs-exports.ts`** (§4). The api PlanProvider imports the *same*
  module to compute the plan `diff` preview — one compile implementation, two importers
  (api for preview, agent for the authoritative apply). The agent re-reads live
  `list_exports` at execute time so an update's option merge is against current reality,
  not a plan-time snapshot.

---

## 3. The five operations

Each kind = one PlanProvider (registered on `PlanEngine`) + one Executor (registered on
`ExecutorRegistry`), mirroring `reference.echo`. Rollback is one inverse helper op.

**The S2 freshness/lease contract is split (engine extension N0, §5.1)** because for NFS
the *desired* resource and the *observed* resource have different identities:
- `affected_resources` (public `ResourceRef[]`, surfaced in the Plan/Task) — the **desired**
  resource(s) the change concerns; the apply txn desired-revision-checks each and (by
  default) leases each. NFS desired kinds (`Share`, `NfsProfile`) are in the public enum;
  the observed kinds (`ExportRule`, `nfs_idmap`) are **not**, so they must NOT appear here.
- `observed_freshness_ref?` (**internal** ApplyPlan field) — `{kind,id,revision}` of the
  **observed** resource to TOCTOU-pin (e.g. `ExportRule/enc(path)`, `nfs_idmap/snapshot`).
  Replaces S2's implicit "pin `observed_revision_expected` against `affected_resources[0]`."
- `lease_resources?` (**internal**, optional) — overrides the lease set when it differs
  from `affected_resources` (only `nfs-idmap.set` needs this; see §3.5).

**ExportRule observed-id encoding (fixes a latent S0/S1 bug, review P1-3/P2).** The collector
sets the `ExportRule` id to the **absolute** export path (`/mnt/data`), but
`isValidObservedId` (`internal/observed.ts`) **rejects** ids that start with `/`, end with
`/`, contain `//`, or have a `.`/`..` segment — so `ExportRule` upserts are rejected today
and never reach KV (the `Share.status.exports[]` join is silently empty). N0b fixes this
with a **canonicalize-then-strip** encoding:
- `enc(path)` = **canonicalize first** — collapse repeated `/`, drop any trailing `/`,
  resolve `.`, reject any `..` (export paths are kernel-normalized absolute paths, so this
  is realistically a no-op, but it MUST run so trailing-slash / `//` inputs can't produce an
  invalid id) — **then strip the single leading `/`** (`/mnt/data` → `mnt/data`,
  `/mnt//data/` → `mnt/data`). `dec(id)` = `'/' + id`. The bare root export `/` → empty id →
  **rejected at validation** (you do not NFS-export `/`).
- The canonical absolute path is stored at **`value.spec.export_path`** (where the live
  `Share`→`ExportRule` join already reads it — `api/routes/nfs.ts`), NOT a top-level
  `value.export_path`.
- The **collector**, the **read-time join**, and the **freshness pin** all key on `enc(path)`.
  Every `observed_freshness_ref` below is `{ ExportRule, enc(path), rev }`.

**`NfsProfile` has no observed producer (review P1-4).** No collector emits `NfsProfile`
(the `Kind` union excludes it; the API reads profiles from **desired** only). So
`nfs-profile.update` pins the **desired** `NfsProfile` revision (a normal
desired-revision-check on `affected_resources`), **not** an observed pin — and N7 must add
the `status.effective_files` producer (§3.4).

| kind | route | affected (lease, public) | freshness pin | helper apply | rollback | risk |
|---|---|---|---|---|---|---|
| `share.create` | `POST /shares` | `Share/{id}` | observed `ExportRule/enc(path)` | `add_export` | `remove_export` | `non_disruptive` |
| `share.update` | `PATCH /shares/{id}` | `Share/{id}` | observed `ExportRule/enc(path)` | `update_export` | `update_export(prior)` | `changing_access` |
| `share.delete` | `DELETE /shares/{id}` | `Share/{id}` | observed `ExportRule/enc(path)` | `remove_export` | `add_export(prior)` | `changing_access` |
| `nfs-profile.update` | `PATCH /nfs-profiles/default` | `NfsProfile/default` | **desired** `NfsProfile/default` | `render_nfs_profile` (ADR-0005) | `render_nfs_profile(prior)` | restart→`changing_access`, else `non_disruptive` |
| `nfs-idmap.set` | `PATCH /nfs-idmap` | *(none)* — lease `NfsIdmap/snapshot` | observed `nfs_idmap/snapshot` | `set_idmapd_domain` | `set_idmapd_domain(prior)` | `non_disruptive` |

### 3.1 `share.create`
- **Plan:** validate the raw spec (path absolute; `clients` non-empty; each
  `ShareClient.options` non-empty; `fsid` present); read observed `ExportRule/enc(path)` —
  already exported → **blocker** `EXPORT_PATH_IN_USE`. `affected_resources=[Share/{id}]`;
  `observed_freshness_ref={ExportRule, enc(path), rev}`. `diff` = the compiled entry (preview,
  via lib/nfs-exports §4).
- **Apply (api txn):** write `/xinas/v1/desired/Share/{id}` (prior=none → recorded for
  revert, §5.2); lease `Share/{id}`; insert task. **`spec` = the raw Share spec** (`{ id,
  path, clients, fsid, security_mode?, sync?, rdma_enabled?, nfs_versions? }`).
- **Executor:** `snapshot_before` → `preflight` (helper reachable; `list_exports`, fail
  `EXPORT_PATH_IN_USE` if appeared) → `apply` (`add_export(compile(spec), create_path:true)`)
  → `verify` (`list_exports` contains it) → `snapshot_after`. Compile via lib/nfs-exports.
- **Rollback:** `remove_export(path)` (idempotent). api reverts the desired Share write.

### 3.2 `share.update`
- **Plan:** require existing desired `Share/{id}`; read observed `ExportRule/enc(path)` for
  the prior rules; merge the PATCH into the Share spec. Warning (not blocker)
  `ACTIVE_NFS_SESSIONS` if observed `NfsSession`s exist on the path.
  `observed_freshness_ref={ExportRule, enc(path), rev}`.
- **Apply:** patch desired Share (prior recorded); **`spec`** = the patched raw Share spec.
- **Executor:** `update_export(path, compile(spec).clients)`; **rollback**
  `update_export(path, prior_rules)` — the prior rules read at preflight from live
  `list_exports` (captured into stage state) so rollback restores exactly what was there.

### 3.3 `share.delete`
- **Plan:** require existing desired Share. Warning `ACTIVE_NFS_SESSIONS`. The on-disk
  directory is **not** removed (mgmt spec §4.6). `observed_freshness_ref={ExportRule, enc(path), rev}`.
- **Apply:** delete desired Share row (prior recorded); **`spec`** = `{ id, path }`.
- **Executor:** preflight captures the live entry; `remove_export(path)` (`NOT_FOUND` →
  treated as already-done); **rollback** `add_export(captured_prior_entry)`.

### 3.4 `nfs-profile.update` — **ADR-0005, not `fix_nfs_conf`**
ADR-0005 §"Effective-config rendering" is authoritative: on Ubuntu 22.04/24.04 the NFS
service config is **not** `/etc/nfs.conf`; the effective targets are `/etc/nfs/nfsd.conf`,
`/etc/default/nfs-kernel-server`, `/etc/modprobe.d/lockd.conf`, and `/etc/default/nfs-common`,
each checksummed into `status.effective_files`. The legacy helper `fix_nfs_conf`
(→`/etc/nfs.conf`) is **wrong here** and is not used.
- **Plan:** read desired `NfsProfile/default`; **absent → plan against the ADR-0005
  default spec with an absence pin (`revision: 0`)** and the desired mutation creates the
  row (create-on-first-update — a fresh install has no desired profile row). The PATCH may
  set `threads.count`, `rdma.enabled`, `service_policy.*`. **restart iff any *changed*
  dimension's policy is `restart`** (e.g. `on_thread_count_change:'restart'` and `threads`
  changed); `reload`/`none` → no restart. risk = `changing_access` iff a restart is implied,
  else `non_disruptive`. **Freshness pins the *desired* `NfsProfile/default` revision** (a
  normal desired-revision-check) — there was no observed `NfsProfile` at design time
  (review P1-4); the N7.2 collector later added one, but the §3.4 desired-pin rule stands.
- **`status.effective_files` producer — DECIDED (N7.2): option (a), an observed
  `NfsProfile` collector**, scoped to `effective_files` checksums (+ `observed_at`) of the
  four ADR-0005 files. Rationale: matches the architecture every other observed kind uses
  (collector → `/internal/v1/observed` → KV → read-time fold), and catches **manual** edits
  to the effective files — ADR-0005's stated drift-detection intent — which helper-returned
  checksums (option b) never could. `status.running` (live thread count / rdma listening /
  active versions) was deferred beyond S3 and **landed in the S3.1 follow-up**: the same
  observed `NfsProfile` collector also reads the nfsd runtime via `/proc/fs/nfsd/`
  (`threads`, `versions`, `portlist` — absent when nfsd is down → `running` omitted) and the
  GET fold surfaces it alongside `effective_files`. Only `nfs-profile.update` via **PATCH**
  is built in S3; the OpenAPI `PUT /nfs-profiles/default` (full replace) stays stubbed.
- **Apply:** patch desired NfsProfile (prior recorded); **`spec`** =
  `{ profile: <the merged full spec>, prior_profile: <the pre-patch spec> }` — the restart
  flag is **derived** (never stored) by the shared `deriveProfileServiceAction` in both
  layers (api for the plan's risk, agent for the helper flag).
- **Executor:** `render_nfs_profile(profile, <derived restart>)` (§6.2) — the helper renders
  the four ADR-0005 files atomically + reloads/restarts per the flag; **rollback**
  `render_nfs_profile(prior_profile, <same derived restart>)` (the prior spec rides IN the
  operation spec, not refetched).

### 3.5 `nfs-idmap.set`
- **Imperative against observed** (no desired row — idmapd is observed-only).
- **Plan:** validate `domain` (must contain a `.`, mgmt spec §4.8). Read observed
  `nfs_idmap/snapshot` for the prior domain (rollback target). risk `non_disruptive`.
  `affected_resources=[]` (no public desired resource); **`lease_resources=[{NfsIdmap,
  snapshot}]`** (serialize concurrent sets); `observed_freshness_ref={nfs_idmap,snapshot,rev}`.
- **`expected_revision` rule (review P2-6).** OpenAPI requires `expected_revision` on every
  apply. Since `affected_resources=[]`, it does **not** bind a desired row; instead the plan
  returns the **observed `nfs_idmap/snapshot` revision** as the plan's revision, the client
  echoes it as `expected_revision`, and the apply txn validates it via `observed_freshness_ref`
  (drift → `CONFLICT(plan_stale)`). A fresh-install with no observed idmap yet → revision `0`.
  This is the general rule for any observed-only operation, not an idmap special-case.
- **Apply:** **no desired write** (`desired_mutations=[]` → `desired_rollback` null);
  **`spec`** = `{ domain }`.
- **Executor:** preflight captures the prior domain; `set_idmapd_domain(domain)`; **rollback**
  `set_idmapd_domain(prior_domain)` (no-op + `FAILED_MANUAL_RECOVERY_REQUIRED` note if the
  prior domain was absent).

---

## 4. Shared compile logic — `src/lib/nfs-exports.ts`

Layer-neutral pure module (like `lib/canonical-json.ts`), **imported by both** the api
PlanProvider (preview `diff`) and the agent Executor (authoritative apply). Unit-tested
in isolation. Encodes deterministic option ordering so a re-plan/recompile of the same
Share is byte-stable.

**Works from the real OpenAPI schema** (corrected after review): `ShareClient = { pattern,
options[] }` — a **raw** per-client option list; `sync`, `security_mode`, `rdma_enabled`
are **Share-level**. There are no structured per-client `access`/`squash`/`sec` fields.

```
compileShareToExportEntry(share):
  for each client in share.spec.clients:
    opts = [...client.options]                       // user-provided raw list (authoritative)
    // Fold Share-level defaults in only when the client did not already specify them:
    if no sync/async token in opts:  opts.push(share.spec.sync ?? 'async')
    if share.spec.security_mode && security_mode !== 'sys' && no 'sec=' in opts:
        opts.push('sec=' + security_mode)
    if no 'subtree_check'/'no_subtree_check' in opts: opts.push('no_subtree_check')  // hardening default
    opts = stableOrder(dedupe(opts))                 // deterministic for plan_hash
    → { host: client.pattern, options: opts }
  → { path: share.spec.path, clients: [...] }
```

The exact fold/precedence rules (which Share-level field can override a client token,
and the canonical option order) are **fixed in N1 with unit tests**; the contract is:
client `options[]` are authoritative, Share-level fields are defaults that never silently
contradict an explicit client token, and the output is deterministic. There is **no
"wizard-managed vs extra_opts" split** (that was a TUI concept; the OpenAPI model already
carries the full raw option list, so an update's `options[]` is taken as-is).

Note: `fsid` is validated (integer) and uniqueness-enforced at plan time but is **not yet
rendered** into the compiled export entry — deferred, because emitting `fsid=` would change
host behavior vs the installer baseline; revisit with Phase-1 HA (see §11).

---

## 5. Engine extensions (N0) — the real-mutation foundation

S2's engine wrote only **tasks** and bound only the columns a `plan_only` row already has.
A real mutation needs THREE generic additions, all reusable by every future real executor
(arrays/fs/network), landed first in N0. **The single source of all three is the
`PlanProvider.preflight` result**, persisted on the `plan_only` task and reconstructed at
apply — so they are **durable across plan→apply** and **bound by `plan_hash`** (review P1-1/P1-2).

### 5.1 Durable plan-binding (so the new plan-side fields actually persist)
Today `plan()` persists only `affected_resources` + scalar `state_revision_expected` +
`plan_hash` as columns, and `toApplyPlan()` rebuilds `ApplyPlan` from those columns — the
new plan-side outputs have **nowhere to live**. N0 adds:
- **`PlanResult` + `ApplyPlan` gain** `observed_freshness_ref?: {kind,id,revision}`,
  `lease_resources?: ResourceRef[]`, and `desired_mutations?: DesiredMutation[]` (§5.3).
- **Migration `004` adds `tasks.plan_binding TEXT`** — a JSON blob holding exactly these
  plan-side outputs, written by `plan()` onto the `plan_only` row.
- **`plan_hash` is extended to include them** (the `engine.ts` hash inputs) so a divergent
  re-plan is detected at apply.
- **`toApplyPlan()` reconstructs them** from `plan_binding`, not just the legacy columns.
- **Backward compatible:** `reference.echo` emits none → `plan_binding` null/`{}` →
  unchanged. Public `affected_resources` stays desired-only (public `ResourceRef` kinds),
  so the OpenAPI `ResourceRef` enum is **not** changed.

### 5.2 Freshness/lease contract split (desired≠observed identity)
The apply txn (`tasks/engine.ts`) consumes the §5.1 fields:
- `observed_freshness_ref` present → the observed TOCTOU check reads
  `/xinas/v1/observed/<kind>/<id>` and rejects `CONFLICT(plan_stale)` on drift, **instead
  of** the S2 default (`observed_revision_expected` vs `affected_resources[0]`). Lets
  desired (`Share`) and observed (`ExportRule`) differ in identity.
- `lease_resources` present → that is the lease set; else lease `affected_resources`
  (current S2 behavior). Lets `nfs-idmap.set` lock a resource that is not a public
  affected resource.

### 5.3 Desired-mutation input contract + **Model R** (revert on failure)
Today `ApplyArgs = { plan, applyReq }` and the apply txn inserts only task + leases. The
desired KV write is a NEW, **explicit** input — not per-route prose (review P1-2):
- **`DesiredMutation = { key, value } | { key, delete: true }`.** The PlanProvider declares
  the operation's `desired_mutations` (e.g. `{ key:'/xinas/v1/desired/Share/{id}', value:
  <share spec> }`); they ride in `plan_binding` (§5.1) so they survive to apply.
- The api is the sole writer of both desired KV and tasks **in one SQLite db**, so the apply
  txn applies `desired_mutations` to KV **atomically** with the lease + task insert, and
  records each mutated key's **prior value** into the migration-`004` **`tasks.desired_rollback
  TEXT`** column (JSON `[{ key, prior_value }]`, `prior_value:null` = key was absent).
- **Model R — a failed task leaves no trace.** `TaskEngine.failBeforeChange` (begin rejected
  → no host change) and the progress receiver's **terminal-failed** handler (host changed
  then executor-rolled-back) both revert `desired_rollback`; terminal-success keeps the write.
  Symmetry: executor undoes the **host**; api undoes the **intent**. `nfs-idmap.set` declares
  no `desired_mutations` → `desired_rollback` null → undo is purely the executor's `set_idmapd_domain(prior)`.

Model D (durable drift) was rejected: xiNAS has no desired-state reconcile loop to clean up
an orphan desired row (S2's `reconcile()` is task-crash recovery, not desired↔observed convergence).

> **Migration `004` therefore adds two columns:** `plan_binding` (plan-time, on the
> `plan_only` task) and `desired_rollback` (apply-time, on the apply task).

### 5.4 Keep the new columns internal (public-serialization strip)
`plan_binding` and `desired_rollback` are **internal-only**, exactly like the S2 `spec`
column — the public `Task` schema (api-v1.yaml) declares none of them. Today's task
serialization spreads the whole row and strips only `spec` (the S2 final-review fix):
`renderTask` (`routes/tasks.ts`, REST) and the SSE watch **snapshot frame** (same file).
**N0 extends both strips to remove `spec`, `plan_binding`, AND `desired_rollback`**, with a
REST + SSE regression test (mirror the existing `spec`-leak test). Without this they leak a
requester's raw desired payload + every mutated KV key on every `GET /tasks` and watch
snapshot — the same exposure class the S2 fix closed for `spec`.

---

## 6. New / corrected helper ops

Both added to `xiNAS-MCP/nfs-helper/`, dispatched in `nfs_helper.py`, documented in
`docs/MCP/spec-nfs-helper.md`, with pytest coverage. Both mirror the existing
lock + atomic `mkstemp`+`os.replace` pattern. **No `Requires-Rebuild` trailer** (review
P2-5): per CLAUDE.md the helper is **MCP-server Python code** deployed by the `xinas_mcp` /
`nfs_helper` role (`copy` of the whole `nfs-helper/` dir, so new files are auto-included),
and the update flow's `git pull` + `xinas-nfs-helper` restart already picks up code-only
changes — adding a trailer here just trains users to click past an unnecessary Ansible
warning. A trailer would only be warranted if the role/unit **deployment** changed (it does
not). The whole work package is therefore code-only for the update flow.

### 6.1 `set_idmapd_domain { domain }`
- validate `domain` non-empty + contains a `.` (else `INVALID_ARGUMENT`);
  `fcntl.LOCK_EX` on `/run/xinas-nfs-idmap.lock`; read `/etc/idmapd.conf`, replace the
  `^\s*Domain\s*=.*$` line under `[General]` (insert/create section if absent); atomic
  write; **no restart** (nfs-idmapd re-reads).

### 6.2 `render_nfs_profile { spec, restart }` (ADR-0005)
- renders the **four ADR-0005 effective files** (`/etc/nfs/nfsd.conf`,
  `/etc/default/nfs-kernel-server`, `/etc/modprobe.d/lockd.conf`, `/etc/default/nfs-common`)
  from the NfsProfile spec; each atomic + locked; returns the per-file checksums (feeds
  `status.effective_files`); reloads or restarts `nfs-server` per `restart`.
- **This is the heavy piece of the work package** (four-file renderer + service policy);
  it is the main reason §3.4 is a candidate to split into its own phase (§12).
- Supersedes the legacy `fix_nfs_conf`→`/etc/nfs.conf` behavior for the profile path.

---

## 7. api-v1.yaml + config-history deltas (corrected after review)

OpenAPI (`openapi` CI gate must stay green):
- **`Share` POST/PATCH/DELETE** already exist (stubbed `EXECUTOR_UNAVAILABLE`) — make real.
- **`PATCH`/`PUT /nfs-profiles/default`** already exist (ADR-0005 §"API endpoints") — make real.
- **Add `PATCH /api/v1/nfs-idmap`** (currently GET-only): body `{ domain: string }`,
  `mode=plan|apply`. This is the **only** missing route.
- **Keep `expected_revision`** in apply bodies — `ApplyRequest.required` still lists it.
- Confirm `Share` POST assigns/validates `id` + `fsid` (server-assigned id if omitted;
  `fsid` required + unique) — N5 detail.

Config-history (`xinas_history/collector.py` `CHECKSUM_TARGETS`, `docs/config-history/specs.md`):
- **Add `/etc/idmapd.conf`** so the §8 snapshot backstop for `nfs-idmap.set` is real
  (today it is absent — review P2-a). N2.
- Reconciling the existing `nfs_conf:/etc/nfs.conf` target to the ADR-0005 files is a
  **related cleanup flagged in §11**, done with N2/N3 if cheap, else tracked separately.

---

## 8. Error model

Reuses the S2 error codes — no new ones.

| condition | outcome |
|---|---|
| `task.begin` rejected / agent unreachable (dispatch) | `FAILED_BEFORE_CHANGE`, leases released, **desired reverted**, route 503/`EXECUTOR_UNAVAILABLE` |
| helper unreachable / refused / timeout (preflight) | `FAILED_PARTIAL_ROLLED_BACK` — the runner has no fail-before-change path for stage failures; rollback runs and **no-ops** (the stash markers show nothing was changed), leases released, **desired reverted** on terminal-failed |
| helper `INVALID_ARGUMENT` (bad path/domain) | plan → 400; preflight → `FAILED_BEFORE_CHANGE` |
| helper `INTERNAL` mid-`apply` (e.g. `exportfs -r` hard error) | executor rollback → `FAILED_PARTIAL_ROLLED_BACK`; api reverts desired |
| `exportfs -s` "Failed to stat" warning | non-fatal — emit a stage warning, continue |
| rollback helper op itself fails | `FAILED_MANUAL_RECOVERY_REQUIRED` + remediation hint |
| observed drift since plan (`observed_freshness_ref`) | `CONFLICT(plan_stale)` from the apply txn |
| lease held by another task | `CONFLICT(lease_held)` |

`xinas_history` snapshots the relevant config file `snapshot_before`/`snapshot_after` as
the deep backstop beneath the executor's inverse-op rollback — **valid only for files in
config-history scope**: `/etc/exports` (shares) today; `/etc/idmapd.conf` once N2 adds it;
the ADR-0005 profile files once §7's config-history reconciliation lands. Where a file is
not yet in scope, the executor's prior-state rollback is the sole undo (noted per op).

---

## 9. Testing

- **Unit — `lib/nfs-exports.ts`:** option folding from `ShareClient.options[]` + Share-level
  `sync`/`security_mode`; `no_subtree_check` default; `sec=` only when non-`sys`; determinism.
- **Unit — PlanProviders:** per kind — `diff`, risk, blockers (`EXPORT_PATH_IN_USE`),
  warnings (`ACTIVE_NFS_SESSIONS`), `affected_resources` (desired only) + `observed_freshness_ref`
  (+ `lease_resources` for idmap). Fake `KvStore`.
- **Unit — Executors:** per kind — apply recompiles via the lib + calls the right helper op;
  rollback issues the exact inverse from captured prior state; helper-error mapping. Fake
  helper client.
- **Unit — N0 engine:** `observed_freshness_ref` drift → `plan_stale`; `lease_resources`
  override leases the right resource; Model R revert on `failBeforeChange` + terminal-failed.
- **Python — helper:** `set_idmapd_domain` (rewrite/insert/atomic/validate/lock);
  `render_nfs_profile` (the four ADR-0005 files, checksums, restart policy).
- **Integration (supertest):** `POST /shares` plan then apply with a mock helper → 202;
  idempotency-conflict; `plan_stale` 409; lease 409; `expected_revision` honored.
- **e2e:** stub nfs-helper on the socket — real api+agent: `share.create`→exported→success;
  forced helper `INTERNAL`→rollback→`FAILED_PARTIAL_ROLLED_BACK`, export gone, desired reverted;
  `nfs-idmap.set`→domain changed.

---

## 10. Decomposition (for the plan)

- **N0** — engine foundation (§5), the largest phase: migration `004` (**`plan_binding`** +
  **`desired_rollback`**); `PlanResult`/`ApplyPlan` gain `observed_freshness_ref` +
  `lease_resources` + `desired_mutations`; `plan()` persists them in `plan_binding` and folds
  them into `plan_hash`; `toApplyPlan()` reconstructs from `plan_binding`; apply-txn
  freshness/lease split + **applies `desired_mutations` to KV recording `desired_rollback`**;
  `failBeforeChange` + terminal-failed revert. **Extend the task REST `renderTask` + SSE
  snapshot strip to drop `spec` + `plan_binding` + `desired_rollback`** (§5.4) + regression
  test. Reference tasks unaffected (null/absent).
- **N0b** — fix the **ExportRule observed-id encoding** (review P1-3/P2): collector emits the
  **canonicalize-then-strip** `enc(path)` id + stores the canonical path at
  **`value.spec.export_path`**; the `Share`→`ExportRule` read-time join keys on `enc(path)`.
  Unblocks `Share.status.exports[]` and the share freshness pin.
- **N1** — `lib/nfs-exports.ts` compile-from-`options[]` + unit tests.
- **N2** — helper `set_idmapd_domain` + add `/etc/idmapd.conf` to config-history
  `CHECKSUM_TARGETS` + spec-nfs-helper.md + pytest. **No rebuild trailer** (§6, review P2-5).
- **N3** — agent NFS helper-client write wrappers (reuse collector's client) +
  `task/nfs-executor.ts` (`share.*` + `nfs-idmap.set`) + register in `wiring.ts` + unit tests.
- **N4** — `plan/providers/nfs.ts` (`share.*` + `nfs-idmap.set`) declaring
  `affected_resources`/`observed_freshness_ref`/`lease_resources`/`desired_mutations` +
  register on `PlanEngine` + tests.
- **N5** — `routes/nfs-mutate.ts` (shares + idmap) + api-v1.yaml `PATCH /nfs-idmap`
  (the only missing route) + integration tests + `openapi` green.
- **N6** — e2e (stub helper): share lifecycle · rollback · idmap.
- **N7 — `nfs-profile.update` (the ADR-0005 phase, §3.4/§6.2):** helper `render_nfs_profile`
  (four-file renderer) + the **`status.effective_files` producer** (observed-NfsProfile
  collector or helper-returned checksums, §3.4) + provider (desired-revision pin) +
  executor + route (PATCH/PUT already exist) + tests. **Sequenced last and splittable** (§12) — the
  heavy piece; the shares + idmap surface above is independently shippable without it.

---

## 11. Open items / risks

- **N7 `status.effective_files` producer** — RESOLVED: decided + built in N7.2 (collector);
  `status.running` RESOLVED in the S3.1 follow-up (§3.4).
- **N0b ExportRule id encoding blast radius** — confirm no other consumer relies on the raw
  absolute-path `ExportRule` id before switching to `enc(path)` (grep collector + join + any
  test fixtures; the kind has no public REST endpoint, so the surface is small).
- **config-history `/etc/nfs.conf` → ADR-0005 targets:** RESOLVED in the S3.1 follow-up —
  the four ADR-0005 effective files added to `CHECKSUM_TARGETS` (additively; `nfs_conf`
  kept for backward-compat and residual drift signal on hosts that still carry the file).
- **Synthetic `NfsIdmap/snapshot` lease:** confirm `LeaseManager.acquire` tolerates a
  `(resource_kind, resource_id)` with no backing desired row (it keys on strings — verify N3/N4).
- **observedSegment casing:** observed singleton is `/xinas/v1/observed/nfs_idmap/snapshot`
  (snake_case per ADR-0003); `observed_freshness_ref.kind` must resolve to `nfs_idmap` (N4).
- **Active-session on update/delete** kept a **warning**, not a blocker — revisit if
  operators want a hard gate.
- **Share `id`/`fsid` assignment** on `POST /shares` — N5.
- **`fsid` not rendered into the export entry** (§4): validated + uniqueness-enforced only;
  emitting `fsid=` would change host behavior vs the installer baseline — revisit with
  Phase-1 HA.

---

## 12. Review revisions (2026-06-05)

This spec was revised after a review that caught six issues; all were verified valid:
- **P1** `affected_resources` overloaded — split into public `affected_resources` (desired,
  leased + revision-checked) + internal `observed_freshness_ref` + optional `lease_resources`
  (§3, §5.1, N0). The public `ResourceRef` enum is untouched (observed kinds stay internal).
- **P1** executor payload conflicted with S2 — the api now forwards the **raw spec** (T9b);
  the agent recompiles via the shared `lib/nfs-exports.ts` (§2, §3, §4).
- **P1** compile didn't match the schema — rewritten to work from `ShareClient.options[]` +
  Share-level `sync`/`security_mode`; no wizard/extra_opts split (§4).
- **P1** ADR-0005 regression — `nfs-profile.update` renders the ADR-0005 files via a new
  `render_nfs_profile` helper op, **not** `fix_nfs_conf`→`/etc/nfs.conf` (§3.4, §6.2).
- **P2** false idmapd snapshot backstop — N2 adds `/etc/idmapd.conf` to config-history; the
  §8 claim is now scoped to files actually tracked (§7, §8).
- **P2** OpenAPI delta misstated — `nfs-profiles` PATCH/PUT already exist; the only missing
  route is `PATCH /nfs-idmap`; `expected_revision` stays required (§7).

**Decision (2026-06-05):** §3.4/N7 (`nfs-profile.update` + the ADR-0005 four-file renderer)
is materially larger than the original "reuse `fix_nfs_conf`" assumption, but **stays
within S3 as N7 (last)** — sequenced after the independently-shippable shares + idmapd
surface (N0–N6) so the renderer's weight doesn't block the rest.

### Second review pass (2026-06-05) — six more, all verified valid
- **P1** N0 fields weren't durable across plan→apply — N0 now adds **`tasks.plan_binding`**
  (migration `004`), persists `observed_freshness_ref`/`lease_resources`/`desired_mutations`
  there, folds them into `plan_hash`, and rebuilds them in `toApplyPlan()` (§5.1).
- **P1** Model R lacked a desired-mutation input contract — added explicit
  **`DesiredMutation` + `desired_mutations`** as a plan-declared, apply-applied surface; the
  apply txn writes KV + records `desired_rollback` atomically (§5.3).
- **P1** `ExportRule/{path}` is rejected by `isValidObservedId` (latent S0/S1 bug) — defined
  the **`enc(path)` encoded id** used by collector + join + freshness; fixed in N0b (§3).
- **P1 (N7)** no observed `NfsProfile` producer — `nfs-profile.update` now pins the
  **desired** `NfsProfile` revision; N7 adds the `status.effective_files` producer (§3.4).
- **P2** wrong rebuild trailer — **removed**; helper code-only changes need none per CLAUDE.md
  (the update flow restarts `xinas-nfs-helper`); tag would be `xinas_mcp`/`nfs_helper` anyway (§6).
- **P2** `expected_revision` undefined for `nfs-idmap.set` — defined: it carries the **observed
  `nfs_idmap` revision**, validated via `observed_freshness_ref` (the general observed-only
  rule), `0` on a fresh install (§3.5).

### Third review pass (2026-06-05) — three more, all verified valid
- **P1** raw `ExportRule/{path}` still in §3.1–3.3 — all three per-op pins now read
  `{ ExportRule, enc(path), rev }`, consistent with the table + the encoding note (§3).
- **P2** `enc(path)` underspecified + wrong path field — now **canonicalize-then-strip**
  (collapse `//`, drop trailing `/`, resolve `.`, reject `..`, reject bare `/`), and the
  canonical path is stored at **`value.spec.export_path`** (where the live join reads it),
  not `value.export_path` (§3).
- **P1** new internal columns leak publicly — N0 now explicitly strips `spec`, `plan_binding`,
  and `desired_rollback` from the REST `renderTask` + SSE snapshot, with a regression test
  (§5.4, N0).
