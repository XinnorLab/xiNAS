# Health check — `raid_status`

**Section:** Storage · **Profiles:** `quick`, `standard`, `deep` ·
**Source:** [xinas_menu/health/engine.py](../../xinas_menu/health/engine.py)
(`check_storage`, `raid_state_verdict`), mirrored in the standalone
[healthcheck.sh](../../healthcheck.sh).

Reads `xicli raid show -f json` and reports one result for the whole array set.

## Verdict

Every word of every array is mapped to a **category**, and the worst category
present decides both the status and the explanation. `actual` names the
offending `array: state` pairs, so the operator sees which array and which word
produced the verdict.

Categories, worst first (`_RAID_CATEGORY_REPORT` in `engine.py` is this table):

| Category | Status | `impact` |
|---|---|---|
| `lost` | `FAIL` | "Degraded RAID reduces redundancy and may reduce performance" |
| `unreadable` | `WARN` | "The array's state could not be read, so its redundancy cannot be certified" |
| `unrecognised` | `WARN` | "This state is not in xiNAS's table for xiRAID 4.4, so nothing can be inferred about the array's redundancy" |
| `stalled` | `WARN` | "Restriping stopped before it finished; the array is serving I/O on an incomplete layout" |
| `initializing` | `WARN` | "Initialization is still computing parity, so the array is usable but not yet fully redundant" |
| `background` | `WARN` | "A background operation is running; the array is redundant but may be slower until it completes" |
| *(none present)* | `PASS` | — |

Each carries its own `fix_hint` as well. **The categories do not share an
explanation, and that is the point.** One line saying "the array is redundant
but may be slower" was attached to every `WARN`, which is true of an SDC scan
and false of three other cases: an initializing array is not yet redundant (AG
says the RAID reaches "a fully operational 'initialized' state" only once
initialization concludes, so until then parity is still being computed), a
stopped restripe has no operation running at all, and nothing whatsoever can be
inferred from a word this table does not know.

`SKIP` is separate from the category ladder — it means the check ran and has no
evidence, rather than a verdict about the arrays:

| `SKIP` when | `actual` |
|---|---|
| `xicli` is absent | `N/A` |
| `xicli raid show` failed | `N/A` |
| the payload did not parse | `parse error` |
| no arrays are configured | `no arrays` |
| **no array reported a readable state** | the `array: state not reported` list |

### Unreadable state fields fail closed

`state` should be a list of words. It is not always: it can be absent, `null`,
an empty list, a bare string, or a list carrying non-strings. `raid_state_words()`
normalizes all of those and reports whether anything usable came back.

Iterating the raw field let the payload's *shape* decide the verdict instead of
its content, in three different ways:

- a missing or empty `state` produced `PASS — 1 array(s) online` for an array
  nothing at all was known about;
- `state: null` raised an uncaught `TypeError` out of the whole health run;
- `state: "online"` iterated into six single characters, each unrecognised, so
  one healthy array produced six `WARN` entries.

A bare string is now read as one word, and anything unusable becomes the
`unreadable` category. An array whose state cannot be read is never certified
healthy, and a readable failure on a *sibling* array still outranks it — an
unreadable `a` alongside a degraded `b` reports `FAIL`, not `WARN`.

## The state table

The vocabulary is the vendor's, from
[AG / Showing RAID State](https://xinnor.io/docs/xiRAID-4.4.0/E/en/AG/1/showing_raid_state.html)
for xiRAID Classic 4.4 — the version the `xiraid_classic` role installs.
Re-check it when that version moves.

| Category | States |
|---|---|
| `healthy` | `online`, `initialized`, `need_resize` |
| `background` | `restriping`, `sdc_scanning` |
| `initializing` | `initing` |
| `stalled` | `need_restripe` |
| `lost` | `degraded`, `reconstructing`, `need_recon`, `need_init`, `inconsistent`, `read_only`, `offline`, `none`, `unrecovered` |

**An unrecognised word is `WARN`, not `PASS` and not `FAIL`.** A future xiRAID
release may add states. Passing one silently would hide a real problem;
failing on one would cry wolf on every engine upgrade, and a health check that
cries wolf gets ignored, which costs more than the state it was reporting.

## Why the split exists

The check used to `FAIL` every word that was not `online` or `initialized`.
That is wrong for four of xiRAID's own states, and wrong in the direction that
does the most damage to a health check's credibility:

- **`initing`** is where every array sits for hours after it is created. A
  node reported `FAIL — data: initing` with the impact line "Degraded RAID
  reduces redundancy" the moment the installer finished, on hardware that was
  behaving perfectly.
- **`sdc_scanning`** is a scheduled integrity scan.
- **`restriping`** is an operator-requested expansion in progress.
- **`need_restripe`** is that expansion stopped part-way.

None of the four is a fault, so none may carry the redundancy-loss impact line.
They are still worth surfacing — an array that has been initializing for a week
is a problem — which is what `WARN` is for. But they are not the *same* thing,
which is why each has its own text: only `sdc_scanning` and `restriping` leave
the array fully redundant, `initing` has not established redundancy yet, and
`need_restripe` describes an operation that is not running at all.

The complement holds too, and matters more: `need_init`, `inconsistent`,
`read_only`, `none` and `unrecovered` are genuine failures that the old
`not in ("online", "initialized")` test happened to catch only because it
caught everything. Enumerating them is what lets the transient states be
softened without softening those.

## Relationship to the other two surfaces

The same 4.4 vocabulary drives the control-path parser
([s3-xiraid-array-spec §5.3](../control-path/s3-xiraid-array-spec.md#53-state--statusstate),
which maps daemon words onto `status.state`) and the login banner's RAID
section ([Installer/spec.md §3.13](../Installer/spec.md#313-motd--login-banner)).

**What is shared is the vocabulary, not the severity.** All three read the same
`state` field and none of them invents words — that part is kept in step
deliberately, and it is what the earlier `rebuilding` / `active` banner
vocabulary got wrong. The mapping from a word to a severity is **not** shared,
because the three answer different questions:

| Word | Control path `status.state` | This check | Banner |
|---|---|---|---|
| `reconstructing` | `rebuilding` (TUI: yellow `~`) | `FAIL` | red |
| `sdc_scanning` (with `online`) | `optimal` (TUI: green `*`) | `WARN` | yellow |
| `need_restripe` (with `online`) | `optimal` (TUI: green `*`) | `WARN` | yellow |
| `initing` | `rebuilding` (TUI: yellow `~`) | `WARN` | yellow |

That divergence is intended. `status.state` is a published **object state** —
what the array *is* — so an array rebuilding after a member failure is
`rebuilding`, and an online array running a scan is `optimal`, both accurately.
This check and the banner publish an **operator verdict** — whether someone
should look. An array reconstructing has lost redundancy until it finishes, so
it earns a `FAIL` here even though `rebuilding` is the correct state name; a
scan is worth a yellow even though the array is optimal.

Do not "fix" one surface to match another by analogy. If they are ever aligned,
it should be because the *questions* were reconciled, not because the tables
looked different. What must never happen is the reverse of the intended skew:
the banner or this check reporting **healthier** than `status.state` — a green
banner over an array the control path calls `failed` is a lie in the direction
that costs data.

## Tests

[tests/test_health_raid_status.py](../../tests/test_health_raid_status.py) —
one case per state, plus the invariants: the worst word in the list wins, an
unknown word is not silently healthy, no payload shape produces `PASS` without
a readable state, a readable failure outranks an unreadable sibling, and each
`WARN` category's `impact` says only what is true of it (`initing` must not
claim the array is redundant; `need_restripe` must not claim something is
running).

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
