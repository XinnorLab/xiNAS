# Role **nfs_server**
Installs and tunes `nfs-kernel-server` for RDMA access, with defaults based on
Xinnor's high-performance NFS blog (Feb 3 2025).

## Variables
* `nfs_threads` – thread count for exportd & nfsd (default 64).
* `nfs_rdma_port` – port for NFS-RDMA service (default 20049).

## Example playbook
```yaml
- hosts: storage_nodes
  roles:
    - nfs_server
```

Reference: Xinnor blog, Feb 3 2025
