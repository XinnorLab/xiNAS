# xiNAS S5 — filesystem adapter: XFS create / mount / unmount / grow / quota / unmanage (design spec)

**Status:** design (2026-06-10; conforms to **ADR-0007**). Completes WS6 on the S2 engine, following the S3/S4 adapter pattern. Implementation plan: `docs/plans/2026-06-10-s5-filesystem-adapter-plan.md`.

**Goal.** Make xiNAS filesystems fully manageable day-2: create (day-1-parity stripe-aligned XFS with external log), mount/unmount (with the WS6 active-share blockers), online grow, quota-mode changes, and unmanage — plus the observe enrichment (`uuid`/`size_bytes`/`free_bytes`/`currently_mounted` become real). All mutations run through plan/apply with the same freshness binding, blocker re-check, and dangerous-gate semantics S4 established.

**Authoritative prior art.** ADR-0007 (this design's contract — identity, schema extension, writability, per-op contracts, the `force` destruction gate); ADR-0006 + the landed S3/S4 adapter (providers/executors/fake-transport patterns, the engine dangerous gate, route freshness binding §S4-4, apply re-check §S4-8); the S0/S1 filesystem collector (id = mount-unit name, status-only rows); the `raid_fs` role (the mkfs command + `.mount` template this spec reproduces).

**Verified integration facts (revised after the S5 review):** observed Filesystem rows have id = unit name, BUT on real hosts they currently carry only `mount_unit_name`/`mount_unit_enabled` — the parser emits `mountpoint`/`backing_device` under a `spec` block that the convergence adapter drops (`{kind, id, status}` passthrough), and no mounted flag is produced anywhere outside fixtures; the S4 array-delete dep walk is therefore fixture-only today (**the ADR-0007 §Observation-normalization prerequisite fixes this first**). The api-v1.yaml schema duplicates `mounted` (required) and `currently_mounted` (optional) — `mounted` becomes canonical, `currently_mounted` is removed. `lib/parse/systemd-unit.ts` parses units and `lib/parse/mountinfo.ts` parses mounts; ExportRule observed rows are keyed by export path; Shares live in desired state (`spec.path`); NfsSessions observed (`spec.export_path`); the **fixture NFS probe returns empty sessions AND exports today** (T4 adds `nfs-sessions.json` + `nfs-exports.json` passthrough so the e2e can prove both unmount blockers); day-1 clamps `log_size` to `blockdev --getsize64 <log_device>` (`_effective_log_size`); the agent unit runs `ProtectSystem=strict` + `ReadWritePaths=/run/xinas /var/log/xinas` + `CapabilityBoundingSet=CAP_CHOWN` — see ADR-0007's audited compatibility table (the one delta: `ReadWritePaths=/etc/systemd/system`, `Requires-Rebuild: xinas_agent`).

---

## 1. Scope

### In scope (S5)
- Shared **`lib/fs/`**: `schema.ts` (spec types + writability metadata), `validate.ts` (per-op rules → ADR-0007 blocker codes), `unit.ts` (systemd path escaping + `.mount` render, day-1 template parity), `derive.ts` (su/sw from observed array geometry).
- **`agent/fs/host.ts`** — the injectable host adapter (`runCommand` + unit-dir I/O): `blkid`, `mkfsXfs`, `growfs`, `writeUnit`/`removeUnit`/`readUnit`, `daemonReload`, `enableNow`/`stop`/`disable`, `readMounts` (reuses `parseMountinfo`), `statfs`, `applyOwnerPolicy`. **`agent/fs/fake-host.ts`** — file-backed fake (fixture mode + e2e): simulated blkid map, units dir, mounted set, op log, deterministic failure hooks.
- **Five providers + executors** (`fs.create`, `fs.mount`, `fs.unmount`, `fs.grow`, `fs.set_quota_mode`) + **unmanage** (`fs.delete`), per the ADR-0007 contracts.
- **Routes**: real `POST /filesystems`, `PATCH /filesystems/{id}` (one-intent dispatch), `DELETE /filesystems/{id}` — out of the stub loop.
- **Observe enrichment**: blkid + statfs + mountinfo cross-ref in the probe (+ fixture support).
- **Contracts (T0)**: `Filesystem.spec` extension, `Filesystem.json` fixture, `fs.*` stub supersession (S2-T0 pattern), blocker-code docs.

### Out of scope
- Mount-option editing beyond quota flags; `owner_policy` live changes; shrink; `xfs_repair`; non-XFS; desired-state reconcile/drift engine (WS9 — the enrichment supplies the observed side only).

---

## 2. Component map (S4 pattern, subprocess transport)

```
   api (unprivileged)                                   agent (root)
   ┌────────────────────────────────────────┐           ┌──────────────────────────────────┐
   │ plan/providers/filesystem.ts (5 kinds + │ task.begin │ task/filesystem-executor.ts      │
   │   unmanage; blockers + su/sw derive)    │ ─────────▶ │   (6 executors over the adapter) │
   │ routes/filesystems.ts (POST/PATCH/DELETE│            │ fs/host.ts  (runCommand seam)    │
   │   one-intent dispatch, §S4-4 binding,   │ ◀───────── │ fs/fake-host.ts (fixture/e2e)    │
   │   §S4-8 filtered re-check)              │  progress  │ probe/filesystem.ts (+blkid,     │
   └───────────────────┬────────────────────┘            │   statfs, mountinfo cross-ref)   │
                       ▼                                  └──────────────────────────────────┘
        lib/fs/{schema,validate,unit,derive}  (shared; unit render == day-1 template)
```

Engine, leases, dangerous gate, SSE — all unchanged S2/S4 machinery.

## 3. Identity, derivation, and the unit render

- `unitNameForMountpoint('/mnt/data') === 'mnt-data.mount'` — full systemd escaping (slash→`-`, leading slash stripped, other specials → `\xNN`; `.`/`-` handling per `systemd-escape -p`), unit-tested against known systemd outputs. The id everywhere.
- `deriveStripe(arraySpec)` → `{ su_kb, sw }` from observed `XiraidArray.spec` (`strip_size_kib`; parity table: raid0→0, raid1→members−1… raid5→1, raid6→2, raid7→3, raid10→members/2, raid50/60/70 → per-group parity × group count). Unknown/underivable → the `stripe_underivable` blocker unless overridden.
- `renderMountUnit(spec)` reproduces the day-1 template: `Requires=`/`After=` the escaped `.device` units for data (and log) devices, `Before=umount.target`, `Conflicts=umount.target`, `[Mount] What/Where/Type=xfs`, `Options=defaults,<mount_options>,logdev=<log_device>?,<quota flag>`, `WantedBy=local-fs.target`.

## 4. Per-operation flows

Engine-side flow per op = S4 verbatim (plan → blockers listed → apply with `expected_revision` binding (`0` for create, current observed otherwise) → filtered re-check → leases → dispatch). The per-op specifics (blockers, risk, stages, rollback) are ADR-0007's §Per-operation contracts — this spec adds only implementation detail:

- **create**: `enriched_spec` carries the fully-resolved mkfs inputs (`label` defaulted, derived `su_kb`/`sw`, `unit_name`, rendered-unit preview in the diff) so the executor needs no KV. Executor `preflight` runs `blkid` on the data device: existing filesystem + `force !== true` → fail before change (the host-side teeth of the gate; the engine already required `dangerous` for `force` plans). The `mkfs` stage resolves the **effective log size** = `min(log_size, blockdev --getsize64 <log_device>)` — the day-1 `_effective_log_size` clamp (host adapter `blockdevSize`; fake host seeds device sizes; a clamped-case golden is mandatory). Rollback is live-state: stop/disable if active, remove the unit if present, `daemon-reload`; mkfs is never reverted (device left formatted, unmanaged).
- **mount/unmount**: thin executors over `enableNow`/`stop`+`disable` with mountinfo verification; unmount's rollback restarts the unit. The dependency walk (sessions + ExportRules at/under the mountpoint, shares in blast radius) lives in the provider; the host-level guard is the umount `EBUSY` failure itself.
- **grow**: `xfs_growfs <mountpoint>`; verify via `statfs` (size not smaller than before — captured in preflight); rollback no-op.
- **set_quota_mode**: preflight captures the current unit text (per-run WeakMap, the S4-T6 pattern); rewrite `Options=` quota flag → `daemon-reload` → `systemctl restart` → verify mounted with the flag in effective options. Rollback: write back the captured unit + `daemon-reload` + restart.
- **unmanage**: preflight captures the unit text; `stop`+`disable` (must already be unmounted per plan blocker — defense in depth), remove unit, `daemon-reload`. Rollback: rewrite the captured unit + `daemon-reload`.

## 5. Observe enrichment

`probe/filesystem.ts` additionally, per unit: `blkid <What=>` → `uuid`, `label` (absent cleanly when the device has no fs); when mountinfo lists the mountpoint → **`mounted: true`** (the canonical schema flag, post-T1 normalization), `effective_mount_options`, `statfs` → `size_bytes`/`free_bytes`. Fixture probes: `filesystems.json` entries may carry these fields (passthrough), and the NFS fixture probe gains **`nfs-sessions.json` + `nfs-exports.json`** passthrough in the collector's real shapes — without it the fixture NFS probe always returns empty and the e2e could pass with the milestone's active-share blockers untested. Failures of individual enrichment commands degrade that field, not the row.

## 6. Error model — reuse only

Blocker codes: ADR-0007's set (`mountpoint_invalid`, `mountpoint_taken`, `backing_array_not_found`, `backing_device_in_use`, `log_array_not_found`, `stripe_underivable`, `backing_array_unhealthy`, `dependent_share_active`, `mountpoint_exported`, `fs_not_mounted`, `fs_mounted`, `dangerous_flag_required`). PATCH multi-intent → `INVALID_ARGUMENT`; identity-field PATCH → `UNSUPPORTED` (`fs_identity_immutable`). No new `ErrorCode`s, no new `details.reason` values (S4's `observed_revision_stale`/`create_expects_revision_zero`/`dangerous_flag_required` reused as-is).

## 7. Contract revisions (T0)

1. `api-v1.yaml`: extend `Filesystem.spec` (ADR-0007 table: `label`, `log_device`, `log_size`, `sector_size`, `su_kb`, `sw`, `force`); document the PATCH one-intent rule in `updateFilesystem`'s description; `Filesystem.json` fixture.
2. Stub supersession (S2-T0 pattern): remove all five `fs.*` from `STUB_METHOD_NAMES` + `REQUIRED_STUB_METHODS`; mark them superseded in the s0s1 RPC table (mutations dispatch via `task.begin`). `filesystems.list`/`mounts.list` on-demand read stubs stay (WS12).
3. ADR-0007 + this spec stay in sync with the contract.

## 8. Testing strategy

- **Unit:** `lib/fs/unit` (escaping golden vs systemd-escape outputs; render golden vs the day-1 template incl. logdev/quota options); `lib/fs/derive` (per-level table incl. 50/60/70 groups); `lib/fs/validate` (per-op blocker tables); host adapter (command construction goldens via a recorded fake `runCommand`); fake host behaviors; all six executors over the fake host (success / preflight-fail / mid-fail rollback / blkid-existing-fs vs `force` / quota unit-restore / EBUSY unmount rollback); providers (blockers, leases incl. backing+log arrays, enriched specs, dep walks over desired Shares + observed Sessions/ExportRules); probe enrichment (fixture blkid/statfs).
- **Route:** POST/PATCH/DELETE plan+apply happy paths; `force`-without-`dangerous` → 412 at apply (engine); multi-intent PATCH → 400; identity PATCH → 422; revision binding → 412 `observed_revision_stale`.
- **e2e** (extends the S4 harness — fake xiRAID + fake host wired in fixture mode): create on `/dev/xi_data` (array from the fake xiRAID) → mounted + observed with uuid/size; unmount blocked by a seeded session → 412; unmount clean → success; grow; quota change; unmanage; create with `force` over an existing blkid-seeded fs without `dangerous` → 412, with → success.
- **Gate:** unit + e2e + contracts + tsc + lint all green (final task).

## 9. Decomposition (T0–T12)

| # | Task |
|---|------|
| T0 | Contracts: spec extension + `mounted` canonicalization (drop `currently_mounted` from the schema) + fixture + `fs.*` stub supersession + s0s1 table + PATCH one-intent docs. |
| T1 | **Observation normalization** (ADR-0007 prerequisite): parser → status-only (mountpoint/backing_device/fs_type/mount_options under `status`), convergence passthrough fixed, collector emits the full set incl. `mounted`; the S4 delete provider + its tests/e2e fixtures migrate `currently_mounted` → `mounted`. TDD. |
| T2 | `lib/fs/unit.ts` — escaping + render. TDD vs systemd-escape goldens + the day-1 template. |
| T3 | `lib/fs/derive.ts` + `lib/fs/schema.ts` + `lib/fs/validate.ts` (per-op rules). TDD. |
| T4 | **Agent-unit compatibility delta** (ADR-0007 table): `ReadWritePaths=/etc/systemd/system` in its own commit with `Requires-Rebuild: xinas_agent`; the Ubuntu hardware smoke checklist lands in the plan/spec. |
| T5 | `agent/fs/host.ts` (+`blockdevSize`) + `fake-host.ts` (command goldens incl. the clamped-log case, op log, failure hooks, device sizes). TDD. |
| T6 | Observe enrichment (`probe/filesystem.ts`): blkid/statfs/mountinfo → uuid/size/free/`mounted`/effective options; fixture passthrough for `filesystems.json` extras + **`nfs-sessions.json` + `nfs-exports.json`** (the e2e's blocker seeds). TDD. |
| T7 | Create provider + `POST /filesystems` route (stub-loop exit). TDD. |
| T8 | Create executor (blkid gate, mkfs with the log clamp, unit, mount, owner_policy; live-state rollback). TDD. |
| T9 | Mount/unmount providers + PATCH route skeleton (one-intent dispatch + binding + re-check). TDD. |
| T10 | Mount/unmount executors (EBUSY rollback) + grow/quota providers. TDD. |
| T11 | Grow + quota executors (unit-capture rollback) + unmanage (provider + DELETE route + executor). TDD. |
| T12 | e2e (incl. BOTH unmount blockers: `dependent_share_active` via seeded sessions AND `mountpoint_exported` via seeded exports; clamped-log mkfs asserted via the fake op log) + the full verification gate. |

## 9b. Freshness binding note (post-churn-fix)

The PATCH/DELETE routes bind `expected_revision` to the CURRENT observed
Filesystem row revision (the S4 §4 convention). This is sweep-stable only
because the observed handler dedupes unchanged re-pushes (s0s1 spec, Flow
A step 3) — without that dedupe every ~60 s filesystem sweep bumped the
revision and staled in-flight plans. Observed revisions now move only on
content change.

## 10. Open questions / risks

- **Agent-unit compatibility** — RESOLVED into ADR-0007's audited table + plan T4 (`ReadWritePaths=/etc/systemd/system`, `Requires-Rebuild: xinas_agent`; mountpoint dirs are PID1-created; `/dev` writable under `strict` with `PrivateDevices` unset; `CAP_CHOWN` suffices). **Residual:** no systemd in dev/CI — the delta is proven by the audit + fake-host coverage + a written Ubuntu hardware smoke checklist (create→mount→grow→quota→unmount→unmanage) to run on a lab node before WS6 is declared shipped.
- **blkid exit codes** — blkid exits 2 on "no filesystem"; the adapter must distinguish that from real failures (T5 golden).
- **`systemctl is-enabled` vs ActiveState** — the probe's current `mount_unit_state` source predates this work; the enrichment's mountinfo cross-ref becomes the authoritative `mounted` regardless.
- **Owner policy at create** — applied once after first mount (`chown`/`chmod` via the adapter); failure degrades to a stage failure (rollback unmounts + unmanages), not a partial half-owned state worth special-casing.

### Ubuntu hardware smoke checklist (the T4 residual — run on a lab node before WS6 is declared shipped)

On an Ubuntu 22.04/24.04 node with xiRAID + the rebuilt `xinas_agent` role (`Requires-Rebuild` from the T4 commit):

1. `POST /filesystems` (backing + log array volumes, `log_size` larger than the log array) → task `success`; `systemctl cat <unit>` matches the rendered template; `xfs_info` shows the day-1 geometry (su/sw, external log, **clamped** log size); the mountpoint directory was created by PID1 (no agent mkdir in the journal).
2. `systemctl is-enabled <unit>` → `enabled` (the enable symlink was written under `/etc/systemd/system` by the sandboxed agent).
3. Export a path + open a client session → unmount apply → 412 with `dependent_share_active`/`mountpoint_exported`; tear down → unmount succeeds.
4. `PATCH {grow:true}` after growing the backing array → `xfs_growfs` reflected in `statfs`.
5. `PATCH {quota_mode:'pquota'}` → unit `Options=` rewritten, remount visible to a connected client (expected disruption), `mount | grep prjquota`.
6. `DELETE` → unit gone, `daemon-reload` clean, data intact (`blkid` still shows the fs).
7. Journal shows no EACCES/EPERM from the agent throughout (sandbox sufficiency).
