# Role **doca_ofed**
Installs NVIDIA DOCA-OFED stack (e.g., 24.07-0.6.1.0) on Ubuntu 24.04 using
DKMS so that kernel modules survive future kernel updates.

Variables:
  * `doca_ofed_version`         – upstream version string.
  * `doca_ofed_components`      – list of APT packages to install.
  * `doca_ofed_auto_reboot`     – reboot automatically if modules built.

### References
* NVIDIA Docs – Installing Mellanox OFED on Ubuntu (DKMS)
* DOCA-OFED installation guide (ConnectX-7)
* DKMS packaging notes for mlnx-ofed-kernel on Ubuntu
