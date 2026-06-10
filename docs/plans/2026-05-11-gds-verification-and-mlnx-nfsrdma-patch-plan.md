# GDS Verification + mlnx-nfsrdma Patch — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-apply the `EXPORT_SYMBOL` → `EXPORT_SYMBOL_GPL` fix to `mlnx-nfsrdma-dkms` in both client installers, rewrite `verify_gds` (and the GDS menu indicator) to be truth-telling via a shared bash parser writing JSON state, and extend the healthcheck with four new check keys driven by the same JSON — including an opt-in `gdsio_smoke` benchmark on AI/checkpoint profiles.

**Architecture:** One shared parser `_gds_parse_state()` in `client_setup.sh` writes `/tmp/.xinas-gds-state.json` from `gdscheck -p`, `/etc/cufile.json`, and `mount -t nfs,nfs4`. Two consumers: bash `verify_gds` (menu UX) and Python `check_gds` heredoc inside `client_healthcheck.sh`. Patch lives in `client_repo/patches/` with an idempotent applier called from both installer flows. The patched module is rebuilt via DKMS; reload is best-effort and never auto-unmounts NFS.

**Tech Stack:** Bash (installer + menu), embedded Python heredoc + YAML profiles (healthcheck), `jq` (already a dependency), `dkms`, `sed`. No new external dependencies.

**Reference design:** `docs/plans/2026-05-11-gds-verification-and-mlnx-nfsrdma-patch-design.md`

**Project testing reality:** Per `CLAUDE.md` — "No build/test system - This is infrastructure-as-code; validation occurs through Ansible modules / manual reproduction." Each task verifies via exact reproduction commands with expected outputs.

**Test box:** `ssh root@172.17.1.151` (password `nvidia`, `sshpass` available locally) — already used in this session to verify the kernel-side fix manually. Use it for live verification of tasks 2, 3, 5, 7, 9, 10.

**Suggested SSH helper for tasks that touch the test box:**

```bash
SSHOPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/xinas-known-hosts \
         -o ConnectTimeout=10 -o PreferredAuthentications=password \
         -o PubkeyAuthentication=no)
xssh() { sshpass -p nvidia ssh "${SSHOPTS[@]}" root@172.17.1.151 "$@"; }
xscp() { sshpass -p nvidia scp "${SSHOPTS[@]}" "$@"; }
```

---

## Task 1: Write the mlnx-nfsrdma troubleshooting memo

**Why first:** Pure docs, zero code dependency. Other tasks reference this file by path in fix_hint strings and patch headers, so getting the canonical path locked in early prevents churn.

**Files:**
- Create: `docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md`

**Step 1: Create the directory + write the memo**

```bash
mkdir -p docs/troubleshooting
```

Write the memo following the structure in the design's "Section 3 / 5 — The memo": TL;DR · Symptoms · Root cause · Confirmation · Affected · Workaround · Proposed upstream fix · References. Target length ≤ 1.5 screens.

Required sections and signals to include verbatim (these are the strings other engineers will grep for):

- TL;DR sentence calling out `EXPORT_SYMBOL` vs `EXPORT_SYMBOL_GPL`.
- The dmesg signature exactly: `failing symbol_get of non-GPLONLY symbol rpcrdma_register_nvfs_dma_ops.`
- The user-visible failure: `gdscheck -p` reports `NFS : Unsupported`; `gdsio` with `-x 0` returns `file register error: GPUDirect Storage not supported on current file`.
- The two-line patch (the `EXPORT_SYMBOL` → `EXPORT_SYMBOL_GPL` swaps) as a code block.
- Affected version: `mlnx-nfsrdma-dkms 26.01.OFED.26.01.1.0.0.1` (DOCA-Host 26.01).
- Workaround paths: `client_repo/patches/mlnx-nfsrdma-nvfs-export-gpl.patch` and `client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh`.

**Step 2: Verify the memo renders + key strings are present**

```bash
grep -F 'failing symbol_get of non-GPLONLY symbol rpcrdma_register_nvfs_dma_ops' \
     docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
grep -F 'EXPORT_SYMBOL_GPL(REGISTER_FUNC)' \
     docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
grep -F 'NFS : Unsupported' \
     docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
grep -F 'mlnx-nfsrdma-dkms 26.01.OFED.26.01.1.0.0.1' \
     docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
wc -l docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
```

Expected: each `grep` prints exactly one line; `wc -l` reports between 60 and 140 lines (sanity bounds for the target length).

**Step 3: Commit**

```bash
git add docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
git commit -m "docs(troubleshooting): memo on mlnx-nfsrdma EXPORT_SYMBOL_GPL bug"
```

---

## Task 2: Create the patch file + applier script + patches/README

**Why before installer wiring:** The applier needs to exist (and be tested standalone against the test box) before any caller is wired in.

**Files:**
- Create: `client_repo/patches/README.md`
- Create: `client_repo/patches/mlnx-nfsrdma-nvfs-export-gpl.patch`
- Create: `client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh`

**Step 1: Write the patch file**

Unified-diff format with a long `#`-prefixed comment header documenting symptom, root cause, affected version, and a link to `docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md`. Body:

```diff
--- a/nvfs_rpc_rdma.c
+++ b/nvfs_rpc_rdma.c
@@ -28,7 +28,7 @@
        } else
              return -ENOTSUPP;
 }
-EXPORT_SYMBOL(REGISTER_FUNC);
+EXPORT_SYMBOL_GPL(REGISTER_FUNC);
 
 // protected via nvfs_module_mutex
 void UNREGISTER_FUNC (void)
@@ -39,4 +39,4 @@
        } while (nvfs_count_ops());
        nvfs_ops = NULL;
 }
-EXPORT_SYMBOL(UNREGISTER_FUNC);
+EXPORT_SYMBOL_GPL(UNREGISTER_FUNC);
```

The applier (next step) does NOT use `patch(1)` — it uses idempotent `sed` so it tolerates upstream cosmetic drift around the two lines. The `.patch` file is kept primarily as documentation and as a record of the exact change for reviewers / upstream submission.

**Step 2: Write the applier script — `apply-mlnx-nfsrdma-export-gpl.sh`**

```bash
#!/usr/bin/env bash
# Idempotent applier for the mlnx-nfsrdma EXPORT_SYMBOL_GPL fix.
# See: docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
# Returns 0 for "applied" AND "no-op-not-needed".
# Returns non-zero only on real error (missing dkms, build failure).

set -euo pipefail

PKG="mlnx-nfsrdma-dkms"
LOG_PREFIX="[mlnx-nfsrdma-gds-patch]"

log() { echo "$LOG_PREFIX $*"; }

# 1. Prerequisite gate
if ! dpkg-query -W -f='${Status}' "$PKG" 2>/dev/null | grep -q 'install ok installed'; then
    log "$PKG not installed — nothing to do."
    exit 0
fi
if ! command -v dkms &>/dev/null; then
    log "ERROR: dkms not found but $PKG is installed."
    exit 1
fi

# 2. Locate source tree
SRC=$(ls -d /usr/src/mlnx-nfsrdma-*/ 2>/dev/null | tail -1 | sed 's:/$::')
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
    log "ERROR: no /usr/src/mlnx-nfsrdma-*/ directory found."
    exit 1
fi
F="$SRC/nvfs_rpc_rdma.c"
if [[ ! -f "$F" ]]; then
    log "ERROR: $F not present — source layout changed?"
    exit 1
fi

# 3. Bug-pattern detection
if ! grep -qE '^EXPORT_SYMBOL\((UN)?REGISTER_FUNC\)' "$F"; then
    log "No bug pattern in $F — already patched or upstream-fixed. No-op."
    exit 0
fi

# 4. Backup + sed patch
TS=$(date +%Y%m%d%H%M%S)
BAK="$F.xinas-bak.$TS"
cp -p "$F" "$BAK"
log "Backup: $BAK"

sed -i \
    -e 's/^EXPORT_SYMBOL(REGISTER_FUNC)/EXPORT_SYMBOL_GPL(REGISTER_FUNC)/' \
    -e 's/^EXPORT_SYMBOL(UNREGISTER_FUNC)/EXPORT_SYMBOL_GPL(UNREGISTER_FUNC)/' \
    "$F"

if ! grep -q '^EXPORT_SYMBOL_GPL(REGISTER_FUNC)' "$F" \
   || ! grep -q '^EXPORT_SYMBOL_GPL(UNREGISTER_FUNC)' "$F"; then
    log "ERROR: sed did not produce both EXPORT_SYMBOL_GPL lines. Reverting."
    cp -p "$BAK" "$F"
    exit 1
fi
log "Patched $F."

# 5. DKMS rebuild
VER=$(basename "$SRC" | sed 's/^mlnx-nfsrdma-//')
KVER=$(uname -r)

log "DKMS remove mlnx-nfsrdma/$VER (all kernels)..."
dkms remove "mlnx-nfsrdma/$VER" --all >/dev/null 2>&1 || true

log "DKMS install mlnx-nfsrdma/$VER for $KVER..."
if ! dkms install "mlnx-nfsrdma/$VER" -k "$KVER"; then
    log "ERROR: DKMS rebuild failed. Restoring source and reinstalling original."
    cp -p "$BAK" "$F"
    dkms install "mlnx-nfsrdma/$VER" -k "$KVER" >/dev/null 2>&1 || true
    exit 1
fi
log "Rebuilt. New srcversion: $(cat /var/lib/dkms/mlnx-nfsrdma/$VER/$KVER/*/module/rpcrdma.ko 2>/dev/null | true)"

# 6. Module reload — best effort, never destructive
REFCNT=$(cat /sys/module/rpcrdma/refcnt 2>/dev/null || echo "n/a")
if [[ "$REFCNT" == "0" ]]; then
    log "rpcrdma refcnt=0 — reloading module live."
    if modprobe -r rpcrdma 2>/dev/null && modprobe rpcrdma 2>/dev/null; then
        log "Patched rpcrdma is live. gdscheck should now report NFS : nvfs."
    else
        log "WARN: live reload failed. Reboot to activate the GDS-NFS fix."
    fi
else
    log "rpcrdma refcnt=$REFCNT (in use) — patched module is on disk."
    log "Reboot to activate the GDS-NFS fix (will NOT auto-unmount NFS)."
fi

exit 0
```

Make executable.

**Step 3: Write `client_repo/patches/README.md`**

Short markdown table per the design's Section 2:

| Patch | Target | Trigger | Memo |
|---|---|---|---|
| `mlnx-nfsrdma-nvfs-export-gpl.patch` | `mlnx-nfsrdma-dkms` (until upstream fix) | content-based: applier runs on every install; auto-skips when bug pattern absent | [troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md](../../docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md) |

Add a one-paragraph "Adding new patches" note explaining the applier-with-no-op-detection pattern so future entries follow the same shape.

**Step 4: Bash-lint and permissions**

```bash
bash -n client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh && echo SYNTAX_OK
chmod +x client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh
ls -l client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh
```

Expected: `SYNTAX_OK` printed; ls shows the file is executable (e.g., `-rwxr-xr-x`).

**Step 5: Live test the applier against the test box**

The test box (`172.17.1.151`) was already patched in this session, so the applier should detect that and return no-op:

```bash
xscp client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh \
     root@172.17.1.151:/tmp/apply-test.sh
xssh 'chmod +x /tmp/apply-test.sh && /tmp/apply-test.sh; echo "rc=$?"'
```

Expected:
```
[mlnx-nfsrdma-gds-patch] No bug pattern in /usr/src/mlnx-nfsrdma-26.01.OFED.26.01.1.0.0.1/nvfs_rpc_rdma.c — already patched or upstream-fixed. No-op.
rc=0
```

If you want to also exercise the apply path live, you can revert the test-box source to the buggy state from its backup (`/usr/src/mlnx-nfsrdma-26.01.OFED.26.01.1.0.0.1/nvfs_rpc_rdma.c.bak.20260511050515`), re-run the applier, and confirm rc=0 with full DKMS rebuild logs. Skip this if you don't want to disturb the live box again.

**Step 6: Commit**

```bash
git add client_repo/patches/
git commit -m "feat(client/patches): add mlnx-nfsrdma EXPORT_SYMBOL_GPL fix + applier"
```

---

## Task 3: Wire the applier into both installer flows

**Files:**
- Modify: `install_client.sh:enable_nfs_rdma_oneshot()` (around line 215-227)
- Modify: `client_repo/client_setup.sh:enable_nfs_rdma()` (the existing function ending ~line 600)

**Step 1: Patch `install_client.sh:enable_nfs_rdma_oneshot()`**

Locate the `apt-get install mlnx-nfsrdma-dkms` block (around line 214-225). Immediately after the existing "mlnx-nfsrdma-dkms already installed" branch and BEFORE `dkms autoinstall -k "$(uname -r)"` (line ~227), insert:

```bash
    # Auto-apply the EXPORT_SYMBOL_GPL fix if the buggy version is installed.
    # See: docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
    local applier="${INSTALL_DIR}/client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh"
    if [[ -x "$applier" ]]; then
        info "Checking for mlnx-nfsrdma GDS-hook export bug..."
        if "$applier" 2>&1 | sed 's/^/     /'; then
            ok "mlnx-nfsrdma GDS-hook check complete"
        else
            warn "mlnx-nfsrdma GDS-hook patch attempt failed — see output above"
        fi
    else
        skip "patch applier not present at $applier"
    fi
```

**Step 2: Patch `client_repo/client_setup.sh:enable_nfs_rdma()`**

Find `enable_nfs_rdma()` (the menu-side counterpart). Just before the `op_end` that closes its `op_start "Enable NFS-RDMA (rpcrdma)"` block, add:

```bash
    # Auto-apply EXPORT_SYMBOL_GPL fix to mlnx-nfsrdma source if the bug is
    # present. Idempotent: no-op when source is already correct.
    local applier="$(dirname "$0")/patches/apply-mlnx-nfsrdma-export-gpl.sh"
    if [[ -x "$applier" ]]; then
        op_run "apply mlnx-nfsrdma EXPORT_SYMBOL_GPL fix" "$applier" || true
    fi
```

The `|| true` is intentional — `op_run` already captures and reports the exit code; a non-zero patch attempt shouldn't abort the whole `enable_nfs_rdma` chain.

**Step 3: Syntax check**

```bash
bash -n install_client.sh && bash -n client_repo/client_setup.sh && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`.

**Step 4: Verify on the test box (already-patched fast path)**

```bash
# Copy current install_client.sh + the (already-patched) repo to test box
# and confirm the applier is called and reports no-op.
xscp install_client.sh root@172.17.1.151:/tmp/install_client.sh
xscp client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh \
     root@172.17.1.151:/opt/xinas-client/client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh
xssh 'chmod +x /opt/xinas-client/client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh
      INSTALL_DIR=/opt/xinas-client /opt/xinas-client/client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh
      echo "rc=$?"'
```

Expected: same "No bug pattern in … — already patched or upstream-fixed. No-op." + `rc=0`.

**Step 5: Commit**

```bash
git add install_client.sh client_repo/client_setup.sh
git commit -m "feat(installer): auto-apply mlnx-nfsrdma EXPORT_SYMBOL_GPL fix"
```

---

## Task 4: Add the shared parser `_gds_parse_state()`

**Why now:** All remaining tasks (5-9) consume its output. Builds in isolation; verifiable before any caller change.

**Files:**
- Modify: `client_repo/client_setup.sh` — add new function in the GDS section, near `check_gds_installed()` (~line 1496).

**Step 1: Add the parser function**

Insert `_gds_parse_state()` before `verify_gds()`. The function writes JSON to `/tmp/.xinas-gds-state.json` (atomic via tmpfile + mv) and implements the truth table from the design exactly. Schema (must match design Section 5):

```json
{
  "overall":     "OK | WARN | FAIL",
  "nfs_state":   "nvfs,compat | nvfs | unsupported | unknown",
  "compat":      "enabled | disabled",
  "mount_table": "valid | invalid | absent",
  "mounts":      [ { "path": "...", "proto": "rdma|tcp|..." } ],
  "errors":      [ "..." ],
  "warns":       [ "..." ],
  "ts":          "<iso8601 utc>"
}
```

Implementation outline (~80 lines bash):

1. Cache key: sha256 of `mtime(/etc/cufile.json)` + `mtime(/proc/driver/nvidia-fs/version)` + `cat /sys/module/rpcrdma/srcversion`. If cache file `/tmp/.xinas-gds-state.json` exists and its embedded `cache_key` matches, return early.
2. Run `sudo gdscheck -p 2>&1` once; parse:
   - `NFS\s*:\s*nvfs,\s*compat` → `nfs_state=nvfs,compat`, `compat=enabled`
   - `NFS\s*:\s*nvfs(?!,)` → `nfs_state=nvfs`, `compat=disabled`
   - `NFS\s*:\s*Unsupported` → `nfs_state=unsupported`, error
   - "Platform verification error" / "Invalid argument" → `nfs_state=unknown`, error
   - **Ignore the `Userspace RDMA :` line entirely** (per design).
3. Validate `/etc/cufile.json` `fs.nfs.mount_table` with `jq`:
   - `type == "object"` AND for each value `.rdma_dev_addr_list` is an array → `mount_table=valid`
   - object but any value missing `rdma_dev_addr_list` → `mount_table=invalid`, WARN
   - not an object or malformed → `mount_table=invalid`, FAIL
   - cufile.json absent → `mount_table=absent`, WARN
4. Enumerate NFS mounts via `findmnt -J -t nfs,nfs4` (JSON output, jq-friendly). For each mount, parse `options` for `proto=rdma|tcp|...`. Emit each into `mounts[]`. If GDS is `nvfs` (or `nvfs,compat`) AND any mount is non-rdma → FAIL with the path.
5. Roll up `overall`: FAIL wins over WARN wins over OK.
6. Write JSON atomically with `mktemp` + `mv`.

**Step 2: Smoke-test the parser standalone**

```bash
# Source just the parser into a test shell (won't trigger menu).
bash -c '
source <(awk "/^_gds_parse_state\\(\\)/,/^}/" client_repo/client_setup.sh)
_gds_parse_state
cat /tmp/.xinas-gds-state.json | jq .
' 2>&1 | head -40
```

Expected on a dev box without GDS:
```json
{
  "overall": "OK",
  "nfs_state": "unknown",
  ...
}
```

(Or whatever clean baseline — the point is it produces valid JSON without crashing.)

**Step 3: Run on the test box where GDS is now working**

```bash
xscp client_repo/client_setup.sh root@172.17.1.151:/tmp/cs.sh
xssh 'bash -c "source <(awk \"/^_gds_parse_state\\(\\)/,/^}/\" /tmp/cs.sh); _gds_parse_state"
      jq . /tmp/.xinas-gds-state.json'
```

Expected:
```json
{
  "overall": "OK",
  "nfs_state": "nvfs",
  "compat": "disabled",
  "mount_table": "valid",
  "mounts": [{ "path": "/mnt/nas", "proto": "rdma" }],
  ...
}
```

(`overall` may be `WARN` if compat is disabled — that's correct per the truth table.)

**Step 4: Run twice in succession to confirm the cache works**

```bash
xssh 'bash -c "source <(awk \"/^_gds_parse_state\\(\\)/,/^}/\" /tmp/cs.sh)
              time _gds_parse_state
              time _gds_parse_state"'
```

Expected: first call ~1 s (runs gdscheck); second call <0.05 s (cache hit; reads JSON only). Cache key embedded in the JSON must be identical between the two runs.

**Step 5: Commit**

```bash
git add client_repo/client_setup.sh
git commit -m "feat(client/setup): add _gds_parse_state shared GDS truth parser"
```

---

## Task 5: Rewrite `verify_gds()` to consume the JSON

**Files:**
- Modify: `client_repo/client_setup.sh:verify_gds()` (lines 1900-2027).

**Step 1: Rewrite `verify_gds()` body**

Replace the existing `verify_gds()` with one that:

1. Calls `_gds_parse_state` first.
2. Reads `/tmp/.xinas-gds-state.json` with `jq`.
3. Emits the new layout (design's "verify_gds() output layout"):
   - Header banner
   - `Overall: <symbol> <state> (<N> errors, <M> warnings)` line
   - **CRITICAL ERRORS** panel — only when `.errors | length > 0` (extracts each message verbatim from the JSON `errors[]` array, with `fix_hint` per message — see helper in step 2).
   - **WARNINGS** panel — only when `.warns | length > 0`.
   - Check 1: nvidia-fs Kernel Module (unchanged).
   - Check 2: GDS Libraries (unchanged).
   - Check 3: nvidia-fs Proc Interface (unchanged).
   - Check 4: cuFile Configuration — show TWO bullets: schema (from `.mount_table`) and compat (from `.compat`); each with its own PASS/WARN.
   - Check 5: gdscheck Platform Verification — PASS/WARN/FAIL derived from `.nfs_state` and presence of errors.
   - **NEW Check 6: NFS Mount Protocol** — iterate `.mounts[]`; PASS if all `proto==rdma`, FAIL otherwise listing offending paths.
   - Check 7 (was 6): GPU/NIC Topology — unchanged (info-only).
   - Full `gdscheck -p` raw output appended at the bottom (the existing behavior — keep it for context).

**Step 2: Add a small `_gds_fix_hint()` helper**

Maps a parser-error message substring to its short fix hint:

```bash
_gds_fix_hint() {
    local msg="$1"
    case "$msg" in
        *"NFS : Unsupported"*|*"NFS: Unsupported"*)
            echo "Run client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh, then reboot."
            echo "See docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md" ;;
        *"proto=tcp"*|*"mounted with proto"*)
            echo "Remount with proto=rdma,port=20049 — see /etc/fstab." ;;
        *"mount_table"*)
            echo "Re-run 'GPUDirect Storage → Configure cuFile' to rewrite the schema." ;;
        *"compat mode disabled"*)
            echo "Optional: set properties.allow_compat_mode = true in /etc/cufile.json." ;;
        *) echo "" ;;
    esac
}
```

**Step 3: Verify on the test box — happy path**

(Test box currently has GDS working with `nvfs` but compat disabled, so expected `Overall: WARN`.)

```bash
xscp client_repo/client_setup.sh root@172.17.1.151:/tmp/cs.sh
xssh 'bash -c "source /tmp/cs.sh; verify_gds 2>&1 | head -80"'
```

Expected output contains:
- A header banner.
- An `Overall: ⚠ WARN` (or similar) line.
- A `WARNINGS` panel mentioning compat mode.
- Check 5 marked `✓ PASS` (NFS state is nvfs).
- Check 6 marked `✓ PASS` (mount is proto=rdma).
- No `CRITICAL ERRORS` panel.

**Step 4: Verify on the test box — induced failure (TCP remount)**

```bash
xssh '
  umount /mnt/nas
  mount -t nfs -o vers=4.2,proto=tcp 192.168.2.12:/ /mnt/nas
  bash -c "source /tmp/cs.sh; verify_gds 2>&1 | head -60"
  umount /mnt/nas
  mount /mnt/nas
'
```

Expected: `Overall: ✗ FAIL`, CRITICAL ERRORS panel mentioning `/mnt/nas mounted with proto=tcp`, Check 6 marked FAIL.

**Step 5: Commit**

```bash
git add client_repo/client_setup.sh
git commit -m "feat(client/menu): rewrite verify_gds with JSON-driven truth and CRITICAL ERRORS panel"
```

---

## Task 6: Three-state `GDS [OK/WARN/FAIL]` indicator on the menu

**Files:**
- Modify: `client_repo/client_setup.sh` — the `${gds_indicator}` computation block (~line 3760-3777).

**Step 1: Replace the two-state indicator with three states**

```bash
    local gds_indicator=""
    if check_gds_installed; then
        # Run parser (cached) and read the rolled-up overall verdict.
        _gds_parse_state >/dev/null 2>&1 || true
        local _overall
        _overall=$(jq -r '.overall // "unknown"' /tmp/.xinas-gds-state.json 2>/dev/null)
        case "$_overall" in
            OK)   gds_indicator=" [OK]" ;;
            WARN) gds_indicator=" [WARN ⚠]" ;;
            FAIL) gds_indicator=" [FAIL ✗]" ;;
            *)    gds_indicator="" ;;
        esac
    fi
```

**Step 2: Verify the indicator on the test box**

```bash
xscp client_repo/client_setup.sh root@172.17.1.151:/tmp/cs.sh
xssh 'bash -c "source /tmp/cs.sh
              # Drive just the indicator block by invoking the wrapping function head.
              if check_gds_installed; then
                  _gds_parse_state >/dev/null 2>&1 || true
                  echo \"indicator: \$(jq -r .overall /tmp/.xinas-gds-state.json)\"
              fi"'
```

Expected: `indicator: WARN` (test box has nvfs but no compat — matches truth table). Confirm visually with a menu walkthrough if you launch the TUI (optional).

**Step 3: Commit**

```bash
git add client_repo/client_setup.sh
git commit -m "feat(client/menu): three-state GDS [OK/WARN/FAIL] indicator from parser"
```

---

## Task 7: Add three read-only check keys to `check_gds()`

**Why this slice:** All three new checks just read the JSON the bash parser produced — no live commands of their own. The destructive `gdsio_smoke` is split into its own task (Task 9) to keep scope tight.

**Files:**
- Modify: `client_repo/client_healthcheck.sh:check_gds()` (starts at line 972).

**Step 1: Add a Python helper to load the bash-produced JSON**

Inside the Python heredoc (top of the heredoc, near other helpers), add:

```python
def _gds_state():
    """Trigger the bash parser, then load /tmp/.xinas-gds-state.json.
    Returns the dict, or None if parser or file unavailable."""
    run_cmd("bash -c 'source /opt/xinas-client/client_repo/client_setup.sh "
            "2>/dev/null && _gds_parse_state' 2>/dev/null")
    try:
        import json
        with open("/tmp/.xinas-gds-state.json") as f:
            return json.load(f)
    except Exception:
        return None
```

Note: sourcing the entire `client_setup.sh` is heavy. Acceptable for a healthcheck run (once per execution); the parser itself caches so repeated calls are cheap. If sourcing turns out problematic in practice (e.g., side effects from top-level code in `client_setup.sh`), the alternative is to extract `_gds_parse_state` into its own sourceable file under `client_repo/lib/`. Flag this in code review; do not preemptively refactor.

**Step 2: Append the three new check keys to `check_gds()`**

Inside `check_gds()`, just before the existing `return results` line, add:

```python
    state = _gds_state() if any(k in checks for k in
        ("gdscheck_nfs_state", "cufile_mount_table_schema", "nfs_mount_proto")) else None

    if "gdscheck_nfs_state" in checks:
        if not state:
            results.append(CheckResult("GDS", "gdscheck_nfs_state", "WARN",
                "Parser unavailable", "could not produce GDS state JSON"))
        else:
            ns = state.get("nfs_state", "unknown")
            compat = state.get("compat", "disabled")
            if ns == "nvfs,compat":
                results.append(CheckResult("GDS", "gdscheck_nfs_state", "PASS",
                    "NFS : nvfs, compat (recommended)", "nvfs,compat"))
            elif ns == "nvfs":
                results.append(CheckResult("GDS", "gdscheck_nfs_state", "WARN",
                    "NFS : nvfs (compat fallback disabled)", "nvfs",
                    fix_hint=("Optional: set properties.allow_compat_mode=true "
                              "in /etc/cufile.json for safer fallback.")))
            elif ns == "unsupported":
                results.append(CheckResult("GDS", "gdscheck_nfs_state", "FAIL",
                    "NFS : Unsupported — GDS over NFS cannot register files",
                    ns,
                    fix_hint=("Run client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh "
                              "then reboot. See docs/troubleshooting/"
                              "mlnx-nfsrdma-export-symbol-gpl-bug.md")))
            else:
                results.append(CheckResult("GDS", "gdscheck_nfs_state", "WARN",
                    "gdscheck NFS state could not be determined", ns))

    if "cufile_mount_table_schema" in checks:
        if not state:
            results.append(CheckResult("GDS", "cufile_mount_table_schema", "WARN",
                "Parser unavailable", "could not produce GDS state JSON"))
        else:
            mt = state.get("mount_table", "absent")
            if mt == "valid":
                results.append(CheckResult("GDS", "cufile_mount_table_schema", "PASS",
                    "fs.nfs.mount_table schema OK", "valid"))
            elif mt == "absent":
                results.append(CheckResult("GDS", "cufile_mount_table_schema", "WARN",
                    "fs.nfs.mount_table not configured", "absent",
                    fix_hint="Run 'GPUDirect Storage → Configure cuFile' to populate."))
            else:
                results.append(CheckResult("GDS", "cufile_mount_table_schema", "FAIL",
                    "fs.nfs.mount_table malformed", mt,
                    fix_hint="Re-run 'GPUDirect Storage → Configure cuFile' to rewrite."))

    if "nfs_mount_proto" in checks:
        if not state:
            results.append(CheckResult("GDS", "nfs_mount_proto", "WARN",
                "Parser unavailable", "could not produce GDS state JSON"))
        else:
            mounts = state.get("mounts", [])
            tcp = [m["path"] for m in mounts if m.get("proto") != "rdma"]
            if not mounts:
                results.append(CheckResult("GDS", "nfs_mount_proto", "INFO",
                    "No NFS mounts on this client", "none"))
            elif not tcp:
                results.append(CheckResult("GDS", "nfs_mount_proto", "PASS",
                    "All NFS mounts use proto=rdma",
                    ",".join(m["path"] for m in mounts)))
            else:
                results.append(CheckResult("GDS", "nfs_mount_proto", "FAIL",
                    "NFS mount(s) not using proto=rdma — GDS will not engage",
                    ",".join(tcp),
                    fix_hint=("Remount with proto=rdma,port=20049 — "
                              "see /etc/fstab.")))
```

**Step 3: Run the healthcheck on the test box (default profile won't include the new keys yet — Task 8 wires them in)**

For now, drive the new keys via direct profile JSON override:

```bash
xscp client_repo/client_healthcheck.sh root@172.17.1.151:/tmp/hc.sh
xssh 'bash -c "
echo \"gds:
  enabled: true
  checks:
    - gdscheck_nfs_state
    - cufile_mount_table_schema
    - nfs_mount_proto\" > /tmp/profile-gds-only.yml
bash /tmp/hc.sh --profile /tmp/profile-gds-only.yml --json --no-save 2>/dev/null \
  | jq \".checks[] | select(.section==\\\"GDS\\\") | {name, severity, message}\"
"'
```

Expected: three rows, one per check key, severities consistent with the test box's state (`gdscheck_nfs_state=WARN` because compat is off, `cufile_mount_table_schema=PASS`, `nfs_mount_proto=PASS`).

**Step 4: Commit**

```bash
git add client_repo/client_healthcheck.sh
git commit -m "feat(client/healthcheck): add gdscheck_nfs_state, cufile_mount_table_schema, nfs_mount_proto checks"
```

---

## Task 8: Wire the new check keys into the YAML profiles

**Files:**
- Modify: `client_repo/client_health_profiles/default.yml`
- Modify: `client_repo/client_health_profiles/ai-training.yml`
- Modify: `client_repo/client_health_profiles/checkpoint-heavy.yml`
- Modify: `client_repo/client_health_profiles/hpc-readmostly.yml`

**Step 1: Inspect current `gds.checks` lists in each profile**

```bash
grep -nA8 '^gds:' client_repo/client_health_profiles/*.yml
```

Note: not all profiles necessarily have a `gds:` block today — confirm before editing each one.

**Step 2: Add the three read-only check keys to every profile's `gds.checks`**

In each profile with a `gds:` block, append three list items (preserving existing entries and YAML indentation):

```yaml
  checks:
    - cufile_config              # existing
    - cufile_nfs_rdma            # existing
    - gdscheck_nfs_state         # NEW
    - cufile_mount_table_schema  # NEW
    - nfs_mount_proto            # NEW
```

`gdsio_smoke` is NOT added here — that comes with Task 9.

**Step 3: YAML lint**

```bash
for f in client_repo/client_health_profiles/*.yml; do
    python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "$f OK" \
        || echo "$f FAIL"
done
```

Expected: every file prints `OK`.

**Step 4: End-to-end on the test box with default profile**

```bash
xscp client_repo/client_health_profiles/default.yml \
     root@172.17.1.151:/opt/xinas-client/client_repo/client_health_profiles/default.yml
xssh 'bash /opt/xinas-client/client_repo/client_healthcheck.sh --json --no-save 2>/dev/null \
  | jq ".checks[] | select(.section==\"GDS\") | {name, severity}"'
```

Expected: rows for `gdscheck_nfs_state`, `cufile_mount_table_schema`, `nfs_mount_proto` present alongside the existing `cufile_config` / `cufile_nfs_rdma` rows. NO `gdsio_smoke` row yet.

**Step 5: Commit**

```bash
git add client_repo/client_health_profiles/
git commit -m "feat(client/profiles): wire new GDS check keys into health profiles"
```

---

## Task 9: Add `gdsio_smoke` check + opt-in profile wiring

**Files:**
- Modify: `client_repo/client_healthcheck.sh:check_gds()` — append a new `if "gdsio_smoke" in checks:` block after the three read-only checks.
- Modify: `client_repo/client_health_profiles/ai-training.yml` — add `gdsio_smoke` to `gds.checks` + a `gdsio_smoke:` parameter block.
- Modify: `client_repo/client_health_profiles/checkpoint-heavy.yml` — same.
- Do NOT modify: `default.yml`, `hpc-readmostly.yml` (per design: smoke benchmark off by default; read-mostly profile excluded).

**Step 1: Implement the smoke check**

Inside `check_gds()`, after the three read-only blocks from Task 7:

```python
    if "gdsio_smoke" in checks:
        # Read smoke parameters from profile, fall back to design defaults.
        smoke_cfg = (exp.get("gdsio_smoke") or {})
        threads   = int(smoke_cfg.get("threads", 4))
        duration  = int(smoke_cfg.get("duration_s", 5))
        filesize  = smoke_cfg.get("file_size", "1G")
        blocksize = smoke_cfg.get("block_size", "1M")
        min_r     = float(smoke_cfg.get("min_read_gib_s", 0))
        min_w     = float(smoke_cfg.get("min_write_gib_s", 0))

        # Skip if state isn't healthy enough to bother.
        if not state:
            results.append(CheckResult("GDS", "gdsio_smoke", "WARN",
                "Skipped: parser unavailable", ""))
        elif state.get("nfs_state") not in ("nvfs", "nvfs,compat"):
            results.append(CheckResult("GDS", "gdsio_smoke", "INFO",
                "Skipped: gdscheck reports GDS not available for NFS",
                state.get("nfs_state", "unknown")))
        else:
            rdma_mounts = [m["path"] for m in state.get("mounts", [])
                           if m.get("proto") == "rdma"]
            if not rdma_mounts:
                results.append(CheckResult("GDS", "gdsio_smoke", "INFO",
                    "Skipped: no proto=rdma NFS mount detected", ""))
            else:
                mp = rdma_mounts[0]
                # Locate gdsio
                gdsio = run_cmd("ls /usr/local/cuda*/gds/tools/gdsio 2>/dev/null "
                                "| head -1") or "/usr/local/cuda/gds/tools/gdsio"

                # Pre-allocate
                for i in range(threads):
                    run_cmd(f"truncate -s {filesize} {mp}/gdsio.healthcheck.{i}")

                def _gdsio(direction_flag):
                    """Run gdsio, return (rc, throughput_gib_s_or_None)."""
                    cmd = (f"{gdsio} -D {mp} -d 0 -w {threads} -s {filesize} "
                           f"-i {blocksize} -x 0 -I {direction_flag} -T {duration} 2>&1")
                    out = run_cmd(cmd, timeout=duration + 30) or ""
                    rc = 0 if "Throughput:" in out else 1
                    import re
                    m = re.search(r'Throughput:\s*([\d.]+)\s*GiB/sec', out)
                    return rc, (float(m.group(1)) if m else None), out

                rc_r, gib_r, out_r = _gdsio(0)   # READ
                rc_w, gib_w, out_w = _gdsio(1)   # WRITE

                # Cleanup
                run_cmd(f"rm -f {mp}/gdsio.healthcheck.*")

                if rc_r or rc_w or gib_r is None or gib_w is None:
                    last = (out_w or out_r or "").splitlines()[-3:]
                    results.append(CheckResult("GDS", "gdsio_smoke", "FAIL",
                        "gdsio smoke benchmark failed",
                        " | ".join(last),
                        fix_hint=("Run 'GPUDirect Storage → Run gdsio Benchmark' "
                                  "from the client menu for full diagnostics.")))
                else:
                    detail = f"READ {gib_r:.2f} GiB/s · WRITE {gib_w:.2f} GiB/s ({mp})"
                    if (min_r and gib_r < min_r) or (min_w and gib_w < min_w):
                        results.append(CheckResult("GDS", "gdsio_smoke", "WARN",
                            "Throughput below profile threshold", detail,
                            fix_hint=("Inspect topology (nvidia-smi topo -mp) "
                                      "and NIC/GPU NUMA affinity.")))
                    else:
                        results.append(CheckResult("GDS", "gdsio_smoke", "PASS",
                            "GDS write+read round-trip OK", detail))
```

**Step 2: Wire into AI/checkpoint profiles**

In `ai-training.yml` and `checkpoint-heavy.yml`, add `gdsio_smoke` to the `gds.checks` list (last item), then append a `gdsio_smoke:` block as a sibling of `checks:`:

```yaml
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
    min_read_gib_s: 0      # 0 = record only, no WARN
    min_write_gib_s: 0
```

**Step 3: YAML lint**

```bash
for f in client_repo/client_health_profiles/{ai-training,checkpoint-heavy}.yml; do
    python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "$f OK" \
        || echo "$f FAIL"
done
```

Expected: both `OK`.

**Step 4: Run on the test box with `ai-training` profile**

```bash
xscp client_repo/client_healthcheck.sh \
     client_repo/client_health_profiles/ai-training.yml \
     root@172.17.1.151:/opt/xinas-client/client_repo/

xssh 'bash /opt/xinas-client/client_repo/client_healthcheck.sh \
    --profile /opt/xinas-client/client_repo/ai-training.yml \
    --json --no-save 2>/dev/null \
  | jq ".checks[] | select(.name==\"gdsio_smoke\") | {severity, message, detail}"'
```

Expected: one row, severity `PASS`, detail like `READ 25.xx GiB/s · WRITE 7.xx GiB/s (/mnt/nas)`.

Wall time of the healthcheck run should be ~15 s (12 s smoke + the existing read-only checks).

**Step 5: Commit**

```bash
git add client_repo/client_healthcheck.sh client_repo/client_health_profiles/{ai-training,checkpoint-heavy}.yml
git commit -m "feat(client/healthcheck): add gdsio_smoke benchmark for AI/checkpoint profiles"
```

---

## Task 10: Final end-to-end verification + push

**Step 1: Syntax + YAML lint everything we touched**

```bash
bash -n install_client.sh \
       client_repo/client_setup.sh \
       client_repo/client_healthcheck.sh \
       client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh \
    && echo "BASH_SYNTAX_OK"

for f in client_repo/client_health_profiles/*.yml; do
    python3 -c "import yaml; yaml.safe_load(open('$f'))"
done && echo "YAML_OK"
```

Expected: both `BASH_SYNTAX_OK` and `YAML_OK`.

**Step 2: Full menu walkthrough on the test box**

```bash
xscp client_repo/client_setup.sh \
     client_repo/client_healthcheck.sh \
     client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh \
     root@172.17.1.151:/opt/xinas-client/client_repo/

xssh 'bash -c "
echo === Indicator ===
source /opt/xinas-client/client_repo/client_setup.sh 2>/dev/null
_gds_parse_state >/dev/null 2>&1 || true
jq -r .overall /tmp/.xinas-gds-state.json

echo === verify_gds first 60 lines ===
verify_gds 2>&1 | head -60

echo === Healthcheck default profile ===
bash /opt/xinas-client/client_repo/client_healthcheck.sh --json --no-save 2>/dev/null \
  | jq \".checks[] | select(.section==\\\"GDS\\\") | {name, severity}\"

echo === Healthcheck ai-training profile ===
bash /opt/xinas-client/client_repo/client_healthcheck.sh \
    --profile /opt/xinas-client/client_repo/client_health_profiles/ai-training.yml \
    --json --no-save 2>/dev/null \
  | jq \".checks[] | select(.section==\\\"GDS\\\") | {name, severity, message}\"
"'
```

Expected pattern:

- Indicator: `WARN` (test box has nvfs but no compat).
- verify_gds: `Overall: ⚠ WARN`, WARNINGS panel mentions compat, no CRITICAL ERRORS panel, Check 5/6 both PASS.
- Default profile: rows for `cufile_config`, `cufile_nfs_rdma`, `gdscheck_nfs_state` (WARN), `cufile_mount_table_schema` (PASS), `nfs_mount_proto` (PASS) — no `gdsio_smoke`.
- AI profile: same five rows PLUS `gdsio_smoke` (PASS with throughput in `message`/`detail`).

**Step 3: Induced-failure smoke (regression confidence)**

Same TCP-remount trick from Task 5 — confirm `Overall` flips to `FAIL`, `nfs_mount_proto` flips to FAIL, and the menu indicator flips to `[FAIL ✗]`. Then revert.

```bash
xssh '
  umount /mnt/nas
  mount -t nfs -o vers=4.2,proto=tcp 192.168.2.12:/ /mnt/nas
  bash -c "source /opt/xinas-client/client_repo/client_setup.sh 2>/dev/null
           _gds_parse_state >/dev/null 2>&1 || true
           jq -r .overall /tmp/.xinas-gds-state.json
           jq .errors /tmp/.xinas-gds-state.json"
  umount /mnt/nas
  mount /mnt/nas
'
```

Expected: `FAIL` printed, errors array contains `"/mnt/nas mounted with proto=tcp"` (or similar).

**Step 4: Idempotency check on the applier (final regression)**

```bash
xssh '/opt/xinas-client/client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh; echo rc=$?
      /opt/xinas-client/client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh; echo rc=$?'
```

Expected: both runs end with `rc=0` and the "no-op (already patched or upstream-fixed)" message — no DKMS rebuild on the second run.

**Step 5: Push**

If all three live verifications pass:

```bash
git log --oneline origin/main..HEAD
git push origin main
```

Expected: the task 1-9 commits flow upstream cleanly.

---

## Notes for the executor

- **Always run the applier through `op_run` or with `|| true` at call sites.** A failed live reload (when rpcrdma is pinned) is expected on re-installs and must not abort the installer chain.
- **Never auto-unmount NFS during installer flow.** The "reboot to activate" hint is intentional. If the user re-runs the installer on a busy box, the patched module is already on disk and next boot picks it up.
- **The shared parser is the single source of truth.** If a future signal (e.g., Userspace RDMA, BeeGFS support) needs to surface in menu OR healthcheck, add it to `_gds_parse_state()` output schema first; both consumers pick it up automatically.
- **Read-only is the default; destructive is opt-in.** `gdsio_smoke` writes ~4 GiB sparse and reads/writes ~25 GiB/s for 10 s. That's why `default.yml` and `hpc-readmostly.yml` skip it.
- **Cache key fragility.** If `/sys/module/rpcrdma/srcversion` doesn't exist (rpcrdma not loaded), fall back to "no-cache" and re-run gdscheck every call. That's slower but always correct.

## References

- Design: `docs/plans/2026-05-11-gds-verification-and-mlnx-nfsrdma-patch-design.md`
- Sibling plan (format model): `docs/plans/2026-05-11-client-healthcheck-nfsrdma-plan.md`
- Memo (written in Task 1): `docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md`
- Test box: `ssh root@172.17.1.151` (password `nvidia`)
