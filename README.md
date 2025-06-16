# xiNAS

This repository contains scripts and Ansible playbooks used to provision xiNAS nodes.

## Getting started

1. Run `prepare_system.sh` on the target host (use the `-e` option for expert mode). This installs required packages including `yq` version 4, `whiptail`, and Ansible, then clones the repository.
   The script immediately launches a simplified start menu in default mode to enter the license and choose a preset. Use `-e` to access the full interactive menu and additional options such as updating the repository.
2. Execute `startup_menu.sh` separately if you need the complete configuration menu outside of the expert mode.
3. Optionally run the included Ansible playbook to apply the configuration.

The `prepare_system.sh` script installs dependencies required by the interactive helper scripts. The helper scripts rely on the [`mikefarah/yq`](https://github.com/mikefarah/yq) binary (v4+). If you encounter errors such as `jq: error: env/1 is not defined`, make sure this version of `yq` is installed by re-running `prepare_system.sh` or installing it manually.
