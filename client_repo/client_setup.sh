#!/usr/bin/env bash
# xiNAS Client Setup Menu
# Emotionally-designed interactive menu for NFS client configuration
# Supports both RDMA and TCP transports

set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
NC='\033[0m'

# Check for root
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Please run: sudo $0"
    exit 1
fi

# Check for whiptail
WHIPTAIL=$(command -v whiptail || true)
if [[ -z "$WHIPTAIL" ]]; then
    echo -e "${YELLOW}Installing whiptail...${NC}"
    if command -v apt-get &>/dev/null; then
        apt-get update -qq && apt-get install -y -qq whiptail
    elif command -v yum &>/dev/null; then
        yum install -y newt
    fi
    WHIPTAIL=$(command -v whiptail || true)
fi

if [[ -z "$WHIPTAIL" ]]; then
    echo -e "${RED}Error: whiptail is required for this menu${NC}"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Display Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_header() {
    clear
    echo -e "${BLUE}"
    cat << 'EOF'

    ██╗  ██╗██╗███╗   ██╗ █████╗ ███████╗
    ╚██╗██╔╝██║████╗  ██║██╔══██╗██╔════╝
     ╚███╔╝ ██║██╔██╗ ██║███████║███████╗
     ██╔██╗ ██║██║╚██╗██║██╔══██║╚════██║
    ██╔╝ ██╗██║██║ ╚████║██║  ██║███████║
    ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝
EOF
    echo -e "${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}     NFS Client Setup${NC}"
    echo -e "${GREEN}    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

show_welcome() {
    show_header

    # Get current mount status
    local nfs_mounts
    nfs_mounts=$(mount -t nfs,nfs4 2>/dev/null | wc -l || echo "0")

    # Check RDMA support
    local rdma_status="Not available"
    local rdma_icon="${RED}○${NC}"
    if [[ -d /sys/class/infiniband ]] && ls /sys/class/infiniband/ &>/dev/null; then
        rdma_status="Available"
        rdma_icon="${GREEN}●${NC}"
    fi

    # Check nfs-common
    local nfs_status="Not installed"
    local nfs_icon="${RED}○${NC}"
    if command -v mount.nfs &>/dev/null || command -v mount.nfs4 &>/dev/null; then
        nfs_status="Installed"
        nfs_icon="${GREEN}●${NC}"
    fi

    echo -e "${WHITE}    ┌─────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${WHITE}    │${NC}  ${CYAN}✨ Welcome to xiNAS Client Setup!${NC}                          ${WHITE}│${NC}"
    echo -e "${WHITE}    └─────────────────────────────────────────────────────────────┘${NC}"
    echo ""
    echo -e "    ${WHITE}SYSTEM STATUS${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "        ${WHITE}Hostname:${NC}    ${CYAN}$(hostname)${NC}"
    echo -e "        ${WHITE}NFS Tools:${NC}   $nfs_icon $nfs_status"
    echo -e "        ${WHITE}RDMA:${NC}        $rdma_icon $rdma_status"
    echo -e "        ${WHITE}NFS Mounts:${NC}  ${GREEN}$nfs_mounts active${NC}"
    echo ""
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo -e "    ${WHITE}QUICK START${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    echo -e "    ${GREEN}①${NC}  ${WHITE}Install NFS Tools${NC} ${DIM}(if not installed)${NC}"
    echo -e "    ${GREEN}②${NC}  ${WHITE}Install DOCA OFED${NC} ${DIM}(for RDMA support)${NC}"
    echo -e "    ${GREEN}③${NC}  ${WHITE}Connect to NAS${NC} ${DIM}(mount NFS share)${NC}"
    echo ""
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo -e "    ${DIM}Need help?${NC} ${CYAN}support@xinnor.io${NC}"
    echo -e "    ${DIM}────────────────────────────────────────────────────────────${NC}"
    echo ""
    read -p "    Press Enter to continue..." -r
}

# ═══════════════════════════════════════════════════════════════════════════════
# System Status Functions
# ═══════════════════════════════════════════════════════════════════════════════

show_status() {
    local out="$TMP_DIR/status"

    {
        echo "CLIENT SYSTEM STATUS"
        printf '=%.0s' {1..70}; echo ""
        echo ""

        echo "  Hostname:  $(hostname)"
        echo "  Kernel:    $(uname -r)"
        echo ""

        # NFS tools status
        echo "NFS TOOLS"
        printf -- '-%.0s' {1..70}; echo ""
        if command -v mount.nfs4 &>/dev/null; then
            echo "  [OK] NFS client tools installed"
            local nfs_version
            nfs_version=$(rpcinfo -p 2>/dev/null | grep -m1 nfs | awk '{print $2}' || echo "N/A")
            echo "       NFS version: $nfs_version"
        else
            echo "  [!!] NFS client tools NOT installed"
            echo "       Install with: apt-get install nfs-common"
        fi
        echo ""

        # RDMA status
        echo "RDMA SUPPORT"
        printf -- '-%.0s' {1..70}; echo ""
        if [[ -d /sys/class/infiniband ]]; then
            local ib_devices
            ib_devices=$(ls /sys/class/infiniband/ 2>/dev/null | tr '\n' ' ')
            if [[ -n "$ib_devices" ]]; then
                echo "  [OK] RDMA devices found: $ib_devices"
                # Show link status
                for dev in /sys/class/infiniband/*/ports/*/state; do
                    [[ -f "$dev" ]] || continue
                    local state
                    state=$(cat "$dev" 2>/dev/null | awk '{print $2}')
                    local dev_name
                    dev_name=$(echo "$dev" | sed 's|/sys/class/infiniband/||;s|/ports.*||')
                    local port
                    port=$(echo "$dev" | grep -oP 'ports/\K\d+')
                    echo "       $dev_name port $port: $state"
                done
            else
                echo "  [--] RDMA module loaded but no devices"
            fi
        else
            echo "  [!!] RDMA not available"
            echo "       Install DOCA OFED for RDMA support"
        fi
        echo ""

        # Current NFS mounts
        echo "ACTIVE NFS MOUNTS"
        printf -- '-%.0s' {1..70}; echo ""
        local mounts
        mounts=$(mount -t nfs,nfs4 2>/dev/null)
        if [[ -n "$mounts" ]]; then
            echo "$mounts" | while read -r line; do
                local server share mountpoint
                server=$(echo "$line" | awk -F: '{print $1}')
                share=$(echo "$line" | awk '{print $1}' | cut -d: -f2)
                mountpoint=$(echo "$line" | awk '{print $3}')
                local opts
                opts=$(echo "$line" | grep -oP '\(\K[^)]+')

                echo "  [*] $mountpoint"
                echo "      Server: $server"
                echo "      Share:  $share"
                if [[ "$opts" == *"rdma"* ]]; then
                    echo "      Mode:   RDMA (high-performance)"
                else
                    echo "      Mode:   TCP"
                fi
                echo ""
            done
        else
            echo "  No NFS mounts active"
            echo ""
        fi

        # /etc/fstab NFS entries
        echo "CONFIGURED MOUNTS (fstab)"
        printf -- '-%.0s' {1..70}; echo ""
        local fstab_nfs
        fstab_nfs=$(grep -E '^\s*[^#].*\snfs' /etc/fstab 2>/dev/null || true)
        if [[ -n "$fstab_nfs" ]]; then
            echo "$fstab_nfs" | while read -r line; do
                local server mountpoint
                server=$(echo "$line" | awk '{print $1}')
                mountpoint=$(echo "$line" | awk '{print $2}')
                echo "  $server -> $mountpoint"
            done
        else
            echo "  No NFS entries in /etc/fstab"
        fi
        echo ""

        printf '=%.0s' {1..70}; echo ""
    } > "$out"

    whiptail --title "System Status" --scrolltext --textbox "$out" 28 76
}

# ═══════════════════════════════════════════════════════════════════════════════
# NFS Mount Configuration
# ═══════════════════════════════════════════════════════════════════════════════

install_nfs_tools() {
    if command -v mount.nfs4 &>/dev/null; then
        whiptail --title "Already Installed" --msgbox "\
NFS client tools are already installed.

You can proceed to mount NFS shares." 10 50
        return 0
    fi

    if whiptail --title "Install NFS Tools" --yesno "\
NFS client tools are not installed.

Install them now?

This will install:
  - nfs-common (Debian/Ubuntu)
  - nfs-utils (RHEL/CentOS)" 14 50; then

        whiptail --title "Installing..." --infobox "Installing NFS client tools..." 6 45

        if command -v apt-get &>/dev/null; then
            apt-get update -qq
            apt-get install -y -qq nfs-common
        elif command -v yum &>/dev/null; then
            yum install -y nfs-utils
        elif command -v dnf &>/dev/null; then
            dnf install -y nfs-utils
        else
            whiptail --title "Error" --msgbox "Could not detect package manager." 8 45
            return 1
        fi

        # Configure NFS client for better performance
        echo "options nfs max_session_slots=180" > /etc/modprobe.d/nfsclient.conf

        whiptail --title "Success" --msgbox "\
NFS client tools installed successfully!

You can now mount NFS shares from your xiNAS server." 10 55
    fi
}

configure_nfs_mount() {
    # Check if NFS tools are installed
    if ! command -v mount.nfs4 &>/dev/null; then
        if whiptail --title "NFS Tools Required" --yesno "\
NFS client tools are not installed.

Install them now?" 10 45; then
            install_nfs_tools
        else
            return
        fi
    fi

    # Step 1: Select protocol
    local protocol
    protocol=$(whiptail --title "Step 1: Select Protocol" --menu "\
Choose the connection protocol:

RDMA provides much higher performance but requires
compatible network hardware (InfiniBand/RoCE).

TCP works with any network." 18 60 2 \
        "RDMA" "High-performance (requires DOCA OFED)" \
        "TCP" "Standard (works everywhere)" \
        3>&1 1>&2 2>&3) || return

    # Check RDMA availability if selected
    if [[ "$protocol" == "RDMA" ]]; then
        if [[ ! -d /sys/class/infiniband ]] || [[ -z "$(ls /sys/class/infiniband/ 2>/dev/null)" ]]; then
            if ! whiptail --title "RDMA Not Available" --yesno "\
RDMA hardware not detected on this system.

Would you like to:
- Yes: Continue with TCP instead
- No: Cancel and install DOCA OFED first" 12 55; then
                return
            fi
            protocol="TCP"
        fi
    fi

    # Step 2: Enter server IP
    local server_ip
    server_ip=$(whiptail --title "Step 2: Server Address" --inputbox "\
Enter the IP address of your xiNAS server:

Example: 192.168.1.100 or 10.10.1.1

This is the storage network IP of your NAS." 14 55 "10.10.1.1" 3>&1 1>&2 2>&3) || return

    [[ -z "$server_ip" ]] && return

    # Validate IP format
    if [[ ! "$server_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        whiptail --title "Invalid IP" --msgbox "Please enter a valid IP address." 8 45
        return
    fi

    # Step 3: Enter remote share path
    local share_path
    share_path=$(whiptail --title "Step 3: Share Path" --inputbox "\
Enter the NFS share path on the server:

Examples:
  /mnt/data      - Data volume
  /              - Root export

Ask your NAS administrator if unsure." 14 55 "/mnt/data" 3>&1 1>&2 2>&3) || return

    [[ -z "$share_path" ]] && share_path="/"

    # Step 4: Enter local mount point
    local mount_point
    mount_point=$(whiptail --title "Step 4: Mount Point" --inputbox "\
Enter the local directory to mount the share:

This directory will be created if it doesn't exist.

Example: /mnt/nas" 12 55 "/mnt/nas" 3>&1 1>&2 2>&3) || return

    [[ -z "$mount_point" ]] && mount_point="/mnt/nas"

    # Step 5: Mount options
    local add_to_fstab="yes"
    if whiptail --title "Step 5: Persistent Mount" --yesno "\
Add this mount to /etc/fstab?

If yes, the share will be automatically
mounted when the system boots.

Recommended: Yes" 12 50; then
        add_to_fstab="yes"
    else
        add_to_fstab="no"
    fi

    # Build mount options
    local mount_opts
    if [[ "$protocol" == "RDMA" ]]; then
        mount_opts="rdma,port=20049,nconnect=16,vers=4.2,sync"
    else
        mount_opts="nconnect=16,vers=4.2,sync"
    fi

    # Confirm settings
    local proto_desc="TCP (standard)"
    [[ "$protocol" == "RDMA" ]] && proto_desc="RDMA (high-performance)"

    if ! whiptail --title "Confirm Settings" --yesno "\
Please review your mount configuration:

Server:      $server_ip
Share:       $share_path
Mount Point: $mount_point
Protocol:    $proto_desc
Persistent:  $add_to_fstab

Proceed with mounting?" 16 55; then
        return
    fi

    # Create mount point
    mkdir -p "$mount_point"

    # Attempt to mount
    whiptail --title "Mounting..." --infobox "Connecting to $server_ip..." 6 45

    local mount_cmd="mount -t nfs -o $mount_opts $server_ip:$share_path $mount_point"
    local mount_log="$TMP_DIR/mount.log"

    if $mount_cmd > "$mount_log" 2>&1; then
        # Success - add to fstab if requested
        if [[ "$add_to_fstab" == "yes" ]]; then
            # Remove any existing entry for this mount point
            sed -i "\|^.*[[:space:]]$mount_point[[:space:]]|d" /etc/fstab 2>/dev/null || true
            # Add new entry
            echo "$server_ip:$share_path $mount_point nfs $mount_opts 0 0" >> /etc/fstab
        fi

        # Get actual mount info
        local actual_opts
        actual_opts=$(mount | grep "$mount_point" | grep -oP '\(\K[^)]+' || echo "$mount_opts")

        whiptail --title "Success!" --msgbox "\
NFS share mounted successfully!

Server:      $server_ip
Share:       $share_path
Mount Point: $mount_point
Protocol:    $proto_desc

You can now access your files at:
  $mount_point

$([ "$add_to_fstab" == "yes" ] && echo "This mount will persist across reboots.")" 18 55
    else
        # Mount failed
        local error_msg
        error_msg=$(cat "$mount_log")

        whiptail --title "Mount Failed" --msgbox "\
Failed to mount NFS share.

Error: $error_msg

Troubleshooting:
- Check server IP is correct
- Verify NFS server is running
- Check firewall settings
- For RDMA: ensure DOCA OFED is installed" 16 60
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Mount Management
# ═══════════════════════════════════════════════════════════════════════════════

manage_mounts() {
    while true; do
        # Get current NFS mounts
        local mounts=()
        local mount_info=()

        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            local mp
            mp=$(echo "$line" | awk '{print $3}')
            local server
            server=$(echo "$line" | awk '{print $1}')
            mounts+=("$mp")
            mount_info+=("$mp" "$server")
        done < <(mount -t nfs,nfs4 2>/dev/null)

        if [[ ${#mounts[@]} -eq 0 ]]; then
            whiptail --title "No Mounts" --msgbox "\
No active NFS mounts found.

Use 'Connect to NAS' to mount a share." 10 50
            return
        fi

        mount_info+=("" "")
        mount_info+=("Back" "Return to main menu")

        local choice
        choice=$(whiptail --title "Manage NFS Mounts" --menu "\
Select a mount to manage:

Active NFS mounts: ${#mounts[@]}" 18 65 8 \
            "${mount_info[@]}" 3>&1 1>&2 2>&3) || return

        [[ "$choice" == "Back" || -z "$choice" ]] && return

        # Show mount details and options
        local server share opts
        server=$(mount | grep " $choice " | awk '{print $1}' | cut -d: -f1)
        share=$(mount | grep " $choice " | awk '{print $1}' | cut -d: -f2)
        opts=$(mount | grep " $choice " | grep -oP '\(\K[^)]+')

        local action
        action=$(whiptail --title "Mount: $choice" --menu "\
Server: $server
Share:  $share
Options: $opts

Select action:" 18 60 4 \
            "1" "View Details" \
            "2" "Unmount" \
            "3" "Remount" \
            "4" "Back" \
            3>&1 1>&2 2>&3) || continue

        case "$action" in
            1)
                local details="$TMP_DIR/mount_details"
                {
                    echo "MOUNT DETAILS"
                    printf '=%.0s' {1..60}; echo ""
                    echo ""
                    echo "  Mount Point: $choice"
                    echo "  Server:      $server"
                    echo "  Share:       $share"
                    echo ""
                    echo "  Options:"
                    echo "  $opts" | tr ',' '\n' | sed 's/^/    /'
                    echo ""
                    echo "  Disk Usage:"
                    df -h "$choice" 2>/dev/null | tail -1 | awk '{print "    Used: "$3" / "$2" ("$5")"}'
                    echo ""
                    printf '=%.0s' {1..60}; echo ""
                } > "$details"
                whiptail --title "Mount Details" --textbox "$details" 20 65
                ;;
            2)
                if whiptail --title "Unmount" --yesno "\
Unmount $choice?

Server: $server:$share

Make sure no programs are using this mount." 12 55; then
                    if umount "$choice" 2>/dev/null; then
                        whiptail --title "Unmounted" --msgbox "Successfully unmounted $choice" 8 50
                    else
                        whiptail --title "Error" --msgbox "\
Failed to unmount.

The mount may be in use. Try:
  lsof +f -- $choice" 12 55
                    fi
                fi
                ;;
            3)
                if whiptail --title "Remount" --yesno "Remount $choice?" 8 45; then
                    if mount -o remount "$choice" 2>/dev/null; then
                        whiptail --title "Remounted" --msgbox "Successfully remounted $choice" 8 50
                    else
                        whiptail --title "Error" --msgbox "Failed to remount." 8 40
                    fi
                fi
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# DOCA OFED Installation
# ═══════════════════════════════════════════════════════════════════════════════

install_doca_ofed() {
    # Check if already installed
    if [[ -d /sys/class/infiniband ]] && command -v ibstat &>/dev/null; then
        local ib_devices
        ib_devices=$(ls /sys/class/infiniband/ 2>/dev/null | tr '\n' ' ')
        if [[ -n "$ib_devices" ]]; then
            whiptail --title "DOCA OFED Status" --msgbox "\
DOCA OFED appears to be installed.

Detected devices: $ib_devices

If you need to reinstall, use:
  ansible-playbook playbooks/doca_ofed_install.yml" 12 55
            return
        fi
    fi

    if ! whiptail --title "Install DOCA OFED" --yesno "\
Install NVIDIA DOCA OFED drivers?

This enables RDMA support for high-performance
NFS connections (NFS over RDMA).

Requirements:
- Compatible network adapter (ConnectX, etc.)
- Internet connection for package download
- System reboot after installation

Proceed with installation?" 16 55; then
        return
    fi

    # Check for Ansible
    if ! command -v ansible-playbook &>/dev/null; then
        whiptail --title "Installing Ansible..." --infobox "Installing Ansible..." 6 40
        if command -v apt-get &>/dev/null; then
            apt-get update -qq
            apt-get install -y -qq ansible
        elif command -v yum &>/dev/null; then
            yum install -y ansible
        else
            whiptail --title "Error" --msgbox "Could not install Ansible." 8 45
            return 1
        fi
    fi

    # Run the playbook
    local playbook="$SCRIPT_DIR/playbooks/doca_ofed_install.yml"
    if [[ ! -f "$playbook" ]]; then
        whiptail --title "Error" --msgbox "Playbook not found:\n$playbook" 10 55
        return 1
    fi

    local log="$TMP_DIR/ansible.log"

    whiptail --title "Installing DOCA OFED" --infobox "\
Installing NVIDIA DOCA OFED...

This may take several minutes.
Please wait..." 10 50

    cd "$SCRIPT_DIR"
    if ansible-playbook "$playbook" -i inventories/lab.ini > "$log" 2>&1; then
        whiptail --title "Installation Complete" --msgbox "\
DOCA OFED installed successfully!

A system reboot is recommended to load
the new kernel modules.

After reboot, RDMA will be available for
high-performance NFS connections." 14 55

        if whiptail --title "Reboot Now?" --yesno "\
Reboot the system now?

RDMA will not be available until reboot." 10 50; then
            reboot
        fi
    else
        whiptail --title "Installation Failed" --scrolltext --textbox "$log" 20 70
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Connection Test
# ═══════════════════════════════════════════════════════════════════════════════

test_connection() {
    local server_ip
    server_ip=$(whiptail --title "Test Connection" --inputbox "\
Enter the xiNAS server IP to test:

This will check network connectivity and
NFS service availability." 12 55 "10.10.1.1" 3>&1 1>&2 2>&3) || return

    [[ -z "$server_ip" ]] && return

    local out="$TMP_DIR/test_result"

    {
        echo "CONNECTION TEST RESULTS"
        printf '=%.0s' {1..60}; echo ""
        echo ""
        echo "Target: $server_ip"
        echo ""

        # Ping test
        echo "1. Network Connectivity (ping)"
        printf -- '-%.0s' {1..60}; echo ""
        if ping -c 2 -W 2 "$server_ip" &>/dev/null; then
            echo "   [OK] Host is reachable"
        else
            echo "   [!!] Host unreachable - check network"
        fi
        echo ""

        # NFS port test
        echo "2. NFS Service (port 2049)"
        printf -- '-%.0s' {1..60}; echo ""
        if timeout 3 bash -c "echo >/dev/tcp/$server_ip/2049" 2>/dev/null; then
            echo "   [OK] NFS port is open"
        else
            echo "   [!!] NFS port closed or filtered"
        fi
        echo ""

        # RDMA port test
        echo "3. NFS-RDMA Service (port 20049)"
        printf -- '-%.0s' {1..60}; echo ""
        if timeout 3 bash -c "echo >/dev/tcp/$server_ip/20049" 2>/dev/null; then
            echo "   [OK] NFS-RDMA port is open"
        else
            echo "   [--] NFS-RDMA port not available"
            echo "       (Normal if RDMA not configured)"
        fi
        echo ""

        # RPC info
        echo "4. RPC Services"
        printf -- '-%.0s' {1..60}; echo ""
        if command -v rpcinfo &>/dev/null; then
            local rpc_out
            rpc_out=$(rpcinfo -p "$server_ip" 2>/dev/null | grep -E 'nfs|mountd' | head -5)
            if [[ -n "$rpc_out" ]]; then
                echo "   [OK] NFS services detected:"
                echo "$rpc_out" | sed 's/^/       /'
            else
                echo "   [!!] No NFS services found"
            fi
        else
            echo "   [--] rpcinfo not available"
        fi
        echo ""

        # Show exports if possible
        echo "5. Available Exports"
        printf -- '-%.0s' {1..60}; echo ""
        if command -v showmount &>/dev/null; then
            local exports
            exports=$(showmount -e "$server_ip" 2>/dev/null | tail -n +2)
            if [[ -n "$exports" ]]; then
                echo "   [OK] Exports found:"
                echo "$exports" | sed 's/^/       /'
            else
                echo "   [--] No exports visible (may be access restricted)"
            fi
        else
            echo "   [--] showmount not available"
        fi
        echo ""

        printf '=%.0s' {1..60}; echo ""
    } > "$out"

    whiptail --title "Connection Test: $server_ip" --scrolltext --textbox "$out" 28 70
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main Menu
# ═══════════════════════════════════════════════════════════════════════════════

main_menu() {
    show_welcome

    while true; do
        # Get quick status for menu
        local nfs_mounts
        nfs_mounts=$(mount -t nfs,nfs4 2>/dev/null | wc -l || echo "0")

        local rdma_status="No"
        [[ -d /sys/class/infiniband ]] && [[ -n "$(ls /sys/class/infiniband/ 2>/dev/null)" ]] && rdma_status="Yes"

        local choice
        choice=$(whiptail --title "═══ xiNAS Client Setup ═══" --menu "\
  $(hostname) | Mounts: $nfs_mounts | RDMA: $rdma_status
  ─────────────────────────────────────────────" 20 60 8 \
            "1" "📊 System Status" \
            "2" "🔌 Connect to NAS" \
            "3" "📁 Manage Mounts" \
            "4" "🔧 Install NFS Tools" \
            "5" "⚡ Install DOCA OFED" \
            "6" "🔍 Test Connection" \
            "7" "🚪 Exit" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) show_status ;;
            2) configure_nfs_mount ;;
            3) manage_mounts ;;
            4) install_nfs_tools ;;
            5) install_doca_ofed ;;
            6) test_connection ;;
            7)
                whiptail --title "See you soon!" --msgbox "\
   Thank you for using xiNAS Client Setup!

   Run this menu again anytime:
     sudo ./client_setup.sh

   Questions? support@xinnor.io
" 12 50
                exit 0
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

case "${1:-}" in
    --status|-s)
        mount -t nfs,nfs4 2>/dev/null || echo "No NFS mounts"
        exit 0
        ;;
    --mount|-m)
        # Quick mount mode
        shift
        if [[ $# -lt 2 ]]; then
            echo "Usage: $0 --mount SERVER:SHARE MOUNTPOINT [rdma|tcp]"
            exit 1
        fi
        server_share="$1"
        mount_point="$2"
        proto="${3:-tcp}"

        mkdir -p "$mount_point"
        if [[ "$proto" == "rdma" ]]; then
            opts="rdma,port=20049,nconnect=16,vers=4.2,sync"
        else
            opts="nconnect=16,vers=4.2,sync"
        fi
        mount -t nfs -o "$opts" "$server_share" "$mount_point"
        exit $?
        ;;
    --help|-h)
        echo "xiNAS Client Setup"
        echo ""
        echo "Usage: sudo $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --status, -s              Show current NFS mounts"
        echo "  --mount, -m SERVER MOUNT  Quick mount (e.g., -m 10.10.1.1:/data /mnt/nas)"
        echo "  --help, -h                Show this help"
        echo ""
        echo "Without options, launches the interactive menu."
        exit 0
        ;;
    *)
        main_menu
        ;;
esac
