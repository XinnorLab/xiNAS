# Role **raid_fs**
Creates xiRAID arrays and tuned XFS filesystems as per Xinnor NFS RDMA blog.

## Variables
* `xiraid_arrays` – list of array definitions (name, level, devices, strip size, parity).
* `xfs_filesystems` – list defining data/log device pairs, mount point, mkfs params.
* `xiraid_license_path` – path to license file applied before arrays are created.
* `xiraid_force_metadata` – when `true` add `--force_metadata` to array creation.

This role requires the **mdadm** package to be installed so that any
leftover Linux MD arrays on xiRAID devices can be stopped and wiped.

Array creation is idempotent. If a RAID with the same name already
exists in the xiRAID configuration file, the role will skip creation
without failing.

## Example playbook
```yaml
- hosts: storage_nodes
  roles:
    - raid_fs
```

Blog reference: “How to Build High-Performance NFS Storage with xiRAID Backend and RDMA Access”, Feb 3 2025
