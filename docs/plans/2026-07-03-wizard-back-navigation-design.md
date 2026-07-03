# Wizard Back navigation — design

**Date:** 2026-07-03
**Status:** Approved (brainstorming), pending implementation plan
**Area specs updated by this work:**
[docs/Storage/fs-shares-management-spec.md](../Storage/fs-shares-management-spec.md) §4.3/§4.4 + Edit,
[docs/Storage/raid-management-spec.md](../Storage/raid-management-spec.md) §4.

## Problem

The day-2 management wizards in the Textual TUI are strictly forward-only.
Each step is a blocking `await self.app.push_screen_wait(dialog)` that returns
a value or `None` (cancel = abort the whole wizard). A user who mis-answers an
early step — e.g. picks the wrong access mode on "Add Share — Step 3/7" — has
no way back; they must cancel and restart from step 1. The user asked for a
**Back button**.

Three wizards are in scope:

| Wizard | Driver | Steps |
|---|---|---|
| Add Share | `NFSScreen._add_share_wizard` + shared `_access_wizard` | 7 (path → 5 access → confirm) |
| Edit Share | `NFSScreen._edit_share` + shared `_access_wizard` | 6 (5 access → confirm) |
| Create Array | `RAIDScreen._create_array_wizard` (self-contained) | 5–7 (name, level, drives, strip, *group size for RAID 50/60*, *spare pool if pools exist*, confirm) |

The shared `_access_wizard` (the 5 middle access-control steps) is used by both
NFS wizards, so covering it covers Add and Edit for one effort. The RAID wizard
is a separate driver with extra complexity: a custom `DrivePickerScreen` modal,
two conditional steps, and inline validation re-prompt loops.

## Goals

- A **Back** button on every wizard step except the first, in all three wizards.
- Back returns to the **previous applicable step** with the user's earlier
  answer **remembered** (pre-selected / pre-filled). Advancing again keeps later
  answers unless the user changes something.
- Cancel (Esc) semantics unchanged — still aborts the whole wizard.
- No regression to the forward path, validation, sub-branches, or dispatch.

## Non-goals

- No Ansible / role behavior change ⇒ **no `Requires-Rebuild:` trailer**
  (Python-TUI-only change).
- No change to `TaskWaitDialog`, the post-confirm API dispatch, audit, or
  snapshot recording.
- No new Textual pilot test harness — the repo tests TUI logic through headless
  helpers, and this design keeps to that convention.

## Approach

A **generic wizard driver** plus a small set of dialog changes. Rejected
alternatives: (2) per-wizard hand-rolled index loops — duplicates back/cancel/
retain logic three times and forces the shared `_access_wizard` to leak its
internal index so Back can cross into the path step; (3) Back only *within* each
sub-section — can't return to step 1, i.e. half the feature.

### New module: `xinas_menu/widgets/wizard.py`

```python
class _Sentinel:
    def __init__(self, name): self._name = name
    def __repr__(self): return self._name

BACK = _Sentinel("BACK")      # step wants the previous step
CANCEL = _Sentinel("CANCEL")  # step wants to abort the wizard

@dataclass
class WizardStep:
    key: str
    run: Callable[[dict, bool, int], Awaitable[Any]]  # (answers, allow_back, step_no)
    applies: Callable[[dict], bool] = lambda a: True

async def run_wizard(steps, initial=None) -> dict | None:
    answers = dict(initial or {})
    idx = 0
    while idx < len(steps):
        step = steps[idx]
        if not step.applies(answers):
            idx += 1
            continue
        allow_back = _has_prior_applicable(steps, idx, answers)
        step_no = _display_number(steps, idx, answers)
        result = await step.run(answers, allow_back, step_no)
        if result is CANCEL:
            return None
        if result is BACK:
            idx = _prev_applicable(steps, idx, answers)  # stays put at idx 0
            continue
        answers[step.key] = result
        idx += 1
    return answers
```

- **Advance:** store `answers[key]`, move to the next index; the loop skips
  inapplicable steps.
- **Back:** jump to the previous *applicable* step (skips e.g. group-size when
  the level isn't 50/60, in both directions).
- **Cancel:** return `None` (unchanged abort semantics).
- **`allow_back`** is false on the first applicable step ⇒ that dialog renders
  no Back button.
- **`step_no`** is the driver-computed 1-based number among applicable steps,
  fed into the dialog title so numbering stays correct across conditional steps.

`run_wizard`, `_prev_applicable`, `_display_number`, and
`_has_prior_applicable` are **pure/headless** — unit-tested with fake steps, no
Textual app required.

### Dialog changes

Add `allow_back: bool = False` to `SelectDialog`, `InputDialog`,
`ConfirmDialog`, and `DrivePickerScreen`. When true:

- Render a **Back** button in the button row.
- Dismiss with the `BACK` sentinel when Back is pressed.
- `SelectDialog` and `ConfirmDialog` also bind `left` → Back (arrow-left is
  unused by the vertical `OptionList` and by yes/no confirms). `Esc` stays
  Cancel everywhere.
- `InputDialog` and `DrivePickerScreen` keep the button as the primary
  affordance (their keyboards are busy with typing / multi-select); the button
  is reachable via Tab-focus.

Return-type widening: the three shared dialogs become
`ModalScreen[str | _Sentinel | None]` / `ModalScreen[bool | _Sentinel]`. The
`BACK` sentinel is a distinct object, so it never collides with a real string,
bool, or `None`.

**State pre-fill:**
- `SelectDialog` gains `selected: str | None` — pre-highlights / scrolls to the
  remembered option.
- `InputDialog.default` and `DrivePickerScreen.preselected` already exist and
  carry the remembered value.

### Wizard rewrites

**NFS (`nfs.py`).** Extract the 5 shared access steps into
`_access_steps(prefix, current=None) -> list[WizardStep]` (closures that pre-fill
from `answers`/`current`). Then:

- `_add_share_wizard`: `steps = [path_step] + _access_steps("Add Share") + [confirm_step]`, then `run_wizard(steps)`.
- `_edit_share`: `steps = _access_steps("Edit Share", current) + [confirm_step]`, then `run_wizard(steps, initial=current)`.

Cross-boundary Back (access-step-1 → path) now falls out naturally — it is one
flat step list, no nested loop to unwind.

**RAID (`raid.py`).** `_create_array_wizard` becomes:

```
steps = [name, level, drives, strip, group_size, spare_pool, confirm]
group_size.applies  = lambda a: a["level"] in {"50", "60"}
spare_pool.applies  = lambda a: bool(available_pools)   # captured from the pools query
```

Titles switch from the current hardcoded/fuzzy strings ("Create Array — Step 5",
"Create Array — Spare Pool") to driver-computed `Create Array — Step {step_no}`,
so a RAID-5 array (no group-size step) numbers 1..N contiguously.

**Sub-branches and validation loops stay inside their step closure:**
- *Path step* (Add Share): `SelectDialog(mounts + ["Custom path…"])`; if custom,
  an `InputDialog`. Back from the custom input returns to the mount select; Back
  from the mount select (when `allow_back`) returns `BACK` to the driver. On
  re-entry, if the stored path matches a mount it's pre-selected, else "Custom
  path…" is pre-selected and the input pre-filled with the stored path.
- *Host step* (access wizard): `SelectDialog(Everyone / Specific network /
  Single host)`; the latter two show a follow-up `InputDialog` for the CIDR/IP.
  Same internal Back handling and best-effort pre-fill from the stored host
  (`*` → Everyone; CIDR → Specific network; bare IP → Single host).
- *Drives step* (RAID): group `SelectDialog` → `DrivePickerScreen`. Back from
  the picker returns to the group select; Back from the group select returns
  `BACK` to the driver. Remembered drive list flows back via `preselected=`.
- *Validation loops* (name, group size): the `while True:` re-prompt stays
  inside the closure; invalid input re-prompts, Back/Cancel exit the loop by
  returning the sentinel.

Confirm step gains `allow_back=True` so the user can revise before create.

### State retention semantics

`run_wizard` holds all answers in one dict across back/forward. Changing an
early answer does **not** auto-invalidate later answers — they keep their prior
values and are shown pre-filled when revisited. This is safe because every step's
option set is static (fixed choice lists, or free-form text the user re-confirms);
the only dynamic inputs (path mount list, drive list, pool list) are queried once
at wizard start and reused.

## Testing (headless, matching repo convention)

TDD the driver and pure helpers — no Textual pilot:

- `run_wizard` forward accumulation returns the full answers dict.
- Back retention: answer step 3, Back to step 2, forward again → step 3's stored
  answer is still present.
- Back on the first applicable step is impossible (`allow_back` false) — and if a
  step returns `BACK` at index 0 anyway, the driver stays put (no underflow).
- Cancel at any step returns `None`.
- Conditional skip: with `level` not in {50,60}, forward skips group-size and
  Back from spare-pool lands on strip; toggling `level` to 50 makes it applicable.
- `_display_number` numbers only applicable steps contiguously.
- Pure pre-fill/parse helpers (path→mount-vs-custom, host→radio+input) tested
  directly.

The dialog `allow_back` rendering + `BACK`-on-press is thin Textual glue over the
above and is left to the same "thin glue, untested" treatment the repo already
applies to screen workers.

## Files touched

- **New:** `xinas_menu/widgets/wizard.py`, `tests/test_wizard_driver.py`.
- **Edit:** `xinas_menu/widgets/select_dialog.py`, `input_dialog.py`,
  `confirm_dialog.py`, `xinas_menu/widgets/drive_picker.py`,
  `xinas_menu/screens/nfs.py`, `xinas_menu/screens/raid.py`.
- **Specs:** `docs/Storage/fs-shares-management-spec.md`,
  `docs/Storage/raid-management-spec.md` (+ short shared "wizard navigation
  model" note describing `BACK`/`CANCEL` and the driver).
