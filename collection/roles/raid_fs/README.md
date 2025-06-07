# Role **raid_fs**
Creates xiRAID arrays and tuned XFS filesystems as per Xinnor NFS RDMA blog.

## Variables
* `xiraid_arrays` – list of array definitions (name, level, devices, strip size, parity).
* `xfs_filesystems` – list defining data/log device pairs, mount point, mkfs params.

## Example playbook
```yaml
- hosts: storage_nodes
  roles:
    - raid_fs
```

Blog reference: “How to Build High-Performance NFS Storage with xiRAID Backend and RDMA Access”, Feb 3 2025
