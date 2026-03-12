"""CLI entry point: python -m xinas_menu [options]

Flags:
  --version        Print version and exit
  --status         Print system status (no TUI)
  --no-welcome     Skip welcome splash screen
  --setup          Launch startup/provisioning app (xinas-setup)
"""
from __future__ import annotations

import argparse
import sys


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="xinas_menu",
        description="xiNAS Management Console",
    )
    p.add_argument("--version", action="store_true", help="Print version and exit")
    p.add_argument("--status", action="store_true", help="Print system status (no TUI)")
    p.add_argument("--no-welcome", action="store_true", help="Skip welcome screen")
    p.add_argument("--setup", action="store_true", help="Launch setup/provisioning menu")
    p.add_argument(
        "--grpc-address",
        default="localhost:6066",
        metavar="HOST:PORT",
        help="xiRAID gRPC address (default: localhost:6066)",
    )
    return p.parse_args()


def _print_version(setup_mode: bool = False) -> None:
    from xinas_menu.version import XINAS_MENU_VERSION
    name = "xinas_setup" if setup_mode else "xinas_menu"
    print(f"{name} {XINAS_MENU_VERSION}")


def _print_status() -> None:
    """Print a brief system status without launching the TUI."""
    import socket
    import platform
    from xinas_menu.version import XINAS_MENU_VERSION
    from xinas_menu.utils.service_ctl import ServiceController

    print(f"xiNAS Management Console v{XINAS_MENU_VERSION}")
    print(f"Hostname:  {socket.gethostname()}")
    print(f"OS:        {platform.system()} {platform.release()}")

    ctl = ServiceController()
    for svc in ("xiraid-server", "nfs-server", "xinas-nfs-helper", "xinas-mcp"):
        st = ctl.state(svc)
        sym = "●" if st.is_active else "○"
        print(f"  {sym} {svc:<30} {st.active}")


def main() -> None:
    args = _parse_args()

    if args.version:
        _print_version(setup_mode=args.setup)
        sys.exit(0)

    if args.status:
        _print_status()
        sys.exit(0)

    if args.setup:
        from xinas_menu.screens.startup.startup_menu import StartupApp
        app = StartupApp()
        app.run()
        sys.exit(0)

    # Default: main management menu
    from xinas_menu.app import XiNASApp
    app = XiNASApp(
        no_welcome=args.no_welcome,
        grpc_address=args.grpc_address,
    )
    app.run()


if __name__ == "__main__":
    main()
