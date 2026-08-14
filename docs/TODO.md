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
