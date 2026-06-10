"""CLI entry point: python -m xinas_menu [options]

Flags:
  --version        Print version and exit
  --status         Print system status (no TUI)
  --no-welcome     Skip welcome splash screen
  --setup          Launch startup/provisioning app (xinas-setup)
"""
from __future__ import annotations

import argparse
import os
import sys


def _require_root_or_exit(action: str) -> None:
    """Exit with a clear message if not running as root.

    The TUI reads/writes root-owned paths (/etc/xinas-mcp/config.json mode
    0640, /root/.ssh/authorized_keys, etc.). On Python 3.12+ pathlib.Path.exists()
    propagates EACCES instead of swallowing it, so non-root invocations crash
    deep in the UI. Fail fast at the entrypoint instead.
    """
    if os.geteuid() != 0:
        sys.stderr.write(
            f"xinas_menu: the {action} must be run as root.\n"
            "Run:  sudo xinas-menu\n"
        )
        sys.exit(1)


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
    import platform
    import socket

    from xinas_menu.utils.service_ctl import ServiceController
    from xinas_menu.version import XINAS_MENU_VERSION

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
        _require_root_or_exit("setup menu")
        from xinas_menu.screens.startup.startup_menu import StartupApp
        app = StartupApp()
        app.run()
        sys.exit(0)

    # Default: main management menu
    _require_root_or_exit("management console")
    from xinas_menu.app import XiNASApp
    app = XiNASApp(
        no_welcome=args.no_welcome,
        grpc_address=args.grpc_address,
    )
    app.run()

    # Management screen can request a hand-off to the uninstaller. The TUI
    # must be fully torn down first because the script removes /opt/xiNAS
    # (the module we are executing from).
    if getattr(app, "return_value", None) == "uninstall":
        script = "/opt/xiNAS/uninstall.sh"
        if not os.path.isfile(script):
            sys.stderr.write(
                f"xinas_menu: {script} not found — cannot launch uninstaller.\n"
            )
            sys.exit(1)
        os.execvp("bash", ["bash", script])


if __name__ == "__main__":
    main()
