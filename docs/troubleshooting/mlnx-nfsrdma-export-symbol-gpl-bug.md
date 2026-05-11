# mlnx-nfsrdma: NFS-GDS hooks exported non-GPL block nvidia_fs registration

## TL;DR

`mlnx-nfsrdma` 26.01 exports the two NFS-RDMA → GDS hook functions via plain
`EXPORT_SYMBOL`. Modern Linux `__symbol_get()` only resolves `EXPORT_SYMBOL_GPL`
exports, so `nvidia_fs` cannot register its NFS callbacks, and `gdscheck -p`
reports `NFS : Unsupported` even though the RDMA mount itself works. The fix
is two characters per export line: `EXPORT_SYMBOL` → `EXPORT_SYMBOL_GPL`.

## Symptoms

- `gdscheck -p` shows `NFS : Unsupported` despite `mlnx-nfsrdma-dkms`,
  `nvidia-fs`, and a working `proto=rdma` NFS mount being present.
- `gdsio` with `-x 0` (GPUDirect) fails at `cuFileHandleRegister`:
  `file register error: GPUDirect Storage not supported on current file`.
- `dmesg` has a tight repeating signature:

  ```
  failing symbol_get of non-GPLONLY symbol rpcrdma_register_nvfs_dma_ops.
  ```

  The same warning appears for `rpcrdma_unregister_nvfs_dma_ops` on module
  unload paths.

## Root cause

- `nvidia_fs` uses `__symbol_get()` to grab two hooks exported by the
  `rpcrdma` module: `rpcrdma_register_nvfs_dma_ops` and
  `rpcrdma_unregister_nvfs_dma_ops`.
- `__symbol_get()` (see `kernel/module/main.c`) resolves only
  `EXPORT_SYMBOL_GPL` symbols. For a plain `EXPORT_SYMBOL` symbol it emits
  the `non-GPLONLY` `pr_warn` shown above and returns `NULL`.
- The DKMS source in
  `/usr/src/mlnx-nfsrdma-<ver>/nvfs_rpc_rdma.c` ships both macros via
  plain `EXPORT_SYMBOL`. The SPDX header is
  `GPL-2.0 OR Linux-OpenIB`, so `EXPORT_SYMBOL_GPL` is fully
  licence-compatible.

## Confirmation

- `nm` on the rebuilt `rpcrdma.ko`: the patched module emits a
  `__ksymtab_gpl` ELF section for both symbols instead of the original
  `__ksymtab` section.
- After `depmod` + reload, `gdscheck -p` flips to `NFS : nvfs` (or
  `nvfs, compat` if cuFile compat mode is enabled in `cufile.json`).
- `gdsio -x 0` against a `proto=rdma` NFS mount then reports
  `XferType: GPUD` and produces real GiB/s numbers (confirmed on
  `ars-511gd`: 25.25 GiB/s read, 7.15 GiB/s write).

## Affected

- `mlnx-nfsrdma-dkms 26.01.OFED.26.01.1.0.0.1` (DOCA-Host 26.01) —
  confirmed in the field.
- Likely any earlier `mlnx-nfsrdma-dkms` 5.x release shipping the same
  `nvfs_rpc_rdma.c` source.
- Will remain affected until Mellanox/NVIDIA ships an upstream fix.
- The symptom is only visible when `nvidia-fs` and `gds-tools` are
  installed alongside `mlnx-nfsrdma`. Pure NFS-RDMA mounts (without GDS)
  are unaffected — the hooks are only consumed by `nvidia_fs`.

## Workaround (automatic in xiNAS client)

- Patch file: `client_repo/patches/mlnx-nfsrdma-nvfs-export-gpl.patch`
- Applier:    `client_repo/patches/apply-mlnx-nfsrdma-export-gpl.sh`
- Auto-applied by both `install_client.sh` (one-shot installer) and the
  Advanced Settings → Install NFS Tools flow in the xiNAS Client TUI.
- The applier is idempotent and safe to re-run; it patches the DKMS
  source, rebuilds the module via `dkms`, runs `depmod`, and reloads
  `rpcrdma` (and its dependents) so the new GPL exports take effect
  without a reboot.
- Manual reproduction: see the applier script.

## Proposed upstream fix

Single-character change per export line in `nvfs_rpc_rdma.c`:

```c
EXPORT_SYMBOL(REGISTER_FUNC)    →  EXPORT_SYMBOL_GPL(REGISTER_FUNC)
EXPORT_SYMBOL(UNREGISTER_FUNC)  →  EXPORT_SYMBOL_GPL(UNREGISTER_FUNC)
```

The licence header on the file (`GPL-2.0 OR Linux-OpenIB`) already permits
GPL-only export; no licence change is required.

- Filed at: _TBD — placeholder for the Mellanox/NVIDIA bug tracker link
  once the upstream report is opened._

## References

- Linux kernel `__symbol_get()` — `kernel/module/main.c` (the `pr_warn`
  source emitting `failing symbol_get of non-GPLONLY symbol ...`).
- NVIDIA GDS Troubleshooting Guide — `gdscheck` filesystem support
  matrix and the meaning of `NFS : Unsupported`.
- Patch + applier paths above (`client_repo/patches/`).
