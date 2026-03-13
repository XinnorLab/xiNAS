# MCP HTTP Remote Access Menu — Design

**Date:** 2026-03-12
**Status:** Approved

## Problem

The MCP server supports Streamable HTTP transport for remote AI assistant connections, but enabling it requires manually editing `/etc/xinas-mcp/config.json`. All xiNAS configuration should be manageable through the interactive menu system.

## Solution

Add a "Remote Access (HTTP)" submenu inside the existing `mcp_menu()` in `post_install_menu.sh` that manages HTTP transport, authentication tokens, and TLS — all via direct `jq` edits to the MCP config JSON file.

## Menu Structure

### Remote Access submenu (`mcp_remote_access_menu`)

Header displays current state: HTTP enabled/disabled, port, TLS status, token count.

| Option | Action |
|--------|--------|
| Enable/Disable HTTP | Toggle `http_enabled` boolean |
| Set Port | Input box for port number (default 8080) |
| Manage Tokens → | Opens token submenu |
| Configure TLS | Prompt for cert/key/CA paths |
| Show Connection Command | Display ready-to-copy `claude mcp add` command |

### Token submenu (`mcp_tokens_menu`)

Lists existing tokens with their roles.

| Option | Action |
|--------|--------|
| Add Token | Name prompt → role select (admin/operator/viewer) → auto-generate via `openssl rand -hex 32` → display once |
| Remove Token | Select from list → confirm → delete from JSON |

### TLS configuration

Simple sequential prompts for cert path, key path, optional CA path. Validates file existence before saving.

## Config Editing Pattern

```bash
_mcp_config_get()  { jq -r "$1" "$MCP_CONFIG" 2>/dev/null; }
_mcp_config_set()  { local tmp; tmp=$(jq "$1" "$MCP_CONFIG") && echo "$tmp" > "$MCP_CONFIG"; }
_mcp_config_apply() { _mcp_config_set "$1" && systemctl restart xinas-nfs-helper 2>/dev/null; }
```

## Files Modified

1. **`post_install_menu.sh`** — Add `mcp_remote_access_menu()`, `mcp_tokens_menu()`, wire into `mcp_menu()`
2. **`collection/roles/xinas_mcp/templates/xinas-mcp-config.json.j2`** — Add `http_enabled`, `http_port`, `tls` fields
3. **`collection/roles/xinas_mcp/defaults/main.yml`** — Add `xinas_mcp_http_enabled`, `xinas_mcp_http_port` variables

## Not Changed

MCP server TypeScript code — already supports HTTP transport, tokens, and TLS. This is purely menu + Ansible template work.
