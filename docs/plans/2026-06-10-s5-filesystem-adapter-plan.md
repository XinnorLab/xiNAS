# S5 Filesystem Adapter (create / mount / unmount / grow / quota / unmanage) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revised 2026-06-10 after independent review** (2 P0 + 2 P1, all verified): the observation-normalization prerequisite (T1), the agent-unit compatibility task (T4, the one `Requires-Rebuild`), the day-1 log-size clamp (T5/T8), and the NFS fixture passthroughs that make the e2e blocker proof real (T6/T12).

**Goal:** Complete WS6 per `docs/control-path/s5-filesystem-spec.md` and ADR-0007: the six filesystem operations on the S2 engine + the observe enrichment + the active-share unmount blockers, e2e-proven against a file-backed fake host.

**Architecture:** Six provider/executor pairs (the S4 pattern), one shared `lib/fs`, one injectable host adapter (`agent/fs/host.ts`), probe enrichment — but FIRST the observation normalization: real-host observed Filesystem rows must actually carry `mountpoint`/`backing_device`/`mounted` under `status` (today fixture-only; the S4 delete dep-walk is blind on real hosts until T1 lands).

**Tech Stack:** unchanged. **`Requires-Rebuild: xinas_agent` on exactly one commit (T4** — `ReadWritePaths=/etc/systemd/system` per ADR-0007's audited compatibility table); everything else is code/docs.

**Conventions:** S2/S4 house rules (`.js` ESM, conditional spread, injected `now()`/deps, HEREDOC commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, never `git add -A`, TDD per task, full gate at the end).

---

## Reuse-not-rebuild

- `src/api/plan/providers/xiraid-array.ts` + `src/api/routes/arrays.ts` — provider/route patterns: fact gathering, enriched specs, §S4-4 revision binding, §S4-8 filtered re-check, one-intent dispatch.
- `src/agent/task/xiraid-array-executor.ts` — executor patterns: live-state rollback, per-run WeakMap capture (quota/unmanage), `checkCancelled`.
- `src/agent/xiraid/fake-transport.ts` — fake-host blueprint (file-backed state, deterministic hooks, `makeUnimplemented*` spread).
- `src/lib/parse/systemd-unit.ts`, `src/lib/parse/mountinfo.ts` (`MountEntry.source/mountpoint/options/fstype`), `src/agent/probe/filesystem.ts`, `src/agent/probe/fixture.ts` (passthrough pattern: `filesystems.json` from S4).
- Day-1 truth to reproduce: `collection/roles/raid_fs/tasks/create_fs.yml` (mkfs argv + the `_effective_log_size = min(log_size, blockdev --getsize64)` clamp at lines ~69-81) and `templates/mount.unit.j2`.
- `handlers/plan-apply.ts`, the engine dangerous gate, `requireInteger/requireString`.

## Verified-fact corrections this plan builds on (review P0s)

1. Real-host observed Filesystem rows carry ONLY `mount_unit_name`/`mount_unit_enabled`: `lib/parse/filesystem.ts` puts `mountpoint`/`backing_device` under `spec`, and `convergence.ts`'s adapter forwards `{kind, id, status}` — `spec` is dropped. No `mounted`/`currently_mounted` is produced outside fixtures. The S4 array-delete dep walk reads `status.*` → fixture-only today. T1 fixes the whole chain.
2. The agent unit (`xinas-agent.service`): `ProtectSystem=strict`, `ReadWritePaths=/run/xinas /var/log/xinas`, `ReadOnlyPaths=/var/lib/xinas /etc/xinas-agent`, `NoNewPrivileges`, `CapabilityBoundingSet=CAP_CHOWN`, `RestrictNamespaces=~cgroup ~user`, syscall filter. ADR-0007's table: the ONE delta is `/etc/systemd/system` writability; mountpoint dirs are PID1-created; `/dev` writable under `strict` (`PrivateDevices` unset); CAP_CHOWN covers owner_policy.

## File structure

| File | Responsibility |
|------|----------------|
| `src/lib/parse/filesystem.ts` (modify, T1) | status-only ObservedFilesystem (`mountpoint`, `backing_device`, `fs_type`, `mount_options` move under `status`). |
| `src/lib/fs/unit.ts` | `unitNameForMountpoint`, `deviceUnitFor`, `renderMountUnit` (day-1 parity), `quotaFlagFor`. |
| `src/lib/fs/derive.ts` / `schema.ts` / `validate.ts` | stripe derivation; spec + intent types; per-op blocker rules. |
| `src/agent/fs/host.ts` | `FsHost`: `blkid`, `blockdevSize`, `mkfsXfs`, `growfs`, `writeUnit/readUnit/removeUnit`, `daemonReload`, `enableNow/stop/disable`, `readMounts`, `statfs`, `applyOwnerPolicy`. |
| `src/agent/fs/fake-host.ts` | file-backed fake (`fs-host-state.json`: blkid map, device sizes, units, mounted set, statfs sizes, op log, `-fail` hooks) + `makeUnimplementedFsHost`. |
| `src/agent/task/filesystem-executor.ts` | six executors over `FsHost`. |
| `src/api/plan/providers/filesystem.ts` | six providers + shared facts (observed Filesystems/Arrays/Sessions/ExportRules + desired Shares). |
| `src/api/routes/filesystems.ts` | POST / PATCH(one-intent) / DELETE. |
| Modified | `api-v1.yaml`, s0s1 spec, `stubs.ts`(+test), `convergence.ts`, `collectors/filesystem.ts`, S4 delete provider + tests/e2e fixtures (T1 migration), `probe/filesystem.ts`, `probe/fixture.ts` (fs extras + nfs sessions/exports passthrough), `xinas-agent.service` (T4), `tasks/build.ts`, `task/wiring.ts`, `app.ts`, `Filesystem.json` fixture. |

---

## Task T0: Contracts + `mounted` canonicalization + stub supersession

**Files:** `docs/control-path/api-v1.yaml`, `docs/control-path/xinas-agent-s0s1-spec.md`, `xiNAS-MCP/src/agent/rpc/methods/stubs.ts` (+ `stubs.test.ts`), create `xiNAS-MCP/src/__tests__/contracts/fixtures/Filesystem.json`.

- [ ] **Step 1: Failing stub test** (the S3/S4 block): `it.each(['fs.create','fs.mount','fs.unmount','fs.grow','fs.set_quota_mode'])('%s is NOT in STUB_METHODS …')`. Run → fails.
- [ ] **Step 2: Remove** the five from `STUB_METHOD_NAMES` + `REQUIRED_STUB_METHODS` (keep `filesystems.list`/`mounts.list`); s0s1 RPC table row → *superseded by the task envelope (S5, ADR-0007)*. Run → passes.
- [ ] **Step 3: api-v1.yaml.** (a) `Filesystem.spec` += `label/log_device/log_size {type:[string,"null"]}`, `sector_size/su_kb/sw {type:[integer,"null"]}`, `force {type:boolean, default:false}` (destructive note). (b) **`mounted` canonicalization:** `status.mounted` stays required; DELETE the duplicate `status.currently_mounted` property. (c) `updateFilesystem` description: ONE intent key per PATCH (`mounted` | `grow` | `quota_mode`); identity fields → per-field `UNSUPPORTED` (`fs_identity_immutable`).
- [ ] **Step 4: Fixture** `Filesystem.json` — full object (status incl. `mounted,uuid,size_bytes,free_bytes,observed_at`).
- [ ] **Step 5:** `npm run test:contracts` + `npm test` → PASS. **Commit:** `feat(control-path): T0 — S5 contracts (Filesystem spec extension, mounted canonical, fs.* supersession)`

## Task T1: Observation normalization (ADR-0007 prerequisite; fixes the latent S4 gap)

**Files:** `xiNAS-MCP/src/lib/parse/filesystem.ts`, `src/agent/convergence.ts` (fs adapter), `src/agent/collectors/filesystem.ts`, `src/api/plan/providers/xiraid-array.ts` (delete dep walk: `currently_mounted` → `mounted`), tests: `lib/parse/filesystem.test.ts`, `collectors/filesystem` tests, `api/plan/xiraid-array-provider.test.ts` seeds, S4 e2e `filesystems.json` fixture keys.

- [ ] **Step 1: Failing parse test:** `mountUnitToFilesystem(...)` output is status-only — `status: { mountpoint, backing_device, fs_type, mount_options, mount_unit_name, mount_unit_enabled }`, NO `spec` key.
- [ ] **Step 2: Implement** the parser reshape; convergence adapter unchanged (`{...r.status}` now actually carries the facts); collector `_fsToUpsert` emits the full set + **`mounted`** (probe-provided; until T6's mountinfo cross-ref it is absent → omitted, not fabricated).
- [ ] **Step 3: Migrate S4 consumers:** the delete provider walk reads `status.mounted` (was `currently_mounted`); update its unit-test seeds + the S4 e2e `filesystems.json` (key rename `currently_mounted` → `mounted`).
- [ ] **Step 4:** FULL `npm test` + `npm run test:e2e` (the S4 suites must stay green through the rename). **Commit:** `fix(agent): T1 — filesystem observation normalization (status-only rows reach real hosts; mounted canonical)`

## Task T2: `lib/fs/unit.ts` (escaping + render)

- [ ] **Step 1: Failing goldens.** Escaping per `systemd-escape -p` semantics: `/mnt/data→mnt-data.mount`, `/srv/share01→srv-share01.mount`, `/→-.mount`, `/mnt/my-disk→mnt-my\x2ddisk.mount`, `/mnt/a b→mnt-a\x20b.mount`; `deviceUnitFor('/dev/xi_data')→dev-xi_data.device` (underscore kept — verified systemd behavior; the day-1 `regex_replace('/','-')` simplification is compatible for `xi_` names). Render golden vs the day-1 template (Requires/After both device units, `Before=umount.target`, `Conflicts=umount.target`, `Options=defaults,<opts>,logdev=…,<quota flag>`, `WantedBy=local-fs.target`).
- [ ] **Step 2: Implement.** Run → passes. **Commit:** `feat(lib): T2 — fs unit escaping + day-1-parity mount-unit render`

## Task T3: `lib/fs/{schema,derive,validate}.ts`

- [ ] **Step 1: Failing tests.** `deriveStripe`: raid5/4@128 → `{su_kb:128, sw:3}`; raid6/8 → 6; raid10/4 → 2; raid50/6 g=3 → 4; raid0/4 → 4; missing strip → undefined. `validateCreate` blocker table (`mountpoint_invalid`, `mountpoint_taken`, `backing_array_not_found`, `backing_device_in_use`, `log_array_not_found`, `stripe_underivable`, advisory `dangerous_flag_required` with `force:true`). `validateUnmount` (`dependent_share_active`, `mountpoint_exported`), `validateMount` (`backing_array_unhealthy`), `validateGrow` (`fs_not_mounted` — reads `status.mounted`), `validateUnmanage` (`fs_mounted`). PATCH narrowing: multi-intent throws; identity-keys list exported.
- [ ] **Step 2: Implement** (pure facts-in, S3 pattern). **Commit:** `feat(lib): T3 — fs stripe derivation + per-op validation (ADR-0007 blockers)`

## Task T4: Agent-unit compatibility delta (the one Requires-Rebuild)

**Files:** `xiNAS-MCP/xinas-agent.service`; the smoke checklist appends to `docs/control-path/s5-filesystem-spec.md` §10.

- [ ] **Step 1: Edit the unit** per the ADR-0007 table: `ReadWritePaths=/run/xinas /var/log/xinas /etc/systemd/system` (one line change + a comment citing ADR-0007). NOTHING else (devices/caps/syscalls verified sufficient — table in the ADR).
- [ ] **Step 2: Append the Ubuntu hardware smoke checklist** to the spec §10 (create→mount→grow→quota→unmount→unmanage on a lab node; verify mkfs argv vs day-1; verify PID1 created the mountpoint dir; verify enable symlink) — the explicit residual until run.
- [ ] **Step 3: Commit** (unit + spec doc together):
```
feat(agent): T4 — allow /etc/systemd/system writes for the fs executors

ADR-0007 §Host-command execution compatibility table: the single sandbox
delta for S5 (unit writes + enable symlinks). Mountpoint dirs are
PID1-created; /dev stays writable under ProtectSystem=strict.

Requires-Rebuild: xinas_agent
```

## Task T5: Host adapter + fake host

- [ ] **Step 1 (confirm-first): blkid exit-code contract** — exit 2 = "no filesystem" (→ `null`, not an error); encode + golden.
- [ ] **Step 2: Failing tests.** Real-host command goldens via recorded fake `runCommand`: `mkfs.xfs -f -L data -d su=128k,sw=3 -l logdev=/dev/xi_log,size=<EFFECTIVE> -s size=4096 /dev/xi_data`; `blkid -o export /dev/xi_data` parse; **`blockdevSize`** via `blockdev --getsize64` (numeric parse); `xfs_growfs /mnt/data`; systemctl verbs; unit file I/O against an injected dir. Fake host (`fs-host-state.json`): seedable blkid map + **device sizes**; mkfs records argv + sets the device's blkid entry; units simulated; `enableNow`/`stop` toggle the mounted set + statfs defaults; `growfs` bumps `size_bytes`; op log; `-fail` hooks on unit/device names.
- [ ] **Step 3: Implement both + `makeUnimplementedFsHost`.** **Commit:** `feat(agent): T5 — fs host adapter (blockdevSize, blkid exit-2) + file-backed fake host`

## Task T6: Observe enrichment + the fixture passthroughs

- [ ] **Step 1: Failing probe tests.** blkid → `uuid`/`label`; mountinfo cross-ref → **`mounted: true`** + `effective_mount_options`; statfs → `size_bytes`/`free_bytes`; individual command failure degrades the field, not the row.
- [ ] **Step 2: Failing fixture tests.** `probe/fixture.ts`: `filesystems.json` passthrough for the new fields; **`createFixtureNfsProbe(dir)` reads `nfs-sessions.json` + `nfs-exports.json`** (collector shapes: sessions `{kind:'NfsSession', id, spec:{client_addr, export_path}, status:{…}}`; exports as the probe's `ObservedExportRule` entries the collector folds by `export_path`) — defaulting empty; convergence passes `fdir`.
- [ ] **Step 3: Implement** (inject execFile, reuse `parseMountinfo`); collector passthrough. Run fs+nfs collector suites. **Commit:** `feat(agent): T6 — fs observe enrichment (uuid/size/free/mounted) + nfs fixture passthrough`

## Task T7: Create provider + POST route

- [ ] **Step 1: Failing tests.** Provider vs seeded observed array (`/dev/xi_data`, raid5×4@128) + log array: blockers `[]`; `affected=[Filesystem#mnt-data.mount, XiraidArray#data, XiraidArray#log]`; enriched spec `{unit_name, label, su_kb:128, sw:3, effective mkfs inputs…}`; diff = rendered unit + mkfs argv preview (log size UNCLAMPED here — the clamp is executor-side and noted in the diff text); every T3 blocker reachable; `force:true` → `risk_level:'destructive'`, `rollback_model:'unsupported'`. Route: POST plan/apply (202; fs+arrays leased); `force` apply without `dangerous` → 412 (engine); `expected_revision` 0.
- [ ] **Step 2: Implement** + register; POST `/filesystems` leaves the stub loop. **Commit:** `feat(api): T7 — fs.create provider + POST /filesystems route`

## Task T8: Create executor

- [ ] **Step 1: Failing tests** (TaskRunner + fake host): success → stages `preflight/mkfs/write_unit/mount/verify`, op order + unit golden + mounted; **clamp golden**: spec log_size `1G`, fake device size 512MiB → mkfs argv carries `size=536870912` (the day-1 min()); blkid-existing + `force:false` → preflight fails, nothing written; + `force:true` → proceeds; mid-failure at mount (`-fail` unit) → rollback removes the unit + daemon-reload → `failed (FAILED_PARTIAL_ROLLED_BACK)`, device left formatted; owner_policy applied.
- [ ] **Step 2: Implement** + wiring (FsHost fixture-selected via `fixtureDir()`, the S4 mount-guard pattern). **Commit:** `feat(agent): T8 — fs.create executor (blkid gate, day-1 mkfs + log clamp, unit, mount)`

## Task T9: Mount/unmount providers + PATCH route

- [ ] **Step 1: Failing tests.** Dispatch: `{mounted:true}`→`fs.mount`, `{mounted:false}`→`fs.unmount`; multi-intent → 400; identity key → 422 `fs_identity_immutable`; revision binding (current observed; stale → 412). Unmount provider: seeded session + ExportRule + desired Share → `dependent_share_active` + `mountpoint_exported`, blast radius diff, Shares leased. Mount provider: array `failed` → `backing_array_unhealthy`.
- [ ] **Step 2: Implement** providers + PATCH skeleton (shared by T10's intents). **Commit:** `feat(api): T9 — fs.mount/unmount providers + PATCH /filesystems/:id (one-intent dispatch)`

## Task T10: Mount/unmount executors + grow/quota providers

- [ ] **Step 1: Failing tests.** mount executor: `enableNow` + mounted verify; failure → rollback `stop`. unmount: `stop`+`disable` + verify; EBUSY hook → rollback `enableNow`, clean `failed`. Grow provider: `{grow:true}` → `fs.grow`, blocker `fs_not_mounted`. Quota provider: `{quota_mode:'pquota'}` → `fs.set_quota_mode`, `changing_access`, unmount-style blockers, old→new flag in diff.
- [ ] **Step 2: Implement + register.** **Commit:** `feat: T10 — fs.mount/unmount executors + fs.grow/set_quota_mode providers`

## Task T11: Grow/quota executors + unmanage

- [ ] **Step 1: Failing tests.** grow: statfs-before captured, `growfs`, verify ≥ before; rollback no-op. quota: preflight captures unit text (WeakMap); `Options=` flag rewrite → `daemonReload` → restart → verify; failure → captured unit restored + restart, clean `failed`. Unmanage provider: mounted → `fs_mounted`; clean → `changing_access`, no dangerous. DELETE route (revision binding). Unmanage executor: capture, `stop/disable` (defensive), `removeUnit`, `daemonReload`, verify; rollback rewrites + reload.
- [ ] **Step 2: Implement + register; DELETE leaves the stub loop.** FULL `npm test`. **Commit:** `feat: T11 — fs.grow/set_quota_mode executors + unmanage (DELETE /filesystems/:id)`

## Task T12: e2e + full gate

**Files:** Create `xiNAS-MCP/src/__tests__/e2e/filesystem-adapter.test.ts` (S4 mutations harness; seed BOTH `nfs-sessions.json` + `nfs-exports.json` at boot for the blocked filesystem; seed `xiraid-state.json` with arrays `data` + `log`; blkid map seeds in `fs-host-state.json`).

- [ ] **Step 1:** POST /filesystems (backing `/dev/xi_data`, log `/dev/xi_log`, log_size larger than the seeded log-device size) → success → mkfs argv in the fake op log shows the **clamped** size → observed row `mounted: true` with uuid/size.
- [ ] **Step 2:** second fs with boot-seeded session + export under its mountpoint → PATCH `{mounted:false}` apply → 412 with BOTH `dependent_share_active` AND `mountpoint_exported` in `details.blockers`.
- [ ] **Step 3:** unmount the clean fs → success; grow → success (size bumped); quota → success (unit Options changed in fake state); unmanage → success → row gone after the sweep.
- [ ] **Step 4:** create `force:true` over a blkid-seeded device without `dangerous` → 412 `dangerous_flag_required`; with → success.
- [ ] **Step 5: Gate.** `npm run build` → `npm test` · `npm run test:e2e` · `npm run test:contracts` · `npx tsc --noEmit` · `npm run lint` — all green.
- [ ] **Step 6: Commit:** `test(e2e): T12 — filesystem adapter round-trip (clamped create, both unmount blockers, grow, quota, unmanage, force gate)`

---

## Self-review notes

- **Review fixes mapped:** P0-observation → T0(b)+T1 (schema canonical + chain fix + S4 migration, full e2e re-run inside T1); P0-sandbox → the ADR table + T4 (one delta, own `Requires-Rebuild` commit, smoke checklist residual); P1-clamp → T5 `blockdevSize` + T8 clamp golden + T12 op-log assert; P1-blockers-proof → T6 nfs fixture passthroughs + T12 Step 2 asserting BOTH codes.
- **Confirm-first steps:** T2 (systemd-escape semantics), T5 (blkid exit codes).
- **Ordering:** T1 before any provider (they read the normalized shape); T4 anywhere before T12 (independent); executors fixture-select the FsHost in wiring like the S4 mount-guard.
