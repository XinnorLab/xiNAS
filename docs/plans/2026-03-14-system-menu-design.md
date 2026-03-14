# System Menu Redesign & Settings

**Date:** 2026-03-14
**Version target:** 2.9.0

## Summary

Reorganize the flat 11-item main menu into 4 logical groups. Add a System submenu with Status dashboard, License management, and Settings (email + health-check scheduler). Scheduled health-check results are emailed via direct SMTP.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scheduler | Systemd timer | Fits existing `service_ctl.py` patterns; survives reboots; journalctl logging |
| Email delivery | Direct SMTP (Python `smtplib`) | Zero external deps; config stays in xiNAS config |
| Config storage | `/etc/xinas-mcp/config.json` | Already exists; read/write patterns established in MCP screen |
| Status data | Mirror `xinas-status` MOTD | Same sections: System, Resources, Network, RAID, NFS Shares, Clients |

## Menu Structure

### Main Menu (4 groups + Exit)

```
1  System       >
2  Storage      >
3  Network      >   (pushes NetworkScreen directly — single item)
4  Management   >
───────────────
0  Exit
```

### System Submenu

```
1  Status           → SystemStatusScreen (dashboard)
2  License          → LicenseScreen (show/set)
3  Settings         → SettingsScreen (email, HC scheduler, test email)
4  xiRAID Exporter  → ExporterScreen (existing)
5  Quick Actions    → QuickActionsScreen (existing, minus license/drives)
───────────────
0  Back
```

### Storage Submenu

```
1  RAID Management    → RAIDScreen (existing)
2  NFS Access Rights  → NFSScreen (existing)
3  Physical Drives    → drives view (extracted from QuickActionsScreen)
───────────────
0  Back
```

### Management Submenu

```
1  User Management  → UsersScreen (existing)
2  Health Check     → HealthScreen (existing)
3  MCP Server       → MCPScreen (existing)
4  Check Updates    → async update check (existing logic)
───────────────
0  Back
```

## System Status Dashboard

Mirrors `xinas-status` Bash MOTD (deployed by `collection/roles/motd/`). Same sections, rendered with Rich markup in a `ScrollableTextView`. Auto-refreshes every 10 seconds.

**Sections:**
1. **SYSTEM** — hostname, kernel, uptime, NFS thread count
2. **RESOURCES** — CPU %, memory % with progress bars, load averages with sparkline
3. **NETWORK** — per-interface: state indicator, name, type badge (ETH/RDMA/IB), IP, speed
4. **RAID ARRAYS** — per-array: status icon, name, level, size, state, drive count
5. **NFS SHARES** — per-export: path, usage bar with %, human-readable used/total
6. **ACTIVE CLIENTS** — client IPs from `/proc/fs/nfsd/clients/*/info` or `ss` fallback

**Data sources:**
- System: `hostnamectl`, `/proc/fs/nfsd/threads`
- Resources: `/proc/stat`, `free -b`, `/proc/loadavg`
- Network: `/sys/class/net/` sysfs reads (state, speed, driver, type)
- RAID: `self.app.grpc.raid_show()` (existing gRPC)
- NFS: `/etc/exports` + `df -h` per export
- Clients: `/proc/fs/nfsd/clients/*/info` → fallback `ss`

## Settings Screen

```
1  Email Configuration
2  Health Check Scheduler
3  Send Test Email
───────────────
0  Back
```

### Config Schema (added to `/etc/xinas-mcp/config.json`)

```json
{
  "email": {
    "enabled": true,
    "smtp_host": "smtp.company.com",
    "smtp_port": 587,
    "smtp_tls": true,
    "smtp_user": "alerts@company.com",
    "smtp_password": "encrypted-or-plain",
    "from_addr": "alerts@company.com",
    "to_addrs": ["admin@company.com"]
  },
  "healthcheck_schedule": {
    "enabled": true,
    "interval_hours": 24,
    "profile": "default"
  }
}
```

### Email Configuration Flow

1. Show current settings (password masked)
2. Wizard: SMTP host → port → TLS (yes/no) → user → password → from → to (comma-separated)
3. Atomic write to config.json

### Health Check Scheduler Flow

1. Show current state: enabled/disabled, interval, next run
2. Toggle enable/disable → writes config + enables/disables systemd timer
3. Set interval → InputDialog for hours (1–168) → updates timer
4. Systemd units:
   - `xinas-healthcheck.service` — runs `python3 -m xinas_menu.health.runner`
   - `xinas-healthcheck.timer` — `OnUnitActiveSec=<interval>h`

### Send Test Email

Uses email config → sends test message via `smtplib` → shows success/failure.

## New Files

| File | Purpose |
|------|---------|
| `xinas_menu/screens/system.py` | SystemScreen submenu |
| `xinas_menu/screens/storage.py` | StorageScreen submenu |
| `xinas_menu/screens/management.py` | ManagementScreen submenu |
| `xinas_menu/screens/system_status.py` | Status dashboard (mirrors xinas-status) |
| `xinas_menu/screens/license.py` | License show/set screen |
| `xinas_menu/screens/settings.py` | Settings screen (email, scheduler, test) |
| `xinas_menu/utils/email_sender.py` | `send_email(subject, body, config)` via smtplib |
| `xinas_menu/utils/hc_scheduler.py` | Systemd timer helpers (enable/disable/status/run+email) |
| `xinas_menu/health/runner.py` | CLI entry for scheduled HC — runs engine, emails report |

## Modified Files

| File | Change |
|------|--------|
| `xinas_menu/screens/main_menu.py` | 4 groups + Exit replacing 11 flat items |
| `xinas_menu/screens/quick_actions.py` | Remove license + drives (moved to System/Storage) |
| `xinas_menu/version.py` | Bump to 2.9.0 |
