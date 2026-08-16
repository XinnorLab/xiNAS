# Health check — `raid_status`

**Section:** Storage · **Profiles:** `quick`, `standard`, `deep` ·
**Source:** [xinas_menu/health/engine.py](../../xinas_menu/health/engine.py)
(`check_storage`, `raid_state_verdict`), mirrored in the standalone
[healthcheck.sh](../../healthcheck.sh).

Reads `xicli raid show -f json` and reports one result for the whole array set.

## Verdict

`state` is a **list** of words per array, and the check walks every word of
every array. The worst verdict any word earns is the verdict of the check.

| Result | When | `impact` |
|---|---|---|
| `SKIP` | `xicli` absent, the command failed, the payload did not parse, or no arrays are configured | — |
| `PASS` | every word of every array is a healthy word | — |
| `WARN` | no word loses redundancy, but at least one is in-progress or unrecognised | "A background operation is running; the array is redundant but may be slower until it completes" |
| `FAIL` | any word means the array has lost redundancy or is unavailable | "Degraded RAID reduces redundancy and may reduce performance" |

`actual` names the offending `array: state` pairs, so the operator sees which
array and which word produced the verdict.

## The state table

The vocabulary is the vendor's, from
[AG / Showing RAID State](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html)
for xiRAID Classic 4.4 — the version the `xiraid_classic` role installs.
Re-check it when that version moves.

| Verdict | States |
|---|---|
| healthy | `online`, `initialized`, `need_resize` |
| in progress | `initing`, `restriping`, `sdc_scanning`, `need_restripe` |
| lost redundancy | `degraded`, `reconstructing`, `need_recon`, `need_init`, `inconsistent`, `read_only`, `offline`, `none`, `unrecovered` |

**An unrecognised word is `WARN`, not `PASS` and not `FAIL`.** A future xiRAID
release may add states. Passing one silently would hide a real problem;
failing on one would cry wolf on every engine upgrade, and a health check that
cries wolf gets ignored, which costs more than the state it was reporting.

## Why the three-way split exists

The check used to `FAIL` every word that was not `online` or `initialized`.
That is wrong for four of xiRAID's own states, and wrong in the direction that
does the most damage to a health check's credibility:

- **`initing`** is where every array sits for hours after it is created. A
  node reported `FAIL — data: initing` with the impact line "Degraded RAID
  reduces redundancy" the moment the installer finished, on hardware that was
  behaving perfectly.
- **`sdc_scanning`** is a scheduled integrity scan.
- **`restriping`** is an operator-requested expansion in progress.
- **`need_restripe`** is that expansion stopped part-way; the array still has
  its redundancy.

None of the four costs redundancy, so none of them may carry the
redundancy-loss impact line. They are real and worth surfacing — an array that
has been initializing for a week is a problem — which is what `WARN` is for.

The complement holds too, and matters more: `need_init`, `inconsistent`,
`read_only`, `none` and `unrecovered` are genuine failures that the old
`not in ("online", "initialized")` test happened to catch only because it
caught everything. Enumerating them is what lets the transient states be
softened without softening those.

## Kept in step with

The same 4.4 vocabulary drives the control-path parser
([s3-xiraid-array-spec §5.3](../control-path/s3-xiraid-array-spec.md#53-state--statusstate),
which maps daemon words onto `status.state`) and the login banner's RAID
section ([Installer/spec.md §3.13](../Installer/spec.md#313-motd--login-banner)).
The three read the same field for different audiences and must not disagree
about which states are failures — a banner that paints an array green while
this check fails it is worse than either alone.

## Tests

[tests/test_health_raid_status.py](../../tests/test_health_raid_status.py) —
one case per state, plus the "worst word in the list wins" and
"unknown word is not silently healthy" invariants.

## Related

- `raid_devices` — the per-member sibling of this check, same command, one
  result per array. It reads each `devices` entry through `raid_member()`,
  which handles all three shapes xiRAID reports members in
  ([s3-xiraid-array-spec §5.2](../control-path/s3-xiraid-array-spec.md#52-devices--statusmember_states)).
  It previously indexed `dev[2][0]` unconditionally: against the bare-path
  shape that yields the third *character* of the path, so every member read as
  "not online", and against the object shape it raised out of the check
  entirely. A member the daemon reports no state for is not a failed member.
- [Storage/raid-management-spec.md](../Storage/raid-management-spec.md) — the
  TUI surface that renders the same states with icons and colour.
