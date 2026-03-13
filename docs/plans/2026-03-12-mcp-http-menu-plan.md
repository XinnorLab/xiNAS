# MCP HTTP Remote Access Menu — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add interactive menu options to `post_install_menu.sh` for enabling/configuring MCP Streamable HTTP transport, managing auth tokens, and setting TLS paths — replacing manual JSON editing.

**Architecture:** New functions `mcp_remote_access_menu()` and `mcp_tokens_menu()` added to `post_install_menu.sh`, wired into the existing `mcp_menu()` as option "9". Config changes use `jq` to edit `/etc/xinas-mcp/config.json` directly, with service restart after each change. Ansible template and defaults updated for consistency.

**Tech Stack:** Bash (menu_lib.sh TUI), jq (JSON editing), openssl (token generation), systemctl (service management)

---

### Task 1: Add jq config helper functions

**Files:**
- Modify: `post_install_menu.sh` — insert after line 2826 (after the MCP constants block)

**Step 1: Add the helper functions**

Insert these helpers right after the `MCP_SSHD_DROPIN` constant (line 2826):

```bash
# ── MCP config helpers (jq-based) ───────────────────────────────────────────

_mcp_config_get() {
    jq -r "$1" "$MCP_CONFIG" 2>/dev/null
}

_mcp_config_set() {
    local tmp
    tmp=$(jq "$1" "$MCP_CONFIG") && echo "$tmp" > "$MCP_CONFIG"
}

_mcp_config_apply() {
    _mcp_config_set "$1" || return 1
    systemctl restart "$MCP_NFS_HELPER_SVC" 2>/dev/null || true
}
```

**Step 2: Commit**

```bash
git add post_install_menu.sh
git commit -m "feat(menu): add jq config helpers for MCP settings"
```

---

### Task 2: Add `mcp_tokens_menu()` function

**Files:**
- Modify: `post_install_menu.sh` — insert new function before `mcp_ssh_access_menu()` (before line 2830)

**Step 1: Implement the tokens submenu**

Insert before `mcp_ssh_access_menu()`:

```bash
# ── MCP token management sub-menu ──────────────────────────────────────────

mcp_tokens_menu() {
    local choice

    while true; do
        show_header

        # List current tokens
        local token_list token_count
        token_count=$(_mcp_config_get '.tokens | length')
        [[ "$token_count" == "null" ]] && token_count=0

        if [[ "$token_count" -gt 0 ]]; then
            echo -e "  ${WHITE}Configured tokens:${NC}"
            local _name _role
            while IFS=$'\t' read -r _name _role; do
                echo -e "    ${GREEN}●${NC} ${_name}  ${DIM}[${_role}]${NC}"
            done < <(jq -r '.tokens | to_entries[] | [.key, .value] | @tsv' "$MCP_CONFIG" 2>/dev/null)
        else
            echo -e "  ${DIM}No tokens configured${NC}"
        fi
        echo ""

        choice=$(menu_select "🔑 API Tokens" "Manage authentication tokens" \
            "1" "➕ Add Token" \
            "2" "➖ Remove Token" \
            "0" "🔙 Back") || return

        case "$choice" in
            1)
                audit_log "MCP > Tokens > Add"
                local token_name
                token_name=$(input_box "Token Name" \
                    "Enter a name for the new token\n(e.g. remote-claude, monitoring):" \
                    "") || continue
                [[ -z "$token_name" ]] && continue

                # Check if name already exists
                local existing
                existing=$(_mcp_config_get ".tokens[\"$token_name\"]")
                if [[ "$existing" != "null" && -n "$existing" ]]; then
                    msg_box "❌ Exists" "Token '${token_name}' already exists.\nRemove it first to regenerate."
                    continue
                fi

                local role
                role=$(menu_select "Token Role" "Select role for '${token_name}':" \
                    "1" "admin    – Full access (create/delete/manage)" \
                    "2" "operator – Read + execute operations" \
                    "3" "viewer   – Read-only access") || continue
                case "$role" in
                    1) role="admin" ;;
                    2) role="operator" ;;
                    3) role="viewer" ;;
                esac

                local token_value
                token_value=$(openssl rand -hex 32)

                # Ensure tokens object exists then add the new token
                _mcp_config_set '.tokens //= {}' || true
                _mcp_config_apply ".tokens[\"$token_name\"] = \"$role\"" || {
                    msg_box "❌ Error" "Failed to save token."
                    continue
                }

                audit_log "MCP > Tokens > Add" "$token_name ($role)"
                msg_box "✅ Token Created" \
                    "Name:  ${token_name}\nRole:  ${role}\n\n${BOLD}Token (copy now — shown once):${NC}\n\n${token_value}\n\nUse as Bearer token in Authorization header."

                # Store the actual token value (the config maps token→role)
                _mcp_config_apply ".tokens[\"$token_value\"] = \"$role\"" || true
                # Remove the name-based placeholder
                _mcp_config_apply "del(.tokens[\"$token_name\"])" || true

                # Re-add with name as a comment-like convention: store name→value mapping
                # Actually: config.json maps token_value→role. We show the name for UX only.
                # Store a parallel map for display: token_labels { token_value: name }
                _mcp_config_set ".token_labels //= {}" || true
                _mcp_config_set ".token_labels[\"$token_value\"] = \"$token_name\"" || true
                ;;
            2)
                audit_log "MCP > Tokens > Remove"
                if [[ "$token_count" -eq 0 ]]; then
                    msg_box "ℹ️  No Tokens" "No tokens to remove."
                    continue
                fi

                # Build selection list from token_labels or raw tokens
                local -a sel_args=()
                local idx=1
                local -a token_keys=()
                while IFS=$'\t' read -r _tk _rl; do
                    local _label
                    _label=$(jq -r ".token_labels[\"$_tk\"] // \"${_tk:0:12}…\"" "$MCP_CONFIG" 2>/dev/null)
                    sel_args+=("$idx" "${_label}  [${_rl}]")
                    token_keys+=("$_tk")
                    ((idx++))
                done < <(jq -r '.tokens | to_entries[] | [.key, .value] | @tsv' "$MCP_CONFIG" 2>/dev/null)

                local sel
                sel=$(menu_select "Remove Token" "Select token to remove:" \
                    "${sel_args[@]}" \
                    "0" "🔙 Cancel") || continue
                [[ "$sel" == "0" ]] && continue

                local rm_idx=$((sel - 1))
                local rm_key="${token_keys[$rm_idx]}"
                local rm_label
                rm_label=$(jq -r ".token_labels[\"$rm_key\"] // \"${rm_key:0:12}…\"" "$MCP_CONFIG" 2>/dev/null)

                if yes_no "Confirm Remove" "Remove token '${rm_label}'?"; then
                    _mcp_config_set "del(.tokens[\"$rm_key\"])" || true
                    _mcp_config_apply "del(.token_labels[\"$rm_key\"])" || true
                    audit_log "MCP > Tokens > Remove" "$rm_label"
                    msg_box "✅ Removed" "Token '${rm_label}' has been removed."
                fi
                ;;
        esac
    done
}
```

**Step 2: Commit**

```bash
git add post_install_menu.sh
git commit -m "feat(menu): add MCP token management submenu"
```

---

### Task 3: Add `mcp_remote_access_menu()` function

**Files:**
- Modify: `post_install_menu.sh` — insert new function after `mcp_tokens_menu()`

**Step 1: Implement the remote access submenu**

```bash
# ── MCP remote access (HTTP) sub-menu ──────────────────────────────────────

mcp_remote_access_menu() {
    local choice

    while true; do
        show_header

        # Read current state
        local http_on http_port tls_cert token_count
        http_on=$(_mcp_config_get '.http_enabled')
        http_port=$(_mcp_config_get '.http_port // 8080')
        tls_cert=$(_mcp_config_get '.tls.cert // empty')
        token_count=$(_mcp_config_get '.tokens | length')
        [[ "$token_count" == "null" ]] && token_count=0

        local http_color http_label
        if [[ "$http_on" == "true" ]]; then
            http_color="$GREEN"; http_label="● Enabled (port ${http_port})"
        else
            http_color="$RED"; http_label="○ Disabled"
        fi

        local tls_label
        if [[ -n "$tls_cert" && "$tls_cert" != "null" ]]; then
            tls_label="${GREEN}● Configured${NC}"
        else
            tls_label="${DIM}○ Not configured${NC}"
        fi

        echo -e "  ${WHITE}HTTP Transport:${NC}  ${http_color}${http_label}${NC}"
        echo -e "  ${WHITE}TLS:${NC}             ${tls_label}"
        echo -e "  ${WHITE}Tokens:${NC}          ${token_count} configured"
        echo ""

        local toggle_label
        [[ "$http_on" == "true" ]] \
            && toggle_label="⏹  Disable HTTP Transport" \
            || toggle_label="▶  Enable HTTP Transport"

        choice=$(menu_select "🌐 Remote Access (HTTP)" "Streamable HTTP transport" \
            "1" "$toggle_label" \
            "2" "🔌 Set Port (current: ${http_port})" \
            "3" "🔑 Manage Tokens (${token_count})" \
            "4" "🔒 Configure TLS" \
            "5" "📋 Show Connection Command" \
            "0" "🔙 Back") || return

        case "$choice" in
            1)
                if [[ "$http_on" == "true" ]]; then
                    audit_log "MCP > HTTP > Disable"
                    _mcp_config_apply '.http_enabled = false'
                    msg_box "⏹  HTTP Disabled" "HTTP transport has been disabled.\nThe MCP server is now stdio-only."
                else
                    audit_log "MCP > HTTP > Enable"
                    if [[ "$token_count" -eq 0 ]]; then
                        if yes_no "⚠️  No Tokens" \
                            "No auth tokens are configured.\nEnabling HTTP without tokens allows\nunauthenticated access.\n\nAdd a token first?"; then
                            mcp_tokens_menu
                            continue
                        fi
                    fi
                    _mcp_config_apply '.http_enabled = true'
                    msg_box "▶  HTTP Enabled" "HTTP transport enabled on port ${http_port}.\n\nRemote clients can connect at:\n  http://$(hostname -I | awk '{print $1}'):${http_port}/mcp"
                fi
                ;;
            2)
                audit_log "MCP > HTTP > Set Port"
                local new_port
                new_port=$(input_box "HTTP Port" \
                    "Enter port number for HTTP transport:" \
                    "$http_port") || continue
                # Validate port number
                if ! [[ "$new_port" =~ ^[0-9]+$ ]] || [[ "$new_port" -lt 1 ]] || [[ "$new_port" -gt 65535 ]]; then
                    msg_box "❌ Invalid Port" "Port must be a number between 1 and 65535."
                    continue
                fi
                _mcp_config_apply ".http_port = $new_port"
                audit_log "MCP > HTTP > Set Port" "$new_port"
                msg_box "✅ Port Updated" "HTTP port set to ${new_port}."
                ;;
            3)
                audit_log "MCP > HTTP > Manage Tokens"
                mcp_tokens_menu
                ;;
            4)
                audit_log "MCP > HTTP > Configure TLS"
                local cert_path key_path ca_path

                cert_path=$(input_box "TLS Certificate" \
                    "Path to TLS certificate file (.crt/.pem):\n\n(Leave empty to disable TLS)" \
                    "$(_mcp_config_get '.tls.cert // empty')") || continue

                if [[ -z "$cert_path" ]]; then
                    if yes_no "Disable TLS?" "Remove TLS configuration?\nHTTP will use plain (unencrypted) connections."; then
                        _mcp_config_apply 'del(.tls)'
                        msg_box "🔓 TLS Disabled" "TLS configuration removed."
                    fi
                    continue
                fi

                if [[ ! -f "$cert_path" ]]; then
                    msg_box "❌ File Not Found" "Certificate file not found:\n${cert_path}"
                    continue
                fi

                key_path=$(input_box "TLS Private Key" \
                    "Path to TLS private key file (.key/.pem):" \
                    "$(_mcp_config_get '.tls.key // empty')") || continue

                if [[ ! -f "$key_path" ]]; then
                    msg_box "❌ File Not Found" "Key file not found:\n${key_path}"
                    continue
                fi

                ca_path=$(input_box "CA Certificate (optional)" \
                    "Path to CA certificate for mTLS (optional):\n\n(Leave empty to skip client cert verification)" \
                    "$(_mcp_config_get '.tls.ca // empty')") || continue

                if [[ -n "$ca_path" && ! -f "$ca_path" ]]; then
                    msg_box "❌ File Not Found" "CA file not found:\n${ca_path}"
                    continue
                fi

                local tls_json
                tls_json=$(jq -n \
                    --arg cert "$cert_path" \
                    --arg key "$key_path" \
                    '{cert: $cert, key: $key}')
                if [[ -n "$ca_path" ]]; then
                    tls_json=$(echo "$tls_json" | jq --arg ca "$ca_path" '. + {ca: $ca}')
                fi
                _mcp_config_apply ".tls = $tls_json"
                audit_log "MCP > HTTP > TLS" "cert=$cert_path"
                msg_box "🔒 TLS Configured" "TLS enabled with:\n  Cert: ${cert_path}\n  Key:  ${key_path}${ca_path:+\n  CA:   ${ca_path}}"
                ;;
            5)
                audit_log "MCP > HTTP > Connection Command"
                local _ip proto
                _ip=$(hostname -I | awk '{print $1}')
                [[ -n "$tls_cert" && "$tls_cert" != "null" ]] && proto="https" || proto="http"

                local _first_token _first_label
                _first_token=$(jq -r '.tokens | keys[0] // empty' "$MCP_CONFIG" 2>/dev/null)
                _first_label=""
                if [[ -n "$_first_token" ]]; then
                    _first_label=$(jq -r ".token_labels[\"$_first_token\"] // \"token\"" "$MCP_CONFIG" 2>/dev/null)
                fi

                local out="$TMP_DIR/mcp_connect_cmd"
                {
                    echo "=== MCP Remote Connection ==="
                    echo ""
                    echo "Endpoint: ${proto}://${_ip}:${http_port}/mcp"
                    echo ""
                    echo "--- Claude Code (CLI) ---"
                    echo ""
                    if [[ -n "$_first_token" ]]; then
                        echo "  claude mcp add \\"
                        echo "    --transport http \\"
                        echo "    --header \"Authorization: Bearer ${_first_token}\" \\"
                        echo "    xinas ${proto}://${_ip}:${http_port}/mcp"
                    else
                        echo "  claude mcp add \\"
                        echo "    --transport http \\"
                        echo "    xinas ${proto}://${_ip}:${http_port}/mcp"
                    fi
                    echo ""
                    echo "--- curl test ---"
                    echo ""
                    echo "  curl -X POST ${proto}://${_ip}:${http_port}/mcp \\"
                    if [[ -n "$_first_token" ]]; then
                        echo "    -H \"Authorization: Bearer ${_first_token}\" \\"
                    fi
                    echo "    -H \"Content-Type: application/json\" \\"
                    echo "    -d '{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"id\":1,\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\"}}}'"
                } > "$out"
                text_box "📋 Connection Command" "$out"
                ;;
        esac
    done
}
```

**Step 2: Commit**

```bash
git add post_install_menu.sh
git commit -m "feat(menu): add MCP remote access (HTTP) submenu"
```

---

### Task 4: Wire remote access into `mcp_menu()`

**Files:**
- Modify: `post_install_menu.sh` — edit `mcp_menu()` function

**Step 1: Add option "9" to the menu_select call**

In `mcp_menu()`, update the status header to show HTTP state, and add option "9" for Remote Access. Change the status display (around line 3013) and the menu_select call (around line 3024).

Update the header display to add HTTP status after the NFS Helper line:

```bash
        # After existing NFS Helper line (line 3016), add:
        local http_status http_color_ra
        local _http_on
        _http_on=$(_mcp_config_get '.http_enabled')
        if [[ "$_http_on" == "true" ]]; then
            local _hp
            _hp=$(_mcp_config_get '.http_port // 8080')
            http_color_ra="$GREEN"; http_status="● Enabled (port ${_hp})"
        else
            http_color_ra="$DIM"; http_status="○ Disabled"
        fi
        echo -e "  ${WHITE}🌐 HTTP Remote:${NC}  ${http_color_ra}${http_status}${NC}"
```

Add option "9" to the `menu_select` call — insert before the "0" Back option:

```bash
            "9" "🌐 Remote Access (HTTP)" \
```

Add case "9" to the case statement:

```bash
            9) audit_log "MCP > Remote Access"; mcp_remote_access_menu ;;
```

**Step 2: Update main menu MCP status indicator**

In the main menu status section (around line 3306), update to show HTTP status too:

```bash
        # Update existing mcp_text logic (around line 3306-3317) to include HTTP:
        local _http_flag
        _http_flag=$(_mcp_config_get '.http_enabled' 2>/dev/null)
        if [[ -f "$MCP_DIST" ]]; then
            if [[ "$_mcp_nfs_state" == "active" ]]; then
                if [[ "$_http_flag" == "true" ]]; then
                    mcp_text="🤖 AI / MCP Server [Ready + HTTP]"
                else
                    mcp_text="🤖 AI / MCP Server [Ready]"
                fi
            else
                mcp_text="🤖 AI / MCP Server [NFS Helper Stopped]"
            fi
        else
            mcp_text="🤖 AI / MCP Server [Not Built]"
        fi
```

**Step 3: Commit**

```bash
git add post_install_menu.sh
git commit -m "feat(menu): wire HTTP remote access into MCP menu"
```

---

### Task 5: Update Ansible template and defaults

**Files:**
- Modify: `collection/roles/xinas_mcp/templates/xinas-mcp-config.json.j2`
- Modify: `collection/roles/xinas_mcp/defaults/main.yml`

**Step 1: Update defaults/main.yml**

Add after `xinas_mcp_sse_port` line:

```yaml
# Streamable HTTP transport (false = disabled; enables remote MCP access)
xinas_mcp_http_enabled: false
xinas_mcp_http_port: 8080
```

**Step 2: Update the Jinja2 template**

Replace the entire template with:

```json
{
  "controller_id": "",
  "nfs_helper_socket": "{{ xinas_mcp_nfs_socket }}",
  "prometheus_url": "{{ xinas_mcp_prometheus_url }}",
  "audit_log_path": "{{ xinas_mcp_audit_log_path }}",
  "tokens": {},
  "sse_enabled": {{ xinas_mcp_sse_enabled | lower }},
  "sse_port": {{ xinas_mcp_sse_port }},
  "http_enabled": {{ xinas_mcp_http_enabled | lower }},
  "http_port": {{ xinas_mcp_http_port }}
}
```

**Step 3: Commit**

```bash
git add collection/roles/xinas_mcp/defaults/main.yml collection/roles/xinas_mcp/templates/xinas-mcp-config.json.j2
git commit -m "feat(ansible): add http_enabled/http_port to MCP config template"
```

---

### Verification

1. **Syntax check**: `bash -n post_install_menu.sh` — must exit 0
2. **jq available**: `which jq` — must be in PATH
3. **Manual test on NAS**: Run `./post_install_menu.sh`, navigate to AI/MCP Server → Remote Access (HTTP), toggle enable, add a token, verify `/etc/xinas-mcp/config.json` has correct fields
4. **Ansible template**: `ansible-playbook playbooks/site.yml --tags xinas_mcp --check` — must not error
5. **MCP server restart**: After enabling HTTP via menu, verify `curl http://localhost:8080/mcp` responds (after creating a token and starting the service)
