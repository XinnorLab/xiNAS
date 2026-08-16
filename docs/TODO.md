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
