# xiNAS Client

This directory contains only the files required to set up an NFS client for xiNAS.
It can be used as a standalone repository so that client machines do not need the
full xiNAS source.

Included files:

- `client_setup.sh` – interactive script for configuring the client
- `playbooks/doca_ofed_install.yml` – optional Ansible playbook to install DOCA OFED
- `collection/roles/doca_ofed` – Ansible role used by the playbook
- `inventories/lab.ini` – default inventory for running the playbook
- `ansible.cfg` – minimal Ansible configuration

To use this directory as a separate repo, copy it to a new Git repository and run
`client_setup.sh` with root privileges on the client machine:

```bash
sudo ./client_setup.sh
```
