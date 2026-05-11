# Client Healthcheck NFS-RDMA Verification — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `nfs_rdma` check to `client_healthcheck.sh` that verifies — on hosts with MLNX/DOCA-OFED installed — that `mlnx-nfsrdma-dkms` is present, the `rpcrdma` module is loaded from the DKMS build, and load is persisted across reboots. Emits the installed package version in the report.

**Architecture:** New check key `nfs_rdma` lives inside `check_rdma()` (next to `rdma_devices` and `port_state`). Detection is gated on MLNX/DOCA-OFED presence using the same `dpkg -l mlnx-ofed-kernel-dkms` / `ofed_info -s` probes the installer uses (`client_setup.sh:554-559`). Read-only — no remediation. Three RDMA profiles get the new check key added to `rdma.checks`.

**Tech Stack:** Bash + embedded Python heredoc (`client_healthcheck.sh`), YAML profile files. No new dependencies — uses existing `run_cmd`, `read_file`, `CheckResult` helpers and standard `dpkg` / `modinfo` (always present on Ubuntu 22.04 / 24.04).

**Reference design:** `docs/plans/2026-05-11-client-healthcheck-nfsrdma-design.md`

**Project testing reality:** Per `CLAUDE.md` — "No build/test system - This is infrastructure-as-code; validation occurs through Ansible modules." So verification per task is **manual reproduction with documented expected outputs**, not pytest. Each task's verification step lists exact commands and expected JSON keys/values.

---

## Task 1: Add `_ofed_present()` and `_dpkg_version()` helpers

**Why first:** Both later tasks depend on these. Adding them in isolation lets us verify they work before wiring in the actual check.

**Files:**
- Modify: `client_repo/client_healthcheck.sh:182` — add two helper functions after the existing `run_cmd` helper (inside the embedded Python heredoc).

**Step 1: Add helpers**

After the `run_cmd` definition (around line 187, before `def get_interfaces():` at line 189), insert:

```python
def _dpkg_version(pkg):
    """Return installed Debian package version string, or None if not installed."""
    out = run_cmd(f"dpkg-query -W -f='${{Status}}|${{Version}}' {pkg} 2>/dev/null")
    if not out or "|" not in out:
        return None
    status, version = out.split("|", 1)
    fields = status.strip().split()
    if not fields or fields[-1] != "installed":
        return None
    return version.strip() or None

def _ofed_present():
    """True if MLNX_OFED / DOCA-Host kernel stack is installed.
    Mirrors the probe used by client_setup.sh:enable_nfs_rdma."""
    if _dpkg_version("mlnx-ofed-kernel-dkms"):
        return True
    return run_cmd("ofed_info -s 2>/dev/null") is not None
```

Note: the `Status:` field has the form `<desired> <error> <state>` (e.g. `install ok installed`). Match the final whitespace-separated field exactly — substring `"installed"` would false-positive on `half-installed` and `not-installed` (the very failure modes this check is meant to catch for `mlnx-nfsrdma-dkms`).

**Step 2: Smoke-test the helpers in isolation**

Run on a host *without* OFED (or any dev machine):

```bash
python3 -c "
import subprocess
def run_cmd(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None

def _dpkg_version(pkg):
    out = run_cmd(f\"dpkg-query -W -f='\\${{Status}}|\\${{Version}}' {pkg} 2>/dev/null\")
    if not out or '|' not in out:
        return None
    status, version = out.split('|', 1)
    if 'installed' not in status:
        return None
    return version.strip() or None

print('bash:', _dpkg_version('bash'))           # expect a version string like '5.1-6ubuntu1'
print('nonexistent:', _dpkg_version('nonexistent-xyz'))  # expect None
print('mlnx-nfsrdma-dkms:', _dpkg_version('mlnx-nfsrdma-dkms'))  # expect None on dev box
"
```

**Expected output:** `bash: <some version>`, `nonexistent: None`, `mlnx-nfsrdma-dkms: None`.

If `bash:` prints `None`, the dpkg-query syntax is wrong — fix the escaping before continuing.

**Step 3: Run the existing healthcheck to confirm we didn't break anything**

```bash
sudo bash client_repo/client_healthcheck.sh --profile default --json /tmp/hc-task1.json
echo "Exit: $?"
jq '.results | length' /tmp/hc-task1.json
```

Expected: exit 0 (or whatever it was before — record the baseline). `.results | length` should be unchanged from before this task.

**Step 4: Commit**

```bash
git add client_repo/client_healthcheck.sh
git commit -m "feat(client-healthcheck): add _ofed_present and _dpkg_version helpers"
```

---

## Task 2: Add `nfs_rdma` check inside `check_rdma()`

**Files:**
- Modify: `client_repo/client_healthcheck.sh` — append a new `if "nfs_rdma" in checks:` block at the end of `check_rdma()` (currently ends at line 874, just before `return results`).

**Step 1: Insert the check block**

Inside `check_rdma()`, immediately before `return results` (line 874), insert:

```python
    if "nfs_rdma" in checks:
        if not _ofed_present():
            results.append(CheckResult("RDMA", "nfs_rdma", "INFO",
                "OFED not detected", "N/A",
                evidence="upstream rpcrdma path; mlnx-nfsrdma-dkms not required"))
        else:
            # Sub-check 1: mlnx-nfsrdma-dkms package presence (+ version visibility)
            pkg_ver = _dpkg_version("mlnx-nfsrdma-dkms")
            required_ver = exp.get("nfsrdma_required_version")
            if pkg_ver is None:
                results.append(CheckResult("RDMA", "nfsrdma_dkms_pkg", "FAIL",
                    "not installed", required_ver or "installed",
                    impact="Without mlnx-nfsrdma-dkms, mount.nfs proto=rdma fails with "
                           "the misleading 'incorrect mount option' error",
                    fix_hint="apt-get install mlnx-nfsrdma-dkms (or re-run installer "
                             "'Install NFS Tools')"))
            elif required_ver and pkg_ver != required_ver:
                results.append(CheckResult("RDMA", "nfsrdma_dkms_pkg", "WARN",
                    pkg_ver, required_ver,
                    impact="Installed mlnx-nfsrdma-dkms version differs from profile pin",
                    fix_hint=f"apt-get install --reinstall mlnx-nfsrdma-dkms={required_ver}"))
            else:
                results.append(CheckResult("RDMA", "nfsrdma_dkms_pkg", "PASS",
                    pkg_ver, required_ver or "installed"))

            # Sub-check 2: rpcrdma module loaded
            loaded = read_file("/proc/modules") or ""
            module_loaded = any(line.split()[:1] == ["rpcrdma"]
                                for line in loaded.split("\n") if line.strip())
            if module_loaded:
                results.append(CheckResult("RDMA", "nfsrdma_module_loaded", "PASS",
                    "loaded", "loaded"))
            else:
                results.append(CheckResult("RDMA", "nfsrdma_module_loaded", "FAIL",
                    "not loaded", "loaded",
                    impact="rpcrdma must be loaded for NFS-RDMA mounts",
                    fix_hint="modprobe rpcrdma"))

            # Sub-check 3: ABI build (DKMS path) — only meaningful if loaded
            if module_loaded:
                modinfo_out = run_cmd("modinfo rpcrdma 2>/dev/null") or ""
                fname = ""
                for line in modinfo_out.split("\n"):
                    if line.startswith("filename:"):
                        fname = line.split(":", 1)[1].strip()
                        break
                if "/updates/dkms/" in fname:
                    results.append(CheckResult("RDMA", "nfsrdma_abi_build", "PASS",
                        "OFED/DKMS build", "OFED/DKMS build",
                        evidence=fname))
                elif fname:
                    results.append(CheckResult("RDMA", "nfsrdma_abi_build", "WARN",
                        "upstream in-kernel build", "OFED/DKMS build",
                        evidence=fname,
                        impact="rpcrdma is the upstream copy; ABI mismatch with OFED "
                               "ib_core/rdma_cm — mounts will likely fail",
                        fix_hint="apt-get install mlnx-nfsrdma-dkms && "
                                 "dkms autoinstall -k $(uname -r) && modprobe -r rpcrdma && "
                                 "modprobe rpcrdma"))
                else:
                    results.append(CheckResult("RDMA", "nfsrdma_abi_build", "SKIP",
                        "modinfo unavailable", "OFED/DKMS build"))

            # Sub-check 4: persistence across reboot
            persist_path = "/etc/modules-load.d/xinas-nfs-rdma.conf"
            if os.path.isfile(persist_path):
                results.append(CheckResult("RDMA", "nfsrdma_persisted", "PASS",
                    persist_path, "present"))
            else:
                results.append(CheckResult("RDMA", "nfsrdma_persisted", "WARN",
                    "missing", "present",
                    impact="rpcrdma works now but will not auto-load after reboot",
                    fix_hint=f"echo rpcrdma > {persist_path}"))
```

**Step 2: Syntax check**

Bash heredoc means we can't directly lint — but we can extract and check:

```bash
sed -n '/python3 - "$profile_file"/,/^PYEOF$/p' client_repo/client_healthcheck.sh \
  | sed '1d;$d' > /tmp/hc-py.py
python3 -m py_compile /tmp/hc-py.py
echo "Exit: $?"
```

Expected: exit 0, no output.

**Step 3: Run healthcheck against `default.yml` (gating sanity check)**

```bash
sudo bash client_repo/client_healthcheck.sh --profile default --json /tmp/hc-task2-default.json
jq '[.results[] | select(.name | startswith("nfsrdma_") or . == "nfs_rdma")]' /tmp/hc-task2-default.json
```

Expected: `[]` — `default.yml` does not enable the `rdma` section, so no `nfs_rdma` rows should appear.

**Step 4: Run healthcheck against an RDMA profile on a TCP-only dev box (no OFED)**

```bash
sudo bash client_repo/client_healthcheck.sh --profile ai-training --json /tmp/hc-task2-ai.json 2>&1 || true
jq '.results[] | select(.section == "RDMA")' /tmp/hc-task2-ai.json
```

Expected: still no `nfs_rdma` row at this stage (profile not yet updated in Task 3). Existing `rdma_devices` / `port_state` rows continue to behave as before. This step proves Task 2 is **inert** until Task 3 wires the profile.

**Step 5: Commit**

```bash
git add client_repo/client_healthcheck.sh
git commit -m "feat(client-healthcheck): add nfs_rdma check (gated on OFED presence)"
```

---

## Task 3: Wire `nfs_rdma` into the three RDMA profiles

**Files:**
- Modify: `client_repo/client_health_profiles/ai-training.yml:10`
- Modify: `client_repo/client_health_profiles/hpc-readmostly.yml:10`
- Modify: `client_repo/client_health_profiles/checkpoint-heavy.yml:10`

**Step 1: Update `ai-training.yml`**

Change line 10 from:

```yaml
  rdma: { enabled: true, checks: [rdma_devices, port_state] }
```

to:

```yaml
  rdma: { enabled: true, checks: [rdma_devices, port_state, nfs_rdma] }
```

**Step 2: Update `hpc-readmostly.yml`**

Same change — append `, nfs_rdma` inside the `checks` list on line 10.

**Step 3: Update `checkpoint-heavy.yml`**

Same change — append `, nfs_rdma` inside the `checks` list on line 10.

**Step 4: Verify the YAML still parses**

The healthcheck has a fallback YAML parser; quickest sanity check is to actually run it:

```bash
for p in ai-training hpc-readmostly checkpoint-heavy; do
  echo "=== $p ==="
  sudo bash client_repo/client_healthcheck.sh --profile "$p" --json "/tmp/hc-task3-$p.json" 2>&1 || true
  jq '.results[] | select(.section == "RDMA") | "\(.name): \(.status) | \(.actual)"' \
    "/tmp/hc-task3-$p.json"
done
```

**Expected on a host without OFED hardware:**
- Each profile shows: `rdma_devices: FAIL` (or similar — depends on hardware) plus a single `nfs_rdma: INFO | OFED not detected` row.
- No Python tracebacks, no `error` rows.

**Expected on a host with OFED + DKMS + RDMA hardware (positive path):**
- `rdma_devices: PASS`, `port_state: PASS`
- `nfsrdma_dkms_pkg: PASS | <version-string>` (e.g. `5.8-OFED.5.8.0.1.0.1`)
- `nfsrdma_module_loaded: PASS | loaded`
- `nfsrdma_abi_build: PASS | OFED/DKMS build`
- `nfsrdma_persisted: PASS | /etc/modules-load.d/xinas-nfs-rdma.conf`

**Expected on a host with OFED but DKMS uninstalled (negative path — only run if you can reproduce):**
- `nfsrdma_dkms_pkg: FAIL | not installed` with the documented `fix_hint`.
- `nfsrdma_module_loaded`: depends on whether `rpcrdma` was previously loaded; FAIL if cold, PASS if loaded from a previous session.
- `nfsrdma_abi_build` (only emitted if loaded): WARN if upstream copy.

**Step 5: Commit**

```bash
git add client_repo/client_health_profiles/
git commit -m "feat(client-healthcheck): enable nfs_rdma check in RDMA profiles"
```

---

## Task 4: Final end-to-end verification + summary line

**No new code.** Just confirm the three profiles produce sensible reports, and update the human-readable text report shows the new rows nicely.

**Step 1: Re-run on the available test host(s)**

```bash
for p in default ai-training hpc-readmostly checkpoint-heavy; do
  echo "===== $p ====="
  sudo bash client_repo/client_healthcheck.sh --profile "$p"
done 2>&1 | tee /tmp/hc-task4-text.log
```

Scroll through `/tmp/hc-task4-text.log` and confirm:
- `default`: no `nfs_rdma` / `nfsrdma_*` rows.
- The three RDMA profiles: rows from Task 3's expected outputs are present and human-readable (no escape-sequence noise, no truncation of the version string).
- No Python tracebacks anywhere.

**Step 2: Inspect a JSON report for downstream consumers**

```bash
sudo bash client_repo/client_healthcheck.sh --profile ai-training --json /tmp/hc-final.json
jq '{
  rdma_section: [.results[] | select(.section == "RDMA")],
  pass_count: [.results[] | select(.section == "RDMA" and .status == "PASS")] | length,
  fail_count: [.results[] | select(.section == "RDMA" and .status == "FAIL")] | length
}' /tmp/hc-final.json
```

Expected: every `RDMA` row has the standard fields (`section`, `name`, `status`, `actual`, `expected`, `evidence`, `impact`, `fix_hint`) — no missing keys.

**Step 3: No commit needed** unless verification surfaced a bug — in which case fix it as a follow-up commit.

---

## What this plan does NOT do

- Does not write a Python unit-test harness for the embedded heredoc — the project has no test runner and adding one is out of scope (see `CLAUDE.md` "No build/test system").
- Does not touch the installer (`client_setup.sh`) — `enable_nfs_rdma` already does the right thing; the healthcheck just verifies its outcome.
- Does not auto-remediate from inside the healthcheck — read-only contract preserved.
- Does not pin `mlnx-nfsrdma-dkms` versions in any default profile — the optional `nfsrdma_required_version` hook exists for environments that want to add a pin later.
