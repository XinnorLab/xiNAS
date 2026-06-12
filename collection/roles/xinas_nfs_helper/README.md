# xinas_nfs_helper

Installs and runs the python `xinas-nfs-helper` daemon (UDS at
`/run/xinas-nfs-helper.sock`). Extracted from `xinas_mcp` (S8 T1,
ADR-0010): the helper serves the agent, so its lifecycle is
independent of the legacy MCP daemon.

| Variable | Default | Purpose |
|---|---|---|
| `xinas_nfs_helper_repo_path` | `/opt/xiNAS/xiNAS-MCP` | Source repo |
| `xinas_nfs_helper_lib_path` | `/usr/lib/xinas-mcp/nfs-helper` | Install target (unchanged path — the shipped unit needs no edits) |

Run AFTER `xinas_node_build` (repo present), BEFORE `xinas_api` /
`xinas_agent` / `xinas_mcp`.
