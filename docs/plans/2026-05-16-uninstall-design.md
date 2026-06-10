# Uninstaller — design notes (2026-05-16)

Companion to [docs/Installer/uninstall-spec.md](../Installer/uninstall-spec.md).
That spec is the contract; this file records the design decisions that led to
it, the alternatives considered, and the trade-offs accepted. Append-only.

## Problem

xiNAS installs across a wide blast radius:

- 13 Ansible roles touching `/opt`, `/etc`, `/usr/local/{bin,sbin}`,
  `/usr/lib`, `/var/{lib,log}`, `/etc/systemd/system`, `/etc/sysctl.d`,
  `/etc/modprobe.d`, `/etc/netplan`, `/etc/default/grub`,
  `/etc/ssh/sshd_config{,.d}`, `/etc/pam.d/login`, `/etc/update-motd.d`,
  `/etc/profile.d`, `/etc/sudoers.d`, `/etc/udev/rules.d`,
  `/etc/cron.d`, plus DKMS modules and three APT repositories.
- A handful of wrapper binaries in `/usr/local/{bin,sbin}`.
- An MCP server, an NFS-helper daemon, a Textual TUI, a config-history
  CLI, a Prometheus exporter — each with its own systemd unit.
- xiRAID arrays, xiRAID spare pools, NVMe namespaces, XFS filesystems
  built on top.
- A typed set of mandatory cleanups vs. three opt-in destructive
  removals (xiRAID, OFED, host perf tuning).

Operators need a supported way to take all of this off again, without
forcing them to read 13 roles to find every artifact. The uninstaller is
the supported way.

## Constraints from the user-provided spec

1. Three optional questions: xiRAID, OFED, perf tunings — all default
   No.
2. xiNAS-specific artifacts must always be removed: packages, NFS
   exports, systemd mounts, MCP helpers, runtime state, history,
   services.
3. Must be idempotent and print a final summary.
4. Must not remove shared system components without explicit consent.

## Decisions

### Entry point: bash wrapper + Ansible playbook + new role

Rejected alternatives:

- **Pure bash.** Lots of conditional `apt`/`systemctl`/`xicli`
  invocations with their own error handling, duplicated from the
  install roles. Hard to keep in sync when roles change.
- **Pure Ansible playbook (no bash wrapper).** The interactive
  prompting (three questions + hostname confirmation) is awkward in
  Ansible. We can do it with `pause`, but ergonomics are poor and the
  TUI shell-out story is worse — Ansible's `pause` requires a TTY in
  exactly the right shape, and the message UX is rigid.
- **A Python module in xinas_menu.** The whole point of uninstall is
  that it must work when the TUI is broken or partially installed; we
  cannot depend on the TUI's venv being usable.

Chosen: bash `uninstall.sh` for prompting + a new
`collection/roles/xinas_uninstall/` for cleanup, invoked through
`playbooks/uninstall.yml`. The bash side does *only* prompts; the role
does all the destructive work. This matches install's split between
`install.sh` (bootstrap + prompts) and `playbooks/site.yml` (work).

### One uninstall role, not per-role cleanup hooks

We considered adding a `tasks/uninstall.yml` to every existing role and
including them with a tag. Rejected because:

- The reverse-dependency ordering is **not** the reverse of the install
  order. Services have to stop before their mounts can unmount; mounts
  have to unmount before the xiRAID arrays underneath can be torn
  down; package purges have to come after the systemd units they own
  are removed. Forcing the install roles to interleave is more
  complex than putting the whole reverse-graph in one place.
- Several install roles share artifacts (e.g. both `xinas_menu` and
  `xinas_history` use `/opt/xiNAS/venv/` and both write to
  `/usr/local/bin/`). Cleaning them in one role is simpler than
  duplicating the "is this still in use?" check across roles.

Trade-off: when a new role is added that installs new artifacts, the
uninstall role must be updated too. The Installer spec map has a row
linking each install role to the uninstall phase that cleans it, so
reviewers can spot a missing entry.

### Always tear down xiRAID arrays, even if xiRAID is being kept

The user-provided spec is explicit that "xiNAS-created" data structures
are always removed. xiRAID arrays named by xiNAS (`data`, `log`,
`*_spare_pool`) are xiNAS-created — the xiRAID *package* is not. So:

- **xiRAID arrays/pools/NS:** always torn down (mandatory cleanup).
- **xiRAID package + repo + DKMS:** only if §3.1 = yes.

The destructive-action banner and the typed-hostname gate both call out
that the data on those arrays goes away.

### Identifying "xiNAS-owned" artifacts

Three layers of identification, in order of confidence:

1. **Marker-bounded blocks.** `/etc/nfs.conf` uses Ansible's
   `blockinfile` marker. We strip the marked block, leaving the rest
   of the file untouched.
2. **Template signatures.** The systemd mount unit template's
   `Description=xiRAID Classic <label>` line is unique enough to
   identify xiNAS-generated mount units without a marker. We scan
   `/etc/systemd/system/*.mount` for that signature.
3. **Exact line match.** For `/etc/ssh/sshd_config` and
   `/etc/pam.d/login`, xiNAS writes a fixed line. We only revert the
   line if its content matches what the install template writes — if
   the operator has hand-edited the line, we leave it and report the
   skip in the summary.

There is no marker in `/etc/exports` today — the entire file is
xiNAS-templated. The role truncates the file to a one-line comment
("cleared by xiNAS uninstall on `<ts>`") rather than deleting it,
because `nfs-kernel-server` expects the file to exist while it is
still installed.

### Default-no, typed-hostname gate

The user spec says "default no" for all three questions. We extend that
to the destructive top-level action — pressing Enter at the
"hostname?" prompt aborts. The typed-hostname pattern is the same one
used by Kubernetes/Terraform "force delete this cluster" UX and is the
strongest reasonable signal that the operator intends the action.

We considered a simple `[y/N]` for the top-level confirm. Rejected —
the action destroys data on `/mnt/data`. A `y` keystroke is too
recoverable.

### Don't run `netplan apply` automatically

`/etc/netplan/99-xinas.yaml` is always removed (it is xiNAS-owned).
But `netplan apply` reconfigures network interfaces and can drop the
operator's SSH session if they are connected through one of the IB
interfaces. The role removes the file and tells the operator in the
summary; they decide when to apply.

### CPU governor: leave alone, document in summary

`cpupower frequency-set -g performance` is not symmetric with any
"restore previous" action — Linux does not record a previous governor
anywhere portable. We considered:

- Snapshotting the governor at install time into
  `/var/lib/xinas/baseline/` so uninstall could restore it.
- Hardcoding `ondemand` as a "reasonable default".

Both add complexity for marginal value. Decision: leave the governor
alone and document the manual step in the summary. The
`xinas-history` baseline already captures install-time state and can be
extended later if we find operators care.

### Apt purge nfs-kernel-server, but not mdadm/xfsprogs

`nfs-kernel-server` and `nfs-common` are xiNAS-specific deployments — a
fresh Ubuntu does not have them. Purging them is consistent with the
mandatory-cleanup intent. `mdadm` and `xfsprogs` are generic system
utilities; even if xiNAS installed them, they are useful to keep. The
summary names them as "left installed" so the operator can decide.

`nodejs` is purged only if xiNAS added the NodeSource APT source — this
is the same "is this xiNAS-installed?" check the role applies to other
"shared" packages.

### Confirmation gate lives in bash, not in Ansible

The `uninstall_confirmed=true` extra-var is the playbook's safety
check. The bash wrapper handles the interactive gate and passes the
flag. Running `ansible-playbook playbooks/uninstall.yml` without the
flag prints a one-line error pointing at `uninstall.sh` and exits
non-zero. This makes the destructive playbook impossible to run
accidentally with a generic "rerun the last command".

### Summary report

We considered emitting the summary from the role itself via Ansible's
`debug` task. Rejected — the role's output is dense, and the summary
is the most important thing the operator sees. The role sets a single
fact (`uninstall_summary`) shaped as:

```json
{
  "removed":   [["Services", "xinas-mcp,xinas-nfs-helper,nfs-server"], ...],
  "preserved": [["xiRAID package", "kept (user declined)"], ...],
  "failed":    [["sshd_config revert", "diverged from template"], ...],
  "manual":    ["Run netplan apply ...", ...],
  "reboot":    false
}
```

The bash wrapper reads the fact via a `local_action` that writes JSON
to `/tmp/xinas-uninstall-summary.json`, then formats it. Keeping the
formatter in bash means the script can show a nicely colored final
report without depending on Python at the end (we just removed
`/opt/xiNAS/venv/`).

## Out of scope

- Rolling back individual xiRAID/RAID/XFS configurations to a previous
  snapshot. That is the `xinas_history` rollback flow, not uninstall.
- Removing third-party stuff xiNAS depends on but didn't install
  (e.g., `chrony` itself, the kernel, the OS). The role keeps a small
  whitelist of packages it considers "xiNAS-deployed" and a strict
  rule against touching anything else.
- Reverting hostname changes. xiNAS sets the hostname at install time
  via the `common` role, but the original hostname is not recorded
  anywhere xiNAS owns. The summary notes that the hostname was changed
  and the operator can revert with `hostnamectl set-hostname`.
