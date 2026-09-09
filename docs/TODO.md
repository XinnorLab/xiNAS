# xiNAS — Deferred Work

Work that was consciously scoped out of a change, not work that was
forgotten. Every entry names what is missing, what the current behavior is
instead, and what "done" looks like — enough for someone else to pick it up
without the conversation it came from.

**This is not a bug tracker and not a wishlist.** An entry belongs here when
all three hold:

- it was cut from a specific change, and the change shipped without it;
- leaving it out is defensible on its own (it is not a half-finished feature);
- shipping it later is a real piece of work, not a follow-up commit.

Anything that makes the shipped behavior wrong is a bug — fix it or file it,
don't defer it here. When an entry is done, delete it; the spec it changed is
the record, not this file.

Format: `## <area> — <what is missing>`, newest first, with the date it was
deferred and the change that deferred it.

---

## MCP — S17 incomplete-source observations are logged, not journaled

*Deferred 2026-09-08, from the S15–S18 validation remediation
(`docs/superpowers/plans/2026-09-08-s15-s18-validation-remediation.md`, Task 4).*

**What is missing.** A journaled signal for an observation row that lacks a
field a producer rule needs (a `Filesystem` without
`effective_mount_options`, an `NfsProfile` without `rdma_listening`, an
RDMA link reading `unknown`, an `XiraidArray` whose members carry no
state), the way `raid.source.unknown_state` reports a RAID word outside
the vocabulary.

**What the code does instead.** The producer keeps its last proven state
and logs `event_source_incomplete` (`{ kind, id, missing }`, plus `kept`
where the rule tracks a last-known boolean — the NFS backing and RDMA
rules — and `exportPath` for the export-backing rule) through the engine
log; nothing reaches the feeds, so a client cannot subscribe to it.

**Why it was cut.** A new event family is a closed-taxonomy change (§6.4,
§6.5, `producers` block, contract fixtures) with no consumer yet; the
domain feeds must not carry a non-domain event to fake one.

**What done looks like.** Either a `*.source.incomplete` family per feed
(warning, `details: { kind, id, missing }`, listed under `producers`) or a
counter on the S17 metrics registry once the `RegistryMetrics` adapter
lands, plus the log line removed.

## doca_ofed — DOCA-Host 3.5.0 (and later) is published but not validated on xiNAS hardware

*Deferred 2026-09-07 by the change that pinned `doca_version` to `3.4.0`
(previously the `latest` alias, which NVIDIA re-pointed to 3.5.0 on
2026-08-20 and which apt then refused on every installed host).*

**What is missing.** Nobody has run DOCA-Host 3.5.0 through the xiNAS
stack: the `mlnx-nfsrdma-dkms` build against the shipped kernels, NFS-RDMA
exports, `ibstat` / `mlx5` bring-up, and the client-side role.

**What the code does instead.** Both `doca_ofed` roles (server and
`client_repo`) install from the `3.4.0` directory — the release the lab
hosts already run — and stay there until someone bumps them.

**Why it was cut.** The change was an outage fix; validating a new DOCA
release is hardware time that had nothing to do with restoring installs.

**Done looks like.** 3.5.0 (or whatever is current then) tested on a lab
host end to end, `doca_version` bumped in both roles in one commit carrying
`Requires-Rebuild: doca_ofed`, and the "as of" date in
`docs/Installer/spec.md` §3.2 refreshed.
## MCP Tasks — task notifications (`subscriptions/listen`, `notifications/tasks`) are not served

*Deferred 2026-09-04, from the S16 MCP Tasks extension
(`docs/control-path/s16-mcp-tasks-spec.md` §14, decision D-04).*

**What is missing.** A client cannot subscribe to a task and be pushed
its status changes; it polls `tasks/get`.

**What the code does instead.** Polling is the extension's mandatory
completion mechanism and works on both transports; `pollIntervalMs`
tells the client how often (2 s, 5 s during `mkfs`). The extension is
advertised without notifications because they are optional in it.

**Why it was cut.** S17's `subscriptions/listen` stream carries resource
feed notifications only and deliberately emits no `notifications/tasks`
(ADR-0010, S17 decision 7); task notifications need per-task
authorization on subscribe, resumption after a transport interruption,
and the complete status-specific shape on every frame, under the S16
contract.

**What done looks like.** `subscriptions/listen` with `notifications.taskIds`
authorized per task against `Task.principal`, `notifications/tasks`
carrying exactly the `tasks/get` shape, no unrelated progress/message
frames on the task stream, and a keep-alive; the e2e proves a
reconnecting subscriber sees no gap.

## MCP Tasks — the S16 counters are not registered with Prometheus

*Deferred 2026-09-04, from S16 (`s16-mcp-tasks-spec.md` §13.2).*

**What is missing.** `TasksMetrics` (handles returned by kind, method
calls and protocol errors, terminal states, cancel outcomes, time to
terminal, active projected tasks by status) is an interface with a noop
implementation; nothing exports it.

**What the code does instead.** The audit trail (`mcp.task.*`) records
every lifecycle event; there is no counter.

**Why it was cut.** The registry and `GET /metrics` endpoint are S15
Task 13 and were not on the branch S16 was built on; registering against
a registry that does not exist yet would have forked it.

**What done looks like.** `registryTasksMetrics(registry)` over
`lib/metrics.ts` with bounded labels only (no task id, principal, device,
mountpoint or idempotency key), the active gauge via `gaugeCollect` over
`TaskStore.countByState`, wired in `app.ts` next to the confirmation
metrics.

## MCP — header validation covers only the task methods

*Deferred 2026-09-04, from S16 (`s16-mcp-tasks-spec.md` §5.6, V-08).*

**What is missing.** The `2026-07-28` Streamable HTTP transport requires
`Mcp-Method` on every request and `Mcp-Name` on `tools/call`, and mandates
HTTP 400 + `-32020` when they are missing or disagree with the body. S14
never validated them; S16 validates them for `tasks/get`, `tasks/update`
and `tasks/cancel` only.

**What the code does instead.** `tools/call`, `tools/list` and
`server/discover` accept requests with no headers at all, as they always
have; the stdio adapter now mirrors the headers on every modern message
it forwards, so xiNAS's own clients are conforming.

**Why it was cut.** Extending strictness to `tools/call` changes behavior
for every existing modern client and test in one step; the task methods
are new, so strictness there costs nothing.

**What done looks like.** `validateTaskMethodHeaders` generalized to every
modern method per the transport table, the conformance tests updated,
and a release note that non-conforming HTTP clients must send the
headers.

## Tasks — only `fs.create` declares a point of no return

*Deferred 2026-09-04, from S16 (`s16-mcp-tasks-spec.md` §9.6, ADR-0012 §9).*

**What is missing.** `xiraid-array-executor` checks the cancel flag
mid-flight (ADR-0012 §3) and has no `irreversible_from` declaration;
whether `xicli raid create` has a stage after which a cancel-plus-rollback
is no longer truthful was not investigated.

**What the code does instead.** The generic boundary rule: a cancel is
honored before the next executor stage and the executor's `rollback()`
runs.

**Why it was cut.** S16's mandatory scenario is the filesystem create;
the xiRAID contract needs its own vendor-doc check (CLAUDE.md spec-first
rule 5) before a stage can be declared irreversible.

**What done looks like.** ADR-0006/S3 record, with `xicli` documentation
cited, which stage (if any) is irreversible; the executor declares it;
the runner test covers it.

## MCP Tasks — no rate limiting of fast polling

*Deferred 2026-09-04, from S16 (`s16-mcp-tasks-spec.md` §6.4).*

**What is missing.** A client that ignores `pollIntervalMs` and polls
`tasks/get` in a tight loop is answered every time.

**What the code does instead.** Each poll is one indexed SELECT and one
render; nothing touches the task. The S15 per-principal token bucket
exists only for confirmation requests.

**Why it was cut.** Optional in the extension; no observed need.

**What done looks like.** The S15 bucket generalized to the task methods
with a `-32602`-free, retry-after-carrying protocol error, and a metric
for rejected polls.

## MCP Tasks — Claude Code and Codex are not verified native Tasks clients

*Deferred 2026-09-04, from S16 (`s16-mcp-tasks-spec.md` §12.4).*

**What is missing.** A captured end-to-end run proving that Claude Code
(≥ 2.1.259) or Codex declares the extension, accepts `CreateTaskResult`,
polls the same task, renders `isError`, and resumes rather than
re-applying after a reconnect.

**What the code does instead.** Both use the fallback (`task_id` +
`tasks.wait`); the hand-rolled conformance harness is the automated
stand-in for the wire format.

**Why it was cut.** The installed Codex (0.136.0) predates any documented
Tasks support; Claude Code's binary contains the extension strings but
that proves nothing about behavior. Manual, hardware-adjacent.

**What done looks like.** The runbook §5b "MCP Tasks" step captured for a
named version; S8 §3.2 and this entry updated to name it.

## Installer — the Python TUI has no "Set Root Password" item, but the installer points at one

*Deferred 2026-09-03, noticed while auditing how the installer handles the
root password (it does not touch it at all).*

**What is missing.** Neither `install.sh` nor any Ansible role sets, changes
or unlocks the root password; the installer only writes the
`PermitRootLogin prohibit-password` sshd drop-in (key-only root SSH) and
then reads `passwd -S root`. When the account is locked or has no password —
the Ubuntu default — [install.sh](../install.sh) warns:
`Root has no password set — run xinas-menu → A → 4 to set one`. That target
does not exist. The MCP screen's **SSH Access Settings** item (`4`,
[xinas_menu/screens/mcp.py](../xinas_menu/screens/mcp.py)) offers status,
enable/disable key-login and add-authorized-key only. The one surface that
sets the password is the deprecated bash `post_install_menu.sh`
(**Set Root Password** → interactive `passwd root`), which the shell-scope
rule says must not grow further and which `install.sh` no longer launches.

**What the code does instead.** The operator gets a warning that names a
menu item they cannot find, and the only working path is `passwd root` in a
console session. Nothing is broken on the host: root stays locked for
password login exactly as Ubuntu shipped it, and key-based SSH for the MCP
bridge works regardless.

**Why it was cut.** The hint dates from the bash post-install menu, where
`A → 4` really was **Set Root Password**. When day-2 management moved to the
Python TUI, the SSH screen was ported but the password item was not, and the
installer message was never re-pointed. Setting a root password is a
console-recovery convenience, not part of the install contract, so it was
left out rather than rushed into the TUI.

**What "done" looks like.** Either:

- add a **Set Root Password** item to the TUI's SSH Access Settings screen
  (it runs as root, so `chpasswd` is enough; the Users screen already has the
  pattern), document it in
  [docs/Installer/spec.md](Installer/spec.md) next to the root-SSH step, and
  point the `install.sh` warning at the real key path; or
- keep the TUI as is and change the warning to say `run passwd root from a
  console session`.

Either way the warning must name something that exists.

## Installer — the bash menus' passive update check is not cached

*Deferred 2026-09-03, from the GitHub rate-limit change
([docs/Installer/update-spec.md](Installer/update-spec.md) "GitHub rate
limits and the access token").*

**What is missing.** `check_for_updates` in `lib/menu_lib.sh` (run at every
`startup_menu.sh` / `simple_menu.sh` start) and its twin in
`post_install_menu.sh` call `api.github.com` on every launch. The Python
TUI now keeps a one-hour cache with an `ETag`; the bash menus do not.

**What the code does instead.** The bash calls go through `xinas_gh_curl`,
so a configured token lifts them onto the token's 5,000/h quota — which is
the fix that matters on a shared address. Without a token they still cost
one anonymous request per launch.

**Why it was cut.** `startup_menu.sh` runs once per install and
`post_install_menu.sh` is a deprecated surface; a second cache format in
bash would duplicate the Python one for a launch count that is small in
practice. The token covers the case that actually failed.

**What done looks like.** One cache file both surfaces read — the Python
`ReleaseCache` JSON at `/var/cache/xinas/update-check.json` is the obvious
candidate — with the bash passive check honouring the same one-hour TTL.

## Storage — the Create Array drive picker does not exclude spare-pool drives

*Deferred 2026-08-29, from the array-spare-pool-by-name change
([docs/superpowers/specs/2026-08-29-array-spare-pool-by-name-design.md](superpowers/specs/2026-08-29-array-spare-pool-by-name-design.md) §5).*

**What is missing.** `_list_api_disks_with_banner` in
[xinas_menu/screens/raid.py](../xinas_menu/screens/raid.py) builds its
`claimed` set from the observed arrays' `member_disk_ids` + `spare_disk_ids`
only. It never reads `GET /api/v1/pools`, so a drive held by a spare pool that
no array currently references is offered to the operator as a free drive.

**What the code does instead.** The control path catches it at plan time: the
`disk_in_spare_pool` blocker (`lib/xiraid/validate.ts`
`checkMembersNotPooled`) names the pool holding the drive and tells the
operator to remove it from the pool or pick another. The operator sees the
error at the wizard's confirmation step rather than at the picker.

**Why it was cut.** The change's scope was the array→pool reference itself,
and the blocker makes the failure correct, actionable and impossible to apply.
Threading pool drives into the picker means the create wizard grows a third
API dependency (`GET /api/v1/pools` is already fetched for the spare step, but
later in the flow and with its failure deliberately swallowed), whose failure
mode has to be decided: silently offering pooled drives is what happens today,
and hard-aborting the wizard on a pools read failure is a worse trade.

Note that the design doc's §5 claim — that the pool surface already keeps
pool-held drives out of free-drive pickers — is **inaccurate for this picker**,
and this entry is the correction. That rule lives in
`_get_free_nvme_drives` ([xinas_menu/screens/spare_pools.py](../xinas_menu/screens/spare_pools.py))
and governs the **Spare Pools** picker only. The design doc is append-only, so
it is not edited; this entry is the durable record.

**Why it matters more now.** Before this change a pool was executor-owned and
died with its array. Pools now outlive the arrays that reference them, so an
unreferenced pool left behind by a deleted array holds drives that show as free
in the wizard and then fail at confirmation.

**What done looks like.** `_list_api_disks_with_banner` folds the drives of
every observed pool into `claimed` — the same exclusion `_get_free_nvme_drives`
already computes — so pooled drives never reach the Create Array picker, with a
decided, tested behavior for a failed pools read (degraded banner, not an
abort). The `disk_in_spare_pool` blocker stays as the preflight backstop for
REST/MCP/CLI clients.

## Installer — the design's secondary repair path for a tree dirtied outside the update flow was never built

*Deferred 2026-08-19, from the preset-overlay change
([docs/superpowers/specs/2026-08-18-preset-overlay-design.md](superpowers/specs/2026-08-18-preset-overlay-design.md) §9).*

**What is missing.** The design specifies a second migration path beyond the
marker-based bridge (`xinas_migrate_overlay`): for the six paths preset
application used to write (the four role `defaults/main.yml` files it
copied over, `net_controllers/templates/netplan.yaml.j2`, and
`playbooks/site.yml`), extract the keys that differ from `HEAD`, write only
those keys into `20-local.yml`, then `git checkout --` the path back to
clean. This was meant to recover a tree dirtied by something other than the
update flow itself. No task in the execution plan ever built it, and no code
in `lib/xinas_config.sh` does what that design paragraph describes.

**Current behavior.** `xinas_migrate_overlay` only ever reads the untracked
`/opt/xiNAS/.xinas_applied_preset` marker; it never diffs any of the six
tracked paths against `HEAD`. A tracked file left dirty by something other
than the pre-migration `apply_preset` / `save_preset` is not specifically
reconciled by any migration code — it is only ever cleaned up as a side
effect of the next `git checkout --force` during an update, which discards
it rather than extracting its keys first.

**Why it was cut.** After the preset-overlay change, nothing in the product
writes those six tracked paths at runtime any more — `configure_raid.sh`,
`configure_network.sh`, `configure_nfs_exports.sh`, `configure_hostname.sh`,
`apply_preset`, and `save_preset` all write the untracked overlay
exclusively ([Installer/spec.md §1.0](Installer/spec.md#10-the-configuration-layer-model)).
So a dirty tree on one of those six paths can now only be **legacy state**
left over from before this change, on a host that has not yet gone through
the marker-based migration. The next update's `git checkout --force` cleans
that legacy dirt unconditionally, and the marker bridge already restores the
preset that produced it — provided the pre-migration host applied that
preset through a code path that wrote the marker, which before the
`apply_preset` consolidation in this same change was only the
`startup_menu.sh` copy (a preset applied from the old `simple_menu.sh` copy
left no marker). The secondary path would additionally recover an operator's
config-editor edits layered on top of that legacy dirt, which the marker
cannot name — a narrower case, and building the per-key `git diff`-against-
`HEAD` extraction correctly (per-key, not per-file, to avoid recreating the
frozen-snapshot problem the whole change exists to remove) is real,
non-trivial work of its own.

**What done looks like.** For each of the six paths, if it is dirty relative
to `git show HEAD:<path>`, diff the two YAML documents key by key, write the
differing keys — and only those — into `20-local.yml`, then
`git checkout -- <path>`. No blanket `git checkout .`: the path list stays
fixed at the six names, and any local modification outside that list is
reported to the operator, not silently discarded. A test proves the
extraction returns only the changed keys, not a whole-file copy.

## Installer — `tests/test_no_runtime_writes_to_tracked.py` cannot see a write reached through a variable

*Deferred 2026-08-19, from Task 11 of the preset-overlay change
(`configure_hostname.sh` writes the overlay, not role defaults, commit
`f376ed6`).*

**What is missing.** The contract test is a textual regex over each listed
script's source (`SCRIPTS` in the test file), not a behavioral check. It
flags a direct, literal write to a tracked path (`collection/roles/**` or
`playbooks/site.yml`) spelled out inline in a `cp`/`mv`/`cat >`/`yq -i`/
redirect command. It cannot see a write that reaches the same tracked path
indirectly through a shell variable: `vars_file=".../defaults/main.yml"`
followed by `mv "$tmp" "$vars_file"` two lines later reads, to the regex,
like a write to `$vars_file`, which matches nothing in the pattern.

**Current behavior.** Both bugs this test exists to prevent a regression of
were exactly this indirect shape historically — `configure_hostname.sh`
(fixed in the same change that added it to `SCRIPTS`, commit `f376ed6`) and
`configure_raid.sh` (fixed earlier in the same plan) both wrote a tracked
role default through a `$vars_file`-style variable. Neither would have been
caught by this test even if it had listed the script at the time: adding
`configure_hostname.sh` to `SCRIPTS` now only prevents a *future* direct
literal write in that file; it does not, and structurally cannot, prove the
original bug would have been caught.

**Why it was cut.** This is a deliberate design tradeoff, not an oversight —
[docs/superpowers/specs/2026-08-18-preset-overlay-design.md](superpowers/specs/2026-08-18-preset-overlay-design.md)
§11 states the property worth pinning, "nothing writes there," is "cheap to
state textually and expensive to state behaviourally," and chose the grep
knowingly. A real fix needs either shell data-flow tracing (resolving a
variable to its assigned literal before matching) or running each script
behaviorally against a scratch repo checkout and diffing the tracked tree
before and after — both materially larger than the regex this test is.

**What done looks like.** At minimum, extend the regex to trace a
single-hop `var=<literal>` assignment to a tracked path and then match a
write through `$var` — this would have caught both historical bugs without
full data-flow analysis. The more thorough option is to actually run every
script in `SCRIPTS` against a scratch checkout and assert the tracked tree
is byte-identical before and after, generalizing the harness
`tests/test_preset_overlay.py` already uses to prove the individual
`configure_*.sh` read-modify-write contracts.

## Installer — `net_detect_infiniband` / `net_detect_mlx5` are dead

*Deferred 2026-08-19, from the preset-overlay change
([docs/superpowers/specs/2026-08-18-preset-overlay-design.md](superpowers/specs/2026-08-18-preset-overlay-design.md) §2 Non-goals).*

**What is missing.** `collection/roles/net_controllers/defaults/main.yml`
declares both `net_detect_infiniband` and `net_detect_mlx5` (both default
`true`), but no task anywhere in the role reads either key.

**Current behavior.** Both keys are inert. Before the preset-overlay change,
`configure_network.sh` wrote a fixed set of pool keys that omitted both, and
applying either preset copied a `network.yml` that also omits them over the
role defaults — deleting them from the effective configuration on every
apply. Nothing broke, because nothing reads them either way.
`configure_network.sh` no longer writes role defaults at all (it writes the
`20-local.yml` overlay instead), so that particular deletion path is gone,
but the two keys remain unreferenced by any task.

**Why it was cut.** Deciding whether interface detection should honour these
two flags, or whether they should be removed entirely, is a role-behavior
question outside the preset-overlay change's scope — recorded as a Non-goal
in the design doc. Until decided,
`tests/test_preset_key_ownership.py::test_every_preset_key_is_defined_by_some_role`
is the only guard that exists: it stops a preset from setting either key
without some role defining it, so a preset author cannot silently ship a
key that looks load-bearing but is not wired to anything.

**What done looks like.** Either wire both into the role's interface
detection step (`collection/roles/net_controllers/tasks/`), or remove them
from `defaults/main.yml`. Whichever direction is chosen, update
[Installer/spec.md §3.3](Installer/spec.md#33-net_controllers--network-discovery--netplan)
to match.

## Config history — the risk class is hidden in the TUI, not fixed

*Deferred 2026-08-15, from the "every row is destroying_data" report.*

**What is missing.** `rollback_class` is still classified and still stored on
every manifest, but the TUI no longer renders it anywhere: the Configuration
History list column, the snapshot detail metadata row, the diff preview, the
full diff, and the restore confirmation dialog.

**Current behavior.** The operator sees no risk indication at all. That is a
deliberate downgrade from a field that read `destroying_data` on every row
including `cpu_allowed=0-63` — an all-red column carries no signal and trains
people to click past the confirmation it exists to gate. Nothing branches on
the class in the TUI today, so no safety gate was removed with the display.

**Why it was cut.** Two independent fail-safes fire on ordinary operations,
and both need a fix wider than a render change:

1. `SnapshotEngine.create_snapshot` calls `classify_operation(op_enum)` with
   no `details`, so `_classify_raid_modify(None)` returns `DESTROYING_DATA`
   ("no details — assume worst case"). The `parameter_change` detail key that
   would yield `non_disruptive` is never passed — `app.snapshots.record()`
   has no parameter for it, so the whole call chain from the screens needs
   the extra argument.
2. The control path records its own `operation_kind` verbatim
   (`xiraid.array.modify`, from
   [xiraid-array-executor.ts](../xiNAS-MCP/src/agent/task/xiraid-array-executor.ts)),
   which is not an `OperationType` value, so `OperationType(operation)` raises
   and the engine stamps the unknown-operation fail-safe.

Both fail-safes are correct in isolation (specs.md §4.7) — the bug is that
they are the common path, not the exception.

**What done looks like.**

1. `OperationType` accepts (or the engine maps) the control-path
   `xiraid.array.*` / `share.*` / `network.*` operation kinds, so a recorded
   operation classifies instead of failing safe.
2. `record()` and `create_snapshot` take `details`, and the RAID/FS screens
   pass `parameter_change` for live tuning edits.
3. A test asserts a `cpu_allowed`-only modify classifies `non_disruptive`.
4. The TUI renders the class again and `docs/config-history/specs.md` §10
   and `architecture.md` drop their suppression notes.

Also worth folding in: one TUI edit currently writes two snapshots a second
apart (`raid_modify` from the screen, `xiraid.array.modify` from the
executor).

## Storage — `discard_ignore` / `discard_verify` are not observed

*Deferred 2026-08-15, from the discard-observation fix.*

**What is missing.** `raid_show --extended` reports four discard knobs. The
parser reads two of them — `discard_allowed` → `spec.tuning.discard` and
`discard_active` → `status.discard_active` — and ignores `discard_ignore`
("all discard requests are ignored") and `discard_verify` ("the system tracks
discarded blocks and verifies they contain zeroes").

**Current behavior.** Both read `0` on the reference node, so the TRIM /
Discard block is complete for the configurations xiNAS creates. An array whose
discards were disabled out-of-band with `xicli raid modify --discard_ignore 1`
would still render `Discard (TRIM) | Enabled` with no hint that every request
is being dropped.

**Why it was cut.** Unlike `discard_active`, these two are *modifiable*
(`xicli raid modify`), so putting them on `spec.tuning` implies a write path.
The vendored `RaidModify` descriptor (4.3.1) carries no field for either, and
protobuf drops an unknown field silently — a PATCH would report success while
the daemon never saw it, exactly the failure `CREATE_ONLY_TUNING` exists to
prevent. Observing them safely means extending that rejection list in the same
change, which is wider than the render bug being fixed.

**What done looks like.**

1. `lib/parse/raid.ts` reads both into `spec.tuning`.
2. `CREATE_ONLY_TUNING` in [routes/arrays.ts](../xiNAS-MCP/src/api/routes/arrays.ts)
   grows both, so a PATCH is rejected with `UNSUPPORTED` rather than silently
   dropped — or the descriptor is re-verified against 4.4 and they become a
   real modify surface.
3. `api-v1.yaml` gains both fields (additive) and the Extended block renders
   them, with `discard_ignore = true` overriding the `Enabled` reading.

TypeScript under `xiNAS-MCP/src/` needs a `Requires-Rebuild: xinas_node_build`
trailer.

## Storage — day-2 array creation does not enable discard

*Deferred 2026-08-14, from the TRIM-support change.*

**What is missing.** The Create Array wizard in the TUI sends no `tuning` at
all ([raid.py](../xinas_menu/screens/raid.py) — the wizard assembles
`name` / `level` / `member_disk_ids` / `strip_size_kib` and, conditionally,
`group_size` and `spare_disk_ids`). `discard` is therefore omitted and xiRAID
applies its own default of `0`.

**Current behavior.** The installer now enables `--discard 1` per array when
every member supports discard and RZAT
([raid-spec §7.5](Installer/raid-spec.md#75-array-creation)). An array created
from the TUI on the same hardware does not get it, so two arrays on one node
can differ in discard behavior depending on which surface created them.

**Why it was cut.** The installer decides from a host-side probe the control
path cannot currently reproduce: `ObservedDisk.status`
([disk.ts](../xiNAS-MCP/src/lib/parse/disk.ts)) carries no discard and no RZAT
field, so the wizard has nothing to decide from. Closing the gap properly is a
four-layer change, not a wizard tweak.

**What done looks like.**

1. The agent's disk probe reads `/sys/block/<dev>/queue/discard_max_bytes` and
   the NVMe namespace `DLFEAT` (low three bits == 1 means deallocated blocks
   read back as zeroes), and surfaces both on `Disk`.
2. `docs/control-path/api-v1.yaml` gains the fields (additive, so oasdiff
   stays green) and `docs/control-path/` records them.
3. The Create Array wizard enables `discard` when every selected member
   qualifies, and says so on the confirmation step — matching the installer's
   rule rather than asking the operator to know it.
4. `docs/Storage/raid-management-spec.md` §4 documents the behavior, and the
   asymmetry note added to §3 is removed.

TypeScript under `xiNAS-MCP/src/` needs a `Requires-Rebuild: xinas_node_build`
trailer. `drive_trim` stays untouched here for the same reason as in the
installer: xiRAID enables it itself only when no disk carries metadata, and
forcing it overrides that safety check.

## Storage — hung NFS mount can still stall the share-list render

*Deferred 2026-08-14, from the WS5.2 TUI thread-safety fix
(`fix/ws5-tui-thread-safety`).*

**What is missing.** A bound on the blocking syscalls in
[`nfs.py`](../xinas_menu/screens/nfs.py) `_format_exports` that `df`'s
`timeout=5` does not cover: `os.path.isdir(path)` (`nfs.py:1063`), which runs
immediately before and gates the `df` call, and the `ss -tn state established
( dport = :2049 )` fallback in the connected-hosts block (`nfs.py:1107`).
Neither has a timeout.

**Current behavior.** `stat(2)` on a hard-mounted, unresponsive NFS export
blocks in uninterruptible sleep (`D` state) with no timeout available at the
syscall level, so on the spec's own headline example (dead NFS server) `isdir`
hangs before the `df` timeout ever gets a chance to fire; `ss` can hang the
same way against a wedged network stack. WS5.2 moved the whole render off the
event loop (`_load_exports` awaits `_format_exports` via `asyncio.to_thread`),
so the TUI no longer freezes — but the render for that refresh still stalls
indefinitely, and because `_load_exports` is `@work(exclusive=True)`, each
subsequent refresh cancels the *worker* while the `to_thread` call underneath
keeps running on a thread borrowed from the event loop's shared default
executor. It cannot be cancelled or reclaimed, so repeated refreshes against a
hung export strand one thread per refresh in that shared pool.

**Why it was cut.** WS5.2's scope was the event-loop-blocking defect (a hung
call freezing the whole TUI), which `to_thread` fixes. Bounding `isdir`/`ss`
themselves is a different problem — there is no interruptible timeout for a
blocked `stat(2)`, so "done" means a probe-in-a-thread design (a dedicated,
bounded worker pool with a hard wall-clock join timeout, treating a probe that
doesn't return in time as failed and leaking that one thread deliberately
instead of the default executor), not a parameter tweak on the existing call.

**What done looks like.**

1. `isdir` (and the `ss` fallback) run through a small dedicated thread pool
   sized to survive N stranded probes, not the event loop's shared default
   executor, so a hung mount can't starve unrelated `to_thread` work.
2. Each probe is joined with a wall-clock timeout; a probe that doesn't
   return in time renders the same way `df`'s timeout does today (`N/A` /
   status badge unaffected) rather than blocking the refresh.
3. `docs/Storage/fs-shares-management-spec.md` §4.2 is updated to state the
   bound covers `isdir` and `ss` too, and the caveat added in this change is
   removed.

## Storage — `xicli raid modify` knobs the surfaces do not offer

*Deferred 2026-08-16, from the xiRAID 4.4 RAID-surface audit.*

The [CR / `xicli raid`](https://xinnor.io/docs/xiRAID-4.4.0/E/en/CR/raid.html)
`raid modify` table documents seven writable parameters that reach neither the
TUI's Edit Array list nor any other client-facing surface, even though
`translate.ts` already emits every one of them into `RaidModifyRequest` and
`Tuning` already types them: `restripe_prio`, `sdc_prio`, `request_limit`,
`memory_prealloc`, `merge_read_wait`, `merge_write_wait`, `adaptive_merge`.
The Extended Details view *renders* all seven, so an operator can see values
they cannot change.

**What the code does instead.** Nothing rejects them — a REST/MCP client that
PATCHes `spec.tuning.sdc_prio` today is validated, translated and applied
correctly. The gap is only that `_MODIFY_PARAMS` in
[xinas_menu/screens/raid.py](../xinas_menu/screens/raid.py) does not list them.

**Why it was cut.** The audit's scope was correctness of what ships — labels
that advertise wrong ranges, bounds looser than the engine's. Adding
parameters is a feature, and three of the seven (`merge_*_wait`,
`adaptive_merge`) are only meaningful when their `merge_*_enabled` sibling is
on, so a useful Edit Array entry for them wants conditional presentation
rather than another flat row.

**What done looks like.**

1. `_MODIFY_PARAMS` carries the seven, each with a `MODIFY_RANGES` entry so
   its label states the range it enforces (raid-management-spec §5.3).
2. `raid_rules.MODIFY_RANGES` gains `restripe_prio` `0-100`, `sdc_prio`
   `1-100`, `request_limit` `0-4294967295`, `memory_prealloc` `0` or
   `1024-65536`, `merge_*_wait` `1-100000` — the same numbers `checkTuning()`
   already enforces control-path-side.
3. `docs/Storage/raid-management-spec.md` §5 lists them.

## Storage — level-conditioned tuning is not validated

*Deferred 2026-08-16, from the xiRAID 4.4 RAID-surface audit.*

Several `xicli raid create` parameters are documented "Except RAIDs 0, 1, 10"
(`--adaptive_merge`, `--merge_read_enabled`, `--merge_write_enabled`, the four
`--merge_*` timings) or "cannot be set for RAIDs 0, 1, 10" (`--sdc_prio`);
`--sparepool` is "not for RAID 0"; `--init_prio` / `--recon_prio` are "Except
RAID 0". `validateCreateSpec()` checks every one of those ranges but not the
level they are legal for, so a `POST /api/v1/arrays` for a `raid10` carrying
`tuning.merge_read_enabled` plans clean and fails at `raid_create`.

**What the code does instead.** The TUI's Create wizard sends **no** `tuning`
at all, so the gap is unreachable from the menu; it is reachable from REST,
MCP and `xinasctl`.

**Why it was cut.** It needs a per-level writability matrix in
`LEVEL_CONSTRAINTS` and a matching blocker code, and the vendor wording is
per-parameter prose rather than a table — transcribing it is a change of its
own, with the same "validate against the vendor page, not the flag name" care
the drive minimums needed.

**What done looks like.**

1. `LEVEL_CONSTRAINTS` in [lib/xiraid/schema.ts](../xiNAS-MCP/src/lib/xiraid/schema.ts)
   carries the set of tuning keys each level rejects, transcribed from CR 4.4
   with the wording quoted.
2. `checkTuning()` takes the level and pushes a `param_not_for_level` blocker.
3. `s3-xiraid-array-spec.md` §Validation lists the new blocker code.

## Storage — `discard` is create-only against a 4.3.1 descriptor, on a 4.4 node

*Deferred 2026-08-16, from the xiRAID 4.4 RAID-surface audit.*

`CREATE_ONLY_TUNING` in [routes/arrays.ts](../xiNAS-MCP/src/api/routes/arrays.ts)
rejects `spec.tuning.discard` on a PATCH because the vendored `RaidModify`
descriptor — taken from a **4.3.1** daemon — has no field for it. CR 4.4
documents `xicli raid modify -dc/--discard` as a supported parameter (noting it
"Requires RAID unload/restore to apply"), so on a 4.4 node the rejection may
now be wrong.

**What the code does instead.** PATCHes carrying `discard` are rejected
pre-plan with `UNSUPPORTED` / `reason: 'create_only_tuning'`, and
`translate.ts` omits the field as a second line of defence. The Extended view
renders `discard` read-only.

**Why it was cut.** Resolving it requires the descriptor from a running 4.4
daemon, which is a host-side artifact, not something the repo can answer. The
failure mode of guessing wrong is asymmetric and bad: if 4.4's `RaidModify`
still lacks the field, removing the rejection makes protobuf drop it silently
and the task report `success` for a change the daemon never saw. Keeping the
rejection costs an operator one `xicli` invocation; removing it prematurely
costs them a lie.

**What done looks like.**

1. The `RaidModify` descriptor is re-vendored from a 4.4 host into
   `proto/xraid/gRPC/protobuf/message_raid.proto`.
2. If it carries `discard` (and `discard_verify` / `drive_write_through`),
   they leave `CREATE_ONLY_TUNING`, `translate.ts` emits them, and Edit Array
   gains the knob with its "requires unload/restore" caveat in the dialog.
3. If it does not, `s4-xiraid-array-mutations-spec.md` records that 4.4 was
   checked and the CLI/gRPC split is real, so the next reader does not re-open
   the question.

## Tasks — progress carries no live stage output

**What is missing.** `TaskProgress` (s2 §10.1) reports the current stage and
elapsed time, but not the line that stage last printed. During the longest
part of a filesystem create — `mkfs.xfs` on a fresh array — a client sees
`stage_name: "mkfs"` and a growing `stage_elapsed_s`, and nothing else.

**What the code does instead.** `ctx.emitOutput()` appends to an in-memory
array in the agent's runner, and `drainOutput()` folds it into the
`stage_succeeded` / `stage_failed` event — so the durable row of a *running*
stage carries no output at all. The rollup reports no output line rather than
a stale one; finished stages' output stays readable in `stages[]`.

**Why it was cut.** Publishing output mid-stage is not a presentation change:
it needs a ninth value in the §6 event taxonomy (`stage_output`), a drain
policy in the runner (interval or line count, so a chatty stage cannot flood
the api), and an append-plus-spill rule on the api side, where today a stage
row's output is written once. The 2026-08-16 MCP progress design deliberately
kept its scope to presenting facts the system already records.

**What done looks like.** `stage_output` joins the taxonomy and the
`TaskProgressEvent` schema; the runner drains on an interval while a stage
runs; the api appends to the stage row and applies the existing 64 KiB spill
rule to the accumulated text; `TaskProgress` gains `last_output_line`.

## Tasks — `xinasctl --wait` does not use the long-poll or the rollup

**What is missing.** `plan_apply_wait` in the CLI polls `GET /tasks/{id}` on
its own loop and renders stage events by hand. It predates
`GET /tasks/{id}/wait` (s2 §10.2) and does not show the `progress` rollup, so
the CLI's view of a long apply is coarser than the MCP client's.

**What the code does instead.** The existing poll loop, unchanged. It works;
it is just a second implementation of waiting.

**Why it was cut.** The 2026-08-16 change was scoped to the MCP surface plus
the shared renderer both surfaces read. Migrating the CLI is mechanical but
touches its own output formatting and tests.

**What done looks like.** `plan_apply_wait` calls `/tasks/{id}/wait` with
`since_revision` threading, and renders `progress.stage_name`,
`stage_position` / `stage_total`, and `elapsed_s`.

## Tasks — progress reports no completion percentage

**What is missing.** `TaskProgress` has no `percent`. A client can say "stage
2 of 5, 41 s in" but not "62 % done".

**What the code does instead.** Stage position and elapsed time only.

**Why it was cut.** For the operation that motivated the feature there is
nothing honest to report: `mkfs.xfs` emits no completion percentage, so any
number would be invented. Other executors are different — xiRAID
initialization exposes `init_progress`, which the array probe already parses
into `rebuild_progress_pct`.

**What done looks like.** An executor that can compute a percentage honestly
reports it on its stage events, `TaskProgress` gains an optional `percent`
(additive to the contract), and it stays absent everywhere the underlying
tool does not supply one — never interpolated from elapsed time.

## e2e — `xinasctl.test.ts` relies on the default 5 s per-test timeout

**What is missing.** Four of the e2e files run assertions that each spawn a
`node dist/cli/xinasctl.js` subprocess, and `xinasctl.test.ts` leaves most of
its `it()` blocks on vitest's default 5000 ms `testTimeout`. Under heavy CPU
oversubscription that budget covers process spawn plus the round trip only
just: measured at ~1.9 s per CLI read at 3× oversubscription, and two tests
("reads over UDS peer trust", "viewer token reads but cannot plan") time out
at ~26× (load average 262 on 10 cores).

**What the code does instead.** The default timeout, unchanged. The suite is
green idle and at the ~3× load that reproduces the agent-readiness race the
2026-09-02 change fixed; only a deliberately extreme load breaks it.

**Why it was cut.** It is a different defect family from the fixed-sleep
races. Those had a real condition to poll for and the sleep was standing in
for it; this one has no condition to wait on — the work genuinely takes
longer than the budget — so the only fixes are raising the per-test timeout
or not spawning a subprocess per assertion. Raising a timeout to paper over
load is exactly the move the fixed-sleep work was undoing, and doing it
opportunistically here would muddy that change.

**What done looks like.** Either the CLI e2e tests carry an explicit timeout
justified by measured spawn cost (as `apply + --wait` already does), or the
file drives the CLI through one long-lived process instead of one per
assertion. Decide deliberately rather than bumping 5000 to a bigger guess.

## MCP — S17 Phase 2 event producers are not shipped

*Spec: [docs/control-path/s17-mcp-subscriptions-spec.md](control-path/s17-mcp-subscriptions-spec.md) §18; requirement §22–§25.*

**What is missing.** Restripe / SDC-scan / pending-maintenance events
(`raid.maintenance.*`, `raid.consistency.inconsistent`, the `restripe` and
`sdc_scan` operation kinds), NFSv4 grace/reclaim events, nfsd counter-rate
events, inode/quota events, sustained SLO events, HA/path events, and the
`nfs.configuration.drift_*` pair the requirement leaves as MAY.

**What the code does instead.** The xiRAID observation already retains
`raw_states` and the four separate progress values, so the Phase 2 xiRAID
producers need no wire or parser change; the other families need new
sources (`/proc/net/rpc/nfsd`, quota, performance collectors). Nothing is
emitted for them; feed reads do not list them under `producers` because the
families do not exist yet.

**Why it was cut.** Phase 1 covers what current observations can prove
(requirement §2.2). **Done** = each producer lands with a validated
fixture for the supported Ubuntu kernel/nfsd, additively on the same six
feeds, cursors and envelope.

## MCP — S17 source-gated event families have no producer

*Spec: S17 spec §8.2, §8.4; decision D-16 in the requirement's Appendix E.*

**What is missing.** `raid.device.error_count_increased`,
`raid.device.fault_threshold_reached`, `raid.device.critical_wear`,
`raid.license.expired`, `raid.license.drive_limit_exceeded`,
`raid.spare.replacement.failed`, `storage.disk.health_degraded` /
`health_recovered` / `wear_critical` / `temperature_high` /
`temperature_cleared`.

**What the code does instead.** The types, severities and envelope schemas
exist; every feed read lists the family under `producers.inactive` with the
reason (`no periodic error-count or wear source`, `no periodic license
source`, `no validated temperature threshold`). xiNAS observes `raid_show`
and `pool_show` periodically and the license only on demand
(`health.probe`); `Disk.status.health` is in the OpenAPI schema but no probe
fills it.

**Why it was cut.** Emitting them from a guess would violate requirement
D-06 (never fabricate). **Done** = a periodic collector for each source (a
license observation; per-bdev error counters and wear from xiRAID or NVMe
SMART; a validated platform temperature threshold) plus the producer and
its transition table.

## MCP — S17 product-client smoke results are pending

*Spec: S17 spec §16; requirement SUBS-CLIENT-002.*

**What is missing.** The recorded live smoke-test rows for Claude Code and
Codex (client version, transport, whether `subscriptions/listen` was
issued, whether `notifications/resources/updated` was observed and
surfaced, reconnect behavior, configuration).

**What the code does instead.** The official v2 client interop tests are
the automated proof; the runbook section defines the protocol; release
notes must state the limitation and point at the `resources/read` polling
fallback until the rows are filled.

**Why it was cut.** They can only be produced on a node with the product
clients installed. **Done** = both rows filled in
`docs/control-path/hardware-smoke-runbook.md`.

## MCP — the modern path does not validate `MCP-Protocol-Version`

*Spec: S14 (`s14-mcp-modern-era-spec.md`); S17 validation V-18 / D-25.*

**What is missing.** The Streamable HTTP transport spec (2026-07-28)
requires every POST to carry `MCP-Protocol-Version` matching
`_meta["io.modelcontextprotocol/protocolVersion"]` and the server to reject
a mismatch.

**What the code does instead.** `api/mcp/modern.ts` classifies the era from
`_meta` only; the header is ignored. The v2 client sends both, consistently.

**Why it was cut.** Pre-existing S14 gap found while validating S17; not a
subscription concern. **Done** = header/body mismatch → HTTP 400 with the
schema's error, tests on both transports.

## MCP — the S17 `RegistryMetrics` adapter is still pending

*Spec: S17 spec §12; decision D-17.*

**What is missing.** The S17 `xinas_mcp_*` / `xinas_operational_event_*`
instruments are not registered on the metrics registry, so
`GET /api/v1/metrics` does not render them.

**What the code does instead.** `SubscriptionMetrics` has an in-memory
implementation that tests assert against; nothing renders it.

**Why it was cut.** The registry itself has LANDED — `lib/metrics.ts` and
`GET /api/v1/metrics` shipped with S15 Task 13, and the S15 confirmation
series render there today. Only the S17 side is outstanding. **Done** = a
`RegistryMetrics` adapter registering the S17 names on that registry
(`Gauge.inc` is available for the `subscriptionsActive(±1)` mapping).

## MCP — the S18 RAID Create view does not consume the S17 feeds

*Spec: [docs/control-path/s18-mcp-raid-create-app-spec.md](control-path/s18-mcp-raid-create-app-spec.md) §8; S17 spec §16.*

**What is missing.** Live progress inside the view for the array-create task
it just applied — the `xinas://events/raid/progress` feed carries exactly
that.

**What the code does instead.** The view follows the `tasks.wait` next hint
through the host, as every non-App client does.

**Why it was cut.** MCP Apps hosts (specification 2026-01-26) relay tool
calls and their results to a view; none relays a `subscriptions/listen`
stream, so a view has no channel on which `notifications/resources/updated`
could arrive. Building a polling loop over `resources/read` inside the view
would duplicate what the host already does with the hint.

**What done looks like.** A host that relays subscription notifications to
views (or an MCP Apps revision that gives a view its own listen), after which
the view reads `raid/progress` after its cursor and drops the hint loop.

## MCP — the TUI "pending approvals" screen is deferred

*Deferred 2026-09-04, from the S15 MCP confirmation change
(`docs/control-path/s15-mcp-mrtr-confirmation-spec.md` §9.5, decision D-09).*

**What is missing.** A Management screen in `xinas_menu` listing pending
MCP confirmations (`GET /api/v1/mcp/confirmations?status=pending`) with
approve / decline actions, the plan summary, and the typed acknowledgement
phrase for destructive records.

**What the code does instead.** Operators approve on the web page
(`/mcp/approvals/{id}`), over REST, or with `xinasctl mcp_confirmations
approve <id> --acknowledge "…"` over the UDS; all three hit the same routes
and approver policy.

**Why it was cut.** Three channels already cover approval; the TUI screen is
additive UI and would have doubled the review surface of a security change.

**What done looks like.** `xinas_menu/screens/mcp_approvals.py` driven by
`control_client.py`, showing exactly the fields the web page shows (S15
§9.3), refusing to approve without the phrase, and a pytest against the
stub server for approve / decline / policy refusal rendering.

## Health — `sections_without_checker` uses a static section list until S19c

*Deferred 2026-09-09, from S19b (`feat/s19b-prompt-context-catalog`);
spec `s19-mcp-health-prompt-spec.md` §8.2, §8.5.*

**What is missing.** `health.context.baselines[].sections_without_checker`
should come from the Python engine itself (`python3 -m xinas_menu.health
--sections`, S19c), so a section the engine gains or loses is reported
without a TypeScript change.

**What the code does instead.** `api/health/profiles.ts` compares each
profile's enabled sections against `KNOWN_ENGINE_SECTIONS`, a copy of the
engine's `section_map` keys taken on 2026-09-09 (`kerberos` is the one
enabled section without a checker today).

**Why it was cut.** The `--sections` flag is S19c work (AC-06, G-03); the
static list makes the G-03 gap visible now instead of hiding it until
then.

**What done looks like.** The agent's `health.baseline` handler runs
`--sections` once at startup and the api reads the live list through it;
`KNOWN_ENGINE_SECTIONS` is deleted and `tests/test_health_engine_sections.py`
pins the flag's output.

## Health — `health.context` fields without an observed source

*Deferred 2026-09-09, from S19b; spec §6.2.*

**What is missing.** `node.xiraid_version` (always `null`) and the
`topology.interfaces[].rdma_capable` / `rdma_link_state` fields the spec
sketched.

**What the code does instead.** `xiraid_version` is `null`; interfaces
carry `operstate` and `mtu` from the `NetworkInterface` collector. RDMA
link state is only observed by the standard profile's `network.rdma-live`
check, which the prompt reads through `health.check`.

**Why it was cut.** No collector observes the xiRAID version or RDMA link
state as KV rows; `health.context` never calls the agent (§6.1), so it
cannot ask for them live.

**What done looks like.** An inventory or network collector row carries
them; `buildHealthContext` reads them; the spec's §6.2 sketch and the
`HealthContext` schema in `api-v1.yaml` gain the fields.

## MCP — `mcp.health_prompt` follow-ups deferred by the S19 spec (§12.3, §17)

*Deferred 2026-09-09, from S19b.*

- TUI toggles for `mcp.health_prompt.enabled` and `probe_policy_max` on
  the MCP Server screen (S8 §6c); today they are `config.json` edits.
- `prompts` `listChanged` notifications and template hot reload; the
  template override is read once at startup.
- MRTR elicitation of missing prompt arguments and `completion/complete`
  for the `baseline_profile` / `targets` arguments.
- Server-side two-sample trend rows for HC-03 / HC-09 (v1 relies on the
  client taking the second sample) and a server-side report history.

Each lands as its own spec amendment; none changes the §13 gate matrix.
