# xinas_menu Ansible Role

Installs the xiNAS Python/Textual management console, replacing the Bash/whiptail scripts.

## What this role does

1. Installs `python3-venv` apt package
2. Creates a Python virtualenv at `/opt/xiNAS/venv` (shared with xinas_mcp)
3. Installs pip packages: `textual`, `grpcio`, `grpcio-tools`, `protobuf`, `pyyaml`
4. Syncs `xinas_menu/` Python package to `/opt/xiNAS/xinas_menu/`
5. Generates gRPC stubs from proto files into `api/proto/`
6. Writes `/usr/local/bin/xinas-menu` and `/usr/local/bin/xinas-setup` wrapper scripts
7. Ensures `/var/log/xinas/` and subdirectories exist

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `xinas_menu_package_path` | `/opt/xiNAS/xinas_menu` | Installed package location |
| `xinas_menu_venv_path` | `/opt/xiNAS/venv` | Python virtualenv |
| `xinas_mcp_proto_path` | `/opt/xiNAS/xiNAS-MCP/proto/xraid/gRPC/protobuf` | Proto files directory |
| `xinas_menu_wrapper_path` | `/usr/local/bin/xinas-menu` | Main wrapper |
| `xinas_setup_wrapper_path` | `/usr/local/bin/xinas-setup` | Setup/provisioning wrapper |
| `xinas_repo_path` | `/opt/xiNAS` | Repository root |

## Usage

```bash
# Full deployment (includes xinas_menu)
ansible-playbook playbooks/site.yml

# Only install/update xinas_menu
ansible-playbook playbooks/site.yml --tags xinas_menu

# Only regenerate gRPC stubs
ansible-playbook playbooks/site.yml --tags xinas_menu,grpc
```

## Wrappers

After installation:

```bash
xinas-menu          # Main management console (post-deploy)
xinas-menu --setup  # Provisioning menu (pre-deploy)
xinas-setup         # Same as xinas-menu --setup
xinas-menu --status # Non-TUI status summary
xinas-menu --version
```

## Requirements

- Ubuntu 22.04 / 24.04 LTS
- Python 3.10+
- xiNAS-MCP must be cloned at `{{ xinas_mcp_proto_path | dirname | dirname | dirname }}`
  (so proto files are available for stub generation)
- The `xinas_mcp` role should run before `xinas_menu` so the NFS helper is running

## Notes

- The virtualenv at `/opt/xiNAS/venv` is shared between `xinas_mcp` tooling and `xinas_menu`
- gRPC stubs are generated at deploy time; the `api/proto/` directory is excluded from rsync
  to avoid overwriting them on subsequent runs
- The `--no-welcome` flag skips the splash screen (useful for CI or quick access)
