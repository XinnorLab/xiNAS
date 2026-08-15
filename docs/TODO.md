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
