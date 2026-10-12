---
paths:
  - "collection/**"
  - "playbooks/**"
  - "presets/**"
  - "lib/**"
  - "*.sh"
---

# Installer and role rules

- Roles are idempotent: a re-run over a healthy node must not reformat,
  rebuild namespaces or wipe anything. Destructive paths require
  `xinas_storage_reset: true`.
- Install and update only from published GitHub Releases. Never
  introduce `git pull origin main`, raw-GitHub URLs, branch archives or
  commit fallbacks into a user-facing path.
- Changes to units, packages, sysctl, kernel modules, NFS flags, RAID
  layout or netplan need a `Requires-Rebuild: <role>` trailer on the
  commit.
- IB interface configuration lives only in `/etc/netplan/99-xinas.yaml`.
- Post-install bash menus (`post_install_menu.sh`, `configure_*.sh`) are
  deprecated: bug fixes only; new day-2 features go to `xinas_menu/`.
- Vendor facts (xiRAID, DOCA-OFED, netplan, `nvme-cli`, XFS, nfsd) are
  cited from vendor documentation with URL and version in the spec.
