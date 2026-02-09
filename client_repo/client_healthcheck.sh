#!/usr/bin/env bash
# xiNAS Client Health Check
# Read-only diagnostic: validates NFS client performance configuration
# Works standalone (CLI) or sourced into client_setup.sh

set -euo pipefail

CHC_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHC_LOG_DIR="/var/log/xinas/client-health"
CHC_TMP_DIR=""

# Locate profiles directory (check multiple locations)
CHC_PROFILES_DIR=""
for _chc_p in "$CHC_SCRIPT_DIR/client_health_profiles" \
              "/opt/xinas-client/client_health_profiles" \
              "/usr/local/bin/client_health_profiles" \
              "/home/xinnor/xiNAS/client_repo/client_health_profiles"; do
    if [[ -d "$_chc_p" ]]; then
        CHC_PROFILES_DIR="$_chc_p"
        break
    fi
done
: "${CHC_PROFILES_DIR:=$CHC_SCRIPT_DIR/client_health_profiles}"

# Source menu library if not already loaded (standalone mode)
if ! declare -f menu_select &>/dev/null; then
    if [[ -f "$CHC_SCRIPT_DIR/lib/menu_lib.sh" ]]; then
        source "$CHC_SCRIPT_DIR/lib/menu_lib.sh"
    elif [[ -f "/usr/local/bin/lib/menu_lib.sh" ]]; then
        source "/usr/local/bin/lib/menu_lib.sh"
    elif [[ -f "/opt/xinas-client/lib/menu_lib.sh" ]]; then
        source "/opt/xinas-client/lib/menu_lib.sh"
    fi
fi

_chc_ensure_tmp() {
    if [[ -z "$CHC_TMP_DIR" ]]; then
        CHC_TMP_DIR="$(mktemp -d)"
        # Compose with existing EXIT trap (don't overwrite parent's cleanup)
        local _existing_trap
        _existing_trap="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//" || true)"
        if [[ -n "$_existing_trap" ]]; then
            trap "${_existing_trap}; rm -rf \"$CHC_TMP_DIR\"" EXIT
        else
            trap 'rm -rf "$CHC_TMP_DIR"' EXIT
        fi
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Python Health Check Engine (embedded)
# ═══════════════════════════════════════════════════════════════════════════════

run_client_healthcheck() {
    local profile_file="$1"
    shift
    local extra_flags=("$@")

    _chc_ensure_tmp
    local out="$CHC_TMP_DIR/healthcheck_result"

    local _pyrc=0
    python3 - "$profile_file" "$CHC_LOG_DIR" "${extra_flags[@]}" > "$out" 2>"$CHC_TMP_DIR/hc_err" << 'PYEOF' || _pyrc=$?
import sys
import os
import json
import subprocess
import re
import time
import platform
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
# YAML parser fallback (no PyYAML dependency)
# ─────────────────────────────────────────────────────────────────────────────

def _parse_yaml_simple(text):
    """Minimal YAML parser for profile files."""
    result = {}
    current_section = None
    current_section_name = None

    for raw_line in text.split("\n"):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip())
        m = re.match(r'^(\w+):\s*(.*)', stripped)
        if not m:
            continue
        key = m.group(1)
        value = m.group(2).strip()
        if indent == 0:
            if not value:
                current_section_name = key
                current_section = {}
                result[key] = current_section
            else:
                result[key] = _yaml_val(value)
                current_section = None
        elif indent > 0 and current_section is not None:
            if value.startswith("{"):
                current_section[key] = _parse_inline_map(value)
            else:
                current_section[key] = _yaml_val(value)
    return result

def _yaml_val(s):
    s = s.strip().strip('"').strip("'")
    if s.lower() == "true": return True
    if s.lower() == "false": return False
    if s.lower() in ("null", "~", ""): return None
    try: return int(s)
    except ValueError: pass
    try: return float(s)
    except ValueError: pass
    return s

def _parse_inline_map(s):
    s = s.strip().lstrip("{").rstrip("}")
    result = {}
    parts, depth, current = [], 0, ""
    for c in s:
        if c == "[": depth += 1
        elif c == "]": depth -= 1
        elif c == "," and depth == 0:
            parts.append(current.strip()); current = ""; continue
        current += c
    if current.strip(): parts.append(current.strip())
    for part in parts:
        if ":" not in part: continue
        k, v = part.split(":", 1)
        k, v = k.strip(), v.strip()
        if v.startswith("[") and v.endswith("]"):
            result[k] = [x.strip() for x in v[1:-1].split(",") if x.strip()]
        else:
            result[k] = _yaml_val(v)
    return result

def load_profile(path):
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
        self.status = status  # PASS, WARN, FAIL, SKIP, INFO
        self.actual = str(actual)
        self.expected = str(expected)
        self.evidence = evidence
        self.impact = impact
        self.fix_hint = fix_hint

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ("section", "name", "status", "actual", "expected",
                 "evidence", "impact", "fix_hint")}

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def read_file(path):
    try:
        with open(path) as f: return f.read().strip()
    except (IOError, OSError): return None

def read_sysctl(key):
    return read_file("/proc/sys/" + key.replace(".", "/"))

def run_cmd(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except (subprocess.TimeoutExpired, OSError):
        return None

def get_interfaces():
    ifaces = []
    try:
        for name in os.listdir("/sys/class/net"):
            if name == "lo" and os.path.isdir(f"/sys/class/net/{name}"):
                continue
            if os.path.isdir(f"/sys/class/net/{name}"):
                ifaces.append(name)
    except OSError:
        pass
    return sorted(ifaces)

def get_high_speed_interfaces():
    """Get interfaces with speed >= 10Gbps or mlx/infiniband driver."""
    result = []
    for iface in get_interfaces():
        try:
            driver_link = f"/sys/class/net/{iface}/device/driver"
            driver = os.path.basename(os.readlink(driver_link))
        except OSError:
            driver = ""
        speed_str = read_file(f"/sys/class/net/{iface}/speed")
        speed = int(speed_str) if speed_str and speed_str.lstrip("-").isdigit() else 0
        if speed >= 10000 or "mlx" in driver.lower() or "ib" in driver.lower():
            result.append(iface)
    return result

def get_nfs_mounts():
    """Parse active NFS mounts from /proc/mounts."""
    mounts = []
    content = read_file("/proc/mounts")
    if not content:
        return mounts
    for line in content.split("\n"):
        parts = line.split()
        if len(parts) < 4:
            continue
        fs_type = parts[2]
        if fs_type in ("nfs", "nfs4"):
            mounts.append({
                "device": parts[0],
                "mountpoint": parts[1],
                "fstype": fs_type,
                "options": parts[3],
            })
    return mounts

def parse_mount_options(opts_str):
    """Parse comma-separated mount options into dict."""
    result = {}
    for opt in opts_str.split(","):
        if "=" in opt:
            k, v = opt.split("=", 1)
            result[k] = v
        else:
            result[opt] = True
    return result

# ─────────────────────────────────────────────────────────────────────────────
# Section: Host Info & Compatibility
# ─────────────────────────────────────────────────────────────────────────────

def check_host_info(exp, checks):
    results = []

    if "os_version" in checks:
        os_info = read_file("/etc/os-release")
        if os_info:
            name = version = ""
            for line in os_info.split("\n"):
                if line.startswith("PRETTY_NAME="):
                    name = line.split("=", 1)[1].strip('"')
                if line.startswith("VERSION_ID="):
                    version = line.split("=", 1)[1].strip('"')
            is_ubuntu = "ubuntu" in name.lower()
            is_supported = version in ("22.04", "24.04")
            if is_ubuntu and is_supported:
                results.append(CheckResult("Host Info", "os_version", "PASS",
                    name, "Ubuntu 22.04/24.04"))
            elif is_ubuntu:
                results.append(CheckResult("Host Info", "os_version", "INFO",
                    name, "Ubuntu 22.04/24.04",
                    evidence="Untested Ubuntu version"))
            else:
                results.append(CheckResult("Host Info", "os_version", "INFO",
                    name, "Ubuntu 22.04/24.04",
                    evidence="Non-Ubuntu distribution"))

    if "kernel_version" in checks:
        kver = platform.release()
        results.append(CheckResult("Host Info", "kernel_version", "INFO",
            kver, "N/A", evidence=f"Kernel: {kver}"))

    if "packages" in checks:
        required = exp.get("packages_required", ["nfs-common"])
        if isinstance(required, str):
            required = [required]
        for pkg in required:
            out = run_cmd(f"dpkg -s {pkg} 2>/dev/null | grep 'Status:.*installed'")
            if out:
                results.append(CheckResult("Host Info", f"package ({pkg})", "PASS",
                    "installed", "installed"))
            else:
                results.append(CheckResult("Host Info", f"package ({pkg})", "FAIL",
                    "not installed", "installed",
                    impact=f"{pkg} is required for NFS client operation",
                    fix_hint=f"apt install {pkg}"))

    if "time_sync" in checks:
        timedatectl = run_cmd("timedatectl show --property=NTPSynchronized --value 2>/dev/null")
        if timedatectl == "yes":
            results.append(CheckResult("Host Info", "time_sync", "PASS",
                "NTP synchronized", "synchronized"))
        elif timedatectl == "no":
            results.append(CheckResult("Host Info", "time_sync", "INFO",
                "NTP not synchronized", "synchronized",
                impact="Time drift can cause auth/timeout issues with NFS",
                fix_hint="timedatectl set-ntp true"))
        else:
            results.append(CheckResult("Host Info", "time_sync", "SKIP",
                "N/A", "synchronized"))

    if "gpu_inventory" in checks:
        gpu_out = run_cmd("nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null")
        if gpu_out:
            gpu_count = len(gpu_out.strip().split("\n"))
            results.append(CheckResult("Host Info", "gpu_inventory", "INFO",
                f"{gpu_count} GPU(s)", "N/A",
                evidence=gpu_out.split("\n")[0]))
        else:
            results.append(CheckResult("Host Info", "gpu_inventory", "INFO",
                "No NVIDIA GPUs detected", "N/A"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Section: Kernel & Sysctl
# ─────────────────────────────────────────────────────────────────────────────

def check_kernel_sysctl(exp, checks):
    results = []

    if "file_max" in checks:
        expected = exp.get("sysctl_file_max", 1048576)
        actual = read_sysctl("fs.file-max")
        if actual and int(actual) >= expected:
            results.append(CheckResult("Kernel & Sysctl", "fs.file-max", "PASS",
                actual, f">={expected}"))
        elif actual:
            results.append(CheckResult("Kernel & Sysctl", "fs.file-max", "WARN",
                actual, f">={expected}",
                impact="Low file-max limits concurrent file handles for metadata-heavy workloads",
                fix_hint=f"sysctl -w fs.file-max={expected}"))
        else:
            results.append(CheckResult("Kernel & Sysctl", "fs.file-max", "SKIP", "N/A", str(expected)))

    sysctl_map = {
        "rmem_max": ("net.core.rmem_max", "sysctl_rmem_max", 268435456, "FAIL",
                     "Low rmem_max limits NFS read buffer capacity"),
        "wmem_max": ("net.core.wmem_max", "sysctl_wmem_max", 268435456, "FAIL",
                     "Low wmem_max limits NFS write buffer capacity"),
        "swappiness": ("vm.swappiness", "sysctl_swappiness", 10, "WARN",
                       "High swappiness may evict NFS page cache"),
    }

    for check_name, (sysctl_key, exp_key, default, severity, impact_msg) in sysctl_map.items():
        if check_name not in checks:
            continue
        expected = exp.get(exp_key, default)
        actual = read_sysctl(sysctl_key)
        if actual is None:
            results.append(CheckResult("Kernel & Sysctl", sysctl_key, "SKIP", "N/A", str(expected)))
            continue
        actual_int = int(actual)
        if check_name == "swappiness":
            passed = actual_int <= expected
        else:
            passed = actual_int >= expected
        if passed:
            results.append(CheckResult("Kernel & Sysctl", sysctl_key, "PASS", actual, str(expected)))
        else:
            results.append(CheckResult("Kernel & Sysctl", sysctl_key, severity, actual, str(expected),
                impact=impact_msg,
                fix_hint=f"sysctl -w {sysctl_key}={expected}"))

    if "dirty_background_ratio" in checks:
        expected = exp.get("sysctl_dirty_background_ratio", 5)
        actual = read_sysctl("vm.dirty_background_ratio")
        if actual:
            if int(actual) <= expected:
                results.append(CheckResult("Kernel & Sysctl", "vm.dirty_background_ratio", "PASS",
                    actual, str(expected)))
            else:
                results.append(CheckResult("Kernel & Sysctl", "vm.dirty_background_ratio", "WARN",
                    actual, str(expected),
                    impact="High dirty_background_ratio delays write-back, increases checkpoint latency",
                    fix_hint=f"sysctl -w vm.dirty_background_ratio={expected}"))

    if "dirty_ratio" in checks:
        expected = exp.get("sysctl_dirty_ratio", 20)
        actual = read_sysctl("vm.dirty_ratio")
        if actual:
            if int(actual) <= expected:
                results.append(CheckResult("Kernel & Sysctl", "vm.dirty_ratio", "PASS",
                    actual, str(expected)))
            else:
                results.append(CheckResult("Kernel & Sysctl", "vm.dirty_ratio", "WARN",
                    actual, str(expected),
                    fix_hint=f"sysctl -w vm.dirty_ratio={expected}"))

    if "congestion_control" in checks:
        actual = read_sysctl("net.ipv4.tcp_congestion_control")
        if actual:
            results.append(CheckResult("Kernel & Sysctl", "tcp_congestion_control", "INFO",
                actual, "N/A", evidence=f"Active TCP CC: {actual}"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Section: NFS Client Module & RPC
# ─────────────────────────────────────────────────────────────────────────────

def check_nfs_client(exp, checks):
    results = []

    if "modules_loaded" in checks:
        required_mods = ["nfs", "nfsv4", "sunrpc"]
        loaded = read_file("/proc/modules") or ""
        for mod in required_mods:
            if mod in loaded or mod.replace("v", "") in loaded:
                results.append(CheckResult("NFS Client", f"module ({mod})", "PASS",
                    "loaded", "loaded"))
            else:
                results.append(CheckResult("NFS Client", f"module ({mod})", "FAIL",
                    "not loaded", "loaded",
                    impact=f"Kernel module {mod} required for NFS operation",
                    fix_hint=f"modprobe {mod}"))

    if "modprobe_conf" in checks:
        conf_path = "/etc/modprobe.d/nfsclient.conf"
        content = read_file(conf_path)
        if content is None:
            results.append(CheckResult("NFS Client", "modprobe_conf", "WARN",
                "missing", "present",
                impact="NFS module tuning not applied - using kernel defaults",
                fix_hint="Run installer: Install NFS Tools to create /etc/modprobe.d/nfsclient.conf"))
        else:
            results.append(CheckResult("NFS Client", "modprobe_conf", "PASS",
                conf_path, "present"))
            # Verify key parameters
            modprobe_checks = {
                "max_session_slots": ("modprobe_max_session_slots", 180),
                "max_session_cb_slots": ("modprobe_max_session_cb_slots", 48),
                "nfs4_disable_idmapping": ("modprobe_nfs4_disable_idmapping", 1),
                "delay_retrans": ("modprobe_delay_retrans", -1),
                "enable_ino64": ("modprobe_enable_ino64", 1),
            }
            for param, (exp_key, default) in modprobe_checks.items():
                expected = exp.get(exp_key, default)
                m = re.search(rf'{param}[=\s]+(-?\d+)', content)
                if m:
                    actual_val = int(m.group(1))
                    if actual_val == expected:
                        results.append(CheckResult("NFS Client", f"modprobe {param}", "PASS",
                            str(actual_val), str(expected)))
                    else:
                        results.append(CheckResult("NFS Client", f"modprobe {param}", "WARN",
                            str(actual_val), str(expected),
                            impact=f"NFS module parameter {param} differs from profile",
                            fix_hint=f"Update {conf_path} and reload module or reboot"))
                else:
                    results.append(CheckResult("NFS Client", f"modprobe {param}", "WARN",
                        "not set", str(expected),
                        fix_hint=f"Add 'options nfs {param}={expected}' to {conf_path}"))

    if "sysctl_conf" in checks:
        conf_path = "/etc/sysctl.d/90-nfs-client.conf"
        content = read_file(conf_path)
        if content is None:
            results.append(CheckResult("NFS Client", "sysctl_conf", "WARN",
                "missing", "present",
                impact="Installer sysctl tuning not found",
                fix_hint="Run installer: Install NFS Tools to create /etc/sysctl.d/90-nfs-client.conf"))
        else:
            results.append(CheckResult("NFS Client", "sysctl_conf", "PASS",
                conf_path, "present"))

    if "rpc_stats" in checks:
        nfsstat = run_cmd("nfsstat -c 2>/dev/null")
        if nfsstat:
            results.append(CheckResult("NFS Client", "rpc_stats", "INFO",
                "available", "N/A",
                evidence="nfsstat client data collected"))
        else:
            results.append(CheckResult("NFS Client", "rpc_stats", "SKIP",
                "N/A", "N/A", evidence="nfsstat not available"))

    if "dmesg_nfs" in checks:
        dmesg = run_cmd("dmesg --time-format reltime 2>/dev/null | grep -iE 'nfs|rpc|sunrpc' | tail -10")
        if dmesg is None:
            dmesg = run_cmd("dmesg 2>/dev/null | grep -iE 'nfs|rpc|sunrpc' | tail -10")
        if dmesg:
            errors = [l for l in dmesg.split("\n") if re.search(r'error|warn|fail|timeout', l, re.I)]
            if errors:
                results.append(CheckResult("NFS Client", "dmesg_nfs_errors", "WARN",
                    f"{len(errors)} recent error(s)", "0",
                    evidence=errors[0][:100],
                    impact="Kernel log shows recent NFS/RPC issues"))
            else:
                results.append(CheckResult("NFS Client", "dmesg_nfs_errors", "PASS",
                    "no recent errors", "0"))
        else:
            results.append(CheckResult("NFS Client", "dmesg_nfs_errors", "SKIP",
                "N/A", "N/A", evidence="dmesg not accessible"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Section: Mount Correctness
# ─────────────────────────────────────────────────────────────────────────────

def check_mounts(exp, checks):
    results = []
    nfs_mounts = get_nfs_mounts()

    if "active_mounts" in checks:
        if nfs_mounts:
            results.append(CheckResult("Mounts", "active_mounts", "PASS",
                f"{len(nfs_mounts)} NFS mount(s)", "present",
                evidence="; ".join(m["mountpoint"] for m in nfs_mounts)))
        else:
            results.append(CheckResult("Mounts", "active_mounts", "FAIL",
                "0", "present",
                impact="No NFS mounts found - client cannot access NAS data",
                fix_hint="Use Connect to NAS in the client menu"))

    if not nfs_mounts:
        return results

    exp_version = str(exp.get("nfs_version", "4.2"))
    exp_proto = exp.get("mount_proto", "tcp")
    exp_rsize = exp.get("mount_rsize", 1048576)
    exp_wsize = exp.get("mount_wsize", 1048576)
    exp_hard = exp.get("mount_hard", True)
    exp_max_connect = exp.get("mount_max_connect", 16)
    exp_lookupcache = exp.get("mount_lookupcache", "all")

    for mount in nfs_mounts:
        mp = mount["mountpoint"]
        opts = parse_mount_options(mount["options"])
        short_mp = mp if len(mp) <= 25 else "..." + mp[-22:]

        if "nfs_version" in checks:
            actual_ver = opts.get("vers", opts.get("nfsvers", "unknown"))
            if actual_ver == exp_version:
                results.append(CheckResult("Mounts", f"nfs_version ({short_mp})", "PASS",
                    f"v{actual_ver}", f"v{exp_version}"))
            else:
                results.append(CheckResult("Mounts", f"nfs_version ({short_mp})", "FAIL",
                    f"v{actual_ver}", f"v{exp_version}",
                    impact=f"Wrong NFS version on {mp}",
                    fix_hint=f"Remount with vers={exp_version}"))

        if "mount_options" in checks:
            # Protocol
            actual_proto = opts.get("proto", "tcp")
            if actual_proto == exp_proto:
                results.append(CheckResult("Mounts", f"proto ({short_mp})", "PASS",
                    actual_proto, exp_proto))
            else:
                # Only FAIL if RDMA required but using TCP
                sev = "FAIL" if exp_proto == "rdma" else "INFO"
                results.append(CheckResult("Mounts", f"proto ({short_mp})", sev,
                    actual_proto, exp_proto,
                    impact="Transport protocol differs from profile" if sev == "FAIL" else "",
                    fix_hint=f"Remount with proto={exp_proto}" if sev == "FAIL" else ""))

            # hard mount
            if exp_hard:
                if opts.get("hard", False):
                    results.append(CheckResult("Mounts", f"hard ({short_mp})", "PASS",
                        "hard", "hard"))
                elif opts.get("soft", False):
                    results.append(CheckResult("Mounts", f"hard ({short_mp})", "FAIL",
                        "soft", "hard",
                        impact="Soft mounts can return errors under transient network issues",
                        fix_hint="Remount with 'hard' option"))

            # rsize/wsize
            for param, exp_val in [("rsize", exp_rsize), ("wsize", exp_wsize)]:
                actual = opts.get(param)
                if actual and int(actual) == exp_val:
                    results.append(CheckResult("Mounts", f"{param} ({short_mp})", "PASS",
                        actual, str(exp_val)))
                elif actual and int(actual) < exp_val:
                    results.append(CheckResult("Mounts", f"{param} ({short_mp})", "WARN",
                        actual, str(exp_val),
                        impact=f"Small {param} reduces throughput",
                        fix_hint=f"Remount with {param}={exp_val}"))

            # nconnect / max_connect
            actual_nc = opts.get("nconnect")
            if actual_nc:
                results.append(CheckResult("Mounts", f"nconnect ({short_mp})", "INFO",
                    actual_nc, "N/A",
                    evidence=f"nconnect={actual_nc} per IP"))

            actual_mc = opts.get("max_connect")
            if actual_mc:
                if int(actual_mc) >= exp_max_connect:
                    results.append(CheckResult("Mounts", f"max_connect ({short_mp})", "PASS",
                        actual_mc, str(exp_max_connect)))
                else:
                    results.append(CheckResult("Mounts", f"max_connect ({short_mp})", "WARN",
                        actual_mc, str(exp_max_connect),
                        fix_hint=f"Remount with max_connect={exp_max_connect}"))

            # lookupcache
            actual_lc = opts.get("lookupcache")
            if actual_lc:
                if actual_lc == exp_lookupcache:
                    results.append(CheckResult("Mounts", f"lookupcache ({short_mp})", "PASS",
                        actual_lc, exp_lookupcache))
                else:
                    results.append(CheckResult("Mounts", f"lookupcache ({short_mp})", "WARN",
                        actual_lc, exp_lookupcache))

    if "persistence" in checks:
        fstab = read_file("/etc/fstab") or ""
        fstab_nfs = [l for l in fstab.split("\n")
                     if l.strip() and not l.strip().startswith("#") and "nfs" in l]
        if fstab_nfs:
            results.append(CheckResult("Mounts", "fstab_persistence", "PASS",
                f"{len(fstab_nfs)} fstab entries", "present",
                evidence="; ".join(l.split()[1] for l in fstab_nfs if len(l.split()) > 1)))
            # Cross-check: are all active mounts in fstab?
            fstab_mps = set()
            for l in fstab_nfs:
                parts = l.split()
                if len(parts) >= 2:
                    fstab_mps.add(parts[1])
            for mount in nfs_mounts:
                if mount["mountpoint"] not in fstab_mps:
                    results.append(CheckResult("Mounts", f"not_persistent ({mount['mountpoint']})", "WARN",
                        "not in fstab", "fstab entry",
                        impact="Mount will be lost on reboot",
                        fix_hint=f"Add entry to /etc/fstab for {mount['mountpoint']}"))
        else:
            # Check systemd mount units
            has_systemd = False
            for mount in nfs_mounts:
                unit_name = mount["mountpoint"].lstrip("/").replace("/", "-") + ".mount"
                if run_cmd(f"systemctl is-enabled {unit_name} 2>/dev/null"):
                    has_systemd = True
            if has_systemd:
                results.append(CheckResult("Mounts", "persistence", "PASS",
                    "systemd units", "present"))
            elif nfs_mounts:
                results.append(CheckResult("Mounts", "persistence", "WARN",
                    "no persistence", "fstab or systemd",
                    impact="NFS mounts will be lost on reboot",
                    fix_hint="Add mount entries to /etc/fstab"))

    if "mountstats" in checks:
        for mount in nfs_mounts:
            mp = mount["mountpoint"]
            short_mp = mp if len(mp) <= 25 else "..." + mp[-22:]
            stats = read_file("/proc/self/mountstats")
            if stats:
                # Find section for this mount
                in_mount = False
                retrans = 0
                timeouts = 0
                for line in stats.split("\n"):
                    if f"mounted on {mp}" in line:
                        in_mount = True
                        continue
                    if in_mount:
                        if line.startswith("device "):
                            break
                        m = re.search(r'retrans:\s*(\d+)', line)
                        if m:
                            retrans += int(m.group(1))
                        m = re.search(r'timeouts:\s*(\d+)', line)
                        if m:
                            timeouts += int(m.group(1))

                if retrans > 0 or timeouts > 0:
                    results.append(CheckResult("Mounts", f"mountstats ({short_mp})", "WARN",
                        f"retrans={retrans}, timeouts={timeouts}", "0",
                        impact="Mount shows retransmissions/timeouts - indicates network or server issues"))
                else:
                    results.append(CheckResult("Mounts", f"mountstats ({short_mp})", "PASS",
                        "retrans=0, timeouts=0", "0"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Section: Network Health
# ─────────────────────────────────────────────────────────────────────────────

def check_network(exp, checks):
    results = []
    ifaces = get_high_speed_interfaces()
    if not ifaces:
        ifaces = [i for i in get_interfaces() if i != "lo"]

    if "link_state" in checks:
        for iface in ifaces:
            state = read_file(f"/sys/class/net/{iface}/operstate")
            if state == "up":
                results.append(CheckResult("Network", f"link_state ({iface})", "PASS",
                    "up", "up"))
            else:
                results.append(CheckResult("Network", f"link_state ({iface})", "FAIL",
                    state or "unknown", "up",
                    impact=f"Interface {iface} is down",
                    fix_hint=f"ip link set {iface} up"))

    if "speed" in checks:
        min_speed = exp.get("net_speed_min", 25000)
        for iface in ifaces:
            speed_str = read_file(f"/sys/class/net/{iface}/speed")
            if not speed_str or not speed_str.lstrip("-").isdigit():
                continue
            speed = int(speed_str)
            if speed < 0:
                continue
            fmt_speed = f"{speed // 1000}Gb/s" if speed >= 1000 else f"{speed}Mb/s"
            fmt_exp = f"{min_speed // 1000}Gb/s" if min_speed >= 1000 else f"{min_speed}Mb/s"
            if speed >= min_speed:
                results.append(CheckResult("Network", f"speed ({iface})", "PASS",
                    fmt_speed, f">={fmt_exp}"))
            else:
                results.append(CheckResult("Network", f"speed ({iface})", "WARN",
                    fmt_speed, f">={fmt_exp}",
                    impact="Link speed below profile minimum",
                    fix_hint="Check cable, switch port speed, and driver"))

    if "mtu" in checks:
        expected_mtu = exp.get("net_mtu", 9000)
        for iface in ifaces:
            mtu = read_file(f"/sys/class/net/{iface}/mtu")
            if mtu and int(mtu) >= expected_mtu:
                results.append(CheckResult("Network", f"mtu ({iface})", "PASS",
                    mtu, str(expected_mtu)))
            elif mtu:
                results.append(CheckResult("Network", f"mtu ({iface})", "FAIL",
                    mtu, str(expected_mtu),
                    impact="Non-jumbo MTU reduces NFS and RDMA throughput",
                    fix_hint=f"ip link set {iface} mtu {expected_mtu}"))

    if "errors_drops" in checks:
        for iface in ifaces:
            stats_path = f"/sys/class/net/{iface}/statistics"
            issues = []
            for counter in ["rx_errors", "tx_errors", "rx_dropped", "tx_dropped"]:
                val = read_file(f"{stats_path}/{counter}")
                if val and int(val) > 0:
                    issues.append(f"{counter}={val}")
            if issues:
                results.append(CheckResult("Network", f"errors_drops ({iface})", "WARN",
                    "; ".join(issues), "0",
                    impact="Interface errors or drops indicate problems",
                    fix_hint="Check cable, switch, and driver settings"))
            else:
                results.append(CheckResult("Network", f"errors_drops ({iface})", "PASS",
                    "0", "0"))

    if "tcp_retransmits" in checks:
        snmp = read_file("/proc/net/snmp")
        if snmp:
            tcp_line_header = None
            tcp_line_values = None
            lines = snmp.split("\n")
            for i, line in enumerate(lines):
                if line.startswith("Tcp:") and tcp_line_header is None:
                    tcp_line_header = line.split()
                elif line.startswith("Tcp:") and tcp_line_header is not None:
                    tcp_line_values = line.split()
                    break
            if tcp_line_header and tcp_line_values:
                try:
                    retrans_idx = tcp_line_header.index("RetransSegs")
                    out_idx = tcp_line_header.index("OutSegs")
                    retrans = int(tcp_line_values[retrans_idx])
                    out_segs = int(tcp_line_values[out_idx])
                    if out_segs > 0:
                        pct = retrans * 100.0 / out_segs
                        if pct > 1.0:
                            results.append(CheckResult("Network", "tcp_retransmits", "WARN",
                                f"{pct:.2f}% ({retrans}/{out_segs})", "<1%",
                                impact="Elevated TCP retransmits indicate congestion or packet loss"))
                        else:
                            results.append(CheckResult("Network", "tcp_retransmits", "PASS",
                                f"{pct:.3f}%", "<1%"))
                except (ValueError, IndexError):
                    pass

    if "route_to_server" in checks:
        # Check if default route exists
        routes = run_cmd("ip route show default 2>/dev/null")
        if routes:
            results.append(CheckResult("Network", "default_route", "PASS",
                routes.split("\n")[0][:60], "present"))
        else:
            results.append(CheckResult("Network", "default_route", "WARN",
                "no default route", "present",
                impact="Missing default route may prevent NFS server access"))
        # Check DNS resolution for any NFS server
        nfs_mounts = get_nfs_mounts()
        for mount in nfs_mounts[:1]:
            server = mount["device"].split(":")[0]
            if not re.match(r'^\d+\.\d+\.\d+\.\d+$', server):
                dns_out = run_cmd(f"getent hosts {server} 2>/dev/null")
                if dns_out:
                    results.append(CheckResult("Network", f"dns ({server})", "PASS",
                        dns_out.split()[0], "resolvable"))
                else:
                    results.append(CheckResult("Network", f"dns ({server})", "FAIL",
                        "unresolvable", "resolvable",
                        impact="NFS server hostname cannot be resolved"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Section: RDMA
# ─────────────────────────────────────────────────────────────────────────────

def check_rdma(exp, checks):
    results = []

    if "rdma_devices" in checks:
        ib_path = "/sys/class/infiniband"
        try:
            devices = os.listdir(ib_path)
            if devices:
                results.append(CheckResult("RDMA", "rdma_devices", "PASS",
                    f"{len(devices)} device(s)", "present",
                    evidence=", ".join(devices)))
            else:
                results.append(CheckResult("RDMA", "rdma_devices", "FAIL",
                    "none", "present",
                    impact="No RDMA devices found - NFSoRDMA will not work",
                    fix_hint="Install DOCA OFED via Advanced Settings"))
        except OSError:
            results.append(CheckResult("RDMA", "rdma_devices", "FAIL",
                "N/A", "present",
                evidence="/sys/class/infiniband not found",
                fix_hint="Install DOCA OFED via Advanced Settings"))

    if "port_state" in checks:
        ib_path = "/sys/class/infiniband"
        try:
            for dev in os.listdir(ib_path):
                ports_dir = os.path.join(ib_path, dev, "ports")
                if not os.path.isdir(ports_dir):
                    continue
                for port in os.listdir(ports_dir):
                    state = read_file(os.path.join(ports_dir, port, "state"))
                    if state and "ACTIVE" in state:
                        results.append(CheckResult("RDMA", f"port_state ({dev}/{port})", "PASS",
                            state, "ACTIVE"))
                    else:
                        results.append(CheckResult("RDMA", f"port_state ({dev}/{port})", "FAIL",
                            state or "unknown", "ACTIVE",
                            impact="RDMA port not active",
                            fix_hint="Check cable and switch port"))
        except OSError:
            pass

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Section: GDS (GPUDirect Storage)
# ─────────────────────────────────────────────────────────────────────────────

def check_gds(exp, checks):
    results = []
    gds_required = exp.get("gds_required", False)

    if "nvidia_driver" in checks:
        driver_ver = run_cmd("cat /sys/module/nvidia/version 2>/dev/null")
        if driver_ver:
            results.append(CheckResult("GDS", "nvidia_driver", "PASS",
                f"v{driver_ver}", "installed"))
        else:
            sev = "FAIL" if gds_required else "INFO"
            results.append(CheckResult("GDS", "nvidia_driver", sev,
                "not loaded", "installed",
                impact="NVIDIA driver required for GDS" if gds_required else "",
                fix_hint="Install NVIDIA driver" if gds_required else ""))

    if "nvidia_fs_module" in checks:
        loaded = read_file("/proc/modules") or ""
        if "nvidia_fs" in loaded:
            results.append(CheckResult("GDS", "nvidia_fs_module", "PASS",
                "loaded", "loaded"))
            # Check /proc/driver/nvidia-fs
            if os.path.isdir("/proc/driver/nvidia-fs"):
                results.append(CheckResult("GDS", "nvidia_fs_proc", "PASS",
                    "present", "present"))
        else:
            sev = "FAIL" if gds_required else "INFO"
            results.append(CheckResult("GDS", "nvidia_fs_module", sev,
                "not loaded", "loaded",
                impact="nvidia-fs module required for GPUDirect Storage" if gds_required else "",
                fix_hint="modprobe nvidia-fs (or install nvidia-gds)" if gds_required else ""))

    if "cufile_config" in checks:
        cufile_path = "/etc/cufile.json"
        if os.path.isfile(cufile_path):
            results.append(CheckResult("GDS", "cufile_config", "PASS",
                cufile_path, "present"))
            # Check if NFS RDMA is configured
            try:
                with open(cufile_path) as f:
                    cufile = json.load(f)
                rdma_addrs = cufile.get("fs", {}).get("nfs", {}).get("rdma_dev_addr_list", [])
                if rdma_addrs:
                    results.append(CheckResult("GDS", "cufile_nfs_rdma", "PASS",
                        f"{len(rdma_addrs)} addr(s)", "configured",
                        evidence=", ".join(str(a) for a in rdma_addrs[:3])))
                else:
                    results.append(CheckResult("GDS", "cufile_nfs_rdma", "WARN",
                        "not configured", "configured",
                        fix_hint="Configure cuFile NFS/RDMA via GDS menu"))
            except (json.JSONDecodeError, OSError):
                results.append(CheckResult("GDS", "cufile_parse", "WARN",
                    "parse error", "valid JSON"))
        else:
            sev = "WARN" if gds_required else "INFO"
            results.append(CheckResult("GDS", "cufile_config", sev,
                "missing", "present",
                fix_hint="Configure cuFile via GDS menu" if gds_required else ""))

    if "gds_libraries" in checks:
        # Check for libcufile
        cuda_lib_paths = [
            "/usr/local/cuda/lib64",
            "/usr/local/cuda/targets/x86_64-linux/lib",
        ]
        found_cufile = False
        found_rdma = False
        for lib_path in cuda_lib_paths:
            if os.path.isfile(f"{lib_path}/libcufile.so"):
                found_cufile = True
            if os.path.isfile(f"{lib_path}/libcufile_rdma.so"):
                found_rdma = True

        if found_cufile:
            results.append(CheckResult("GDS", "libcufile", "PASS",
                "found", "present"))
        else:
            sev = "FAIL" if gds_required else "INFO"
            results.append(CheckResult("GDS", "libcufile", sev,
                "not found", "present",
                fix_hint="Install nvidia-gds package" if gds_required else ""))

        if found_rdma:
            results.append(CheckResult("GDS", "libcufile_rdma", "PASS",
                "found", "present"))
        elif gds_required:
            results.append(CheckResult("GDS", "libcufile_rdma", "WARN",
                "not found", "present",
                impact="GDS RDMA library missing - NFS/RDMA GDS path unavailable"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Section: Runtime Counters & Symptoms
# ─────────────────────────────────────────────────────────────────────────────

def check_runtime(exp, checks):
    results = []

    if "nfs_errors" in checks:
        nfsstat = run_cmd("nfsstat -c 2>/dev/null")
        if nfsstat:
            retrans_warn = exp.get("nfs_retrans_warn", 100)
            timeout_warn = exp.get("nfs_timeout_warn", 10)
            # Parse retransmissions
            m = re.search(r'retrans\s*=\s*(\d+)', nfsstat)
            retrans = int(m.group(1)) if m else 0
            m = re.search(r'timeout[s]?\s*=\s*(\d+)', nfsstat)
            timeouts = int(m.group(1)) if m else 0

            if retrans > retrans_warn or timeouts > timeout_warn:
                results.append(CheckResult("Runtime", "nfs_retrans_timeouts", "WARN",
                    f"retrans={retrans}, timeouts={timeouts}",
                    f"retrans<{retrans_warn}, timeouts<{timeout_warn}",
                    impact="Elevated NFS retransmissions indicate network or server congestion",
                    fix_hint="Check network health and NFS server load"))
            else:
                results.append(CheckResult("Runtime", "nfs_retrans_timeouts", "PASS",
                    f"retrans={retrans}, timeouts={timeouts}",
                    f"retrans<{retrans_warn}, timeouts<{timeout_warn}"))

    if "cpu_iowait" in checks:
        stat1 = read_file("/proc/stat")
        if stat1:
            # Take a quick 1-second sample
            import time as _time
            _time.sleep(1)
            stat2 = read_file("/proc/stat")
            if stat2:
                try:
                    c1 = [int(x) for x in stat1.split("\n")[0].split()[1:]]
                    c2 = [int(x) for x in stat2.split("\n")[0].split()[1:]]
                    delta = [c2[i] - c1[i] for i in range(min(len(c1), len(c2)))]
                    total = sum(delta) or 1
                    iowait_pct = delta[4] * 100.0 / total if len(delta) > 4 else 0
                    if iowait_pct > 30:
                        results.append(CheckResult("Runtime", "cpu_iowait", "WARN",
                            f"{iowait_pct:.1f}%", "<30%",
                            impact="High iowait indicates storage/network bottleneck"))
                    else:
                        results.append(CheckResult("Runtime", "cpu_iowait", "PASS",
                            f"{iowait_pct:.1f}%", "<30%"))
                except (ValueError, IndexError):
                    pass

    if "memory_pressure" in checks:
        meminfo = read_file("/proc/meminfo")
        if meminfo:
            mem = {}
            for line in meminfo.split("\n"):
                parts = line.split(":")
                if len(parts) == 2:
                    mem[parts[0].strip()] = int(parts[1].strip().split()[0])
            total = mem.get("MemTotal", 1)
            avail = mem.get("MemAvailable", mem.get("MemFree", 0))
            swap_total = mem.get("SwapTotal", 0)
            swap_used = swap_total - mem.get("SwapFree", swap_total)
            avail_pct = avail * 100 / total

            if avail_pct < 5:
                results.append(CheckResult("Runtime", "memory_available", "WARN",
                    f"{avail_pct:.0f}% free", ">5%",
                    impact="Very low available memory may cause OOM or NFS cache eviction"))
            else:
                results.append(CheckResult("Runtime", "memory_available", "PASS",
                    f"{avail_pct:.0f}% free", ">5%"))

            if swap_used > 0 and swap_total > 0:
                swap_pct = swap_used * 100 / swap_total
                if swap_pct > 50:
                    results.append(CheckResult("Runtime", "swap_usage", "WARN",
                        f"{swap_pct:.0f}% used", "<50%",
                        impact="Heavy swap usage degrades NFS client performance"))
                else:
                    results.append(CheckResult("Runtime", "swap_usage", "PASS",
                        f"{swap_pct:.0f}% used", "<50%"))

    if "softirq_pressure" in checks:
        softirq = read_file("/proc/softirqs")
        if softirq:
            # Just report NET_RX/NET_TX totals as INFO
            net_rx = net_tx = 0
            for line in softirq.split("\n"):
                if line.strip().startswith("NET_RX"):
                    net_rx = sum(int(x) for x in line.split()[1:] if x.isdigit())
                elif line.strip().startswith("NET_TX"):
                    net_tx = sum(int(x) for x in line.split()[1:] if x.isdigit())
            results.append(CheckResult("Runtime", "softirq_net", "INFO",
                f"NET_RX={net_rx}, NET_TX={net_tx}", "N/A",
                evidence="Network softirq counters (baseline snapshot)"))

    return results

# ─────────────────────────────────────────────────────────────────────────────
# Report generators
# ─────────────────────────────────────────────────────────────────────────────

def compute_overall(results):
    critical_sections = {"Mounts", "Network", "NFS Client"}
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
    return {"PASS": C.GREEN, "WARN": C.YELLOW, "FAIL": C.RED,
            "SKIP": C.DIM, "INFO": C.CYAN}.get(status, "")

def generate_text_report(results, metadata, privacy=False, color=False):
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
    title = "xiNAS CLIENT HEALTH CHECK REPORT"
    pad = (W - len(title)) // 2
    lines.append(f"{bld}{' ' * pad}{title}{nc}")
    lines.append(f"{dim}{'=' * (W + 2)}{nc}")
    lines.append("")
    hostname = metadata.get("hostname", "N/A")
    if privacy:
        hostname = "***"
    lines.append(f"  {dim}Date:{nc}      {metadata.get('timestamp', 'N/A')}")
    lines.append(f"  {dim}Hostname:{nc}  {hostname}")
    lines.append(f"  {dim}Profile:{nc}   {metadata.get('profile', 'N/A')}")
    lines.append(f"  {dim}Duration:{nc}  {metadata.get('duration', 'N/A')}")
    lines.append("")
    lines.append(f"  Overall:   {status_icon.get(overall, overall)} {oc}{bld}{overall}{nc}")
    lines.append("")

    counts = {"PASS": 0, "WARN": 0, "FAIL": 0, "SKIP": 0, "INFO": 0}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    lines.append(f"  {grn}PASS: {counts['PASS']}{nc}  |  {ylw}WARN: {counts['WARN']}{nc}  |  {red}FAIL: {counts['FAIL']}{nc}  |  {dim}SKIP: {counts['SKIP']}{nc}  |  {cyn}INFO: {counts['INFO']}{nc}")
    lines.append("")
    lines.append(f"{dim}{'-' * (W + 2)}{nc}")

    sections_grouped = {}
    for r in results:
        sections_grouped.setdefault(r.section, []).append(r)

    icon_map = {
        "PASS": f"{grn}[OK]{nc}",
        "WARN": f"{ylw}[!!]{nc}",
        "FAIL": f"{red}[XX]{nc}",
        "SKIP": f"{dim}[--]{nc}",
        "INFO": f"{cyn}[ii]{nc}",
    }

    for section, section_results in sections_grouped.items():
        lines.append("")
        lines.append(f"  {bld}{cyn}[{section.upper()}]{nc}")
        lines.append(f"  {dim}{'─' * (W - 2)}{nc}")
        for r in section_results:
            sc = _status_color(r.status) if color else ""
            icon = icon_map.get(r.status, "[??]")
            actual = r.actual
            expected = r.expected
            if privacy:
                actual = re.sub(r'\d+\.\d+\.\d+\.\d+', '***', actual)
                expected = re.sub(r'\d+\.\d+\.\d+\.\d+', '***', expected)
            lines.append(f"  {icon}  {sc}{r.name}{nc}")
            lines.append(f"         {dim}Actual:{nc} {actual}  {dim}|{nc}  {dim}Expected:{nc} {expected}")
            if r.evidence:
                ev = r.evidence
                if privacy:
                    ev = re.sub(r'\d+\.\d+\.\d+\.\d+', '***', ev)
                lines.append(f"         {dim}Evidence:{nc} {ev}")
            if r.status in ("WARN", "FAIL"):
                if r.impact:
                    lines.append(f"         {ylw}Impact:{nc} {r.impact}")
                if r.fix_hint:
                    lines.append(f"         {blu}Fix:{nc} {r.fix_hint}")
            lines.append("")

    lines.append(f"{dim}{'=' * (W + 2)}{nc}")

    # Remediation summary
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

    # Drift detection
    drift_items = [r for r in results if r.status in ("WARN", "FAIL")
                   and r.section in ("Kernel & Sysctl", "NFS Client", "Mounts")]
    if drift_items:
        lines.append("")
        lines.append(f"  {bld}{ylw}DRIFT FROM INSTALLER BASELINE{nc}")
        lines.append(f"  {dim}{'─' * (W - 2)}{nc}")
        for r in drift_items:
            sc = red if r.status == "FAIL" else ylw
            lines.append(f"  {sc}{r.section} > {r.name}{nc}")
            lines.append(f"    {dim}Current:{nc} {r.actual}  {dim}|{nc}  {dim}Expected:{nc} {r.expected}")
            if r.fix_hint:
                lines.append(f"    {blu}Fix:{nc} {r.fix_hint}")
        lines.append("")
        lines.append(f"{dim}{'=' * (W + 2)}{nc}")

    return "\n".join(lines)

def generate_json_report(results, metadata, host_inventory, privacy=False):
    overall = compute_overall(results)

    if privacy:
        metadata = dict(metadata)
        metadata["hostname"] = "***"
        host_inventory = dict(host_inventory)
        for k in list(host_inventory.keys()):
            if isinstance(host_inventory[k], str):
                host_inventory[k] = re.sub(r'\d+\.\d+\.\d+\.\d+', '***', host_inventory[k])

    report = {
        "metadata": metadata,
        "host_inventory": host_inventory,
        "overall": overall,
        "summary": {
            "pass": sum(1 for r in results if r.status == "PASS"),
            "warn": sum(1 for r in results if r.status == "WARN"),
            "fail": sum(1 for r in results if r.status == "FAIL"),
            "skip": sum(1 for r in results if r.status == "SKIP"),
            "info": sum(1 for r in results if r.status == "INFO"),
        },
        "checks": [r.to_dict() for r in results],
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
    flag_privacy = "--privacy" in flags

    try:
        profile = load_profile(profile_file)
    except Exception as e:
        print(f"Error loading profile: {e}", file=sys.stderr)
        sys.exit(1)

    import socket
    start_time = time.time()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    hostname = socket.gethostname()

    # Host inventory
    host_inventory = {
        "hostname": hostname,
        "kernel": platform.release(),
        "os": read_file("/etc/os-release") and
              re.search(r'PRETTY_NAME="([^"]*)"', read_file("/etc/os-release") or ""),
        "cpu": run_cmd("nproc 2>/dev/null") or "N/A",
        "ram_gb": "N/A",
        "gpu_present": os.path.isdir("/proc/driver/nvidia"),
        "nics": ", ".join(get_high_speed_interfaces()),
    }
    # Fix OS name extraction
    os_match = host_inventory["os"]
    host_inventory["os"] = os_match.group(1) if os_match else "unknown"
    # RAM
    meminfo = read_file("/proc/meminfo")
    if meminfo:
        m = re.search(r'MemTotal:\s+(\d+)', meminfo)
        if m:
            host_inventory["ram_gb"] = f"{int(m.group(1)) // 1048576}GB"

    exp = profile.get("expectations", {})
    sections = profile.get("sections", {})

    # Run checks
    all_results = []
    section_map = {
        "host_info": check_host_info,
        "kernel_sysctl": check_kernel_sysctl,
        "nfs_client": check_nfs_client,
        "mounts": check_mounts,
        "network": check_network,
        "rdma": check_rdma,
        "gds": check_gds,
        "runtime": check_runtime,
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
                str(e), "N/A", evidence=f"Section failed: {e}"))

    duration = f"{time.time() - start_time:.1f}s"
    metadata = {
        "timestamp": timestamp,
        "hostname": hostname,
        "profile": profile.get("profile", "unknown"),
        "description": profile.get("description", ""),
        "duration": duration,
    }

    # Generate reports (plain for saving, colored for display)
    text_report_plain = generate_text_report(all_results, metadata, flag_privacy, color=False)
    text_report_color = generate_text_report(all_results, metadata, flag_privacy, color=True)
    json_report = generate_json_report(all_results, metadata, host_inventory, flag_privacy)

    # Save reports (always plain text, no ANSI codes)
    if not flag_no_save:
        try:
            os.makedirs(log_dir, mode=0o755, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            text_path = os.path.join(log_dir, f"client-health_{ts}.txt")
            json_path = os.path.join(log_dir, f"client-health_{ts}.json")
            with open(text_path, "w") as f:
                f.write(text_report_plain)
            with open(json_path, "w") as f:
                f.write(json_report)
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
        cat "$CHC_TMP_DIR/hc_err" >&2
        return 1
    fi

    # Extract saved report paths from stderr
    local report_text report_json
    report_text=$(grep '__REPORT_TEXT__=' "$CHC_TMP_DIR/hc_err" 2>/dev/null | sed 's/__REPORT_TEXT__=//' || true)
    report_json=$(grep '__REPORT_JSON__=' "$CHC_TMP_DIR/hc_err" 2>/dev/null | sed 's/__REPORT_JSON__=//' || true)

    [[ -n "$report_text" ]] && echo "$report_text" > "$CHC_TMP_DIR/last_report_text"
    [[ -n "$report_json" ]] && echo "$report_json" > "$CHC_TMP_DIR/last_report_json"

    echo "$out"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Menu Functions
# ═══════════════════════════════════════════════════════════════════════════════

run_and_display_client_healthcheck() {
    local profile="$1"
    shift
    local flags=("$@")
    local profile_file="$CHC_PROFILES_DIR/${profile}.yml"

    # Create tmp dir in parent shell so subshell $(...) inherits it
    # without setting a new EXIT trap that would delete files prematurely
    _chc_ensure_tmp

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
    result_file=$(run_client_healthcheck "$profile_file" "${flags[@]}") || true

    if [[ -n "$result_file" ]] && [[ -f "$result_file" ]]; then
        # Extract overall status and summary from report
        local overall summary saved_path=""
        overall=$(grep 'Overall:' "$result_file" 2>/dev/null | head -1 | sed 's/.*\[//;s/\].*//' || true)
        summary=$(grep -E 'PASS:.*WARN:.*FAIL:' "$result_file" 2>/dev/null | head -1 | sed 's/^  //' || true)

        if [[ -f "$CHC_TMP_DIR/last_report_text" ]]; then
            saved_path=$(cat "$CHC_TMP_DIR/last_report_text")
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
                text_box "🩺 Client Health Check Results" "$result_file"
            fi

            # Offer remediation wizard if issues found
            if [[ "$overall" != "PASS" ]] && [[ -f "$CHC_TMP_DIR/last_report_json" ]]; then
                local wiz_json_path
                wiz_json_path=$(cat "$CHC_TMP_DIR/last_report_json")
                if [[ -f "$wiz_json_path" ]]; then
                    if yes_no "🔧 Remediation Wizard" \
                        "Issues were found in the health check.\n\nWould you like to run the remediation wizard\nto fix them automatically?"; then
                        client_remediation_wizard "$wiz_json_path"
                    fi
                fi
            fi
        else
            cat "$result_file"
        fi
    fi
}

view_last_client_report() {
    local latest
    latest=$(ls -t "$CHC_LOG_DIR"/client-health_*.txt 2>/dev/null | head -1)
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

view_client_report_directory() {
    _chc_ensure_tmp

    if [[ ! -d "$CHC_LOG_DIR" ]] || [[ -z "$(ls -A "$CHC_LOG_DIR"/*.txt 2>/dev/null)" ]]; then
        if declare -f msg_box &>/dev/null; then
            msg_box "No Reports" "No health check reports found in:\n$CHC_LOG_DIR"
        else
            echo "No health check reports found."
        fi
        return
    fi

    local -a menu_items=()
    local -a files=()
    local i=1

    while IFS= read -r file; do
        local basename
        basename=$(basename "$file" .txt)
        local ts
        ts=$(echo "$basename" | sed 's/client-health_//' | sed 's/_/ /')
        files+=("$file")
        menu_items+=("$i" "📄 $ts")
        ((i++))
    done < <(ls -t "$CHC_LOG_DIR"/client-health_*.txt 2>/dev/null | head -20)

    if [[ ${#menu_items[@]} -eq 0 ]]; then
        if declare -f msg_box &>/dev/null; then
            msg_box "No Reports" "No reports found."
        fi
        return
    fi

    menu_items+=("0" "🔙 Back")

    if declare -f menu_select &>/dev/null; then
        local choice
        choice=$(menu_select "📂 Client Health Reports" "Select a report to view:" \
            "${menu_items[@]}") || return

        [[ "$choice" == "0" ]] && return
        local idx=$((choice - 1))
        if [[ $idx -ge 0 && $idx -lt ${#files[@]} ]]; then
            text_box "📄 $(basename "${files[$idx]}")" "${files[$idx]}"
        fi
    fi
}

client_remediation_wizard() {
    local json_path="$1"
    _chc_ensure_tmp
    local issues_file="$CHC_TMP_DIR/fixable_issues"
    local manual_file="$CHC_TMP_DIR/manual_issues"
    local sysctl_file="$CHC_TMP_DIR/sysctl_applied"

    # Extract fixable issues from JSON report
    python3 - "$json_path" "$issues_file" "$manual_file" << 'PYEOF'
import sys, json, re

json_path = sys.argv[1]
issues_path = sys.argv[2]
manual_path = sys.argv[3]

AUTO_PATTERNS = [
    r'^sysctl\s+-w\s+',
    r'^echo\s+.*\s*>\s*/',
    r'^ip\s+link\s+set\s+',
    r'^modprobe\s+',
    r'^apt\s+install\s+',
    r'^timedatectl\s+',
    r'^systemctl\s+(start|restart|enable)\s+',
]

def is_auto_fixable(hint):
    for pat in AUTO_PATTERNS:
        if re.match(pat, hint):
            return True
    return False

with open(json_path) as f:
    report = json.load(f)

auto_issues = []
manual_issues = []
idx = 0

for check in report.get("checks", []):
    if check["status"] not in ("FAIL", "WARN"):
        continue
    hint = check.get("fix_hint", "").strip()
    if not hint:
        continue
    idx += 1
    line = "{idx}|{status}|{section}|{name}|{hint}|{auto}".format(
        idx=idx, status=check["status"], section=check["section"],
        name=check["name"], hint=hint, auto="1" if is_auto_fixable(hint) else "0"
    )
    if is_auto_fixable(hint):
        auto_issues.append(line)
    else:
        manual_issues.append(line)

with open(issues_path, "w") as f:
    f.write("\n".join(auto_issues))

with open(manual_path, "w") as f:
    f.write("\n".join(manual_issues))
PYEOF

    # Count issues
    local auto_count=0 manual_count=0
    [[ -s "$issues_file" ]] && auto_count=$(wc -l < "$issues_file")
    [[ -s "$manual_file" ]] && manual_count=$(wc -l < "$manual_file")

    if [[ $auto_count -eq 0 && $manual_count -eq 0 ]]; then
        msg_box "✅ No Fixable Issues" "No issues with fix hints were found.\n\nThe client looks good!"
        return
    fi

    # Build check_list from auto-fixable issues
    if [[ $auto_count -gt 0 ]]; then
        local -a cl_items=()
        while IFS='|' read -r idx status section name hint auto; do
            [[ -z "$idx" ]] && continue
            local default_state="OFF"
            [[ "$status" == "FAIL" ]] && default_state="ON"
            local label="[$status] $section > $name"
            [[ ${#label} -gt 60 ]] && label="${label:0:57}..."
            cl_items+=("$idx" "$label" "$default_state")
        done < "$issues_file"

        local selected=""
        selected=$(check_list "🔧 Client Remediation Wizard" \
            "Select issues to fix ($auto_count auto-fixable).\nFAIL items are pre-selected, WARN items are not." \
            "${cl_items[@]}") || {
            if [[ $manual_count -gt 0 ]]; then
                _chc_show_manual_guidance "$manual_file"
            fi
            return
        }

        if [[ -n "$selected" ]]; then
            > "$sysctl_file"
            local applied=0 failed=0

            for sel_idx in $selected; do
                sel_idx="${sel_idx//\"/}"
                local line=""
                line=$(grep "^${sel_idx}|" "$issues_file" 2>/dev/null || true)
                [[ -z "$line" ]] && continue

                IFS='|' read -r _idx status section name hint _auto <<< "$line"

                if yes_no "🔧 Apply Fix" \
                    "[$status] $section > $name\n\nCommand to run:\n  $hint\n\nExecute this fix?"; then

                    local output="" rc=0
                    output=$(bash -c "$hint" 2>&1) || rc=$?

                    if [[ $rc -eq 0 ]]; then
                        ((applied++))
                        msg_box "✅ Fix Applied" "[$status] $section > $name\n\nCommand succeeded.\n${output:+\nOutput: $output}"
                        if [[ "$hint" =~ ^sysctl\ -w\  ]]; then
                            echo "$hint" >> "$sysctl_file"
                        fi
                    else
                        ((failed++))
                        msg_box "❌ Fix Failed" "[$status] $section > $name\n\nCommand failed (exit code $rc).\n${output:+\nOutput: $output}"
                    fi
                fi
            done

            if [[ $applied -gt 0 || $failed -gt 0 ]]; then
                msg_box "🔧 Remediation Summary" "$applied fix(es) applied successfully.\n$failed fix(es) failed."
            fi

            # Sysctl persistence
            if [[ -s "$sysctl_file" ]]; then
                if yes_no "💾 Persist Sysctl Changes" \
                    "Some sysctl values were changed at runtime.\n\nMake them persistent across reboots?\n(Writes to /etc/sysctl.d/90-nfs-client-tuning.conf)"; then
                    local sysctl_conf="/etc/sysctl.d/90-nfs-client-tuning.conf"
                    {
                        echo "# xiNAS client health check remediation - $(date '+%Y-%m-%d %H:%M:%S')"
                        while IFS= read -r scmd; do
                            local kv="${scmd#sysctl -w }"
                            echo "$kv"
                        done < "$sysctl_file"
                    } > "$sysctl_conf"
                    msg_box "💾 Saved" "Sysctl settings written to:\n$sysctl_conf"
                fi
            fi
        fi
    fi

    # Show manual guidance if any
    if [[ $manual_count -gt 0 ]]; then
        _chc_show_manual_guidance "$manual_file"
    fi

    # Offer re-run
    if yes_no "🔄 Re-run Health Check" \
        "Would you like to re-run a quick health check\nto verify the applied fixes?"; then
        run_and_display_client_healthcheck "default"
    fi
}

_chc_show_manual_guidance() {
    local manual_file="$1"
    _chc_ensure_tmp
    local guide="$CHC_TMP_DIR/manual_guide"

    {
        echo "The following issues require manual intervention:"
        echo ""
        local i=0
        while IFS='|' read -r idx status section name hint auto; do
            [[ -z "$idx" ]] && continue
            ((i++))
            echo "  $i. [$status] $section > $name"
            echo "     -> $hint"
            echo ""
        done < "$manual_file"
    } > "$guide"

    text_box "📋 Manual Remediation Steps" "$guide"
}

client_healthcheck_menu() {
    # Determine available profiles
    local -a profiles=()
    local -a profile_labels=()
    for yml in "$CHC_PROFILES_DIR"/*.yml; do
        [[ -f "$yml" ]] || continue
        local pname
        pname=$(basename "$yml" .yml)
        profiles+=("$pname")
    done

    local choice
    while true; do
        choice=$(menu_select "🩺 Client Health Check" "Validate NFS client configuration (read-only)" \
            "1" "⚡ Quick Check (< 1 min)" \
            "2" "📋 Standard Check (2-5 min)" \
            "3" "🔬 Deep Check (5-10 min)" \
            "4" "📄 View Last Report" \
            "5" "📂 Browse Reports" \
            "6" "🔧 Remediation Wizard" \
            "0" "🔙 Back") || break

        case "$choice" in
            1)
                local profile="default"
                local extra_flags=""
                # Offer profile selection
                local profile_choice
                profile_choice=$(menu_select "Select Profile" "Choose workload profile for validation:" \
                    "1" "📋 Default (general NFS client)" \
                    "2" "🤖 AI Training (GPU, high throughput)" \
                    "3" "📚 HPC Read-Mostly (aggressive caching)" \
                    "4" "💾 Checkpoint Heavy (strict consistency)") || continue
                case "$profile_choice" in
                    1) profile="default" ;;
                    2) profile="ai-training" ;;
                    3) profile="hpc-readmostly" ;;
                    4) profile="checkpoint-heavy" ;;
                esac
                run_and_display_client_healthcheck "$profile"
                ;;
            2)
                local profile_choice
                profile_choice=$(menu_select "Select Profile" "Choose workload profile for validation:" \
                    "1" "📋 Default (general NFS client)" \
                    "2" "🤖 AI Training (GPU, high throughput)" \
                    "3" "📚 HPC Read-Mostly (aggressive caching)" \
                    "4" "💾 Checkpoint Heavy (strict consistency)") || continue
                local profile="default"
                case "$profile_choice" in
                    1) profile="default" ;;
                    2) profile="ai-training" ;;
                    3) profile="hpc-readmostly" ;;
                    4) profile="checkpoint-heavy" ;;
                esac
                run_and_display_client_healthcheck "$profile"
                ;;
            3)
                local profile_choice
                profile_choice=$(menu_select "Select Profile" "Choose workload profile for validation:" \
                    "1" "📋 Default (general NFS client)" \
                    "2" "🤖 AI Training (GPU, high throughput)" \
                    "3" "📚 HPC Read-Mostly (aggressive caching)" \
                    "4" "💾 Checkpoint Heavy (strict consistency)") || continue
                local profile="default"
                case "$profile_choice" in
                    1) profile="default" ;;
                    2) profile="ai-training" ;;
                    3) profile="hpc-readmostly" ;;
                    4) profile="checkpoint-heavy" ;;
                esac
                # Offer toggle options for deep check
                local toggle_flags=""
                if declare -f check_list &>/dev/null; then
                    toggle_flags=$(check_list "🔬 Deep Check Options" "Toggle optional checks:" \
                        "Mounts" "Validate NFS mounts and list all" "ON" \
                        "RDMA" "Include RDMA/NFSoRDMA checks" "ON" \
                        "GDS" "Include GPUDirect Storage checks" "ON" \
                        "Privacy" "Redact hostnames/IPs in report" "OFF") || continue
                fi
                local flags=()
                if [[ "$toggle_flags" == *"Privacy"* ]]; then
                    flags+=("--privacy")
                fi
                run_and_display_client_healthcheck "$profile" "${flags[@]}"
                ;;
            4) view_last_client_report ;;
            5) view_client_report_directory ;;
            6)
                _chc_ensure_tmp
                local json_path=""
                if [[ -f "$CHC_TMP_DIR/last_report_json" ]]; then
                    json_path=$(cat "$CHC_TMP_DIR/last_report_json")
                fi
                if [[ -z "$json_path" ]] || [[ ! -f "$json_path" ]]; then
                    json_path=$(ls -t "$CHC_LOG_DIR"/client-health_*.json 2>/dev/null | head -1)
                fi
                if [[ -n "$json_path" ]] && [[ -f "$json_path" ]]; then
                    client_remediation_wizard "$json_path"
                else
                    msg_box "No Report" "No health check report found.\n\nRun a health check first."
                fi
                ;;
            0) break ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# CLI Entry Point (standalone mode)
# ═══════════════════════════════════════════════════════════════════════════════

_chc_cli_main() {
    local profile="default"
    local flags=()
    local interactive=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --default)          profile="default" ;;
            --ai-training)      profile="ai-training" ;;
            --hpc-readmostly)   profile="hpc-readmostly" ;;
            --checkpoint-heavy) profile="checkpoint-heavy" ;;
            --json)             flags+=("--json") ;;
            --no-save)          flags+=("--no-save") ;;
            --privacy)          flags+=("--privacy") ;;
            --menu)             interactive=true ;;
            --help|-h)
                echo "xiNAS Client Health Check"
                echo ""
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Profiles:"
                echo "  --default            General NFS client (default)"
                echo "  --ai-training        AI/ML training workload"
                echo "  --hpc-readmostly     HPC read-mostly workload"
                echo "  --checkpoint-heavy   Checkpoint-heavy workload"
                echo ""
                echo "Options:"
                echo "  --json        Output JSON instead of text"
                echo "  --no-save     Don't save report to disk"
                echo "  --privacy     Redact hostnames and IPs"
                echo "  --menu        Launch interactive menu"
                echo "  --help, -h    Show this help"
                echo ""
                echo "Reports saved to: $CHC_LOG_DIR/"
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
        client_healthcheck_menu
        return
    fi

    local profile_file="$CHC_PROFILES_DIR/${profile}.yml"
    if [[ ! -f "$profile_file" ]]; then
        echo "Error: Profile not found: $profile_file" >&2
        exit 1
    fi

    _chc_ensure_tmp
    local result_file=""
    result_file=$(run_client_healthcheck "$profile_file" "${flags[@]}") || true
    if [[ -n "$result_file" ]] && [[ -f "$result_file" ]]; then
        cat "$result_file"
    fi
}

# Run CLI if executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    _chc_cli_main "$@"
fi
