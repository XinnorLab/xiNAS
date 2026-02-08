#!/usr/bin/env bash
# xiNAS Health Check
# Validates storage node configuration for high performance
# Works standalone (CLI) or sourced into post_install_menu.sh

set -euo pipefail

HC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HC_LOG_DIR="/var/log/xinas/healthcheck"
HC_TMP_DIR=""

# Locate profiles directory (check multiple locations)
HC_PROFILES_DIR=""
for _hc_p in "$HC_SCRIPT_DIR/healthcheck_profiles" \
             "/usr/local/bin/healthcheck_profiles" \
             "/opt/xiNAS/healthcheck_profiles" \
             "/home/xinnor/xiNAS/healthcheck_profiles"; do
    if [[ -d "$_hc_p" ]]; then
        HC_PROFILES_DIR="$_hc_p"
        break
    fi
done
: "${HC_PROFILES_DIR:=$HC_SCRIPT_DIR/healthcheck_profiles}"

# Source menu library if not already loaded (standalone mode)
if ! declare -f menu_select &>/dev/null; then
    if [[ -f "$HC_SCRIPT_DIR/lib/menu_lib.sh" ]]; then
        source "$HC_SCRIPT_DIR/lib/menu_lib.sh"
    elif [[ -f "/usr/local/bin/lib/menu_lib.sh" ]]; then
        source "/usr/local/bin/lib/menu_lib.sh"
    elif [[ -f "/opt/xiNAS/lib/menu_lib.sh" ]]; then
        source "/opt/xiNAS/lib/menu_lib.sh"
    elif [[ -f "/home/xinnor/xiNAS/lib/menu_lib.sh" ]]; then
        source "/home/xinnor/xiNAS/lib/menu_lib.sh"
    fi
fi

_hc_ensure_tmp() {
    if [[ -z "$HC_TMP_DIR" ]]; then
        HC_TMP_DIR="$(mktemp -d)"
        # Compose with existing EXIT trap (don't overwrite parent's cleanup)
        local _existing_trap
        _existing_trap="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//" || true)"
        if [[ -n "$_existing_trap" ]]; then
            trap "${_existing_trap}; rm -rf \"$HC_TMP_DIR\"" EXIT
        else
            trap 'rm -rf "$HC_TMP_DIR"' EXIT
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Python Health Check Engine (embedded)
# ═══════════════════════════════════════════════════════════════════════════════

run_healthcheck() {
    local profile_file="$1"
    shift
    local extra_flags=("$@")

    _hc_ensure_tmp
    local out="$HC_TMP_DIR/healthcheck_result"
    local json_out="$HC_TMP_DIR/healthcheck_json"

    local _pyrc=0
    python3 - "$profile_file" "$HC_LOG_DIR" "${extra_flags[@]}" > "$out" 2>"$HC_TMP_DIR/hc_err" << 'PYEOF' || _pyrc=$?
import sys
import os
import json
import subprocess
import re
import time
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
# YAML parser fallback (no PyYAML dependency)
# ─────────────────────────────────────────────────────────────────────────────

def _parse_yaml_simple(text):
    """Minimal YAML parser for profile files - handles flat keys and section maps."""
    result = {}
    current_section = None
    current_section_name = None

    for raw_line in text.split("\n"):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(raw_line) - len(raw_line.lstrip())

        # Top-level key: value
        m = re.match(r'^(\w+):\s*(.*)', stripped)
        if not m:
            continue

        key = m.group(1)
        value = m.group(2).strip()

        if indent == 0:
            # Top-level key
            if not value:
                current_section_name = key
                current_section = {}
                result[key] = current_section
            else:
                result[key] = _yaml_val(value)
                current_section = None
                current_section_name = None
        elif indent > 0 and current_section is not None:
            # Inside a section
            if value.startswith("{"):
                # Inline map: { enabled: true, checks: [a, b] }
                current_section[key] = _parse_inline_map(value)
            else:
                current_section[key] = _yaml_val(value)

    return result

def _yaml_val(s):
    """Convert a YAML scalar string to Python type."""
    s = s.strip().strip('"').strip("'")
    if s.lower() == "true":
        return True
    if s.lower() == "false":
        return False
    if s.lower() in ("null", "~", ""):
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    return s

def _parse_inline_map(s):
    """Parse { key: val, key: [a, b] } into a dict."""
    s = s.strip().lstrip("{").rstrip("}")
    result = {}
    # Split by comma but not inside brackets
    parts = []
    depth = 0
    current = ""
    for c in s:
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append(current.strip())
            current = ""
            continue
        current += c
    if current.strip():
        parts.append(current.strip())

    for part in parts:
        if ":" not in part:
            continue
        k, v = part.split(":", 1)
        k = k.strip()
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            items = [x.strip() for x in v[1:-1].split(",") if x.strip()]
            result[k] = items
        else:
            result[k] = _yaml_val(v)
    return result

def load_profile(path):
    """Load a profile YAML file."""
    try:
        import yaml
        with open(path) as f:
            return yaml.safe_load(f)
    except ImportError:
        with open(path) as f:
            return _parse_yaml_simple(f.read())

# ─────────────────────────────────────────────────────────────────────────────
# Data structures
# ─────────────────────────────────────────────────────────────────────────────

class CheckResult:
    def __init__(self, section, name, status, actual, expected,
                 evidence="", impact="", fix_hint=""):
        self.section = section
        self.name = name
        self.status = status      # PASS, WARN, FAIL, SKIP
        self.actual = str(actual)
        self.expected = str(expected)
        self.evidence = evidence
        self.impact = impact
        self.fix_hint = fix_hint

    def to_dict(self):
        return {
            "section": self.section,
            "name": self.name,
            "status": self.status,
            "actual": self.actual,
            "expected": self.expected,
            "evidence": self.evidence,
            "impact": self.impact,
            "fix_hint": self.fix_hint
        }

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def read_file(path):
    """Read a file, return contents or None."""
    try:
        with open(path) as f:
            return f.read().strip()
    except (IOError, OSError):
        return None

def read_sysctl(key):
    """Read a sysctl value via /proc/sys."""
    path = "/proc/sys/" + key.replace(".", "/")
    return read_file(path)

def run_cmd(cmd, timeout=10):
    """Run a command, return stdout or None."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return None
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        return None

def get_interfaces():
    """Get non-loopback network interfaces."""
    ifaces = []
    net_path = "/sys/class/net"
    try:
        for name in os.listdir(net_path):
            if name == "lo":
                continue
            if os.path.isdir(os.path.join(net_path, name)):
                ifaces.append(name)
    except OSError:
        pass
    return sorted(ifaces)

def get_mlx_interfaces():
    """Get interfaces driven by mlx5_core."""
    mlx = []
    for iface in get_interfaces():
        try:
            driver_link = f"/sys/class/net/{iface}/device/driver"
            driver = os.path.basename(os.readlink(driver_link))
            if "mlx" in driver.lower():
                mlx.append(iface)
        except OSError:
            pass
    return mlx

def get_data_mounts():
    """Get /mnt/* mount points from /proc/mounts."""
    mounts = []
    content = read_file("/proc/mounts")
    if content:
        for line in content.split("\n"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].startswith("/mnt/"):
                mounts.append(parts)
    return mounts

# ─────────────────────────────────────────────────────────────────────────────
# Section checkers
# ─────────────────────────────────────────────────────────────────────────────

def check_cpu(exp, checks):
    results = []
    if "governor" in checks:
        governors = set()
        cpu_path = "/sys/devices/system/cpu"
        try:
            for entry in os.listdir(cpu_path):
                gov_file = os.path.join(cpu_path, entry, "cpufreq/scaling_governor")
                val = read_file(gov_file)
                if val:
                    governors.add(val)
        except OSError:
            pass

        expected = exp.get("cpu_governor", "performance")
        if not governors:
            results.append(CheckResult("CPU", "governor", "SKIP", "N/A", expected,
                evidence="cpufreq not available",
                fix_hint="CPU frequency scaling may not be supported"))
        elif governors == {expected}:
            results.append(CheckResult("CPU", "governor", "PASS",
                expected, expected, evidence=f"All CPUs: {expected}"))
        else:
            results.append(CheckResult("CPU", "governor", "FAIL",
                ", ".join(sorted(governors)), expected,
                evidence=f"Found governors: {', '.join(sorted(governors))}",
                impact="Non-performance governor reduces throughput",
                fix_hint=f"cpupower frequency-set -g {expected}"))

    if "tuned_profile" in checks:
        expected = exp.get("tuned_profile", "throughput-performance")
        actual = run_cmd("tuned-adm active 2>/dev/null | awk -F': ' '{print $2}'")
        if actual is None:
            results.append(CheckResult("CPU", "tuned_profile", "SKIP", "N/A", expected,
                evidence="tuned-adm not found",
                fix_hint="apt install tuned && tuned-adm profile throughput-performance"))
        elif actual == expected:
            results.append(CheckResult("CPU", "tuned_profile", "PASS",
                actual, expected))
        else:
            results.append(CheckResult("CPU", "tuned_profile", "WARN",
                actual, expected,
                impact="Suboptimal tuned profile for storage workload",
                fix_hint=f"tuned-adm profile {expected}"))

    if "numa_balance" in checks:
        expected = exp.get("numa_balance", 0)
        actual = read_file("/proc/sys/kernel/numa_balancing")
        if actual is None:
            results.append(CheckResult("CPU", "numa_balance", "SKIP",
                "N/A", str(expected)))
        elif int(actual) == expected:
            results.append(CheckResult("CPU", "numa_balance", "PASS",
                actual, str(expected)))
        else:
            results.append(CheckResult("CPU", "numa_balance", "WARN",
                actual, str(expected),
                impact="NUMA auto-balancing can cause latency spikes",
                fix_hint="echo 0 > /proc/sys/kernel/numa_balancing"))

    return results

def check_kernel(exp, checks):
    results = []

    if "thp" in checks:
        expected = exp.get("thp", "never")
        content = read_file("/sys/kernel/mm/transparent_hugepage/enabled")
        if content is None:
            results.append(CheckResult("Kernel", "thp", "SKIP", "N/A", expected))
        else:
            m = re.search(r'\[(\w+)\]', content)
            actual = m.group(1) if m else content
            if actual == expected:
                results.append(CheckResult("Kernel", "thp", "PASS", actual, expected))
            elif actual == "always":
                results.append(CheckResult("Kernel", "thp", "FAIL", actual, expected,
                    impact="THP causes latency spikes in storage workloads",
                    fix_hint="echo never > /sys/kernel/mm/transparent_hugepage/enabled"))
            else:
                results.append(CheckResult("Kernel", "thp", "WARN", actual, expected,
                    fix_hint="echo never > /sys/kernel/mm/transparent_hugepage/enabled"))

    if "ksm" in checks:
        expected = exp.get("ksm", 0)
        actual = read_file("/sys/kernel/mm/ksm/run")
        if actual is None:
            results.append(CheckResult("Kernel", "ksm", "SKIP", "N/A", str(expected)))
        elif int(actual) == expected:
            results.append(CheckResult("Kernel", "ksm", "PASS", actual, str(expected)))
        else:
            results.append(CheckResult("Kernel", "ksm", "WARN", actual, str(expected),
                impact="KSM consumes CPU scanning for duplicate pages",
                fix_hint="echo 0 > /sys/kernel/mm/ksm/run"))

    if "mitigations" in checks:
        cmdline = read_file("/proc/cmdline") or ""
        if "mitigations=off" in cmdline:
            results.append(CheckResult("Kernel", "mitigations", "PASS",
                "off", "off", evidence="mitigations=off in cmdline"))
        else:
            results.append(CheckResult("Kernel", "mitigations", "WARN",
                "on (default)", "off",
                impact="CPU mitigations reduce throughput 5-15%",
                fix_hint="Add mitigations=off to GRUB_CMDLINE_LINUX in /etc/default/grub"))

    return results

def check_vm(exp, checks):
    results = []
    vm_checks = {
        "swappiness": ("vm.swappiness", "vm_swappiness", 1, 10, "WARN"),
        "dirty_background_ratio": ("vm.dirty_background_ratio", "vm_dirty_background_ratio", 5, None, "WARN"),
        "dirty_ratio": ("vm.dirty_ratio", "vm_dirty_ratio", 15, None, "WARN"),
        "vfs_cache_pressure": ("vm.vfs_cache_pressure", "vm_vfs_cache_pressure", 200, 100, "WARN"),
        "zone_reclaim": ("vm.zone_reclaim_mode", "vm_zone_reclaim", 0, None, "WARN"),
    }

    for check_name, (sysctl_key, exp_key, default, threshold, severity) in vm_checks.items():
        if check_name not in checks:
            continue
        expected = exp.get(exp_key, default)
        actual = read_sysctl(sysctl_key)
        if actual is None:
            results.append(CheckResult("VM", check_name, "SKIP", "N/A", str(expected)))
            continue

        actual_int = int(actual)
        passed = False

        if check_name == "swappiness":
            passed = actual_int <= (threshold or expected)
        elif check_name == "vfs_cache_pressure":
            passed = actual_int >= (threshold or expected)
        elif check_name == "zone_reclaim":
            passed = actual_int == expected
        else:
            passed = actual_int == expected

        if passed:
            results.append(CheckResult("VM", check_name, "PASS",
                actual, str(expected)))
        else:
            results.append(CheckResult("VM", check_name, severity,
                actual, str(expected),
                impact=f"Non-optimal {sysctl_key} for storage",
                fix_hint=f"sysctl -w {sysctl_key}={expected}"))

    return results

def check_network(exp, checks):
    results = []
    ifaces = get_interfaces()
    mlx_ifaces = get_mlx_interfaces()
    # Use Mellanox interfaces if available, otherwise all non-lo
    check_ifaces = mlx_ifaces if mlx_ifaces else ifaces

    if "link_state" in checks:
        for iface in check_ifaces:
            state = read_file(f"/sys/class/net/{iface}/operstate")
            if state == "up":
                results.append(CheckResult("Network", f"link_state ({iface})", "PASS",
                    "up", "up"))
            else:
                results.append(CheckResult("Network", f"link_state ({iface})", "FAIL",
                    state or "unknown", "up",
                    impact=f"Interface {iface} is not up",
                    fix_hint=f"ip link set {iface} up"))

    if "speed" in checks:
        min_speed = exp.get("net_speed_min", 25000)
        for iface in check_ifaces:
            speed = read_file(f"/sys/class/net/{iface}/speed")
            if speed is None or not speed.lstrip("-").isdigit():
                results.append(CheckResult("Network", f"speed ({iface})", "SKIP",
                    "N/A", f">={min_speed}Mb/s"))
                continue
            speed_int = int(speed)
            if speed_int < 0:
                results.append(CheckResult("Network", f"speed ({iface})", "SKIP",
                    "N/A", f">={min_speed}Mb/s", evidence="Link down"))
                continue
            speed_str = f"{speed_int // 1000}Gb/s" if speed_int >= 1000 else f"{speed_int}Mb/s"
            exp_str = f"{min_speed // 1000}Gb/s" if min_speed >= 1000 else f"{min_speed}Mb/s"
            if speed_int >= min_speed:
                results.append(CheckResult("Network", f"speed ({iface})", "PASS",
                    speed_str, f">={exp_str}"))
            else:
                results.append(CheckResult("Network", f"speed ({iface})", "WARN",
                    speed_str, f">={exp_str}",
                    impact="Low link speed limits throughput",
                    fix_hint="Check cable, switch port, and driver settings"))

    if "mtu" in checks:
        expected_mtu = exp.get("net_mtu", 9000)
        for iface in check_ifaces:
            mtu = read_file(f"/sys/class/net/{iface}/mtu")
            if mtu is None:
                continue
            mtu_int = int(mtu)
            if mtu_int >= expected_mtu:
                results.append(CheckResult("Network", f"mtu ({iface})", "PASS",
                    mtu, str(expected_mtu)))
            else:
                results.append(CheckResult("Network", f"mtu ({iface})", "FAIL",
                    mtu, str(expected_mtu),
                    impact="Non-jumbo MTU reduces RDMA and NFS throughput",
                    fix_hint=f"ip link set {iface} mtu {expected_mtu}"))

    # Sysctl checks
    sysctl_checks = []
    if "sysctl_rmem" in checks:
        sysctl_checks.append(("net.core.rmem_max", "net_rmem_max", 1073741824))
    if "sysctl_wmem" in checks:
        sysctl_checks.append(("net.core.wmem_max", "net_wmem_max", 1073741824))
    if "sysctl_backlog" in checks:
        sysctl_checks.append(("net.core.netdev_max_backlog", "net_backlog", 250000))

    for sysctl_key, exp_key, default in sysctl_checks:
        expected = exp.get(exp_key, default)
        actual = read_sysctl(sysctl_key)
        if actual is None:
            results.append(CheckResult("Network", sysctl_key, "SKIP",
                "N/A", str(expected)))
            continue
        actual_int = int(actual)
        if actual_int >= expected:
            results.append(CheckResult("Network", sysctl_key, "PASS",
                actual, str(expected)))
        else:
            severity = "FAIL" if "rmem" in sysctl_key or "wmem" in sysctl_key else "WARN"
            results.append(CheckResult("Network", sysctl_key, severity,
                actual, str(expected),
                impact=f"Low {sysctl_key} limits network buffer capacity",
                fix_hint=f"sysctl -w {sysctl_key}={expected}"))

    if "ring_rx_tx" in checks:
        expected_rx = exp.get("net_ring_rx", 8192)
        expected_tx = exp.get("net_ring_tx", 8192)
        for iface in check_ifaces:
            output = run_cmd(f"ethtool -g {iface} 2>/dev/null")
            if output is None:
                results.append(CheckResult("Network", f"ring_buffers ({iface})", "SKIP",
                    "N/A", f"RX:{expected_rx} TX:{expected_tx}",
                    evidence="ethtool not available"))
                continue
            # Parse current settings (after "Current hardware settings:")
            current_section = False
            rx_val = tx_val = None
            for line in output.split("\n"):
                if "Current hardware settings" in line:
                    current_section = True
                    continue
                if current_section:
                    m = re.match(r'^RX:\s+(\d+)', line)
                    if m:
                        rx_val = int(m.group(1))
                    m = re.match(r'^TX:\s+(\d+)', line)
                    if m:
                        tx_val = int(m.group(1))
            if rx_val is not None and tx_val is not None:
                actual_str = f"RX:{rx_val} TX:{tx_val}"
                exp_str = f"RX:{expected_rx} TX:{expected_tx}"
                if rx_val >= expected_rx and tx_val >= expected_tx:
                    results.append(CheckResult("Network", f"ring_buffers ({iface})", "PASS",
                        actual_str, exp_str))
                else:
                    results.append(CheckResult("Network", f"ring_buffers ({iface})", "WARN",
                        actual_str, exp_str,
                        impact="Small ring buffers cause packet drops under load",
                        fix_hint=f"ethtool -G {iface} rx {expected_rx} tx {expected_tx}"))

    if "errors_drops" in checks:
        for iface in check_ifaces:
            stats_path = f"/sys/class/net/{iface}/statistics"
            issues = []
            for counter in ["rx_errors", "tx_errors", "rx_dropped", "tx_dropped"]:
                val = read_file(f"{stats_path}/{counter}")
                if val and int(val) > 0:
                    issues.append(f"{counter}={val}")
            if issues:
                results.append(CheckResult("Network", f"errors_drops ({iface})", "WARN",
                    "; ".join(issues), "0",
                    impact="Interface errors/drops indicate problems",
                    fix_hint="Check cable, switch, and driver settings"))
            else:
                results.append(CheckResult("Network", f"errors_drops ({iface})", "PASS",
                    "0", "0"))

    return results

def check_rdma(exp, checks):
    results = []

    if "rdma_devices" in checks:
        output = run_cmd("rdma link show 2>/dev/null")
        if output is None:
            results.append(CheckResult("RDMA", "rdma_devices", "SKIP",
                "N/A", "present",
                evidence="rdma command not found",
                fix_hint="Install rdma-core: apt install rdma-core"))
        elif output:
            dev_count = len([l for l in output.split("\n") if l.strip()])
            results.append(CheckResult("RDMA", "rdma_devices", "PASS",
                f"{dev_count} device(s)", "present"))
        else:
            results.append(CheckResult("RDMA", "rdma_devices", "FAIL",
                "none", "present",
                impact="No RDMA devices found - NFS-RDMA cannot function",
                fix_hint="Check OFED installation and firmware"))

    if "port_state" in checks:
        output = run_cmd("ibv_devinfo 2>/dev/null")
        if output is None:
            results.append(CheckResult("RDMA", "port_state", "SKIP",
                "N/A", "PORT_ACTIVE",
                evidence="ibv_devinfo not found"))
        else:
            active = output.count("PORT_ACTIVE")
            total_ports = output.count("port:")
            if total_ports == 0:
                results.append(CheckResult("RDMA", "port_state", "SKIP",
                    "no ports", "PORT_ACTIVE"))
            elif active == total_ports:
                results.append(CheckResult("RDMA", "port_state", "PASS",
                    f"{active}/{total_ports} ACTIVE", "PORT_ACTIVE"))
            else:
                results.append(CheckResult("RDMA", "port_state", "FAIL",
                    f"{active}/{total_ports} ACTIVE", "PORT_ACTIVE",
                    impact="Inactive RDMA ports reduce available bandwidth",
                    fix_hint="Check cable connections and switch configuration"))

    if "pfc" in checks or "trust_mode" in checks or "ecn" in checks:
        for iface in get_mlx_interfaces():
            output = run_cmd(f"mlnx_qos -i {iface} 2>/dev/null")
            if output is None:
                if "pfc" in checks:
                    results.append(CheckResult("RDMA", f"pfc ({iface})", "SKIP",
                        "N/A", "enabled on priority 3",
                        evidence="mlnx_qos not found"))
                continue

            if "pfc" in checks:
                pfc_match = re.search(r'enabled\s*:\s*([\d,]+)', output)
                if pfc_match:
                    pfc_str = pfc_match.group(1)
                    if "3" in pfc_str.split(","):
                        results.append(CheckResult("RDMA", f"pfc ({iface})", "PASS",
                            f"enabled: {pfc_str}", "priority 3 enabled"))
                    else:
                        results.append(CheckResult("RDMA", f"pfc ({iface})", "WARN",
                            f"enabled: {pfc_str}", "priority 3 enabled",
                            fix_hint=f"mlnx_qos -i {iface} --pfc 0,0,0,1,0,0,0,0"))
                else:
                    results.append(CheckResult("RDMA", f"pfc ({iface})", "WARN",
                        "not detected", "priority 3 enabled"))

            if "trust_mode" in checks:
                trust_match = re.search(r'trust state:\s*(\w+)', output)
                if trust_match:
                    trust = trust_match.group(1)
                    if trust == "dscp":
                        results.append(CheckResult("RDMA", f"trust_mode ({iface})", "PASS",
                            trust, "dscp"))
                    else:
                        results.append(CheckResult("RDMA", f"trust_mode ({iface})", "WARN",
                            trust, "dscp",
                            fix_hint=f"mlnx_qos -i {iface} --trust dscp"))

            if "ecn" in checks:
                ecn_match = re.search(r'ecn\s*:\s*(\w+)', output, re.IGNORECASE)
                if ecn_match:
                    ecn = ecn_match.group(1)
                    if ecn.lower() in ("on", "enabled", "1"):
                        results.append(CheckResult("RDMA", f"ecn ({iface})", "PASS",
                            ecn, "enabled"))
                    else:
                        results.append(CheckResult("RDMA", f"ecn ({iface})", "WARN",
                            ecn, "enabled"))

    if "roce_tos" in checks:
        actual = read_file("/proc/sys/net/rdma_cm/default_roce_tos")
        if actual is None:
            results.append(CheckResult("RDMA", "roce_tos", "SKIP",
                "N/A", "106", evidence="/proc/sys/net/rdma_cm not available"))
        elif actual == "106":
            results.append(CheckResult("RDMA", "roce_tos", "PASS", "106", "106"))
        else:
            results.append(CheckResult("RDMA", "roce_tos", "WARN",
                actual, "106",
                fix_hint="echo 106 > /proc/sys/net/rdma_cm/default_roce_tos"))

    return results

def check_storage(exp, checks):
    results = []

    if "raid_status" in checks:
        if not run_cmd("command -v xicli"):
            results.append(CheckResult("Storage", "raid_status", "SKIP",
                "N/A", "all online",
                evidence="xicli not found",
                fix_hint="Install xiRAID first"))
        else:
            output = run_cmd("xicli raid show -f json 2>/dev/null")
            if output is None:
                results.append(CheckResult("Storage", "raid_status", "SKIP",
                    "N/A", "all online",
                    evidence="xicli raid show failed"))
            else:
                try:
                    data = json.loads(output)
                    if not data:
                        results.append(CheckResult("Storage", "raid_status", "SKIP",
                            "no arrays", "all online",
                            evidence="No RAID arrays configured"))
                    else:
                        all_ok = True
                        degraded = []
                        for name, arr in data.items():
                            states = arr.get("state", [])
                            for s in states:
                                if s.lower() not in ("online", "initialized"):
                                    all_ok = False
                                    degraded.append(f"{name}: {s}")
                        if all_ok:
                            results.append(CheckResult("Storage", "raid_status", "PASS",
                                f"{len(data)} array(s) online", "all online"))
                        else:
                            results.append(CheckResult("Storage", "raid_status", "FAIL",
                                "; ".join(degraded), "all online",
                                impact="Degraded RAID reduces redundancy and may reduce performance",
                                fix_hint="Check xicli raid show for details"))
                except (json.JSONDecodeError, AttributeError):
                    results.append(CheckResult("Storage", "raid_status", "SKIP",
                        "parse error", "all online"))

    if "raid_devices" in checks:
        output = run_cmd("xicli raid show -f json 2>/dev/null")
        if output:
            try:
                data = json.loads(output)
                for name, arr in data.items():
                    devices = arr.get("devices", [])
                    bad = []
                    for dev in devices:
                        state = dev[2][0] if dev[2] else "unknown"
                        if state.lower() != "online":
                            bad.append(f"{dev[1]}: {state}")
                    if bad:
                        results.append(CheckResult("Storage", f"raid_devices ({name})", "WARN",
                            "; ".join(bad), "all online",
                            impact="Degraded devices affect array health"))
                    else:
                        results.append(CheckResult("Storage", f"raid_devices ({name})", "PASS",
                            f"{len(devices)} online", "all online"))
            except (json.JSONDecodeError, AttributeError, IndexError):
                pass

    if "mount_status" in checks:
        mounts = get_data_mounts()
        if mounts:
            results.append(CheckResult("Storage", "mount_status", "PASS",
                f"{len(mounts)} data mount(s)", "present",
                evidence=", ".join(m[1] for m in mounts)))
        else:
            results.append(CheckResult("Storage", "mount_status", "FAIL",
                "no data mounts", "present",
                impact="No data filesystems mounted under /mnt/",
                fix_hint="Check RAID and filesystem configuration"))

    if "nr_requests" in checks:
        expected = exp.get("nvme_nr_requests", 512)
        try:
            for entry in os.listdir("/sys/block"):
                if not entry.startswith("nvme"):
                    continue
                nr = read_file(f"/sys/block/{entry}/queue/nr_requests")
                if nr and int(nr) < expected:
                    results.append(CheckResult("Storage", f"nr_requests ({entry})", "WARN",
                        nr, str(expected),
                        fix_hint=f"echo {expected} > /sys/block/{entry}/queue/nr_requests"))
                elif nr:
                    results.append(CheckResult("Storage", f"nr_requests ({entry})", "PASS",
                        nr, str(expected)))
        except OSError:
            pass

    return results

def check_nvme_health(exp, checks):
    results = []

    if not run_cmd("command -v nvme"):
        results.append(CheckResult("NVMe Health", "nvme_cli", "SKIP",
            "N/A", "installed",
            evidence="nvme-cli not found",
            fix_hint="apt install nvme-cli"))
        return results

    # Get NVMe devices
    try:
        nvme_devs = [f"/dev/{d}" for d in os.listdir("/sys/block") if d.startswith("nvme")]
    except OSError:
        return results

    # Only check base controllers (nvme0, nvme1, ...) not partitions
    controllers = set()
    for d in nvme_devs:
        base = re.match(r'/dev/(nvme\d+)', d)
        if base:
            controllers.add(f"/dev/{base.group(1)}")

    for ctrl in sorted(controllers):
        ctrl_name = os.path.basename(ctrl)
        output = run_cmd(f"nvme smart-log {ctrl} -o json 2>/dev/null")
        if output is None:
            continue
        try:
            smart = json.loads(output)
        except json.JSONDecodeError:
            continue

        if "smart_critical" in checks:
            crit = smart.get("critical_warning", 0)
            if crit == 0:
                results.append(CheckResult("NVMe Health", f"smart_critical ({ctrl_name})", "PASS",
                    "0", "0"))
            else:
                results.append(CheckResult("NVMe Health", f"smart_critical ({ctrl_name})", "FAIL",
                    str(crit), "0",
                    impact="NVMe critical warning indicates imminent failure",
                    fix_hint="Replace drive as soon as possible"))

        if "temperature" in checks:
            temp = smart.get("temperature", 0)
            # Handle kelvin vs celsius
            if temp > 200:
                temp = temp - 273
            warn = exp.get("nvme_temp_warn", 60)
            fail = exp.get("nvme_temp_fail", 70)
            if temp >= fail:
                results.append(CheckResult("NVMe Health", f"temperature ({ctrl_name})", "FAIL",
                    f"{temp}C", f"<{fail}C",
                    impact="Drive overheating - risk of thermal throttling or failure",
                    fix_hint="Check airflow and cooling"))
            elif temp >= warn:
                results.append(CheckResult("NVMe Health", f"temperature ({ctrl_name})", "WARN",
                    f"{temp}C", f"<{warn}C",
                    fix_hint="Monitor temperature trend"))
            else:
                results.append(CheckResult("NVMe Health", f"temperature ({ctrl_name})", "PASS",
                    f"{temp}C", f"<{warn}C"))

        if "wear_level" in checks:
            wear = smart.get("percent_used", 0)
            warn = exp.get("nvme_wear_warn", 50)
            fail = exp.get("nvme_wear_fail", 80)
            if wear >= fail:
                results.append(CheckResult("NVMe Health", f"wear_level ({ctrl_name})", "FAIL",
                    f"{wear}%", f"<{fail}%",
                    impact="Drive nearing end of life",
                    fix_hint="Plan drive replacement"))
            elif wear >= warn:
                results.append(CheckResult("NVMe Health", f"wear_level ({ctrl_name})", "WARN",
                    f"{wear}%", f"<{warn}%",
                    fix_hint="Monitor wear level trend"))
            else:
                results.append(CheckResult("NVMe Health", f"wear_level ({ctrl_name})", "PASS",
                    f"{wear}%", f"<{warn}%"))

    return results

def check_filesystem(exp, checks):
    results = []
    mounts = get_data_mounts()

    for mount_info in mounts:
        mount_path = mount_info[1]
        mount_opts = mount_info[3] if len(mount_info) > 3 else ""

        if "disk_usage" in checks:
            output = run_cmd(f"df --output=pcent '{mount_path}' 2>/dev/null | tail -1")
            if output:
                pct = int(output.strip().rstrip("%"))
                warn = exp.get("fs_usage_warn", 80)
                fail = exp.get("fs_usage_fail", 95)
                if pct >= fail:
                    results.append(CheckResult("Filesystem", f"disk_usage ({mount_path})", "FAIL",
                        f"{pct}%", f"<{fail}%",
                        impact="Filesystem nearly full - writes may fail",
                        fix_hint="Free up space or expand filesystem"))
                elif pct >= warn:
                    results.append(CheckResult("Filesystem", f"disk_usage ({mount_path})", "WARN",
                        f"{pct}%", f"<{warn}%"))
                else:
                    results.append(CheckResult("Filesystem", f"disk_usage ({mount_path})", "PASS",
                        f"{pct}%", f"<{warn}%"))

        if "inode_usage" in checks:
            output = run_cmd(f"df --output=ipcent '{mount_path}' 2>/dev/null | tail -1")
            if output:
                stripped = output.strip().rstrip("%")
                if stripped != "-":
                    pct = int(stripped)
                    warn = exp.get("fs_inode_warn", 80)
                    fail = exp.get("fs_inode_fail", 95)
                    if pct >= fail:
                        results.append(CheckResult("Filesystem", f"inode_usage ({mount_path})", "FAIL",
                            f"{pct}%", f"<{fail}%",
                            impact="Inode exhaustion prevents new file creation"))
                    elif pct >= warn:
                        results.append(CheckResult("Filesystem", f"inode_usage ({mount_path})", "WARN",
                            f"{pct}%", f"<{warn}%"))
                    else:
                        results.append(CheckResult("Filesystem", f"inode_usage ({mount_path})", "PASS",
                            f"{pct}%", f"<{warn}%"))

        if "mount_opts" in checks:
            if "noatime" in mount_opts:
                results.append(CheckResult("Filesystem", f"mount_opts ({mount_path})", "PASS",
                    "noatime", "noatime present"))
            else:
                results.append(CheckResult("Filesystem", f"mount_opts ({mount_path})", "WARN",
                    mount_opts[:40], "noatime present",
                    impact="Without noatime, every read updates metadata",
                    fix_hint=f"Add noatime to mount options in /etc/fstab"))

    return results

def check_nfs(exp, checks):
    results = []

    if "service_running" in checks:
        output = run_cmd("systemctl is-active nfs-server 2>/dev/null")
        if output == "active":
            results.append(CheckResult("NFS", "service_running", "PASS",
                "active", "active"))
        else:
            results.append(CheckResult("NFS", "service_running", "FAIL",
                output or "inactive", "active",
                impact="NFS server is not running - no exports available",
                fix_hint="systemctl start nfs-server"))

    if "threads" in checks:
        expected = exp.get("nfs_threads", 64)
        actual = read_file("/proc/fs/nfsd/threads")
        if actual is None:
            results.append(CheckResult("NFS", "threads", "SKIP",
                "N/A", str(expected),
                evidence="NFS server not loaded"))
        else:
            actual_int = int(actual)
            if actual_int >= expected:
                results.append(CheckResult("NFS", "threads", "PASS",
                    actual, str(expected)))
            else:
                results.append(CheckResult("NFS", "threads", "WARN",
                    actual, str(expected),
                    impact="Too few NFS threads limits concurrent client performance",
                    fix_hint=f"Set threads={expected} in /etc/nfs.conf [nfsd] section"))

    if "versions" in checks:
        versions_file = read_file("/proc/fs/nfsd/versions")
        if versions_file:
            has_41 = "+4.1" in versions_file
            has_42 = "+4.2" in versions_file
            if has_41 and has_42:
                results.append(CheckResult("NFS", "versions", "PASS",
                    versions_file, "v4.1, v4.2"))
            else:
                missing = []
                if not has_41:
                    missing.append("v4.1")
                if not has_42:
                    missing.append("v4.2")
                results.append(CheckResult("NFS", "versions", "WARN",
                    versions_file, "v4.1, v4.2",
                    impact=f"Missing NFS {', '.join(missing)} support",
                    fix_hint="Enable versions in /etc/nfs.conf"))
        else:
            results.append(CheckResult("NFS", "versions", "SKIP",
                "N/A", "v4.1, v4.2"))

    if "rdma_enabled" in checks:
        nfs_conf = read_file("/etc/nfs.conf")
        if nfs_conf and re.search(r'rdma\s*=\s*y', nfs_conf, re.IGNORECASE):
            results.append(CheckResult("NFS", "rdma_enabled", "PASS",
                "rdma=y", "rdma=y"))
        elif nfs_conf:
            results.append(CheckResult("NFS", "rdma_enabled", "WARN",
                "rdma not enabled", "rdma=y",
                impact="NFS-RDMA not enabled - falling back to TCP",
                fix_hint="Add rdma=y under [nfsd] in /etc/nfs.conf"))
        else:
            results.append(CheckResult("NFS", "rdma_enabled", "SKIP",
                "N/A", "rdma=y",
                evidence="/etc/nfs.conf not found"))

    if "exports_exist" in checks:
        exports = read_file("/etc/exports")
        if exports:
            lines = [l for l in exports.split("\n")
                     if l.strip() and not l.strip().startswith("#")]
            if lines:
                results.append(CheckResult("NFS", "exports_exist", "PASS",
                    f"{len(lines)} export(s)", "non-empty"))
            else:
                results.append(CheckResult("NFS", "exports_exist", "WARN",
                    "empty", "non-empty",
                    impact="No NFS exports configured",
                    fix_hint="Add exports to /etc/exports"))
        else:
            results.append(CheckResult("NFS", "exports_exist", "WARN",
                "file missing", "non-empty",
                fix_hint="Create /etc/exports with export definitions"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Report generators
# ─────────────────────────────────────────────────────────────────────────────

def compute_overall(results):
    """Compute overall status: PASS, WARN, FAIL."""
    critical_sections = {"Network", "Storage", "NFS"}
    has_fail = False
    warn_count = 0
    critical_warn = False

    for r in results:
        if r.status == "FAIL":
            has_fail = True
        elif r.status == "WARN":
            warn_count += 1
            if r.section in critical_sections:
                critical_warn = True

    if has_fail:
        return "FAIL"
    if warn_count >= 3 or critical_warn:
        return "WARN"
    return "PASS"

class C:
    """ANSI color codes for terminal output."""
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    BLUE = "\033[34m"
    CYAN = "\033[36m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    NC = "\033[0m"

def _status_color(status):
    return {"PASS": C.GREEN, "WARN": C.YELLOW, "FAIL": C.RED, "SKIP": C.DIM}.get(status, "")

def generate_text_report(results, metadata, color=False):
    W = 74
    lines = []

    overall = compute_overall(results)
    oc = _status_color(overall) if color else ""
    nc = C.NC if color else ""
    bld = C.BOLD if color else ""
    dim = C.DIM if color else ""
    cyn = C.CYAN if color else ""
    grn = C.GREEN if color else ""
    ylw = C.YELLOW if color else ""
    red = C.RED if color else ""
    blu = C.BLUE if color else ""

    status_icon = {"PASS": f"{grn}[PASS]{nc}", "WARN": f"{ylw}[WARN]{nc}", "FAIL": f"{red}[FAIL]{nc}"}

    lines.append(f"{dim}{'=' * (W + 2)}{nc}")
    title = "xiNAS HEALTH CHECK REPORT"
    pad = (W - len(title)) // 2
    lines.append(f"{bld}{' ' * pad}{title}{nc}")
    lines.append(f"{dim}{'=' * (W + 2)}{nc}")
    lines.append("")
    lines.append(f"  {dim}Date:{nc}      {metadata.get('timestamp', 'N/A')}")
    lines.append(f"  {dim}Hostname:{nc}  {metadata.get('hostname', 'N/A')}")
    lines.append(f"  {dim}Profile:{nc}   {metadata.get('profile', 'N/A')}")
    lines.append(f"  {dim}Duration:{nc}  {metadata.get('duration', 'N/A')}")
    lines.append("")
    lines.append(f"  Overall:   {status_icon.get(overall, overall)} {oc}{bld}{overall}{nc}")
    lines.append("")

    # Summary counts
    counts = {"PASS": 0, "WARN": 0, "FAIL": 0, "SKIP": 0}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    lines.append(f"  {grn}PASS: {counts['PASS']}{nc}  |  {ylw}WARN: {counts['WARN']}{nc}  |  {red}FAIL: {counts['FAIL']}{nc}  |  {dim}SKIP: {counts['SKIP']}{nc}")
    lines.append("")
    lines.append(f"{dim}{'-' * (W + 2)}{nc}")

    # Group by section
    sections_grouped = {}
    for r in results:
        sections_grouped.setdefault(r.section, []).append(r)

    icon_map = {
        "PASS": f"{grn}[OK]{nc}",
        "WARN": f"{ylw}[!!]{nc}",
        "FAIL": f"{red}[XX]{nc}",
        "SKIP": f"{dim}[--]{nc}",
    }

    for section, section_results in sections_grouped.items():
        lines.append("")
        lines.append(f"  {bld}{cyn}[{section.upper()}]{nc}")
        lines.append(f"  {dim}{'─' * (W - 2)}{nc}")

        for r in section_results:
            sc = _status_color(r.status) if color else ""
            icon = icon_map.get(r.status, "[??]")
            lines.append(f"  {icon}  {sc}{r.name}{nc}")
            lines.append(f"         {dim}Actual:{nc} {r.actual}  {dim}|{nc}  {dim}Expected:{nc} {r.expected}")
            if r.evidence:
                lines.append(f"         {dim}Evidence:{nc} {r.evidence}")
            if r.status in ("WARN", "FAIL"):
                if r.impact:
                    lines.append(f"         {ylw}Impact:{nc} {r.impact}")
                if r.fix_hint:
                    lines.append(f"         {blu}Fix:{nc} {r.fix_hint}")
            lines.append("")

    lines.append(f"{dim}{'=' * (W + 2)}{nc}")

    # Remediation summary for failures and warnings
    issues = [r for r in results if r.status in ("FAIL", "WARN")]
    if issues:
        lines.append("")
        lines.append(f"  {bld}{red}REMEDIATION SUMMARY{nc}")
        lines.append(f"  {dim}{'─' * (W - 2)}{nc}")
        for i, r in enumerate(issues, 1):
            sc = red if r.status == "FAIL" else ylw
            lines.append(f"  {i}. {sc}[{r.status}]{nc} {r.section} > {r.name}")
            if r.fix_hint:
                lines.append(f"     {blu}->{nc} {r.fix_hint}")
        lines.append("")
        lines.append(f"{dim}{'=' * (W + 2)}{nc}")

    return "\n".join(lines)

def generate_json_report(results, metadata):
    overall = compute_overall(results)
    report = {
        "metadata": metadata,
        "overall": overall,
        "summary": {
            "pass": sum(1 for r in results if r.status == "PASS"),
            "warn": sum(1 for r in results if r.status == "WARN"),
            "fail": sum(1 for r in results if r.status == "FAIL"),
            "skip": sum(1 for r in results if r.status == "SKIP"),
        },
        "checks": [r.to_dict() for r in results]
    }
    return json.dumps(report, indent=2)

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage: <profile_file> <log_dir> [flags...]", file=sys.stderr)
        sys.exit(1)

    profile_file = args[0]
    log_dir = args[1]
    flags = args[2:]

    flag_json_only = "--json" in flags
    flag_no_save = "--no-save" in flags

    # Load profile
    try:
        profile = load_profile(profile_file)
    except Exception as e:
        print(f"Error loading profile: {e}", file=sys.stderr)
        sys.exit(1)

    # Collect metadata
    import socket
    start_time = time.time()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    hostname = socket.gethostname()

    # Gather expectations
    exp = profile.get("expectations", {})
    sections = profile.get("sections", {})

    # Run checks
    all_results = []
    section_map = {
        "cpu": check_cpu,
        "kernel": check_kernel,
        "vm": check_vm,
        "network": check_network,
        "rdma": check_rdma,
        "storage": check_storage,
        "nvme_health": check_nvme_health,
        "filesystem": check_filesystem,
        "nfs": check_nfs,
    }

    for section_name, checker in section_map.items():
        section_cfg = sections.get(section_name, {})
        if not section_cfg.get("enabled", False):
            continue
        section_checks = section_cfg.get("checks", [])
        if not section_checks:
            continue
        try:
            results = checker(exp, section_checks)
            all_results.extend(results)
        except Exception as e:
            all_results.append(CheckResult(section_name, "error", "SKIP",
                str(e), "N/A", evidence=f"Section check failed: {e}"))

    duration = f"{time.time() - start_time:.1f}s"

    metadata = {
        "timestamp": timestamp,
        "hostname": hostname,
        "profile": profile.get("profile", "unknown"),
        "description": profile.get("description", ""),
        "duration": duration,
    }

    # Generate reports (plain for saving, colored for display)
    text_report_plain = generate_text_report(all_results, metadata, color=False)
    text_report_color = generate_text_report(all_results, metadata, color=True)
    json_report = generate_json_report(all_results, metadata)

    # Save reports (always plain text, no ANSI codes)
    if not flag_no_save:
        try:
            os.makedirs(log_dir, mode=0o755, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            text_path = os.path.join(log_dir, f"healthcheck_{ts}.txt")
            json_path = os.path.join(log_dir, f"healthcheck_{ts}.json")
            with open(text_path, "w") as f:
                f.write(text_report_plain)
            with open(json_path, "w") as f:
                f.write(json_report)
            # Store paths for bash wrapper
            print(f"__REPORT_TEXT__={text_path}", file=sys.stderr)
            print(f"__REPORT_JSON__={json_path}", file=sys.stderr)
        except OSError as e:
            print(f"Warning: Could not save reports: {e}", file=sys.stderr)

    # Output (colored for terminal display)
    if flag_json_only:
        print(json_report)
    else:
        print(text_report_color)

if __name__ == "__main__" or True:
    main()
PYEOF

    if [[ $_pyrc -ne 0 ]]; then
        echo "Health check engine failed:" >&2
        cat "$HC_TMP_DIR/hc_err" >&2
        return 1
    fi

    # Extract saved report paths from stderr
    local report_text report_json
    report_text=$(grep '__REPORT_TEXT__=' "$HC_TMP_DIR/hc_err" 2>/dev/null | sed 's/__REPORT_TEXT__=//' || true)
    report_json=$(grep '__REPORT_JSON__=' "$HC_TMP_DIR/hc_err" 2>/dev/null | sed 's/__REPORT_JSON__=//' || true)

    # Store for later reference
    [[ -n "$report_text" ]] && echo "$report_text" > "$HC_TMP_DIR/last_report_text"
    [[ -n "$report_json" ]] && echo "$report_json" > "$HC_TMP_DIR/last_report_json"

    echo "$out"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Menu Functions
# ═══════════════════════════════════════════════════════════════════════════════

run_and_display_healthcheck() {
    local profile="$1"
    shift
    local flags=("$@")
    local profile_file="$HC_PROFILES_DIR/${profile}.yml"

    # Create tmp dir in parent shell so subshell $(...) inherits it
    # without setting a new EXIT trap that would delete files prematurely
    _hc_ensure_tmp

    if [[ ! -f "$profile_file" ]]; then
        if declare -f msg_box &>/dev/null; then
            msg_box "Error" "Profile not found: $profile_file"
        else
            echo "Error: Profile not found: $profile_file" >&2
        fi
        return 1
    fi

    if declare -f info_box &>/dev/null; then
        info_box "Running Health Check" "Profile: $profile\nThis may take a moment..."
    fi

    local result_file=""
    result_file=$(run_healthcheck "$profile_file" "${flags[@]}") || true

    if [[ -n "$result_file" ]] && [[ -f "$result_file" ]]; then
        # Extract overall status and summary from report
        local overall summary saved_path=""
        overall=$(grep 'Overall:' "$result_file" 2>/dev/null | head -1 | sed 's/.*\[//;s/\].*//' || true)
        summary=$(grep -E 'PASS:.*WARN:.*FAIL:' "$result_file" 2>/dev/null | head -1 | sed 's/^  //' || true)

        if [[ -f "$HC_TMP_DIR/last_report_text" ]]; then
            saved_path=$(cat "$HC_TMP_DIR/last_report_text")
        fi

        # Build completion message
        local status_icon=""
        case "$overall" in
            PASS) status_icon="✅" ;;
            WARN) status_icon="⚠️" ;;
            FAIL) status_icon="❌" ;;
            *)    status_icon="🩺" ;;
        esac

        if declare -f yes_no &>/dev/null; then
            local notify_msg="Health check complete!\n\n${status_icon} Overall: ${overall}\n\n${summary}"
            if [[ -n "$saved_path" ]]; then
                notify_msg+="\n\nReport saved to:\n${saved_path}"
            fi
            notify_msg+="\n\nWould you like to view the full report?"

            if yes_no "🩺 Health Check Complete" "$notify_msg"; then
                text_box "🩺 Health Check Results" "$result_file"
            fi
        else
            cat "$result_file"
        fi
    fi
}

view_last_report() {
    local latest
    latest=$(ls -t "$HC_LOG_DIR"/healthcheck_*.txt 2>/dev/null | head -1)
    if [[ -z "$latest" ]]; then
        if declare -f msg_box &>/dev/null; then
            msg_box "No Reports" "No health check reports found.\n\nRun a health check first."
        else
            echo "No health check reports found."
        fi
        return
    fi

    if declare -f text_box &>/dev/null; then
        text_box "📄 Last Report: $(basename "$latest")" "$latest"
    else
        cat "$latest"
    fi
}

view_report_directory() {
    _hc_ensure_tmp

    if [[ ! -d "$HC_LOG_DIR" ]] || [[ -z "$(ls -A "$HC_LOG_DIR"/*.txt 2>/dev/null)" ]]; then
        if declare -f msg_box &>/dev/null; then
            msg_box "No Reports" "No health check reports found in:\n$HC_LOG_DIR"
        else
            echo "No health check reports found."
        fi
        return
    fi

    # Build menu from saved reports
    local -a menu_items=()
    local -a files=()
    local i=1

    while IFS= read -r file; do
        local basename
        basename=$(basename "$file" .txt)
        local ts
        ts=$(echo "$basename" | sed 's/healthcheck_//' | sed 's/_/ /')
        files+=("$file")
        menu_items+=("$i" "📄 $ts")
        ((i++))
    done < <(ls -t "$HC_LOG_DIR"/healthcheck_*.txt 2>/dev/null | head -20)

    if [[ ${#menu_items[@]} -eq 0 ]]; then
        if declare -f msg_box &>/dev/null; then
            msg_box "No Reports" "No reports found."
        fi
        return
    fi

    menu_items+=("0" "🔙 Back")

    if declare -f menu_select &>/dev/null; then
        local choice
        choice=$(menu_select "📂 Health Check Reports" "Select a report to view:" \
            "${menu_items[@]}") || return

        [[ "$choice" == "0" ]] && return
        local idx=$((choice - 1))
        if [[ $idx -ge 0 && $idx -lt ${#files[@]} ]]; then
            text_box "📄 $(basename "${files[$idx]}")" "${files[$idx]}"
        fi
    fi
}

healthcheck_menu() {
    local choice
    while true; do
        if declare -f show_header &>/dev/null; then
            show_header
        fi

        choice=$(menu_select "🩺 Health Check" "Validate system configuration for performance" \
            "1" "⚡ Quick Check (< 1 min)" \
            "2" "📋 Standard Check (2-5 min)" \
            "3" "🔬 Deep Check (5-10 min)" \
            "4" "📄 View Last Report" \
            "5" "📂 Browse Reports" \
            "0" "🔙 Back") || break

        case "$choice" in
            1) run_and_display_healthcheck "quick" ;;
            2) run_and_display_healthcheck "standard" ;;
            3)
                # Deep check - offer toggle options
                local deep_flags=""
                if declare -f check_list &>/dev/null; then
                    deep_flags=$(check_list "🔬 Deep Check Options" "Toggle optional deep checks:" \
                        "RDMA" "Full RDMA PFC/ECN/DSCP checks" "ON" \
                        "NVMe" "NVMe SMART health data" "ON" \
                        "Filesystem" "Disk & inode usage checks" "ON") || continue
                fi
                run_and_display_healthcheck "deep"
                ;;
            4) view_last_report ;;
            5) view_report_directory ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# CLI Entry Point (standalone mode)
# ═══════════════════════════════════════════════════════════════════════════════

_hc_cli_main() {
    local profile="quick"
    local flags=()
    local interactive=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --quick)     profile="quick" ;;
            --standard)  profile="standard" ;;
            --deep)      profile="deep" ;;
            --json)      flags+=("--json") ;;
            --no-save)   flags+=("--no-save") ;;
            --menu)      interactive=true ;;
            --help|-h)
                echo "xiNAS Health Check"
                echo ""
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Profiles:"
                echo "  --quick       Quick check: /proc, /sys reads only (default)"
                echo "  --standard    Standard: + ethtool, nfsstat, interface stats"
                echo "  --deep        Deep: + SMART, NVMe logs, FS checks"
                echo ""
                echo "Options:"
                echo "  --json        Output JSON instead of text"
                echo "  --no-save     Don't save report to disk"
                echo "  --menu        Launch interactive menu"
                echo "  --help, -h    Show this help"
                echo ""
                echo "Reports saved to: $HC_LOG_DIR/"
                exit 0
                ;;
            *)
                echo "Unknown option: $1" >&2
                echo "Use --help for usage." >&2
                exit 1
                ;;
        esac
        shift
    done

    if [[ "$interactive" == "true" ]]; then
        healthcheck_menu
        return
    fi

    local profile_file="$HC_PROFILES_DIR/${profile}.yml"
    if [[ ! -f "$profile_file" ]]; then
        echo "Error: Profile not found: $profile_file" >&2
        exit 1
    fi

    _hc_ensure_tmp

    local result_file=""
    result_file=$(run_healthcheck "$profile_file" "${flags[@]}") || true

    if [[ -n "$result_file" ]] && [[ -f "$result_file" ]]; then
        cat "$result_file"
    fi
}

# Run CLI if executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    _hc_cli_main "$@"
fi
