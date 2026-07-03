# Seed install-time NFS shares into desired state

**Date:** 2026-07-03
**Status:** Approved design (pre-implementation)
**Area:** Installer (`docs/Installer/fs-exports-spec.md`) + Control-path bootstrap (`xiNAS-MCP/src/api/bootstrap.ts`, ADR-0016)

## 1. Problem

The installer's Ansible `exports` role renders `/etc/exports` directly from the
preset `exports` variable ([`collection/roles/exports/tasks/main.yml`](../../../collection/roles/exports/tasks/main.yml)).
That export is **never** written into the control-path desired state
(`/xinas/v1/desired/Share/`). `seedInfrastructure()` seeds only the Cluster and
Node singletons ([`bootstrap.ts`](../../../xiNAS-MCP/src/api/bootstrap.ts)).

Because `GET /api/v1/shares` returns desired-state Shares **only**
([`routes/nfs.ts`](../../../xiNAS-MCP/src/api/routes/nfs.ts) line ~112), the
install-time default is absent from the API's view. The TUI's
`_format_exports` falls back to reading `/etc/exports` **only when the API list
is empty** ([`xinas_menu/screens/nfs.py`](../../../xinas_menu/screens/nfs.py)
line ~828: `if data and isinstance(data, list):`).

Symptom chain:

1. Fresh install → `GET /shares` = `[]` → TUI reads `/etc/exports` → default visible.
2. Operator adds a share via the wizard → a desired Share row is created.
3. `GET /shares` = `[<new share>]` (non-empty) → TUI uses API data only, no
   `/etc/exports` fallback → **the install-time default disappears from the list**.

The export itself is untouched — the nfs-helper's `add_export` is a
read-modify-write over the whole `/etc/exports`
([`nfs-helper/nfs_exports.py`](../../../xiNAS-MCP/nfs-helper/nfs_exports.py)
line ~89), so the default line is preserved and clients keep access. The bug is
**visibility + manageability**: the install-time default becomes invisible and
un-editable/un-removable in the TUI the moment any API-managed share exists.

## 2. Decision

Adopt the install-time exports into desired state at install (chosen scope:
**install-time seed only** — out-of-band exports are NOT auto-adopted; they
remain drift). The installer hands the seed to the API via a **manifest file**
that the API consumes at bootstrap (chosen mechanism — the API is the sole
writer of the SQLite state DB per ADR-0002, so Ansible cannot write the row
directly).

## 3. Architecture — two touch points

### 3a. Ansible `exports` role → seed manifest (new, additive task)

A new task in the `exports` role renders a JSON manifest from the **same**
`exports` preset variable that drives `exports.j2`, so `/etc/exports` and the
manifest are consistent by construction.

- **Path:** `/var/lib/xinas/seed/shares.json` (sibling of the state DB dir
  `/var/lib/xinas/state/`).
- **Additive:** this task does **not** modify the existing `/etc/exports`
  template task. No new code path clobbers a helper-managed `/etc/exports`.
- **Shape** (one entry per preset export; `clients`/`options` carried raw so the
  Jinja stays a simple string split and the parsing lives in tested TS):

```json
[
  {
    "path": "/mnt/data",
    "clients": "*",
    "options": ["rw", "sync", "insecure", "no_root_squash",
                "no_subtree_check", "no_wdelay", "fsid=0"]
  }
]
```

- Empty/omitted `exports` var → an empty manifest `[]` (or no file). The API
  seeds nothing.

### 3b. API bootstrap → `seedShares()` (new module, called at bootstrap)

Lives in its own focused module `xiNAS-MCP/src/api/seed-shares.ts` and is called
from `server.ts` immediately **after** `seedInfrastructure(state, config)` —
same bootstrap window, before any listener binds, so plain `put()` with no CAS
is safe (single writer). `bootstrap.ts` stays singleton-only. Reads the manifest
path from API config (default `/var/lib/xinas/seed/shares.json`).

The desired Share row is written in the exact shape the GET routes render and
`providers/nfs.ts` `toDesiredShareDoc` produces:
`{ kind: 'Share', id, spec: { path, clients: [{ pattern, options }], fsid } }`.
The KV `put()` has no key-prefix validation, so the marker key
`/xinas/v1/meta/shares_seeded` (outside `desired/`·`observed/`, like
`/xinas/v1/cluster`) is safe and never leaks into a list route.

Algorithm:

1. If the one-time marker `/xinas/v1/meta/shares_seeded` is present → **return**
   (seeding happens exactly once, ever).
2. Else if the manifest is absent or empty → do nothing and **leave the marker
   unset** (so a boot after the exports role later runs will still seed — this
   handles install ordering where the API starts before the manifest exists).
3. Else, for each manifest entry:
   - Skip if a desired Share already exists for that `path` (belt-and-suspenders
     against duplicates).
   - Build the Share spec: extract `fsid` from the option tokens (top-level;
     required by the api-v1 Share schema `[path, clients, fsid]`), keep the
     remaining tokens as `clients: [{ pattern, options }]`, and assign a
     deterministic id via `encExportId(path)`
     ([`lib/nfs-export-id.ts`](../../../xiNAS-MCP/src/lib/nfs-export-id.ts)).
   - `put()` `/xinas/v1/desired/Share/<id>` as `{ kind: 'Share', id, spec }`
     with source tag `api:bootstrap`. **No executor is run; `/etc/exports` is
     not written** — the export already exists on disk.
   - After the pass, `put()` the marker `/xinas/v1/meta/shares_seeded`
     (`{ seeded_at, source: 'api:bootstrap' }`).

Edge handling:

- `encExportId` throws on a bare-root or `..` path → skip that entry, log, do
  not abort the boot.
- Missing `fsid` token → assign `max(existing fsids) + 1` (fsid 0 stays reserved
  per the mutate route's convention) so the schema requirement is always met.

## 4. Why the one-time marker matters

Without it, an operator who removes the seeded default via the TUI (which
deletes the desired Share **and** removes the `/etc/exports` line) would have it
**resurrected** on the next API restart — the manifest still lists it and no
desired row exists for it, so it would be re-seeded, leaving a ghost desired row
with no matching export (a `drift.nfs-exports` `missing` entry). The marker makes
seeding strictly first-boot-after-install, so deletes are permanent. A fresh
state DB (re-install) has no marker and re-seeds correctly.

## 5. Data flow

```
preset `exports` var
   ├── exports.j2 ─────────────► /etc/exports            (unchanged)
   └── shares.json manifest ───► seedShares() at boot ──► /xinas/v1/desired/Share/<id>
                                                              │
                                        GET /api/v1/shares ◄──┘
                                                              │
                                        TUI "Show NFS Exports" shows the
                                        default alongside any added share;
                                        Edit/Remove now work on it.
```

## 6. Scope boundaries (consistent with "install-time seed only")

- **Out-of-band exports are NOT adopted.** A share added later via raw
  `exportfs` or a hand-edit of `/etc/exports` stays as drift and is surfaced by
  `drift.nfs-exports` (`extra`) in health. The TUI list continues to show
  desired-state only; this design does **not** add an orphan-merge to the list
  (that was the "continuous adoption / display-merge" option that was declined).
  **Residual, documented:** an out-of-band export is still invisible in the TUI
  list, though health flags it.
- **No `Requires-Rebuild: exports` trailer.** Forcing the `exports` role to
  re-run on a plain release update would re-template `/etc/exports` and could
  clobber a helper-managed exports file (a pre-existing behavior of that role's
  wholesale template task). So this feature benefits **fresh installs and full
  re-provisions**; existing installs adopt on their next full provision, not on a
  plain release update. Documented as a limitation.

## 7. Testing

**API (vitest):**
- manifest present, marker unset → desired Shares seeded (correct path, clients,
  extracted fsid) + marker set.
- marker already set → no-op (no writes).
- manifest absent → no-op, marker stays unset.
- existing desired Share for the manifest path → not duplicated.
- delete-then-restart (marker set) → no resurrection.
- unencodable path (`/`) → skipped, boot continues.

**Ansible:**
- the manifest render round-trips the `exports` var (path/clients/options).
- the existing `/etc/exports` template task is unchanged (no new clobber path).

## 8. Spec-first updates (land with the implementation)

- `docs/Installer/fs-exports-spec.md` — document the seed manifest contract and
  the install→desired-state seeding behavior.
- Control-path bootstrap — extend the seed contract (ADR-0016 / `bootstrap.ts`
  currently cover cluster + node singletons) to include the one-time Share seed
  and the `/xinas/v1/meta/shares_seeded` marker.
