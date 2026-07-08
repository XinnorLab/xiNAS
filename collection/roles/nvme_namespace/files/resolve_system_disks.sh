#!/bin/bash
# Resolve the physical disk(s) that host the OS. See docs/Installer/raid-spec.md §2.
#
# Each OS mount (/, /boot, /boot/efi) is walked *down* the block-device stack to
# the physical disk(s) it is built on, so an LVM (/dev/mapper/...), dm-crypt, MD
# (/dev/mdX), or ZFS (pool/dataset) root resolves to the real disk(s) instead of
# an opaque name. Without this a guided-LVM/ZFS install misclassifies the OS
# disk as a data drive and the cleanup pass wipes it.
#
# Output contract (consumed by resolve_system_disks.yml):
#   line 1        : "root_resolved=1" if the ROOT filesystem mapped to at least
#                   one physical disk, else "root_resolved=0"
#   lines 2..N    : "/dev/<disk>" — the sorted, unique physical disks to protect
#
# A non-empty ESP or /boot can populate the protected set even when root does
# not resolve (e.g. ZFS/iSCSI root); root_resolved lets the caller still fail
# closed in that case.
set -o pipefail

# resolve <mount-source> -> physical whole disks backing it (one per line)
resolve() {
  local src="$1"
  [ -n "$src" ] || return 0
  src="${src%%[*}"   # strip btrfs subvolume annotation: /dev/sda2[/@] -> /dev/sda2
  case "$src" in
    /dev/*)
      # `lsblk -s` renders an inverse *tree*: the NAME column carries box-drawing
      # glyphs even with -n -p. A linear chain glues them to the name
      # ("└─/dev/nvme0n1"); a branching tree (e.g. an MD mirror) also prepends a
      # "│ " continuation field. So TYPE is the last field and NAME is $(NF-1);
      # strip everything before "/dev/" so the caller's '^/dev/' filter keeps
      # every backing disk. See §2.
      lsblk -s -npo NAME,TYPE "$src" 2>/dev/null | awk '$NF == "disk" { print substr($(NF-1), index($(NF-1), "/dev/")) }'
      ;;
    *:/*)
      return 0   # nfs / network root: nothing local to protect
      ;;
    */*)
      # Possibly a ZFS dataset (pool/dataset/...). Resolve the pool's vdevs.
      local pool="${src%%/*}" member
      command -v zpool >/dev/null 2>&1 || return 0
      zpool status -LP "$pool" 2>/dev/null \
        | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^\/dev\//) print $i }' \
        | while IFS= read -r member; do
            lsblk -s -npo NAME,TYPE "$member" 2>/dev/null \
              | awk '$NF == "disk" { print substr($(NF-1), index($(NF-1), "/dev/")) }'
          done
      ;;
    *)
      return 0   # tmpfs / overlay / unknown: nothing to protect
      ;;
  esac
}

root_src="$(findmnt -no SOURCE / 2>/dev/null | head -1)"
root_disks="$(resolve "$root_src" | sort -u)"

if [ -n "$root_disks" ]; then
  echo "root_resolved=1"
else
  echo "root_resolved=0"
fi

{
  printf '%s\n' "$root_disks"
  resolve "$(findmnt -no SOURCE /boot 2>/dev/null | head -1)"
  resolve "$(findmnt -no SOURCE /boot/efi 2>/dev/null | head -1)"
  # Every EFI System Partition by GUID (mirrored ESPs -> protect all backing
  # disks, not just the mounted one).
  lsblk -nrpo NAME,PARTTYPE 2>/dev/null \
    | awk 'tolower($2) == "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" { print $1 }' \
    | while IFS= read -r esp; do resolve "$esp"; done
} | sed '/^$/d' | sort -u
