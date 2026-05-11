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
log "Rebuilt. New srcversion: $(modinfo /var/lib/dkms/mlnx-nfsrdma/$VER/$KVER/*/module/rpcrdma.ko 2>/dev/null | awk '/^srcversion:/ {print $2}' || echo 'unknown')"

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
