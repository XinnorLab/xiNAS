# Role **doca_ofed**
Installs the NVIDIA DOCA-Host "Everything" profile (`doca-all`) plus the
firmware updater (`mlnx-fw-updater`) from the official DOCA APT repository
on Ubuntu. Defaults to the `latest` repo alias so each run pulls the most
recent DOCA-Host release.

The repo's signing key is fetched from the **component dir's**
`doca_keyring.gpg` (`<doca_repo_base>/<doca_repo_component>/doca_keyring.gpg`, a
binary keyring) into `/etc/apt/trusted.gpg.d/mellanox-doca.gpg`. NVIDIA rotated
the DOCA-Host key to `DC726C5E41B9CC50` (2026-01); the legacy top-level
`GPG-KEY-Mellanox.pub` is stale and does not carry it, which made the former
`apt_key` import fail `apt update` with `NO_PUBKEY`. The key is re-fetched every
run so a future rotation self-heals. (This path is the one verified end-to-end on
DOCA hardware.)

Variables:
  * `doca_version` – release version string. Default `latest` (NVIDIA's
    alias to the most recent release); pin to a specific version
    (e.g. `3.3.0`) or use an LTS alias (e.g. `latest-3.2-LTS`) to lock it.
  * `doca_distro_series` – Ubuntu series used in repository path.
  * `doca_repo_base` – base URL of the DOCA repository.
  * `doca_repo_component` – component path built from version and distro.
  * `doca_pkgs` – list of packages to install. Default: `doca-all`,
    `mlnx-fw-updater`, `mlnx-nfsrdma-dkms` (NFS-RDMA kernel module).
  * `doca_ofed_auto_reboot` – reboot automatically if modules built.

### What NVIDIA documents, and what we determined ourselves

Reconciled 2026-08-14 against the
[DOCA-Host Installation and Upgrade guide](https://networking-docs.nvidia.com/doca/sdk/doca-host-installation-and-upgrade).

**Confirmed by NVIDIA:**
* `doca-all` is a real DOCA-Host installation profile (alongside `doca-ofed`,
  `doca-libvma` and others); the supported profile set per OS is published in
  the guide's *Supported Host OS per DOCA-Host Installation Profile* table.
* `mlnx-fw-updater` is a separate package, installed with its own
  `apt install -y mlnx-fw-updater`.

**[observed] — not documented by NVIDIA:**
* **The repository URL.** The guide's documented path is to download a repo
  `.deb` from NVIDIA DOCA Downloads and `dpkg -i` it; it does **not** publish
  the `linux.mellanox.com/public/repo/doca/<version>/ubuntu<ver>/x86_64`
  layout this role builds by hand, nor the `latest` / `latest-<X.Y>-LTS`
  aliases. Both were determined by browsing the public repo tree and are
  verified working on DOCA hardware — but NVIDIA is free to restructure them
  without it being a documented breaking change.
* **The keyring path and key ID.** The guide only says package managers fetch
  and verify signatures automatically. That the component dir carries a binary
  `doca_keyring.gpg`, that the current key is `DC726C5E41B9CC50`, and that the
  legacy top-level `GPG-KEY-Mellanox.pub` no longer carries it, all come from
  the `NO_PUBKEY` failure and from inspecting the repo.
* **The reboot requirement.** NVIDIA documents a **driver restart**
  (`/etc/init.d/openibd restart`, `mst restart`) after installation, and
  requires a full reboot only for Secure Boot MOK enrollment. xiNAS asks for a
  reboot instead: this role installs DKMS modules (`mlnx-nfsrdma-dkms`) on top
  of a driver stack that may already be in use, and a reboot is the only step
  that reliably brings the whole mlx5/IB stack up on these nodes. That is a
  **xiNAS operational choice**, stricter than NVIDIA's instruction — not an
  NVIDIA requirement, and not something to cite the vendor for.

### References
* [NVIDIA DOCA-Host Installation and Upgrade](https://networking-docs.nvidia.com/doca/sdk/doca-host-installation-and-upgrade)
* NVIDIA Docs – Installing Mellanox OFED on Ubuntu (DKMS)
* DKMS packaging notes for mlnx-ofed-kernel on Ubuntu
