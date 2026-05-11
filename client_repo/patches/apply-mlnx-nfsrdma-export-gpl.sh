#!/usr/bin/env bash
# Idempotent applier for the mlnx-nfsrdma EXPORT_SYMBOL_GPL fix.
# See: docs/troubleshooting/mlnx-nfsrdma-export-symbol-gpl-bug.md
# Returns 0 for "applied" AND "no-op-not-needed".
# Returns non-zero only on real error (missing dkms, build failure).

set -euo pipefail

PKG="mlnx-nfsrdma-dkms"
LOG_PREFIX="[mlnx-nfsrdma-gds-patch]"
STAMP="/var/lib/xinas/mlnx-nfsrdma-gpl-patch.applied"

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
# Prefer dkms's own view of the installed module version. Fall back to a
# glob only when dkms doesn't know about it (rare, defensive).
VER=$(dkms status mlnx-nfsrdma 2>/dev/null | awk -F'[/,:]' '/^mlnx-nfsrdma\// {print $2; exit}')
if [[ -n "$VER" && -d "/usr/src/mlnx-nfsrdma-$VER" ]]; then
    SRC="/usr/src/mlnx-nfsrdma-$VER"
else
    SRC=$(ls -d /usr/src/mlnx-nfsrdma-*/ 2>/dev/null | tail -1 | sed 's:/$::')
fi
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
    log "ERROR: no /usr/src/mlnx-nfsrdma-*/ directory found."
    exit 1
fi
F="$SRC/nvfs_rpc_rdma.c"
if [[ ! -f "$F" ]]; then
    log "ERROR: $F not present — source layout changed?"
    exit 1
fi

# Derive VER from the source directory basename only if the dkms-status
# lookup above didn't already give us one.
: "${VER:=$(basename "$SRC" | sed 's/^mlnx-nfsrdma-//')}"
KVER=$(uname -r)

# Helper: apply the sed patch to the source file (with backup + verify).
patch_source() {
    local ts bak
    ts=$(date +%Y%m%d%H%M%S)
    bak="$F.xinas-bak.$ts"
    cp -p "$F" "$bak"
    log "Backup: $bak"
    BAK="$bak"

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
}

# Helper: rebuild via DKMS, write the stamp, then live-reload the module.
rebuild_and_stamp() {
    log "DKMS remove mlnx-nfsrdma/$VER (all kernels)..."
    dkms remove "mlnx-nfsrdma/$VER" --all >/dev/null 2>&1 || true

    local logdir="/var/log/xinas"
    mkdir -p "$logdir" 2>/dev/null || logdir="/tmp"
    local logfile="$logdir/mlnx-nfsrdma-dkms.log"

    log "DKMS install mlnx-nfsrdma/$VER for $KVER (log: $logfile)..."
    if ! dkms install "mlnx-nfsrdma/$VER" -k "$KVER" >"$logfile" 2>&1; then
        log "ERROR: DKMS rebuild failed. Tail of $logfile:"
        tail -30 "$logfile" 2>/dev/null | sed "s/^/$LOG_PREFIX     /"
        if [[ -n "${BAK:-}" && -f "$BAK" ]]; then
            log "ERROR: Restoring source and reinstalling original."
            cp -p "$BAK" "$F"
            dkms install "mlnx-nfsrdma/$VER" -k "$KVER" >>"$logfile" 2>&1 || true
        fi
        exit 1
    fi
    log "DKMS install complete. Full log: $logfile"
    log "New srcversion: $(modinfo /var/lib/dkms/mlnx-nfsrdma/$VER/$KVER/*/module/rpcrdma.ko 2>/dev/null | awk '/^srcversion:/ {print $2}' || echo 'unknown')"

    # Write stamp recording that this src_dir + kernel was successfully rebuilt.
    mkdir -p "$(dirname "$STAMP")" 2>/dev/null || true
    {
        echo "src_dir=$(basename "$SRC")"
        echo "kernel=$KVER"
        echo "applied_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$STAMP"
    log "Stamp written: $STAMP"

    # Module reload — best effort, never destructive.
    local refcnt
    refcnt=$(cat /sys/module/rpcrdma/refcnt 2>/dev/null || echo "n/a")
    if [[ "$refcnt" == "0" ]]; then
        log "rpcrdma refcnt=0 — reloading module live."
        # Best-effort live reload. -r and then modprobe are separate steps so we
        # can detect the split-brain case where the unload succeeded but the
        # reload didn't — the box would otherwise be left with no rpcrdma loaded.
        if modprobe -r rpcrdma 2>/dev/null; then
            if modprobe rpcrdma 2>/dev/null; then
                log "Patched rpcrdma is live. gdscheck should now report NFS : nvfs."
            else
                log "ERROR: rpcrdma was unloaded but failed to reload. Module is on"
                log "ERROR: disk but NOT loaded. Run 'modprobe rpcrdma' or reboot."
                exit 1
            fi
        else
            log "WARN: modprobe -r rpcrdma failed (module still loaded). Reboot to activate the fix."
        fi
    else
        log "rpcrdma refcnt=$refcnt (in use) — patched module is on disk."
        log "Reboot to activate the GDS-NFS fix (will NOT auto-unmount NFS)."
    fi
}

# Helper: stamp-file validity check (matches current src_dir + running kernel).
stamp_valid() {
    [[ -f "$STAMP" ]] || return 1
    local stamp_src stamp_kver
    stamp_src=$(awk -F= '/^src_dir=/ {print $2; exit}' "$STAMP")
    stamp_kver=$(awk -F= '/^kernel=/ {print $2; exit}' "$STAMP")
    [[ "$stamp_src" == "$(basename "$SRC")" && "$stamp_kver" == "$KVER" ]]
}

# 3. Decide path based on bug-pattern + stamp state.
if grep -qE '^EXPORT_SYMBOL\((UN)?REGISTER_FUNC\)' "$F"; then
    # Source still has the bug — normal patch + rebuild path.
    patch_source
    rebuild_and_stamp
elif stamp_valid; then
    log "No bug pattern in $F — already patched and stamp confirms rebuild for $KVER. No-op."
    exit 0
else
    # Source is patched but we have no proof the loaded module matches. Could
    # be an interrupted earlier run (source patched, DKMS never finished) or a
    # kernel upgrade since the last rebuild. Force a DKMS rebuild for safety;
    # skip the sed step since the source is already correct.
    log "Source already patched but stamp absent or stale — forcing a DKMS rebuild to ensure the loaded module matches the source."
    rebuild_and_stamp
fi

exit 0
