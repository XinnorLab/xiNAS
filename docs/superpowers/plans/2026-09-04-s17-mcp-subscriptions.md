# S17 MCP Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a modern MCP (`2026-07-28`) client durable, cursor-addressable operational event feeds for RAID, storage, NFS and the node, delivered as standard MCP Resources plus `subscriptions/listen` wake-ups over Streamable HTTP and stdio, derived only from committed observed-state transitions.

**Architecture:** A SQLite journal (`operational_events`, migration 007) is written inside the existing observation-ingest transaction by a `TransitionEngine` whose per-kind producers compare the stored row with the incoming one; the heartbeat tracker and the inventory boot id write to the same journal. After a commit, a `SubscriptionRegistry` coalesces per-feed wake-ups onto live `subscriptions/listen` SSE responses (one per HTTP request; demultiplexed onto stdout by the stdio adapter). Six feed resources are read through `resources/read` with opaque cursors; `GET /events` projects the same rows.

**Tech Stack:** TypeScript (Node ≥20, ESM, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Express 5, better-sqlite3, `node:crypto`, vitest + supertest, biome, `@modelcontextprotocol/sdk` 1.x (legacy path, unchanged), `@modelcontextprotocol/client` 2.0.0 (devDependency, tests only), `ajv` (schema validation in tests).

**Spec:** [docs/control-path/s17-mcp-subscriptions-spec.md](../../control-path/s17-mcp-subscriptions-spec.md). Validation record and decisions: Appendix D/E of [docs/control-path/s17-mcp-subscriptions-requirements.md](../../control-path/s17-mcp-subscriptions-requirements.md). Amended contracts already on this branch: ADR-0010, S14 §1/§4/§5.2/§7/§8, S16-requirements §14, S3, S4, S5, S6, S7, agent spec, `docs/Notifications/spec-email-notifications.md`, `api-v1.yaml`, `CLAUDE.md`, `docs/TODO.md`.

## Global Constraints

- Work in the worktree `.claude/worktrees/s17-mcp-subscriptions` on branch `feat/s17-mcp-subscriptions` (based on `d8bfbb1`, the S15 branch head). Never `cd` into the shared main checkout or the sibling `s15-mcp-mrtr` / `s16-mcp-tasks` worktrees. PR target is `release/3.14` (after S15), merged with `--merge`.
- **Spec-first is satisfied by Task 0** (the contract set is the first commit). Do not reorder it behind code.
- All repository artifacts are in **English**.
- Every commit touching `xiNAS-MCP/src/` carries the trailer `Requires-Rebuild: xinas_node_build`. Docs-only commits carry no trailer.
- Conventional Commits: `type(scope): subject`. End every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit per task; do **not** push.
- `docs/control-path/api-v1.yaml` changes are additive only (done in Task 0). `ApplyRequest` and task payloads are untouched.
- Verification from `xiNAS-MCP/` before declaring any code task done: `npm run typecheck && npm run lint && npm run format:check` and `npm test`. Tasks touching `src/__tests__/e2e/**` or the stdio adapter additionally run `npm run build && npm run test:e2e`. Docs: `npx --yes markdownlint-cli2 'docs/**/*.md'`; `api-v1.yaml`: `npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml` (0 errors; 46 pre-existing warnings).
- Timestamps in the store are epoch-ms numbers; the wire renders ISO strings. Never mix them.
- Fixed values copied from the spec: feeds `raid`, `raid/progress`, `storage`, `nfs`, `nfs/sessions`, `system`; URI prefix `xinas://events/`; MIME `application/vnd.xinas.events+json`; cursor version `1`, tag = first 8 bytes of SHA-256; read limit default **100**, max **500**; retention 7 d (1–30), 100 000 rows (10 000–1 000 000), cleanup 3600 s (60–86 400), batch 500 rows / 50 batches per run; `max_uris_per_listen` 6; `max_listeners_per_principal` 4 (1–64); `max_listeners_per_process` 32 (1–1024); `max_pending_per_stream` 256 (16–4096); `keepalive_ms` 15 000 (1000–60 000); `coalesce_ms` 250 (0–5000); progress bucket 10 / min 30 s / max silence 600 s; capacity 80/75/90/85; lock threshold disabled (`enter: 0`); envelope ≤ 65 536 bytes; `summary` ≤ 256 chars; JSON-RPC `-32602` for every invalid URI/cursor/params, `-32000` for listener limits, `-32601` when `mcp.subscriptions.enabled` is false; HTTP `406` when `Accept` lacks `text/event-stream`.
- Event type names, severities, reason codes and `operation.kind` values are the spec's §6.4/§6.5 lists and nothing else.
- Everything inside `kv.transaction(...)` / `db.transaction(...)` is synchronous. No `await` inside the observation transaction.
- A source failure never produces a removal, outage or recovery event (spec §8.0). Nothing in the engine may emit on `previous === null` except the four baseline exceptions.
- No bearer, cursor string, client address (outside `nfs/sessions`), event payload or raw vendor string in audit rows, logs or `summary`.
- Metrics labels are exactly `{transport}`, `{transport,outcome}`, `{transport,reason}`, `{feed,outcome}`, `{feed}`, `{feed,severity}`, `{source}`.

---

## File structure

New files (under `xiNAS-MCP/src/` unless noted):

| File | Responsibility |
|---|---|
| `state/migrations/007-operational-events.sql` | `operational_events`, `operational_event_meta`, indexes |
| `api/events/types.ts` | `Feed`, `FEEDS`, `FEED_URI_PREFIX`, `EventEnvelope`, `EventInput`, `Severity`, `ReasonCode`, `OperationKind`, subject/source unions |
| `api/events/cursor.ts` | `encodeCursor`, `decodeCursor`, `CursorError` |
| `api/events/journal.ts` | `EventJournal` — insert (dedupe), `listAfter`, `listLatest`, `bounds`, `retentionSweep`, `metaGet/metaSet` |
| `api/events/envelope.ts` | `buildEnvelope` (ids, bounds, canonical payload), `summaryFor` templates, `validateDetails` |
| `api/events/schema.ts` | per-type `details` JSON schemas (Ajv, `additionalProperties: false`), `PRODUCER_FAMILIES` |
| `api/events/meta.ts` | typed accessors over `operational_event_meta` keys |
| `api/events/engine.ts` | `TransitionEngine` — batch lifecycle, dispatch to producers, task correlation helper |
| `api/events/producers/raid.ts` | `raid` + `raid/progress` producers |
| `api/events/producers/storage.ts` | `storage` producers |
| `api/events/producers/nfs.ts` | `nfs` producers (services, exports, backing, RDMA) |
| `api/events/producers/sessions.ts` | `nfs/sessions` producers (debounce, lock threshold) |
| `api/events/producers/system.ts` | services, links, reboot/restore-pending, collector state, agent state |
| `api/events/subscriptions.ts` | `SubscriptionRegistry` — listeners, limits, coalescing, overflow, graceful close |
| `api/events/audit.ts` | `queueSubscriptionEvent` — `mcp.subscription.*`, `mcp.event_cursor.gap_observed` |
| `api/events/metrics.ts` | `SubscriptionMetrics`, `noopSubscriptionMetrics`, `InMemorySubscriptionMetrics` |
| `api/events/retention.ts` | `RetentionSweeper` timer |
| `api/events/feeds.ts` | the feed `ResourceProvider`: list/templates/read envelope, producers metadata |
| `api/mcp/resources.ts` | `ResourceProvider` seam, `listResources`, `listTemplates`, `readResource`, `parseFeedUri` |
| `api/mcp/listen.ts` | `subscriptions/listen` validation + SSE writer + stream lifecycle |
| `api/routes/events.ts` | rewritten: journal projection |
| `__tests__/contracts/mcp/2026-07-28/schema.json` | vendored MCP schema (added in Task 0) |
| `__tests__/api/events/*.test.ts` | unit tests per module |
| `__tests__/api/mcp-resources.test.ts`, `mcp-listen.test.ts`, `mcp-stdio-listen.test.ts`, `mcp-client-v2.test.ts` | api / adapter / interop tests |
| `__tests__/contracts/mcp-wire.test.ts` | wire messages validated against the vendored schema |
| `__tests__/contracts/fixtures/Event.json` | OpenAPI fixture |
| `__tests__/e2e/subscriptions.test.ts` | end-to-end scenarios |

Modified files: `lib/parse/raid.ts`, `api/internal/observed.ts`, `api/heartbeat.ts`, `api/config.ts`, `api/context.ts`, `api/server.ts`, `api/app.ts`, `api/mcp/modern.ts`, `api/mcp/discover.ts`, `api/mcp/transport.ts`, `mcp-stdio.ts`, `agent/probe/inventory.ts`, `agent/probe/systemd.ts`, `agent/probe/fixture.ts`, `agent/collectors/inventory.ts`, `__tests__/contracts/fixtures/XiraidArray.json`, `__tests__/api/mcp-discover.test.ts`, `__tests__/api/heartbeat.test.ts`, `__tests__/api/_helpers.ts`, `package.json` (done), `docs/control-path/hardware-smoke-runbook.md`.

---

### Task 0: Commit the contract set (already written on this branch)

**Files:** everything `git status` shows under `docs/`, `CLAUDE.md`, `xiNAS-MCP/package.json`, `xiNAS-MCP/package-lock.json`, `xiNAS-MCP/src/__tests__/contracts/mcp/2026-07-28/schema.json`, plus this plan.

- [ ] **Step 1: Verify the docs gates**

```bash
npx --yes markdownlint-cli2 'docs/**/*.md'
npx --yes -p @stoplight/spectral-cli@latest spectral lint --ruleset .spectral.yaml docs/control-path/api-v1.yaml
```

Expected: `0 issues`; spectral `0 errors` (46 warnings pre-exist).

- [ ] **Step 2: Verify the TypeScript tree still passes with the new devDependency**

```bash
cd xiNAS-MCP && npm run typecheck && npm run lint && npm run format:check && npm test
```

- [ ] **Step 3: Commit**

```bash
git add docs CLAUDE.md xiNAS-MCP/package.json xiNAS-MCP/package-lock.json xiNAS-MCP/src/__tests__/contracts/mcp/2026-07-28/schema.json
git commit -m "docs(control-path): S17 MCP subscriptions — requirements validation record, spec, ADR-0010/S14/S16/S3-S7/agent/notification amendments, api-v1 additions, plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Journal, migration 007 and the cursor codec

**Files:**
- Create: `src/state/migrations/007-operational-events.sql`, `src/api/events/types.ts`, `src/api/events/cursor.ts`, `src/api/events/journal.ts`
- Test: `src/__tests__/api/events/cursor.test.ts`, `src/__tests__/api/events/journal.test.ts`, `src/__tests__/state/migrations.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type Feed = 'raid' | 'raid/progress' | 'storage' | 'nfs' | 'nfs/sessions' | 'system'`; `FEEDS: readonly Feed[]` (that order); `FEED_URI_PREFIX = 'xinas://events/'`; `feedUri(feed)`.
  - `encodeCursor({ controllerId, feed, sequence }): string`; `decodeCursor(cursor, { controllerId, feed, last }): { sequence: number }` — throws `CursorError` (message `invalid cursor`).
  - `class EventJournal { constructor(db, { controllerId, now? }); insert(input: EventInput, opts?: { dedupeKey?: string }): { sequence: number; envelope: EventEnvelope; deduplicated: boolean }; listAfter(feed, afterSequence, limit): EventEnvelope[]; listLatest(feed, limit): EventEnvelope[]; hasAfter(feed, sequence): boolean; bounds(): { oldest: number | null; last: number }; retentionSweep({ retentionDays, maxRows, batchRows, maxBatches }): { deleted: number; exhausted: boolean }; count(): number; metaGet<T>(key): T | null; metaSet(key, value): void }`.
  - `EventInput` = `EventEnvelope` without `eventId`, `sequence`, `controllerId` (the journal fills them; `eventId` = `randomUUID()`).

- [ ] **Step 1: Write the migration**

```sql
-- 007 (S17, docs/control-path/s17-mcp-subscriptions-spec.md §7.1):
-- the operational-event journal and its producer-state side table.
CREATE TABLE IF NOT EXISTS operational_events (
  sequence           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT    NOT NULL UNIQUE,
  controller_id      TEXT    NOT NULL,
  feed               TEXT    NOT NULL CHECK (feed IN ('raid','raid/progress','storage','nfs','nfs/sessions','system')),
  type               TEXT    NOT NULL,
  severity           TEXT    NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  detected_at        INTEGER NOT NULL,
  occurred_at        INTEGER,
  subject_kind       TEXT    NOT NULL,
  subject_id         TEXT    NOT NULL,
  dedupe_key         TEXT,
  cause_task_id      TEXT,
  cause_operation_id TEXT,
  payload            TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS operational_events_feed_seq_idx ON operational_events(feed, sequence);
CREATE INDEX IF NOT EXISTS operational_events_detected_idx ON operational_events(detected_at);
CREATE INDEX IF NOT EXISTS operational_events_subject_idx ON operational_events(subject_kind, subject_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS operational_events_dedupe_idx ON operational_events(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS operational_event_meta (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing cursor tests**

```ts
// src/__tests__/api/events/cursor.test.ts
import { describe, expect, it } from 'vitest';
import { CursorError, decodeCursor, encodeCursor } from '../../../api/events/cursor.js';

const scope = { controllerId: '00000000-0000-0000-0000-0000000000aa', feed: 'raid' as const, last: 50 };

describe('cursor codec', () => {
  it('round-trips and is base64url', () => {
    const c = encodeCursor({ controllerId: scope.controllerId, feed: 'raid', sequence: 42 });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, scope)).toEqual({ sequence: 42 });
  });
  it.each([
    ['other controller', encodeCursor({ controllerId: 'x', feed: 'raid', sequence: 1 })],
    ['other feed', encodeCursor({ controllerId: scope.controllerId, feed: 'nfs', sequence: 1 })],
    ['future sequence', encodeCursor({ controllerId: scope.controllerId, feed: 'raid', sequence: 51 })],
    ['tampered tag', `${encodeCursor({ controllerId: scope.controllerId, feed: 'raid', sequence: 1 }).slice(0, -2)}AA`],
    ['garbage', 'not*base64'],
    ['too long', 'A'.repeat(300)],
  ])('rejects %s', (_label, cursor) => {
    expect(() => decodeCursor(cursor, scope)).toThrow(CursorError);
    expect(() => decodeCursor(cursor, scope)).toThrow('invalid cursor');
  });
  it('accepts sequence 0 and sequence == last', () => {
    expect(decodeCursor(encodeCursor({ ...scope, sequence: 0 }), scope)).toEqual({ sequence: 0 });
    expect(decodeCursor(encodeCursor({ ...scope, sequence: 50 }), scope)).toEqual({ sequence: 50 });
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run src/__tests__/api/events/cursor.test.ts` → module not found.

- [ ] **Step 4: Implement `types.ts` and `cursor.ts`**

```ts
// src/api/events/types.ts
export const FEEDS = ['raid', 'raid/progress', 'storage', 'nfs', 'nfs/sessions', 'system'] as const;
export type Feed = (typeof FEEDS)[number];
export const FEED_URI_PREFIX = 'xinas://events/';
export const FEED_MIME = 'application/vnd.xinas.events+json';
export const feedUri = (feed: Feed): string => `${FEED_URI_PREFIX}${feed}`;
export const isFeed = (v: unknown): v is Feed => typeof v === 'string' && (FEEDS as readonly string[]).includes(v);

export type Severity = 'info' | 'warning' | 'error' | 'critical';
export type TimeAccuracy = 'source' | 'observed' | 'task';
export type SourceKind = 'observed_transition' | 'observed_snapshot' | 'heartbeat' | 'inventory' | 'task';
export type SubjectKind = 'XiraidArray' | 'Disk' | 'Pool' | 'Filesystem' | 'ExportRule' | 'NfsSession' | 'SystemdUnit' | 'Agent' | 'Collector' | 'NetworkInterface' | 'Node';
export type OperationKind = 'initialization' | 'reconstruction';
export const REASON_CODES = ['baseline','state_none','reconcile_absent','unit_failed','unit_inactive','unmounted','ro_option','hysteresis','task','reboot','connect_refused','heartbeat_timeout','collector_error','no_valid_update','helper_absent','not_configured','unknown_word','regression'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface EventEnvelope {
  schemaVersion: '1';
  eventId: string;
  sequence: number;
  controllerId: string;
  feed: Feed;
  type: string;
  severity: Severity;
  detectedAt: string;
  timeAccuracy: TimeAccuracy;
  source: { kind: SourceKind; component: string };
  subject: { kind: SubjectKind; id: string };
  summary: string;
  occurredAt?: string;
  previous?: Record<string, unknown>;
  current?: Record<string, unknown>;
  operation?: { kind: OperationKind; generation: number; progressPct?: number; bucket?: number };
  threshold?: { metric: string; value: number; unit: string; enter: number; clear: number };
  reasonCode?: ReasonCode;
  relatedResources?: Array<{ kind: string; id: string }>;
  cause?: { taskId?: string; operationId?: string };
  details?: Record<string, unknown>;
}
export type EventInput = Omit<EventEnvelope, 'eventId' | 'sequence' | 'controllerId'>;
```

```ts
// src/api/events/cursor.ts
import { createHash } from 'node:crypto';
import type { Feed } from './types.js';

const SEP = '\x1f';
const VERSION = '1';
const MAX_LEN = 256;

export class CursorError extends Error {
  constructor() { super('invalid cursor'); this.name = 'CursorError'; }
}
function tag(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, 11); // 8 bytes → 11 base64url chars
}
export function encodeCursor(p: { controllerId: string; feed: Feed; sequence: number }): string {
  const body = [VERSION, p.controllerId, p.feed, String(p.sequence)].join(SEP);
  return Buffer.from(`${body}${SEP}${tag(body)}`, 'utf8').toString('base64url');
}
export function decodeCursor(cursor: string, scope: { controllerId: string; feed: Feed; last: number }): { sequence: number } {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_LEN || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new CursorError();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = text.split(SEP);
  if (parts.length !== 5) throw new CursorError();
  const [version, controllerId, feed, seqText, t] = parts as [string, string, string, string, string];
  if (version !== VERSION || controllerId !== scope.controllerId || feed !== scope.feed) throw new CursorError();
  if (!/^(0|[1-9][0-9]{0,15})$/.test(seqText)) throw new CursorError();
  const sequence = Number(seqText);
  if (sequence > scope.last) throw new CursorError();
  if (tag([version, controllerId, feed, seqText].join(SEP)) !== t) throw new CursorError();
  return { sequence };
}
```

- [ ] **Step 5: Run cursor tests → PASS.**

- [ ] **Step 6: Write the failing journal tests**

```ts
// src/__tests__/api/events/journal.test.ts
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventJournal } from '../../../api/events/journal.js';
import type { EventInput } from '../../../api/events/types.js';
import { runMigrations } from '../../../state/migrations.js';

const CID = '00000000-0000-0000-0000-0000000000aa';
const input = (over: Partial<EventInput> = {}): EventInput => ({
  schemaVersion: '1', feed: 'raid', type: 'raid.state.degraded', severity: 'error',
  detectedAt: '2026-09-04T12:00:00.000Z', timeAccuracy: 'observed',
  source: { kind: 'observed_transition', component: 'XiraidArray' },
  subject: { kind: 'XiraidArray', id: 'data' }, summary: 'RAID array data: degraded', ...over,
});

describe('EventJournal', () => {
  let db: Database.Database; let j: EventJournal; let now = 1_000_000;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); j = new EventJournal(db, { controllerId: CID, now: () => now }); });
  afterEach(() => db.close());

  it('allocates increasing sequences across feeds and fills ids', () => {
    const a = j.insert(input()); const b = j.insert(input({ feed: 'nfs' }));
    expect(b.sequence).toBe(a.sequence + 1);
    expect(a.envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.envelope.controllerId).toBe(CID);
    expect(j.listAfter('raid', 0, 10)).toEqual([a.envelope]);
  });
  it('dedupes on the key without allocating a sequence', () => {
    const a = j.insert(input(), { dedupeKey: 'k' }); const b = j.insert(input(), { dedupeKey: 'k' });
    expect(b.deduplicated).toBe(true); expect(b.sequence).toBe(a.sequence); expect(j.count()).toBe(1);
  });
  it('lists the newest N ascending and reports hasAfter', () => {
    for (let i = 0; i < 5; i++) j.insert(input({ summary: `e${i}` }));
    expect(j.listLatest('raid', 2).map((e) => e.summary)).toEqual(['e3', 'e4']);
    expect(j.hasAfter('raid', 3)).toBe(true); expect(j.hasAfter('raid', 5)).toBe(false);
  });
  it('sequence survives deletes (AUTOINCREMENT never reuses)', () => {
    j.insert(input()); j.insert(input());
    db.prepare('DELETE FROM operational_events').run();
    expect(j.insert(input()).sequence).toBe(3);
    expect(j.bounds()).toEqual({ oldest: 3, last: 3 });
  });
  it('retention deletes oldest first in bounded batches', () => {
    for (let i = 0; i < 12; i++) { now += 1000; j.insert(input()); }
    const r = j.retentionSweep({ retentionDays: 30, maxRows: 5, batchRows: 2, maxBatches: 2 });
    expect(r).toEqual({ deleted: 4, exhausted: true });
    expect(j.bounds().oldest).toBe(5);
    const r2 = j.retentionSweep({ retentionDays: 30, maxRows: 5, batchRows: 500, maxBatches: 50 });
    expect(r2).toEqual({ deleted: 3, exhausted: false });
    expect(j.count()).toBe(5);
  });
  it('age retention uses detected_at', () => {
    j.insert(input({ detectedAt: new Date(now - 8 * 86_400_000).toISOString() }));
    j.insert(input());
    expect(j.retentionSweep({ retentionDays: 7, maxRows: 1000, batchRows: 500, maxBatches: 50 }).deleted).toBe(1);
  });
  it('meta get/set round-trips JSON', () => {
    expect(j.metaGet('boot_id')).toBeNull();
    j.metaSet('boot_id', 'abc'); expect(j.metaGet<string>('boot_id')).toBe('abc');
  });
});
```

- [ ] **Step 7: Implement `journal.ts`**

```ts
// src/api/events/journal.ts
import { randomUUID } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import { canonicalize } from '../../lib/canonical-json.js';
import type { EventEnvelope, EventInput, Feed } from './types.js';

export interface RetentionPolicy { retentionDays: number; maxRows: number; batchRows: number; maxBatches: number }
export const MAX_PAYLOAD_BYTES = 65_536;

export class EventJournal {
  readonly #db: Database; readonly #controllerId: string; readonly #now: () => number;
  readonly #insert: Statement; readonly #byDedupe: Statement; readonly #after: Statement; readonly #latest: Statement;
  readonly #hasAfter: Statement; readonly #oldest: Statement; readonly #last: Statement; readonly #count: Statement;
  readonly #deleteOlderThan: Statement; readonly #deleteOldest: Statement; readonly #metaGet: Statement; readonly #metaSet: Statement;
  constructor(db: Database, opts: { controllerId: string; now?: () => number }) {
    this.#db = db; this.#controllerId = opts.controllerId; this.#now = opts.now ?? Date.now;
    this.#insert = db.prepare(`INSERT INTO operational_events (event_id, controller_id, feed, type, severity, detected_at, occurred_at, subject_kind, subject_id, dedupe_key, cause_task_id, cause_operation_id, payload) VALUES (@event_id, @controller_id, @feed, @type, @severity, @detected_at, @occurred_at, @subject_kind, @subject_id, @dedupe_key, @cause_task_id, @cause_operation_id, @payload)`);
    this.#byDedupe = db.prepare('SELECT sequence, payload FROM operational_events WHERE dedupe_key = ?');
    this.#after = db.prepare('SELECT payload FROM operational_events WHERE feed = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?');
    this.#latest = db.prepare('SELECT payload FROM (SELECT payload, sequence FROM operational_events WHERE feed = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC');
    this.#hasAfter = db.prepare('SELECT 1 FROM operational_events WHERE feed = ? AND sequence > ? LIMIT 1');
    this.#oldest = db.prepare('SELECT MIN(sequence) AS s FROM operational_events');
    this.#last = db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'operational_events'), 0) AS s");
    this.#count = db.prepare('SELECT COUNT(*) AS n FROM operational_events');
    this.#deleteOlderThan = db.prepare('DELETE FROM operational_events WHERE sequence IN (SELECT sequence FROM operational_events WHERE detected_at < ? ORDER BY sequence ASC LIMIT ?)');
    this.#deleteOldest = db.prepare('DELETE FROM operational_events WHERE sequence IN (SELECT sequence FROM operational_events ORDER BY sequence ASC LIMIT ?)');
    this.#metaGet = db.prepare('SELECT value FROM operational_event_meta WHERE key = ?');
    this.#metaSet = db.prepare('INSERT INTO operational_event_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  }
  // insert: dedupe lookup first; then payload with a placeholder sequence, run insert, patch sequence into payload
  // (payload stores the FULL envelope including sequence — rewrite once after lastInsertRowid).
  insert(input: EventInput, opts: { dedupeKey?: string } = {}): { sequence: number; envelope: EventEnvelope; deduplicated: boolean } { /* see spec §7.2 */ }
  listAfter(feed: Feed, afterSequence: number, limit: number): EventEnvelope[] { return (this.#after.all(feed, afterSequence, limit) as { payload: string }[]).map((r) => JSON.parse(r.payload) as EventEnvelope); }
  listLatest(feed: Feed, limit: number): EventEnvelope[] { /* #latest */ }
  hasAfter(feed: Feed, sequence: number): boolean { return this.#hasAfter.get(feed, sequence) !== undefined; }
  bounds(): { oldest: number | null; last: number } { /* #oldest, #last */ }
  count(): number { return (this.#count.get() as { n: number }).n; }
  retentionSweep(p: RetentionPolicy): { deleted: number; exhausted: boolean } {
    // loop up to maxBatches: first age (detected_at < now − days), then row cap (count − maxRows); each batch its own db.transaction
  }
  metaGet<T>(key: string): T | null { const r = this.#metaGet.get(key) as { value: string } | undefined; return r === undefined ? null : (JSON.parse(r.value) as T); }
  metaSet(key: string, value: unknown): void { this.#metaSet.run(key, JSON.stringify(value), this.#now()); }
}
```

The `insert` body: if `opts.dedupeKey` and `#byDedupe.get(key)` exists → return `{ sequence, envelope: JSON.parse(payload), deduplicated: true }`. Otherwise `eventId = randomUUID()`, run `#insert` with `payload: '{}'` placeholder? No — SQLite needs the final payload; do it in two statements inside `db.transaction`: insert with payload `''`, read `lastInsertRowid`, build `envelope = { ...input, eventId, sequence, controllerId }`, `payload = canonicalize(envelope)`, refuse when `Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES` (throw `RangeError('event payload exceeds 64 KiB')`), then `UPDATE operational_events SET payload = ? WHERE sequence = ?`. `detected_at`/`occurred_at` columns store `Date.parse(...)`.

- [ ] **Step 8: Extend `migrations.test.ts`** — assert `007-operational-events.sql` applied (`schema_version` has 7) and the two tables exist.

- [ ] **Step 9: Run all → PASS; typecheck/lint/format.**

- [ ] **Step 10: Commit** — `feat(events): operational-event journal (migration 007) and opaque feed cursors (S17 §7)` + trailer.

---

### Task 2: Envelope builder, details schemas, redaction bounds

**Files:**
- Create: `src/api/events/schema.ts`, `src/api/events/envelope.ts`
- Test: `src/__tests__/api/events/envelope.test.ts`

**Interfaces:**
- Produces: `buildEvent(spec: EventSpec): EventInput` where `EventSpec = { feed, type, severity, subject, source, detectedAtMs, summaryArgs: Record<string,string|number>, ... optional groups }`; `summaryFor(type, args)` returns the templated ≤256-char string; `validateDetails(type, details)` throws `RangeError` on schema failure; `PRODUCER_FAMILIES: Record<Feed, { active: string[]; inactive: Array<{ family: string; reason: string }> }>` (§4.4 defaults, before config tweaks); `EVENT_SEVERITY: Record<string, Severity | ((ctx) => Severity)>` — the §6.4 table.

- [ ] **Step 1: Failing tests** — `summaryFor('raid.operation.started', { array: 'data', kind: 'initialization' })` equals `'RAID array data: initialization started'`; a 5000-char id is capped so the summary is ≤ 256 chars and control characters (``, `\n`) are stripped; `validateDetails('nfs.session.connected', { clientAddr: '10.0.0.1', exportPath: '/srv', protoVersion: 'v4.1', lockedFiles: 0 })` passes; an extra key `{ raw: {...} }` fails; every type in `EVENT_SEVERITY` has a details schema (iterate); `buildEvent` output serializes under 64 KiB for a details object with 64 × 1024-char strings? — instead assert that a `details` string > 1024 chars fails validation.

- [ ] **Step 2: Implement** — `schema.ts` holds one Ajv instance (`strict: false`, `allErrors: true`) compiled once; schemas per type with `additionalProperties: false`, `maxLength: 1024` on strings, `maxItems: 64` on arrays. `envelope.ts` templates: a `Record<string, (a) => string>` keyed by type; `clean(s) = s.replace(/[ -\x1f]/g, '').slice(0, 120)` applied to every arg; final `.slice(0, 256)`.

- [ ] **Step 3: Tests pass; commit** — `feat(events): event envelope builder, per-type details schemas and summary templates (S17 §6)` + trailer.

---

### Task 3: xiRAID observation correction

**Files:**
- Modify: `src/lib/parse/raid.ts` (interface `ObservedXiraidArray.status`, `parseRaidShow`), `src/__tests__/contracts/fixtures/XiraidArray.json`
- Test: `src/__tests__/lib/xiraid/raid-parse.test.ts` (extend the existing parser test file; find it with `grep -l parseRaidShow src/__tests__ -r`)

- [ ] **Step 1: Failing tests** — a payload `{ name: 'data', level: '5', devices: [...], state: ['Online', 'initing', 'online'], init_progress: 37, recon_progress: null, restripe_progress: 'x', sdc_progress: 100.0 }` yields `status.raw_states: ['online', 'initing']`, `init_progress_pct: 37`, `recon_progress_pct: null`, `restripe_progress_pct: null`, `sdc_progress_pct: 100`, and `rebuild_progress_pct: 37` (unchanged merge). A value `150` → `null`; `-1` → `null`; `NaN` → `null`. An unknown word `weird` is retained in `raw_states` and `status.state === 'unknown'`.

- [ ] **Step 2: Implement** — `const pct = (v: unknown): number | null => { const n = numberOrNull(v); return n !== null && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null; }`; add the five fields to the status literal; `raw_states: states` (already normalized by `normalizeStates` — confirm it lower-cases and de-duplicates; if it only lower-cases, add `[...new Set(states)]`).

- [ ] **Step 3: Fixture** — add `"raw_states": ["online"], "init_progress_pct": null, "recon_progress_pct": null, "restripe_progress_pct": null, "sdc_progress_pct": null` to `XiraidArray.json` status; `npm run test:contracts`.

- [ ] **Step 4: Full gate; commit** — `feat(xiraid): retain raw state words and the four separate progress values on XiraidArray.status (S17 §8.1, S3 amendment)` + trailer.

---

### Task 4: Transition engine core, meta accessors, RAID and RAID-progress producers

**Files:**
- Create: `src/api/events/meta.ts`, `src/api/events/engine.ts`, `src/api/events/producers/raid.ts`
- Test: `src/__tests__/api/events/engine.test.ts`, `src/__tests__/api/events/producers-raid.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EngineDeps { journal: EventJournal; db: Database; config: ResolvedSubscriptionsConfig; now: () => number; taskLookup?: (kinds: string[], subjectRef: string) => { task_id: string; correlation_id: string } | null }
  export interface ChangeCtx { kind: Kind; id: string; previous: Record<string, unknown> | null; current: Record<string, unknown> | null; previousRevision: number | null; observedAt: string; kv: KvTransaction }
  export interface Producer { onChange?(ctx: ChangeCtx, emit: Emit, meta: MetaStore): void; onSnapshot?(kind: Kind, present: Set<string>, emit: Emit, meta: MetaStore, kv: KvTransaction): void }
  export type Emit = (spec: EventSpec, opts?: { dedupeKey?: string }) => void
  export class TransitionEngine { constructor(deps: EngineDeps, producers?: Producer[]); begin(batch: { observedAt: string; completeSnapshots: Kind[]; kv: KvTransaction }): void; onChange(c: Omit<ChangeCtx,'kv'|'observedAt'>): void; onSnapshot(kind: Kind, present: Set<string>): void; commit(): { feeds: Set<Feed>; count: number }; emitDirect(spec: EventSpec, opts?): { feeds: Set<Feed> } /* outside a batch: heartbeat/inventory */ }
  export class MetaStore { constructor(journal: EventJournal); get<T>(key): T | null; set(key, value): void; }
  ```
  - `raid.ts` exports `raidProducer: Producer` and the pure helpers `healthPredicates(rawStates: string[], memberStates)`, `conditions(rawStates)`, used by tests.
- Consumes: Task 1/2 exports.

- [ ] **Step 1: Failing engine tests** — `begin/onChange/commit` inserts through the journal inside a `db.transaction` (assert rollback on a throwing producer leaves zero rows); `commit()` returns the touched feeds; `emitDirect` works without `begin`; a producer's `emit` with `previous === null` for a non-baseline type is ignored by the engine guard (assert that a test producer emitting `raid.state.degraded` on a null previous is dropped and logged) — the guard lists the four baseline exceptions.

- [ ] **Step 2: Failing RAID table tests** — table-driven over `(previousRawStates, previousMembers, currentRawStates, currentMembers) → expected types`, covering (all words lower-case):
  - `null → ['online','initing']` → `raid.operation.observed_running` only.
  - `['online'] → ['online','initing']` → `raid.operation.started` (generation 1).
  - `['online','initing'] → ['online','initialized']` → `raid.operation.completed`.
  - `['online','initing'] → ['need_init']` → `raid.operation.failed` (warning).
  - `['online','initing'] → ['offline']` → `raid.operation.failed` (error) + `raid.state.offline`.
  - `['online'] → ['degraded']` → `raid.state.degraded`; `['degraded'] → ['degraded','reconstructing']` → `raid.operation.started` (reconstruction), no state event; `['degraded','reconstructing'] → ['online']` → `raid.operation.completed` + `raid.state.recovered` (previous.severity `error`); `['degraded','reconstructing'] → ['need_recon']` → `raid.operation.failed`.
  - `['online'] → ['online','read_only']` → `raid.state.read_only`; `['online'] → ['none']` → `raid.state.offline` reason `state_none`; `['online'] → ['unrecovered']` → `raid.state.unrecovered` (critical).
  - `null → ['offline']` → `raid.state.offline` reason `baseline`; `null → ['degraded']` → nothing.
  - `['online'] → ['online','sdc_scanning']`, `→ ['online','need_restripe']`, `→ ['online','need_resize']`, `→ ['online','restriping']`, `→ ['online','inconsistent']`, `→ ['online','need_init']` → no `raid.state.*` event.
  - `['online'] → ['online','weird']` → `raid.source.unknown_state` once; repeat → dedupe (meta `unknown_state_warned`).
  - member `online → offline` → `raid.member.offline` (subject Disk); `offline → online` → `raid.member.returned`; array-level `online` with a member `reconstructing` is not `healthy` (operation not completed).
  - array `online` + `reconstructing` members and array word `online` only → completion requires all members online.
  - `current === null` with previous active init → `raid.array.removed` with `details.operationInProgress: 'initialization'` and no operation event; without `restore_pending`.
  - `previous === null` after the kind's baseline (meta `baseline_done:XiraidArray`) → `raid.array.created`.
  - Pool: `drives ['a','b'] → ['a']` → `raid.spare.disconnected` for `b`; `→ []` while an array references the pool → also `raid.spare_pool.exhausted`; `[] → ['a']` → `raid.spare.returned` + `raid.spare_pool.replenished`.
  - Replacement: previous members `[d1,d2]`, current `[d1,d3]`, previous Pool row for the array's `spare_pool` has `d3` → `raid.spare.replacement.completed` `{ replaced: 'd2', replacement: 'd3', pool }` and no `raid.spare.disconnected` for `d3` in the same batch.
  - Restore: with `restore_pending = { knownArrays: ['a','b','c','d'] }` and a complete snapshot where `a` is `['online']`, `b` `['read_only','online']`, `c` `['offline']`, `d` absent → `raid.restore.completed` ×3 (`healthy` info, `read_only` warning, `offline` error) and `raid.restore.failed` for `d` with `{ result: 'not_restored' }`; `restore_pending` cleared; `d`'s reconcile delete emits no `raid.array.removed`.
  - Progress: `init_progress_pct` 0 → 12 → 19 → 23 (with `now` advancing 40 s each) → events at bucket 10 (12) and bucket 20 (23), none at 19; a jump 23 → 67 → one event with `progressPct: 67, bucket: 60`; `67 → 30` while still `initing` → generation 2, reason `regression`; two samples 5 s apart → the second suppressed by `min_interval_s`; unchanged 40 % for 700 s → no event; 40 → 41 after 700 s → event (max silence); `init_progress_pct: null` → nothing.

- [ ] **Step 3: Implement `meta.ts`, `engine.ts`, `producers/raid.ts`** following spec §8.0–§8.3. Task correlation: `engine.correlate(kinds: string[], subjectRef: string)` runs `SELECT task_id, correlation_id FROM tasks WHERE kind IN (...) AND state IN ('running','success') AND affected_resources LIKE ? ORDER BY updated_at DESC LIMIT 1` with `%"<Kind>/<id>"%` — check the persisted `affected_resources` JSON shape in `api/tasks/store.ts` first and match it exactly. Baseline detection per kind: meta `baseline_done:<Kind>` set by `onSnapshot` on the first complete snapshot of that kind; `raid.array.created` / `filesystem.definition.added` / `nfs.export.added` / `nfs.session.connected` emit for `previous === null` only when that flag is already set.

- [ ] **Step 4: All tests pass; gate; commit** — `feat(events): transition engine and the RAID / RAID-progress producers (S17 §8.0–§8.3)` + trailer.

---

### Task 5: Storage, NFS and NFS-session producers

**Files:**
- Create: `src/api/events/producers/storage.ts`, `src/api/events/producers/nfs.ts`, `src/api/events/producers/sessions.ts`
- Test: `src/__tests__/api/events/producers-storage.test.ts`, `producers-nfs.test.ts`, `producers-sessions.test.ts`

- [ ] **Step 1: Failing storage tests** — `mounted true → false` → `mount.lost` (reason `unmounted`); `mount_unit_state active → failed` → `mount.lost` (`unit_failed`); `false → true` → `mount.restored`; `effective_mount_options ['rw'] → ['ro']` (mounted both) → `read_only.entered`; reverse → `cleared`; capacity with `size 100 free 25` (75 %) → nothing; `free 19` (81 %) → `capacity.warning` with threshold group; `free 12` (88 %) → nothing (still warning); `free 9` (91 %) → `capacity.critical`; `free 16` (84 %) → `capacity.cleared`?? No — 84 % clears critical (`< 85`) back to warning: expect `filesystem.capacity.warning` with `previous.severity: critical`; `free 26` (74 %) → `capacity.cleared`; `previous === null` with 95 % → `capacity.critical` (baseline exception); `size 0` → nothing; per-filesystem override applies; row deleted → `definition.removed`; created after baseline → `definition.added`; `mount_unit_state failed` + a `failed` `fs.mount` task (injected `taskLookup`) → `mount.failed` with `cause.taskId`.

- [ ] **Step 2: Failing NFS tests** — services: `active → failed` on `nfs-server.service` → `nfs.service.unavailable`; `failed → active` → `recovered`; `load_state not-found` → nothing; `xinas-agent.service` uses `system.service.*` (goes in Task 6's system producer, but the shared unit rule lives in `nfs.ts` as `unitTransition()` — test it here). Exports: rules `[{host:'10.0.0.0/24', options:['rw','sync']}] → [{host:'10.0.0.0/24', options:['sync','rw']}]` → nothing; `→ options ['rw','sync','no_root_squash']` → `export.changed`; add host → `export.added`; drop host → `export.removed`; row deleted → one `removed` per rule; created after baseline → one `added` per rule. Backing: export `/srv/data2` with filesystems `/srv/data` (unmounted) and `/srv/data2` (mounted) → available; `/srv/data2` fs `mounted → false` → `backing_unavailable`; export `/srv/data/proj` under `/srv/data` → follows `/srv/data`. RDMA: desired profile `rdma.enabled true`, observed `rdma_listening true`, one managed iface `rdma_link_state up` → ready; iface `→ down` → `nfs.rdma.unavailable` naming the iface; `rdma.enabled false` → never.

- [ ] **Step 3: Failing sessions tests** — session created after baseline → nothing yet; next complete `NfsSession` snapshot containing it → `connected`; a batch without a `NfsSession` snapshot → nothing; reconcile delete → candidate; next snapshot without it → `disconnected`; snapshot with it again → candidate dropped, no event; `proto_version v4.1 → v4.2` → `protocol_changed`; lock threshold `enter 100 clear 50`: `locked_files 99 → 100` → `crossed`; `100 → 60` → nothing; `→ 49` → `cleared`; with `enter 0` nothing ever. Details carry `clientAddr`/`exportPath` and never `client_hostname`.

- [ ] **Step 4: Implement the three producers** per spec §8.4–§8.5. Backing readiness needs the other kind's rows: read them through `ctx.kv.list({ prefix: '/xinas/v1/observed/Filesystem/' })` / `.../ExportRule/` inside the transaction (transaction-snapshot reads, `KvTransaction.list`). Desired profile: `ctx.kv.get('/xinas/v1/desired/NfsProfile/default')`. Path boundary: `p === m || p.startsWith(m.endsWith('/') ? m : m + '/')`, longest `m` wins.

- [ ] **Step 5: Gate; commit** — `feat(events): storage, NFS and NFS-session producers (S17 §8.4–§8.5)` + trailer.

---

### Task 6: System producers, heartbeat and ingest wiring

**Files:**
- Create: `src/api/events/producers/system.ts`
- Modify: `src/api/heartbeat.ts` (replace `#emitStateChange`; add `recordCollectorMap` hook), `src/api/internal/observed.ts` (engine hook, per-kind last-accepted), `src/api/context.ts` (`events?: EventsContext`), `src/api/server.ts` (open the journal, build the engine, pass to the tracker), `src/__tests__/api/_helpers.ts` (wire `events` when `withEvents: true`)
- Test: `src/__tests__/api/events/producers-system.test.ts`, extend `src/__tests__/api/heartbeat.test.ts`, `src/__tests__/api/internal-observed.test.ts`

**Interfaces:**
- Produces: `interface EventsContext { journal: EventJournal; engine: TransitionEngine; registry?: SubscriptionRegistry; config: ResolvedSubscriptionsConfig; metrics: SubscriptionMetrics }` on `ApiContext.events` (registry attached in Task 9). `HeartbeatTrackerOptions.events?: { onAgentState(from, to, reason): void; onCollectorMap(map: Record<string,string>): void }`.

- [ ] **Step 1: Failing tests** — system producer: `SystemdUnit xiraid-server.service active → failed` → `system.service.unavailable`; `xinas-api.service failed → active` → `recovered`; `xinas-api.service active → failed` → nothing (V-72); links: managed iface `link_state up → down` → `system.network.link_down`; unmanaged non-RDMA → nothing; `rdma_link_state down → up` → `system.rdma.link_up`; a current row missing `link_state` (partial) → nothing; reboot: inventory `boot_id` first seen → meta stored, no event; changed → `system.reboot.detected` + `restore_pending` with the known arrays; unchanged → nothing. Collector map: `{ XiraidArray: 'running' } → { XiraidArray: 'error: XIRAID_DAEMON_UNAVAILABLE: x' }` → `system.collector.failed` (details.reason ≤ 256); back to `running` without a newer accepted batch → nothing; after `collector_last_accepted:XiraidArray` advances → `recovered`; staleness: last accepted 100 s ago with poll 30 s and agent healthy → `stale`; accepted batch → `recovered`. Heartbeat: the tracker no longer writes `/xinas/v1/events/` KV rows (assert `kv.list({prefix})` empty) and calls `events.onAgentState('healthy','degraded','heartbeat_timeout')`; the existing bootstrap suppression test still passes. Observed handler: with `ctx.events` present, an upsert whose value changed calls the engine and the journal has the expected row, all inside one transaction (assert a producer throw rolls back the KV write too); the handler stores `collector_last_accepted:<Kind>`; without `ctx.events` behavior is unchanged.

- [ ] **Step 2: Implement** — in `observed.ts`, inside the transaction: `engine.begin({ observedAt: body.observed_at, completeSnapshots, kv: tx })`; on each applied upsert `engine.onChange({ kind, id, previous: current?.value ?? null, current: value, previousRevision: current?.revision ?? null })`; on each explicit delete and each reconcile delete `engine.onChange({ ..., current: null })`; after reconcile, `engine.onSnapshot(kind, presentIds)` per complete kind; `const { feeds } = engine.commit()`; after the transaction returns: `ctx.events.registry?.notify(feeds)`. In `heartbeat.ts`: `#emitStateChange` → `this.#opts.events?.onAgentState(from, to, reason)`; `recordHeartbeatSuccess` → `this.#opts.events?.onCollectorMap(payload.collectors)` when provided. `server.ts`: `const journal = new EventJournal(state.db, { controllerId })`, `const engine = new TransitionEngine({ journal, db: state.db, config: resolveSubscriptionsConfig(config), now: Date.now, taskLookup })`, `ctx.events = { journal, engine, config, metrics }`; tracker options get the two hooks (they call `engine.emitDirect`, then `registry?.notify`).

- [ ] **Step 3: Gate; commit** — `feat(events): system producers; heartbeat and observation ingest write the journal in-transaction (S17 §8.0, §8.6)` + trailer.

---

### Task 7: Configuration section `mcp.subscriptions`

**Files:**
- Modify: `src/api/config.ts` (`SubscriptionsConfig`, `ResolvedSubscriptionsConfig`, `SUBSCRIPTIONS_DEFAULTS`, `resolveSubscriptionsConfig`, `validateSubscriptionsSection` called from `loadConfig`)
- Test: `src/__tests__/api/config-subscriptions.test.ts`

- [ ] **Step 1: Failing tests** — defaults resolve to the spec's values; `retention_days: 31` → throws `mcp.subscriptions.retention_days must be an integer in [1, 30], got 31`; `capacity: { warning_enter: 80, warning_clear: 80 }` → throws mentioning `clear < enter`; `critical_enter: 79` → throws; `per_filesystem: { 'srv-data.mount': { warning_enter: 95 } }` merges with globals; `nfs_lock_threshold: { enter: 10, clear: 20 }` → throws; `enabled: false` accepted; `progress.max_silence_s` below `min_interval_s` → throws.

- [ ] **Step 2: Implement** with the `validateMcpSection` style (`bounded(name, value, min, max)`).

- [ ] **Step 3: Gate; commit** — `feat(api): mcp.subscriptions config section with bounded validation (S17 §10)` + trailer.

---

### Task 8: Resource provider seam, feed reads, discovery

**Files:**
- Create: `src/api/mcp/resources.ts`, `src/api/events/feeds.ts`
- Modify: `src/api/mcp/modern.ts` (cases `resources/list`, `resources/templates/list`, `resources/read`), `src/api/mcp/discover.ts` (`buildCapabilities(ctx?)`, `buildDiscoverResult(ctx?)`, `INSTRUCTIONS` + one sentence on feeds/polling), `src/api/mcp/transport.ts` (pass `ctx` into the modern handler options), `src/api/mcp/dispatch.ts` (`DispatcherOptions.events?: EventsContext`, `identity` unchanged)
- Test: `src/__tests__/api/mcp-resources.test.ts`, update `src/__tests__/api/mcp-discover.test.ts` (capability with/without journal)

**Interfaces:**
- Produces:
  ```ts
  export interface ResourceProvider { list(): McpResource[]; templates(): McpResourceTemplate[]; owns(uri: string): boolean; read(uri: string, ctx: ReadCtx): ReadResourceResult; subscribable(uri: string): boolean }
  export function listResources(providers): McpResource[]; listTemplates(providers); readResource(providers, uri, ctx)  // throws McpProtocolError(-32602,'invalid resource uri')
  export function parseFeedUri(uri: string): { feed: Feed; after?: string; limit?: number }  // throws McpProtocolError(-32602)
  export function feedProvider(events: EventsContext, audit?: AuditAppender): ResourceProvider
  ```

- [ ] **Step 1: Failing tests** (raw JSON-RPC over HTTP as in `mcp-discover.test.ts`, server started with an inline config that has `agent` unset and a journal — `startServer` always opens the journal now):
  - `resources/list` → six resources in order, MIME, `resultType/ttlMs/cacheScope`, no `nextCursor`; with `params.cursor` → `-32602`.
  - `resources/templates/list` → six templates `xinas://events/<feed>{?after,limit}`.
  - `resources/read` of `xinas://events/raid` on an empty journal → envelope with `events: []`, `gap: false`, `nextCursor === headCursor === oldestAvailableCursor`, `producers.inactive` lists `raid.device` and `raid.license`.
  - Insert 7 events directly through `handle.state`… (expose `handle.events.journal` on `ServerHandle` for tests) → read without `after` and `limit=3` returns the newest 3 ascending, `hasMore: false`; read with `after` = cursor of event 2 → events 3..7 (limit 100), `hasMore: false`; `limit=2` → 3,4 + `hasMore: true`.
  - Delete rows 1–4 through the journal's sweep (`maxRows: 3`) → read with the old cursor of event 1 → `gap: true`, events 5..7, `oldestAvailableCursor` decodes to 4.
  - `-32602` cases: `xinas://events/raid?x=1`, `?limit=0`, `?limit=501`, `?after=zzz`, `?after=a&after=b`, `xinas://events/raid#f`, `file:///etc/passwd`, `xinas://events/raid/`, `XINAS://events/raid`, `params.uri` non-string, `params.inputResponses: {}`.
  - viewer token reads all six; unauthenticated → 401; `mcp.subscriptions.enabled: false` → `-32601` and discover has no `resources`.
  - `server/discover` → `capabilities.resources` equals `{ subscribe: true, listChanged: false }`.

- [ ] **Step 2: Implement** per spec §4; `feeds.ts` builds the envelope, calls `events.metrics.eventRead(feed, outcome)` and queues `mcp.event_cursor.gap_observed` on a gap.

- [ ] **Step 3: Gate; commit** — `feat(mcp): modern-era Resources — six event feeds, cursor templates, reads, capability (S17 §3–§4)` + trailer.

---

### Task 9: Subscription registry, audit and metrics

**Files:**
- Create: `src/api/events/subscriptions.ts`, `src/api/events/audit.ts`, `src/api/events/metrics.ts`
- Test: `src/__tests__/api/events/subscriptions.test.ts`, `metrics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ListenerSink { write(message: unknown): boolean /* false = backpressured */; end(): void; pendingCount(): number }
  export interface OpenListener { id: string | number; principal: string; role: Role; transport: 'http' | 'stdio'; feeds: Feed[]; reauthorize: () => boolean; sink: ListenerSink; correlationId: string }
  export class SubscriptionRegistry {
    constructor(deps: { config: ResolvedSubscriptionsConfig; metrics: SubscriptionMetrics; audit?: AuditAppender; now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout })
    open(l: OpenListener): { ok: true; handle: ListenerHandle } | { ok: false; reason: 'principal_limit' | 'process_limit' }
    notify(feeds: Iterable<Feed>): void
    close(handle: ListenerHandle, reason: CloseReason): void
    closeAll(reason: 'shutdown'): void   // writes the graceful result through sink.write then sink.end
    activeCount(): number
  }
  export type CloseReason = 'client' | 'empty_filter' | 'overflow' | 'unauthorized' | 'shutdown' | 'error'
  ```
  - Metrics: `interface SubscriptionMetrics { subscriptionsActive(transport, delta): void; subscriptionOpened(transport, outcome): void; subscriptionClosed(transport, reason): void; notification(feed, outcome: 'sent'|'skipped'|'error'): void; coalesced(feed): void; eventRead(feed, outcome: 'ok'|'gap'|'invalid'): void; cursorGap(feed): void; eventCreated(feed, severity): void; journalRows(n): void; journalOldestAgeSeconds(s): void; detectionDelaySeconds(source, s): void }` + `noopSubscriptionMetrics` + `InMemorySubscriptionMetrics` (`snapshot(): Record<string, number>` keyed `name{label=value,...}`).

- [ ] **Step 1: Failing tests** with fake timers (`vi.useFakeTimers()`): open writes the ack first with the accepted filter and the id; `notify(['raid'])` ×3 within 250 ms → one `notifications/resources/updated` with `params.uri = 'xinas://events/raid'`, `coalesced` metric 2; `notify(['nfs'])` for a listener subscribed to `raid` only → nothing; `reauthorize` returning false at fire time → listener closed `unauthorized`, no update written; sink `write` returning false and `pendingCount()` > 256 → `overflow` close, audit row `mcp.subscription.overflow`, no graceful result; limits: 5th listener of a principal → `principal_limit`; 33rd overall → `process_limit`; `closeAll('shutdown')` writes `{ jsonrpc, id, result: { resultType: 'complete', _meta: {subscriptionId} } }` then `end()`; an empty accepted set → ack with `{}` then immediate graceful close (`empty_filter`); ids keep their JSON type (string `'listen:1'` and number `7`).

- [ ] **Step 2: Implement** per spec §5.6; audit rows via `audit.queue({ kind: 'mcp.subscription.<event>', principal, client_type: 'mcp', request_id: correlationId, parameters_hash, result_hash, payload })` with `parameters_hash = sha256(canonicalize(payload))` (copy the S15 helper's shape).

- [ ] **Step 3: Gate; commit** — `feat(events): subscription registry with coalescing, limits, overflow, graceful close; lifecycle audit; metrics interface (S17 §5.6, §11, §12)` + trailer.

---

### Task 10: `subscriptions/listen` over Streamable HTTP, retention sweeper, server lifecycle

**Files:**
- Create: `src/api/mcp/listen.ts`, `src/api/events/retention.ts`
- Modify: `src/api/mcp/transport.ts` (route `subscriptions/listen` to the SSE path before `handleModernRequest`), `src/api/mcp/modern.ts` (`subscriptions/listen` reaches `-32601` only when disabled), `src/api/server.ts` (registry + sweeper start/stop; `close()` calls `registry.closeAll('shutdown')` before `server.close`), `src/api/context.ts`
- Test: `src/__tests__/api/mcp-listen.test.ts`

- [ ] **Step 1: Failing tests** (raw `http.request` keeping the response open; parse SSE by splitting on `\n\n`):
  - POST listen with `resourceSubscriptions: ['xinas://events/raid','xinas://events/raid','xinas://events/nfs/sessions','ui://nope','xinas://events/raid?limit=1']` → `200`, `content-type: text/event-stream`, `x-accel-buffering: no`, first event is the ack with `resourceSubscriptions: ['xinas://events/raid','xinas://events/nfs/sessions']` and `_meta.subscriptionId` equal to the request id (test both `'listen:1'` and `9`).
  - Then push an observation through `POST /internal/v1/observed` (internal agent bearer from the inline config) that creates a `raid.state.degraded` → within 1 s an `updated` event with `uri: 'xinas://events/raid'`; a storage transition → nothing on this stream.
  - Unknown field `params.eventTypes` → JSON `-32602`; `notifications` missing → `-32602`; 7 distinct URIs → `-32602 too many resource subscriptions`; `Accept: application/json` only → `406`; no bearer over TCP → `401`; all `ui://`/unknown → ack `{}` then the graceful result and the stream ends.
  - Keep-alive: with `keepalive_ms: 200` in the inline config, a `: keep-alive` comment arrives within 500 ms.
  - Client closes the socket → `registry.activeCount()` returns 0 within 200 ms; journal untouched.
  - Limits: 4 open listeners for one principal, 5th → JSON `-32000` `data.limit: 'principal'`.
  - `handle.close()` with an open listener → the stream receives the result `{ id, result: { resultType: 'complete', _meta } }` then ends.
  - Retention sweeper: inline `cleanup_interval_s: 60` — assert `RetentionSweeper` runs `retentionSweep` on start (spy through `handle.events.journal.count()` after seeding 101 rows with `max_rows: 100`, hmm min is 10 000 — use the unit test on `RetentionSweeper` with an injected journal stub and fake timers instead).

- [ ] **Step 2: Implement** `listen.ts`: `validateListenParams(params) → { filter } | McpProtocolError`; `acceptFilter(filter, providers, identity) → { accepted: Feed[]; ackFilter }`; `openHttpListener(req, res, ...)` sets headers, `res.flushHeaders()`, builds a `ListenerSink` over `res` (`write` returns `res.write(...)`, `pendingCount = res.writableLength / 256` approximation plus the registry's own pending map), arms the keep-alive interval (cleared on close), `res.on('close', () => registry.close(handle, 'client'))`. `transport.ts`: after the modern identity check, `if (msg.method === 'subscriptions/listen') return handleListen(...)`. `retention.ts`: `RetentionSweeper({ journal, policy, intervalMs, metrics })` with `start()`/`stop()`, `unref`, runs once on start.

- [ ] **Step 3: Gate; commit** — `feat(mcp): subscriptions/listen over Streamable HTTP with ack-first SSE, keep-alive, limits and graceful shutdown; journal retention sweeper (S17 §5.1–§5.4, §7.3)` + trailer.

---

### Task 11: stdio adapter SSE demultiplexing

**Files:**
- Modify: `src/mcp-stdio.ts`
- Test: `src/__tests__/api/mcp-stdio-listen.test.ts` (spawn `dist/mcp-stdio.js` after `npm run build`, or import the module's exported `createBridge({ socketPath, stdin, stdout })` factory — refactor the module so `isMain` calls `createBridge` and tests drive it in-process against a real `startServer` on a UNIX socket).

- [ ] **Step 1: Failing tests** — two listen lines `{"id":"listen:1",...raid}` and `{"id":"listen:2",...nfs}` then a `tools/list` line: stdout shows both acks (order irrelevant) each with its own id, and the `tools/list` result is not blocked behind the streams; push a raid event → exactly one stdout line with `subscriptionId: 'listen:1'`; a `notifications/cancelled` line for `listen:1` → no further lines for it (push another raid event, assert only `listen:2`-less silence… the nfs listener does not get raid) and the api's `activeCount()` drops; closing stdin ends the process/bridge with no dangling requests; a pre-ack JSON rejection (7 URIs) is written as one line with the error.

- [ ] **Step 2: Implement** per spec §5.5: `createBridge` returns `{ handleLine(line): void; close(): void }`; listen lines go to `openListen()` which uses `http.request` with `accept: application/json, text/event-stream`, inspects `res.headers['content-type']`, and for SSE feeds chunks through a minimal parser (split on `\n`, accumulate `data:` lines until a blank line, emit `data` join). Track `live: Map<idKey, ClientRequest>` where `idKey = JSON.stringify(id)`.

- [ ] **Step 3: `npm run build && npm run test:e2e` still green (the adapter is used by `client-parity` e2e); gate; commit** — `feat(mcp-stdio): demultiplex subscriptions/listen SSE streams onto stdout, off the serial chain (S17 §5.5, D-19)` + trailer.

---

### Task 12: REST `/events` projection

**Files:**
- Modify: `src/api/routes/events.ts`
- Create: `src/__tests__/contracts/fixtures/Event.json`
- Test: `src/__tests__/api/routes-events.test.ts`

- [ ] **Step 1: Failing tests** (supertest with `buildTestApp({ withEvents: true })`): seed three journal rows across feeds → `GET /events` returns newest first, each row with `event_id`, `ts`, `kind`, `severity`, `message`, `feed`, `sequence`, `cursor`; `?feed=raid` filters; `?severity=error` filters; `?since=<iso>` filters by `detected_at`; `?feed=raid&after=<cursor of row 1>&limit=1` returns ascending from row 2; `?after=` without `feed` → 400 `INVALID_ARGUMENT`; `?limit=501` → 400; a legacy KV row under `/xinas/v1/events/` still appears (merged) — seed one through `state.kv.put`.

- [ ] **Step 2: Implement**; add the `Event.json` fixture (with the additive fields) and run `npm run test:contracts`.

- [ ] **Step 3: Gate; commit** — `feat(api): GET /events projects the operational-event journal with feed, cursor and limit paging (S17 §13)` + trailer.

---

### Task 13: Agent sources — boot id and systemd allow-list

**Files:**
- Modify: `src/agent/probe/inventory.ts` (read `/proc/sys/kernel/random/boot_id`, trimmed; absent → omitted), `src/agent/collectors/inventory.ts` (forward `boot_id`), `src/agent/probe/fixture.ts` (fixture inventory probe: `boot_id` from `inventory.json` when present, else a fixed `00000000-0000-4000-8000-000000000001`), `src/agent/probe/systemd.ts` (`S17_ALLOWLIST_ADDITIONS = ['xinas-nfs-helper.service', 'xiraid-server.service']`)
- Test: `src/__tests__/agent/collectors/inventory.test.ts` (extend), `src/__tests__/agent/probe/systemd.test.ts` (extend; find the existing file names with `ls src/__tests__/agent/**`)

- [ ] **Step 1: Failing tests** — the inventory delta carries `status.boot_id` when the probe returns it and omits it otherwise; the allow-list contains the two units; the fixture inventory probe returns a boot id.

- [ ] **Step 2: Implement; gate; commit** — `feat(agent): observe the boot id and the nfs-helper / xiRAID daemon units for S17 events` + trailer.

---

### Task 14: Wire contract tests and v2-client interop tests

**Files:**
- Create: `src/__tests__/contracts/mcp-wire.test.ts`, `src/__tests__/api/mcp-client-v2.test.ts`

- [ ] **Step 1: Wire contract tests** — load `contracts/mcp/2026-07-28/schema.json` with Ajv (draft 2020-12: `new Ajv2020({ strict: false })` from `ajv/dist/2020.js`), compile `SubscriptionsListenRequest`, `SubscriptionsAcknowledgedNotification`, `ResourceUpdatedNotification`, `SubscriptionsListenResultResponse`, `ListResourcesResult`, `ListResourceTemplatesResult`, `ReadResourceResult`; capture real server output (start a server, open a listen, push an event, read a feed) and assert each message validates; assert the six resources' `uri`, `name`, `mimeType` values byte-exact.

- [ ] **Step 2: Interop tests** with `Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/client` (`versionNegotiation: { mode: 'pin', version: '2026-07-28' }` — check the exact option name in `dist/index.d.mts` `VersionNegotiationOptions`): `getServerCapabilities()` shows `resources.subscribe`; `listResources()` six; `listResourceTemplates()` six; `readResource({ uri })` parses; `client.listen({ resourceSubscriptions: [raidUri] })` resolves with `honoredFilter.resourceSubscriptions` equal to `[raidUri]`; a notification handler registered for `notifications/resources/updated` (find the handler API: `setNotificationHandler(ResourceUpdatedNotification, ...)` or `onNotification`) receives the update with the matching `subscriptionId` after an observation push; the client reads after its cursor and sees the event; `subscription.close()` → `activeCount()` 0; reconnect: close, push an event while closed, re-listen + read after the old cursor → the missed event is returned; two subscriptions on one client carry distinct ids; an unauthorized/unknown URI is absent from `honoredFilter` and indistinguishable from unknown.

- [ ] **Step 3: Gate; commit** — `test(mcp): S17 wire-schema contract tests and @modelcontextprotocol/client 2.0.0 interop suite (S17 §15, SUBS-CLIENT-001)`.

---

### Task 15: End-to-end scenarios

**Files:**
- Create: `src/__tests__/e2e/subscriptions.test.ts` (copy the harness setup from `xiraid-array-create.test.ts`: per-run writable fixture dir, `XINAS_AGENT_PROBE_MODE=fixture:<dir>`, `XINAS_AGENT_XIRAID_POLL_MS=500`, real api + agent processes over UNIX sockets)

- [ ] **Step 1: Scenarios** (one `describe.sequential`): (1) open a raid subscription over the api UNIX socket; (2) write `xiraid-state.json` with an array `state: ['online','initing'], init_progress: 5` → first observation is a baseline → expect `raid.operation.observed_running` in a feed read (not `started`) — then flip to `['online']` and back to `['online','initing']` to get (3) ack-before-update ordering and (4) a feed read returning `raid.operation.started`; (5) open a second subscription on `raid/progress`, bump `init_progress` 5 → 35 → the progress subscriber wakes, the raid subscriber does not; (6) set `['online','initialized']` → `raid.operation.completed` in `raid`; (7) close the raid subscription, set `['degraded']`, re-listen, read after the old cursor → `raid.state.degraded` present; (8) rename `xiraid-state.json` away so the fake transport throws → no `raid.array.removed`, a `system.collector.failed` appears; restore the file → `system.collector.recovered`; (9) edit the fixture `systemd.json` (find its shape in `probe/fixture.ts`) `nfs-server.service` active → failed → `nfs.service.unavailable`, back → `recovered`; (10) edit `nfs-exports.json` add/change/remove a rule → the three export events; (11) edit `filesystems.json` `free_bytes` across 80 % and back below 75 % → `capacity.warning` then `cleared`; (12) two stdio subscriptions through `dist/mcp-stdio.js` → distinct ids on stdout.

- [ ] **Step 2: `npm run build && npm run test:e2e`; commit** — `test(e2e): S17 subscription scenarios over the fixture-mode agent and fake xiRAID (SUBS-TEST-004)`.

---

### Task 16: Docs closure and final gate

**Files:**
- Modify: `docs/control-path/hardware-smoke-runbook.md` (new section "S17 subscriptions — product-client smoke protocol" with the two pending rows), `docs/control-path/s17-mcp-subscriptions-spec.md` (status line → "implemented 2026-09-04 (Phase 1)"; any deviation discovered during implementation recorded inline with the task that forced it), `xiNAS-MCP/src/api/mcp/discover.ts` `INSTRUCTIONS` (already in Task 8).

- [ ] **Step 1: Run every gate** — the TypeScript block (`typecheck`, `lint`, `format:check`, `test`, `test:contracts`, `build`, `test:e2e`), markdownlint, spectral.

- [ ] **Step 2: Commit** — `docs(control-path): S17 runbook smoke protocol; spec status implemented`.

---

## Self-review

- **Spec coverage:** §3 → Task 8; §4 → Task 8; §5.1–§5.4 → Task 10; §5.5 → Task 11; §5.6 → Task 9/10; §6 → Task 2; §7 → Task 1 (+ retention timer Task 10); §8.0–§8.3 → Task 4; §8.4–§8.5 → Task 5; §8.6 → Task 6 + Task 13; §9 → Tasks 8–10 (`reauthorize`, `authorizeEvent` hook in `feeds.ts`); §10 → Task 7; §11 → Task 9; §12 → Task 9; §13 → Task 12; §14 → Tasks 6/10 tests; §15 → Tasks 14/15; §16 → Task 16 (+ `INSTRUCTIONS` sentence, Task 8).
- **Type consistency:** `EventInput`/`EventEnvelope` (Task 1) are consumed by Task 2's `buildEvent` and Task 4's `Emit`; `ResolvedSubscriptionsConfig` (Task 7) is consumed by Tasks 4, 6, 9, 10 — Task 4 lands before Task 7, so Task 4 defines a local `EngineConfig` subset (`progress`, `capacity`, `nfs_lock_threshold`, `stalenessMultiplier`) that Task 7's resolved type structurally satisfies. `EventsContext` (Task 6) gains `registry` in Task 9 (optional field declared in Task 6).
- **Placeholders:** the `journal.ts` sketch leaves method bodies described in prose where the SQL statements above define them exactly; every other step names its concrete inputs and expected outputs.
