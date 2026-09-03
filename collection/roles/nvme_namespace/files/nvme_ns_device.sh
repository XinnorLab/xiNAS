#!/bin/bash
# Resolve NVMe namespace block devices by identity — controller serial + NSID —
# never by the nvmeXnY name. See docs/Installer/raid-spec.md §4.5.
#
# The Y in nvmeXnY is the kernel's per-subsystem namespace-head *instance*
# (ida_alloc_min(&subsys->ns_ida, 1, ...) in drivers/nvme/host/core.c), not
# the NSID. After the rebuild's delete-ns/create-ns cycle the old head can still
# hold instance 1 when the new NSID 1 is scanned, so it comes up as nvme10n2
# and the large NSID 2 as nvme10n3 (observed on every data controller of
# xinas-box, 2026-09-03). xiRAID keys its members on
# "<ID_SERIAL_SHORT>_<NAMESPACE_ID>" (xiraid-core 4.4.1,
# /usr/lib/xraid/drive/v2/nvme.py) and looks the block device up at runtime;
# this helper does the same lookup from sysfs, with no udev/nvme-cli dependency.
#
# Usage:
#   nvme_ns_device.sh list <ctrl>                   "<nsid> /dev/<dev> <serial>_<nsid>" per namespace, ascending NSID
#   nvme_ns_device.sh resolve <ctrl> <nsid>         "/dev/<dev>"; exit 1 when no such namespace is up
#   nvme_ns_device.sh wait <ctrl> <nsid> [timeout]  like resolve, polling once a second (default 30 s)
#
# <ctrl> is the controller, as /dev/nvme10 or nvme10. Exit 2 when the
# controller is unknown or the arguments are malformed. SYSFS_ROOT / DEV_ROOT
# (default /sys, /dev) let the unit tests point the resolver at a fake tree.

set -u

SYSFS_ROOT="${SYSFS_ROOT:-/sys}"
DEV_ROOT="${DEV_ROOT:-/dev}"

usage() {
  echo "usage: nvme_ns_device.sh {list <ctrl>|resolve <ctrl> <nsid>|wait <ctrl> <nsid> [timeout]}" >&2
  exit 2
}

# read_attr <file>: print a sysfs attribute with surrounding whitespace removed
# (the serial attribute is space-padded to its NVMe field width). Fails when
# the attribute is missing, unreadable or empty — entries vanish mid-scan
# during a rescan, and that must not abort the whole enumeration.
read_attr() {
  local v
  v=$(cat "$1" 2>/dev/null) || return 1
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}

# ctrl_serial <ctrl>: the controller's serial, the same attribute udev turns
# into ID_SERIAL_SHORT. Fails when the controller does not exist.
ctrl_serial() {
  read_attr "$SYSFS_ROOT/class/nvme/${1##*/}/serial"
}

# ns_candidates <ctrl>: every visible namespace block device carrying the
# controller's serial, as "<nsid> <dev> <parent>" (unsorted). <parent> is the
# basename of the block device's `device` link — the controller without
# kernel multipath, the nvme-subsysN device with it (both carry `serial`).
ns_candidates() {
  local ctrl="${1##*/}" serial dir dev nsid dev_serial hidden parent
  serial=$(ctrl_serial "$ctrl") || return 2
  for dir in "$SYSFS_ROOT"/block/nvme[0-9]*n[0-9]*; do
    [ -d "$dir" ] || continue
    dev="${dir##*/}"
    nsid=$(read_attr "$dir/nsid") || continue
    [[ "$nsid" =~ ^[0-9]+$ ]] || continue
    dev_serial=$(read_attr "$dir/device/serial") || continue
    [ "$dev_serial" = "$serial" ] || continue
    # Multipath path devices (nvme10c10n2) are hidden gendisks: no /dev node.
    hidden=$(read_attr "$dir/hidden") || hidden=0
    [ "$hidden" = "0" ] || continue
    [ -e "$DEV_ROOT/$dev" ] || continue
    parent=$(readlink "$dir/device" 2>/dev/null) || parent=""
    printf '%s %s %s\n' "$nsid" "$dev" "${parent##*/}"
  done
}

# ns_table_sorted <ctrl>: one "<nsid> <dev>" line per NSID, ascending. When
# two controllers share a serial (dual-port drive, multipath off) the device
# whose parent is the requested controller wins; ties break on the device name.
ns_table_sorted() {
  local ctrl="${1##*/}" cands
  cands=$(ns_candidates "$ctrl") || return $?
  printf '%s\n' "$cands" | awk -v c="$ctrl" 'NF == 3 { print $1, ($3 == c) ? 0 : 1, $2 }' \
    | sort -k1,1n -k2,2n -k3,3 \
    | awk '!seen[$1]++ { print $1, $3 }'
}

list_ns() {
  local ctrl="${1##*/}" serial table nsid dev
  serial=$(ctrl_serial "$ctrl") || {
    echo "nvme_ns_device.sh: controller $ctrl not found under $SYSFS_ROOT/class/nvme" >&2
    return 2
  }
  table=$(ns_table_sorted "$ctrl") || return $?
  while read -r nsid dev; do
    [ -n "$dev" ] || continue
    printf '%s %s/%s %s_%s\n' "$nsid" "$DEV_ROOT" "$dev" "$serial" "$nsid"
  done <<< "$table"
}

# resolve_ns <ctrl> <nsid>: print the block device path; 1 when the namespace
# is not up, 2 when the controller is unknown.
resolve_ns() {
  local ctrl="${1##*/}" want="$2" table nsid dev
  ctrl_serial "$ctrl" > /dev/null || {
    echo "nvme_ns_device.sh: controller $ctrl not found under $SYSFS_ROOT/class/nvme" >&2
    return 2
  }
  table=$(ns_table_sorted "$ctrl") || return $?
  while read -r nsid dev; do
    [ -n "$dev" ] || continue
    if [ "$nsid" = "$want" ]; then
      printf '%s/%s\n' "$DEV_ROOT" "$dev"
      return 0
    fi
  done <<< "$table"
  return 1
}

wait_ns() {
  local ctrl="${1##*/}" nsid="$2" timeout="$3" deadline dev rc
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    dev=$(resolve_ns "$ctrl" "$nsid")
    rc=$?
    if [ $rc -eq 0 ]; then
      printf '%s\n' "$dev"
      return 0
    fi
    [ $rc -eq 2 ] && return 2
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 1
  done
  echo "nvme_ns_device.sh: no block device for NSID $nsid on $ctrl (serial $(ctrl_serial "$ctrl")) after ${timeout}s;" \
    "namespaces seen: $(list_ns "$ctrl" 2>/dev/null | tr '\n' ';')" >&2
  return 1
}

case "${1:-}" in
  list)
    [ $# -eq 2 ] || usage
    list_ns "$2"
    ;;
  resolve)
    [ $# -eq 3 ] || usage
    [[ "$3" =~ ^[0-9]+$ ]] || usage
    resolve_ns "$2" "$3"
    ;;
  wait)
    [ $# -ge 3 ] && [ $# -le 4 ] || usage
    [[ "$3" =~ ^[0-9]+$ ]] || usage
    [[ "${4:-30}" =~ ^[0-9]+$ ]] || usage
    wait_ns "$2" "$3" "${4:-30}"
    ;;
  *)
    usage
    ;;
esac
