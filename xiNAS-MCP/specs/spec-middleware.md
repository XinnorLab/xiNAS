# Middleware Layer Specification

---

## `src/middleware/rbac.ts`

### Role Hierarchy
```
viewer (0) < operator (1) < admin (2)
```

### Permission Matrix

| Role | Tools |
|---|---|
| `viewer` | `system.*`, `health.*`, `network.list`, `disk.list`, `disk.get_smart`, `raid.list`, `share.list`, `auth.get_supported_modes`, `job.get`, `job.list` |
| `operator` | viewer + `disk.run_selftest`, `disk.set_led`, `share.create/update_policy/set_quota/delete/get_active_sessions`, `raid.lifecycle_control`, `job.cancel` |
| `admin` | operator + `raid.create/modify_performance/unload/restore/delete`, `disk.secure_erase`, `network.configure`, `auth.validate_kerberos` |

Any tool not in the table defaults to `admin`.

### `checkPermission(toolName, ctx)`
Throws `McpToolError(PERMISSION_DENIED)` with message: `"Tool 'X' requires role 'Y'. Principal 'P' has role 'Q'."`

### Token Resolution
- API token → role via `config.tokens` map
- No token on stdio → `role = 'admin'` (local access)
- Unknown token → `role = 'viewer'` (least privilege default)

---

## `src/middleware/audit.ts`

### Audit Entry Structure
```typescript
{
  request_id: string;       // UUID v4
  principal: string;        // token or 'local'
  timestamp: string;        // ISO 8601
  controller_id: string;
  tool_name: string;
  parameters_hash: string;  // SHA-256(JSON.stringify(params))
  result_hash: string;      // SHA-256(JSON.stringify(result)) or SHA-256(error_code)
  job_id?: string;
  duration_ms: number;
  error?: string;
  prev_hash: string;        // SHA-256 of previous log line (hash chain)
}
```

### Hash Chain
Each entry's `prev_hash` is SHA-256 of the raw JSON string of the preceding entry.
First entry uses `prev_hash = "0"×64`.

Enables tamper detection: any modification breaks the chain.

### Sinks
1. **File**: `fs.appendFileSync(config.audit_log_path)` — atomic on Linux (O_APPEND)
2. **Syslog**: Unix datagram to `/dev/log` — PRI=14 (user.info), best-effort

### Verification
To verify chain integrity:
```bash
python3 -c "
import json, hashlib
lines = open('/var/log/xinas/mcp-audit.jsonl').readlines()
prev = '0'*64
for i, line in enumerate(lines):
    entry = json.loads(line)
    assert entry['prev_hash'] == prev, f'Chain broken at line {i}'
    prev = hashlib.sha256(line.encode()).hexdigest()
print('Chain OK')
"
```

---

## `src/middleware/locking.ts`

### `ArrayLockManager`
In-memory `Map<arrayId, LockState>` with promise-chain pattern.

### `withLock(arrayId, toolName, fn)`
1. If `arrayId` already locked → throw `McpToolError(CONFLICT, "Array 'X' is currently locked by 'Y'")`
2. Create a new `Promise` with its `resolve` reference stored
3. Set lock entry
4. `await fn()`
5. `resolve()` and `delete` lock entry on exit (even on error)

### `isLocked(arrayId)` / `lockedBy(arrayId)`
Read-only queries.

### Singleton
`export const arrayLocks = new ArrayLockManager()` — shared across all tool calls.

---

## `src/middleware/idempotency.ts`

### `IdempotencyStore`
In-memory `Map<key, { result, expiresAt }>`. TTL = 5 minutes.

### `check(key)` → `{ hit: boolean, result? }`
Returns cached result if key exists and not expired. Expired entries are lazily deleted.

### `store_(key, result)`
Stores result with expiry timestamp.

### Cleanup
`setInterval(purgeExpired, 10min).unref()` — runs without blocking process exit.

### Usage Pattern (in toolRegistry)
```
if idempotency_key provided:
  cached = idempotencyStore.check(key)
  if cached.hit → return cached.result
execute handler
idempotencyStore.store_(key, result)
```

---

## `src/middleware/planApply.ts`

### `applyWithPlan(mode, ctx)`
```
mode='plan':
  plan = await ctx.preflight()
  return plan   // caller sees PlanResult

mode='apply':
  plan = await ctx.preflight()
  if !plan.preflight_passed:
    throw McpToolError(PRECONDITION_FAILED, blocking_resources)
  result = await ctx.execute()
  return result  // caller sees actual result
```

### Error Behavior
- Preflight failure in apply mode: `PRECONDITION_FAILED` with `{ plan }` in details
- Execute failure: propagated as-is (no rollback)

### `PlanContext<T>`
```typescript
{
  preflight: () => Promise<PlanResult>;
  execute: () => Promise<T>;
}
```
