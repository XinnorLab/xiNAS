#!/usr/bin/env bash
# xiNAS Post-Install Management Menu
# Emotionally-designed interactive menu for daily NAS management
# Run after each login for quick system management

set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Check if running in interactive terminal
if [[ ! -t 0 ]]; then
    echo "This script must be run in an interactive terminal"
    exit 1
fi

# Check for whiptail
if ! command -v whiptail &>/dev/null; then
    echo -e "${RED}Error: whiptail is required${NC}"
    echo "Install with: sudo apt-get install whiptail"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# RAID Information Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_raid_info() {
    local extended="${1:-false}"
    local out="$TMP_DIR/raid_info"
    local title="💾 RAID Arrays"

    if [[ "$extended" == "true" ]]; then
        title="💾 RAID Arrays (Extended)"
    fi

    if ! command -v xicli &>/dev/null; then
        whiptail --title "$title" --msgbox "\
   ⚠️  xiRAID CLI not found

   The xicli command is not installed.
   Please ensure xiRAID is properly installed.

   Run the installation playbook first:
   ./startup_menu.sh → Install
" 14 50
        return
    fi

    {
        echo "═══════════════════════════════════════════════════════════════"
        echo "                    RAID ARRAY INFORMATION"
        echo "═══════════════════════════════════════════════════════════════"
        echo ""

        if [[ "$extended" == "true" ]]; then
            xicli raid show -e 2>&1 || echo "Failed to retrieve extended RAID info"
        else
            xicli raid show 2>&1 || echo "Failed to retrieve RAID info"
        fi

        echo ""
        echo "═══════════════════════════════════════════════════════════════"
        echo "                      SPARE POOLS"
        echo "═══════════════════════════════════════════════════════════════"
        echo ""
        xicli pool show 2>&1 || echo "No spare pools configured"

        echo ""
        echo "═══════════════════════════════════════════════════════════════"
        echo "                    PHYSICAL DRIVES"
        echo "═══════════════════════════════════════════════════════════════"
        echo ""
        xicli drive show 2>&1 || echo "Failed to retrieve drive info"

    } > "$out" 2>&1

    whiptail --title "$title" --scrolltext --textbox "$out" 24 78
}

raid_menu() {
    while true; do
        local choice
        choice=$(whiptail --title "═══ 💾 RAID Management ═══" --menu "\
  View and manage your storage arrays
  ─────────────────────────────────────────────" 18 60 5 \
            "1" "📊 Quick Overview" \
            "2" "📋 Extended Details (-e)" \
            "3" "💿 Physical Drives" \
            "4" "🏊 Spare Pools" \
            "5" "🔙 Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_raid_info "false" ;;
            2) show_raid_info "true" ;;
            3)
                local out="$TMP_DIR/drives"
                if command -v xicli &>/dev/null; then
                    xicli drive show > "$out" 2>&1
                else
                    echo "xicli not found" > "$out"
                fi
                whiptail --title "💿 Physical Drives" --scrolltext --textbox "$out" 24 78
                ;;
            4)
                local out="$TMP_DIR/pools"
                if command -v xicli &>/dev/null; then
                    xicli pool show > "$out" 2>&1
                else
                    echo "xicli not found" > "$out"
                fi
                whiptail --title "🏊 Spare Pools" --scrolltext --textbox "$out" 20 70
                ;;
            5) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Network Configuration Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_network_info() {
    local out="$TMP_DIR/net_info"
    {
        echo "═══════════════════════════════════════════════════════════════"
        echo "                    NETWORK CONFIGURATION"
        echo "═══════════════════════════════════════════════════════════════"
        echo ""
        echo "Hostname: $(hostname -f 2>/dev/null || hostname)"
        echo ""
        echo "─── Active Interfaces ───────────────────────────────────────────"
        echo ""

        for iface in /sys/class/net/*; do
            [[ -d "$iface" ]] || continue
            name=$(basename "$iface")
            [[ "$name" == "lo" ]] && continue

            state=$(cat "$iface/operstate" 2>/dev/null || echo "unknown")
            speed=$(cat "$iface/speed" 2>/dev/null || echo "")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")
            ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}' | head -1)
            [[ -z "$ip_addr" ]] && ip_addr="No IP"

            # Format speed
            if [[ "$speed" =~ ^[0-9]+$ ]] && [[ $speed -gt 0 ]]; then
                if [[ $speed -ge 1000 ]]; then
                    speed_str="$((speed/1000))Gb/s"
                else
                    speed_str="${speed}Mb/s"
                fi
            else
                speed_str="--"
            fi

            printf "  %-12s  %-18s  %-10s  %s  (%s)\n" "$name" "$ip_addr" "$speed_str" "$state" "$driver"
        done

        echo ""
        echo "─── Routing Table ─────────────────────────────────────────────────"
        echo ""
        ip route show 2>/dev/null | head -10

    } > "$out"

    whiptail --title "🌐 Network Information" --scrolltext --textbox "$out" 24 78
}

network_menu() {
    while true; do
        local choice
        choice=$(whiptail --title "═══ 🌐 Network Settings ═══" --menu "\
  Configure network interfaces
  ─────────────────────────────────────────────" 18 60 5 \
            "1" "📊 View Current Configuration" \
            "2" "✏️  Edit Network Settings" \
            "3" "🔄 Apply Network Changes" \
            "4" "📋 View Netplan Config" \
            "5" "🔙 Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_network_info ;;
            2)
                if [[ -f /etc/netplan/99-xinas.yaml ]]; then
                    ROLE_TEMPLATE_OVERRIDE=/etc/netplan/99-xinas.yaml "$SCRIPT_DIR/configure_network.sh"
                else
                    "$SCRIPT_DIR/configure_network.sh"
                fi
                ;;
            3)
                if whiptail --title "🔄 Apply Changes" --yesno "\
   Apply network configuration?

   This will run 'netplan apply' to activate
   any changes to the network settings.

   ⚠️  Active connections may be briefly interrupted.
" 14 55; then
                    if sudo netplan apply 2>/dev/null; then
                        whiptail --title "✅ Success" --msgbox "Network configuration applied successfully!" 8 50
                    else
                        whiptail --title "❌ Error" --msgbox "Failed to apply network configuration.\nCheck /var/log/syslog for details." 10 55
                    fi
                fi
                ;;
            4)
                local netplan_file=""
                for f in /etc/netplan/99-xinas.yaml /etc/netplan/*.yaml; do
                    [[ -f "$f" ]] && { netplan_file="$f"; break; }
                done
                if [[ -n "$netplan_file" && -f "$netplan_file" ]]; then
                    whiptail --title "📋 Netplan: $netplan_file" --scrolltext --textbox "$netplan_file" 24 78
                else
                    whiptail --title "📋 Netplan" --msgbox "No netplan configuration found." 8 45
                fi
                ;;
            5) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# System Status Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_status() {
    clear
    if command -v xinas-status &>/dev/null; then
        xinas-status
    else
        echo -e "${YELLOW}xinas-status command not found${NC}"
        echo ""
        echo "Basic system information:"
        echo ""
        echo "Hostname: $(hostname)"
        echo "Uptime:   $(uptime -p)"
        echo "Load:     $(cat /proc/loadavg | awk '{print $1, $2, $3}')"
        echo ""
        echo "Memory:"
        free -h
        echo ""
        echo "Disk Usage:"
        df -h | grep -E '^/dev|^Filesystem'
    fi
    echo ""
    echo -e "${CYAN}Press Enter to return to menu...${NC}"
    read -r
}

# ═══════════════════════════════════════════════════════════════════════════════
# NFS Access Rights Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_nfs_exports() {
    local out="$TMP_DIR/nfs_info"
    {
        echo "═══════════════════════════════════════════════════════════════"
        echo "                    NFS EXPORT CONFIGURATION"
        echo "═══════════════════════════════════════════════════════════════"
        echo ""

        if [[ -f /etc/exports ]]; then
            echo "─── Current Exports (/etc/exports) ─────────────────────────────"
            echo ""
            cat /etc/exports
            echo ""
            echo "─── Active NFS Clients ──────────────────────────────────────────"
            echo ""

            # Check for active clients
            local client_count=0
            if [[ -d /proc/fs/nfsd/clients ]]; then
                for client_dir in /proc/fs/nfsd/clients/*/; do
                    [[ -f "${client_dir}info" ]] || continue
                    client_ip=$(grep -oP 'address:\s*\K[\d.]+' "${client_dir}info" 2>/dev/null | head -1)
                    [[ -n "$client_ip" ]] && {
                        echo "  ● $client_ip"
                        ((client_count++))
                    }
                done
            fi

            if [[ $client_count -eq 0 ]]; then
                # Fallback: check established connections
                ss -tn state established '( dport = :2049 )' 2>/dev/null | \
                    awk 'NR>1 {split($4,a,":"); print "  ● " a[1]}' | sort -u
                [[ $(ss -tn state established '( dport = :2049 )' 2>/dev/null | wc -l) -le 1 ]] && \
                    echo "  No active clients"
            fi

            echo ""
            echo "─── Share Usage ───────────────────────────────────────────────────"
            echo ""
            awk '{print $1}' /etc/exports 2>/dev/null | while read -r path; do
                [[ -z "$path" || "$path" =~ ^# ]] && continue
                if [[ -d "$path" ]]; then
                    df -h "$path" 2>/dev/null | awk 'NR==2 {printf "  %-25s %s used of %s (%s)\n", "'"$path"'", $3, $2, $5}'
                else
                    echo "  $path (not mounted)"
                fi
            done
        else
            echo "  /etc/exports not found"
            echo ""
            echo "  NFS exports have not been configured yet."
            echo "  Run the installation playbook to set up NFS shares."
        fi

    } > "$out"

    whiptail --title "📂 NFS Shares" --scrolltext --textbox "$out" 24 78
}

edit_nfs_clients() {
    if [[ ! -f /etc/exports ]]; then
        whiptail --title "⚠️ No Exports" --msgbox "\
   No NFS exports configured yet.

   Run the installation playbook first to set up
   your NFS shares, then return here to modify
   access rights.
" 12 55
        return
    fi

    # Parse current exports
    local exports_file="/etc/exports"
    local out="$TMP_DIR/exports_list"

    mapfile -t paths < <(awk '!/^#/ && NF {print $1}' "$exports_file" 2>/dev/null)

    if [[ ${#paths[@]} -eq 0 ]]; then
        whiptail --title "⚠️ No Exports" --msgbox "No exports found in /etc/exports" 8 45
        return
    fi

    # Build menu
    local menu_items=()
    for path in "${paths[@]}"; do
        local clients
        clients=$(awk -v p="$path" '$1==p {for(i=2;i<=NF;i++) printf "%s ", $i}' "$exports_file" | head -c 40)
        menu_items+=("$path" "${clients:-no clients}")
    done
    menu_items+=("Back" "Return to menu")

    while true; do
        local choice
        choice=$(whiptail --title "📂 Edit NFS Access Rights" --menu "\
  Select an export to modify access:
  ─────────────────────────────────────────────" 20 70 10 \
            "${menu_items[@]}" 3>&1 1>&2 2>&3) || break

        [[ "$choice" == "Back" ]] && break

        # Get current settings for this export
        local current_line
        current_line=$(grep "^${choice}[[:space:]]" "$exports_file" 2>/dev/null | head -1)
        local current_clients
        current_clients=$(echo "$current_line" | awk '{for(i=2;i<=NF;i++) print $i}')

        # Show edit dialog
        local new_clients
        new_clients=$(whiptail --title "✏️ Edit: $choice" --inputbox "\
  Current access rules:
  $current_clients

  Enter new access rules (e.g., *(rw,sync,no_subtree_check))

  Common formats:
    *                    - Allow all hosts
    192.168.1.0/24       - Allow subnet
    client.example.com   - Allow specific host

  Common options:
    rw,sync,no_subtree_check,no_root_squash
" 20 70 "$current_clients" 3>&1 1>&2 2>&3) || continue

        if [[ -n "$new_clients" ]]; then
            # Create backup
            local ts
            ts=$(date +%Y%m%d%H%M%S)
            sudo cp "$exports_file" "${exports_file}.${ts}.bak"

            # Update the export line
            sudo sed -i "s|^${choice}[[:space:]].*|${choice} ${new_clients}|" "$exports_file"

            # Refresh exports
            if sudo exportfs -ra 2>/dev/null; then
                whiptail --title "✅ Success" --msgbox "\
   Export updated successfully!

   Path: $choice
   Access: $new_clients

   Changes are now active.
" 12 55
                # Update menu items
                menu_items=()
                for path in "${paths[@]}"; do
                    local clients
                    clients=$(awk -v p="$path" '$1==p {for(i=2;i<=NF;i++) printf "%s ", $i}' "$exports_file" | head -c 40)
                    menu_items+=("$path" "${clients:-no clients}")
                done
                menu_items+=("Back" "Return to menu")
            else
                whiptail --title "⚠️ Warning" --msgbox "Export updated but exportfs failed.\nCheck configuration manually." 10 55
            fi
        fi
    done
}

nfs_menu() {
    while true; do
        local choice
        choice=$(whiptail --title "═══ 📂 NFS Access Management ═══" --menu "\
  Manage NFS share permissions
  ─────────────────────────────────────────────" 18 60 5 \
            "1" "📊 View Current Shares & Clients" \
            "2" "✏️  Edit Access Rights" \
            "3" "🔄 Refresh Exports" \
            "4" "📋 View Raw /etc/exports" \
            "5" "🔙 Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_nfs_exports ;;
            2) edit_nfs_clients ;;
            3)
                if sudo exportfs -ra 2>/dev/null; then
                    whiptail --title "✅ Success" --msgbox "NFS exports refreshed successfully!" 8 45
                else
                    whiptail --title "❌ Error" --msgbox "Failed to refresh NFS exports.\nCheck /etc/exports for errors." 10 50
                fi
                ;;
            4)
                if [[ -f /etc/exports ]]; then
                    whiptail --title "📋 /etc/exports" --scrolltext --textbox /etc/exports 20 70
                else
                    whiptail --title "📋 /etc/exports" --msgbox "File not found." 8 40
                fi
                ;;
            5) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Quick Actions
# ═══════════════════════════════════════════════════════════════════════════════

quick_actions_menu() {
    while true; do
        local choice
        choice=$(whiptail --title "═══ ⚡ Quick Actions ═══" --menu "\
  Common administrative tasks
  ─────────────────────────────────────────────" 18 60 6 \
            "1" "📊 Show xinas-status" \
            "2" "🔄 Restart NFS Server" \
            "3" "📋 View System Logs" \
            "4" "💾 Check Disk Health" \
            "5" "🔍 Service Status" \
            "6" "🔙 Back" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_status ;;
            2)
                if whiptail --title "🔄 Restart NFS" --yesno "\
   Restart the NFS server?

   ⚠️  Active client connections may be
   temporarily interrupted.
" 11 50; then
                    if sudo systemctl restart nfs-server 2>/dev/null; then
                        whiptail --title "✅ Success" --msgbox "NFS server restarted successfully!" 8 45
                    else
                        whiptail --title "❌ Error" --msgbox "Failed to restart NFS server." 8 45
                    fi
                fi
                ;;
            3)
                local out="$TMP_DIR/logs"
                {
                    echo "═══ Recent System Messages ═══"
                    echo ""
                    journalctl -n 50 --no-pager 2>/dev/null || dmesg | tail -50
                } > "$out"
                whiptail --title "📋 System Logs" --scrolltext --textbox "$out" 24 78
                ;;
            4)
                local out="$TMP_DIR/disks"
                {
                    echo "═══ Disk Health Status ═══"
                    echo ""
                    if command -v xicli &>/dev/null; then
                        xicli drive show 2>&1
                    else
                        lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,STATE 2>/dev/null
                        echo ""
                        df -h 2>/dev/null
                    fi
                } > "$out"
                whiptail --title "💾 Disk Health" --scrolltext --textbox "$out" 24 78
                ;;
            5)
                local out="$TMP_DIR/services"
                {
                    echo "═══ Service Status ═══"
                    echo ""
                    for svc in nfs-server xiraid nfsdcld rpcbind; do
                        status=$(systemctl is-active "$svc" 2>/dev/null || echo "not found")
                        case "$status" in
                            active) icon="✓" ;;
                            inactive) icon="○" ;;
                            *) icon="?" ;;
                        esac
                        printf "  %s  %-20s %s\n" "$icon" "$svc" "$status"
                    done
                } > "$out"
                whiptail --title "🔍 Services" --textbox "$out" 16 50
                ;;
            6) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Welcome Screen
# ═══════════════════════════════════════════════════════════════════════════════

show_welcome() {
    # Get quick stats for welcome screen
    local hostname
    hostname=$(hostname -f 2>/dev/null || hostname)
    local uptime_str
    uptime_str=$(uptime -p 2>/dev/null | sed 's/up //')

    # Get RAID status summary
    local raid_status="Not installed"
    if command -v xicli &>/dev/null; then
        local raid_count
        raid_count=$(xicli raid show -f json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else len(d.keys()))" 2>/dev/null || echo "0")
        [[ "$raid_count" != "0" ]] && raid_status="$raid_count array(s)"
    fi

    # Get NFS status
    local nfs_status="Stopped"
    if [[ -f /proc/fs/nfsd/threads ]]; then
        local threads
        threads=$(cat /proc/fs/nfsd/threads 2>/dev/null)
        nfs_status="Running ($threads threads)"
    fi

    whiptail --title "✨ xiNAS Management Console" --msgbox "\
   Welcome back to your NAS server!

   ┌─────────────────────────────────────────────┐
   │  🖥️  Host:    $hostname
   │  ⏱️  Uptime:  $uptime_str
   │  💾  RAID:    $raid_status
   │  📂  NFS:     $nfs_status
   └─────────────────────────────────────────────┘

   Select an option from the menu to manage
   your storage system.

   Need help? Contact: support@xinnor.io
" 20 55
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main Menu
# ═══════════════════════════════════════════════════════════════════════════════

main_menu() {
    # Show welcome on first run (can be skipped with --no-welcome)
    if [[ "${1:-}" != "--no-welcome" ]]; then
        show_welcome
    fi

    while true; do
        local choice
        choice=$(whiptail --title "═══ xiNAS Management ═══" --menu "\
  $(hostname) | $(uptime -p 2>/dev/null | sed 's/up //')
  ─────────────────────────────────────────────" 20 60 8 \
            "1" "📊 System Status" \
            "2" "💾 RAID Management" \
            "3" "🌐 Network Settings" \
            "4" "📂 NFS Access Rights" \
            "5" "⚡ Quick Actions" \
            "6" "🚪 Exit" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_status ;;
            2) raid_menu ;;
            3) network_menu ;;
            4) nfs_menu ;;
            5) quick_actions_menu ;;
            6)
                whiptail --title "👋 See you soon!" --msgbox "\
   Thank you for using xiNAS!

   Run this menu again anytime:
     post_install_menu.sh

   Or view status with:
     xinas-status

   Questions? support@xinnor.io
" 14 50
                exit 0
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

# Handle command line arguments
case "${1:-}" in
    --status|-s)
        # Quick status view
        if command -v xinas-status &>/dev/null; then
            xinas-status
        else
            echo "xinas-status not found"
        fi
        exit 0
        ;;
    --raid|-r)
        # Quick RAID info
        if command -v xicli &>/dev/null; then
            xicli raid show
        else
            echo "xicli not found"
        fi
        exit 0
        ;;
    --help|-h)
        echo "xiNAS Post-Install Management Menu"
        echo ""
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --status, -s     Show system status and exit"
        echo "  --raid, -r       Show RAID info and exit"
        echo "  --no-welcome     Skip welcome screen"
        echo "  --help, -h       Show this help message"
        echo ""
        echo "Without options, launches the interactive menu."
        exit 0
        ;;
    --no-welcome)
        main_menu --no-welcome
        ;;
    *)
        main_menu
        ;;
esac
