# xinas_node_build

Node 20 toolchain (NodeSource) + the xiNAS-MCP TypeScript build
(`npm ci` + `npm run build` → `dist/`). Extracted from `xinas_mcp`
(S8 T1, ADR-0010) so the build artifacts are provisioned independently
of the legacy MCP daemon. Consumers: `xinas_api`, `xinas_agent`, and
the `xinas_mcp` shim.

| Variable | Default | Purpose |
|---|---|---|
| `xinas_node_build_repo_path` | `/opt/xiNAS/xiNAS-MCP` | Repo build directory |

Run BEFORE `xinas_nfs_helper`, `xinas_api`, `xinas_agent`, `xinas_mcp`.
