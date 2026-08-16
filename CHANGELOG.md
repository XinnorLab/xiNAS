# Changelog

All notable changes to xiNAS are recorded here. Versions follow
[Semantic Versioning](https://semver.org/) with `vX.Y.Z` git tags, and
each entry corresponds to a published
[GitHub Release](https://github.com/XinnorLab/xiNAS/releases) — the only
supported source for installing and updating xiNAS.

## [3.9.5] - 2026-08-16

Requires a rebuild of `xinas_node_build` — the fix is in the agent, which runs
compiled JavaScript from the untracked `dist/`.

### Fixed

- **The Filesystem screen no longer reports a mounted filesystem as
  read-only.** `/mnt/data` rendered as `Options: ro,nosuid,noatime,nodiratime`
  while it was mounted `rw`, exported `rw` over NFS, and being written to.

  The agent read the mount table from `/proc/self/mountinfo`, which reports the
  namespace of the *reading process*. `xinas-agent.service` runs with
  `ProtectSystem=strict`, `ProtectHome=yes` and `PrivateTmp=yes` — any one of
  which gives the service its own mount namespace — so the agent was observing
  **its own sandbox**, not the host. `ProtectSystem=strict` makes the hierarchy
  read-only outside the unit's `ReadWritePaths`, which is where the `ro` came
  from, and the sandbox added `nosuid`. Captured on the reference node, same
  device, same instant:

  ```text
  agent ns  /mnt/data ro,nosuid,noatime,nodiratime   - xfs /dev/xi_data rw,…
  host  ns  /mnt/data rw,noatime,nodiratime          - xfs /dev/xi_data rw,…
  ```

  All three agent readers now use `/proc/1/mountinfo` — PID 1 is by definition
  in the root mount namespace — via a single `HOST_MOUNTINFO_PATH` constant,
  with no fallback to `/proc/self`.

  **The xiRAID delete guard was not affected**, which was verified rather than
  assumed: it matches on the mount `source` and on `logdev=`/`rtdev=` in the
  fs-specific *super* options, which are properties of the superblock and read
  identically in both namespaces. It moves to the host table for consistency
  only. The state store was not stale either — the api deliberately skips
  content-identical upserts, so the row sitting at `revision: 1` since install
  meant the agent kept publishing the same wrong value, not that it had stopped.

## [3.9.4] - 2026-08-16

Requires a rebuild of `xinas_node_build` — the fix is in the control-path
parser and the agent executor, both of which run compiled JavaScript from the
untracked `dist/`.

First release verified on hardware. 3.9.3 was deployed to a node running
xiRAID Classic 4.4.0 (driver `4.4.0-43861`) and the RAID surfaces were
exercised against the live daemon, which found one real defect and corrected
one false claim.

### Fixed

- **Attaching a spare pool no longer fails on an array that has none.**
  The daemon spells "this array has no spare pool" as the **string `"-"`**,
  not as an empty string and not by omitting the key — both arrays on a
  freshly installed node report `"sparepool": "-"` with no pools configured at
  all. xiNAS read that as a pool *name*, with two consequences:

  - The modify executor's foreign-pool guard rejects any sparepool that is
    neither `''` nor `xnsp_<array>`, so `PATCH /api/v1/arrays/{id}` carrying
    `spare_disk_ids` failed preflight with *"sparepool '-' is not managed by
    the control path"* — on every array of a fresh install. Detaching hit the
    matching failure at the verify stage, and rollback would have written the
    sentinel back as if it were a name.
  - `GET /api/v1/arrays` published `status.spare_pool: "-"`, which per
    ADR-0011 joins to `Pool.referenced_by` — a reference to a pool that cannot
    exist.

  The sentinel is now normalized in one place, `readSparepoolName()` in
  `lib/parse/raid.ts`, which every consumer reads through.

### Corrected

- **3.9.3 claimed the login banner labelled every array `unknown`.** It did
  not. The claim was that the daemon does not repeat the array name inside the
  keyed object, so `arr["name"]` read empty; on a live 4.4 node each value
  *does* carry `"name"`, and the pre-change banner rendered `data` and `log`
  correctly. The reasoning went from "the payload is keyed by name" to "the
  name must therefore not be inside", and that step was never checked against
  a real payload. The code change is kept — reading the key as a fallback is
  the more robust of the two — but it fixed nothing observable, and
  `docs/Installer/spec.md` §3.13 now records the correction rather than the
  claim.

  The sibling claim about `raid_devices` and the bare-path device shape stands
  as written (it is conditional on that shape), but for the record: xiRAID 4.4
  emits only the `[index, path, [states]]` tuple, so that fix is defensive
  rather than a repair of observed behaviour.

## [3.9.3] - 2026-08-16

Requires a rebuild of `xinas_node_build` (the control-path parser compiles
into the untracked `dist/`) and `motd` (the login banner is an Ansible
template). The update flow names both before it applies them.

Everything in this release is xiNAS reading xiRAID's own documentation for
**xiRAID Classic 4.4.0** — the version `xiraid_classic` installs — rather
than a plausible guess at it. None of it was verified on hardware; the
reference node was unreachable while the work was done.

### Fixed

- **A RAID array in real trouble is no longer published as `unknown`.**
  The agent's parser knew only part of xiRAID's state vocabulary, so
  `unrecovered` ("can't complete reconstruction because of unrecoverable
  sections"), `read_only` ("the license has expired"), `none` (unloaded or
  not restored after reboot), `inconsistent` and `need_init` all fell
  through to `unknown` — the TUI, MCP and CLI each rendered an array that
  needed attention as unremarkable. Every state on the vendor's
  [Showing RAID State](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html)
  page now maps; four benign ones are deliberately left unmapped so they
  cannot downgrade a healthy array's verdict.

- **The `raid_status` health check no longer fails a healthy node.** It
  failed any state that was not `online`/`initialized`, so a freshly
  installed node reported `FAIL — data: initing` with the impact line
  "Degraded RAID reduces redundancy" while the array was doing exactly
  what it was supposed to. The check now separates redundancy loss (FAIL)
  from work in progress (WARN), and each WARN says only what is true of
  it: an initializing array is *"usable but not yet fully redundant"*, a
  stopped restripe is *"serving I/O on an incomplete layout"*, and an
  unrecognised state supports no claim at all.

- **The login banner no longer paints a degraded array green.** It read
  only the first word of a state list, so `["online", "degraded"]`
  rendered as a green `online` while a drive was gone, and it matched an
  invented vocabulary in which `reconstructing` and `initing` were
  unknown and got a red cross. It also labelled every array `unknown`,
  because the daemon keys arrays by name rather than repeating the name
  inside the object.

- **An unreadable state is no longer certified as healthy.** A missing or
  empty `state` reported `PASS — 1 array(s) online` for an array nothing
  was known about, `state: null` raised an uncaught `TypeError` out of the
  whole health run, and the string `"online"` was iterated into six
  single characters. Anything unusable is now its own category, never
  PASS; when no array reports a readable state the check reports SKIP.

- **`raid_devices` reads all three member shapes.** It indexed
  `dev[2][0]`, which parses only the tuple form — against a bare device
  path that is the third *character* of the path, so every member read as
  not-online, and against the object form it raised out of the check.

- **Tuning values xiRAID rejects are now caught before the operator
  confirms.** The four merge knobs were validated as `>= 0` against a
  documented range of 1–100000 µs, and `request_limit` had no upper bound
  at all, so an out-of-range edit planned cleanly and failed mid-apply.
  Edit Array pre-validates too, instead of letting a plan blocker be the
  first thing that says no.

- **A legal priority of `0` is no longer blocked on modify.** `xicli raid
  modify` documents `init_prio` and `restripe_prio` as 0–100 where `raid
  create` documents 1–100; the create floor was applied to both.
  `recon_prio` and `sdc_prio` stay at 1 on either surface, as documented.

- **Edit Array's labels state the range it actually enforces.** "Recon
  Priority (0-100)" invited a value both xiRAID and the control path
  reject. Labels are now generated from the same table the validator
  uses, so they cannot drift apart again.

### Added

- `docs/HealthCheck/raid-status-check.md` — the `raid_status` contract:
  the category table, the vendor wording behind each state, and the
  documented severity differences between the health check, the banner
  and the control path's `status.state`.

## [3.9.2] - 2026-08-16

No rebuild required — the change is Python TUI only, so the release-tag
checkout the update flow already performs is sufficient.

### Changed

- **Configuration History no longer displays the rollback risk class.**
  Every row read `destroying_data` — including `Modified array 'log':
  cpu_allowed=0-63`, a live tuning edit that disrupts nothing. An all-red
  column carries no signal and trains the operator to click past the
  confirmation it exists to gate, so it was worse than no column at all.

  Two fail-safes fire on the common path. Each is correct in isolation
  (`config-history/specs.md` §4.7) — the defect is that they are the rule
  rather than the exception. `SnapshotEngine.create_snapshot` classifies
  without passing `details`, so every `raid_modify` takes the "no details
  — assume worst case" branch; and the control path records its own
  operation kinds (`xiraid.array.modify`), which are not `OperationType`
  values, so they take the unknown-operation branch.

  The display is suppressed in all five places it appeared: the history
  list column, the snapshot-detail metadata row, the diff preview, the
  full diff, and the restore confirmation dialog. **Classification and
  storage are unchanged** — `rollback_class` is still computed and still
  written to every manifest — and no confirmation gate is lost, because
  nothing in the TUI branched on the class. Fixing the classification is
  tracked in [docs/TODO.md](docs/TODO.md); the display returns with it.

### Fixed

- **A long operation name no longer collides with the Status column in
  Configuration History.** `xiraid.array.modify` is 19 characters and the
  Operation column was 18, so the table rendered
  `xiraid.array.modifyapplied`. The column is now 21 wide, with
  truncation past 20.

## [3.9.1] - 2026-08-15

Requires-Rebuild: xinas_node_build

`xinas-api` and `xinas-agent` run compiled JavaScript from
`xiNAS-MCP/dist/`, which is not tracked in git. The fix in this release
is in the agent's `raid_show` parser, so without that role it never
reaches the host and the TUI keeps rendering the old value.

A single-fix release: the TRIM / Discard block added in 3.9.0 could never
show anything but `unknown`.

### Fixed

- **The Extended array view now reads discard under the name the daemon
  actually reports.** `Discard (TRIM)` and `Drive TRIM` rendered
  `unknown` on every array of every 3.9.0 install. The parser looked for
  `discard` and `drive_trim` — those are `xicli raid create` **flag**
  spellings, and `raid_show --extended` does not use them. Verified on a
  live node (`xicli 4.4.0`, driver `4.4.0-43861`): the payload's only
  discard keys are `discard_allowed`, `discard_active`, `discard_ignore`,
  `discard_verify` and `drive_write_through`. The same class of miss as
  the `resync_enabled` row removed in 3.8.0, and it survived review
  because the tests asserted the `unknown` and called it correct.

  `discard_allowed` now maps to `spec.tuning.discard` (what the array is
  **configured** to accept) and `discard_active` to the new
  `status.discard_active` (whether discards are being processed **right
  now**). The block renders both, because they diverge: on the reference
  node the initializing `data` array reads `allowed=1 active=0` while
  `log` reads `1/1`. Showing only the configured value tells an operator
  TRIM is reaching the media when the daemon is not processing a single
  discard.

  The `Drive TRIM` row is gone and `drive_trim` is no longer read at all.
  It TRIMs the member disks *before* the array is created — a one-shot
  action, not array state — so no `raid_show` will ever report it, and
  the row could only ever have printed `unknown`.

  `discard_ignore` / `discard_verify` remain unobserved on purpose
  ([docs/TODO.md](docs/TODO.md)): both are `raid modify` knobs, and
  surfacing them on `spec.tuning` without extending `CREATE_ONLY_TUNING`
  in the same change would offer a write path the vendored `RaidModify`
  descriptor silently drops.

  `status.discard_active` is additive in `api-v1.yaml` — no breaking
  schema change. Specs: `Storage/raid-management-spec.md` §3 and the §3.2
  render table, `control-path/s3-xiraid-array-spec.md` §5.

## [3.9.0] - 2026-08-15

> **Requires-Rebuild: nvme_namespace, raid_fs, xinas_node_build, xiraid**
> — four roles, for four independent reasons. `xinas_node_build` is the
> load-bearing one: `xinas-api` and `xinas-agent` run compiled JavaScript
> from `xiNAS-MCP/dist/`, which is not tracked in git, so without that
> role the fsid work and every other TypeScript change in this release
> never reaches the host. `xiraid` installs the renumbered xiRAID 4.4
> repository package, `raid_fs` carries the new discard decision, and
> `nvme_namespace` carries the corrected per-level minimum drive table
> and its fail-closed state checks.

The xiRAID 4.4 release. The installer now pulls xiRAID 4.4, and the
per-level rules that engine actually enforces — array-name character set
and length, minimum member counts, RAID 10's even-count rule, RAID 70's
group-size floor — are checked in the TUI and the control path before a
create is dispatched, instead of after the operator has confirmed it.
Alongside that, NFS `fsid` allocation moves off the clients and into the
server, and a long run of fail-closed and observation-honesty fixes stops
several surfaces from reporting a confident value they never read.

> **Caveat:** the server-side `fsid` allocation (#293) has not been
> smoke-tested on real hardware. No dev host carried the source or the
> built `dist/` for it; this release is what makes that test reachable
> through the normal update path. Treat the first NFSv4 mount after
> updating as the verification step.

### Added

- **NFS share `fsid`s are allocated server-side, collision-free.**
  `Share.spec.fsid` was required by the API and nothing assigned it, so
  every client allocated its own — two concurrent creates computed the
  same number and both applies succeeded, because the plans pin the
  Share id (which differs) and not the fsid (which does not). An fsid
  collision silently breaks NFSv4 client mounts. Allocation now happens
  in the `share.create` plan provider, and the plan→apply race is closed
  by a per-number marker row pinned absent in `affected_resources`: the
  losing apply fails `PRECONDITION_FAILED` and re-plans onto the next
  number. Clients may now omit `spec.fsid` on `POST /api/v1/shares`; an
  explicitly requested fsid that is already held is an `FSID_IN_USE`
  plan blocker rather than a silent substitution. Delete releases the
  marker, and boot backfills markers for pre-existing installs. The TUI
  stops allocating entirely. (#293)

- **Every per-level xiRAID rule is checked before dispatch.** The vendor
  audit had documented three rules as known gaps. RAID 10's even-member
  requirement becomes a `members_not_even` blocker; RAID 70's group-size
  floor of 6 becomes a per-level minimum rather than the generic 4.
  The create wizard now re-prompts at the drives step naming the level's
  own requirement ("RAID 5 needs at least 4 drives (3 selected)"), and
  applies range, divisibility and the two-group minimum at the group-size
  step — the first step where both level and drive count are known.
  `xinas_menu/utils/raid_rules.py` holds the Python-side constraints,
  mirroring `lib/xiraid/schema.ts`, with the vendor source and product
  version cited.

- **Discard is enabled on new arrays where the hardware allows it.**
  Discards issued by XFS were dropped at the RAID layer: xiRAID's
  `--discard` defaults to 0 and the installer never set it. The decision
  is made per array, probing each member for discard support
  (`discard_max_bytes`) and RZAT (the NVMe `DLFEAT` field, which xiRAID
  requires and sysfs can no longer answer). An ineligible member degrades
  to "create without discard", never to a failed create. `--drive_trim`
  is deliberately not passed — it TRIMs disks *before* creation, and
  xiRAID enables it on its own only when no disk carries metadata, which
  is exactly the safety check a forced flag would override.

- **A source-controlled xiRAID 4.4 hardware-key tool.** The opaque, stale
  `./hwkey` ELF binary is replaced by a stdlib-only tool computing the
  correct 4.4 v2 hardware key, byte-exact at the same path, with a shared
  library (`xinas_menu/utils/hwkey.py`), a TUI local-compute fallback,
  and a durable spec (`docs/Installer/hwkey-spec.md`). (#276)

### Fixed

- **The installer pulled a xiRAID version that no longer exists at that
  name.** 4.4 renumbers the multi-pack repository package from the old
  `1.x.y-NNNN` scheme to a product-aligned `4.4-1802`. The repo version
  now points at the real published `.deb` (verified live on
  `pkg.xinnor.io`), `xiraid_version` moves to 4.4.0, and the role READMEs,
  mounting-docs link and installer spec are synced.

- **Three surfaces each had a different idea of a legal array name and a
  legal member count.** The wizard allowed hyphens and 64 characters, the
  published OpenAPI pattern allowed `^[A-Za-z0-9_-]{1,63}$`, and `xicli`
  accepts neither — a name could pass the TUI and be rejected by the API,
  or pass both and be rejected by the engine after the operator confirmed
  the create. Per the xiRAID Classic 4.4 command reference the rule is 28
  characters of Latin letters, digits and underscore, with `power` and
  `uevent` prohibited; it now lives once in
  `xinas_menu/utils/xiraid_names.py`, is enforced in `validateCreateSpec()`,
  and the published pattern is tightened to match. Separately, the minimum
  drive counts disagreed three ways — the installer defaulted RAID 5 to 3
  and fell through to a `>= 2` catch-all for RAID 50/60, the control-path
  table said raid5 3 and raid50 6, and the wizard did not pre-validate at
  all. All three now carry the engine-enforced table (RAID 5 → 4,
  RAID 50/60 → 8), which matters most in the installer, where the
  under-count previously failed only after `nvme_namespace` had already
  destroyed and rebuilt every namespace.

- **Several surfaces failed open when they could not read the truth.**
  `nvme_namespace` now fails closed when storage state cannot be
  determined, and its `MATCH` path requires the arrays to be online
  (#279); Delete Array fails closed on dependency discovery; a
  filesystem whose dependencies cannot be read no longer reports as
  having none; and an unreadable NFS share list is no longer reported as
  an empty one, which had made a probe failure indistinguishable from a
  host with no shares.

- **The TUI reported outcomes it had not observed.** Audit entries now
  record what actually happened rather than what was assumed; the
  degraded-disks banner is threaded into the Spare Pools dialogs, and the
  false "all drives assigned" claim is suppressed when the fetch behind
  it was degraded; an operator with no drives is told that no drives
  means no observation, instead of being shown a clean result. A hung
  export no longer freezes the share list, config-history reset renders
  its progress instead of dropping every line, and Quick Actions hands
  the terminal to `btop` via `App.suspend()` rather than fighting it for
  the screen.

- **`xinas_history` snapshot store, GC and risk classification (WS4).**
  Seven fixes, chiefly fail-safe defaults that failed the wrong way: an
  undetermined risk classification defaulted to `non_disruptive` — the
  auto-proceed path — for exactly the cases the system understands least,
  and now defaults to `destroying_data`. Snapshot ids are validated before
  a store path is built, GC no longer runs lock-free or deletes an
  in-flight restore's source, ephemeral pre-change snapshots resolve to a
  terminal state, leaked `.tmp-*` staging directories are skipped, and the
  deprecated `datetime.utcnow()` is gone from all six sites. (#295)

- **Client DOCA OFED install is gated on NIC presence.** A client with no
  PCI vendor `0x15b3` device no longer pulls the DOCA repo, builds DKMS
  modules, or reboots for nothing. The gate is applied both in
  `client_setup.sh` (with a "[No Mellanox NIC]" indicator) and in the
  client `doca_ofed` role, so a direct `ansible-playbook` invocation is
  equally safe. (#294)

- **A carrier-down interface no longer fails a pool verify.** The agent
  defers verification instead. (#289)

### Changed

- **CI format-checks the whole repository.** `ruff format --check` was
  scoped to three package dirs and covered 113 files where the repo has
  247, so files under `tests/` and `collection/` kept drifting and
  reaching CI unformatted. The check is now whole-repo, honoring
  `extend-exclude`; `ruff check` deliberately keeps its scoped paths.

- **Day-2 RAID and NFS specs realigned with the control-path code.**
  `docs/Storage/raid-management-spec.md` and the NFS docs were describing
  behavior the code no longer had. Vendor-documented behavior is now
  separated from what was observed on a node, and `CLAUDE.md` requires
  third-party claims to be validated against the vendor's own
  documentation before a spec lands.

## [3.8.1] - 2026-07-27

> **Requires-Rebuild: xinas_node_build** — every fix below except the
> Active Sessions render is agent/API TypeScript, and a code-only update
> does not rebuild `dist/`. A host must re-run that role once on update
> to pick up the rebuilt bundle. Nothing here touches the network,
> storage layout, or systemd unit definitions.

The release that makes v3.8.0 actually land. v3.8.0 shipped
`Requires-Rebuild: xinas_node_build`, the rebuild ran and rewrote
`dist/`, but nothing restarted `xinas-api` / `xinas-agent` — so both
daemons kept serving the build they had loaded before the update and
every v3.8.0 control-path fix stayed inert on updated hosts. This release
fixes the restart gap and clears the remaining observe/apply defects
surfaced by end-to-end testing against a live host.

### Fixed

- **`xinas_node_build` rebuilt `dist/` but never restarted its
  consumers.** `xinas-api` and `xinas-agent` run compiled JavaScript out
  of `xiNAS-MCP/dist/` and read it once at process start; the role
  rebuilt the bundle and stopped, because the `xinas_api` / `xinas_agent`
  handlers fire only on their own unit/config changes, which a change
  confined to `xiNAS-MCP/src` never touches. v3.8.0 shipped with that gap
  — its fixes (including the `raid_show` `size` parse that left every
  array's capacity `N/A`) rewrote `dist/` and then kept running the old
  process, reporting success throughout. The build task now notifies
  uniquely-named handlers that restart `xinas-api` then `xinas-agent`
  (the agent `Requires=xinas-api.service`), each guarded on a stat of the
  unit so a host without them skips rather than fails. `Requires-Rebuild:
  xinas_node_build` is now sufficient for a TypeScript-only change on its
  own. (#269)

- **A legitimate network address change could never be applied, and a
  malformed one answered 500.** `verifyDev` read `ip -j addr show` once,
  immediately after `netplan apply` — but apply returns before
  systemd-networkd finishes reconfiguring (measured ~0.4 s early on a
  live IB host), so verify observed the post-flush empty state, threw
  `missing <cidr> after apply`, and the runner rolled every change back
  in both directions. Verify now polls to a settle deadline (15 s,
  250 ms interval) with an injectable budget. Separately, a blocked plan
  (e.g. a malformed CIDR) still rendered netplan, and `connectedSubnet()`
  threw on the unparsable CIDR, dying as `500 INTERNAL` and leaking an
  internal symbol; the render is now skipped when blockers exist, so a
  bad CIDR returns 200 with the `addresses_invalid` blocker. (#275)

- **The RAID tuning modify path was unreachable or silently lossy.**
  Three defects: `expected_revision` was absent from the MCP catalog's
  mutate schema and never coerced by the CLI, so every apply route
  answered `INVALID_ARGUMENT`; the vendored `RaidModify` proto was stale,
  so `sdc_prio` / `max_sectors_kb` / `adaptive_merge_path` modifies
  reached the daemon with the field silently dropped; and `translate.ts`
  emitted create-only knobs (`discard`, `drive_trim`, `resync_enabled`)
  on modify, which the daemon accepted as `success` while never applying
  them. Field numbers are taken from the running 4.3.1 descriptor,
  create-only knobs are now rejected pre-plan with
  `reason: create_only_tuning` (422), and a `coerceToSchema()` converts
  each string arg to the catalog-declared scalar type. (#272)

- **Exported shares were observed as not exported.** The observe-side
  `parseListExports` / `parseListSessions` read a wire shape the
  nfs-helper never emits, so both always returned `[]` — no `ExportRule`
  or `NfsSession` was ever observed even though writes worked. The health
  check reported `nfs.exports: <share> not exported` and
  `drift.nfs-exports: N missing` for shares that ARE exported, and
  `Share.status.exports` was always empty. Both parsers now read the real
  `{ok, result, request_id}` envelope and field names, an `ok:false`
  throws instead of returning `[]` (which would let the collector
  reconcile-DELETE good rows), and `drift.nfs-exports` normalizes
  `fsid=N` out of the comparison so the NFSv4 root export stops flagging
  a permanent false drift. (#274)

- **`cpu_allowed` rendered as `unknown` for arrays that really were
  pinned.** The xiRAID 4.3.x daemon reports CPU affinity as a JSON array
  of core ids (`cpu_allowed = [5, 6, 7]`), but `readTuning` accepted only
  the string shape the fake transport writes back, so the array failed
  the `typeof === 'string'` check and the knob was dropped before it
  reached the API. It is now range-compressed into the schema's existing
  string spelling (`[5,6,7]` → `"5-7"`, sorted and de-duplicated) — the
  value an operator would retype into the modify dialog — so a whole-node
  pin renders `"0-63"` instead of a 200-character list. A bare number
  stays unreadable on purpose (ambiguous between a core id and a
  bitmask). (#270)

- **Active Sessions rendered `? -> ?` for every NFS client.**
  `nfs.list_sessions()` returns `{client_ip, nfs_version, export_path,
  active_locks}` dicts, but `_format_sessions` read `s["client"]` /
  `s["path"]` — keys that shape never carries — so both fell through to
  the `?` default while the real client IP and export path sat unread.
  Now reads the documented `client_ip` / `export_path`, keeping the old
  keys as a fallback for an alternate session source. (#273)

## [3.8.0] - 2026-07-24

> **Requires-Rebuild: xinas_node_build** — the RAID observation fixes and
> the share-create preflight gate are agent/API TypeScript, and a
> code-only update does not rebuild `dist/`. A host must re-run that role
> once on update to pick up the rebuilt bundle. Nothing in this release
> touches the network, storage layout, or systemd units.

An observation-correctness cycle. Every fix below is a case where the TUI
printed a confident value it had never actually read — an unread tuning
knob rendered as `unlimited`, a member state the daemon did report
collapsed into `unknown`, a healthy exporter reported `inactive`, a
carrier-less loopback drawn as a fault. The new NFS restriction is the
one behavior change.

### Added

- **NFS shares are restricted to xiRAID-backed filesystems.** Exporting a
  path off a xiRAID array was accepted end-to-end, which let an operator
  publish the system disk. The TUI's Add Share now offers only xiRAID
  mount points and their subfolders, and the control path enforces the
  same rule independently: `share.create` runs a live, fail-closed
  preflight in `buildShareCreate` requiring the export path to sit at or
  under a `/dev/xi_*` mount, rejecting anything else with
  `EXPORT_PATH_NOT_ON_XIRAID`. A `findmnt` failure is distinguished from
  "no xiRAID filesystems present" so a probe error cannot read as an
  empty allowlist. Specs: `docs/Storage/fs-shares-management-spec.md`,
  `docs/control-path/s3-nfs-executor-spec.md`.

### Fixed

- **Array tuning was rendered entirely from defaults, never from the
  daemon.** Extended Details showed `Memory Limit | unlimited` while
  `apply_tuning` rejected the same edit with "RAID already has '2048'
  reserved MiBs". Three independent breaks stacked: the collector's
  `raid_show` omitted `extended: true`, so the daemon never emitted the
  tuning surface; `lib/parse/raid.ts` had no tuning mapping, so
  `spec.tuning` stayed empty regardless; and the renderer read each knob
  with a falsy-default (`memory_limit` → `unlimited`, `memory_prealloc` →
  `disabled`, every boolean → `Disabled`). A knob nobody read printed as
  the most reassuring possible value. The parser now maps the tuning
  surface, renames the daemon's unit-suffixed fields to their ADR-0006
  names, and **omits** any knob the daemon did not emit; the renderer
  prints those as `unknown`, keyed off `is None` rather than falsiness so
  a real `0` still means unlimited/disabled. The Resync row is gone —
  `resync_enabled` is create-only and never reported, so it could only
  ever have been a guess.

- **A daemon answering with object-shaped members parsed to a
  member-less array.** The member-path reader handled string and
  `[idx, path, [states]]` tuple shapes but not the per-device object
  (`{path|device|name: …}`) form the extended payload can carry — and the
  create wizard reads a member-less array as "those drives are free".
  Path extraction moved to a shared `devicePath()` helper. Same change
  restores the SDC Priority row (parsed and specced, missing only from
  the renderer) and relabels the Merge Read/Write Max knobs `(KB)` →
  `(us)`, the last place still mislabelling a time as a size.

- **A degraded array member was invisible in the array overview.**
  `parseRaidShow` hardcoded `status.member_states: []`, discarding the
  states the daemon reports inside each `raid_show` device tuple, so the
  Devices line counted every member as unknown and collapsed to a bare
  "N total". The parser now reads a per-member `{index, device, states}`
  record and maps each device path back to its control-path Disk id, so
  the overview renders "N total | k online | j degraded | i offline".
  Observation only: a state the daemon never reported stays absent rather
  than becoming a fabricated `online`.

- **A healthy xiRAID exporter was reported as inactive, permanently.**
  The upstream `.deb` is hyphenated as a package but installs its unit as
  `xiraid_exporter.service` (underscore); older builds shipped the
  hyphenated spelling, so both exist in the field. Every xiNAS call site
  assumed the hyphen, and because `systemctl show` exits 0 reporting
  `ActiveState=inactive` for an unknown unit, a wrong name was
  indistinguishable from a stopped service — so Integrations → xiRAID
  Exporter showed "inactive" for an exporter actively serving metrics on
  `:9827`, its Restart action restarted a non-existent unit and reported
  success (leaving a false status that could never be cleared), both
  health engines flagged the exporter as down, and the role's `service:`
  task would fail outright. The unit name is now resolved at runtime by
  probing `LoadState`, which distinguishes installed-but-stopped from
  unknown where `ActiveState` conflates them. `healthcheck.sh` embeds a
  standalone program that cannot import the resolver, so it carries a
  byte-identical copy pinned by a parity test; the uninstall role sweeps
  both spellings instead of guessing. Spec:
  `docs/Management/xiraid-exporter-spec.md`.

- **Loopback was drawn as a fault.** The kernel reports
  `operstate=unknown` for carrier-less devices, so `lo` arrived from
  `GET /network/interfaces` as `link_state: unknown` and the overview
  rendered `[??] lo / State: unknown`. Normalized to `up` for loopback
  devices only (identified by `/sys/class/net/<if>/type == 772`, falling
  back to the name). A loopback explicitly reported down still renders
  down, and a non-loopback with an unknown state keeps its `[??]` marker.

- **An interface whose driver cannot report link speed rendered as
  `-1M`.** `/sys/class/net/<iface>/speed` reports `-1` (or `0` on some
  drivers) when the speed is unknown, and an interface can be
  operationally up in that state; the main-page mini-status and System
  Status formatted the raw value while the network overview already
  showed `[----] ---`. New `format_link_speed()` / `read_link_speed()`
  helpers treat anything non-positive, unparseable, or read from a
  missing/EINVAL attribute as unknown, and both screens keep their own
  placeholder.

### Changed

- **`CLAUDE.md` refreshed against the current tree.** It claimed "No
  build/test system" against 15 blocking CI jobs, listed 9 roles in the
  playbook order where `site.yml` has 17 (omitting the entire
  `xinas_node_build` → `xinas_api` → `xinas_agent` control-path block),
  said 10 Ansible roles where there are 20, and omitted `xinas_menu/`,
  `xiNAS-MCP/`, and `tests/` from Key Directories. Replaced with a
  Verification section carrying the exact CI commands — including the
  three-path argument list that five jobs repeat verbatim and that
  `ruff check .` does not reproduce. Binding policy (release/update,
  spec-first, rebuild-trailer rules, netplan and storage-reset gotchas)
  is unchanged.

- **`ruff format` drift repaired under `tests/` and `collection/`.** CI
  format-checks only three paths, so drift accumulated unnoticed in
  7 files and blocked the repo-wide release gate. Formatting only.

## [3.7.0] - 2026-07-11

> **Requires-Rebuild: xinas_menu, xinas_node_build** — the helper-sync
> wrapper deploys via the `xinas_menu` role, and the audit-middleware
> change lives in the compiled `xinas-api` bundle
> (`xinas_node_build`). A host must re-run those roles once on update to
> pick up the new wrapper and the rebuilt bundle.

Closes the **WS3 installer & update-flow correctness** workstream — all
12 verified findings (F1–F12) plus review-surfaced follow-ups — and adds
two control-path fixes.

### Added

- **`xinas-update-helper-sync` privileged wrapper.** The in-TUI update's
  NFS-helper refresh must write the root-owned
  `/usr/lib/xinas-mcp/nfs-helper` tree and restart a root-run unit from
  the unprivileged `xinnor` user; a new root-owned wrapper (mirroring
  `xinas-update-git`: hard-coded paths, no caller input,
  `set -euo pipefail`, non-zero on failure) provides that under a
  NOPASSWD grant. This is the bootstrapping release — a host must re-run
  the `xinas_menu` role once to pick the wrapper up (F11a).
- **Update apply factored into one tested flow.** `XiNASApp` and
  `StartupApp` carried an independently-maintained checkout → rebuild →
  restart sequence in two untested files. They now delegate to a shared
  `update_apply.apply_update_flow()`: checkout, rebuild with an `rc != 0`
  safety stop (no refresh, no restart), the NFS-helper refresh, then
  restart. `refresh_nfs_helper()` returns one of five explicit outcomes
  (skip-covered / skip-absent / success / fail-with-wrapper /
  fail-without-wrapper), each with non-interchangeable remediation, and a
  refresh failure is a partial success — warn and still restart into the
  new code (F11b/F11c).

### Fixed

- **Interactive menus no longer die on a clean Exit, a missing `./hwkey`,
  or an update check.** Under `set -euo pipefail` a menu Exit (rc 2), a
  `chmod`/pipeline failure on an absent or non-zero `./hwkey`, and a
  backgrounded update check each aborted or silently no-op'd the installer
  (F1/F4/F7). Menu exit-2 is now guarded (so `install.sh` reaches the
  wrapper install), the hwkey call sites fall back to `unavailable`
  instead of a bare/blank field, and `check_for_updates` runs
  synchronously so its banner actually fires — with every network call
  bounded (a failed check reads as "no update" without hanging or aborting
  the shell).
- **Update/version checks compare release tags by semver — no downgrades,
  no injection, no false success.** A string inequality reported "update
  available" for any differing tag, including an *older* one, and could
  walk an install backward (F6); shared `_semver_parse`/`_semver_gt` in
  `lib/menu_lib.sh` now mirror `update_check.py`'s ordering (rejecting
  leading-zero/oversized components as unparseable → "not greater"). Every
  bash checkout path force-checks-out (the installed tree is git-dirty by
  design) and validates the ref against a shared `_is_release_tag()`
  semver regex before checkout — `install.sh` also drops a nested
  `bash -c` that made a quote in the tag a command-injection vector; the
  four regex copies are pinned byte-identical against drift (F5/F5c). The
  client and `prepare_system.sh` update paths stop swallowing
  fetch/checkout failures and no longer print "updated" on failure
  (F8/F9).
- **`XINAS_UPDATE_REPO` removed; dev-only repo repointing gated off.** An
  env var could redirect version comparison, release notes, rebuild
  trailers, and the download link at a spoofed feed; it is removed across
  all five surfaces (F12). The expert menu's "Git Repository
  Configuration" (which repointed and `git pull`'d an arbitrary branch — a
  Release-Policy violation) is now gated behind `XINAS_DEV_REPO_CONFIG=1`,
  off by default. `XINAS_UPDATE_CHANNEL` is unaffected.
- **`yq` is pinned and checksum-verified.** It was fetched from
  `releases/latest` with no version pin, no checksum, and a hardcoded
  `amd64` asset; the installer now pins `v4.53.3`, selects the asset by
  `uname -m`, verifies its sha256 before install, and aborts on mismatch
  or an unsupported arch (F2).
- **Honest install-failure dialog.** The "Collect Diagnostics" choice was
  a dead end handled identically to "close" while its label falsely
  claimed an auto-upload; it now invokes `collect_data.sh` and is
  relabeled to match what actually happens (F10).
- **Agent observation pushes no longer flood the audit trail.** The audit
  middleware recorded an `http.POST./observed` row for every
  `xinas-agent` observation push; the `PollDriver` full-sweep buried real
  operator actions under hundreds of identical rows. `POST
  /internal/v1/observed` is now skipped in `auditMiddleware` (the agent's
  low-frequency internal routes stay audited).
- **User delete stops orphaning XFS quotas; new accounts require a
  password.** `_collect_user_quotas` read a `quota -u -N -b` form that
  printed nothing for a user with a limit on this xiRAID-backed XFS, so
  delete saw no quota to clear and `userdel` orphaned it onto the freed
  UID (a later `useradd` reusing that UID inherited the stale limit);
  quota collection now uses `report -u` and clears reliably. Passwordless
  new accounts also no longer land in a Locked state.

## [3.6.5] - 2026-07-10

> **Requires-Rebuild: xinas_agent, xinas_node_build** — the sandbox fixes
> land in `/etc/systemd/system/xinas-agent.service`, which only the
> `xinas_agent` role re-installs; the pool and array fixes are agent-side
> TypeScript, and a code-only update does not rebuild `dist/`. Both roles
> are the same pair 3.6.4 asked for, so a host that took 3.6.4 simply
> converges. Neither role touches the network.

### Fixed

- **Every spare pool was observed empty, and every live pool was observed
  inactive.** The real xiRAID 4.3.x daemon lists a pool's members as
  `[idx, path, [state]]` triples and reports `state` as a list of words.
  `parsePoolShow` read the device path as the tuple's *last* element, so it
  got `["ready"]` — an array, not a string — and filtered every drive out;
  `active` was read as a bare string and never matched a list. The blast
  radius ran well past the Spare Pools screen: the TUI drive picker offered
  drives the pool already owned (the daemon then rejected `pool add`, which
  surfaced as `FAILED_PARTIAL_ROLLED_BACK`), the RAID create wizard offered
  a live array's spares as free devices, and a false `active` disarmed
  **both** pool-delete guards, leaving an active pool deletable through the
  API. The path is now found by scanning the tuple for the `/dev/…` string
  rather than by fixed index, and `state` is accepted as either a word or a
  list of words. Tests carry the captured payload verbatim — the shape the
  fake transport emitted was invented, which is why 1370 green tests never
  saw this.

- **A failed `pool add` rolled back the pool's pre-existing members.** The
  pool modify executor reversed the whole spec instead of the delta it had
  caused. Because `pool add` fails as a unit when any named drive is already
  a member, the inverse `poolRemove(spec.drives)` targeted the members the
  task had never touched. Observed live: a failed 3-drive add rolled back
  into a `pool remove` of the pool's two existing members, and survived only
  because the daemon rejects an all-or-nothing remove naming one non-member.
  Each intent now snapshots membership and active state before mutating and
  reverses only what actually changed; a missing snapshot means rollback does
  nothing, because a no-op beats a guessed reversal.

- **Editing a RAID array always failed.** Three spare-pool reads in the
  modify executor still used a local array-shaped reader for `raid_show`,
  which the real daemon keys by array name. Verify threw
  `array '<name>' vanished` on every edit — after `raid_modify` had already
  succeeded — and surfaced as `FAILED_PARTIAL_ROLLED_BACK`. The
  foreign-sparepool preflight guard never fired, so an array on an
  operator-managed pool was silently re-pointed at `xnsp_<array>`, and
  rollback mis-captured the pre-state, leaving an array referencing a deleted
  pool. All three now route through the shared `readShow` normalizer.

- **Every `fs.create` died at the mkfs stage and rolled back.** `mkfs.xfs`
  sets the device's soft block size with `ioctl(BLKBSZSET)`, which the kernel
  gates on `CAP_SYS_ADMIN` and denies with `EACCES` — not a permissions
  problem on the device node, which is what the ADR-0007 sandbox audit had
  assumed when it ruled the row "no extra capability needed". The agent runs
  `User=root` but bounded to `CAP_CHOWN CAP_NET_ADMIN`, so the `capable()`
  check failed however `/dev/xi_*` was owned. `fs.grow` carried the identical
  defect through `xfs_growfs`; it went unnoticed because a filesystem that
  cannot be created cannot be grown. `CAP_SYS_ADMIN` is now granted in both
  `CapabilityBoundingSet` and `AmbientCapabilities`. Read the grant as an
  accident guard, not a containment boundary — the unit already runs as root
  with `/etc/systemd/system` writable.

- **Every `net.iface.update` and `net.pool.apply` died at `render_write`.**
  `netplan generate` writes `/run/udev/rules.d/90-netplan.rules`, which the
  ADR-0008 sandbox audit missed when it enumerated netplan's runtime outputs,
  and `ProtectSystem=strict` mounts all of `/run` read-only. The write hit
  `EROFS`, and because `netRollback` re-runs `netplan generate` to re-validate
  it failed identically — so a stage that had touched no kernel state reported
  as `FAILED_MANUAL_RECOVERY_REQUIRED`. `-/run/udev` is added to
  `ReadWritePaths`, optional like `/run/netplan`. Both sandbox fixes are
  guarded by unit-file contract tests, but neither is proven on hardware: the
  fake host never execs `mkfs.xfs`, so no unit or e2e coverage can surface a
  kernel capability check.

- **A cold install left the InfiniBand ports with no addresses, and still
  exited 0.** On a ConnectX card in InfiniBand mode `mlx5_core` creates no
  netdev — the `ibN` interfaces come from `ib_ipoib`, loaded only when
  `openibd` starts. `doca_ofed` restarts `openibd` via `notify:`, and Ansible
  defers handlers to the end of the play, so `net_controllers` scanned
  `/sys/class/net` with the restart still queued, found nothing, and wrote its
  "no high-speed interfaces were detected" placeholder netplan. This only
  reproduces on a genuinely cold node — any reinstall over an existing OFED
  already has `ib_ipoib` loaded. Fixed with `meta: flush_handlers` at the end
  of `doca_ofed`. **Affects fresh installs only**, which is why this release
  does not ask updating hosts to re-run `doca_ofed`. (#264)

- **Two CI failures.** `_semver_key` took an `Optional` straight from
  `_parse_semver` — no crash was reachable, but pyright cannot narrow through
  the guarding bool, so the typecheck job failed; the `None` checks now fold
  into the early return. Nested backticks in `docs/Installer/update-spec.md`
  closed a code span early and tripped markdownlint MD038.

## [3.6.4] - 2026-07-10

> **Requires-Rebuild: xinas_agent, xinas_node_build** — the unit-file fix
> only takes effect once the `xinas_agent` role re-installs
> `/etc/systemd/system/xinas-agent.service`; a code-only update leaves the
> broken unit in place. `xinas_node_build` is carried forward so a host
> updating from 3.6.2 or earlier rebuilds `dist/` and picks up the 3.6.2
> RAID fix. Neither role touches the network.

### Fixed

- **The agent ran with no namespace restriction at all.**
  `RestrictNamespaces=~cgroup ~user` does not mean "deny cgroup and user":
  the leading `~` already negates the whole list, so the second one is a
  parse error. systemd logs *"Failed to parse namespace type string,
  ignoring: cgroup ~user"* and drops the directive entirely — the exact
  opposite of what the comment above it promised, on every start. Corrected
  to `RestrictNamespaces=~cgroup user`, which denies both. (#263)

- **The agent lost its NfsSession sweep on every boot.** The unit had no
  ordering against `xinas-nfs-helper.service`, but the `NfsSession`
  collector connects to `/run/xinas-nfs-helper.sock` in `initialSweep()`,
  so boot raced the helper and failed with
  `connect ENOENT /run/xinas-nfs-helper.sock`. Added `After=` + `Wants=`
  (soft, so the agent still starts where the helper is not deployed;
  `Requires=` would couple their failures). This narrows the window rather
  than closing it — the helper is `Type=simple`, so ordering guarantees
  only that it was forked, not that it has bound the socket. The residue is
  benign: `boot.ts` skips a failed sweep and `PollDriver` re-sweeps once the
  probe recovers. Closing it fully needs socket activation or `Type=notify`.
  (#263)

  Both regressions are now guarded by `tests/test_agent_unit.py`.

## [3.6.3] - 2026-07-10

> **Requires-Rebuild: doca_ofed, motd, net_controllers, xinas_agent,
> xinas_node_build** — the code change itself is Python-only and needs no
> rebuild. These roles are **carried forward** for hosts that never ran
> them: 3.6.0's and 3.6.1's trailers never parsed (see below), and a host
> running 3.6.2 or older still reads only the incoming release's notes with
> the old, strict parser. Re-running `net_controllers` flushes PBR tables
> 100–199 and all mlx interface IPs before re-applying — expect a brief
> interruption on the data interfaces. All the roles are idempotent, so a
> host already carrying these changes simply converges.

### Fixed

- **`Requires-Rebuild:` trailers were silently lost two different ways.**
  An unparsed trailer is indistinguishable from no trailer, so the update
  checked out the new code and skipped the Ansible step that makes it
  effective — with no warning to the operator.
  - `parse_rebuild_trailers` anchored the trailer at column 0, but release
    notes wrap it in a Markdown callout. **v3.6.0**
    (`motd, xinas_node_build`) and **v3.6.1**
    (`net_controllers, doca_ofed`) both bolded and blockquoted the line, so
    neither release ever re-ran a single role on an updating host. The
    parser now tolerates leading blockquote markers (`>`), emphasis
    (`*`, `_`), backticks and whitespace, and strips the same decoration
    from each tag. A prose mention mid-sentence still does not match.
  - The checker parsed only the **latest** release's body, so every release
    an operator skipped lost its rebuild — a host jumping 3.6.0 → 3.6.2
    never saw 3.6.1's notes, yet 3.6.1's roles still had to run there.
    Trailers are now unioned across **every eligible release strictly newer
    than the installed version** (drafts and prereleases were already
    filtered); `all` anywhere in that union short-circuits. Only the latest
    release's notes are still shown to the operator.

  The union takes effect for hosts running 3.6.3 or later — an older host
  uses its own installed parser for the next check, which is why this
  release carries the missing roles forward explicitly.
  `docs/Installer/update-spec.md` gains a *Rebuild trailers* section.

## [3.6.2] - 2026-07-10

> **Requires-Rebuild: xinas_node_build, xinas_agent, net_controllers,
> doca_ofed** — the RAID fix is agent-side TypeScript, and a plain
> code-only update does not rebuild `dist/`, so `xinas_node_build` and
> `xinas_agent` must re-run for array delete/create to work against the
> xiRAID daemon. `net_controllers` and `doca_ofed` are carried over from
> 3.6.1: that release's trailer was wrapped in a Markdown blockquote and
> never matched `parse_rebuild_trailers`' line-anchored regex, so updating
> hosts never re-rendered netplan and their data NICs may still be
> unaddressed. Re-running `net_controllers` flushes PBR tables 100–199 and
> all mlx interface IPs before re-applying — expect a brief interruption on
> the data interfaces.
>
> Write the trailer as a bare, column-0 line in release notes. The update
> flow reads only the **latest** release's body, so a trailer that fails to
> parse (or a release the operator skips) silently drops its rebuild.

### Fixed

- **RAID array delete always failed on real hardware.** `Delete Array`
  tore down the NFS share, unmounted the filesystem and removed the mount
  unit, then stopped at `preflight: array '<name>' does not exist on the
  daemon` — while the array was there the whole time. The task executors
  kept private, array-only readers for `raid_show` / `pool_show`, but the
  real xiRAID 4.3.x daemon keys both payloads by array name
  (`{"data": {...}, "log": {...}}`). Those readers returned an empty list,
  so every live array read as absent. `2868136` (v3.5.0) fixed the
  collector's copy of the reader and left the others, which is why the TUI
  could list an array the executor then denied existed. Beyond the delete
  failure this also meant:
  - `create` skipped its name-collision and claimed-device guards, then
    timed out in `wait_online` while leaving the new array behind;
  - `modify` / rename saw no array;
  - delete's spare-pool cleanup silently skipped;
  - `pool.delete` skipped its "still referenced as a spare pool" guard,
    allowing deletion of a pool an array was actively using;
  - observed `spare_disk_ids` was always empty.

  All four readers now route through the shared normalizers
  (`parseRaidShowEntries`, `parsePoolShow`), and
  `docs/control-path/s3-xiraid-array-spec.md` §8 records the one-reader
  rule so a fifth copy does not appear.

- **Create rollback could destroy an array it never created.** Repairing
  the payload-shape bug above re-armed the create executor's name-collision
  guard — and its rollback then destroyed whatever `raid_show` listed under
  the target name, including a pre-existing array. A `create` that failed
  preflight because the name was taken would have wiped the operator's
  array of that name. The destructive branch is now gated on a
  `create_attempted` stash marker (the delete executor's existing idiom),
  restoring the contract `s3-xiraid-array-spec.md` §7 already specified:
  *if `created` → `raidDestroy`; else no-op.* Reproducible on the
  array-shaped fake transport, so it predated the shape fix — the shape bug
  had been masking it on real hardware.

  Covered by six regression tests exercising both payload shapes.

## [3.6.1] - 2026-07-09

> **Requires-Rebuild: net_controllers, doca_ofed** — the fix re-renders
> netplan through the `net_controllers` role and resolves the IB udev
> template in `doca_ofed`, so updating hosts must re-run both roles for
> data interfaces to actually get addressed.

### Fixed

- **Data NICs never got an IP from the pool.** The `default` and
  `xinnorVM` presets each shipped a static `netplan.yaml.j2` snapshot
  (taken in `6b6819f`, before the role template became dynamic).
  `autoinstall.sh` copies preset files over role files, so every install
  replaced the dynamic template with a config for a single non-existent
  `ib0` interface — `net_controllers` still detected the NICs and computed
  `net_allocated_ips`, but the render discarded them, leaving the data
  interfaces unaddressed and never brought up. The `ib0` rename path was
  also dead: `ib_netplan_template` pointed at `/opt/provision` (never
  installed to), so `configure_ib_udev.sh` returned at its `[ ! -f ]`
  guard while still reporting "changed". The fix:
  - drops the two preset `netplan.yaml.j2` snapshots so the role's dynamic
    template survives (as already done for `nvme_namespace.yml`);
  - resolves `ib_netplan_template` via `playbook_dir`, matching the
    `common` role;
  - makes `configure_ib_udev.sh` emit `noop:` / `changed:` / `unchanged:`
    markers and keys `changed_when` off the marker, so a no-op is visible;
  - stops `configure_manual()` from inventing `ib0:100.100.100.1/24` when
    the operator configures nothing (it had already disabled the IP pool,
    so cancelling out stranded every NIC).

  With the snapshots gone, the three IB ports render as
  `ibp65s0` / `ibp9s0f0` / `ibp9s0f1` on `10.10.{1,2,3}.1/24`, MTU 4092,
  each with its own routing table. Covered by
  `tests/test_net_controllers_template.py`.
  ([#262](https://github.com/XinnorLab/xiNAS/pull/262))

## [3.6.0] - 2026-07-09

> **Requires-Rebuild: motd, xinas_node_build** — updating from an
> earlier release re-runs the `motd` role (relocated banner cron) and
> rebuilds the control-path node (`xinas_node_build`) for the agent
> delete-preflight fix.

### Added

- **Uninstall is gated behind expert mode, and uninstall output is
  readable.** The Management → "Uninstall xiNAS" entry no longer appears
  in a normal `xinas-menu` run — it shows only in the new expert mode
  (`xinas-menu -e` / `--expert`), since uninstall is rare and
  destructive and must not sit one keypress away in the day-2 menu.
  Direct `uninstall.sh` invocation is unaffected. `uninstall.sh` now
  forces `ANSIBLE_STDOUT_CALLBACK=default` for the playbook run, so the
  operator sees named tasks instead of the raw per-task JSON blobs that
  `ansible.cfg`'s pinned `minimal` callback produced. See
  `docs/Installer/uninstall-spec.md` §2.1, §2.2.

### Fixed

- **TUI: modal dialogs no longer crash or pop the wrong screen on a
  double-dismiss.** A duplicated input event (double Enter, double-click)
  could queue a second dismiss before the first popped the screen;
  textual 8.2.8's `Screen.dismiss` pops unconditionally, so the duplicate
  popped the wrong screen — or raised `ScreenStackError` when only the
  base screen remained. A shared `GuardedModalScreen` mixin makes
  `dismiss()` a no-op once the screen is inactive; every modal dialog now
  uses it — `SelectDialog`, `ConfirmDialog`, `InputDialog`,
  `ChecklistDialog`, `TextAreaDialog`, `DrivePicker`, and `TaskWaitDialog`
  — each with a back-to-back double-dismiss regression test.
- **TUI: control-path task failures now show the failing stage's
  message.** A failed task previously rendered only
  `task <id> ended failed (<error_code>)`; the actionable detail (e.g.
  `preflight: /mnt/data is already a live mountpoint`) was in the task
  record but never surfaced. `TaskFailed`/`TaskCancelled` now carry the
  stage `error_message`, `ConfirmDialog` wraps long lines instead of
  clipping them, and the "Retry with force?" consent appears only for the
  filesystem executor's existing-filesystem gate rather than on every
  failure.
- **Agent: delete-preflight failures are no longer escalated to
  `requires_manual_recovery`.** The `xiraid.array.delete` executor's
  rollback threw "destructive operation: rollback unsupported" whenever
  `raid_show` reported the array absent or itself threw — even when the
  failure originated in preflight and nothing destructive was attempted.
  The destroy stage now records a `destroy_attempted` marker before
  calling `raid_destroy`; with the marker absent, rollback is a no-op
  that never queries the daemon, yielding a clean, retryable `failed`.
  See `docs/control-path/s4-xiraid-array-mutations-spec.md` §7, §12.
  **Requires-Rebuild: xinas_node_build**
- **Uninstaller safety (WS2).** Four independent hazards in the teardown
  path are fixed:
  - **Config-history store is never purged on role re-runs.** The
    `xinas_history` role deleted `snapshots/`, `baseline/`, and `state`
    on *every* run, so any day-2 `site.yml` re-run destroyed all rollback
    history. Store dirs are now created idempotently and never removed.
  - **`--dry-run` never deletes.** `rm -rf "$INSTALL_DIR"` was
    unconditional, so a dry run actually deleted `/opt/xiNAS`; it is now
    guarded by the dry-run check. Each `--remove-*` flag now answers only
    its own question instead of forcing global non-interactive mode.
  - **RAID teardown is scoped to xiNAS-managed arrays and the OS disk is
    excluded from drive clean.** Teardown previously destroyed *every*
    xiRAID array/pool and cleaned *every* NVMe device, including foreign
    arrays and the system drive. It now filters to managed names and
    excludes the resolved system drives.
  - **Banner-refresh cron is removed on uninstall.** The cron job
    installed into root's crontab but uninstall only removed
    `/etc/cron.d/xinas-banner`, so the job survived. The job now lives at
    the `cron.d` path (with migration away from the legacy root-crontab
    entry). **Requires-Rebuild: motd**

### Changed

- **`docs/Installer/uninstall-spec.md` §4.3:** namespace re-consolidation
  is deliberately not performed on uninstall — the pre-install namespace
  layout is not recorded in the install baseline, so re-consolidation
  would be a guess; a subsequent install reshapes namespaces via
  `nvme_namespace`.

## [3.5.0] - 2026-07-09

### Added

- **Config-history tombstones: deleted config files are tracked and
  restorable (ADR-0017, S13).** Snapshots now record `absent_files` — the
  well-known system config files that did not exist at snapshot time —
  explicitly at creation, never inferred after the fact. File-level
  rollback recreates a deletion when the target snapshot tombstones a file
  that exists now, restore computes a `delete_set` for tombstoned files,
  and `restorable` was widened to cover them. The control-path API adopts
  tombstone deletes (primary-kind config files only) and can apply and
  revert a desired-delete; the TUI snapshot detail screen lists the
  tombstoned paths. Covered by an end-to-end tombstone/adopt test and
  runbook §5g.

### Fixed

- **Agent: a completed array destroy is no longer escalated to
  `requires_manual_recovery`.** Any hiccup after a successful
  `raid_destroy` (spare-pool `pool_show` error, transient `raid_show`,
  async propagation delay) escalated a cleanly completed destroy to
  `FAILED_MANUAL_RECOVERY_REQUIRED` and halted teardown. Post-destroy
  steps are now best-effort or confirmation-only: spare-pool cleanup
  failure warns instead of failing the stage, `verify` polls for the
  array to clear with a bounded wait, and `requires_manual_recovery` is
  reserved for a `raid_destroy` call that itself failed mid-way. See
  `docs/control-path/s4-xiraid-array-mutations-spec.md` §7.
- **Agent: observed state settles after a successful apply.** Teardown
  chains (`fs.unmount` → `fs.unmanage`) raced the 60-second collector
  poll: the next step's preflight read the stale pre-apply state and
  returned a false `fs_mounted` blocker. The agent TaskRunner now re-runs
  the collectors for the kinds an operation mutated and flushes them to
  the API KV before the terminal event, so a chained plan reads
  post-apply state. See `docs/control-path/s2-task-envelope-spec.md`
  §7.1.
- **TUI: "Remove Share" on the NFS screen did nothing.** A refactor left
  `NFSScreen._remove_share` without its `@work` decorator, so the menu
  handler created and dropped a coroutine. The decorator is restored and
  a structural test guards all sync-handler worker calls.
- **Log collectors: default transfer server updated to
  `5.75.230.104:8080`** in `collect_data.sh` and the TUI Collect Logs
  screen; the `TRANSFER_SERVER` override is unchanged.
  ([#260](https://github.com/XinnorLab/xiNAS/pull/260))
- **Uninstaller: `--remove-xiraid` also purges `xiraid-appimage` and
  `xiraid-kmod`.** xiRAID 4.3 installs both as held dependencies of
  `xiraid-core`, so purging the metapackage alone left `xicli` and the
  prebuilt kernel module behind, violating the uninstall spec's §9
  guarantee.

## [3.4.1] - 2026-07-08

### Fixed

- **OS-disk resolution across `lsblk -s` tree output (`nvme_namespace`).**
  `resolve_system_disks.sh` walks each OS mount down to its backing disk
  with `lsblk -s`, whose NAME column carries box-drawing glyphs (e.g.
  `└─/dev/nvme0n1`) and, for a branching root such as an MD-mirror, a
  `│ ` continuation field — even with `-n -p`. The awk read a fixed field
  and emitted the name verbatim, so callers got glyph-prefixed paths (and
  lost mirror members), `resolve_system_disks.yml` then dropped them via
  its `^/dev/` filter, and every guided-LVM / MD-mirror install aborted
  with `CRITICAL: Could not detect the OS system drive` (a fail-closed
  guard — no data was wiped, but the install could not proceed). TYPE is
  now keyed off the last field and the name taken from `$(NF-1)` with
  everything before `/dev/` stripped, so linear (LVM) and branching (MD
  mirror) roots both resolve to every backing disk. The unit test now
  stubs the real tree-glyph output, including the branching MD case
  ([#258](https://github.com/XinnorLab/xiNAS/pull/258)).

## [3.4.0] - 2026-07-08

### Added

- **Non-destructive `site.yml` re-run (storage-reset safety).** Re-running
  the installer over a healthy array now converges instead of risking a
  reformat. The `nvme_namespace` role performs read-only storage-state
  detection that classifies each data drive as **MATCH** (already
  provisioned to the intended layout), **EMPTY**, or **FOREIGN**, and
  gates namespace rebuild + cleanup on that state. `raid_fs` reuses the
  detected state to gate the drive-clean and MD sweep and makes a
  converge/fail-fast `mkfs` decision instead of reformatting on a label
  mismatch. Destroying and rebuilding storage now requires the explicit
  `xinas_storage_reset: true` with an interactive `YES` (or
  `nvme_skip_cleanup_confirmation: true` for automation), surfaced
  through a shared fact-guarded confirmation banner that discloses
  exactly which devices will be wiped. See
  [docs/Installer/raid-spec.md](docs/Installer/raid-spec.md) §11.

### Changed

- **Legacy wipe knobs disarmed.** `xfs_force_mkfs` and
  `nvme_use_existing_namespaces` no longer trigger destructive actions on
  their own; storage is only destroyed via the explicit
  `xinas_storage_reset` path above. The disarmed `xfs_force_mkfs` pin was
  removed from the lab inventory and the preset `raid_fs.yml` files.
- **OS disk protected across LVM/ZFS/MD roots.** Detection and cleanup
  now resolve the system disk through its LVM/ZFS/MD backing devices (via
  `lsblk` paths) and exclude it from every wipe and namespace operation.

### Fixed

- **`nvme_namespace` hardening.** Per-device wipe error isolation (one
  drive's failure no longer aborts the sweep); explicit failure on
  unexpected single-namespace layouts instead of a dead fallback;
  partition tables wiped on the resolved block devices with the scope
  disclosed in the confirm banner; ZFS vdevs resolved via `lsblk`;
  detection facts kept clean by routing helper `echo` output to stderr; a
  loud guard when a required helper is missing; and defensive `rc` checks
  in delete-tracking so skip mode reliably skips.
- **`xinas-agent` task lifecycle.** A pre/post-stage throw can no longer
  hang a task — the agent always emits a terminal event. Apply tasks no
  longer hang at `snapshot_before` (the agent is granted config-history
  RW). Disk observation batches with null model/serial are no longer
  rejected (null fields are omitted before the batch is sent).
- **Reinstall without reboot.** The installer now `reset-failed`s the
  xiNAS units so reinstalling no longer fails with `EBUSY` on units left
  in a failed state.
- **Config-history correctness.** Snapshot ids now carry microsecond
  resolution so two snapshots created in the same second no longer
  collide, and auto-rollback restores the changed files directly instead
  of re-running `site.yml`.
- **`/var/log/xinas` ownership.** The `xinas_menu` role no longer
  clobbers `/var/log/xinas` ownership, which was crash-looping
  `xinas-api`.

### Rebuild required

Updating to this release rebuilds the node agent and its TypeScript
bundle (agent lifecycle fixes) and re-runs the `xinas_menu` role (log
ownership fix):

    Requires-Rebuild: xinas_node_build, xinas_agent, xinas_menu

## [3.3.0] - 2026-07-06

### Added

- **Installing operator is auto-added to `xinas-admin`.** Without a human
  member of `xinas-admin`, a non-root operator hit
  `connect EACCES /run/xinas/api.sock` from `xinas-mcp-stdio` and the CLI
  until they manually ran `usermod -aG`. The `xinas_api` role now resolves
  the operator behind the install (`SUDO_USER`/`USER`; root and empty
  skipped) and appends them — plus any accounts in the new
  `xinas_api_admin_users` list — to `xinas-admin`. `append: true` means
  nobody is created or removed; opt out with
  `xinas_api_add_installing_operator: false`. Requires the `xinas_api`
  role to re-run on update.
- **Actionable hint when the API socket rejects an MCP connection.**
  `xinas-mcp-stdio` now maps the socket errno to a fix — `EACCES` → join
  `xinas-admin` (or run as root); `ENOENT`/`ECONNREFUSED` → check
  `systemctl status xinas-api` — instead of surfacing a bare
  `connect EACCES … api.sock`. The raw errno and socket path are kept.
- **Break-glass control-plane restart on the MCP screen.** A guarded
  "[R] Restart Control-Plane (api+agent)" action on Integrations → MCP
  Server restarts `xinas-api` then `xinas-agent` (order matters — the
  agent `Requires=`/`After=` the api). A confirm dialog warns it
  disconnects active remote MCP/API sessions; it never stops a daemon,
  never targets the agent alone, and is audit-logged as
  `mcp.control_plane_restart` (#250).
- **User deletion clears XFS quotas first.** XFS user quotas are keyed by
  numeric UID, so a plain `userdel` orphaned the account's block limits and
  a later `useradd` reusing the freed UID silently inherited them. Delete
  now snapshots the user's per-mount quotas, names them in the confirm
  dialog, clears each to 0/0 via the NFS helper, then runs `userdel -r`;
  on any failure every already-cleared quota is restored and the account
  left intact.
- **Account lock status in the List Users table.** A new Status
  (Locked/Active) column sourced from `passwd -S` surfaces lock state
  without drilling into Manage User.
- **NFS helper pre-creates its op lock files at startup.** All four flock
  lock files (`/run/xinas-exports.lock` and the nfs-conf/idmap/profile
  locks) are created empty in `run_server()` before accepting
  connections, so the lock surface is deterministic and observable from
  boot rather than appearing lazily on first use.

### Fixed

- **TUI MCP Server screen retargeted to `xinas-api` config.** The screen
  still spoke to the retired `xinas-mcp` daemon — restarting `xinas-mcp`
  after every write and reading/writing `/etc/xinas-mcp/config.json` in
  the legacy schema. Post-S8 (ADR-0010) the MCP transport lives inside
  `xinas-api.service`; the screen now restarts `xinas-api` and reads/writes
  `/etc/xinas-api/config.json` in the real `ApiConfig` schema
  (`mcp.http`, `mcp.allow_apply`, `tokens: {token: {principal, role}}`),
  preserving the file's `0640 root:xinas-admin` mode/owner. Drops the TLS
  UI, adds an "Allow MCP apply" toggle, protects the bootstrap admin
  token, and fixes the Claude Code registration hint (`xinas-mcp-stdio`).
- **VM-aware fallback when NVMe detection finds no data drives.** An
  unattended default-preset install on a KVM/virtio VM aborted
  mid-pipeline (`nvme_namespace` found 0 data drives, `raid_fs` then
  failed on an undefined `xiraid_arrays`). It now re-probes all block
  devices and, on a VM, auto-continues in whole-disk mode with a forced
  RAID1 log; on bare metal or a diskless host it fails with an actionable
  message.
- **Updates no longer abort on a dirty install tree.** The installer copies
  preset files over tracked files, so `/opt/xiNAS` is git-dirty by design;
  when a release also changed one of those files, `git checkout <tag>`
  aborted. The update now force-checks-out the release tag (discarding
  local modifications to *tracked* files only; untracked
  `.xinas_applied_preset`, `keys/`, logs preserved). Requires the
  `xinas_menu` role to re-run on update.
- **Active filesystems are no longer dropped from observed state.** The
  agent wrote `systemctl is-enabled` output into `mount_unit_state`, which
  the control-path schema constrains to systemd `ActiveState`, so every
  enabled `.mount` unit 400'd at `/internal/v1/observed` and was silently
  dropped — a mounted `/mnt/data` never reached the store and the TUI
  showed "No XFS filesystems found." The probe now queries
  `systemctl is-active`, and the publisher surfaces non-retryable 4xx
  rejections to the journal instead of dropping them silently.
- **Leaked task leases are reclaimed — no more spurious "resource is
  locked".** Deleting a just-created NFS share failed with
  `CONFLICT: resource is locked by another task` because nothing drove the
  60s lease TTL. A new 30s lease sweeper reaps expired leases whose holder
  is already terminal (never touching in-flight work), the terminal-event
  state transition and lease release now run in one transaction, and a
  `lease_held` conflict renders a calm "temporarily locked… wait and retry"
  dialog.
- **RAID/share/filesystem deletes no longer 404 on ids containing `/`.**
  A Share id mirrors the export path minus its leading slash
  (`/mnt/data` → `mnt/data`), so raw interpolation split
  `DELETE /api/v1/shares/mnt/data` into two segments and matched no route,
  aborting "Delete Array" on step 1. Every id-in-path call site now
  percent-encodes the id as a single segment via `control_client.quote_id()`.
- **View Audit Log merges the control-path trail.** The screen read only
  the local `/var/log/xinas/audit.log`, so shares created via MCP/API
  (recorded as `share.create` in the hash-chained `GET /api/v1/audit`
  trail) never appeared. It now queries both and renders them in one
  chronological view, degrading gracefully when either source is missing.
- **Retired `xinas-mcp` unit removed from the TUI.** The startup banner,
  system-status screen, Service Status view, and menu restart actions
  still referenced the standalone `xinas-mcp.service` (removed at install
  time), painting a false red "inactive" and producing spurious restart
  failures. They now reflect the real daemons — `xinas-api` + `xinas-agent`
  — and "Restart NFS Helper" targets only `xinas-nfs-helper` (#247, #249).
- **Wizard "Back" button styled flat to match Cancel.** `#btn-back` fell
  through to Textual's stock bordered button style; it now shares the
  neutral-button selector with `#btn-cancel`/`#btn-no` across
  SelectDialog, ConfirmDialog, and InputDialog.
- **`textual` pinned to `>=8.2.8,<8.3`.** An unpinned `textual>=0.71.0`
  floor let CI and production drift onto 8.2.8, whose `Worker` is no longer
  awaitable — breaking `python-typecheck` and the `_show_control_error`
  call sites. Pinned identically across `pyproject.toml`, the `xinas_menu`
  role, and `install.sh`, and `_show_control_error` dropped `@work` so it
  stays awaitable (#251). Requires the `xinas_menu` role to re-run on
  update.

## [3.2.1] - 2026-07-04

### Fixed

- **Repeated provisioning no longer bricks boot with "Too many boot init
  vars".** The `perf_tuning` role appended its high-performance kernel-arg
  block to `GRUB_CMDLINE_LINUX` on every run — a `\1` backref that
  re-prepended the existing value — so each re-provision added another full
  copy of `intel_idle.max_cstate=0 … mds=off`. The flag-style tokens the
  kernel does not consume (`noibrs`, `noibpb`, `no_stf_barrier`, …) pile into
  the init argument vector; once they cross the kernel's `MAX_INIT_ARGS` (32),
  PID 1 setup panics at boot with `Too many boot init vars` — reported after
  several reinstalls. The task now strips any previously-applied xiNAS args
  before prepending exactly one copy: it is idempotent, preserves foreign
  kernel args, and self-heals a host that already accumulated duplicates (as
  long as it can still boot to re-run). Regression from 3.1.x
  (`$1` → `\1` backref correction). Requires the `perf_tuning` role to
  re-run on update.

## [3.2.0] - 2026-07-03

### Added

- **Install-time NFS exports are seeded into control-path desired
  state.** The installer wrote `/etc/exports` directly but never
  registered those exports in desired state, so the install-time default
  share disappeared from the TUI the moment any share was added through
  the API (the export stayed live but became invisible and
  unmanageable). The `exports` role now renders a seed manifest that
  `xinas-api` adopts into desired state once at first boot, guarded by a
  one-time marker so operator deletes are not resurrected (#244).
- **Observed-read routes now signal a degraded backend instead of
  faking an empty result.** The list routes
  (`GET /api/v1/arrays|disks|filesystems`) attach a
  `DEGRADED_BACKEND_UNAVAILABLE` warning when their backing collector
  (`XiraidArray` / `Disk` / `Filesystem`) is errored, and the RAID and
  Filesystem TUI screens render a degraded banner rather than a
  misleading "(no … configured)" empty state — so a down or stale
  backend is distinguishable from "genuinely none". The result payload
  is unchanged (additive warning; no `api-v1.yaml` change) (#245).
- **State-preserving Back navigation across the day-2 wizards.** The Add
  Share, Edit Share, and Create Array wizards gained a Back button on a
  new headless `run_wizard` driver (`BACK` / `CANCEL` sentinels,
  conditional-step `applies()` predicates); previously entered answers
  are remembered when stepping back, and conditional RAID steps are
  handled correctly (#246).

### Fixed

- **Observed xiRAID arrays were invisible in the API and TUI.** The
  tolerant `parseRaidShow` parser only accepted the fake transport's
  JSON-array `raid_show` payload and rejected the real xiRAID 4.3.x
  daemon shape (an object keyed by array name, with devices expressed as
  `[idx, path, states]` tuples). Configured arrays therefore never
  reached the observed-state store, the Control-Path API, or the Textual
  TUI. The parser now normalizes both shapes and extracts device paths
  from the tuple form, with a regression test for the real
  object-keyed / tuple-device payload (#243).
- **Informational and error pop-ups no longer ask an unanswerable
  Yes/No.** `ConfirmDialog` defaults to Yes/No and only renders a single
  OK button when constructed with `ok_only=True`. Notices, detail views,
  and error dialogs across the day-2 screens (RAID, NFS, filesystem,
  spare pools, drives, network) omitted the kwarg and so prompted the
  operator to answer messages that have nothing to answer (e.g. "No
  available drives found."). Every informational dialog now passes
  `ok_only=True`; genuine consent prompts whose result is branched on
  (Create/Edit confirmations, delete warnings, final confirmations) keep
  Yes/No. The screen-wide convention is recorded in the RAID, FS/shares,
  and network management specs.

### Rebuild required

Updating to this release rebuilds the node agent, its TypeScript bundle,
and the API service so the `parseRaidShow` fix and the degraded-read
warnings take effect:

    Requires-Rebuild: xinas_node_build, xinas_agent, xinas_api

## [3.1.2] - 2026-07-03

### Fixed

- **Default install no longer aborts at array creation.** Installing a
  release via `install.sh` → `autoinstall.sh --preset default` failed on
  every host with `raid_fs/tasks/create_array.yml: 'raid_create_min_free_mb'
  is undefined` (`ansible-playbook` exit 2). `autoinstall.sh` applies a
  preset by copying `presets/<name>/raid_fs.yml` over the `raid_fs` role's
  `defaults/main.yml`, so the `raid_create_min_free_mb` default added in
  3.1.0 was wiped whenever a preset was applied and the memory-floor guard
  then evaluated an undefined variable (#242).
- Both shipped presets (`default`, `xinnorVM`) now carry
  `raid_create_min_free_mb: 2560`, with a comment documenting that role
  defaults must be mirrored into presets that replace them.
- The guard task is now defensive (`raid_create_min_free_mb | default(2560)`)
  so a preset that forgets the tunable can never hard-fail the whole install
  again — it loses the override, not the run.

## [3.1.1] - 2026-07-03

### Changed — GitHub-Releases-only delivery

- xiNAS now checks for updates **only through published GitHub
  Releases**. The update checker queries the GitHub Releases API,
  compares the installed version against the latest published release
  tag using semantic versioning (`v1.2.3` and `1.2.3` compare equal),
  and reports the new version, release notes, and download source.
- The `main` branch is **no longer used as a production update source**.
  The in-TUI updater checks out the latest **release tag** instead of
  running `git pull origin main`.
- **Protection against fallback to branch-based updates** was added:
  draft releases are always ignored, prereleases are ignored unless the
  `prerelease` channel is explicitly enabled, and any failure (API
  unavailable, missing required asset) surfaces a clear error instead of
  degrading to `main`/`master`, a branch archive, or a commit snapshot.
- Install one-liners now fetch the installer from the latest release
  asset
  (`https://github.com/XinnorLab/xiNAS/releases/latest/download/install.sh`),
  and `install.sh` / `prepare_system.sh` / `install_client.sh` resolve
  and check out the latest release tag rather than cloning `main`.
- The client TUI self-updater and the privileged `xinas-update-git`
  helper were converted to release-tag checkout (helper now accepts
  `fetch` / `checkout <vX.Y.Z>` only — no `pull`).
- The **Release and Update Policy** in `CLAUDE.md` was updated, and a new
  contract doc was added at `docs/Installer/update-spec.md`.

### Added

- `tests/test_update_check.py` covering release detection, draft and
  prerelease filtering, semver comparison, the no-`main`-fallback
  behavior, branch-archive avoidance, and the missing-asset error path.
