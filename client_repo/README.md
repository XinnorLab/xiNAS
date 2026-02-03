# xiNAS Client

This directory contains only the files required to set up an NFS client for xiNAS.
It can be used as a standalone repository so that client machines do not need the
full xiNAS source.

## Included Files

- `client_setup.sh` – interactive script for configuring the client
- `playbooks/doca_ofed_install.yml` – optional Ansible playbook to install DOCA OFED
- `collection/roles/doca_ofed` – Ansible role used by the playbook
- `inventories/lab.ini` – default inventory for running the playbook
- `ansible.cfg` – minimal Ansible configuration

## Quick Start

To use this directory as a separate repo, copy it to a new Git repository and run
`client_setup.sh` with root privileges on the client machine. If you elect to
install DOCA OFED via the included playbook, the script will install the required
Ansible packages automatically:

```bash
sudo ./client_setup.sh
```

## CLI Options

```
sudo ./client_setup.sh [OPTIONS]

Options:
  --status, -s              Show current NFS mounts
  --mount, -m SERVER MOUNT  Quick mount NFS share
  --network-status, -n      Show network configuration status
  --csi, --csi-nfs          Open Kubernetes CSI NFS menu
  --csi-status              Show CSI NFS driver status
  --version, -v             Show version information
  --update, -u              Check for and install updates
  --help, -h                Show help
```

## Kubernetes CSI NFS Driver

The client setup includes optional support for the [Kubernetes CSI NFS Driver](https://github.com/kubernetes-csi/csi-driver-nfs), enabling dynamic NFS volume provisioning in Kubernetes clusters.

### Features

- **Install/Uninstall CSI Driver**: Install via Helm or official script
- **Configure StorageClass**: Create StorageClasses pointing to your xiNAS server
- **Manage StorageClasses**: View, delete, or set default StorageClass
- **Status Check**: View driver pods, storage classes, and PVCs

### Usage

Access the CSI NFS menu from the main menu (option 7) or directly:

```bash
sudo ./client_setup.sh --csi
```

To check status non-interactively:

```bash
sudo ./client_setup.sh --csi-status
```

### Example StorageClass

After installation, create a StorageClass for your xiNAS server:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: xinas-nfs
provisioner: nfs.csi.k8s.io
parameters:
  server: 10.10.1.1
  share: /mnt/data
reclaimPolicy: Delete
volumeBindingMode: Immediate
mountOptions:
  - nfsvers=4.2
  - hard
  - nconnect=16
  - rsize=1048576
  - wsize=1048576
```

### Example PVC

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-nfs-pvc
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: xinas-nfs
  resources:
    requests:
      storage: 100Gi
```

## Requirements

- **NFS Client**: Ubuntu 22.04/24.04 LTS (Debian-based)
- **RDMA Support**: Requires DOCA OFED installation
- **Kubernetes CSI**: Requires kubectl and cluster access
