# S5 Filesystem Adapter (create / mount / unmount / grow / quota / unmanage) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete WS6 per `docs/control-path/s5-filesystem-spec.md` and ADR-0007: the six filesystem operations on the S2 engine + the observe enrichment + the active-share unmount blockers, e2e-proven against a file-backed fake host.

**Architecture:** Six provider/executor pairs (the S4 pattern), one shared `lib/fs` (escaping/render/derive/validate), one injectable host adapter (`agent/fs/host.ts`, subprocess seam like the xiRAID transport), probe enrichment. Engine/leases/dangerous gate unchanged.

**Tech Stack:** unchanged. **`Requires-Rebuild` only if T3's sandbox check finds `/etc/systemd/system` missing from the agent unit's write paths** (then that one unit-file commit carries `Requires-Rebuild: xinas_agent`); everything else is code/docs.

**Conventions:** S2/S4 house rules (`.js` ESM, conditional spread, injected `now()`/deps, HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, never `git add -A`, TDD per task, full gate at the end).

---

## Reuse-not-rebuild

- `src/api/plan/providers/xiraid-array.ts` + `src/api/routes/arrays.ts` — the provider/route patterns: `gatherFacts`-style KV reads, enriched specs, §S4-4 revision binding, §S4-8 filtered re-check, one-intent dispatch (modeled on PATCH /arrays).
- `src/agent/task/xiraid-array-executor.ts` — executor patterns: live-state rollback, per-run WeakMap capture (quota/unmanage need it), `checkCancelled`.
- `src/agent/xiraid/fake-transport.ts` — the fake-host blueprint (file-backed state + `-fail` hooks + `makeUnimplemented*` spread helper).
- `src/lib/parse/systemd-unit.ts` (unit parsing), `src/lib/parse/mountinfo.ts` (`MountEntry`), `src/agent/probe/filesystem.ts` (probe to enrich), `collection/roles/raid_fs/templates/mount.unit.j2` + `tasks/create_fs.yml` (the day-1 template/command to reproduce — paste-verified in T1/T3 goldens).
- `handlers/plan-apply.ts`, the engine dangerous gate (S4 T1), `requireInteger/requireString`.

## File structure

| File | Responsibility |
|------|----------------|
| `src/lib/fs/unit.ts` | `unitNameForMountpoint` (systemd path escaping), `renderMountUnit(resolved)` (day-1 template parity), `quotaFlagFor(mode)`. |
| `src/lib/fs/derive.ts` | `deriveStripe(arraySpec) → { su_kb, sw } \| undefined` (per-level parity table). |
| `src/lib/fs/schema.ts` | `FilesystemCreateSpec` + PATCH-intent types + identity-field list. |
| `src/lib/fs/validate.ts` | `validateCreate(spec, facts)`, `validateMount/Unmount/Grow/Quota/Unmanage(facts)` → ADR-0007 blocker codes. |
| `src/agent/fs/host.ts` | `FsHost` interface + `createRealFsHost()` (execFile `runCommand` + node:fs unit I/O + statfs). |
| `src/agent/fs/fake-host.ts` | `createFakeFsHost(dir)` — fixture/e2e state (`fs-host-state.json`): blkid map, units, mounted set, statfs sizes, op log, failure hooks; + `makeUnimplementedFsHost()`. |
| `src/agent/task/filesystem-executor.ts` | the six executors over `FsHost` (+ the xiRAID client is NOT needed — array health is plan-side). |
| `src/api/plan/providers/filesystem.ts` | six providers + shared fact gathering (observed Filesystems/XiraidArrays/Sessions/ExportRules + desired Shares). |
| `src/api/routes/filesystems.ts` | POST / PATCH (one-intent) / DELETE; mounted in `app.ts`, the three verbs leave the stub loop. |
| Modified | `api-v1.yaml`, s0s1 spec, `stubs.ts`(+test), `probe/filesystem.ts`, `probe/fixture.ts`, `tasks/build.ts`, `task/wiring.ts`, `app.ts`, contracts fixture. |

---

## Task T0: Contracts + stub supersession

**Files:** `docs/control-path/api-v1.yaml`, `docs/control-path/xinas-agent-s0s1-spec.md`, `xiNAS-MCP/src/agent/rpc/methods/stubs.ts` (+ `stubs.test.ts`), create `xiNAS-MCP/src/__tests__/contracts/fixtures/Filesystem.json`.

- [ ] **Step 1: Failing stub test** (mirror the S3/S4 blocks): `it.each(['fs.create','fs.mount','fs.unmount','fs.grow','fs.set_quota_mode'])('%s is NOT in STUB_METHODS …')`. Run → fails.
- [ ] **Step 2: Remove** the five from `STUB_METHOD_NAMES` + `REQUIRED_STUB_METHODS` (keep `filesystems.list`/`mounts.list`); s0s1 RPC table row → *superseded by the task envelope (S5, ADR-0007)*. Run → passes.
- [ ] **Step 3: api-v1.yaml.** `Filesystem.spec` += `label {type:[string,"null"]}`, `log_device {type:[string,"null"]}`, `log_size {type:[string,"null"]}`, `sector_size {type:[integer,"null"]}`, `su_kb {type:[integer,"null"]}`, `sw {type:[integer,"null"]}`, `force {type:boolean, default:false, description:"Overwrite an existing filesystem (destructive — requires dangerous:true at apply)."}`. `updateFilesystem` description: ONE intent key per PATCH (`mounted` | `grow` | `quota_mode`); identity fields → per-field UNSUPPORTED `fs_identity_immutable`.
- [ ] **Step 4: Fixture** `Filesystem.json` — a full create-shaped object incl. status with `mounted,uuid,size_bytes,free_bytes,observed_at` (schema-required).
- [ ] **Step 5:** `npm run test:contracts` + `npm test` → PASS. **Commit:** `docs(control-path)+feat: T0 — S5 contract revisions (Filesystem spec extension, fs.* supersession)`

## Task T1: `lib/fs/unit.ts` (escaping + render)

- [ ] **Step 1: Failing goldens.** Escaping: `/mnt/data→mnt-data.mount`, `/srv/share01→srv-share01.mount`, `/→-.mount`, `/mnt/my-disk→mnt-my\x2ddisk.mount`, `/mnt/a b→mnt-a\x20b.mount` (systemd-escape -p semantics: `-`→`\x2d`, space→`\x20`, dots in the FIRST char escaped). Render golden vs the day-1 template: given `{what:'/dev/xi_data', where:'/mnt/data', log_device:'/dev/xi_log', options:['noatime','logbsize=256k'], quota_mode:'uquota'}` → exact unit text with `Requires=dev-xi\x2ddata.device dev-xi\x2dlog.device`… wait — day-1 uses simple `regex_replace` escaping for device units (`/dev/xi_data → dev-xi-data.device`, NO `\x2d` for the underscore-to…): **Step 1 includes a 10-minute verification**: run `systemd-escape -p /dev/xi_data` mentally/from docs — systemd escapes `_` as-is (allowed), `-` inside path components → `\x2d`; `xi_data` has no dash → `dev-xi_data.device`. The DAY-1 template's `regex_replace('/', '-')` produced `dev-xi_data.device` too. Lock goldens to REAL systemd behavior (underscores kept; embedded dashes escaped), note the day-1 simplification as compatible for xi_ names.
- [ ] **Step 2: Implement** `unitNameForMountpoint`, `deviceUnitFor(path)`, `renderMountUnit`, `quotaFlagFor`. Run → passes. **Commit:** `feat(lib): T1 — fs unit escaping + day-1-parity mount-unit render`

## Task T2: `lib/fs/{schema,derive,validate}.ts`

- [ ] **Step 1: Failing tests.** `deriveStripe`: raid5/4-members strip 128 → `{su_kb:128, sw:3}`; raid6/8 → sw 6; raid10/4 → sw 2; raid50/6 g=3 → sw 4 (2 groups × (3−1)); raid0/4 → sw 4; missing strip_size → undefined. `validateCreate` table: bad mountpoint → `mountpoint_invalid`; unit-name collision vs observed fs → `mountpoint_taken`; backing not an observed array volume → `backing_array_not_found`; another fs on the device → `backing_device_in_use`; log device not an array volume → `log_array_not_found`; no derivable stripe + no override → `stripe_underivable`; `force:true` → advisory `dangerous_flag_required` present. `validateUnmount(facts)`: session under mountpoint → `dependent_share_active`; ExportRule at/under → `mountpoint_exported`. `validateMount`: array state failed → `backing_array_unhealthy`. `validateGrow`: not mounted → `fs_not_mounted`. `validateUnmanage`: mounted → `fs_mounted`. PATCH narrowing: multi-intent throws (route maps to 400); identity keys list exported for the route's 422 scan.
- [ ] **Step 2: Implement** (pure, facts injected — the S3 validate pattern). Run → passes. **Commit:** `feat(lib): T2 — fs stripe derivation + per-op validation (ADR-0007 blockers)`

## Task T3: Host adapter + fake host

- [ ] **Step 1 (confirm-first): sandbox + blkid.** (a) `grep -n "ReadWritePaths\|ProtectSystem" xiNAS-MCP/xinas-agent.service` — if `/etc/systemd/system` is NOT writable under the current directives, add it (`ReadWritePaths=/etc/systemd/system`) in a SEPARATE commit with `Requires-Rebuild: xinas_agent`. (b) blkid exit-code contract: exit 2 = no fs (not an error) — encode in the adapter.
- [ ] **Step 2: Failing tests.** `FsHost` interface: `blkid(dev) → {fstype?, label?, uuid?} | null`, `mkfsXfs(args)`, `growfs(mountpoint)`, `writeUnit(name, text)`, `readUnit(name)`, `removeUnit(name)`, `daemonReload()`, `enableNow(name)`, `stop(name)`, `disable(name)`, `readMounts()`, `statfs(mountpoint) → {size_bytes, free_bytes}`, `applyOwnerPolicy(mountpoint, policy)`. Real-host command goldens via a recorded fake `runCommand` (assert exact argv: `mkfs.xfs -f -L data -d su=128k,sw=3 -l logdev=/dev/xi_log,size=1G -s size=4096 /dev/xi_data`; `blkid -o export /dev/xi_data` parse; exit-2 → null). Fake host (`fs-host-state.json`): blkid map seedable; `mkfsXfs` sets the device's blkid entry (rejects if entry exists and argv lacks `-f`? — argv always has `-f`; the GATE is executor-side, so the fake just records); units dir simulated in state; `enableNow` adds to mounted set + statfs default sizes; `stop` removes; op log; hooks: any op against a unit/device whose name ends `-fail` rejects; `growfs` bumps size_bytes.
- [ ] **Step 3: Implement both + `makeUnimplementedFsHost()`.** Run → passes (+ tsc). **Commit:** `feat(agent): T3 — fs host adapter (injectable runCommand) + file-backed fake host`

## Task T4: Observe enrichment

- [ ] **Step 1: Failing probe tests.** Given a unit + fake exec results: blkid → `uuid`/`label` into status; mountinfo lists the mountpoint → `currently_mounted: true` + `effective_mount_options` + statfs `size_bytes`/`free_bytes`; blkid failure → fields absent, row still emitted. Fixture probe passthrough: `filesystems.json` entries may carry the new fields.
- [ ] **Step 2: Implement** in `probe/filesystem.ts` (inject the same execFile pattern; reuse `parseMountinfo`); collector `_fsToUpsert` passes the new fields through. Run full disk/fs suites. **Commit:** `feat(agent): T4 — filesystem observe enrichment (uuid/size/free/currently_mounted)`

## Task T5: Create provider + POST route

- [ ] **Step 1: Failing tests.** Provider (KV harness, S4 pattern): valid spec vs seeded observed array (`/dev/xi_data`, strip 128, raid5×4) → blockers `[]`, `affected_resources=[Filesystem#mnt-data.mount, XiraidArray#data (+log array)]`, enriched spec carries resolved `{unit_name, label, su_kb:128, sw:3, …}`, diff carries the rendered unit + mkfs argv preview; each blocker case from T2 reachable through the provider; `force:true` → `risk_level:'destructive'`, `rollback_model:'unsupported'`, advisory blocker present. Route: POST plan/apply happy (202, leases fs+arrays); `force` apply without `dangerous` → 412 `dangerous_flag_required` (engine); `expected_revision` must be 0.
- [ ] **Step 2: Implement** provider + route (mirror arrays POST; register in `build.ts`; POST `/filesystems` leaves the stub loop). Run + full suite. **Commit:** `feat(api): T5 — fs.create provider + POST /filesystems route`

## Task T6: Create executor

- [ ] **Step 1: Failing tests** (TaskRunner + fake host): success → stages `preflight/mkfs/write_unit/mount/verify`, op order asserted, unit text golden, mounted; existing blkid entry + `force:false` → preflight fails, nothing written; + `force:true` → proceeds (mkfs overwrites); mid-failure (unit named `…-fail` hook at mount) → rollback removes the unit + daemon-reload, terminal `failed (FAILED_PARTIAL_ROLLED_BACK)`, device left formatted; owner_policy applied when present.
- [ ] **Step 2: Implement** + register in `wiring.ts` (executors take the `FsHost`; wiring builds real-vs-fake by `fixtureDir()`, the T10-S4 pattern). **Commit:** `feat(agent): T6 — fs.create executor (blkid gate, day-1 mkfs, unit, mount)`

## Task T7: Mount/unmount providers + PATCH route

- [ ] **Step 1: Failing tests.** PATCH dispatch: `{mounted:true}`→`fs.mount`, `{mounted:false}`→`fs.unmount`; multi-intent `{mounted:true, grow:true}` → 400; identity key `{mountpoint:…}` → 422 `fs_identity_immutable`; revision binding (current observed revision; stale → 412). Unmount provider: seeded session (`export_path:/mnt/data/share`) + ExportRule (`/mnt/data/share`) + desired Share → blockers `dependent_share_active`+`mountpoint_exported`, blast radius in diff, Shares leased. Mount provider: array `failed` → `backing_array_unhealthy`.
- [ ] **Step 2: Implement** providers + the PATCH route skeleton (one-intent dispatch shared by T9). **Commit:** `feat(api): T7 — fs.mount/unmount providers + PATCH /filesystems/:id (one-intent dispatch)`

## Task T8: Mount/unmount executors

- [ ] **Step 1: Failing tests.** mount: `enableNow` + verify mounted; not-mounted-after → stage fail → rollback `stop` (no-op-safe). unmount: `stop`+`disable` + verify unmounted; simulated EBUSY (hook) → rollback `enableNow` restores, clean `failed`.
- [ ] **Step 2: Implement + register.** **Commit:** `feat(agent): T8 — fs.mount/unmount executors (EBUSY-safe rollback)`

## Task T9: Grow + quota providers (PATCH intents)

- [ ] **Step 1: Failing tests.** `{grow:true}` → `fs.grow`, blocker `fs_not_mounted` when observed not mounted; `{quota_mode:'pquota'}` → `fs.set_quota_mode`, `risk_level:'changing_access'`, unmount-style blockers applied (sessions/exports), diff shows old→new flag.
- [ ] **Step 2: Implement.** **Commit:** `feat(api): T9 — fs.grow + fs.set_quota_mode providers`

## Task T10: Grow + quota executors

- [ ] **Step 1: Failing tests.** grow: captures `statfs` before, `growfs`, verify size ≥ before (fake bumps); rollback no-op. quota: preflight captures the unit text (WeakMap per-run, S4-T6 pattern); rewrite `Options=` flag → `daemonReload` → `stop`+`enableNow` (restart) → verify mounted; tuning…no — failure mid-restart → rollback writes the captured unit back + `daemonReload` + `enableNow`; terminal clean `failed`.
- [ ] **Step 2: Implement + register.** **Commit:** `feat(agent): T10 — fs.grow + fs.set_quota_mode executors (unit-capture rollback)`

## Task T11: Unmanage (provider + DELETE route + executor)

- [ ] **Step 1: Failing tests.** Provider: mounted → blocker `fs_mounted`; clean → `risk_level:'changing_access'`, `rollback_model:'non_disruptive'`, NO dangerous blocker. Route: DELETE plan/apply with revision binding. Executor: captures unit text; `stop`/`disable` (defensive), `removeUnit`, `daemonReload`; verify the unit is gone; rollback rewrites the unit + `daemonReload`.
- [ ] **Step 2: Implement + register + DELETE leaves the stub loop.** Run FULL `npm test`. **Commit:** `feat: T11 — fs unmanage (DELETE /filesystems/:id, config-only)`

## Task T12: e2e + full gate

**Files:** Create `xiNAS-MCP/src/__tests__/e2e/filesystem-adapter.test.ts` (clone the S4 mutations harness; the agent's fixture mode must wire `createFakeFsHost(fixtureDir)` — confirm `wiring.ts` does this from T6).

- [ ] **Step 1:** create array `data` via the fake xiRAID (or seed xiraid-state.json directly) → POST /filesystems (backing `/dev/xi_data`) → success → observed row mounted with uuid/size (fixture statfs defaults).
- [ ] **Step 2:** seed an NfsSession fixture under the mountpoint → PATCH `{mounted:false}` apply → 412 `dependent_share_active`; remove the session seed (post-boot? sessions come from the NFS collector — fixture nfs probe returns empty… seed via the API-side? sessions are observed-only. SOLUTION: extend the fixture NFS probe to read `nfs-sessions.json` (one small passthrough, same as filesystems.json — fold into T4) and seed it at boot for a SECOND filesystem used only for the blocked case).
- [ ] **Step 3:** unmount the clean fs → success; grow → success (size bumped); quota → success (unit Options changed in the fake state); unmanage → success → row disappears after the collector sweep.
- [ ] **Step 4:** create `force:true` over a blkid-seeded device without `dangerous` → 412; with `dangerous:true` → success.
- [ ] **Step 5: Gate.** `npm run build` → `npm test` · `npm run test:e2e` · `npm run test:contracts` · `npx tsc --noEmit` · `npm run lint` — all green.
- [ ] **Step 6: Commit:** `test(e2e): T12 — filesystem adapter round-trip (create, blockers, grow, quota, unmanage, force gate)`

---

## Self-review notes

- **Spec coverage:** spec §3→T1/T2, §4 per-op→T5–T11, §5→T4, §7→T0, §8→per-task+T12. ADR blocker codes all reachable in T2/T5/T7/T9/T11 tests.
- **Confirm-first steps:** T1 (systemd-escape semantics), T3 Step 1 (sandbox write path — the only potential `Requires-Rebuild` — and blkid exit codes).
- **Resolved during self-review:** the e2e blocked-unmount scenario needs seedable NfsSessions → the fixture NFS probe gains `nfs-sessions.json` passthrough, folded into T4 (same pattern as S4's `filesystems.json`).
- **Executors need no xiRAID client** (array health is plan-side); the `FsHost` is the only new agent dependency, fixture-selected in `wiring.ts` like the S4 mount-guard.
