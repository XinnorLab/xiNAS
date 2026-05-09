"""GpuDirectScreen -- GPUDirect Storage (GDS) management submenu."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer
from textual import work

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView
from xinas_client.widgets.confirm_dialog import ConfirmDialog
from xinas_client.widgets.input_dialog import InputDialog

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_GRN, _YLW, _RED, _CYN = "\033[32m", "\033[33m", "\033[31m", "\033[36m"
_BLD, _DIM, _NC = "\033[1m", "\033[2m", "\033[0m"

_CUFILE_PATH = Path("/etc/cufile.json")

_ITEMS = [
    MenuItem("1", "Show GDS Status"),
    MenuItem("2", "Install GDS"),
    MenuItem("3", "Configure cuFile"),
    MenuItem("4", "Verify GDS"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

_HELP_TEXT = f"""\

  {_CYN}{'─' * 60}{_NC}
  {_BLD}GPUDirect Storage (GDS){_NC}
  {_CYN}{'─' * 60}{_NC}

  {_BLD}[1]{_NC} Show GDS Status
  {_DIM}    Check nvidia-fs module, cufile.json, GPU info{_NC}

  {_BLD}[2]{_NC} Install GDS
  {_DIM}    Install nvidia-gds package and load nvidia-fs module{_NC}

  {_BLD}[3]{_NC} Configure cuFile
  {_DIM}    Generate /etc/cufile.json for RDMA NFS mounts{_NC}

  {_BLD}[4]{_NC} Verify GDS
  {_DIM}    Run all GDS verification checks{_NC}
"""


class GpuDirectScreen(Screen):
    """GPUDirect Storage management submenu."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  GPUDirect Storage", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="gds-nav")
            yield ScrollableTextView(_HELP_TEXT, id="gds-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "1":
            self._show_status()
        elif key == "2":
            self._install_gds()
        elif key == "3":
            self._configure_cufile()
        elif key == "4":
            self._verify_gds()
        elif key == "0":
            self.app.pop_screen()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    # ── [1] Show GDS Status ──────────────────────────────────────────

    @work(exclusive=True)
    async def _show_status(self) -> None:
        view = self.query_one("#gds-content", ScrollableTextView)
        loop = asyncio.get_running_loop()
        try:
            text = await loop.run_in_executor(None, _build_gds_status)
        except Exception:
            _log.debug("GDS status build failed", exc_info=True)
            text = f"  {_RED}Error building GDS status{_NC}"
        view.set_content(text)

    # ── [2] Install GDS ──────────────────────────────────────────────

    @work(exclusive=True)
    async def _install_gds(self) -> None:
        view = self.query_one("#gds-content", ScrollableTextView)

        confirmed = await self.app.push_screen_wait(
            ConfirmDialog(
                "Install GPUDirect Storage?\n\n"
                "This will run:\n"
                "  apt-get install -y nvidia-gds\n"
                "  modprobe nvidia-fs\n\n"
                "Root privileges are required.",
                "Install GDS",
            )
        )
        if not confirmed:
            return

        view.set_content(f"  {_BLD}Installing GPUDirect Storage...{_NC}\n")
        loop = asyncio.get_running_loop()

        # Step 1: apt-get install
        view.append(f"  {_DIM}Running: apt-get install -y nvidia-gds{_NC}")
        rc, out, err = await loop.run_in_executor(None, _run_apt_install_gds)
        if rc != 0:
            view.append(f"  {_RED}[FAIL]{_NC} Installation failed (exit code {rc})")
            if err.strip():
                for line in err.strip().splitlines()[-5:]:
                    view.append(f"    {_DIM}{line}{_NC}")
            return
        view.append(f"  {_GRN}[OK]{_NC}   nvidia-gds package installed")

        # Step 2: modprobe nvidia-fs
        view.append(f"\n  {_DIM}Running: modprobe nvidia-fs{_NC}")
        rc, out, err = await loop.run_in_executor(None, _run_modprobe_nvidia_fs)
        if rc != 0:
            view.append(f"  {_RED}[FAIL]{_NC} Failed to load nvidia-fs module")
            if err.strip():
                for line in err.strip().splitlines()[-3:]:
                    view.append(f"    {_DIM}{line}{_NC}")
        else:
            view.append(f"  {_GRN}[OK]{_NC}   nvidia-fs module loaded")

        view.append(f"\n  {_GRN}Installation complete.{_NC}")
        view.append(f"  {_DIM}Run \"Show GDS Status\" or \"Verify GDS\" to confirm.{_NC}")

    # ── [3] Configure cuFile ─────────────────────────────────────────

    @work(exclusive=True)
    async def _configure_cufile(self) -> None:
        view = self.query_one("#gds-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        # Detect RDMA IPs from active interfaces
        rdma_ips = await loop.run_in_executor(None, _detect_rdma_ips)
        nfs_mounts = await loop.run_in_executor(None, _detect_nfs_mounts)

        default_ips = " ".join(rdma_ips) if rdma_ips else ""
        hint = ""
        if rdma_ips:
            hint = f"Detected RDMA IPs: {', '.join(rdma_ips)}"

        prompt = "Enter RDMA IP addresses (space-separated):"
        if hint:
            prompt = f"{hint}\n\n{prompt}"

        ip_input = await self.app.push_screen_wait(
            InputDialog(
                prompt,
                title="cuFile RDMA IPs",
                default=default_ips,
                placeholder="e.g. 10.0.0.1 10.0.0.2",
            )
        )
        if ip_input is None:
            return

        ips = ip_input.strip().split()
        if not ips:
            await self.app.push_screen_wait(
                ConfirmDialog("No IPs provided. Aborted.", "Error", ok_only=True)
            )
            return

        # Build cufile.json
        cufile_config = _build_cufile_json(ips, nfs_mounts)
        view.set_content(f"  {_BLD}Configuring {_CUFILE_PATH}{_NC}\n")

        # Backup existing cufile.json BEFORE any modification. Abort on failure.
        backup_ok, backup_path = await loop.run_in_executor(None, _backup_cufile)
        if not backup_ok:
            view.append(
                f"  {_RED}[FAIL]{_NC} Could not back up {_CUFILE_PATH} to {backup_path}"
            )
            view.append(f"  {_RED}[FAIL]{_NC} cufile.json was NOT modified.")
            return
        if backup_path:
            view.append(f"  {_GRN}[OK]{_NC}   backed up existing config to {backup_path}")
        else:
            view.append(f"  {_DIM}(no existing cufile.json -- nothing to back up){_NC}")

        view.append(f"  {_BLD}Writing {_CUFILE_PATH}{_NC}")
        try:
            rc = await loop.run_in_executor(
                None, _write_cufile, cufile_config
            )
            if rc == 0:
                view.append(f"  {_GRN}[OK]{_NC}   {_CUFILE_PATH} written successfully")
                view.append("")
                view.append(f"  {_BLD}Configuration:{_NC}")
                formatted = json.dumps(cufile_config, indent=2)
                for line in formatted.splitlines():
                    view.append(f"    {_DIM}{line}{_NC}")
            else:
                view.append(
                    f"  {_RED}[FAIL]{_NC} Could not write {_CUFILE_PATH} "
                    f"(permission denied?)"
                )
        except Exception as exc:
            view.append(f"  {_RED}[FAIL]{_NC} Error: {exc}")

    # ── [4] Verify GDS ───────────────────────────────────────────────

    @work(exclusive=True)
    async def _verify_gds(self) -> None:
        view = self.query_one("#gds-content", ScrollableTextView)
        loop = asyncio.get_running_loop()

        rule = f"  {_CYN}{'─' * 60}{_NC}"
        view.set_content(
            f"\n{rule}\n  {_BLD}GDS VERIFICATION{_NC}\n{rule}\n"
        )

        # Check 1: nvidia-fs module
        view.append(f"\n  {_BLD}[1/6] nvidia-fs kernel module{_NC}")
        loaded = await loop.run_in_executor(None, _check_nvidia_fs_loaded)
        if loaded:
            view.append(f"    {_GRN}[OK]{_NC}   nvidia-fs module is loaded")
        else:
            view.append(f"    {_RED}[FAIL]{_NC} nvidia-fs module is NOT loaded")

        # Check 2: GDS libraries
        view.append(f"\n  {_BLD}[2/6] GDS libraries{_NC}")
        libs_ok, libs_detail = await loop.run_in_executor(None, _check_gds_libraries)
        if libs_ok:
            view.append(f"    {_GRN}[OK]{_NC}   GDS libraries found")
        else:
            view.append(f"    {_RED}[FAIL]{_NC} GDS libraries not found")
        if libs_detail:
            view.append(f"    {_DIM}{libs_detail}{_NC}")

        # Check 3: /proc/driver/nvidia-fs
        view.append(f"\n  {_BLD}[3/6] /proc/driver/nvidia-fs{_NC}")
        proc_ok, proc_detail = await loop.run_in_executor(
            None, _check_proc_nvidia_fs
        )
        if proc_ok:
            view.append(f"    {_GRN}[OK]{_NC}   /proc/driver/nvidia-fs is present")
            if proc_detail:
                for line in proc_detail.splitlines()[:5]:
                    view.append(f"    {_DIM}{line}{_NC}")
        else:
            view.append(f"    {_RED}[FAIL]{_NC} /proc/driver/nvidia-fs not found")

        # Check 4: cufile.json
        view.append(f"\n  {_BLD}[4/6] cuFile configuration{_NC}")
        cufile_ok, cufile_detail = await loop.run_in_executor(
            None, _check_cufile_config
        )
        if cufile_ok:
            view.append(f"    {_GRN}[OK]{_NC}   {_CUFILE_PATH} is valid")
        else:
            view.append(f"    {_RED}[FAIL]{_NC} {cufile_detail}")

        # Check 5: gdscheck.py
        view.append(f"\n  {_BLD}[5/6] gdscheck tool{_NC}")
        gds_ok, gds_detail = await loop.run_in_executor(None, _run_gdscheck)
        if gds_ok:
            view.append(f"    {_GRN}[OK]{_NC}   gdscheck passed")
        else:
            view.append(f"    {_YLW}[SKIP]{_NC} {gds_detail}")

        # Check 6: GPU/NIC topology
        view.append(f"\n  {_BLD}[6/6] GPU / NIC topology{_NC}")
        topo_ok, topo_detail = await loop.run_in_executor(
            None, _check_gpu_nic_topology
        )
        if topo_ok:
            view.append(f"    {_GRN}[OK]{_NC}   GPU and NIC detected")
            if topo_detail:
                for line in topo_detail.splitlines()[:8]:
                    view.append(f"    {_DIM}{line}{_NC}")
        else:
            view.append(f"    {_YLW}[SKIP]{_NC} {topo_detail}")

        # Summary
        view.append(f"\n{rule}")
        passed = sum([loaded, libs_ok, proc_ok, cufile_ok, gds_ok, topo_ok])
        total = 6
        if passed == total:
            view.append(f"  {_GRN}All {total} checks passed.{_NC}")
        else:
            view.append(f"  {_YLW}{passed}/{total} checks passed.{_NC}")
        view.append("")


# ── Helpers (run in executor threads) ─────────────────────────────────


def _build_gds_status() -> str:
    """Build GDS status text. Runs in a worker thread."""
    lines: list[str] = []
    rule = f"  {_CYN}{'─' * 60}{_NC}"

    lines.append(f"\n{rule}")
    lines.append(f"  {_BLD}GPUDirect Storage Status{_NC}")
    lines.append(rule)
    lines.append("")

    # nvidia-smi
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi:
        lines.append(f"  {_GRN}\u25cf{_NC} nvidia-smi {_GRN}available{_NC}")
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,driver_version,memory.total",
                 "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0:
                for gpu_line in r.stdout.strip().splitlines():
                    lines.append(f"    {_DIM}{gpu_line.strip()}{_NC}")
        except Exception:
            pass
    else:
        lines.append(f"  {_RED}\u25cf{_NC} nvidia-smi {_RED}not found{_NC}")

    lines.append("")

    # nvidia-fs module
    loaded = _check_nvidia_fs_loaded()
    if loaded:
        lines.append(f"  {_GRN}\u25cf{_NC} nvidia-fs module {_GRN}loaded{_NC}")
    else:
        lines.append(f"  {_RED}\u25cf{_NC} nvidia-fs module {_RED}not loaded{_NC}")

    # cufile.json
    if _CUFILE_PATH.is_file():
        lines.append(f"  {_GRN}\u25cf{_NC} cuFile config {_GRN}present{_NC}")
        try:
            cfg = json.loads(_CUFILE_PATH.read_text())
            # Show key properties
            props = cfg.get("properties", {})
            if "rdma_dev_addr_list" in props:
                addrs = props["rdma_dev_addr_list"]
                if isinstance(addrs, list):
                    lines.append(
                        f"    {_DIM}RDMA addresses: "
                        f"{', '.join(str(a) for a in addrs)}{_NC}"
                    )
        except Exception:
            lines.append(f"    {_DIM}(could not parse cufile.json){_NC}")
    else:
        lines.append(f"  {_YLW}\u25cf{_NC} cuFile config {_YLW}not found{_NC}")
        lines.append(f"    {_DIM}Use \"Configure cuFile\" to create it{_NC}")

    # /proc/driver/nvidia-fs
    proc_path = Path("/proc/driver/nvidia-fs")
    if proc_path.is_dir():
        lines.append(f"  {_GRN}\u25cf{_NC} /proc/driver/nvidia-fs {_GRN}present{_NC}")
        try:
            stats_file = proc_path / "stats"
            if stats_file.is_file():
                content = stats_file.read_text().strip()
                for sline in content.splitlines()[:3]:
                    lines.append(f"    {_DIM}{sline}{_NC}")
        except Exception:
            pass
    else:
        lines.append(f"  {_DIM}\u25cf{_NC} /proc/driver/nvidia-fs {_DIM}absent{_NC}")

    lines.append("")
    return "\n".join(lines)


def _check_nvidia_fs_loaded() -> bool:
    """Check if nvidia_fs module is loaded."""
    try:
        with open("/proc/modules") as f:
            for line in f:
                if line.startswith("nvidia_fs "):
                    return True
    except Exception:
        pass
    return False


def _check_gds_libraries() -> tuple[bool, str]:
    """Check for GDS shared libraries."""
    lib_paths = [
        Path("/usr/local/cuda/lib64/libcufile.so"),
        Path("/usr/lib/x86_64-linux-gnu/libcufile.so"),
    ]
    for p in lib_paths:
        if p.exists():
            return True, str(p)
    # Try ldconfig
    try:
        r = subprocess.run(
            ["ldconfig", "-p"], capture_output=True, text=True, timeout=5,
        )
        if "libcufile" in r.stdout:
            return True, "found via ldconfig"
    except Exception:
        pass
    return False, "libcufile.so not found"


def _check_proc_nvidia_fs() -> tuple[bool, str]:
    """Check /proc/driver/nvidia-fs."""
    proc_path = Path("/proc/driver/nvidia-fs")
    if not proc_path.is_dir():
        return False, ""
    try:
        stats = (proc_path / "stats").read_text().strip()
        return True, stats
    except Exception:
        return True, ""


def _check_cufile_config() -> tuple[bool, str]:
    """Validate cufile.json exists and is valid JSON."""
    if not _CUFILE_PATH.is_file():
        return False, f"{_CUFILE_PATH} does not exist"
    try:
        json.loads(_CUFILE_PATH.read_text())
        return True, ""
    except json.JSONDecodeError as exc:
        return False, f"Invalid JSON: {exc}"
    except Exception as exc:
        return False, f"Cannot read: {exc}"


def _run_gdscheck() -> tuple[bool, str]:
    """Run gdscheck.py if available."""
    gdscheck = shutil.which("gdscheck") or shutil.which("gdscheck.py")
    if not gdscheck:
        # Try common install path
        for candidate in [
            "/usr/local/cuda/gds/tools/gdscheck.py",
            "/usr/local/cuda/tools/gdscheck.py",
        ]:
            if Path(candidate).is_file():
                gdscheck = candidate
                break
    if not gdscheck:
        return False, "gdscheck not found"
    try:
        r = subprocess.run(
            [gdscheck, "-p"], capture_output=True, text=True, timeout=30,
        )
        if r.returncode == 0:
            return True, ""
        return False, f"gdscheck exited with code {r.returncode}"
    except Exception as exc:
        return False, str(exc)


def _check_gpu_nic_topology() -> tuple[bool, str]:
    """Check GPU/NIC topology via nvidia-smi topo."""
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return False, "nvidia-smi not available"
    try:
        r = subprocess.run(
            ["nvidia-smi", "topo", "-m"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0 and r.stdout.strip():
            return True, r.stdout.strip()
        return False, "nvidia-smi topo returned no output"
    except Exception as exc:
        return False, str(exc)


def _detect_rdma_ips() -> list[str]:
    """Detect IP addresses on RDMA-capable interfaces."""
    ips: list[str] = []
    ib_dir = Path("/sys/class/infiniband")
    if not ib_dir.is_dir():
        return ips

    # Map IB devices to netdevs
    netdevs: set[str] = set()
    try:
        for dev in ib_dir.iterdir():
            ports_dir = dev / "ports"
            if not ports_dir.is_dir():
                continue
            for port in ports_dir.iterdir():
                gid_dir = port / "gid_attrs" / "ndevs"
                if gid_dir.is_dir():
                    for ndev_file in gid_dir.iterdir():
                        try:
                            netdevs.add(ndev_file.read_text().strip())
                        except Exception:
                            pass
    except Exception:
        pass

    # Also try /sys/class/net/*/device/driver for mlx
    try:
        net_dir = Path("/sys/class/net")
        for iface in net_dir.iterdir():
            try:
                driver = (iface / "device" / "driver").resolve().name
                if "mlx" in driver:
                    netdevs.add(iface.name)
            except Exception:
                pass
    except Exception:
        pass

    # Get IPs from those netdevs
    for nd in netdevs:
        try:
            r = subprocess.run(
                ["ip", "-4", "-o", "addr", "show", nd],
                capture_output=True, text=True, timeout=3,
            )
            for match in re.finditer(r"inet\s+(\d+\.\d+\.\d+\.\d+)", r.stdout):
                ips.append(match.group(1))
        except Exception:
            pass

    return sorted(set(ips))


def _detect_nfs_mounts() -> list[str]:
    """Detect active NFS mount points."""
    mounts: list[str] = []
    try:
        r = subprocess.run(
            ["mount", "-t", "nfs,nfs4"],
            capture_output=True, text=True, timeout=5,
        )
        for line in r.stdout.strip().splitlines():
            parts = line.split()
            if len(parts) >= 3:
                mounts.append(parts[2])
    except Exception:
        pass
    return mounts


def _build_cufile_json(
    rdma_ips: list[str],
    nfs_mounts: list[str],
) -> dict:
    """Build a cufile.json configuration dict."""
    config: dict = {
        "properties": {
            "max_direct_io_size_kb": 16384,
            "max_device_cache_size_kb": 131072,
            "max_device_pinned_mem_size_kb": 33554432,
            "posix_pool_slab_size_kb": 4096,
            "posix_pool_slab_count": 128,
            "rdma_dev_addr_list": rdma_ips,
            "allow_compat_mode": False,
            "poll_mode": False,
            "poll_thresh_size_kb": 4,
            "max_batch_io_timeout_msecs": 5,
            "max_direct_io_size_per_device_kb": 16384,
        },
        "fs": {
            "generic": {
                "posix_unaligned_writes": False,
            },
        },
    }

    # Add NFS mount entries if present
    if nfs_mounts:
        config["fs"]["mounts"] = [
            {"mountpoint": mp, "type": "nfs"} for mp in nfs_mounts
        ]

    return config


def _backup_cufile() -> tuple[bool, str]:
    """Back up /etc/cufile.json before modification.

    Returns (success, backup_path). If cufile.json does not exist, returns
    (True, "") since there is nothing to back up. On copy failure returns
    (False, attempted_path) so the caller can surface the path it tried.
    """
    if not _CUFILE_PATH.is_file():
        return True, ""
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    backup = Path(f"{_CUFILE_PATH}.bak.{ts}")
    try:
        shutil.copy2(_CUFILE_PATH, backup)
        return True, str(backup)
    except Exception:
        return False, str(backup)


def _write_cufile(config: dict) -> int:
    """Write cufile.json. Returns 0 on success, 1 on failure."""
    try:
        content = json.dumps(config, indent=2) + "\n"
        _CUFILE_PATH.write_text(content)
        return 0
    except PermissionError:
        return 1
    except Exception:
        return 1


def _run_apt_install_gds() -> tuple[int, str, str]:
    """Run apt-get install -y nvidia-gds."""
    try:
        r = subprocess.run(
            ["apt-get", "install", "-y", "nvidia-gds"],
            capture_output=True, text=True, timeout=300,
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "apt-get timed out after 5 minutes"
    except FileNotFoundError:
        return 1, "", "apt-get not found"
    except Exception as exc:
        return 1, "", str(exc)


def _run_modprobe_nvidia_fs() -> tuple[int, str, str]:
    """Run modprobe nvidia-fs."""
    try:
        r = subprocess.run(
            ["modprobe", "nvidia-fs"],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode, r.stdout, r.stderr
    except Exception as exc:
        return 1, "", str(exc)
