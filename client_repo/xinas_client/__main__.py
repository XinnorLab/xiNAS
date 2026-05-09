"""CLI entry point: python -m xinas_client [options]

Flags:
  --version, -v        Print version and exit
  --status, -s         Show current NFS mounts
  --mount, -m          Quick mount: SERVER:SHARE MOUNTPOINT [PROTO] [SEC]
  --network-status, -n Show network configuration
  --csi, --csi-nfs     Open Kubernetes CSI menu
  --csi-status         Show CSI driver status
  --healthcheck, --hc  Run client health check
  --update, -u         Check for / install updates
  --no-welcome         Skip welcome splash screen
"""
from __future__ import annotations

import argparse
import sys


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="xinas_client",
        description="xiNAS NFS Client Console",
    )
    p.add_argument("--version", "-v", action="store_true", help="Print version and exit")
    p.add_argument("--status", "-s", action="store_true", help="Show current NFS mounts")
    p.add_argument(
        "--mount",
        "-m",
        nargs="+",
        metavar="ARG",
        help="Quick mount: SERVER:SHARE MOUNTPOINT [PROTO] [SEC]",
    )
    p.add_argument(
        "--network-status", "-n", action="store_true", help="Show network configuration"
    )
    p.add_argument("--csi", "--csi-nfs", action="store_true", help="Open CSI NFS menu")
    p.add_argument("--csi-status", action="store_true", help="Show CSI driver status")
    p.add_argument(
        "--healthcheck",
        "--hc",
        nargs="*",
        default=None,
        metavar="PROFILE",
        help="Run client health check",
    )
    p.add_argument("--update", "-u", action="store_true", help="Check for updates")
    p.add_argument("--no-welcome", action="store_true", help="Skip welcome screen")
    return p.parse_args()


def _print_version() -> None:
    from xinas_client.version import CLIENT_VERSION

    print(f"xinas_client {CLIENT_VERSION}")


def _print_status() -> None:
    """Show active NFS mounts."""
    import subprocess

    print("Active NFS mounts:")
    r = subprocess.run(
        ["mount", "-t", "nfs,nfs4"],
        capture_output=True,
        text=True,
    )
    if r.returncode == 0 and r.stdout.strip():
        for line in r.stdout.strip().splitlines():
            print(f"  {line}")
    else:
        print("  (none)")


def _print_network_status() -> None:
    """Show network interface summary."""
    import subprocess

    print("Network interfaces:")
    r = subprocess.run(
        ["ip", "-br", "addr"],
        capture_output=True,
        text=True,
    )
    if r.returncode == 0:
        print(r.stdout)


def _cli_mount(args: list[str]) -> None:
    """Quick mount from CLI arguments."""
    if len(args) < 2:
        print("Usage: --mount SERVER:SHARE MOUNTPOINT [PROTO] [SEC]", file=sys.stderr)
        sys.exit(1)

    server_share = args[0]
    mount_point = args[1]
    proto = args[2] if len(args) > 2 else "tcp"
    sec = args[3] if len(args) > 3 else "sys"

    import subprocess
    import os

    os.makedirs(mount_point, exist_ok=True)

    opts = (
        f"vers=4.2,proto={proto},hard,nconnect=16,"
        f"rsize=1048576,wsize=1048576,"
        f"lookupcache=all,sec={sec}"
    )

    cmd = ["mount", "-t", "nfs", "-o", opts, server_share, mount_point]
    print(f"Mounting {server_share} → {mount_point}  (proto={proto}, sec={sec})")
    r = subprocess.run(cmd)
    sys.exit(r.returncode)


def _run_healthcheck(profiles: list[str] | None) -> None:
    """Run client_healthcheck.sh."""
    import subprocess
    from pathlib import Path

    script = Path(__file__).resolve().parent.parent / "client_healthcheck.sh"
    if not script.exists():
        print(f"Health check script not found: {script}", file=sys.stderr)
        sys.exit(1)

    cmd = ["bash", str(script)]
    if profiles:
        cmd.extend(profiles)
    r = subprocess.run(cmd)
    sys.exit(r.returncode)


def _check_update() -> None:
    """Check for updates and optionally install."""
    from xinas_client.utils.update_check import UpdateChecker

    checker = UpdateChecker()
    available = checker._check_sync()
    if available:
        print("Update available.")
        answer = input("Apply now? [y/N]: ").strip().lower()
        if answer == "y":
            ok, msg = checker.apply_update()
            if ok:
                print(f"Updated: {msg}")
                print("Restarting...")
                checker.restart_self()
            else:
                print(f"Update failed: {msg}", file=sys.stderr)
                sys.exit(1)
    else:
        print("Already up to date.")


def main() -> None:
    args = _parse_args()

    if args.version:
        _print_version()
        sys.exit(0)

    if args.status:
        _print_status()
        sys.exit(0)

    if args.mount:
        _cli_mount(args.mount)

    if args.network_status:
        _print_network_status()
        sys.exit(0)

    if args.healthcheck is not None:
        _run_healthcheck(args.healthcheck or None)

    if args.update:
        _check_update()
        sys.exit(0)

    # Default: launch TUI
    from xinas_client.app import XiNASClientApp

    app = XiNASClientApp(no_welcome=args.no_welcome)
    app.run()


if __name__ == "__main__":
    main()
