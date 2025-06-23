# Role **raid_fs**
Creates xiRAID arrays and tuned XFS filesystems as per Xinnor NFS RDMA blog.

## Variables
* `xiraid_arrays` – list of array definitions (name, level, devices, strip size, parity).
* `xfs_filesystems` – list defining data/log device pairs, mount point, mkfs params.
* `xiraid_license_path` – path to license file applied before arrays are created.
* `xiraid_force_metadata` – when `true` add `--force_metadata` to array creation.

This role requires the **mdadm** package to be installed so that any
leftover Linux MD arrays on xiRAID devices can be stopped and wiped.

When mounting filesystems the role automatically appends an
`x-systemd.wanted-by` option referencing the underlying block device so
that the mount is handled by `systemd` at boot time. This follows the
[xiRAID documentation on file system mounting](https://xinnor.io/docs/xiRAID-4.3.0/E/en/AG/2/file_system_mounting_examples.html).

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
