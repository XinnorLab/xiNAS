"""AdvancedSettingsScreen -- navigation hub for advanced client features."""
from __future__ import annotations

import logging

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Label, Footer

from xinas_client.widgets.menu_list import MenuItem, NavigableMenu
from xinas_client.widgets.text_view import ScrollableTextView

_log = logging.getLogger(__name__)

# ── ANSI color constants ──────────────────────────────────────────────
_BLD, _DIM, _CYN, _NC = "\033[1m", "\033[2m", "\033[36m", "\033[0m"

_ITEMS = [
    MenuItem("1", "Manage Mounts"),
    MenuItem("2", "Network Settings"),
    MenuItem("3", "Install NFS Tools"),
    MenuItem("4", "Install DOCA OFED"),
    MenuItem("5", "GPUDirect Storage"),
    MenuItem("6", "Kubernetes CSI NFS"),
    MenuItem("7", "Test Connection"),
    MenuItem("8", "Client Health Check"),
    MenuItem("9", "Check for Updates"),
    MenuItem("", "", separator=True),
    MenuItem("0", "Back"),
]

_HELP_TEXT = f"""\

  {_CYN}{'─' * 60}{_NC}
  {_BLD}Advanced Settings{_NC}
  {_CYN}{'─' * 60}{_NC}

  {_BLD}[1]{_NC} Manage Mounts
  {_DIM}    View, unmount, or remount active NFS shares{_NC}

  {_BLD}[2]{_NC} Network Settings
  {_DIM}    Configure storage network interfaces{_NC}

  {_BLD}[3]{_NC} Install NFS Tools
  {_DIM}    Install nfs-common and configure for high performance{_NC}

  {_BLD}[4]{_NC} Install DOCA OFED
  {_DIM}    Install NVIDIA DOCA drivers for RDMA networking{_NC}

  {_BLD}[5]{_NC} GPUDirect Storage
  {_DIM}    Configure GPUDirect Storage (GDS) for direct GPU-NFS I/O{_NC}

  {_BLD}[6]{_NC} Kubernetes CSI NFS
  {_DIM}    Install and configure the NFS CSI driver for Kubernetes{_NC}

  {_BLD}[7]{_NC} Test Connection
  {_DIM}    Verify connectivity and throughput to the NAS server{_NC}

  {_BLD}[8]{_NC} Client Health Check
  {_DIM}    Run diagnostics on NFS, RDMA, and network configuration{_NC}

  {_BLD}[9]{_NC} Check for Updates
  {_DIM}    Check for newer versions of the xiNAS client package{_NC}
"""


class AdvancedSettingsScreen(Screen):
    """Submenu providing access to advanced client management features."""

    BINDINGS = [
        Binding("escape", "go_back", "Back", show=True, key_display="0/Esc"),
        Binding("0", "go_back", "Back", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("  Advanced Settings", id="screen-title")
        with Horizontal(id="split-layout"):
            yield NavigableMenu(_ITEMS, id="advanced-nav")
            yield ScrollableTextView(_HELP_TEXT, id="advanced-content")
        yield Footer()

    def on_navigable_menu_selected(self, event: NavigableMenu.Selected) -> None:
        key = event.key.upper()
        if key == "0":
            self.app.pop_screen()
        elif key == "1":
            from xinas_client.screens.manage_mounts import ManageMountsScreen

            self.app.push_screen(ManageMountsScreen())
        elif key == "2":
            from xinas_client.screens.network import NetworkScreen

            self.app.push_screen(NetworkScreen())
        elif key == "3":
            from xinas_client.screens.install_nfs import InstallNfsScreen

            self.app.push_screen(InstallNfsScreen())
        elif key == "4":
            from xinas_client.screens.install_doca import InstallDocaScreen

            self.app.push_screen(InstallDocaScreen())
        elif key == "5":
            from xinas_client.screens.gds import GpuDirectScreen

            self.app.push_screen(GpuDirectScreen())
        elif key == "6":
            from xinas_client.screens.csi_nfs import K8sCsiScreen

            self.app.push_screen(K8sCsiScreen())
        elif key == "7":
            from xinas_client.screens.test_connection import TestConnectionScreen

            self.app.push_screen(TestConnectionScreen())
        elif key == "8":
            from xinas_client.screens.health_check import HealthCheckScreen

            self.app.push_screen(HealthCheckScreen())
        elif key == "9":
            from xinas_client.screens.updates import UpdateCheckScreen

            self.app.push_screen(UpdateCheckScreen())

    def action_go_back(self) -> None:
        self.app.pop_screen()
