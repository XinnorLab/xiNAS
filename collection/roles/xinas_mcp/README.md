# xinas_mcp (retirement shim — ADR-0010)

The MCP transport lives inside `xinas-api.service` since S8: the
`/mcp` Streamable HTTP endpoint (optionally on a dedicated TCP
listener via the api config's `mcp.http` block) and the
`xinas-mcp-stdio` adapter binary. This role now:

1. stops/disables/removes the legacy standalone `xinas-mcp.service`;
2. installs the `/usr/local/bin/xinas-mcp-stdio` and
   `/usr/local/bin/xinasctl` wrappers;
3. points the Claude Code integration at the stdio adapter.

**Apply gate:** MCP tool calls can plan and read by default; `mode=apply`
requires `mcp.allow_apply: true` in `/etc/xinas-api/config.json`
(the WS12 exit criterion — default false).

**Token migration (operator step):** bearer tokens from the legacy
`/etc/xinas-mcp/config.json` must be re-created in the xinas-api token
store if remote MCP clients used them; local stdio access
authenticates via the api socket's file mode (no token).

| Variable | Default | Purpose |
|---|---|---|
| `xinas_mcp_repo_path` | `/opt/xiNAS/xiNAS-MCP` | Built repo (dist/) |
| `xinas_mcp_configure_claude` | `true` | Write root's Claude MCP config |
| `xinas_mcp_claude_config_dir` | `/root/.claude` | Claude config dir |
| `xinas_mcp_allow_root_ssh` | `true` | Key-auth root SSH drop-in |

Run AFTER `xinas_node_build` (and normally after `xinas_api`, which
serves the transport).
