# xinas_mcp

Installs and configures the **xiNAS MCP Server** — a Model Context Protocol bridge
that exposes xiNAS infrastructure operations (RAID, disks, NFS shares, health) as
strongly-typed tools to AI assistants such as Claude Code.

## What this role does

| Step | Action |
|------|--------|
| 1 | Installs **Node.js 20 LTS** via NodeSource APT repository (skipped if ≥ v20 already present) |
| 2 | Runs `npm ci && npm run build` in `xinas_mcp_repo_path` to compile TypeScript → `dist/` |
| 3 | Copies the **NFS helper daemon** (`nfs-helper/*.py`) to `/usr/lib/xinas-mcp/nfs-helper/` |
| 4 | Installs and enables **`xinas-nfs-helper.service`** (Python Unix-socket daemon managing `/etc/exports`) |
| 5 | Creates `/etc/xinas-mcp/config.json` with sane defaults (never overwrites existing config) |
| 6 | Creates `/var/log/xinas/` audit log directory |
| 7 | Deploys `/root/.claude/mcp_servers.json` so Claude Code discovers the MCP server automatically |
| 8 | Creates `/etc/ssh/sshd_config.d/10-xinas-root-access.conf` to enable key-based root SSH (overrides cloud-init drop-ins that disable root login) |
| 9 | Creates `/usr/local/bin/xinas-mcp` wrapper script for clean remote SSH invocation |

## Requirements

- Ubuntu 22.04 / 24.04 LTS
- xiNAS repo cloned to `/opt/xiNAS` (done by `install.sh`)
- Internet access for the NodeSource APT repository

## Role variables

| Variable | Default | Description |
|----------|---------|-------------|
| `xinas_mcp_repo_path` | `/opt/xiNAS/xiNAS-MCP` | Path to the MCP source directory |
| `xinas_mcp_helper_lib_path` | `/usr/lib/xinas-mcp/nfs-helper` | NFS helper install target |
| `xinas_mcp_config_dir` | `/etc/xinas-mcp` | Config directory |
| `xinas_mcp_nfs_socket` | `/run/xinas-nfs-helper.sock` | Unix socket for NFS helper |
| `xinas_mcp_prometheus_url` | `http://localhost:9827/metrics` | xiraid-exporter endpoint |
| `xinas_mcp_audit_log_path` | `/var/log/xinas/mcp-audit.jsonl` | Audit log file |
| `xinas_mcp_sse_enabled` | `false` | Enable SSE transport (stdio is default) |
| `xinas_mcp_sse_port` | `8080` | SSE port (only used when sse_enabled=true) |
| `xinas_mcp_configure_claude` | `true` | Deploy Claude Code MCP integration for root |
| `xinas_mcp_claude_config_dir` | `/root/.claude` | Claude Code config directory |
| `xinas_mcp_allow_root_ssh` | `true` | Enable key-based root SSH via sshd drop-in (safe: password login stays blocked) |

## Using with Claude Code

### Option A — Claude Code running on the NAS (root shell)

The Ansible role deploys `/root/.claude/mcp_servers.json` automatically.
Just run `claude` on the NAS and the `xinas` server is available.

### Option B — Claude Code on your workstation (remote)

The MCP server must run on the NAS (it connects to local xiRAID gRPC and NFS sockets).
Use the SSH stdio transport — Claude Code pipes JSON-RPC over the connection:

```bash
# Add once on your workstation
claude mcp add --transport stdio xinas -- ssh -T root@<nas-ip> xinas-mcp
```

**Prerequisite:** Copy your workstation's SSH public key to the NAS first:

```bash
ssh-copy-id root@<nas-ip>
```

Verify the connection:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | ssh -T root@<nas-ip> xinas-mcp \
  | python3 -m json.tool | grep '"name"' | head -5
```

The output should list the first 5 of 33 xiNAS tools.

## NFS helper verification

```bash
echo '{"op":"list_exports","request_id":"test-1"}' | nc -U /run/xinas-nfs-helper.sock
# Expected: {"ok": true, "result": [...], "request_id": "test-1"}
```

## Tags

| Tag | Action |
|-----|--------|
| `xinas_mcp` | All tasks |
| `xinas_mcp,nodejs` | Node.js installation only |
| `xinas_mcp,build` | npm ci + build only |
| `xinas_mcp,nfs_helper` | NFS daemon install only |
| `xinas_mcp,config` | Config and log directories only |
| `xinas_mcp,claude` | Claude Code integration only |
| `xinas_mcp,ssh` | sshd drop-in + wrapper script only |
