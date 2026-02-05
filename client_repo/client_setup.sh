#!/usr/bin/env bash
# xiNAS Client Setup Menu
# Emotionally-designed interactive menu for NFS client configuration
# Supports both RDMA and TCP transports

set -euo pipefail

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Version tracking
CLIENT_VERSION="1.7.0"

# Network configuration file
NETWORK_CONFIG="$SCRIPT_DIR/network_config.yml"
UPDATE_AVAILABLE=""

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
NC='\033[0m'

# ═══════════════════════════════════════════════════════════════════════════════
# Update Check
# ═══════════════════════════════════════════════════════════════════════════════

check_for_updates() {
    # Only check if installed via git (standard install location)
    local install_dir="/opt/xinas-client"
    local git_dir="$install_dir/.git"

    # Also check if running from a git repo directly
    if [[ ! -d "$git_dir" ]]; then
        git_dir="$SCRIPT_DIR/../.git"
        [[ -d "$git_dir" ]] || git_dir="$SCRIPT_DIR/.git"
        [[ -d "$git_dir" ]] || return 0  # Not a git install, skip check
        install_dir="$(dirname "$git_dir")"
    fi

    # Skip if no git command
    command -v git &>/dev/null || return 0

    # Skip if no network (quick check)
    timeout 2 bash -c "echo >/dev/tcp/github.com/443" 2>/dev/null || return 0

    # Get local commit
    local local_commit
    local_commit=$(git -C "$install_dir" rev-parse HEAD 2>/dev/null) || return 0

    # Fetch latest (quiet, background-friendly)
    git -C "$install_dir" fetch --quiet origin main 2>/dev/null || return 0

    # Get remote commit
    local remote_commit
    remote_commit=$(git -C "$install_dir" rev-parse origin/main 2>/dev/null) || return 0

    # Compare
    if [[ "$local_commit" != "$remote_commit" ]]; then
        UPDATE_AVAILABLE="true"
    fi
}

show_update_banner() {
    if [[ "$UPDATE_AVAILABLE" == "true" ]]; then
        echo -e "${YELLOW}    ┌─────────────────────────────────────────────────────────────┐${NC}"
        echo -e "${YELLOW}    │${NC}  ${CYAN}📦 Update available!${NC} Run: ${WHITE}curl -fsSL https://xinnor.io/install_client.sh | sudo bash${NC}"
        echo -e "${YELLOW}    └─────────────────────────────────────────────────────────────┘${NC}"
        echo ""
    fi
}

# Run update check in background to avoid slowing startup
check_for_updates &
UPDATE_CHECK_PID=$!

# Check for root
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Please run: sudo $0"
    exit 1
fi

# Source the menu library (check multiple locations)
if [[ -f "$SCRIPT_DIR/lib/menu_lib.sh" ]]; then
    source "$SCRIPT_DIR/lib/menu_lib.sh"
elif [[ -f "/usr/local/bin/lib/menu_lib.sh" ]]; then
    source "/usr/local/bin/lib/menu_lib.sh"
elif [[ -f "/opt/xinas-client/lib/menu_lib.sh" ]]; then
    source "/opt/xinas-client/lib/menu_lib.sh"
else
    echo -e "${RED}Error: menu_lib.sh not found${NC}"
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

    # Wait for update check to complete (with timeout)
    if [[ -n "${UPDATE_CHECK_PID:-}" ]]; then
        # Wait up to 3 seconds for the background check
        for _ in {1..30}; do
            kill -0 "$UPDATE_CHECK_PID" 2>/dev/null || break
            sleep 0.1
        done 2>/dev/null
        wait "$UPDATE_CHECK_PID" 2>/dev/null || true
    fi

    # Show update banner if available
    show_update_banner

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
    echo -e "    ${GREEN}③${NC}  ${WHITE}Configure Network${NC} ${DIM}(storage network IPs)${NC}"
    echo -e "    ${GREEN}④${NC}  ${WHITE}Connect to NAS${NC} ${DIM}(mount NFS share)${NC}"
    echo -e "    ${GREEN}⑤${NC}  ${WHITE}K8s CSI Driver${NC} ${DIM}(for Kubernetes volumes)${NC}"
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

        # High-speed network interfaces
        echo "HIGH-SPEED NETWORK INTERFACES"
        printf -- '-%.0s' {1..70}; echo ""
        local hs_found=0
        for iface in /sys/class/net/*; do
            [ -d "$iface" ] || continue
            local name
            name=$(basename "$iface")
            [ "$name" = "lo" ] && continue
            [ -e "$iface/device" ] || continue

            local type driver
            type=$(cat "$iface/type" 2>/dev/null || echo "0")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")

            if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                local ip_addr speed state
                ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}')
                [[ -z "$ip_addr" ]] && ip_addr="no IP"
                speed=$(cat "$iface/speed" 2>/dev/null || echo "unknown")
                state=$(cat "$iface/operstate" 2>/dev/null || echo "unknown")
                echo "  [*] $name"
                echo "      IP:     $ip_addr"
                echo "      Speed:  ${speed}Mb/s"
                echo "      State:  $state"
                echo "      Driver: $driver"
                hs_found=1
            fi
        done
        [[ $hs_found -eq 0 ]] && echo "  No high-speed interfaces detected"
        echo ""

        printf '=%.0s' {1..70}; echo ""
    } > "$out"

    text_box "System Status" "$out"
}

# ═══════════════════════════════════════════════════════════════════════════════
# NFS Mount Configuration
# ═══════════════════════════════════════════════════════════════════════════════

install_nfs_tools() {
    if command -v mount.nfs4 &>/dev/null; then
        msg_box "Already Installed" "\
NFS client tools are already installed.

You can proceed to mount NFS shares."
        return 0
    fi

    if yes_no "Install NFS Tools" "\
NFS client tools are not installed.

Install them now?

This will install:
  - nfs-common (Debian/Ubuntu)
  - nfs-utils (RHEL/CentOS)"; then

        info_box "Installing..." "Installing NFS client tools..."

        if command -v apt-get &>/dev/null; then
            apt-get update -qq
            apt-get install -y -qq nfs-common
        elif command -v yum &>/dev/null; then
            yum install -y nfs-utils
        elif command -v dnf &>/dev/null; then
            dnf install -y nfs-utils
        else
            msg_box "Error" "Could not detect package manager."
            return 1
        fi

        # Configure NFS client kernel module for better performance
        cat > /etc/modprobe.d/nfsclient.conf <<'EOF'
# NFS client performance tuning for high-throughput workloads
options nfs max_session_slots=180
options nfs max_session_cb_slots=48
options nfs callback_nr_threads=10
options nfs nfs4_disable_idmapping=1
options nfs nfs_idmap_cache_timeout=900
options nfs delay_retrans=-1
options nfs nfs_access_max_cachesize=4194304
options nfs enable_ino64=1
EOF

        # Configure sysctl parameters for high-throughput NFS
        cat > /etc/sysctl.d/90-nfs-client.conf <<'EOF'
# Network buffer sizes for high-throughput NFS (256 MB)
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456

# Minimize swapping for better NFS performance
vm.swappiness = 10
EOF
        sysctl --system >/dev/null 2>&1

        msg_box "Success" "\
NFS client tools installed successfully!

You can now mount NFS shares from your xiNAS server."
    fi
}

configure_nfs_mount() {
    # Check if NFS tools are installed
    if ! command -v mount.nfs4 &>/dev/null; then
        if yes_no "NFS Tools Required" "\
NFS client tools are not installed.

Install them now?"; then
            install_nfs_tools
        else
            return
        fi
    fi

    # Step 1: Select protocol
    local protocol
    protocol=$(menu_select "Step 1: Select Protocol" \
        "Choose protocol (RDMA=high performance, TCP=universal)" \
        "RDMA" "High-performance (requires DOCA OFED)" \
        "TCP" "Standard (works everywhere)") || return

    # Check RDMA availability if selected
    if [[ "$protocol" == "RDMA" ]]; then
        if [[ ! -d /sys/class/infiniband ]] || [[ -z "$(ls /sys/class/infiniband/ 2>/dev/null)" ]]; then
            if ! yes_no "RDMA Not Available" "\
RDMA hardware not detected on this system.

Would you like to:
- Yes: Continue with TCP instead
- No: Cancel and install DOCA OFED first"; then
                return
            fi
            protocol="TCP"
        fi
    fi

    # Step 2: Number of server IPs (for multi-IP distribution)
    local num_ips
    num_ips=$(menu_select "Step 2: Number of Server IPs" \
        "How many IPs? Multiple IPs use session trunking." \
        "1" "Single IP (nconnect=16)" \
        "2" "Two IPs with trunking (nconnect=8 each)" \
        "4" "Four IPs with trunking (nconnect=4 each)" \
        "8" "Eight IPs with trunking (nconnect=2 each)") || return

    local nconnect=$((16 / num_ips))

    # Step 3: Enter server IP(s)
    local server_ips=()
    local i
    for ((i=1; i<=num_ips; i++)); do
        local ip_label="Server Address"
        local ip_prompt="Enter the IP address of your xiNAS server:"
        if [[ $num_ips -gt 1 ]]; then
            ip_label="Server Address $i of $num_ips"
            ip_prompt="Enter IP address $i of $num_ips:"
        fi

        local server_ip
        server_ip=$(input_box "Step 3: $ip_label" "\
$ip_prompt

Example: 192.168.1.100 or 10.10.1.1

This is the storage network IP of your NAS." "10.10.1.$i" 3>&1 1>&2 2>&3) || return

        [[ -z "$server_ip" ]] && return

        # Validate IP format
        if [[ ! "$server_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            msg_box "Invalid IP" "Please enter a valid IP address."
            return
        fi

        server_ips+=("$server_ip")
    done

    # Step 4: Enter remote share path
    local share_path
    share_path=$(input_box "Step 4: Share Path" "\
Enter the NFS share path on the server:

Examples:
  /mnt/data      - Data volume
  /              - Root export

Ask your NAS administrator if unsure." "/mnt/data" 3>&1 1>&2 2>&3) || return

    [[ -z "$share_path" ]] && share_path="/"

    # Step 5: Enter local mount point
    local mount_point_base
    local mount_point_msg="Enter the local directory to mount the share:

This directory will be created if it doesn't exist.

Example: /mnt/nas"
    if [[ $num_ips -gt 1 ]]; then
        mount_point_msg="Enter the base directory for mount points:

Each IP will be mounted to a numbered subdirectory:
  /mnt/nas/1, /mnt/nas/2, etc.

Example: /mnt/nas"
    fi
    mount_point_base=$(input_box "Step 5: Mount Point" "\
$mount_point_msg" "/mnt/nas" 3>&1 1>&2 2>&3) || return

    [[ -z "$mount_point_base" ]] && mount_point_base="/mnt/nas"

    # Step 6: Authentication
    local sec_mode="sys"
    local auth_desc="None (UID/GID)"
    if yes_no "Step 6: Authentication" "\
Does your NFS server require authentication?

Select 'Yes' if your administrator has set up
Kerberos (krb5) authentication.

Select 'No' for standard UID/GID mapping."; then
        sec_mode=$(menu_select "Step 6: Security Mode" \
            "Select NFS security mode:" \
            "krb5" "Kerberos authentication" \
            "krb5i" "Kerberos + integrity checking" \
            "krb5p" "Kerberos + encryption (most secure)" \
            "sys" "Standard UID/GID (no Kerberos)") || return

        case "$sec_mode" in
            krb5)  auth_desc="Kerberos" ;;
            krb5i) auth_desc="Kerberos + integrity" ;;
            krb5p) auth_desc="Kerberos + encryption" ;;
            sys)   auth_desc="None (UID/GID)" ;;
        esac

        # Check for Kerberos ticket if using krb5
        if [[ "$sec_mode" != "sys" ]]; then
            if ! klist &>/dev/null; then
                msg_box "⚠️ Kerberos Ticket Required" "\
No Kerberos ticket found!

Before mounting, you need to authenticate:

  kinit username@REALM

Ask your administrator for:
  - Your Kerberos username
  - The realm name (e.g., XINNOR.IO)

The mount will proceed but may fail without a valid ticket."
            fi
        fi
    fi

    # Step 7: Persistent mount
    local add_to_fstab="yes"
    if yes_no "Step 7: Persistent Mount" "\
Add this mount to /etc/fstab?

If yes, the share will be automatically
mounted when the system boots.

Recommended: Yes"; then
        add_to_fstab="yes"
    else
        add_to_fstab="no"
    fi

    # Build mount options - training profile for all variants
    # Multi-IP (2+) adds trunking (trunkdiscovery)
    local mount_opts
    local proto_desc
    local mode_desc
    local conn_desc
    local trunk_opts=""

    # Add trunking for multi-IP configurations
    if [[ $num_ips -gt 1 ]]; then
        trunk_opts=",trunkdiscovery"
    fi

    # Add security option
    local sec_opts=",sec=$sec_mode"

    if [[ "$protocol" == "RDMA" ]]; then
        # RDMA with training options
        mount_opts="vers=4.2,proto=rdma,port=20049,hard,max_connect=16,nconnect=$nconnect,rsize=1048576,wsize=1048576,lookupcache=all,acregmin=60,acregmax=600,acdirmin=60,acdirmax=600${trunk_opts}${sec_opts}"
        proto_desc="RDMA"
        if [[ $num_ips -gt 1 ]]; then
            mode_desc="training + trunking"
        else
            mode_desc="training (attribute caching)"
        fi
        conn_desc="max_connect=16, nconnect=$nconnect per IP"
    else
        # TCP with training options
        mount_opts="vers=4.2,proto=tcp,hard,max_connect=16,nconnect=$nconnect,rsize=1048576,wsize=1048576,lookupcache=all,acregmin=60,acregmax=600,acdirmin=60,acdirmax=600${trunk_opts}${sec_opts}"
        proto_desc="TCP"
        if [[ $num_ips -gt 1 ]]; then
            mode_desc="training + trunking"
        else
            mode_desc="training (attribute caching)"
        fi
        conn_desc="max_connect=16, nconnect=$nconnect per IP"
    fi

    # Confirm settings
    local ip_list="${server_ips[*]}"
    local mount_point_desc="$mount_point_base"
    if [[ $num_ips -gt 1 ]]; then
        mount_point_desc="$mount_point_base/{1..$num_ips}"
    fi

    if ! yes_no "Confirm Settings" "\
Please review your mount configuration:

Server IPs:   $ip_list
Share:        $share_path
Mount Point:  $mount_point_desc
Protocol:     $proto_desc
Mode:         $mode_desc
Auth:         $auth_desc (sec=$sec_mode)
Connections:  $conn_desc
I/O Size:     rsize/wsize=1MB
Persistent:   $add_to_fstab

Proceed with mounting?"; then
        return
    fi

    # Mount each IP
    local mount_log="$TMP_DIR/mount.log"
    local failed_mounts=()
    local successful_mounts=()

    for ((i=0; i<num_ips; i++)); do
        local current_ip="${server_ips[$i]}"
        local mount_point
        if [[ $num_ips -eq 1 ]]; then
            mount_point="$mount_point_base"
        else
            mount_point="$mount_point_base/$((i+1))"
        fi

        # Create mount point
        mkdir -p "$mount_point"

        info_box "Mounting..." "Connecting to $current_ip ($((i+1))/$num_ips)..."

        local mount_cmd="mount -t nfs -o $mount_opts $current_ip:$share_path $mount_point"

        if $mount_cmd > "$mount_log" 2>&1; then
            successful_mounts+=("$current_ip → $mount_point")

            # Add to fstab if requested
            if [[ "$add_to_fstab" == "yes" ]]; then
                # Remove any existing entry for this mount point
                sed -i "\|^.*[[:space:]]$mount_point[[:space:]]|d" /etc/fstab 2>/dev/null || true
                # Add new entry
                echo "$current_ip:$share_path $mount_point nfs $mount_opts 0 0" >> /etc/fstab
            fi
        else
            failed_mounts+=("$current_ip: $(cat "$mount_log")")
        fi
    done

    # Show results
    if [[ ${#failed_mounts[@]} -eq 0 ]]; then
        local mount_list=""
        for m in "${successful_mounts[@]}"; do
            mount_list+="  $m"$'\n'
        done

        msg_box "Success!" "NFS share(s) mounted successfully!\n\nProtocol: $proto_desc\nConnections: $conn_desc\n\nMounted:\n$mount_list\n$([ "$add_to_fstab" == "yes" ] && echo "These mounts will persist across reboots.")\n\nUse 'nfsstat -m' to verify."
    elif [[ ${#successful_mounts[@]} -gt 0 ]]; then
        local fail_list=""
        for f in "${failed_mounts[@]}"; do
            fail_list+="  $f"$'\n'
        done

        msg_box "Partial Success" "\
Some mounts succeeded, others failed.

Failed:
$fail_list
Troubleshooting:
- Check server IPs are correct
- Verify NFS server is running
- Check firewall settings"
    else
        msg_box "Mount Failed" "Failed to mount NFS share.\n\nError:\n$(cat "$mount_log")\n\nTroubleshooting:\n- Check server IP is correct\n- Verify NFS server is running\n- Check firewall settings"
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
            msg_box "No Mounts" "\
No active NFS mounts found.

Use 'Connect to NAS' to mount a share."
            return
        fi

        mount_info+=("" "")
        mount_info+=("Back" "Return to main menu")

        local choice
        choice=$(menu_select "Manage NFS Mounts" \
            "Active NFS mounts: ${#mounts[@]}" \
            "${mount_info[@]}") || return

        [[ "$choice" == "Back" || -z "$choice" ]] && return

        # Show mount details and options
        local server share opts
        server=$(mount | grep " $choice " | awk '{print $1}' | cut -d: -f1)
        share=$(mount | grep " $choice " | awk '{print $1}' | cut -d: -f2)
        opts=$(mount | grep " $choice " | grep -oP '\(\K[^)]+')

        local action
        action=$(menu_select "Mount: $choice" \
            "Server: $server | Share: $share" \
            "1" "View Details" \
            "2" "Unmount" \
            "3" "Remount" \
            "4" "Back") || continue

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
                text_box "Mount Details" "$details"
                ;;
            2)
                if yes_no "Unmount" "\
Unmount $choice?

Server: $server:$share

Make sure no programs are using this mount."; then
                    if umount "$choice" 2>/dev/null; then
                        msg_box "Unmounted" "Successfully unmounted $choice"
                    else
                        msg_box "Error" "\
Failed to unmount.

The mount may be in use. Try:
  lsof +f -- $choice"
                    fi
                fi
                ;;
            3)
                if yes_no "Remount" "Remount $choice?"; then
                    if mount -o remount "$choice" 2>/dev/null; then
                        msg_box "Remounted" "Successfully remounted $choice"
                    else
                        msg_box "Error" "Failed to remount."
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
            msg_box "DOCA OFED Status" "\
DOCA OFED appears to be installed.

Detected devices: $ib_devices

If you need to reinstall, use:
  ansible-playbook playbooks/doca_ofed_install.yml"
            return
        fi
    fi

    if ! yes_no "Install DOCA OFED" "\
Install NVIDIA DOCA OFED drivers?

This enables RDMA support for high-performance
NFS connections (NFS over RDMA).

Requirements:
- Compatible network adapter (ConnectX, etc.)
- Internet connection for package download
- System reboot after installation

Proceed with installation?"; then
        return
    fi

    # Check for Ansible
    if ! command -v ansible-playbook &>/dev/null; then
        info_box "Installing Ansible..." "Installing Ansible..."
        if command -v apt-get &>/dev/null; then
            apt-get update -qq
            apt-get install -y -qq ansible
        elif command -v yum &>/dev/null; then
            yum install -y ansible
        else
            msg_box "Error" "Could not install Ansible."
            return 1
        fi
    fi

    # Run the playbook
    local playbook="$SCRIPT_DIR/playbooks/doca_ofed_install.yml"
    if [[ ! -f "$playbook" ]]; then
        msg_box "Error" "Playbook not found:\n$playbook"
        return 1
    fi

    local log="$TMP_DIR/ansible.log"

    info_box "Installing DOCA OFED" "\
Installing NVIDIA DOCA OFED...

This may take several minutes.
Please wait..."

    cd "$SCRIPT_DIR"
    if ansible-playbook "$playbook" -i inventories/lab.ini > "$log" 2>&1; then
        msg_box "Installation Complete" "\
DOCA OFED installed successfully!

A system reboot is recommended to load
the new kernel modules.

After reboot, RDMA will be available for
high-performance NFS connections."

        if yes_no "Reboot Now?" "\
Reboot the system now?

RDMA will not be available until reboot."; then
            reboot
        fi
    else
        text_box "Installation Failed" "$log"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Kubernetes CSI NFS Driver
# ═══════════════════════════════════════════════════════════════════════════════

# Check if kubectl is available and cluster is accessible
check_kubernetes_available() {
    if ! command -v kubectl &>/dev/null; then
        return 1
    fi
    if ! kubectl cluster-info &>/dev/null; then
        return 2
    fi
    return 0
}

# Check if CSI NFS driver is installed
check_csi_nfs_installed() {
    if ! check_kubernetes_available; then
        return 1
    fi
    # Check for CSI driver pods
    kubectl get pods -n kube-system -l app.kubernetes.io/name=csi-driver-nfs &>/dev/null 2>&1 && return 0
    kubectl get pods -n kube-system -l app=csi-nfs-controller &>/dev/null 2>&1 && return 0
    # Check for CSI driver daemonset
    kubectl get daemonset -n kube-system csi-nfs-node &>/dev/null 2>&1 && return 0
    return 1
}

# Show CSI NFS driver status
show_csi_nfs_status() {
    local out="$TMP_DIR/csi_status"

    {
        echo "KUBERNETES CSI NFS DRIVER STATUS"
        printf '=%.0s' {1..70}; echo ""
        echo ""

        # Check kubectl
        echo "PREREQUISITES"
        printf -- '-%.0s' {1..70}; echo ""
        if command -v kubectl &>/dev/null; then
            echo "  [OK] kubectl installed: $(kubectl version --client -o json 2>/dev/null | grep -o '"gitVersion":"[^"]*"' | head -1 | cut -d'"' -f4)"
        else
            echo "  [!!] kubectl NOT installed"
            echo "       Install: https://kubernetes.io/docs/tasks/tools/"
            echo ""
            printf '=%.0s' {1..70}; echo ""
            return
        fi

        if command -v helm &>/dev/null; then
            echo "  [OK] helm installed: $(helm version --short 2>/dev/null)"
        else
            echo "  [--] helm not installed (optional)"
        fi
        echo ""

        # Check cluster connectivity
        echo "CLUSTER CONNECTIVITY"
        printf -- '-%.0s' {1..70}; echo ""
        if kubectl cluster-info &>/dev/null; then
            echo "  [OK] Kubernetes cluster accessible"
            local context
            context=$(kubectl config current-context 2>/dev/null || echo "unknown")
            echo "       Context: $context"
            local nodes
            nodes=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
            echo "       Nodes: $nodes"
        else
            echo "  [!!] Cannot connect to Kubernetes cluster"
            echo "       Check your kubeconfig: kubectl config view"
            echo ""
            printf '=%.0s' {1..70}; echo ""
            return
        fi
        echo ""

        # Check CSI driver
        echo "CSI NFS DRIVER"
        printf -- '-%.0s' {1..70}; echo ""
        if check_csi_nfs_installed; then
            echo "  [OK] CSI NFS driver installed"
            echo ""
            echo "  Controller pods:"
            kubectl get pods -n kube-system -l app=csi-nfs-controller --no-headers 2>/dev/null | sed 's/^/       /' || \
            kubectl get pods -n kube-system -l app.kubernetes.io/name=csi-driver-nfs --no-headers 2>/dev/null | sed 's/^/       /'
            echo ""
            echo "  Node pods:"
            kubectl get pods -n kube-system -l app=csi-nfs-node --no-headers 2>/dev/null | sed 's/^/       /'
        else
            echo "  [!!] CSI NFS driver NOT installed"
            echo "       Use 'Install CSI NFS Driver' to install"
        fi
        echo ""

        # Check storage classes
        echo "NFS STORAGE CLASSES"
        printf -- '-%.0s' {1..70}; echo ""
        local nfs_sc
        nfs_sc=$(kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.provisioner}{"\n"}{end}' 2>/dev/null | grep -i nfs || true)
        if [[ -n "$nfs_sc" ]]; then
            echo "$nfs_sc" | while read -r name provisioner; do
                local default_marker=""
                kubectl get storageclass "$name" -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}' 2>/dev/null | grep -q "true" && default_marker=" (default)"
                echo "  [*] $name$default_marker"
                echo "      Provisioner: $provisioner"
            done
        else
            echo "  [--] No NFS storage classes found"
            echo "       Use 'Configure Storage Class' to create one"
        fi
        echo ""

        # Check PVCs using NFS
        echo "NFS PERSISTENT VOLUME CLAIMS"
        printf -- '-%.0s' {1..70}; echo ""
        local nfs_pvcs
        nfs_pvcs=$(kubectl get pvc --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.storageClassName}{"\t"}{.status.phase}{"\n"}{end}' 2>/dev/null | grep -E "nfs|xiNAS|xinas" || true)
        if [[ -n "$nfs_pvcs" ]]; then
            echo "  NAMESPACE          NAME                      STORAGECLASS     STATUS"
            echo "$nfs_pvcs" | while IFS=$'\t' read -r ns name sc phase; do
                printf "  %-18s %-25s %-15s %s\n" "$ns" "$name" "$sc" "$phase"
            done
        else
            echo "  [--] No NFS-based PVCs found"
        fi
        echo ""

        printf '=%.0s' {1..70}; echo ""
    } > "$out"

    text_box "CSI NFS Driver Status" "$out"
}

# Install CSI NFS driver
install_csi_nfs_driver() {
    # Check prerequisites
    if ! command -v kubectl &>/dev/null; then
        msg_box "kubectl Required" "\
kubectl is not installed.

Install kubectl first:
  https://kubernetes.io/docs/tasks/tools/

Or for Ubuntu/Debian:
  sudo snap install kubectl --classic"
        return 1
    fi

    if ! kubectl cluster-info &>/dev/null; then
        msg_box "Cluster Not Accessible" "\
Cannot connect to Kubernetes cluster.

Make sure:
1. A Kubernetes cluster is running
2. kubectl is properly configured
3. You have cluster access permissions

Check with: kubectl cluster-info"
        return 1
    fi

    # Check if already installed
    if check_csi_nfs_installed; then
        local pods
        pods=$(kubectl get pods -n kube-system -l app=csi-nfs-controller --no-headers 2>/dev/null | head -3 || true)
        msg_box "Already Installed" "\
CSI NFS driver is already installed.

Controller pods:
$pods

Use 'Check Status' to see full details."
        return 0
    fi

    # Choose installation method
    local method
    method=$(menu_select "Installation Method" \
        "Helm is recommended if available" \
        "helm" "Install via Helm (recommended)" \
        "script" "Install via official script") || return

    local log="$TMP_DIR/csi_install.log"

    case "$method" in
        helm)
            # Check for helm
            if ! command -v helm &>/dev/null; then
                if yes_no "Helm Not Found" "\
Helm is not installed.

Install Helm now?

This will download and install Helm 3."; then
                    info_box "Installing Helm..." "Downloading and installing Helm..."
                    if curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash > "$log" 2>&1; then
                        msg_box "Helm Installed" "Helm installed successfully!"
                    else
                        text_box "Helm Install Failed" "$log"
                        return 1
                    fi
                else
                    return
                fi
            fi

            info_box "Installing CSI NFS Driver" "\
Installing CSI NFS Driver via Helm...

This may take a few minutes."

            {
                echo "Adding CSI NFS Helm repository..."
                helm repo add csi-driver-nfs https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/charts
                echo "Updating Helm repositories..."
                helm repo update
                echo "Installing csi-driver-nfs..."
                helm install csi-driver-nfs csi-driver-nfs/csi-driver-nfs \
                    --namespace kube-system \
                    --set controller.replicas=1 \
                    --wait
            } > "$log" 2>&1

            if [[ $? -eq 0 ]]; then
                msg_box "Installation Complete" "\
CSI NFS Driver installed successfully!

Next steps:
1. Create a StorageClass for your NFS server
2. Create PersistentVolumeClaims using the StorageClass

Use 'Configure Storage Class' to set up
a StorageClass for your xiNAS server."
            else
                text_box "Installation Failed" "$log"
                return 1
            fi
            ;;

        script)
            info_box "Installing CSI NFS Driver" "\
Installing CSI NFS Driver via script...

This may take a few minutes."

            {
                echo "Downloading and running CSI NFS install script..."
                curl -skSL https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/deploy/install-driver.sh | bash -s master --
            } > "$log" 2>&1

            if [[ $? -eq 0 ]] && check_csi_nfs_installed; then
                msg_box "Installation Complete" "\
CSI NFS Driver installed successfully!

Next steps:
1. Create a StorageClass for your NFS server
2. Create PersistentVolumeClaims using the StorageClass

Use 'Configure Storage Class' to set up
a StorageClass for your xiNAS server."
            else
                text_box "Installation Failed" "$log"
                return 1
            fi
            ;;
    esac
}

# Uninstall CSI NFS driver
uninstall_csi_nfs_driver() {
    if ! check_csi_nfs_installed; then
        msg_box "Not Installed" "CSI NFS driver is not installed."
        return
    fi

    if ! yes_no "Confirm Uninstall" "\
Uninstall CSI NFS Driver?

WARNING: This will remove the CSI driver.
Existing PVCs may become inaccessible.

Are you sure?"; then
        return
    fi

    local log="$TMP_DIR/csi_uninstall.log"

    info_box "Uninstalling..." "Removing CSI NFS Driver..."

    # Try helm uninstall first
    if command -v helm &>/dev/null && helm list -n kube-system | grep -q csi-driver-nfs; then
        helm uninstall csi-driver-nfs -n kube-system > "$log" 2>&1
    else
        # Use the uninstall script
        curl -skSL https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/deploy/uninstall-driver.sh | bash -s master -- > "$log" 2>&1
    fi

    if ! check_csi_nfs_installed; then
        msg_box "Uninstalled" "CSI NFS Driver has been removed."
    else
        text_box "Uninstall Issue" "$log"
    fi
}

# Configure NFS StorageClass for xiNAS
configure_csi_nfs_storage_class() {
    if ! check_kubernetes_available; then
        msg_box "Cluster Not Accessible" "\
Cannot connect to Kubernetes cluster.

Make sure kubectl is configured and
the cluster is accessible."
        return 1
    fi

    if ! check_csi_nfs_installed; then
        if ! yes_no "Driver Not Installed" "\
CSI NFS driver is not installed.

Install it now?"; then
            return
        fi
        install_csi_nfs_driver || return 1
    fi

    # Get NFS server address
    local nfs_server
    nfs_server=$(input_box "NFS Server Address" "\
Enter the xiNAS server IP address:

This should be the storage network IP
that Kubernetes nodes can access.

Example: 10.10.1.1" "10.10.1.1" 3>&1 1>&2 2>&3) || return

    [[ -z "$nfs_server" ]] && return

    # Validate IP format
    if [[ ! "$nfs_server" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        msg_box "Invalid IP" "Please enter a valid IP address."
        return
    fi

    # Get NFS share path
    local nfs_share
    nfs_share=$(input_box "NFS Share Path" "\
Enter the NFS export path on the server:

This is the base path that will be used
for dynamic provisioning.

Example: /mnt/data" "/mnt/data" 3>&1 1>&2 2>&3) || return

    [[ -z "$nfs_share" ]] && nfs_share="/mnt/data"

    # Storage class name
    local sc_name
    sc_name=$(input_box "Storage Class Name" "\
Enter a name for the StorageClass:

This will be used in PVC definitions.

Example: xinas-nfs" "xinas-nfs" 3>&1 1>&2 2>&3) || return

    [[ -z "$sc_name" ]] && sc_name="xinas-nfs"

    # Reclaim policy
    local reclaim_policy
    reclaim_policy=$(menu_select "Reclaim Policy" \
        "What happens when a PVC is deleted?" \
        "Delete" "Delete the data (default)" \
        "Retain" "Keep the data for manual cleanup" \
        "Archive" "Archive before deletion") || return

    [[ -z "$reclaim_policy" ]] && reclaim_policy="Delete"

    # Set as default?
    local set_default="false"
    if yes_no "Default StorageClass" "\
Make this the default StorageClass?

If yes, PVCs without an explicit storageClassName
will use this StorageClass."; then
        set_default="true"
    fi

    # Generate StorageClass YAML
    local sc_file="$TMP_DIR/storageclass.yaml"
    cat > "$sc_file" <<EOF
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: $sc_name
  annotations:
    storageclass.kubernetes.io/is-default-class: "$set_default"
provisioner: nfs.csi.k8s.io
parameters:
  server: $nfs_server
  share: $nfs_share
  # subDir: \${pvc.metadata.namespace}/\${pvc.metadata.name}
reclaimPolicy: $reclaim_policy
volumeBindingMode: Immediate
mountOptions:
  - nfsvers=4.2
  - hard
  - nconnect=16
  - rsize=1048576
  - wsize=1048576
EOF

    # Show preview and confirm
    if ! yes_no "Confirm StorageClass" "\
StorageClass configuration:

Name:          $sc_name
NFS Server:    $nfs_server
NFS Share:     $nfs_share
Reclaim:       $reclaim_policy
Default:       $set_default

Create this StorageClass?"; then
        return
    fi

    # Apply the StorageClass
    local log="$TMP_DIR/sc_apply.log"
    if kubectl apply -f "$sc_file" > "$log" 2>&1; then
        msg_box "StorageClass Created" "\
StorageClass '$sc_name' created successfully!

Example PVC:
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: $sc_name
  resources:
    requests:
      storage: 100Gi"
    else
        text_box "Failed" "$log"
    fi
}

# List and manage storage classes
manage_csi_nfs_storage_classes() {
    if ! check_kubernetes_available; then
        msg_box "Cluster Not Accessible" "Cannot connect to Kubernetes cluster."
        return
    fi

    while true; do
        # Get NFS storage classes
        local sc_list=()
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            local name provisioner
            name=$(echo "$line" | awk '{print $1}')
            provisioner=$(echo "$line" | awk '{print $2}')
            if [[ "$provisioner" == *"nfs"* ]]; then
                local default_marker=""
                kubectl get storageclass "$name" -o jsonpath='{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}' 2>/dev/null | grep -q "true" && default_marker=" (default)"
                sc_list+=("$name" "$provisioner$default_marker")
            fi
        done < <(kubectl get storageclass --no-headers 2>/dev/null)

        if [[ ${#sc_list[@]} -eq 0 ]]; then
            msg_box "No NFS StorageClasses" "\
No NFS StorageClasses found.

Use 'Create StorageClass' to add one."
            return
        fi

        sc_list+=("" "")
        sc_list+=("Back" "Return to CSI menu")

        local choice
        choice=$(menu_select "NFS Storage Classes" \
            "Select a StorageClass to manage:" \
            "${sc_list[@]}") || return

        [[ "$choice" == "Back" || -z "$choice" ]] && return

        # Show options for selected StorageClass
        local action
        action=$(menu_select "StorageClass: $choice" \
            "Select action:" \
            "1" "View Details" \
            "2" "Delete StorageClass" \
            "3" "Set as Default" \
            "4" "Back") || continue

        case "$action" in
            1)
                local details="$TMP_DIR/sc_details"
                kubectl get storageclass "$choice" -o yaml > "$details" 2>&1
                text_box "StorageClass: $choice" "$details"
                ;;
            2)
                if yes_no "Delete StorageClass" "\
Delete StorageClass '$choice'?

Note: Existing PVCs using this StorageClass
will NOT be deleted."; then
                    if kubectl delete storageclass "$choice" &>/dev/null; then
                        msg_box "Deleted" "StorageClass '$choice' deleted."
                    else
                        msg_box "Error" "Failed to delete StorageClass."
                    fi
                fi
                ;;
            3)
                # Remove default from others first
                for sc in $(kubectl get storageclass -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
                    kubectl patch storageclass "$sc" -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}' &>/dev/null || true
                done
                # Set this one as default
                if kubectl patch storageclass "$choice" -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' &>/dev/null; then
                    msg_box "Default Set" "'$choice' is now the default StorageClass."
                else
                    msg_box "Error" "Failed to set as default."
                fi
                ;;
        esac
    done
}

# Check for CSI NFS driver updates
check_csi_nfs_updates() {
    # Returns: 0 = update available, 1 = up to date or not installed, 2 = error
    # Sets CSI_CURRENT_VERSION and CSI_LATEST_VERSION variables

    if ! check_csi_nfs_installed; then
        return 1
    fi

    # Get current installed version
    CSI_CURRENT_VERSION=""
    CSI_LATEST_VERSION=""

    # Try to get version from helm
    if command -v helm &>/dev/null && helm list -n kube-system 2>/dev/null | grep -q csi-driver-nfs; then
        CSI_CURRENT_VERSION=$(helm list -n kube-system -o json 2>/dev/null | grep -o '"chart":"csi-driver-nfs-[^"]*"' | head -1 | sed 's/.*csi-driver-nfs-\([^"]*\)".*/\1/')
    fi

    # If no helm version, try to get from image tag
    if [[ -z "$CSI_CURRENT_VERSION" ]]; then
        CSI_CURRENT_VERSION=$(kubectl get deployment -n kube-system csi-nfs-controller -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | grep -o 'v[0-9.]*' || echo "")
    fi

    [[ -z "$CSI_CURRENT_VERSION" ]] && CSI_CURRENT_VERSION="unknown"

    # Get latest version from GitHub API
    CSI_LATEST_VERSION=$(curl -fsSL --connect-timeout 5 https://api.github.com/repos/kubernetes-csi/csi-driver-nfs/releases/latest 2>/dev/null | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

    if [[ -z "$CSI_LATEST_VERSION" ]]; then
        return 2  # Could not check
    fi

    # Compare versions (simple string comparison)
    if [[ "$CSI_CURRENT_VERSION" != "$CSI_LATEST_VERSION" && "$CSI_CURRENT_VERSION" != "unknown" ]]; then
        return 0  # Update available
    fi

    return 1  # Up to date or unknown
}

# Upgrade CSI NFS driver
upgrade_csi_nfs_driver() {
    local log="$TMP_DIR/csi_upgrade.log"

    if command -v helm &>/dev/null && helm list -n kube-system 2>/dev/null | grep -q csi-driver-nfs; then
        # Upgrade via Helm
        info_box "Upgrading CSI Driver" "Upgrading CSI NFS Driver via Helm..."

        {
            echo "Updating Helm repositories..."
            helm repo update
            echo "Upgrading csi-driver-nfs..."
            helm upgrade csi-driver-nfs csi-driver-nfs/csi-driver-nfs \
                --namespace kube-system \
                --wait
        } > "$log" 2>&1

        if [[ $? -eq 0 ]]; then
            return 0
        else
            text_box "Upgrade Failed" "$log"
            return 1
        fi
    else
        # Reinstall via script (script method doesn't have clean upgrade)
        if yes_no "Upgrade CSI Driver" "\
The CSI driver was installed via script.

To upgrade, it will be reinstalled.
This should not affect existing PVCs.

Proceed with reinstall?"; then
            info_box "Upgrading CSI Driver" "Reinstalling CSI NFS Driver..."

            {
                echo "Removing old installation..."
                curl -skSL https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/deploy/uninstall-driver.sh | bash -s master --
                echo "Installing latest version..."
                curl -skSL https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/deploy/install-driver.sh | bash -s master --
            } > "$log" 2>&1

            if check_csi_nfs_installed; then
                return 0
            else
                text_box "Upgrade Failed" "$log"
                return 1
            fi
        fi
        return 1
    fi
}

# CSI NFS Driver menu
kubernetes_csi_nfs_menu() {
    # Check if running on a Kubernetes node
    if ! command -v kubectl &>/dev/null; then
        if ! yes_no "kubectl Not Found" "\
kubectl is not installed on this system.

This feature requires:
- kubectl command-line tool
- Access to a Kubernetes cluster

Would you like to install kubectl?"; then
            return
        fi

        info_box "Installing kubectl..." "Installing kubectl..."

        if command -v snap &>/dev/null; then
            snap install kubectl --classic &>/dev/null
        elif command -v apt-get &>/dev/null; then
            curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.29/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg &>/dev/null
            echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.29/deb/ /' > /etc/apt/sources.list.d/kubernetes.list
            apt-get update -qq && apt-get install -y -qq kubectl
        else
            msg_box "Manual Install Required" "\
Could not auto-install kubectl.

Please install manually:
https://kubernetes.io/docs/tasks/tools/"
            return
        fi

        if command -v kubectl &>/dev/null; then
            msg_box "Installed" "kubectl installed successfully!"
        else
            msg_box "Installation Failed" "Failed to install kubectl."
            return
        fi
    fi

    while true; do
        # Get quick status
        local k8s_status="Not configured"
        local csi_status="Not installed"
        local csi_version=""
        local update_marker=""

        if kubectl cluster-info &>/dev/null 2>&1; then
            k8s_status="Connected"
            if check_csi_nfs_installed; then
                csi_status="Installed"
                # Check version
                if command -v helm &>/dev/null && helm list -n kube-system 2>/dev/null | grep -q csi-driver-nfs; then
                    csi_version=$(helm list -n kube-system -o json 2>/dev/null | grep -o '"chart":"csi-driver-nfs-[^"]*"' | head -1 | sed 's/.*csi-driver-nfs-\([^"]*\)".*/\1/')
                fi
                if [[ -z "$csi_version" ]]; then
                    csi_version=$(kubectl get deployment -n kube-system csi-nfs-controller -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | grep -o 'v[0-9.]*' || echo "")
                fi
                [[ -n "$csi_version" ]] && csi_status="$csi_version"

                # Quick update check (cached for menu display)
                if check_csi_nfs_updates 2>/dev/null; then
                    update_marker=" ⬆"
                fi
            fi
        fi

        local choice
        choice=$(menu_select "Kubernetes CSI NFS Driver" \
            "Cluster: $k8s_status | CSI: $csi_status$update_marker" \
            "1" "📊 Check Status" \
            "2" "📦 Install CSI NFS Driver" \
            "3" "🔄 Upgrade CSI NFS Driver" \
            "4" "⚙️  Configure Storage Class" \
            "5" "📁 Manage Storage Classes" \
            "6" "🗑️  Uninstall CSI NFS Driver" \
            "7" "🔙 Back to Main Menu") || return

        case "$choice" in
            1) show_csi_nfs_status ;;
            2) install_csi_nfs_driver ;;
            3)
                if ! check_csi_nfs_installed; then
                    msg_box "Not Installed" "CSI NFS driver is not installed.\n\nInstall it first using option 2."
                elif check_csi_nfs_updates; then
                    if yes_no "Update Available" "\
CSI NFS Driver update available!

Current: $CSI_CURRENT_VERSION
Latest:  $CSI_LATEST_VERSION

Upgrade now?"; then
                        if upgrade_csi_nfs_driver; then
                            msg_box "Upgraded!" "CSI NFS Driver upgraded to $CSI_LATEST_VERSION!"
                        fi
                    fi
                else
                    msg_box "Up to Date" "CSI NFS Driver is up to date.\n\nVersion: ${CSI_CURRENT_VERSION:-$csi_version}"
                fi
                ;;
            4) configure_csi_nfs_storage_class ;;
            5) manage_csi_nfs_storage_classes ;;
            6) uninstall_csi_nfs_driver ;;
            7) return ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Connection Test
# ═══════════════════════════════════════════════════════════════════════════════

test_connection() {
    local server_ip
    server_ip=$(input_box "Test Connection" "\
Enter the xiNAS server IP to test:

This will check network connectivity and
NFS service availability." "10.10.1.1" 3>&1 1>&2 2>&3) || return

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

    text_box "Connection Test: $server_ip" "$out"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Update Management
# ═══════════════════════════════════════════════════════════════════════════════

check_and_update() {
    local install_dir="/opt/xinas-client"
    local git_dir="$install_dir/.git"

    # Initialize CSI variables to prevent unbound errors
    CSI_CURRENT_VERSION="${CSI_CURRENT_VERSION:-}"
    CSI_LATEST_VERSION="${CSI_LATEST_VERSION:-}"

    # Check alternate locations
    if [[ ! -d "$git_dir" ]]; then
        git_dir="$SCRIPT_DIR/../.git"
        [[ -d "$git_dir" ]] || git_dir="$SCRIPT_DIR/.git"
        if [[ -d "$git_dir" ]]; then
            install_dir="$(dirname "$git_dir")"
        fi
    fi

    local client_update_available=""
    local csi_update_available=""
    local local_commit=""
    local remote_commit=""

    info_box "Checking..." "Checking for updates..."

    # Check xiNAS Client updates
    if [[ -d "$git_dir" ]] && command -v git &>/dev/null; then
        if git -C "$install_dir" fetch --quiet origin main 2>/dev/null; then
            local_commit=$(git -C "$install_dir" rev-parse HEAD 2>/dev/null)
            remote_commit=$(git -C "$install_dir" rev-parse origin/main 2>/dev/null)
            if [[ "$local_commit" != "$remote_commit" ]]; then
                client_update_available="true"
            fi
        fi
    fi

    # Check CSI NFS driver updates
    if check_csi_nfs_installed && check_kubernetes_available; then
        if check_csi_nfs_updates; then
            csi_update_available="true"
        fi
    fi

    # No updates available
    if [[ -z "$client_update_available" && -z "$csi_update_available" ]]; then
        local csi_msg=""
        if check_csi_nfs_installed; then
            csi_msg="\nCSI NFS Driver: ${CSI_CURRENT_VERSION:-installed}"
        fi
        msg_box "Up to Date" "\
Everything is up to date!

xiNAS Client: v$CLIENT_VERSION${local_commit:+ (${local_commit:0:8})}$csi_msg"
        UPDATE_AVAILABLE=""
        return
    fi

    # Build update message
    local update_msg="Updates available:\n\n"
    local update_options=()

    if [[ -n "$client_update_available" ]]; then
        local changes
        changes=$(git -C "$install_dir" log --oneline HEAD..origin/main 2>/dev/null | head -5)
        update_msg+="xiNAS Client:\n"
        update_msg+="  Current: ${local_commit:0:8}\n"
        update_msg+="  Latest:  ${remote_commit:0:8}\n"
        update_msg+="  Changes:\n$(echo "$changes" | sed 's/^/    /')\n\n"
        update_options+=("client" "Update xiNAS Client" "ON")
    fi

    if [[ -n "$csi_update_available" ]]; then
        update_msg+="CSI NFS Driver:\n"
        update_msg+="  Current: $CSI_CURRENT_VERSION\n"
        update_msg+="  Latest:  $CSI_LATEST_VERSION\n"
        update_options+=("csi" "Update CSI NFS Driver" "ON")
    fi

    # Show update dialog
    if [[ ${#update_options[@]} -eq 3 ]]; then
        # Only one update available, use simple yesno
        if [[ -n "$client_update_available" ]]; then
            if yes_no "Update Available" "$update_msg\n\nUpdate xiNAS Client now?"; then
                info_box "Updating..." "Downloading xiNAS Client update..."
                if git -C "$install_dir" pull --quiet origin main 2>/dev/null; then
                    UPDATE_AVAILABLE=""
                    msg_box "Updated!" "xiNAS Client updated!\n\nThe menu will restart."
                    exec "$0" "$@"
                else
                    msg_box "Update Failed" "Failed to update. Try: git pull origin main"
                fi
            fi
        else
            if yes_no "Update Available" "$update_msg\n\nUpdate CSI NFS Driver now?"; then
                if upgrade_csi_nfs_driver; then
                    msg_box "Updated!" "CSI NFS Driver updated to ${CSI_LATEST_VERSION:-latest}!"
                fi
            fi
        fi
    else
        # Multiple updates, use checklist
        local selected
        selected=$(check_list "Updates Available" \
            "Select updates to install:" \
            "${update_options[@]}") || return

        if [[ "$selected" == *"client"* ]]; then
            info_box "Updating..." "Downloading xiNAS Client update..."
            if git -C "$install_dir" pull --quiet origin main 2>/dev/null; then
                UPDATE_AVAILABLE=""
            else
                msg_box "Client Update Failed" "Failed to update client."
            fi
        fi

        if [[ "$selected" == *"csi"* ]]; then
            if upgrade_csi_nfs_driver; then
                msg_box "CSI Updated" "CSI NFS Driver updated!"
            fi
        fi

        # Restart if client was updated
        if [[ "$selected" == *"client"* ]] && [[ -z "$UPDATE_AVAILABLE" ]]; then
            msg_box "Updated!" "Updates installed!\n\nThe menu will restart."
            exec "$0" "$@"
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Network Configuration
# ═══════════════════════════════════════════════════════════════════════════════

# Validate IPv4 address (without CIDR)
valid_ipv4() {
    local ip="$1"
    [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS=. read -r o1 o2 o3 o4 <<< "$ip"
    for octet in $o1 $o2 $o3 $o4; do
        [[ $octet -ge 0 && $octet -le 255 ]] || return 1
    done
    return 0
}

# Validate IPv4 address with CIDR prefix
valid_ipv4_cidr() {
    local ip=${1%/*}
    local prefix=${1#*/}
    [[ "$1" == */* ]] || return 1
    valid_ipv4 "$ip" || return 1
    [[ $prefix =~ ^[0-9]{1,2}$ ]] || return 1
    [[ $prefix -ge 0 && $prefix -le 32 ]] || return 1
    return 0
}

# Get current network pool settings
get_network_pool_settings() {
    if [[ -f "$NETWORK_CONFIG" ]] && command -v yq &>/dev/null; then
        net_pool_enabled=$(yq '.net_ip_pool_enabled // false' "$NETWORK_CONFIG" 2>/dev/null || echo "false")
        net_pool_start=$(yq '.net_ip_pool_start // "10.10.1.2"' "$NETWORK_CONFIG" 2>/dev/null || echo "10.10.1.2")
        net_pool_end=$(yq '.net_ip_pool_end // "10.10.255.2"' "$NETWORK_CONFIG" 2>/dev/null || echo "10.10.255.2")
        net_pool_prefix=$(yq '.net_ip_pool_prefix // 24' "$NETWORK_CONFIG" 2>/dev/null || echo "24")
        net_mtu=$(yq '.net_mtu // 0' "$NETWORK_CONFIG" 2>/dev/null || echo "0")
    else
        net_pool_enabled=false
        net_pool_start="10.10.1.2"
        net_pool_end="10.10.255.2"
        net_pool_prefix=24
        net_mtu=0
    fi
}

# Save network pool settings
save_network_pool_settings() {
    local start="$1" end="$2" prefix="$3" mtu="${4:-0}"

    # Install yq if not present
    if ! command -v yq &>/dev/null; then
        if command -v snap &>/dev/null; then
            snap install yq 2>/dev/null || true
        fi
    fi

    cat > "$NETWORK_CONFIG" <<EOF
---
# xiNAS Client Network Configuration
# Automatic IP pool allocation for storage network interfaces
net_ip_pool_enabled: true
net_ip_pool_start: "$start"
net_ip_pool_end: "$end"
net_ip_pool_prefix: $prefix

# Interface detection
net_detect_infiniband: true
net_detect_mlx5: true

# MTU (0 = system default, 9000 = jumbo frames)
net_mtu: $mtu
EOF
}

# Detect high-speed network interfaces
detect_high_speed_interfaces() {
    local interfaces=()
    for iface in /sys/class/net/*; do
        [ -d "$iface" ] || continue
        local name
        name=$(basename "$iface")
        [ "$name" = "lo" ] && continue
        [ -e "$iface/device" ] || continue

        local type driver
        type=$(cat "$iface/type" 2>/dev/null || echo "0")
        driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")

        # InfiniBand (type 32) or NVIDIA MLX5 driver
        if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
            interfaces+=("$name")
        fi
    done
    echo "${interfaces[@]}"
}

# Configure IP pool for automatic allocation
configure_network_ip_pool() {
    get_network_pool_settings

    # Input start IP
    while true; do
        local new_start
        new_start=$(input_box "Network: IP Pool Start" "\
Configure IP pool for storage network interfaces.

Start IP address of the pool:

Format: X.X.X.X (e.g., 10.10.1.2)
Each interface will get the next subnet:
  Interface 1: 10.10.1.2
  Interface 2: 10.10.2.2
  etc.

Note: Use .2 addresses if .1 is your NAS server." "$net_pool_start" 3>&1 1>&2 2>&3) || return

        if valid_ipv4 "$new_start"; then
            break
        else
            msg_box "Invalid IP" "Invalid IP address format. Use X.X.X.X"
        fi
    done

    # Input end IP
    while true; do
        local new_end
        new_end=$(input_box "Network: IP Pool End" "\
End IP address of the pool:

Format: X.X.X.X (e.g., 10.10.255.2)" "$net_pool_end" 3>&1 1>&2 2>&3) || return

        if valid_ipv4 "$new_end"; then
            break
        else
            msg_box "Invalid IP" "Invalid IP address format. Use X.X.X.X"
        fi
    done

    # Input prefix
    while true; do
        local new_prefix
        new_prefix=$(input_box "Network: Subnet Prefix" "\
Subnet prefix (CIDR):

(e.g., 24 for /24 = 255.255.255.0)" "$net_pool_prefix" 3>&1 1>&2 2>&3) || return

        if [[ $new_prefix =~ ^[0-9]{1,2}$ ]] && [[ $new_prefix -ge 1 && $new_prefix -le 32 ]]; then
            break
        else
            msg_box "Invalid Prefix" "Invalid prefix. Use 1-32."
        fi
    done

    # Input MTU
    local new_mtu
    new_mtu=$(input_box "Network: MTU Setting" "\
MTU (Maximum Transmission Unit):

  0    = System default
  1500 = Standard Ethernet
  9000 = Jumbo frames (recommended for storage)

Leave at 0 unless you know your network supports jumbo frames." "$net_mtu" 3>&1 1>&2 2>&3) || return

    [[ -z "$new_mtu" ]] && new_mtu=0

    # Save settings
    save_network_pool_settings "$new_start" "$new_end" "$new_prefix" "$new_mtu"

    # Show summary
    msg_box "IP Pool Configured" "IP Pool configured:\n\nRange: $new_start - $new_end\nPrefix: /$new_prefix\nMTU: $([ "$new_mtu" = "0" ] && echo "System default" || echo "$new_mtu")\n\nSaved to: $NETWORK_CONFIG\n\nUse 'Apply Network Configuration' to activate."
}

# Configure interfaces manually
configure_network_manual() {
    # Gather available interfaces
    readarray -t all_interfaces < <(ip -o link show | awk -F': ' '{print $2}' | grep -v lo)

    if [[ ${#all_interfaces[@]} -eq 0 ]]; then
        msg_box "No Interfaces" "No network interfaces found."
        return
    fi

    declare -A curr_ip new_ip
    local configs=()

    for iface in "${all_interfaces[@]}"; do
        local ip_addr
        ip_addr=$(ip -o -4 addr show "$iface" 2>/dev/null | awk '{print $4}')
        [[ -z "$ip_addr" ]] && ip_addr="none"
        curr_ip[$iface]="$ip_addr"
        new_ip[$iface]=""
    done

    while true; do
        local menu_items=()
        for iface in "${all_interfaces[@]}"; do
            local speed="unknown"
            if [[ -e "/sys/class/net/$iface/speed" ]]; then
                speed=$(cat "/sys/class/net/$iface/speed" 2>/dev/null || echo "unknown")
            fi
            # Check if high-speed interface
            local type driver marker=""
            if [[ -e "/sys/class/net/$iface/device" ]]; then
                type=$(cat "/sys/class/net/$iface/type" 2>/dev/null || echo "0")
                driver=$(basename "$(readlink -f "/sys/class/net/$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")
                if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                    marker=" [RDMA]"
                fi
            fi
            local desc="${curr_ip[$iface]}"
            [[ -n "${new_ip[$iface]}" ]] && desc+=" -> ${new_ip[$iface]}"
            desc+=" - ${speed}Mb/s${marker}"
            menu_items+=("$iface" "$desc")
        done
        menu_items+=("" "")
        menu_items+=("Finish" "Apply configuration")

        local iface
        iface=$(menu_select "Manual Network Configuration" \
            "[RDMA] indicates high-speed interfaces" \
            "${menu_items[@]}") || return

        [[ "$iface" == "Finish" ]] && break
        [[ -z "$iface" ]] && continue

        local prompt="IPv4 address for $iface (current: ${curr_ip[$iface]})"
        [[ -n "${new_ip[$iface]}" ]] && prompt+="\n[new: ${new_ip[$iface]}]"

        while true; do
            local addr
            addr=$(input_box "Configure: $iface" "\
$prompt

Format: X.X.X.X/prefix (e.g., 10.10.1.2/24)

Leave empty to skip this interface." 3>&1 1>&2 2>&3) || break

            [[ -z "$addr" ]] && break

            if valid_ipv4_cidr "$addr"; then
                new_ip[$iface]="$addr"
                local found=""
                for i in "${!configs[@]}"; do
                    local name
                    IFS=: read -r name _ <<< "${configs[i]}"
                    if [[ "$name" == "$iface" ]]; then
                        configs[i]="$iface:$addr"
                        found=1
                        break
                    fi
                done
                [[ -z "$found" ]] && configs+=("$iface:$addr")
                break
            else
                msg_box "Invalid Format" "Invalid IPv4/CIDR format. Use X.X.X.X/prefix"
            fi
        done
    done

    if [[ ${#configs[@]} -eq 0 ]]; then
        msg_box "No Changes" "No interfaces were configured."
        return
    fi

    # Ask for MTU
    get_network_pool_settings
    local mtu
    mtu=$(input_box "MTU Setting" "\
MTU (Maximum Transmission Unit):

  0    = System default
  1500 = Standard Ethernet
  9000 = Jumbo frames (recommended for storage)" "$net_mtu" 3>&1 1>&2 2>&3) || return

    [[ -z "$mtu" ]] && mtu=0

    # Generate netplan configuration
    local netplan_file="/etc/netplan/99-xinas-client.yaml"
    local tmp_file
    tmp_file=$(mktemp)

    cat > "$tmp_file" <<EOF
# xiNAS Client Network Configuration
# Generated by client_setup.sh
network:
  version: 2
  renderer: networkd
  ethernets:
EOF

    for cfg in "${configs[@]}"; do
        local name addr
        IFS=: read -r name addr <<< "$cfg"
        cat >> "$tmp_file" <<EOF
    $name:
      dhcp4: no
      addresses: [ $addr ]
EOF
        if [[ "$mtu" -gt 0 ]]; then
            cat >> "$tmp_file" <<EOF
      mtu: $mtu
EOF
        fi
    done

    # Show preview
    local preview="$TMP_DIR/netplan_preview"
    cat "$tmp_file" > "$preview"

    if yes_no "Confirm Configuration" "Apply this netplan configuration?\n\nThis will modify: $netplan_file"; then
        # Backup existing config
        if [[ -f "$netplan_file" ]]; then
            cp "$netplan_file" "${netplan_file}.$(date +%Y%m%d%H%M%S).bak"
        fi

        mv "$tmp_file" "$netplan_file"
        chmod 600 "$netplan_file"

        # Save MTU to config
        if [[ -f "$NETWORK_CONFIG" ]] && command -v yq &>/dev/null; then
            yq -i ".net_mtu = $mtu" "$NETWORK_CONFIG" 2>/dev/null || true
            yq -i '.net_ip_pool_enabled = false' "$NETWORK_CONFIG" 2>/dev/null || true
        else
            cat > "$NETWORK_CONFIG" <<EOF
---
net_ip_pool_enabled: false
net_mtu: $mtu
EOF
        fi

        if yes_no "Apply Now?" "\
Configuration saved to $netplan_file

Apply network configuration now?

Warning: This may briefly disrupt network connectivity."; then
            info_box "Applying..." "Applying network configuration..."
            if netplan apply 2>/dev/null; then
                sleep 2
                msg_box "Success" "Network configuration applied successfully!\n\nMTU: $([ "$mtu" = "0" ] && echo "System default" || echo "$mtu")"
            else
                msg_box "Warning" "\
netplan apply returned an error.

Please check the configuration:
  cat $netplan_file

You may need to apply manually:
  sudo netplan apply"
            fi
        else
            msg_box "Saved" "\
Configuration saved but not applied.

To apply later, run:
  sudo netplan apply"
        fi
    else
        rm -f "$tmp_file"
    fi
}

# Apply IP pool configuration to interfaces
apply_network_pool() {
    get_network_pool_settings

    if [[ "$net_pool_enabled" != "true" ]]; then
        msg_box "Pool Not Configured" "\
IP pool is not enabled.

Please configure the IP pool first using
'Configure IP Pool' option."
        return
    fi

    # Detect high-speed interfaces
    local hs_ifaces
    hs_ifaces=$(detect_high_speed_interfaces)

    if [[ -z "$hs_ifaces" ]]; then
        msg_box "No Interfaces" "\
No high-speed interfaces detected.

Make sure DOCA OFED is installed and your
InfiniBand/RDMA hardware is recognized."
        return
    fi

    # Convert to array
    local interfaces=($hs_ifaces)

    if [[ ${#interfaces[@]} -eq 0 ]]; then
        msg_box "No Interfaces" "No interfaces to configure."
        return
    fi

    # Parse start IP to calculate allocation
    IFS=. read -r s1 s2 s3 s4 <<< "$net_pool_start"

    # Generate netplan
    local netplan_file="/etc/netplan/99-xinas-client.yaml"
    local tmp_file
    tmp_file=$(mktemp)

    cat > "$tmp_file" <<EOF
# xiNAS Client Network Configuration
# Generated by client_setup.sh (IP Pool Mode)
network:
  version: 2
  renderer: networkd
  ethernets:
EOF

    local idx=0
    local allocated_ips=""
    for iface in "${interfaces[@]}"; do
        # Calculate IP: increment third octet for each interface
        local ip_third=$((s3 + idx))
        local ip="${s1}.${s2}.${ip_third}.${s4}"
        allocated_ips+="  $iface: ${ip}/${net_pool_prefix}\n"

        cat >> "$tmp_file" <<EOF
    $iface:
      dhcp4: no
      addresses: [ ${ip}/${net_pool_prefix} ]
EOF
        if [[ "$net_mtu" -gt 0 ]]; then
            cat >> "$tmp_file" <<EOF
      mtu: $net_mtu
EOF
        fi
        ((++idx))
    done

    # Show preview
    if yes_no "Apply IP Pool Configuration" "Detected ${#interfaces[@]} interface(s).\n\nPool: $net_pool_start - $net_pool_end / $net_pool_prefix\n\nApply this configuration?"; then
        # Backup existing config
        if [[ -f "$netplan_file" ]]; then
            cp "$netplan_file" "${netplan_file}.$(date +%Y%m%d%H%M%S).bak"
        fi

        mv "$tmp_file" "$netplan_file"
        chmod 600 "$netplan_file"

        info_box "Applying..." "Applying network configuration..."

        if netplan apply 2>/dev/null; then
            sleep 2
            msg_box "Success" "Network configuration applied!\n\nConfiguration: $netplan_file"
        else
            msg_box "Warning" "\
netplan apply returned an error.

Please check the configuration manually:
  cat $netplan_file
  sudo netplan apply"
        fi
    else
        rm -f "$tmp_file"
    fi
}

# View current network configuration
view_network_config() {
    get_network_pool_settings

    local out="$TMP_DIR/network_config"
    {
        echo "NETWORK CONFIGURATION"
        printf '=%.0s' {1..60}; echo ""
        echo ""

        echo "IP POOL SETTINGS"
        printf -- '-%.0s' {1..60}; echo ""
        echo "  Enabled: $net_pool_enabled"
        echo "  Range:   $net_pool_start - $net_pool_end"
        echo "  Prefix:  /$net_pool_prefix"
        echo "  MTU:     $([ "$net_mtu" = "0" ] && echo "System default" || echo "$net_mtu")"
        echo ""

        echo "DETECTED HIGH-SPEED INTERFACES"
        printf -- '-%.0s' {1..60}; echo ""
        local found=0
        for iface in /sys/class/net/*; do
            [ -d "$iface" ] || continue
            local name
            name=$(basename "$iface")
            [ "$name" = "lo" ] && continue
            [ -e "$iface/device" ] || continue

            local type driver
            type=$(cat "$iface/type" 2>/dev/null || echo "0")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")

            if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                local ip_addr speed state
                ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}')
                [[ -z "$ip_addr" ]] && ip_addr="no IP"
                speed=$(cat "$iface/speed" 2>/dev/null || echo "unknown")
                state=$(cat "$iface/operstate" 2>/dev/null || echo "unknown")
                echo "  $name:"
                echo "    IP:     $ip_addr"
                echo "    Speed:  ${speed}Mb/s"
                echo "    State:  $state"
                echo "    Driver: $driver"
                found=1
            fi
        done
        [[ $found -eq 0 ]] && echo "  No high-speed interfaces detected"
        echo ""

        echo "CURRENT NETPLAN (99-xinas-client.yaml)"
        printf -- '-%.0s' {1..60}; echo ""
        if [[ -f "/etc/netplan/99-xinas-client.yaml" ]]; then
            cat "/etc/netplan/99-xinas-client.yaml" | sed 's/^/  /'
        else
            echo "  Not configured"
        fi
        echo ""

        echo "ALL NETWORK INTERFACES"
        printf -- '-%.0s' {1..60}; echo ""
        ip -br addr 2>/dev/null | sed 's/^/  /'
        echo ""

        printf '=%.0s' {1..60}; echo ""
    } > "$out"

    text_box "Network Configuration" "$out"
}

# Network settings menu
configure_network() {
    while true; do
        get_network_pool_settings

        local pool_status="DISABLED"
        [[ "$net_pool_enabled" == "true" ]] && pool_status="ENABLED"

        # Count high-speed interfaces
        local hs_count
        hs_count=$(detect_high_speed_interfaces | wc -w)

        local choice
        choice=$(menu_select "Network Settings" \
            "IP Pool: $net_pool_start - $net_pool_end [$pool_status]" \
            "1" "Configure IP Pool (automatic allocation)" \
            "2" "Configure Interfaces Manually" \
            "3" "Apply IP Pool Configuration" \
            "4" "View Current Configuration" \
            "5" "Back to Main Menu") || return

        case "$choice" in
            1) configure_network_ip_pool ;;
            2) configure_network_manual ;;
            3) apply_network_pool ;;
            4) view_network_config ;;
            5) return ;;
        esac
    done
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

        # Build update indicator
        local update_indicator=""
        [[ "$UPDATE_AVAILABLE" == "true" ]] && update_indicator=" | ${YELLOW}Update!${NC}"

        local choice
        choice=$(menu_select "xiNAS Client Setup v$CLIENT_VERSION" \
            "$(hostname) | Mounts: $nfs_mounts | RDMA: $rdma_status" \
            "1" "📊 System Status" \
            "2" "🔌 Connect to NAS" \
            "3" "📁 Manage Mounts" \
            "4" "🌐 Network Settings" \
            "5" "🔧 Install NFS Tools" \
            "6" "⚡ Install DOCA OFED" \
            "7" "☸️  Kubernetes CSI NFS Driver" \
            "8" "🔍 Test Connection" \
            "9" "🔄 Check for Updates" \
            "0" "🚪 Exit") || break

        case "$choice" in
            1) show_status ;;
            2) configure_nfs_mount ;;
            3) manage_mounts ;;
            4) configure_network ;;
            5) install_nfs_tools ;;
            6) install_doca_ofed ;;
            7) kubernetes_csi_nfs_menu ;;
            8) test_connection ;;
            9) check_and_update ;;
            0)
                msg_box "See you soon!" "\
   Thank you for using xiNAS Client Setup!

   Run this menu again anytime:
     sudo ./client_setup.sh

   Questions? support@xinnor.io
"
                exit 0
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

case "${1:-}" in
    --version|-v)
        echo "xiNAS Client v$CLIENT_VERSION"
        # Show git commit if available
        _install_dir="/opt/xinas-client"
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR/.."
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR"
        if [[ -d "$_install_dir/.git" ]] && command -v git &>/dev/null; then
            _commit=$(git -C "$_install_dir" rev-parse --short HEAD 2>/dev/null)
            [[ -n "$_commit" ]] && echo "Commit: $_commit"
        fi
        exit 0
        ;;
    --update|-u)
        echo -e "${CYAN}Checking for updates...${NC}"
        _install_dir="/opt/xinas-client"
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR/.."
        [[ -d "$_install_dir/.git" ]] || _install_dir="$SCRIPT_DIR"
        if [[ ! -d "$_install_dir/.git" ]]; then
            echo -e "${RED}Error: Not a git installation${NC}"
            echo "Reinstall using: curl -fsSL https://xinnor.io/install_client.sh | sudo bash"
            exit 1
        fi
        git -C "$_install_dir" fetch --quiet origin main 2>/dev/null || {
            echo -e "${RED}Error: Could not fetch updates${NC}"
            exit 1
        }
        _local_commit=$(git -C "$_install_dir" rev-parse HEAD 2>/dev/null)
        _remote_commit=$(git -C "$_install_dir" rev-parse origin/main 2>/dev/null)
        if [[ "$_local_commit" == "$_remote_commit" ]]; then
            echo -e "${GREEN}Already up to date${NC}"
            exit 0
        fi
        echo -e "${YELLOW}Update available: ${_local_commit:0:8} -> ${_remote_commit:0:8}${NC}"
        git -C "$_install_dir" pull --quiet origin main 2>/dev/null && {
            echo -e "${GREEN}Updated successfully!${NC}"
            exit 0
        }
        echo -e "${RED}Update failed${NC}"
        exit 1
        ;;
    --status|-s)
        mount -t nfs,nfs4 2>/dev/null || echo "No NFS mounts"
        exit 0
        ;;
    --mount|-m)
        # Quick mount mode with training options
        # Supports multiple IPs: SERVER1,SERVER2:SHARE MOUNTPOINT [tcp|rdma] [sec]
        shift
        if [[ $# -lt 2 ]]; then
            echo "Usage: $0 --mount SERVER:SHARE MOUNTPOINT [PROTO] [SEC]"
            echo "       $0 --mount SERVER1,SERVER2:SHARE MOUNTPOINT [PROTO] [SEC]"
            echo ""
            echo "Protocols (PROTO):"
            echo "  tcp   - TCP transport (default)"
            echo "  rdma  - RDMA transport (requires DOCA OFED)"
            echo ""
            echo "Security modes (SEC):"
            echo "  sys   - Standard UID/GID mapping (default)"
            echo "  krb5  - Kerberos authentication"
            echo "  krb5i - Kerberos + integrity checking"
            echo "  krb5p - Kerberos + encryption"
            echo ""
            echo "Multi-IP support (distributes 16 connections + trunking):"
            echo "  1 IP  = nconnect=16"
            echo "  2 IPs = nconnect=8 each + trunkdiscovery"
            echo "  4 IPs = nconnect=4 each + trunkdiscovery"
            echo "  8 IPs = nconnect=2 each + trunkdiscovery"
            echo ""
            echo "Examples:"
            echo "  -m 10.10.1.1:/data /mnt/nas"
            echo "  -m 10.10.1.1:/data /mnt/nas tcp krb5p"
            echo "  -m 10.10.1.1,10.10.1.2:/data /mnt/nas rdma"
            exit 1
        fi
        server_share="$1"
        mount_point="$2"
        proto="${3:-tcp}"
        sec_mode="${4:-sys}"

        # Validate security mode
        case "$sec_mode" in
            sys|krb5|krb5i|krb5p) ;;
            *) echo "Error: Invalid security mode '$sec_mode'. Use: sys, krb5, krb5i, krb5p"; exit 1 ;;
        esac

        # Parse server(s) and share path
        servers_part="${server_share%%:*}"
        share_path="${server_share#*:}"

        # Split servers by comma
        IFS=',' read -ra server_ips <<< "$servers_part"
        num_ips=${#server_ips[@]}

        # Validate number of IPs (must be power of 2, max 16)
        if [[ $num_ips -ne 1 && $num_ips -ne 2 && $num_ips -ne 4 && $num_ips -ne 8 && $num_ips -ne 16 ]]; then
            echo "Error: Number of IPs must be 1, 2, 4, 8, or 16"
            exit 1
        fi

        nconnect=$((16 / num_ips))

        # Add trunking for multi-IP configurations
        trunk_opts=""
        if [[ $num_ips -gt 1 ]]; then
            trunk_opts=",trunkdiscovery"
        fi

        # Build mount options - training profile for all
        case "$proto" in
            rdma)
                opts="vers=4.2,proto=rdma,port=20049,hard,max_connect=16,nconnect=$nconnect,rsize=1048576,wsize=1048576,lookupcache=all,acregmin=60,acregmax=600,acdirmin=60,acdirmax=600${trunk_opts},sec=$sec_mode"
                proto_desc="RDMA"
                ;;
            tcp|*)
                opts="vers=4.2,proto=tcp,hard,max_connect=16,nconnect=$nconnect,rsize=1048576,wsize=1048576,lookupcache=all,acregmin=60,acregmax=600,acdirmin=60,acdirmax=600${trunk_opts},sec=$sec_mode"
                proto_desc="TCP"
                ;;
        esac

        echo "Protocol: $proto_desc"
        echo "Security: sec=$sec_mode"
        echo "Connections: max_connect=16, nconnect=$nconnect per IP"
        [[ $num_ips -gt 1 ]] && echo "Trunking: enabled (trunkdiscovery)"
        echo ""

        exit_code=0
        for ((i=0; i<num_ips; i++)); do
            current_ip="${server_ips[$i]}"
            if [[ $num_ips -eq 1 ]]; then
                current_mount="$mount_point"
            else
                current_mount="$mount_point/$((i+1))"
            fi
            mkdir -p "$current_mount"
            echo "Mounting $current_ip:$share_path to $current_mount"
            if ! mount -t nfs -o "$opts" "$current_ip:$share_path" "$current_mount"; then
                echo -e "${RED}Failed to mount $current_ip${NC}"
                exit_code=1
            else
                echo -e "${GREEN}OK${NC}"
            fi
        done

        if [[ $exit_code -eq 0 ]]; then
            echo ""
            echo -e "${GREEN}All mounts successful${NC}"
            echo "Use 'nfsstat -m' to verify connection status"
        fi
        exit $exit_code
        ;;
    --network-status|-n)
        echo -e "${CYAN}Network Configuration Status${NC}"
        echo ""
        if [[ -f "$NETWORK_CONFIG" ]]; then
            echo "Configuration file: $NETWORK_CONFIG"
            cat "$NETWORK_CONFIG"
        else
            echo "No network configuration file found."
        fi
        echo ""
        echo -e "${CYAN}High-Speed Interfaces:${NC}"
        for iface in /sys/class/net/*; do
            [ -d "$iface" ] || continue
            name=$(basename "$iface")
            [ "$name" = "lo" ] && continue
            [ -e "$iface/device" ] || continue
            type=$(cat "$iface/type" 2>/dev/null || echo "0")
            driver=$(basename "$(readlink -f "$iface/device/driver" 2>/dev/null)" 2>/dev/null || echo "")
            if [ "$type" = "32" ] || [ "$driver" = "mlx5_core" ]; then
                ip_addr=$(ip -o -4 addr show "$name" 2>/dev/null | awk '{print $4}' || echo "no IP")
                [[ -z "$ip_addr" ]] && ip_addr="no IP"
                echo "  $name: $ip_addr (driver: $driver)"
            fi
        done
        exit 0
        ;;
    --csi|--csi-nfs)
        # Direct access to CSI NFS menu
        kubernetes_csi_nfs_menu
        exit 0
        ;;
    --csi-status)
        # Show CSI NFS driver status (non-interactive)
        if ! command -v kubectl &>/dev/null; then
            echo -e "${RED}Error: kubectl not installed${NC}"
            exit 1
        fi
        if ! kubectl cluster-info &>/dev/null; then
            echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
            exit 1
        fi
        echo -e "${CYAN}Kubernetes CSI NFS Driver Status${NC}"
        echo ""
        echo "Cluster: $(kubectl config current-context 2>/dev/null || echo 'unknown')"
        echo ""
        if check_csi_nfs_installed; then
            echo -e "${GREEN}CSI NFS Driver: Installed${NC}"
            echo ""
            echo "Controller pods:"
            kubectl get pods -n kube-system -l app=csi-nfs-controller --no-headers 2>/dev/null | sed 's/^/  /' || true
            echo ""
            echo "Node pods:"
            kubectl get pods -n kube-system -l app=csi-nfs-node --no-headers 2>/dev/null | sed 's/^/  /' || true
        else
            echo -e "${YELLOW}CSI NFS Driver: Not installed${NC}"
        fi
        echo ""
        echo "NFS StorageClasses:"
        kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.provisioner}{"\n"}{end}' 2>/dev/null | grep -i nfs | sed 's/^/  /' || echo "  (none)"
        exit 0
        ;;
    --help|-h)
        echo "xiNAS Client Setup v$CLIENT_VERSION"
        echo ""
        echo "Usage: sudo $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  --status, -s              Show current NFS mounts"
        echo "  --mount, -m SERVER MOUNT  Quick mount (see below)"
        echo "  --network-status, -n      Show network configuration status"
        echo "  --csi, --csi-nfs          Open Kubernetes CSI NFS menu"
        echo "  --csi-status              Show CSI NFS driver status"
        echo "  --version, -v             Show version information"
        echo "  --update, -u              Check for and install updates"
        echo "  --help, -h                Show this help"
        echo ""
        echo "Mount: -m SERVER:SHARE MOUNTPOINT [PROTO] [SEC]"
        echo ""
        echo "Protocols (PROTO):"
        echo "  tcp   - TCP transport (default)"
        echo "  rdma  - RDMA transport (requires DOCA OFED)"
        echo ""
        echo "Security (SEC):"
        echo "  sys   - Standard UID/GID (default)"
        echo "  krb5  - Kerberos authentication"
        echo "  krb5i - Kerberos + integrity"
        echo "  krb5p - Kerberos + encryption"
        echo ""
        echo "Multi-IP (distributes 16 connections + trunking):"
        echo "  1 IP = nconnect=16, 2 IPs = nconnect=8 each, etc."
        echo ""
        echo "Kubernetes CSI NFS Driver:"
        echo "  The CSI driver enables dynamic NFS volume provisioning"
        echo "  in Kubernetes clusters using your xiNAS server."
        echo ""
        echo "Examples:"
        echo "  -m 10.10.1.1:/data /mnt/nas              # TCP, sec=sys"
        echo "  -m 10.10.1.1:/data /mnt/nas tcp krb5p    # TCP + Kerberos"
        echo "  -m 10.10.1.1,10.10.1.2:/data /mnt/nas    # Multi-IP"
        echo "  -m 10.10.1.1:/data /mnt/nas rdma         # RDMA"
        echo ""
        echo "Without options, launches the interactive menu."
        exit 0
        ;;
    *)
        main_menu
        ;;
esac
