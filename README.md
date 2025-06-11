# xiNAS

This repository contains scripts and Ansible playbooks used to provision xiNAS nodes.

## Getting started

1. Run `prepare_system.sh` on the target host. This installs required packages such as `yq`, `whiptail`, Ansible and clones the repository.
2. Execute `startup_menu.sh` to configure network, RAID arrays and NFS exports interactively.
3. Optionally run the included Ansible playbook to apply the configuration.

The `prepare_system.sh` script installs dependencies required by the interactive helper scripts. If you encounter an error like `yq: command not found` when selecting **Configure RAID**, ensure that `prepare_system.sh` has been run or install `yq` manually.
