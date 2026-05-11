# Client Healthcheck: NFS-RDMA Verification

**Date:** 2026-05-11
**Component:** `client_repo/client_healthcheck.sh`
**Status:** Design approved

## Problem

When MLNX_OFED / DOCA-Host is installed on a client, the in-kernel `rpcrdma`
module is built against the upstream `ib_core` / `rdma_cm` ABI and fails to
load against the OFED-provided modules (CRC mismatch). The visible failure
mode is misleading: `mount.nfs` returns `incorrect mount option` for any
`proto=rdma` mount.

The fix, applied by `client_setup.sh:enable_nfs_rdma` (line 523), is to
install `mlnx-nfsrdma-dkms` so `rpcrdma` is rebuilt against the OFED ABI.
Today the healthcheck has no way to verify that the fix is in place. A user
who sees mount failures has no signal pointing them at the missing DKMS
package.

## Goal

Add a read-only check to `client_healthcheck.sh` that verifies NFS-RDMA is
correctly installed and loadable on hosts where it is expected, and surfaces
the installed DKMS package version in the report.

## Non-goals

- Auto-remediation. The healthcheck stays read-only; it points at the
  installer's existing `enable_nfs_rdma` flow via `fix_hint`.
- Strict version pinning by default. Installed-and-functional is enough to
  PASS. An optional profile-level `nfsrdma_required_version` hook is
  available for environments that want strict equality, but no profile uses
  it out of the box.
- Validation on TCP-only clients. Profiles without RDMA hardware already
  disable the entire `rdma` section.

## Design

### Check placement

New check key `nfs_rdma` under the existing `rdma` section in
`check_rdma()` (currently at `client_healthcheck.sh:832`). The check key
emits multiple `CheckResult` rows — same pattern used by `cufile_config` in
`check_gds()`, which emits both `cufile_config` and `cufile_nfs_rdma`.

Placement under `rdma` (rather than `nfs_client`) is deliberate: the section
already has the right gating — profiles without RDMA disable it entirely,
so `default.yml` clients stay unaffected.

### Detection logic

Gated on MLNX/DOCA-OFED being present, since that is the only environment
where the wrong `rpcrdma` build silently breaks NFS-RDMA mounts. Detection
reuses the same probes as the installer at
`client_setup.sh:554-559`: `dpkg -l mlnx-ofed-kernel-dkms` OR `ofed_info -s`.

- **No OFED detected** → emit a single `INFO` row stating the upstream
  rpcrdma path is in use and `mlnx-nfsrdma-dkms` is not required. Matches
  `enable_nfs_rdma` early-return behavior.
- **OFED detected** → run the four sub-checks below.

### Sub-checks (when OFED is present)

| Sub-check | What it does | Severity on miss |
|---|---|---|
| `nfsrdma_dkms_pkg` | `dpkg -l mlnx-nfsrdma-dkms` — emit installed version string in `actual` field. | **FAIL** — `mount.nfs proto=rdma` will return misleading "incorrect mount option". `fix_hint`: re-run installer "Install NFS Tools" or `apt-get install mlnx-nfsrdma-dkms`. |
| `nfsrdma_module_loaded` | `rpcrdma` present in `/proc/modules`. | **FAIL** — `fix_hint`: `modprobe rpcrdma`. |
| `nfsrdma_abi_build` | `modinfo rpcrdma` filename contains `/dkms/` (i.e., it is the OFED build, not the upstream in-kernel one). | **WARN** — module loaded but it is the upstream copy; mounts will still fail despite "module loaded" being green. |
| `nfsrdma_persisted` | `/etc/modules-load.d/xinas-nfs-rdma.conf` exists. | **WARN** — works now, will not survive reboot. |

### Visibility (option-3 piece)

The installed version string from `dpkg -l mlnx-nfsrdma-dkms` is always
shown in the `nfsrdma_dkms_pkg` row's `actual` field when OFED is present.
This is the practical "version visibility" — it helps spot the rare case
where the wrong DOCA-Host repo is enabled, without forcing operators to
maintain a pinned version list.

### Optional version-pin hook

If a profile sets `nfsrdma_required_version: "X.Y-Z"` in `expectations`, do
a strict equality check (PASS/WARN). Default profiles do not set it, so
behavior stays "installed + functional = PASS." Costs ~5 lines and keeps
strict-pin available for environments that want it (e.g., locked-down
production fleets) without forcing it on everyone.

### Profile changes

Add `nfs_rdma` to `rdma.checks` in:
- `client_repo/client_health_profiles/ai-training.yml`
- `client_repo/client_health_profiles/hpc-readmostly.yml`
- `client_repo/client_health_profiles/checkpoint-heavy.yml`

`default.yml` is unchanged (RDMA section stays disabled).

## Architecture notes

- All commands are read-only: `dpkg -l`, `modinfo`, `read_file`, listing
  `/sys/class/infiniband`. Reuses existing `run_cmd` / `read_file` helpers
  in the embedded Python script.
- Failures in any individual sub-probe degrade gracefully — the section
  wrapper at `client_healthcheck.sh:1390-1395` already catches exceptions
  per-section.
- No new external dependencies. `modinfo` and `dpkg` are present on every
  supported target (Ubuntu 22.04 / 24.04).

## Testing

- Unit-style: invoke `client_healthcheck.sh` standalone with each of the
  three RDMA profiles on a host with OFED + DKMS installed → expect all
  four sub-checks PASS plus version row.
- Negative path: uninstall `mlnx-nfsrdma-dkms` (or stage a test container
  with OFED but no DKMS) → expect `nfsrdma_dkms_pkg` FAIL with version
  field `not installed` and the documented `fix_hint`.
- Gating: run with `default.yml` → no `nfs_rdma` rows emitted.
- Gating: run on a TCP-only host (no OFED) using an RDMA profile → single
  `INFO` row stating OFED not detected; remaining sub-checks skipped.

## Out of scope / future

- Cross-checking the loaded `rpcrdma` `srcversion` against the DKMS source
  tarball (overkill; modinfo path is sufficient).
- Auto-installing `mlnx-nfsrdma-dkms` from the healthcheck (would violate
  read-only contract; installer already does this).
- Adding default version pins to profiles (defer until a real fleet asks
  for it).
