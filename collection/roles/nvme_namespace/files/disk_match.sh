#!/bin/bash
# Boundary-safe block-device membership for the nvme_namespace cleanup path.
# See docs/Installer/raid-spec.md §2/§3.
#
# The cleanup pass must never destroy an LVM VG / MD array / ZFS pool that lives
# on a *protected* OS disk. Naive string-prefix matching is unsafe because a
# data controller "/dev/nvme1" is a string prefix of "/dev/nvme10", so an OS
# partition "/dev/nvme10n1p3" would be dragged into destruction. These helpers
# match on device-name *boundaries* instead, and always veto anything on a
# protected disk.
#
# Sourced by cleanup_storage.yml; also runnable as a CLI for tests:
#   DATA_DRIVES=... SYSTEM_DISKS=... SYSTEM_CTRLS=... disk_match.sh is-data <dev>
#   disk_match.sh belongs <dev> <drive>
# Both exit 0 on match, 1 otherwise.

# belongs <dev> <drive>
#   True when <dev> is <drive> itself or one of its child namespaces/partitions.
#   Boundary rules:
#     nvme controller  /dev/nvme1     -> child /dev/nvme1n<digit>...
#     whole disk       /dev/nvme1n1   -> child /dev/nvme1n1p<digit>...
#     whole disk       /dev/sda        -> child /dev/sda<digit>...
#   A "/dev/nvmeN" + digit sequence (e.g. nvme1 -> nvme10) is rejected: the
#   trailing digit continues the controller number, it is not a child.
belongs() {
  local dev="$1" drive="$2"
  [ -n "$dev" ] && [ -n "$drive" ] || return 1
  [ "$dev" = "$drive" ] && return 0
  case "$dev" in
    "${drive}"n[0-9]*) return 0 ;;   # controller -> namespace
    "${drive}"p[0-9]*) return 0 ;;   # nvme namespace disk -> partition
    "${drive}"[0-9]*)                # sd*/vd* disk -> partition
      case "$drive" in
        *[0-9]) return 1 ;;          # drive ends in a digit: ambiguous, reject
        *) return 0 ;;
      esac
      ;;
  esac
  return 1
}

# is_data_member <dev>
#   True when <dev> belongs to a DATA_DRIVES member AND to no protected member
#   (SYSTEM_DISKS / SYSTEM_CTRLS). The protected veto is checked first so a stale
#   or overlapping data entry can never override OS-disk protection.
is_data_member() {
  local dev="$1" d
  for d in $SYSTEM_DISKS $SYSTEM_CTRLS; do
    belongs "$dev" "$d" && return 1
  done
  for d in $DATA_DRIVES; do
    belongs "$dev" "$d" && return 0
  done
  return 1
}

# CLI dispatch only when executed directly (not when sourced).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "$1" in
    is-data) is_data_member "$2" ;;
    belongs) belongs "$2" "$3" ;;
    *)
      echo "usage: disk_match.sh {is-data <dev>|belongs <dev> <drive>}" >&2
      exit 2
      ;;
  esac
fi
