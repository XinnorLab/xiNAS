# Role **doca_ofed**
Installs the NVIDIA DOCA-Host "Everything" profile (`doca-all`) plus the
firmware updater (`mlnx-fw-updater`) from the official DOCA APT repository
on Ubuntu. Defaults to the `latest` repo alias so each run pulls the most
recent DOCA-Host release.

The repo's signing key is fetched from the **component dir's**
`doca_keyring.gpg` (`<doca_repo_base>/<doca_repo_component>/doca_keyring.gpg`)
into `/usr/share/keyrings/` and pinned via `signed-by` on the repo line. NVIDIA
rotated the DOCA-Host key to `DC726C5E41B9CC50` (2026-01-20); the legacy
top-level `GPG-KEY-Mellanox.pub` is stale and does not carry it, which made the
former `apt_key` import fail `apt update` with `NO_PUBKEY`. The key is
re-fetched every run so a future rotation self-heals.

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

### References
* NVIDIA Docs – Installing Mellanox OFED on Ubuntu (DKMS)
* DOCA-OFED installation guide (ConnectX-7)
* DKMS packaging notes for mlnx-ofed-kernel on Ubuntu
