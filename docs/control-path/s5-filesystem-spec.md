# xiNAS S5 — filesystem adapter: XFS create / mount / unmount / grow / quota / unmanage (design spec)

**Status:** design (2026-06-10; conforms to **ADR-0007**). Completes WS6 on the S2 engine, following the S3/S4 adapter pattern. Implementation plan: `docs/plans/2026-06-10-s5-filesystem-adapter-plan.md`.

**Goal.** Make xiNAS filesystems fully manageable day-2: create (day-1-parity stripe-aligned XFS with external log), mount/unmount (with the WS6 active-share blockers), online grow, quota-mode changes, and unmanage — plus the observe enrichment (`uuid`/`size_bytes`/`free_bytes`/`currently_mounted` become real). All mutations run through plan/apply with the same freshness binding, blocker re-check, and dangerous-gate semantics S4 established.

**Authoritative prior art.** ADR-0007 (this design's contract — identity, schema extension, writability, per-op contracts, the `force` destruction gate); ADR-0006 + the landed S3/S4 adapter (providers/executors/fake-transport patterns, the engine dangerous gate, route freshness binding §S4-4, apply re-check §S4-8); the S0/S1 filesystem collector (id = mount-unit name, status-only rows); the `raid_fs` role (the mkfs command + `.mount` template this spec reproduces).

**Verified integration facts:** observed Filesystem rows are status-only with id = unit name; the probe reads `/etc/systemd/system/*.mount` + `systemctl is-enabled`; `lib/parse/systemd-unit.ts` parses units and `lib/parse/mountinfo.ts` parses mounts; ExportRule observed rows are keyed by export path (`/xinas/v1/observed/ExportRule/<path>`); Shares live in desired state (`spec.path`); NfsSessions observed (`spec.export_path`); no legacy fs tool exists; the agent has no generic host-command runner yet (the probes' `execFile` pattern is the precedent).

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

- **create**: `enriched_spec` carries the fully-resolved mkfs inputs (`label` defaulted, derived `su_kb`/`sw`, `unit_name`, rendered-unit preview in the diff) so the executor needs no KV. Executor `preflight` runs `blkid` on the data device: existing filesystem + `force !== true` → fail before change (the host-side teeth of the gate; the engine already required `dangerous` for `force` plans). Rollback is live-state: stop/disable if active, remove the unit if present, `daemon-reload`; mkfs is never reverted (device left formatted, unmanaged).
- **mount/unmount**: thin executors over `enableNow`/`stop`+`disable` with mountinfo verification; unmount's rollback restarts the unit. The dependency walk (sessions + ExportRules at/under the mountpoint, shares in blast radius) lives in the provider; the host-level guard is the umount `EBUSY` failure itself.
- **grow**: `xfs_growfs <mountpoint>`; verify via `statfs` (size not smaller than before — captured in preflight); rollback no-op.
- **set_quota_mode**: preflight captures the current unit text (per-run WeakMap, the S4-T6 pattern); rewrite `Options=` quota flag → `daemon-reload` → `systemctl restart` → verify mounted with the flag in effective options. Rollback: write back the captured unit + `daemon-reload` + restart.
- **unmanage**: preflight captures the unit text; `stop`+`disable` (must already be unmounted per plan blocker — defense in depth), remove unit, `daemon-reload`. Rollback: rewrite the captured unit + `daemon-reload`.

## 5. Observe enrichment

`probe/filesystem.ts` additionally, per unit: `blkid <What=>` → `uuid`, `label` (absent cleanly when the device has no fs); when mountinfo lists the mountpoint → `currently_mounted: true`, `effective_mount_options`, `statfs` → `size_bytes`/`free_bytes`. Fixture probe: `filesystems.json` entries may now carry these fields (passthrough). Failures of individual enrichment commands degrade that field, not the row.

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
| T0 | Contracts: spec extension + fixture + `fs.*` stub supersession + s0s1 table + PATCH one-intent docs. |
| T1 | `lib/fs/unit.ts` — escaping + render + (re)parse helpers. TDD vs systemd-escape goldens + the day-1 template. |
| T2 | `lib/fs/derive.ts` + `lib/fs/schema.ts` + `lib/fs/validate.ts` (per-op rules). TDD. |
| T3 | `agent/fs/host.ts` + `fake-host.ts` (command goldens, op log, failure hooks, fixture-dir state). TDD. |
| T4 | Observe enrichment (`probe/filesystem.ts` + fixture passthrough): blkid/statfs/mountinfo → uuid/size/free/currently_mounted/effective options. TDD. |
| T5 | Create provider + `POST /filesystems` route (stub-loop exit). TDD. |
| T6 | Create executor (blkid gate, mkfs, unit, mount, owner_policy; live-state rollback). TDD. |
| T7 | Mount/unmount providers + PATCH route skeleton (one-intent dispatch + binding + re-check). TDD. |
| T8 | Mount/unmount executors (EBUSY rollback). TDD. |
| T9 | Grow + quota providers (PATCH intents) . TDD. |
| T10 | Grow + quota executors (unit-capture rollback for quota). TDD. |
| T11 | Unmanage provider + DELETE route + executor (unit-capture rollback). TDD. |
| T12 | e2e + the full verification gate. |

## 10. Open questions / risks

- **systemctl under the agent sandbox** — `systemctl` talks to systemd over its private UNIX socket/dbus (AF_UNIX — already allowed); `daemon-reload`/`enable` also need write access under `/etc/systemd/system` (the unit's `ProtectSystem=strict` documented deviation already grants the agent its write paths — VERIFY the unit's `ReadWritePaths` covers `/etc/systemd/system` during T3; if not, that one-line unit change carries `Requires-Rebuild: xinas_agent`).
- **blkid exit codes** — blkid exits 2 on "no filesystem"; the adapter must distinguish that from real failures (T3 golden).
- **`systemctl is-enabled` vs ActiveState** — the probe's current `mount_unit_state` source predates this work; the enrichment's mountinfo cross-ref becomes the authoritative `currently_mounted` regardless.
- **Owner policy at create** — applied once after first mount (`chown`/`chmod` via the adapter); failure degrades to a stage failure (rollback unmounts + unmanages), not a partial half-owned state worth special-casing.
