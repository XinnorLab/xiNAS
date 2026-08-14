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

## Control path — create-surface tuning still models fields the daemon doesn't have

**Deferred 2026-08-14**, when the vendored `message_raid.proto` was re-vendored
from the running xiRAID **4.3.1** daemon on the demo node (its
`message_raid_pb2.py` descriptor read directly). The proto now matches the
daemon field-for-field; the TypeScript layers above it were left as-is.

**What is missing.** `translate.ts` (`toRaidCreateRequest`), `schema.ts`
(`Tuning`), and `docs/control-path/api-v1.yaml` still model three create knobs
that do not line up with the real daemon:

- `drive_trim` — the daemon has **no** field by this name; TRIM-at-create is
  `trim` / `no_trim` (RaidCreate fields 33/34). `translate.ts` emits
  `drive_trim`, which `@grpc/proto-loader` now drops, so the knob is inert.
- `discard` — absent from RaidCreate on 4.3.1 (per-array discard is a
  `xicli raid modify` / CLI concept, not a gRPC create field). Also inert.
- `resync_enabled` — absent from both RaidCreate and RaidModify on 4.3.1.
  Already inert; now also absent from the vendored proto.

**Current behavior.** Setting any of the three on create is silently dropped
at the proto-loader boundary and reports success — the same false-success
failure mode ADR-0006 flags for modify. `max_sectors_kb` and `sdc_prio`, by
contrast, now DO reach the daemon on create (they were being dropped before
the re-vendor because the old proto lacked them on RaidCreate).

**Why deferred, not fixed now.** Dropping `discard` / `drive_trim` from
`api-v1.yaml`'s tuning schema is a **breaking** change that `oasdiff` will fail
in CI, and renaming the create knob to `trim`/`no_trim` is a public-contract
decision, not a mechanical edit. It needs its own reviewed change, and it
interacts with the discard-enablement entry below (both touch how the create
surface expresses TRIM/discard).

**What done looks like.**

1. Decide the create-surface contract: expose `trim`/`no_trim` as the real
   TRIM-at-create knob; drop or repurpose `discard`/`resync_enabled` on create.
2. `translate.ts` emits `trim`/`no_trim` (mapped from whatever the schema
   settles on), and stops emitting `drive_trim`/`discard`/`resync_enabled` on
   create.
3. `api-v1.yaml` + `docs/control-path/` updated (additive where possible to
   keep oasdiff green; a removal needs an explicit breaking-change decision).
4. The "misleading create-side note" corrections in ADR-0006 §Writability and
   `s4-xiraid-array-mutations-spec.md` collapse to "done".

**Also still open, unrelated to this repo change:** the demo node runs 4.3.1,
so whether xiRAID **4.4**'s `RaidModify` gained `discard` (the 4.4 CLI docs say
it is modifiable) has not been checked against a 4.4 daemon. Re-run the same
descriptor read against a 4.4 host when one is available.

TypeScript under `xiNAS-MCP/src/` needs a `Requires-Rebuild: xinas_node_build`
trailer when this lands.

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
