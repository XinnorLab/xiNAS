# Install fails on Ubuntu's virtual kernel flavour (cloud images)

**Found:** 2026-10-19, installing `v3.13.3` with the `xinnorVM` preset on
an Ubuntu 24.04.5 cloud image (runbook §2).
**Affects:** `v3.13.3` and `release/3.14` (the tasks below are unchanged
between them). Any host whose kernel metapackage is `linux-virtual` /
`linux-image-virtual` instead of `linux-generic` / `linux-image-generic`
— every Ubuntu cloud image (checked on the 24.04.5 `noble-server-cloudimg-amd64` image).
**Status:** fix in progress (FEAT-INST-01). Workaround below.

## Symptoms

The installer stops with exit 2 and names the failing role.

1. **`common` fails first:**

   ```text
   Failed to find package 'linux-image-generic' to perform selection 'hold'.
   ```

2. **With that worked around, `doca_ofed` fails:** `openibd.service`
   does not start, and the journal shows

   ```text
   Failed loading kernel module mlx5_ib
   ```

   with this in `dmesg`:

   ```text
   mlx5_ib: Unknown symbol macsec_netdev_is_offloaded (err -2)
   ```

## Cause

The installer assumes the generic kernel flavour in two places:

- `collection/roles/common/tasks/main.yml`, "Hold current Ubuntu kernel":
  `dpkg_selections: name=linux-image-generic selection=hold`. A hold on a
  package that is not installed fails, so the role stops.
- The `doca_ofed` role installs DOCA-Host's DKMS drivers, whose `mlx5_ib`
  needs the `macsec` module. Ubuntu ships `macsec.ko` in
  `linux-modules-extra-<kernel>`, which `linux-image-generic` pulls in and
  `linux-image-virtual` does not.

Both flavours boot the same `-generic` kernel image, so `uname -r` and
`ansible_kernel` do not tell them apart; only the installed metapackages
do.

## Evidence

On the VM (Ubuntu 24.04.5, kernel `6.8.0-142-generic`, DOCA-Host 3.4.0
from the role's pinned directory), 2026-10-19:

| Check | Result |
|-------|--------|
| Kernel metapackages the cloud image ships | `linux-image-virtual`, `linux-virtual` (no `linux-image-generic`) |
| `dpkg -S .../drivers/net/macsec.ko.zst` | `linux-modules-extra-6.8.0-142-generic` |
| `apt-cache depends linux-image-generic` | `linux-image-6.8.0-147-generic`, `linux-modules-extra-6.8.0-147-generic`, `linux-firmware`, microcode |
| `apt-cache depends linux-image-virtual` | `linux-image-6.8.0-147-generic` only |
| `modprobe mlx5_ib` before / after installing `linux-modules-extra-6.8.0-142-generic` | fails with the unknown symbol / loads, and `openibd` starts |

## Workaround

Before installing, on the host:

```bash
sudo apt-get install -y linux-generic "linux-modules-extra-$(uname -r)"
```

`linux-generic` gives the `common` role a `linux-image-generic` to hold.
It also installs the newest kernel with its extra modules, but the running
kernel is unchanged until a reboot. The second package covers the running
kernel, whose extra modules are what DOCA's `mlx5_ib` needs now.

## Hosts already installed

None to repair: on an affected host the install never completed. A host
that completed after the workaround is in the same state as a
generic-flavour host.
