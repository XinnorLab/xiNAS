# xiNAS Uninstaller Specification

This document describes the supported way to remove xiNAS from a target host:
the user prompts, the cleanup steps, what is always removed, what is only
removed on explicit confirmation, and the guarantees the uninstaller must
provide.

The uninstaller is the inverse of the install flow described in
[Installer/spec.md](./spec.md). Where install layers `common → doca_ofed →
… → motd`, uninstall walks the same artifacts and removes them in
**reverse dependency order**: services first, then mounts, then storage,
then files, then packages, then host-level tunings (if requested).

Source layout this spec is paired with:

- Entry script: [uninstall.sh](../../uninstall.sh)
- Playbook: [playbooks/uninstall.yml](../../playbooks/uninstall.yml)
- Role: [collection/roles/xinas_uninstall/](../../collection/roles/xinas_uninstall)
- TUI entry: Management → "Uninstall xiNAS" in [xinas_menu/screens/management.py](../../xinas_menu/screens/management.py)

---

## 1. Goals and non-goals

### 1.1 Goals

- Remove every artifact xiNAS installs on a host (binaries, services,
  configs, state, logs, kernel-module DKMS entries, repo + GPG keys it
  added, the cloned repo at `/opt/xiNAS`).
- Keep shared system components (xiRAID, Mellanox OFED, host performance
  tunings) untouched **unless** the operator explicitly opts in.
- Be safely runnable more than once (idempotent), and safe to run after
  a partial install — missing artifacts are reported as "already absent",
  never as errors.
- Print a final, auditable summary of what was removed, what was kept,
  what failed, and whether a reboot is recommended.

### 1.2 Non-goals

- Restoring distribution defaults that pre-existed xiNAS (e.g. the user's
  pre-existing `chrony.conf` content, original `vm.swappiness` value).
  When xiNAS reverts a tuning, it removes the xiNAS-managed file or
  block; it does not attempt to reconstruct a "factory" baseline.
- Removing data on xiRAID arrays without consent. The mandatory cleanup
  unmounts xiNAS-managed XFS filesystems and tears down the xiNAS-created
  xiRAID arrays; this destroys the data on those arrays. The uninstaller
  must clearly warn about this and require a typed confirmation before
  proceeding (see §5).
- Uninstalling xiNAS from a remote node. The uninstaller runs against
  `inventory_hostname=localhost` only (same model as the installer
  menus).

---

## 2. Entry points

### 2.1 `uninstall.sh` (primary)

A top-level bash script at the repo root, parallel to
[install.sh](../../install.sh). It:

1. Verifies it is running as root and that
   `/opt/xiNAS/playbooks/uninstall.yml` exists.
2. Prints the destructive-action banner and the mandatory-cleanup list.
3. Asks the three optional-removal questions (§3), defaulting to **No**.
4. Asks the typed confirmation gate (§5).
5. Invokes `ansible-playbook playbooks/uninstall.yml` with the three
   answers passed as extra-vars:

   ```bash
   ansible-playbook playbooks/uninstall.yml \
       -e uninstall_remove_xiraid=<true|false> \
       -e uninstall_remove_ofed=<true|false> \
       -e uninstall_revert_perf=<true|false> \
       -e uninstall_confirmed=true
   ```

6. Captures the playbook's structured summary fact and prints the final
   §8 report.

#### 2.1.1 Non-interactive flags

| Flag | Meaning |
|------|---------|
| `--remove-xiraid` | Sets `uninstall_remove_xiraid=true`. |
| `--remove-ofed` | Sets `uninstall_remove_ofed=true`. |
| `--revert-perf-tuning` | Sets `uninstall_revert_perf=true`. |
| `--yes`, `-y` | Skip the typed confirmation. Optional flags still default to false unless their own flag was passed. |
| `--dry-run` | Run the playbook with `--check` and `--diff`; no changes are applied. |
| `--help`, `-h` | Print usage and exit. |

When `--yes` is **not** passed, the script always shows the destructive
banner and the typed-confirmation gate, even if all three optional
removal flags were supplied via the command line.

### 2.2 TUI entry: Management → Uninstall xiNAS

The Textual Management screen
([xinas_menu/screens/management.py](../../xinas_menu/screens/management.py))
adds a new entry **"Uninstall xiNAS"** under Management. It does not run
the cleanup in-process. It shells out to:

```
sudo /opt/xiNAS/uninstall.sh
```

after pushing the TUI to a `screen.suspend()` block. This keeps the
running TUI from disappearing under itself when its own files are being
removed and lets the user see the full bash output.

If `/opt/xiNAS/uninstall.sh` is missing (older deploys), the menu shows
a notification telling the user to `git pull` first.

### 2.3 Direct playbook invocation

The playbook is fully usable standalone:

```bash
ansible-playbook playbooks/uninstall.yml \
    -e uninstall_remove_xiraid=true \
    -e uninstall_remove_ofed=false \
    -e uninstall_revert_perf=true \
    -e uninstall_confirmed=true
```

`uninstall_confirmed=true` is **required**. Running the playbook without
it fails preflight with a clear message pointing at `uninstall.sh`.

---

## 3. User prompts

The bash entry asks exactly three questions, in this order. The default
answer for every question is **No**.

### 3.1 Remove xiRAID

```
Do you want to remove the xiRAID package from this system? [y/N]
```

- **Yes** → role removes `/etc/xiraid/`, `apt purge xiraid-core
  xiraid-exporter`, removes the xiRAID APT repo file and its GPG key,
  and runs `dkms remove xiraid --all`.
- **No** → none of the above. The xiRAID kernel module, `xicli`, the
  Xinnor APT repository, and `/etc/xiraid/` are left in place exactly as
  the user had them. xiRAID arrays that xiNAS created are still torn
  down as part of the mandatory cleanup (see §4.3) — that step is about
  the **arrays**, not about the xiRAID package.

### 3.2 Remove Mellanox OFED

```
Do you want to remove Mellanox OFED from this system? [y/N]
```

- **Yes** → role purges `doca-all`, `mlnx-fw-updater`, and
  `mlnx-nfsrdma-dkms`; if `/usr/sbin/mlnxofedinstall` is present, run
  `mlnxofedinstall --uninstall --force` first (it is the supported way to
  remove a DOCA-Host install). Removes the DOCA APT repo file and the
  Mellanox GPG key. Removes `/etc/udev/rules.d/70-ib-names.rules` and
  `/usr/local/sbin/configure_ib_udev.sh`.
- **No** → none of the above. `mlx5_core`, `rpcrdma`, the DOCA APT
  source, and the InfiniBand udev rules stay in place. The
  `/etc/netplan/99-xinas.yaml` file is still removed (it is xiNAS-owned
  network config, not OFED), but `netplan apply` is **not** run — the
  user is told to run it manually if they want the IB addresses to drop.

### 3.3 Revert OS-level performance optimizations

```
Do you want to remove OS-level performance optimizations applied by xiNAS? [y/N]
```

- **Yes** → role removes the following xiNAS-managed tunings:
  - Delete `/etc/sysctl.d/90-perf-vm.conf` and
    `/etc/sysctl.d/90-roce-lossless.conf`.
  - Delete `/etc/modprobe.d/nvme.conf` (the xiNAS NVMe `poll_queues`
    line). Run `update-initramfs -u -k all`.
  - Strip the xiNAS-added kernel arguments from
    `/etc/default/grub`: `intel_idle.max_cstate=0`,
    `transparent_hugepage=never`, and the `mitigations=off …` block.
    Run `update-grub`.
  - `tuned-adm profile balanced` (or stop+disable `tuned` if the
    operator never had it before — the role records `tuned`'s prior
    enable state from `xinas_history` if available and uses
    `balanced` otherwise).
  - Re-enable `irqbalance` (`systemctl enable --now irqbalance`).
  - `sysctl --system` to reload the remaining system sysctls (this
    reverts the network/SunRPC values the `perf_tuning` role applied
    via direct `sysctl` — they survive the file deletion until the
    next `sysctl --system` or reboot, which the role triggers
    explicitly).
  - The role does **not** re-run `cpupower` to flip the CPU governor
    back. The governor revert is documented as a "manual step" in
    the final summary because there is no portable "previous
    governor" record.
- **No** → none of the above. All performance tunings stay in place.

The role applies the optional removals **after** the mandatory cleanup
finishes, in the order: xiRAID → OFED → perf. This ordering is
deliberate — xiRAID and OFED removal both touch DKMS state and may need
the initramfs rebuilt, so it is more efficient to do them before the
final `update-initramfs`/`update-grub` triggered by the perf revert.

---

## 4. Mandatory cleanup

Regardless of how the operator answered §3, the following always runs.
The steps are grouped by **phase**. Within a phase, ordering is fixed.
The role records every step's outcome in a `uninstall_summary` fact for
the §8 report.

### 4.1 Phase A — quiesce services

1. `systemctl stop xinas-mcp xinas-nfs-helper` (best-effort).
2. `systemctl disable xinas-mcp xinas-nfs-helper` (best-effort).
3. `exportfs -ua` (best-effort) — unexports all NFS shares so the
   kernel server is no longer serving xiNAS data while we tear down the
   filesystems.

xiNAS does not stop `nfs-server` here. That happens in phase D, after
mountpoints are gone.

### 4.2 Phase B — remove NFS exports

1. Replace `/etc/exports` with a comment-only file: the entire current
   content is xiNAS-templated (see
   [exports/templates/exports.j2](../../collection/roles/exports/templates/exports.j2)),
   so it is safe to truncate to a single header line:

   ```
   # /etc/exports - cleared by xiNAS uninstall on <timestamp>
   ```

   If the operator wants a true distribution default, they can delete
   the file. The uninstaller leaves the header so the file's `mtime`
   reflects the removal.
2. Remove any `/etc/exports.d/xinas-*.conf` files if present (none are
   produced by the current install, but the spec is conservative
   against future drop-ins).
3. `exportfs -r` to reload.

### 4.3 Phase C — tear down xiRAID arrays and namespaces

1. Read xiNAS-managed array and pool names. Preferred source:
   `xinas-history snapshot show baseline --json` (the install baseline
   records the `xiraid_arrays` and `xiraid_spare_pools` it created).
   Fallback: `xicli raid show -f json` and `xicli pool show -f json`,
   then match against the names xiNAS uses (`data`, `log`,
   `*_spare_pool`).
2. For every array found in (1): `xicli raid destroy -n <name> --force`.
3. For every pool found in (1): `xicli pool delete -n <name>`.
4. For every NVMe device that backed an array: `xicli drive clean -d
   <device>` (best-effort).
5. Rebuild NVMe namespaces to a single full-size namespace only **if**
   the operator opted into xiRAID removal **and** the install baseline
   recorded that xiNAS rebuilt the namespaces. Otherwise leave NVMe
   namespaces alone (the operator may want to keep the n1/n2 split
   for their own xiRAID setup after uninstall).

If `xicli` is not on `PATH` (e.g. xiRAID was already removed in a prior
run), the whole phase is skipped with a "xicli not present, skipping"
note in the summary.

### 4.4 Phase D — remove xiNAS mounts

1. For every `*.mount` unit in `/etc/systemd/system/` whose
   `Description=` starts with `xiRAID Classic` plus a trailing space (the template signature
   from
   [raid_fs/templates/mount.unit.j2](../../collection/roles/raid_fs/templates/mount.unit.j2)):
   - `systemctl stop <unit>`
   - `systemctl disable <unit>`
   - Remove the unit file.
2. Stop and disable `nfs-server.service`.
3. `systemctl daemon-reload`.

The role does **not** edit `/etc/fstab` — xiNAS never writes to it.

### 4.5 Phase E — remove xiNAS services and helpers

1. Remove unit files:
   - `/etc/systemd/system/xinas-mcp.service`
   - `/etc/systemd/system/xinas-nfs-helper.service`
2. Remove the runtime socket dir `/run/xinas-nfs-helper/` if present
   (systemd usually does this on stop, but we want to be explicit on
   partial-state systems).
3. `systemctl daemon-reload`.

### 4.6 Phase F — remove wrapper binaries

Remove the following files if they exist:

- `/usr/local/bin/xinas-mcp`
- `/usr/local/bin/xinas-menu`
- `/usr/local/bin/xinas-setup`
- `/usr/local/bin/xinas-history`
- `/usr/local/bin/xinas-status`
- `/usr/local/bin/xinas-generate-banner`
- `/usr/local/sbin/xinas-update-git`

### 4.7 Phase G — remove xiNAS config, state, and library paths

Remove the following directories (recursive, idempotent):

- `/etc/xinas-mcp/` — MCP config + audit log dir
- `/usr/lib/xinas-mcp/` — NFS helper library
- `/var/lib/xinas/` — config-history store and any future xiNAS state
- `/var/log/xinas/` — MCP audit log, healthcheck logs
- `/etc/netplan/99-xinas.yaml` — xiNAS-owned netplan file (the role
  does **not** run `netplan apply`; see §6)
- `/etc/sudoers.d/xinas-update`
- `/etc/profile.d/99-xinas-menu.sh`
- `/etc/update-motd.d/99-xinas-status`
- `/etc/issue.net` — only if `grep -q "Managed by xiNAS" /etc/issue.net`
  matches; otherwise leave it.
- `/etc/cron.d/xinas-banner` (the banner-refresh cron, when present)
- `/etc/apt/apt.conf.d/20auto-upgrades` is **not** removed (it is a
  stock Ubuntu file that xiNAS only templates; leaving it preserves
  the existing unattended-upgrades behavior).
- `/etc/ssh/sshd_config.d/10-xinas-root-access.conf` is **always
  removed** — it is xiNAS-specific and the operator may not want
  root-key SSH after xiNAS is gone. Reload sshd at the end of this
  phase.
- `/root/.claude/mcp_servers.json` — only if it contains the xiNAS MCP
  server entry **and** removing the xiNAS entry leaves the file empty;
  in that case delete the file. Otherwise, leave the file but strip the
  xiNAS entry (the file is JSON, so the role uses a small in-tree
  Python helper).

### 4.8 Phase H — revert in-place config edits

These are config files xiNAS does not own outright but has appended to.
All blocks are bounded by markers so the revert is precise.

| File | Marker | Action |
|------|--------|--------|
| `/etc/nfs.conf` | `# BEGIN ANSIBLE managed section – nfs_server role` / `# END …` | Remove the marked block. |
| `/etc/ssh/sshd_config` | (no marker — see below) | Remove the lines `PrintMotd no`, `UsePAM yes`, and `Banner /etc/issue.net` **only if their content matches what xiNAS writes**. Reload sshd. |
| `/etc/pam.d/login` | (no marker — see below) | Remove the line `session optional pam_motd.so motd=/run/motd.dynamic`. |
| `/etc/default/grub` | (no marker — see below) | Only touched if the operator opted into perf revert (§3.3). |

For the marker-less files, the role only touches lines that are
verbatim what the xiNAS install templates write. If the operator has
hand-edited the line (e.g. changed `Banner /etc/issue.net` to
`Banner /etc/my-banner`), the original line is left in place and the
revert is reported as "skipped — file diverged" in the summary.

### 4.9 Phase I — remove xiNAS-deployed system packages

This step is mandatory because these packages are part of the xiNAS
deployment, not pre-existing system state:

- `apt purge nfs-kernel-server nfs-common`
- `apt purge nodejs` **only if** `/etc/apt/sources.list.d/nodesource.list`
  (or equivalent) is present — i.e. xiNAS installed Node.js. Skip if
  the system had Node.js from another source.
- `apt purge cpufrequtils linux-tools-common linux-tools-generic tuned`
  **only if** the operator opted into perf revert (§3.3); these were
  installed by `perf_tuning`.
- `apt purge mdadm xfsprogs` is **not** done by default. These are
  generic Linux utilities; many users want them around. The summary
  notes them as "left installed".

After package removal: `apt autoremove --purge -y`.

### 4.10 Phase J — final daemon reloads

1. `systemctl daemon-reload`
2. `systemctl reload ssh` (if it is still installed)
3. `sysctl --system`

---

## 5. Confirmation gate

Before any phase runs, `uninstall.sh` displays:

```
This will permanently remove xiNAS from this host.

This permanently destroys data and CANNOT be undone.

Mandatory cleanup includes:
  - Stopping and removing the xiNAS MCP server and NFS helper
  - Removing NFS exports created by xiNAS
  - Unmounting and removing xiRAID Classic arrays + XFS filesystems
    (THIS PERMANENTLY DESTROYS THE DATA ON /mnt/data AND ANY OTHER xiNAS-MANAGED MOUNT)
  - Removing the /opt/xiNAS source tree
  - Removing xiNAS history at /var/lib/xinas/config-history

Optional removals (your answers above):
  - Remove xiRAID:            <yes|no>
  - Remove Mellanox OFED:     <yes|no>
  - Revert OS perf tuning:    <yes|no>

To proceed, type this host's hostname (<HOSTNAME>):
>
```

The operator must type the literal hostname (read from
`/etc/hostname`). If they type anything else, abort with exit code `2`
and make no changes.

`--yes` skips the typed gate but still prints the banner.

---

## 6. Safety requirements

1. **No surprise package removal.** The script never removes
   `xiraid-core`, any `doca-*` / `mlnx-*` package, `tuned`, or any other
   package, until the matching §3 answer is "yes".
2. **No surprise network outage.** The role removes
   `/etc/netplan/99-xinas.yaml` but never calls `netplan apply`. The
   final summary tells the operator to run `netplan apply` to release
   the stale IPs and PBR rules.
3. **Data warning.** The destructive-action banner in §5 calls out the
   array teardown explicitly. The typed-hostname gate is required.
4. **Default no.** Every §3 question defaults to **No**. A bare
   `<Enter>` keeps the optional component installed.

---

## 7. Idempotency requirements

1. Every step that targets a file uses Ansible's `state: absent` or
   the equivalent shell-level "remove if exists" pattern. Re-running on
   a clean system must not fail.
2. Every `systemctl stop`/`disable` is wrapped to tolerate "unit not
   loaded" / "unit does not exist" without failing.
3. Every `apt purge` is wrapped to tolerate "package not installed"
   (`failed_when: rc != 0 and 'is not installed' not in stderr`).
4. xiRAID array/pool deletion is wrapped to tolerate "no such array".
5. The §5 confirmation gate runs on every invocation; idempotency does
   not extend to skipping confirmation on subsequent runs.

---

## 8. Final summary

After the playbook returns, `uninstall.sh` prints a structured report:

```
xiNAS uninstall complete

Removed:
  ✓ Services: xinas-mcp, xinas-nfs-helper, nfs-server
  ✓ Mounts:   mnt-data.mount, mnt-log.mount
  ✓ Arrays:   data, log
  ✓ Pools:    data_spare_pool
  ✓ Exports:  /etc/exports (cleared)
  ✓ Wrappers: xinas-mcp, xinas-menu, xinas-setup, xinas-history,
              xinas-status, xinas-generate-banner, xinas-update-git
  ✓ Paths:    /opt/xiNAS, /etc/xinas-mcp, /usr/lib/xinas-mcp,
              /var/lib/xinas, /var/log/xinas,
              /etc/netplan/99-xinas.yaml,
              /etc/sudoers.d/xinas-update,
              /etc/ssh/sshd_config.d/10-xinas-root-access.conf
  ✓ Packages: nfs-kernel-server, nfs-common, nodejs

Preserved (you said no, or xiNAS does not own them):
  · xiRAID package and /etc/xiraid (kept)
  · Mellanox OFED / DOCA-Host (kept)
  · OS performance tunings (kept)
  · mdadm, xfsprogs (kept — generic system utilities)

Failed:
  (none) | <task name>: <short reason>

Manual actions you may want to take:
  · Run `netplan apply` to release xiNAS-managed IPs from your NICs.
  · CPU governor is still set to `performance`. Set it back with
    `cpupower frequency-set -g ondemand` if you prefer.
  · /etc/exports has been cleared. Delete the file if you want to
    return to a system without an /etc/exports.

Reboot recommended: <yes|no>
```

"Reboot recommended" is **yes** when any of:

- The operator opted into OFED removal (kernel modules were removed).
- The operator opted into perf revert (grub args, initramfs changed).
- A DKMS module was uninstalled.

Otherwise **no**.

The summary is also written to
`/var/log/xinas-uninstall.<timestamp>.log` (the only log file the
uninstaller leaves on the host — the `/var/log/xinas/` directory has
been removed by then).

---

## 9. Final state guarantees

After a successful `uninstall.sh` run, the following must be true:

| Property | Status |
|----------|--------|
| `systemctl list-units --all 'xinas-*'` returns no units | ✓ |
| `dpkg -l \| grep -E 'xinas\|xiraid-exporter'` returns nothing | ✓ |
| `ls /opt/xiNAS` returns "no such file or directory" | ✓ |
| `ls /etc/xinas-mcp /usr/lib/xinas-mcp /var/lib/xinas /var/log/xinas` returns "no such file or directory" | ✓ |
| `which xinas-menu xinas-mcp xinas-history` returns nothing | ✓ |
| `cat /etc/exports` is empty / single comment line | ✓ |
| `xicli raid show -f json` lists no xiNAS-named arrays | ✓ |
| `xicli` is present iff `uninstall_remove_xiraid=false` | ✓ |
| `lsmod \| grep mlx5_core` returns iff `uninstall_remove_ofed=false` | ✓ |
| `/etc/sysctl.d/90-perf-vm.conf` exists iff `uninstall_revert_perf=false` | ✓ |
| `/etc/default/grub` xiNAS args removed iff `uninstall_revert_perf=true` | ✓ |

If any guarantee is not met, the §8 summary's "Failed" section names
the step and the operator can re-run the script — the second run is a
no-op for the steps that already succeeded.
