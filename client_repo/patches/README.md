# xiNAS client patches

Source-level fixes applied at client install time to third-party kernel
modules and tooling. Each patch ships with an idempotent applier script;
callers (installer, TUI) invoke the applier unconditionally and let it
decide whether the fix is needed.

## Active patches

| Patch | Target | Trigger | Memo |
|---|---|---|---|
| `mlnx-nfsrdma-nvfs-export-gpl.patch` | `mlnx-nfsrdma-dkms` (until upstream fix) | content-based: applier runs on every install; auto-skips when bug pattern absent | [troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md](../../docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md) |

## Adding new patches

Every entry in this directory follows the same shape so the installer
can call the applier blindly and trust the exit code. The applier owns
all detection logic — it greps the source tree (or queries the package,
or checks a sysfs node) to decide whether the bug pattern is still
present, returns exit 0 for both "applied" and "no-op, not needed", and
returns non-zero only for real errors (missing prerequisite, build
failure). Callers never need preflight branches like
`if version == X then patch`. To add a new patch: drop the unified-diff
`.patch` file (kept for documentation and upstream submission) plus a
matching `apply-*.sh` applier into this directory, add a row to the
table above, and link to a troubleshooting memo under
`docs/troubleshooting/` that documents the symptom, root cause, and
affected versions.
