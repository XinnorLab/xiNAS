# xiNAS

This repository contains scripts and Ansible playbooks used to provision xiNAS nodes.

## Getting started

1. Run `prepare_system.sh` on the target host (use the `-e` option for expert mode). Use `-u` to update the repository without launching any menus. This installs required packages including `yq` version 4, `whiptail`, and Ansible, then clones the repository.
   The script immediately launches a simplified start menu in default mode to enter the license and choose a preset. Use `-e` to access the full interactive menu with additional options such as updating the repository or saving the current configuration as a new preset.
2. Execute `startup_menu.sh` separately if you need the complete configuration menu outside of the expert mode. Any presets you create in expert mode will also be available here and in the simplified menu. It also allows setting a custom hostname.
3. To apply the configuration, choose **Continue** from the menu.
   The playbook will run at that point, executing all configured roles. An **Exit** option is available if you want to leave without running the playbook.
4. To configure an NFS client on another system, run `sudo ./client_setup.sh`. Root
   privileges are required to install packages, create the mount point and mount
   the exported share. If you only need the client pieces, copy the contents of
   the `client_repo` directory into a separate repository and run the script
   from there.

The `prepare_system.sh` script installs dependencies required by the interactive helper scripts. The helper scripts rely on the [`mikefarah/yq`](https://github.com/mikefarah/yq) binary (v4+). If you encounter errors such as `jq: error: env/1 is not defined`, make sure this version of `yq` is installed by re-running `prepare_system.sh` or installing it manually.
Earlier versions of the RAID configuration script failed with `'//' expects 2 args but there is 1` when no spare pool existed. The script now creates the pool automatically the first time you enter devices.
You can inspect all `yq` binaries with `which -a yq`. If multiple paths are listed, reorder your `PATH` so `/usr/local/bin/yq` precedes others or remove the older version entirely.

The `configure_hostname.sh` script updates `/etc/hosts` so that the system's hostname shares the `127.0.0.1` entry with `localhost`.
