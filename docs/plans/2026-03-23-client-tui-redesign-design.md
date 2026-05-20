# xiNAS Client TUI Redesign — Design Document

**Date:** 2026-03-23
**Status:** Draft

## Problem

The xiNAS client menu (`client_repo/client_setup.sh`) is a 3,600-line Bash script with a custom `menu_lib.sh` widget library. The server menu (`xinas_menu/`) is a modern Python Textual TUI with a dark blue/teal theme, split-panel layout, and reusable dialog widgets. The visual and UX gap between the two products creates a fragmented user experience.

## Goal

Rewrite the client menu as a standalone Python Textual TUI app (`client_repo/xinas_client/`) that visually matches the server menu while preserving full feature parity with the existing Bash implementation.

## Decisions

- **Standalone package** in `client_repo/` — no dependency on `xinas_menu`
- **Copy widgets + styles** from server into client package (not a shared lib)
- **Full feature parity** with current `client_setup.sh`

## Package Structure

```
client_repo/
  xinas_client/
    __init__.py
    __main__.py                   # CLI entry point (argparse)
    app.py                        # XiNASClientApp(App)
    version.py
    styles.tcss                   # Copied from server (identical theme)

    widgets/                      # Copied from xinas_menu/widgets/
      __init__.py
      header.py                   # Modified: client ASCII art + branding
      menu_list.py                # Verbatim (fix import paths)
      text_view.py                # Verbatim
      alert_bar.py                # Verbatim
      confirm_dialog.py           # Verbatim
      input_dialog.py             # Verbatim
      select_dialog.py            # Verbatim
      checklist_dialog.py         # Verbatim
      textarea_dialog.py          # Verbatim
      op_status.py                # Verbatim
      progress_bar.py             # Verbatim

    screens/
      __init__.py
      welcome.py                  # Splash screen (probes NFS tools + RDMA)
      main_menu.py                # 3 items + live status pane
      system_status.py            # Full status display
      mount_wizard.py             # 7-step NFS mount wizard
      manage_mounts.py            # List/unmount/remount/fstab
      network.py                  # Network settings submenu
      install_nfs.py              # Install NFS tools
      install_doca.py             # DOCA OFED install
      gds.py                      # GPUDirect Storage
      csi_nfs.py                  # Kubernetes CSI NFS Driver
      test_connection.py          # Connection diagnostics
      health_check.py             # Client health check
      updates.py                  # Update checker
      playbook_screen.py          # Ansible runner (adapted from server)

    utils/
      __init__.py
      subprocess_runner.py        # async subprocess wrappers
      system_info.py              # hostname, kernel, CPU, memory
      nfs_utils.py                # mount/unmount/fstab parsing
      rdma_utils.py               # RDMA/IB detection
      network_utils.py            # interface enumeration
      update_check.py             # git-based update checker
```

## Screen Hierarchy

```
WelcomeScreen (auto-advance 2s)
  ↓
ClientMainMenuScreen (status pane on right)
  ├── [1] System Status → SystemStatusScreen
  ├── [2] Connect to NAS → MountWizardScreen (7-step wizard)
  ├── [3] Advanced Settings → AdvancedSettingsScreen
  │     ├── [1] Manage Mounts
  │     ├── [2] Network Settings (submenu)
  │     ├── [3] Install NFS Tools
  │     ├── [4] Install DOCA OFED
  │     ├── [5] GPUDirect Storage (submenu)
  │     ├── [6] Kubernetes CSI NFS (submenu)
  │     ├── [7] Test Connection
  │     ├── [8] Client Health Check
  │     └── [9] Check for Updates
  └── [0] Exit
```

## Mount Wizard (7-Step)

Single screen with internal state machine (not 7 separate screens). Each step uses existing dialog widgets via `push_screen_wait()`. Back-navigation decrements the step counter; Escape from step 1 pops the screen.

Steps: Protocol → Num IPs → IP Addresses → Share Path → Mount Point → Auth Mode → Confirm + fstab

## CLI Mode

`__main__.py` dispatches CLI flags (`--status`, `--mount`, `--network-status`, etc.) before launching TUI. CLI functions use plain `subprocess.run()` — no Textual import needed.

## Dependencies

- `textual>=0.47.0` (includes `rich`)
- `pyyaml>=6.0`
- No grpcio, no ansible (ansible installed on-demand for DOCA)
