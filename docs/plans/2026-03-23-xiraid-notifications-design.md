# xiRAID Notification Settings — Design Doc

## Goal

Expose xiRAID's email notification system in the xiNAS TUI Settings screen so
users can manage RAID alert recipients, severity levels, and polling intervals
without using the `xicli` CLI directly.

## Background

xiRAID has a built-in notification pipeline that sends emails for RAID state
changes (degraded, offline, unrecovered, online), reconstruction/initialization
progress, and license events. It uses system `sendmail` and is configured via
`/etc/xraid/raid-mail.conf`. Management is through `xicli mail` and
`xicli settings mail` commands.

xiNAS already has a separate SMTP-based email pipeline for health check reports.
The two systems remain independent — this feature adds TUI access to xiRAID's
existing notification commands without changing its transport.

## Decision Record

| Decision | Rationale |
|----------|-----------|
| Use gRPC directly | Consistent with XiRAIDClient pattern (RAID, pools, license); avoids CLI parsing |
| CLI fallback for test send | No `mail_send` gRPC RPC exists; `xicli mail send` is the only option |
| Keep sendmail transport | xiRAID controls its own delivery; avoids coupling |
| Extend Settings screen | Natural location next to existing email/scheduler settings |

## Architecture

```
Settings Screen (settings.py)
  ├── Email Configuration        ← xiNAS SMTP (health checks)
  ├── Health Check Scheduler
  ├── Send Test Email
  └── xiRAID Notifications (NEW)
        └── xicli_mail.py (async helpers)
              └── XiRAIDClient (grpc_client.py)
                    └── gRPC → xiRAID daemon (localhost:6066)
```

## gRPC RPCs Used

| Function | gRPC RPC | Purpose |
|----------|----------|---------|
| `mail_show()` | `mail_show(MailShow)` | List recipients + levels |
| `mail_add()` | `mail_add(MailAdd)` | Add recipient |
| `mail_remove()` | `mail_remove(MailRemove)` | Remove recipient |
| `mail_send_test()` | *CLI fallback: `xicli mail send`* | Send test notification (no gRPC RPC) |
| `settings_mail_show()` | `settings_mail_show(SettingsMailShow)` | Query polling intervals |
| `settings_mail_modify()` | `settings_mail_modify(SettingsMailModify)` | Set polling intervals |

## Notification Levels

- **error** — RAID offline/degraded/unrecovered, license failures
- **warning** — Reconstruction/initialization incomplete
- **info** — RAID online, reconstruction/initialization started/completed/progress

A recipient configured for level X receives messages at level X and above.

## UI Flow

1. Settings overview shows xiRAID mail status (recipient count + polling intervals)
2. Menu item "xiRAID Notifications" displays current recipients table + intervals
3. Action menu: Add Recipient / Remove Recipient / Modify Intervals / Send Test
4. Each action uses standard TUI dialogs (InputDialog, SelectDialog, ConfirmDialog)
5. All mutations are audit-logged under `settings.xiraid_mail`

## Response Parsing

All xiRAID gRPC RPCs return `ResponseMessage { string message }` where message
is JSON-encoded. The `XiRAIDClient._parse_response()` handles JSON decoding.
The `xicli_mail.py` extractors normalize the JSON into simple dicts/lists.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| gRPC stubs not installed | Overview: "not available"; all calls return (False, None, "stubs not available") |
| xiRAID daemon unreachable | `grpc_available()` returns False; menu item shows warning |
| gRPC call fails | Error message from exception displayed in content pane |
| Invalid email input | TUI validates `@` before calling gRPC |
| `mail_send_test` without xicli | CLI fallback fails gracefully via `run_cmd` |

## Files

- **Modified:** `xinas_menu/api/grpc_client.py` — added `message_mail_pb2` to stubs, 5 new mail methods
- **Rewritten:** `xinas_menu/utils/xicli_mail.py` — async gRPC via XiRAIDClient (~150 lines)
- **Modified:** `xinas_menu/screens/settings.py` — menu item + 5 new methods (~170 lines added)
