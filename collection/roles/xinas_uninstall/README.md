# xinas_uninstall

Reverses everything `playbooks/site.yml` installs, in reverse-dependency
order. See [docs/Installer/uninstall-spec.md](../../../docs/Installer/uninstall-spec.md)
for the full behavior contract.

## Usage

The role is the back end of `uninstall.sh`. It is not safe to invoke
directly without the bash wrapper's confirmation gate, but it is
supported for automation:

```bash
ansible-playbook playbooks/uninstall.yml \
    -e uninstall_confirmed=true \
    -e uninstall_remove_xiraid=false \
    -e uninstall_remove_ofed=false \
    -e uninstall_revert_perf=false
```

Without `uninstall_confirmed=true` the role refuses to run.

## Variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `uninstall_confirmed` | `false` | Must be `true` for the role to do anything. |
| `uninstall_remove_xiraid` | `false` | Purge xiRAID package, repo, DKMS module. |
| `uninstall_remove_ofed` | `false` | Purge DOCA-Host / OFED packages and repo. |
| `uninstall_revert_perf` | `false` | Remove sysctl/grub/initramfs perf tunings. |

## Phases

Each phase is its own task file under `tasks/`:

| File | Phase |
|------|-------|
| `00_preflight.yml`        | Confirmation, summary fact init. |
| `10_quiesce_services.yml` | Stop MCP + NFS helper; unexport NFS shares. |
| `20_remove_exports.yml`   | Clear `/etc/exports`, remove `/etc/exports.d/xinas-*`. |
| `30_teardown_raid.yml`    | Delete xiRAID arrays + spare pools + drive clean. |
| `40_remove_mounts.yml`    | Stop and remove xiNAS systemd `.mount` units; stop `nfs-server`. |
| `50_remove_services.yml`  | Delete `xinas-mcp` and `xinas-nfs-helper` unit files. |
| `60_remove_binaries.yml`  | Remove `/usr/local/{bin,sbin}/xinas-*` wrappers. |
| `70_remove_paths.yml`     | Remove `/opt/xiNAS`, `/etc/xinas-mcp`, `/usr/lib/xinas-mcp`, `/var/lib/xinas`, `/var/log/xinas`, `/etc/netplan/99-xinas.yaml`, sudoers, motd, cron, sshd drop-in. |
| `80_revert_inplace_edits.yml` | Strip Ansible block from `/etc/nfs.conf`; remove xiNAS `Banner`/`PrintMotd` lines from `sshd_config`; remove xiNAS pam_motd hook from `/etc/pam.d/login`; remove `/etc/sysctl.d/90-roce-lossless.conf`. |
| `90_remove_packages.yml`  | Purge `nfs-kernel-server`, `nfs-common`, and `nodejs` (if xiNAS added NodeSource). |
| `91_optional_xiraid.yml`  | Gated. Purge xiRAID, DKMS-remove module, drop repo. |
| `92_optional_ofed.yml`    | Gated. Run `mlnxofedinstall --uninstall` if present, purge DOCA packages, drop repo + GPG key, remove IB udev rules. |
| `93_optional_perf.yml`    | Gated. Delete sysctl drop-ins, NVMe modprobe drop-in, xiNAS kernel args; `update-grub`, `update-initramfs`, tuned=balanced, re-enable irqbalance, purge perf packages. |
| `99_finalize.yml`         | `daemon-reload`, `apt update`, write summary JSON to `/tmp/xinas-uninstall-summary.json` and a persistent log under `/var/log/`. |

## Output

The role builds a `uninstall_summary` fact and writes it to
`/tmp/xinas-uninstall-summary.json` at the end. `uninstall.sh` reads
this file to print the final colorized report. A persistent
`/var/log/xinas-uninstall-<iso8601>.log` is also written.

## Idempotency

Every step tolerates missing artifacts:

- `state: absent` on file/dir removal.
- `failed_when: false` on `systemctl stop/disable` for missing units.
- `apt purge` ignores "is not installed".
- `xicli raid/pool delete` ignores "not found" / "does not exist".

Running the playbook a second time is safe and produces a summary
report listing everything as "already absent".
