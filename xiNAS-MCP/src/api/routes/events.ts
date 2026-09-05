/**
 * GET /events — the operational-event journal projected in the legacy
 * `Event` shape plus the additive S17 fields (S17 §13, decision D-22).
 *
 * `since` and `severity` keep working; `feed`, `after` (a feed cursor;
 * requires `feed`) and `limit` page forward. Without `after` the newest
 * rows come first; with it the rows after the cursor come ascending, and
 * each row carries its own `cursor` for the next call. Rows the retired
 * `/xinas/v1/events/` KV writer left behind are still served (after the
 * journal rows) for one release.
 */

import { Router } from 'express';
import type { ApiContext } from '../context.js';
import { ApiException } from '../errors.js';
import { CursorError, decodeCursor, encodeCursor } from '../events/cursor.js';
import type { EventJournal } from '../events/journal.js';
import { FEEDS, type EventEnvelope, type Feed, isFeed } from '../events/types.js';
import { listByPrefix, sendOk, unwrapValues } from '../handlers/reads.js';

const LIMIT_MAX = 500;
const LIMIT_DEFAULT = 100;

/** The REST row: legacy fields first, then the additive projection. */
export function toRestEvent(e: EventEnvelope, controllerId: string): Record<string, unknown> {
  return {
    event_id: e.eventId,
    ts: e.detectedAt,
    kind: e.type,
    severity: e.severity,
    message: e.summary,
    related_resources: e.relatedResources ?? [],
    feed: e.feed,
    sequence: e.sequence,
    type: e.type,
    subject: e.subject,
    detected_at: e.detectedAt,
    ...(e.occurredAt !== undefined ? { occurred_at: e.occurredAt } : {}),
    time_accuracy: e.timeAccuracy,
    source: e.source,
    cursor: encodeCursor({ controllerId, feed: e.feed, sequence: e.sequence }),
    ...(e.previous !== undefined ? { previous: e.previous } : {}),
    ...(e.current !== undefined ? { current: e.current } : {}),
    ...(e.operation !== undefined ? { operation: e.operation } : {}),
    ...(e.threshold !== undefined ? { threshold: e.threshold } : {}),
    ...(e.reasonCode !== undefined ? { reason_code: e.reasonCode } : {}),
    ...(e.cause !== undefined ? { cause: e.cause } : {}),
    ...(e.details !== undefined ? { details: e.details } : {}),
  };
}

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

interface Query {
  feed?: Feed;
  after?: string;
  limit: number;
  sinceMs?: number;
  severity?: string;
}

function parseQuery(q: Record<string, unknown>): Query {
  const out: Query = { limit: LIMIT_DEFAULT };
  const feed = firstString(q.feed);
  if (feed !== undefined) {
    if (!isFeed(feed)) throw new ApiException('INVALID_ARGUMENT', `unknown feed '${feed}'`);
    out.feed = feed;
  }
  const after = firstString(q.after);
  if (after !== undefined) {
    if (out.feed === undefined) {
      throw new ApiException('INVALID_ARGUMENT', 'after requires feed');
    }
    out.after = after;
  }
  const limit = firstString(q.limit);
  if (limit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > LIMIT_MAX) {
      throw new ApiException('INVALID_ARGUMENT', `limit must be an integer in [1, ${LIMIT_MAX}]`);
    }
    out.limit = Number(limit);
  }
  const since = firstString(q.since);
  if (since !== undefined) {
    const ms = Date.parse(since);
    if (!Number.isFinite(ms)) {
      throw new ApiException('INVALID_ARGUMENT', 'since must be an RFC 3339 date-time');
    }
    out.sinceMs = ms;
  }
  const severity = firstString(q.severity);
  if (severity !== undefined) out.severity = severity;
  return out;
}

function readJournal(journal: EventJournal, controllerId: string, query: Query): EventEnvelope[] {
  if (query.after !== undefined && query.feed !== undefined) {
    const { last } = journal.bounds();
    let sequence: number;
    try {
      ({ sequence } = decodeCursor(query.after, { controllerId, feed: query.feed, last }));
    } catch (err) {
      if (err instanceof CursorError) throw new ApiException('INVALID_ARGUMENT', 'invalid cursor');
      throw err;
    }
    return journal.listAfter(query.feed, sequence, query.limit);
  }
  const feeds: readonly Feed[] = query.feed !== undefined ? [query.feed] : FEEDS;
  const rows: EventEnvelope[] = [];
  for (const feed of feeds) rows.push(...journal.listLatest(feed, query.limit));
  rows.sort((a, b) => b.sequence - a.sequence);
  return rows.slice(0, query.limit);
}

export function eventsRouter(ctx: ApiContext): Router {
  const r = Router();
  r.get('/events', (req, res) => {
    const query = parseQuery(req.query as Record<string, unknown>);
    const result: Record<string, unknown>[] = [];
    const revisions: number[] = [];

    const journal = ctx.events?.journal;
    if (journal !== undefined) {
      for (const e of readJournal(journal, ctx.config.controller_id, query)) {
        if (query.sinceMs !== undefined && Date.parse(e.detectedAt) < query.sinceMs) continue;
        if (query.severity !== undefined && e.severity !== query.severity) continue;
        result.push(toRestEvent(e, ctx.config.controller_id));
      }
    }

    // Pre-S17 KV rows (agent_state_changed): served unchanged, after the
    // journal rows, only for an unfiltered listing.
    if (query.feed === undefined && query.after === undefined) {
      const legacy = listByPrefix<Record<string, unknown>>(ctx.state, '/xinas/v1/events/');
      for (const row of unwrapValues(legacy)) {
        if (query.severity !== undefined && row.severity !== query.severity) continue;
        if (
          query.sinceMs !== undefined &&
          typeof row.ts === 'string' &&
          Date.parse(row.ts) < query.sinceMs
        ) {
          continue;
        }
        result.push(row);
      }
      revisions.push(...legacy.map((x) => x.revision));
    }

    sendOk(req, res, result, revisions);
  });
  return r;
}
