# Mail Notification Tools Specification

Tools for managing xiRAID's email notification system: recipients, severity levels, polling intervals, and test delivery.

---

## Tool Summary

| Tool | Min Role | Plan/Apply | gRPC RPC |
|------|----------|------------|----------|
| `mail.list_recipients` | viewer | — | `mail_show` |
| `mail.add_recipient` | admin | plan/apply | `mail_add` |
| `mail.remove_recipient` | admin | plan/apply | `mail_remove` |
| `mail.get_settings` | viewer | — | `settings_mail_show` |
| `mail.update_settings` | admin | plan/apply | `settings_mail_modify` |
| `mail.send_test` | operator | — | CLI fallback: `xicli mail send` |

---

## Architecture

```
MCP Client → mail.* tools → gRPC → xiRAID daemon (localhost:6066)
                                      ↓
                              Internal sendmail → recipients
```

xiRAID manages its own email delivery via the system `sendmail` binary. The MCP tools only configure **who** receives notifications and **when** polling occurs. They do not control the SMTP transport — that is internal to xiRAID.

---

## Tools

### `mail.list_recipients`

List all configured notification recipients with their severity levels.

**Input:**
```json
{ "controller_id": "optional-uuid" }
```

**Output:** Array of `{ address, level }` objects.

**gRPC:** `mail_show(MailShow{})` → `ResponseMessage.message` (JSON)

---

### `mail.add_recipient`

Add or update a notification recipient at a given severity level.

**Input:**
```json
{
  "controller_id": "optional-uuid",
  "address": "admin@example.com",
  "level": "warning",
  "mode": "plan"
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | string (email) | yes | Recipient email address |
| `level` | enum | yes | `"info"`, `"warning"`, or `"error"` |
| `mode` | enum | no | `"plan"` (default) or `"apply"` |

**Notification level semantics:** A recipient at level X receives all events at severity X and above:
- `info` → receives info + warning + error
- `warning` → receives warning + error
- `error` → receives error only

**Preflight:** Validates email format.

**gRPC:** `mail_add(MailAdd{ address, level })`

---

### `mail.remove_recipient`

Remove a recipient from the notification list.

**Input:**
```json
{
  "controller_id": "optional-uuid",
  "address": "admin@example.com",
  "mode": "plan"
}
```

**Preflight:** Fetches current recipients; fails if address not found.

**gRPC:** `mail_remove(MailRemove{ address })`

---

### `mail.get_settings`

Get current mail polling settings.

**Input:**
```json
{ "controller_id": "optional-uuid" }
```

**Output:**
```json
{
  "polling_interval": 10,
  "progress_polling_interval": 10
}
```

| Field | Unit | Description |
|-------|------|-------------|
| `polling_interval` | seconds | How often xiRAID checks RAID/drive state for changes |
| `progress_polling_interval` | minutes | How often progress updates are sent during init/reconstruction |

**gRPC:** `settings_mail_show(SettingsMailShow{})`

---

### `mail.update_settings`

Update mail polling intervals.

**Input:**
```json
{
  "controller_id": "optional-uuid",
  "polling_interval": 30,
  "progress_polling_interval": 5,
  "mode": "plan"
}
```

Both interval fields are optional — only provided fields are updated.

**Preflight:** Validates intervals are positive integers.

**gRPC:** `settings_mail_modify(SettingsMailModify{ polling_interval?, progress_polling_interval? })`

---

### `mail.send_test`

Send a test notification to all configured recipients.

**Input:**
```json
{ "controller_id": "optional-uuid" }
```

**Implementation note:** No gRPC RPC exists for test send. This tool falls back to `xicli mail send` via subprocess. Requires `xicli` to be on PATH.

---

## Proto References

- `xiNAS-MCP/proto/xraid/gRPC/protobuf/message_mail.proto` — `MailAdd`, `MailRemove`, `MailShow`
- `xiNAS-MCP/proto/xraid/gRPC/protobuf/message_settings.proto` — `SettingsMailModify`, `SettingsMailShow`
- `xiNAS-MCP/proto/xraid/gRPC/protobuf/service_xraid.proto` — RPC definitions

## Source Files

| File | Purpose |
|------|---------|
| `src/grpc/mail.ts` | gRPC wrappers for mail RPCs |
| `src/grpc/settings.ts` | Existing settings RPCs (settings_mail_show already present, add settings_mail_modify) |
| `src/tools/mail.ts` | MCP tool schemas and handlers |
| `src/registry/toolRegistry.ts` | Tool registration |
| `src/middleware/rbac.ts` | Permission assignments |
