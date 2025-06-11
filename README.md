# xiNAS

This repository contains scripts and Ansible playbooks used to provision xiNAS nodes.

## Getting started

1. Run `prepare_system.sh` on the target host. This installs required packages including `yq` version 4, `whiptail`, and Ansible, then clones the repository.
2. Execute `startup_menu.sh` to configure network, RAID arrays and NFS exports interactively.
3. Optionally run the included Ansible playbook to apply the configuration.

The `prepare_system.sh` script installs dependencies required by the interactive helper scripts. The helper scripts rely on the [`mikefarah/yq`](https://github.com/mikefarah/yq) binary (v4+). If you encounter errors such as `jq: error: env/1 is not defined`, make sure this version of `yq` is installed by re-running `prepare_system.sh` or installing it manually.
