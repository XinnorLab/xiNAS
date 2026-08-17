# xiNAS Client Setup — Behavior Spec

Owns the behavior contract for the client-side surface shipped in
`client_repo/`: the `xinas-client` menu (`client_setup.sh`) and the
configuration it writes on an NFS client host.

The client health report (`client_repo/client_healthcheck.sh`) reads the
same on-disk state this spec defines; where a check names a file, that file
is defined here.

Related:
- [docs/Installer/update-spec.md](../Installer/update-spec.md) — release-only
  install/update rule, which the client installer follows too.
- `docs/plans/2026-03-23-client-tui-redesign-design.md` — historical redesign
  plan (append-only history of intent, not the live contract).

---

## 1. Scope

| Surface | File | Status |
|---------|------|--------|
| Client menu | `client_repo/client_setup.sh` | Active (bash; the client host has no Python TUI) |
| Client health report | `client_repo/client_healthcheck.sh` | Active |
| Health profiles | `client_repo/client_health_profiles/*.yml` | Active |

The "Python-only for day-2 management" rule in the repo's `CLAUDE.md`
applies to the **server** node. The client package is a standalone bash
deliverable and stays bash.

---

## 2. NFS client tuning drop-ins

### 2.1 The two files

`Install NFS Tools` owns two configuration drop-ins. They are xiNAS-authored
files; nothing else in the client package writes them.

| File | Purpose |
|------|---------|
| `/etc/modprobe.d/nfsclient.conf` | `options nfs …` — session slots, idmapping, retrans, ino64 |
| `/etc/sysctl.d/90-nfs-client.conf` | socket buffer maxima, `vm.swappiness` |

Required content is defined by the `nfs_client` checks in
`client_healthcheck.sh` (`modprobe_conf`, the per-parameter `modprobe *`
checks, and `sysctl_conf`). The health-check expectations and the values
written here are one contract — changing a value means changing both.

### 2.2 The contract

**After `Install NFS Tools` returns, both drop-ins exist — on every path
through the action, including the path where NFS client tools were already
installed.**

This is the whole point of the section. `nfs-common` is present out of the
box on many images, and on those hosts the *only* work `Install NFS Tools`
has left to do is write the drop-ins. A version of the action that reports
"Already Installed" and returns without writing them leaves the host
permanently un-tuned, and puts the user in a loop: the health report says
`[WARN] NFS Client > sysctl_conf → Run installer: Install NFS Tools`, the
installer says "Already Installed", and nothing changes.

### 2.3 Write policy

Applied per file, independently:

| On-disk state | Action | Reported step |
|---------------|--------|---------------|
| Missing | Write the xiNAS content | `create <path>` |
| Present | Leave untouched | `<path> already present` |

A drop-in that exists but carries edited values is **not** rewritten. It is
an admin-owned file once it exists, and silently reverting a deliberate
local tuning change is worse than the drift. Drift is visible: the
per-parameter `modprobe *` checks in the health report compare actual values
against the profile and WARN on a mismatch.

Consequence, accepted deliberately: a stale or hand-broken drop-in is
reported but not auto-repaired. Repair is `rm` the file and re-run
`Install NFS Tools`.

### 2.4 sysctl reload

`sysctl --system` runs only when `/etc/sysctl.d/90-nfs-client.conf` was
created by this invocation. When the file was already present its values are
already live (applied at boot), and an unconditional reload would re-apply
every other drop-in on the host as a side effect of an action that changed
nothing.

### 2.5 Reporting

Both paths report through the same `op_status.sh` frame:

- **Tools missing** — drop-in steps are part of the existing
  `Install NFS Tools` operation, between the package install and
  `op_verify mount.nfs4`.
- **Tools already installed** — when at least one drop-in is missing, the
  action opens its own operation frame so the user sees what was written.
  When both are already present, no frame is opened; the action reports
  "Already Installed" and returns, as before.

`enable_nfs_rdma` continues to run on both paths, unchanged.
