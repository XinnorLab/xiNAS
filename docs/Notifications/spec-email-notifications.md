# Email and Notification Specification

## Overview

xiNAS provides two independent email notification pipelines that coexist on the same node:

1. **xiNAS SMTP pipeline** — sends scheduled health check reports through a user-configured SMTP server. Managed entirely by the xiNAS Python stack and systemd timers.

2. **xiRAID notification pipeline** — sends real-time RAID event alerts (state changes, reconstruction progress, license issues) through the xiRAID daemon's internal sendmail transport. Managed via gRPC RPCs; the xiNAS TUI exposes configuration but does not control delivery.

Both pipelines have separate recipient lists, separate configuration stores, and separate delivery mechanisms. The TUI Settings screen (menu item 1–4) provides unified management of both from a single screen.

---

## xiNAS SMTP Pipeline

### Configuration

Stored in `/etc/xinas-mcp/config.json` under the `email` key:

```json
{
  "email": {
    "enabled": true,
    "smtp_host": "smtp.example.com",
    "smtp_port": 587,
    "smtp_tls": true,
    "smtp_user": "alerts@example.com",
    "smtp_password": "secret",
    "from_addr": "alerts@example.com",
    "to_addrs": ["admin@example.com", "ops@example.com"]
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Master switch for xiNAS email delivery |
| `smtp_host` | string | — | SMTP server hostname or IP |
| `smtp_port` | int | `587` | SMTP port (1–65535) |
| `smtp_tls` | bool | `true` | Issue STARTTLS after connect |
| `smtp_user` | string | `""` | SMTP AUTH username (optional) |
| `smtp_password` | string | `""` | SMTP AUTH password (optional) |
| `from_addr` | string | — | Envelope sender / From header |
| `to_addrs` | string[] | `[]` | One or more recipient addresses |

### SMTP Connection Sequence

Implementation: `xinas_menu/utils/email_sender.py` → `send_email(subject, body, config, html=False)`

```
1.  SMTP(host, port, timeout=30)
2.  EHLO
3.  if smtp_tls:
        STARTTLS
        EHLO           ← required again after TLS upgrade
4.  if smtp_user and smtp_password:
        LOGIN(user, password)
5.  SENDMAIL(from_addr, to_addrs, mime_message)
6.  QUIT
```

- Uses `smtplib.SMTP` (not `SMTP_SSL`) — TLS is negotiated via STARTTLS on port 587.
- Port 465 (implicit TLS) also works because Python's `SMTP` handles it, but STARTTLS on 587 is the expected path.
- Credentials are always sent **after** TLS is established.
- MIME structure: `MIMEMultipart("alternative")` with a single `MIMEText` part (`text/plain` or `text/html`).
- Returns `(ok: bool, error: str)`. Errors are logged as warnings but never raised.

### Email Validation

The TUI validates addresses with a minimal `"@" in addr` check. No regex validation is applied. The SMTP server performs authoritative validation at send time.

---

## Health Check Email Flow

### Trigger: Systemd Timer

The scheduler creates two systemd units in `/etc/systemd/system/`:

**`xinas-healthcheck.timer`**

```ini
[Unit]
Description=xiNAS Health Check Timer

[Timer]
OnBootSec=5min
OnUnitActiveSec={interval_hours}h
Persistent=true

[Install]
WantedBy=timers.target
```

**`xinas-healthcheck.service`**

```ini
[Unit]
Description=xiNAS Scheduled Health Check
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -m xinas_menu.health.runner
Environment=PYTHONPATH=/opt/xiNAS
Environment=HC_PROFILE={profile}
```

Unit files are written atomically via `tempfile.mkstemp()` + `os.replace()` to prevent partial reads by systemd.

### Scheduler Configuration

Stored in `/etc/xinas-mcp/config.json` under `healthcheck_schedule`:

```json
{
  "healthcheck_schedule": {
    "enabled": true,
    "interval_hours": 24,
    "profile": "standard"
  }
}
```

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `enabled` | bool | — | Timer active state |
| `interval_hours` | int | 1–168 | Repeat interval in hours |
| `profile` | string | `quick` / `standard` / `deep` | Health check depth |

Scheduler API (`xinas_menu/utils/hc_scheduler.py`):

| Function | Description |
|----------|-------------|
| `scheduler_enable(interval, profile)` | Write units, daemon-reload, enable + start timer |
| `scheduler_disable()` | Stop + disable timer |
| `scheduler_status()` | Return `{enabled, active, interval_hours, next_run, last_run}` |

### Health Check Profiles

| Profile | Timeout | Scope |
|---------|---------|-------|
| `quick` | 60s | Essential services, basic RAID state |
| `standard` | 300s | Services, network, memory, filesystem, NFS, RDMA |
| `deep` | 600s | All standard checks plus NVMe health, performance tuning, Kerberos |

Profile files: `healthcheck_profiles/{quick,standard,deep}.yml`

### Runner Execution

Entry point: `python3 -m xinas_menu.health.runner`

```
1.  Read HC_PROFILE env var (default: "standard")
2.  Locate profile YAML:
      /opt/xiNAS/healthcheck_profiles/
      ./../healthcheck_profiles/
      /home/xinnor/xiNAS/healthcheck_profiles/
3.  Run health engine → (text_report, json_path)
4.  Parse JSON report:
      summary.fail → FAIL count
      summary.warn → WARN count
      summary.pass → PASS count
5.  Generate summary string:
      "FAIL (n failed, m warnings, k passed)"   if fail > 0
      "WARN (n warnings, k passed)"             if warn > 0
      "OK (n passed)"                           if all pass
6.  If email enabled and recipients configured:
      subject = "[xiNAS] Health Check {summary} — {hostname} ({timestamp})"
      body    = strip_ansi(text_report)
      send_email(subject, body, config)
7.  Log report to /var/log/xinas/healthcheck/
```

### ANSI Stripping

Health engine output contains ANSI color codes for TUI display. Before emailing, these are removed:

```python
re.sub(r"\x1b\[[0-9;]*m", "", text_report)
```

This strips CSI SGR sequences (`ESC[...m`) while preserving all other content.

---

## xiRAID Notification Pipeline

### Overview

The xiRAID daemon (`xiraid-server.service`) includes an independent mail notification subsystem. It polls RAID and drive state at configurable intervals, and on state changes sends emails to registered recipients via the system's `sendmail` binary.

xiNAS does not control the xiRAID delivery mechanism — it only manages the recipient list and polling intervals through gRPC RPCs.

### gRPC Connection

| Setting | Value |
|---------|-------|
| Address | `localhost:6066` |
| Transport | TLS (one-way, server-cert only) |
| CA cert | `/etc/xraid/crt/ca-cert.pem` (primary) |
| Fallback certs | `/etc/xraid/crt/ca-cert.crt`, `/etc/xiraid/server.crt`, `/etc/xinas-mcp/server.crt` |
| Insecure fallback | Yes, with warning (dev mode only) |
| Timeout | 5s per RPC |

Client implementation: `xinas_menu/api/grpc_client.py` → `XiRAIDClient`

All RPCs return `ResponseMessage { optional string message = 1; }` where `message` is a JSON-encoded string.

### Recipient Management RPCs

Proto definitions: `xiNAS-MCP/proto/xraid/gRPC/protobuf/message_mail.proto`

**`mail_show`** — List all notification recipients

```protobuf
message MailShow {}   // empty request
```

Response JSON: list of `{"address": "email", "level": "info|warning|error"}`

**`mail_add`** — Add or update a recipient

```protobuf
message MailAdd {
    string address = 1;   // email address
    string level = 2;     // "info", "warning", or "error"
}
```

**`mail_remove`** — Remove a recipient

```protobuf
message MailRemove {
    string address = 1;   // email address to remove
}
```

### Notification Levels

| Level | Severity | Receives |
|-------|----------|----------|
| `info` | 0 (lowest) | All notifications |
| `warning` | 1 | Warning + error notifications |
| `error` | 2 (highest) | Error notifications only |

A recipient configured at level X receives all notifications at severity X and above. For example, a recipient at `warning` receives warning and error events but not info events.

### Notification Events

xiRAID triggers notifications on the following state changes:

| Event | Level | Trigger |
|-------|-------|---------|
| RAID degraded | error | Array enters degraded state |
| RAID offline | error | Array goes offline |
| RAID unrecovered | error | Array enters unrecovered state |
| RAID online | info | Array returns to healthy state |
| License expired | error | License validity check fails |
| License disk limit exceeded | error | Active disks exceed license allowance |
| Reconstruction started | info | RAID rebuild begins |
| Reconstruction progress | info | Periodic progress update during rebuild |
| Reconstruction completed | info | RAID rebuild finishes successfully |
| Reconstruction failed | warning | RAID rebuild ends without full recovery |
| Initialization started | info | New array initialization begins |
| Initialization progress | info | Periodic progress update during init |
| Initialization completed | info | Initialization finishes successfully |
| Initialization failed | warning | Initialization ends without completion |

### Polling Intervals

Proto definitions: `xiNAS-MCP/proto/xraid/gRPC/protobuf/message_settings.proto`

**`settings_mail_show`** — Query current polling settings

```protobuf
message SettingsMailShow {}   // empty request
```

Response JSON: `{"polling_interval": int, "progress_polling_interval": int}`

**`settings_mail_modify`** — Update polling intervals

```protobuf
message SettingsMailModify {
    optional uint32 polling_interval = 1;            // seconds
    optional uint32 progress_polling_interval = 2;   // minutes
}
```

| Setting | Unit | Default | Description |
|---------|------|---------|-------------|
| `polling_interval` | seconds | 10 | How often xiRAID checks RAID/drive state |
| `progress_polling_interval` | minutes | 10 | How often progress updates are sent during init/reconstruction |

Notifications fire on **state change**, not on every poll cycle. The polling interval controls detection latency, not email frequency.

### Test Email

There is no gRPC RPC for sending a test notification. The TUI falls back to the CLI command:

```bash
xicli mail send
```

This triggers a test message to all configured recipients through xiRAID's sendmail transport.

---

## TUI Settings Screen

Location: `xinas_menu/screens/settings.py`

### Menu Structure

```
Settings
├─ 1: Email Configuration       ← xiNAS SMTP settings
├─ 2: Health Check Scheduler     ← Systemd timer management
├─ 3: Send Test Email            ← xiNAS SMTP test
├─ 4: xiRAID Notifications       ← gRPC recipient/interval management
└─ 0/Esc: Back
```

### Overview Display

On entry, the Settings screen shows a summary of all four subsystems:

```
Settings Overview

  Email:      enabled  (smtp.example.com:587)
  Recipients: admin@example.com, ops@example.com

  HC Scheduler: enabled  (every 24h)
  Profile:      standard
  Next run:     2026-03-24 14:30 UTC
  Last run:     2026-03-23 14:30 UTC

  xiRAID Mail: enabled  (3 recipients)
  Polling:      10s / 10min
```

States are color-coded: green for enabled/active, dim for unconfigured, red for errors.

### Email Configuration (Item 1)

Interactive dialog sequence:

1. Show current settings (password masked as `●●●●●●●●`)
2. Choose: "Configure Email" or "Disable Email"
3. If configuring: SMTP host → port → STARTTLS → username → password → from → to
4. All fields validated before save
5. Config persisted to `/etc/xinas-mcp/config.json`
6. Audit: `settings.email`

### Health Check Scheduler (Item 2)

1. Show current status (enabled/disabled, interval, profile, next/last run)
2. Choose: "Enable/Update Scheduler" or "Disable Scheduler"
3. If enabling: interval (1–168 hours) → profile (quick/standard/deep)
4. Calls `scheduler_enable()` which writes systemd units and activates timer
5. Config persisted to `/etc/xinas-mcp/config.json`
6. Audit: `settings.hc_scheduler`

### Send Test Email (Item 3)

1. Checks `email.enabled` — warns if not configured
2. Sends: subject `[xiNAS] Test Email — {hostname}`, body confirmation text
3. Shows success (green) or failure (red with SMTP error)
4. Audit: `settings.test_email`

### xiRAID Notifications (Item 4)

1. Checks gRPC availability via `grpc_available()` (probes `license_show`)
2. Fetches recipients (`mail_show`) and polling settings (`settings_mail_show`)
3. Displays recipient table and interval values
4. Action menu:
   - **Add Recipient** — email input (validates `@`) + level select (`error`/`warning`/`info`)
   - **Remove Recipient** — select from list + confirm dialog
   - **Modify Polling Intervals** — polling_interval (seconds, >0) + progress_polling_interval (minutes, >0)
   - **Send Test Notification** — calls `xicli mail send` via subprocess
5. Audit: `settings.xiraid_mail`

---

## Audit Events

All settings changes are recorded via `self.app.audit.log(action, detail, status)`:

| Action | Detail | Status |
|--------|--------|--------|
| `settings.email` | `host={smtp_host}` | OK |
| `settings.hc_scheduler` | `enabled every {n}h profile={p}` / `disabled` | OK / FAIL |
| `settings.test_email` | `sent` | OK / FAIL |
| `settings.xiraid_mail` | `add {email} level={level}` | OK / FAIL |
| `settings.xiraid_mail` | `remove {email}` | OK / FAIL |
| `settings.xiraid_mail` | `modify pi={s} ppi={m}` | OK / FAIL |
| `settings.xiraid_mail` | `test_send` | OK / FAIL |

---

## File Matrix

| File | Purpose |
|------|---------|
| `xinas_menu/utils/email_sender.py` | SMTP send function |
| `xinas_menu/utils/hc_scheduler.py` | Systemd timer create/enable/disable |
| `xinas_menu/health/runner.py` | Scheduled health check entry point |
| `xinas_menu/health/engine.py` | Health check execution engine |
| `xinas_menu/utils/xicli_mail.py` | Async gRPC wrappers for xiRAID mail RPCs |
| `xinas_menu/api/grpc_client.py` | XiRAIDClient with mail_* methods |
| `xinas_menu/screens/settings.py` | TUI Settings screen |
| `xinas_menu/utils/config.py` | Config read/write for `/etc/xinas-mcp/config.json` |
| `healthcheck_profiles/*.yml` | Health check profile definitions |

---

## Troubleshooting

### xiNAS health check emails not arriving

**Symptom:** Scheduler is enabled, health checks run, but no emails received.

1. Verify email is enabled:
   ```bash
   python3 -c "import json; c=json.load(open('/etc/xinas-mcp/config.json')); print(c.get('email',{}))"
   ```
2. Check `enabled: true` and `to_addrs` is non-empty.
3. Send a test email from TUI Settings → "Send Test Email".
4. Check health check logs:
   ```bash
   ls -lt /var/log/xinas/healthcheck/
   ```
5. Verify timer is active:
   ```bash
   systemctl status xinas-healthcheck.timer
   ```

### xiRAID notifications not arriving

**Symptom:** Recipients configured via TUI but no RAID alert emails.

1. Verify recipients via gRPC:
   ```bash
   xicli mail show
   ```
2. Verify sendmail is installed and working:
   ```bash
   echo "test" | sendmail -v your@email.com
   ```
3. Check xiRAID service is running:
   ```bash
   systemctl status xiraid-server
   ```
4. Send test notification:
   ```bash
   xicli mail send
   ```
5. Check xiRAID logs for mail errors:
   ```bash
   journalctl -u xiraid-server --since "1 hour ago" | grep -i mail
   ```

### gRPC connection failures in TUI

**Symptom:** "xiRAID daemon is not reachable" in Settings screen.

1. Verify daemon is listening:
   ```bash
   ss -tlnp | grep 6066
   ```
2. Verify TLS certificate exists:
   ```bash
   ls -la /etc/xraid/crt/ca-cert.pem
   ```
3. Test gRPC directly:
   ```bash
   xicli license show
   ```
4. Check Python gRPC stubs are installed:
   ```bash
   python3 -c "from xinas_menu.api.proto import service_xraid_pb2_grpc; print('OK')"
   ```
