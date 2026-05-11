# GDS Verification, mlnx-nfsrdma Patch, and Healthcheck Integration

**Date:** 2026-05-11
**Components:** `install_client.sh`, `client_repo/client_setup.sh`, `client_repo/client_healthcheck.sh`, new `client_repo/patches/`, new `docs/troubleshooting/`
**Status:** Design approved

## Problem

A long debug session against `ars-511gd` (NVIDIA GB300, aarch64, kernel
6.17, DOCA-Host 26.01) uncovered three related issues:

1. **Packaging bug in `mlnx-nfsrdma-dkms 26.01.OFED.26.01.1.0.0.1`.** The
   two NFS-RDMA→GDS hook functions `rpcrdma_register_nvfs_dma_ops` and
   `rpcrdma_unregister_nvfs_dma_ops` are exported via plain
   `EXPORT_SYMBOL`. Modern kernels' `__symbol_get()` resolves only
   `EXPORT_SYMBOL_GPL` exports, so `nvidia_fs` cannot register, dmesg
   repeats `failing symbol_get of non-GPLONLY symbol …`, and
   `gdscheck -p` reports `NFS : Unsupported`. A live two-character source
   patch + DKMS rebuild flipped the verdict to `NFS : nvfs`, after which
   `gdsio -x 0` against the NFS-RDMA mount delivered 25 GiB/s read,
   7 GiB/s write — confirmed real GPU-direct path (`XferType: GPUD`).

2. **The Client Setup menu's `verify_gds` lied.** Its summary said "All
   critical checks PASSED" while `gdscheck -p` (shown inline) printed
   `Platform verification error : Invalid argument`. The boolean rolled
   up only checks 1-3 (module/libs/proc); it never inspected gdscheck for
   negative markers. The top-line `GDS [OK]` menu indicator at line 3777
   was equally misleading — it toggled purely on `nvidia-fs` module
   presence.

3. **`cufile.json` schema invisible to verification.** During the session
   the script wrote `fs.nfs.mount_table` in three wrong shapes
   (`array<object>`, `array<string>`, `object{ip:path}`) before
   converging on NVIDIA's canonical `object{path: {rdma_dev_addr_list:
   [...]}}`. None of the wrong shapes was caught by `verify_gds`; only
   `gdscheck`'s parser noticed, with a message that didn't make the
   schema problem obvious.

## Goal

Three deliverables, one branch:

- **Auto-apply the mlnx-nfsrdma fix** in both client installers
  (`install_client.sh` one-shot and Setup menu's
  `enable_nfs_rdma`) so any host that pulls a buggy
  `mlnx-nfsrdma-dkms` build gets the GPL-export patch transparently.
- **Make `verify_gds` truth-telling** — parse `gdscheck`'s actual
  verdict, validate `cufile.json` schema, check that NFS mounts are
  `proto=rdma`, surface failures in a CRITICAL ERRORS panel above the
  detailed checks, and propagate the result to the menu's
  `GDS [OK]/[WARN]/[FAIL]` indicator.
- **Extend the healthcheck** with four new check keys covering the same
  signals, plus an opt-in `gdsio_smoke` benchmark (5 s × 4 threads ×
  1 GiB) for the AI/checkpoint profiles. Single shared parser; no
  truth-table duplication between menu and healthcheck.
- **Memo** the mlnx-nfsrdma bug at
  `docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md` as a
  jump-to-fix reference and as the writeup we hand to Mellanox upstream.

## Non-goals

- Auto-rewriting `cufile.json`. The existing **Configure cuFile** menu
  flow already does this; `verify_gds` only validates the result.
- Filing the upstream bug. The memo prepares the case; the decision to
  file is the user's.
- Detecting / scoring `Userspace RDMA : Unsupported` in `gdscheck`. Per
  user decision: noisy and not meaningful on this stack — ignored.
- Auto-unmounting NFS during installer to swap rpcrdma in-place. Patched
  module lands on disk; next reboot picks it up. Auto-unmount is a
  foot-gun with data in flight.
- Server-side validation. This design is client-side only.

## Design

### File inventory

| Path | Change |
|---|---|
| `docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md` | **NEW** — memo |
| `client_repo/patches/README.md` | **NEW** — patch index |
| `client_repo/patches/mlnx-nfsrdma-nvfs-export-gpl.patch` | **NEW** — unified diff |
| `client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh` | **NEW** — idempotent applier (detect → patch → DKMS rebuild → optional reload) |
| `install_client.sh` | Call applier inside `enable_nfs_rdma_oneshot()` after `apt-get install mlnx-nfsrdma-dkms` |
| `client_repo/client_setup.sh` | Call applier from `enable_nfs_rdma()`; rewrite `verify_gds()`; 3-state `gds_menu` indicator; add shared parser `_gds_parse_state()` writing `/tmp/.xinas-gds-state.json` |
| `client_repo/client_healthcheck.sh` | New check keys in `check_gds()`: `gdscheck_nfs_state`, `cufile_mount_table_schema`, `nfs_mount_proto`, `gdsio_smoke`. Reads `/tmp/.xinas-gds-state.json` produced by the bash parser. |
| `client_repo/client_health_profiles/*.yml` | Wire new check keys into `gds.checks`; `gdsio_smoke` opt-in for AI/checkpoint profiles |

### Shared parser — `_gds_parse_state()`

Pure-bash function in `client_setup.sh`. Single source of truth for the
GDS verdict; both the menu's `verify_gds` and the healthcheck's
`check_gds` (via Python) consume its JSON output.

```json
{
  "overall":      "OK" | "WARN" | "FAIL",
  "nfs_state":    "nvfs,compat" | "nvfs" | "unsupported" | "unknown",
  "compat":       "enabled" | "disabled",
  "mount_table":  "valid" | "invalid" | "absent",
  "mounts":       [ { "path": "/mnt/nas", "proto": "rdma" }, ... ],
  "errors":       [ "...", ... ],
  "warns":        [ "...", ... ],
  "ts":           "<iso8601>"
}
```

Inputs (read-only): `gdscheck -p`, `/etc/cufile.json`, `mount -t nfs,nfs4`.
Output: `/tmp/.xinas-gds-state.json` (atomic write).

**Truth table:**

| Signal | PASS | WARN | FAIL |
|---|---|---|---|
| `gdscheck` `NFS :` line | `nvfs, compat` | `nvfs` (no compat) | `Unsupported`, `compat`-only, or missing |
| `cufile.json` `fs.nfs.mount_table` | object; every value has `rdma_dev_addr_list: []` | object but at least one value missing the inner array | not an object, malformed JSON, or absent |
| Any NFS mount with GDS configured | `proto=rdma` | — | `proto=tcp` or no `proto=` |
| `gdscheck` cuFile init | no "Platform verification error" / "Invalid argument" | — | error present |
| `gdscheck` `Userspace RDMA :` line | **ignored** | **ignored** | **ignored** |

Rollup: `FAIL` wins over `WARN` wins over `OK`.

**Caching:** key = `mtime(/etc/cufile.json)` + `mtime(/proc/driver/nvidia-fs/version)` + `cat /sys/module/rpcrdma/srcversion` (concatenated, hashed). When any change, the cache is invalidated and `gdscheck` re-runs. Cost in normal navigation: zero (cache hit); after config changes: one `gdscheck -p` (~1 s).

### Patch + applier (deliverable 1)

**The patch — `mlnx-nfsrdma-nvfs-export-gpl.patch`**

Unified diff against `/usr/src/mlnx-nfsrdma-*/nvfs_rpc_rdma.c`:

```diff
-EXPORT_SYMBOL(REGISTER_FUNC);
+EXPORT_SYMBOL_GPL(REGISTER_FUNC);
...
-EXPORT_SYMBOL(UNREGISTER_FUNC);
+EXPORT_SYMBOL_GPL(UNREGISTER_FUNC);
```

Long header documents: symptom, dmesg signature, root cause one-liner,
affected version, link to the memo. File's own SPDX header is
`GPL-2.0 OR Linux-OpenIB` — `EXPORT_SYMBOL_GPL` is licence-compatible.

**The applier — `apply-mlnx-nfsrdma-export-gpl.sh`**

```
1. Prerequisite gate
   ─ dpkg -l mlnx-nfsrdma-dkms not installed → exit 0 (nothing to do)
   ─ command -v dkms missing             → exit 1
2. SRC=$(ls -d /usr/src/mlnx-nfsrdma-*/ | tail -1)
3. Bug-pattern detect
   ─ grep -qE '^EXPORT_SYMBOL\((UN)?REGISTER_FUNC\)' "$SRC/nvfs_rpc_rdma.c"
   ─ no match → exit 0 (upstream-fixed or already patched)
4. Backup + sed (idempotent on the bug pattern)
   ─ Verify both lines now read EXPORT_SYMBOL_GPL
   ─ Verify failure → restore from backup, exit 1
5. DKMS rebuild
   ─ dkms remove  mlnx-nfsrdma/<ver> --all
   ─ dkms install mlnx-nfsrdma/<ver> -k $(uname -r)
   ─ On build failure → restore backup, dkms install original, exit 1
6. Module reload — BEST EFFORT, NEVER DESTRUCTIVE
   ─ if cat /sys/module/rpcrdma/refcnt == 0:
       modprobe -r rpcrdma && modprobe rpcrdma
       log "Patched rpcrdma live; gdscheck should now show NFS:nvfs"
   ─ else:
       log "WARN: rpcrdma is in use — reboot to activate the GDS-NFS fix"
       (Patched module is already on disk; next boot picks it up.)
7. exit 0
```

Returns 0 for "applied" *and* "no-op-not-needed". Auto-unmount is never
attempted.

**Call sites:**

- `install_client.sh:enable_nfs_rdma_oneshot()` — runs the applier
  between `apt-get install mlnx-nfsrdma-dkms` and `dkms autoinstall`.
- `client_repo/client_setup.sh:enable_nfs_rdma()` — same call inside
  the existing `op_run` chain so installer output stays uniform.

### Menu rewrite — `verify_gds` + `gds_menu` indicator (deliverable 2)

**`verify_gds()` output layout:**

```
═════════════════════════════════════════════════════════════
                  GDS Verification Results
═════════════════════════════════════════════════════════════

  Overall: ✗ FAIL    (2 errors, 1 warning)

┌─ CRITICAL ERRORS ─────────────────────────────────────────┐  (suppressed
│  ✗ gdscheck reports NFS : Unsupported                     │   when no
│      → Likely cause: mlnx-nfsrdma not built with GPL fix. │   FAIL rows)
│      → Fix: client_repo/patches/apply-mlnx-nfsrdma-…sh    │
│             then reboot.                                  │
│  ✗ /mnt/nas mounted with proto=tcp                        │
│      → GDS requires NFS-RDMA. Remount with proto=rdma.    │
└───────────────────────────────────────────────────────────┘

┌─ WARNINGS ────────────────────────────────────────────────┐  (suppressed
│  ⚠ cuFile compat mode disabled                            │   when no
│      → Recommended: properties.allow_compat_mode = true   │   WARN rows)
└───────────────────────────────────────────────────────────┘

▶ Check 1: nvidia-fs Kernel Module          ✓ PASS
▶ Check 2: GDS Libraries                    ✓ PASS
▶ Check 3: nvidia-fs Proc Interface         ✓ PASS
▶ Check 4: cuFile Configuration             ✓ PASS  (schema)
                                            ⚠ WARN  (compat disabled)
▶ Check 5: gdscheck Platform Verification   ✗ FAIL  (NFS: Unsupported)
▶ Check 6: NFS Mount Protocol               ✗ FAIL  (/mnt/nas proto=tcp)
▶ Check 7: GPU/NIC Topology (info)          ✓ ...

─── Full gdscheck -p output ──────────────────────────────────
  GDS release version: 1.16.1.26
  ...
═════════════════════════════════════════════════════════════
```

Key differences from today:

- **Overall** at the top derived from `_gds_parse_state` JSON, not from a
  hand-rolled boolean.
- **CRITICAL ERRORS / WARNINGS** panels above the detailed checks so
  failures are visible without scrolling past 30 lines of gdscheck noise.
- **Check 5** actually parses gdscheck (PASS/WARN/FAIL); raw output still
  appears further down for context.
- **New Check 6** (NFS Mount Protocol) flags TCP-mounted NFS when GDS is
  configured.
- **Check 4** splits PASS/WARN — schema validity and compat-enablement
  are distinct findings.

**`gds_menu` indicator** at line 3791:

| Indicator | `overall` from JSON |
|---|---|
| `[OK]`       | OK |
| `[WARN ⚠]`   | WARN |
| `[FAIL ✗]`   | FAIL |
| (empty)      | GDS not installed |

### Healthcheck extension — `check_gds()` (deliverable 3)

Four new check keys, each emitting one or more `CheckResult` rows from
the JSON the bash parser produced:

| Check key | Source field | Severity rules | `fix_hint` |
|---|---|---|---|
| `gdscheck_nfs_state` | `.nfs_state` + `.compat` | PASS=nvfs+compat · WARN=nvfs only · FAIL=unsupported | "Run `client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh` then reboot. See docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md" |
| `cufile_mount_table_schema` | `.mount_table` | PASS=valid · WARN=inner key missing · FAIL=wrong outer type | "Re-run **GPUDirect Storage → Configure cuFile** to rewrite the schema" |
| `nfs_mount_proto` | `.mounts[].proto` | PASS · FAIL with offending mount path(s) | "Remount with `proto=rdma,port=20049` — see `mount -o remount …` or `/etc/fstab`" |
| `gdsio_smoke` | (live run) | PASS+throughput · WARN below profile threshold · FAIL on non-zero exit | "Inspect detail; run **GPUDirect Storage → Run gdsio Benchmark** for the full run" |

Skip semantics (one `INFO` row, no FAIL): GDS not installed; or no NFS
mount on this client.

**`gdsio_smoke` flow:**

```
Run only when:
  - profile enables it
  - gdscheck shows nvfs or nvfs,compat
  - at least one proto=rdma NFS mount exists

For the first proto=rdma mount:
  1. truncate -s 1G <mp>/gdsio.healthcheck.{0..3}        (sparse)
  2. gdsio -D <mp> -d 0 -w 4 -s 1G -i 1M -x 0 -I 0 -T 5   # READ
  3. gdsio -D <mp> -d 0 -w 4 -s 1G -i 1M -x 0 -I 1 -T 5   # WRITE
  4. rm <mp>/gdsio.healthcheck.*
  5. Parse "Throughput: <N> GiB/sec" from each pass.
     CheckResult.detail = "READ N1 GiB/s · WRITE N2 GiB/s"
```

Wall time: ~12 s. Disk transient: 4 GiB sparse.
Exit handling: each `gdsio` call tolerates non-zero (same pattern as
`run_gdsio_benchmark`) so a crash never aborts the healthcheck.

### Profile wiring — `client_health_profiles/*.yml`

```yaml
# default.yml — read-only checks only
gds:
  enabled: true
  checks:
    - cufile_config              # existing
    - cufile_nfs_rdma            # existing
    - gdscheck_nfs_state         # NEW
    - cufile_mount_table_schema  # NEW
    - nfs_mount_proto            # NEW
    # gdsio_smoke OFF — touches disk, ~12 s
```

```yaml
# ai-training.yml & checkpoint-heavy.yml — opt-in smoke benchmark
gds:
  enabled: true
  checks:
    - cufile_config
    - cufile_nfs_rdma
    - gdscheck_nfs_state
    - cufile_mount_table_schema
    - nfs_mount_proto
    - gdsio_smoke
  gdsio_smoke:
    threads: 4
    duration_s: 5
    file_size: 1G
    block_size: 1M
    min_read_gib_s: 0           # 0 = record only, no WARN
    min_write_gib_s: 0
```

`hpc-readmostly.yml` stays at the read-only set — read-mostly workloads
serve from a warm cache and a smoke benchmark gives misleading numbers.

### Hooks into existing healthcheck affordances

- `client_remediation_wizard()` at line 1689 already drives users through
  `fix_hint` strings — new check keys integrate for free.
- `view_last_client_report()` at line 1623 picks up new rows via the
  existing `CheckResult` serialization.

## Testing

Per `CLAUDE.md` — "infrastructure-as-code; validation occurs through
Ansible modules / manual reproduction." Each task in the implementation
plan will list exact verification commands and expected outputs. Key
acceptance signals:

- **Patch + applier.** Re-run `apply-mlnx-nfsrdma-export-gpl.sh` twice
  in a row; second run prints "no-op (already patched)" and exits 0.
- **Menu `verify_gds`.** Run on the test box pre- and post-patch:
  pre = `[FAIL ✗]` indicator with NFS-Unsupported error in CRITICAL
  ERRORS panel; post = `[OK]` with no errors.
- **Healthcheck.** Run with `default.yml` profile: emits new check rows;
  `gdsio_smoke` row absent. Re-run with `ai-training.yml`: `gdsio_smoke`
  row present with throughput.
- **TCP-mount regression.** Manually remount `/mnt/nas` with `proto=tcp`,
  re-run `verify_gds`: produces `nfs_mount_proto FAIL` with the path.
- **Already-fixed upstream simulation.** Manually patch the source to
  `EXPORT_SYMBOL_GPL` before running the applier; applier detects "no
  bug pattern present" and exits 0 with no-op.

## Migration

Single commit (squash on merge). No data migration. Existing healthcheck
runs continue to produce the same rows; new rows additive. The menu's
`verify_gds` is rewritten in place — users who previously saw an
incorrect `PASS` will now see the truth, which is the intent.

## References

- Live session repro & evidence — chat log (this conversation).
- `docs/plans/2026-05-11-client-healthcheck-nfsrdma-design.md` — sibling
  healthcheck check key for the existing `mlnx-nfsrdma-dkms` install
  flow, on which the new check keys are modeled.
- `docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md` — the
  memo this design produces.
