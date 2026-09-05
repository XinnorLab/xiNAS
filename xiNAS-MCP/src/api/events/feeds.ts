/**
 * The six event feeds as an MCP `ResourceProvider` (S17 §4): catalog,
 * cursor templates and the feed read envelope with its cursor/gap rules.
 *
 * Every read runs inside the caller's authorization context (minimum role
 * `viewer`; every Phase 1 subject is viewer-readable on REST, spec §9.2);
 * the result is therefore `cacheScope: private`, and `ttlMs: 0` because a
 * feed is stale the moment it is read.
 */

import { INVALID_PARAMS, McpProtocolError } from '../mcp/confirmation/errors.js';
import {
  type McpResource,
  type McpResourceTemplate,
  type ReadCtx,
  type ReadResourceResult,
  type ResourceProvider,
  feedOfBaseUri,
  parseFeedUri,
} from '../mcp/resources.js';
import type { EventsContext } from './context.js';
import { CursorError, decodeCursor, encodeCursor } from './cursor.js';
import type { EventJournal } from './journal.js';
import { PRODUCER_FAMILIES, type ProducerFamilies } from './schema.js';
import { FEEDS, FEED_MIME, type Feed, type EventEnvelope, feedUri } from './types.js';

const FEED_NAMES: Record<Feed, { name: string; description: string }> = {
  raid: {
    name: 'RAID events',
    description: 'xiRAID array, operation, member, spare, restore, media and license transitions',
  },
  'raid/progress': {
    name: 'RAID progress',
    description: 'Bucketed initialization and reconstruction progress (high-frequency; opt-in)',
  },
  storage: {
    name: 'Storage events',
    description: 'Filesystem mount, read-only, capacity and disk-health transitions',
  },
  nfs: {
    name: 'NFS events',
    description: 'NFS service, export, backing-filesystem and NFS-over-RDMA readiness transitions',
  },
  'nfs/sessions': {
    name: 'NFS session events',
    description:
      'Client session connect/disconnect, protocol and lock-threshold transitions (high-frequency; opt-in; carries client addresses)',
  },
  system: {
    name: 'System events',
    description: 'xiNAS service, agent, collector, network/RDMA link and reboot transitions',
  },
};

export function feedResources(): McpResource[] {
  return FEEDS.map((feed) => ({
    uri: feedUri(feed),
    name: FEED_NAMES[feed].name,
    description: FEED_NAMES[feed].description,
    mimeType: FEED_MIME,
  }));
}

export function feedTemplates(): McpResourceTemplate[] {
  return FEEDS.map((feed) => ({
    uriTemplate: `${feedUri(feed)}{?after,limit}`,
    name: FEED_NAMES[feed].name,
    description: `${FEED_NAMES[feed].description} (cursor read)`,
    mimeType: FEED_MIME,
  }));
}

/** The feed read envelope (spec §4.4). */
export interface FeedReadEnvelope {
  schemaVersion: '1';
  feed: Feed;
  events: EventEnvelope[];
  nextCursor: string;
  oldestAvailableCursor: string;
  headCursor: string;
  hasMore: boolean;
  gap: boolean;
  generatedAt: string;
  producers: ProducerFamilies;
}

export interface GapInfo {
  feed: Feed;
  requestedSequence: number;
  oldestSequence: number | null;
}

/** Hooks `readFeed` calls (no request context). */
export interface FeedReadHooks {
  /** Every read, with its outcome (metrics, spec §12). */
  onRead?(feed: Feed, outcome: 'ok' | 'gap' | 'invalid'): void;
  /** A read that returned `gap: true` (one audit row, spec §11). */
  onGap?(info: GapInfo): void;
  /** Lets the envelope report `nfs.rdma` as not configured. */
  isRdmaConfigured?(): boolean;
}

/** Hooks the provider takes; `onGap` also learns who read (for the audit row). */
export interface FeedProviderHooks {
  onRead?(feed: Feed, outcome: 'ok' | 'gap' | 'invalid'): void;
  onGap?(info: GapInfo, ctx: ReadCtx): void;
  isRdmaConfigured?(): boolean;
}

export interface FeedReadParams {
  after?: string;
  limit?: number;
}

/**
 * Read one feed per the S17 §4.4 table. `S` is the cursor's sequence,
 * `oldest` the smallest retained sequence (any feed), `last` the last
 * allocated one.
 */
export function readFeed(
  journal: EventJournal,
  feed: Feed,
  params: FeedReadParams,
  opts: {
    controllerId: string;
    limitDefault: number;
    limitMax: number;
    now: () => number;
    hooks?: FeedReadHooks;
  },
): FeedReadEnvelope {
  const limit = params.limit ?? opts.limitDefault;
  if (limit > opts.limitMax) {
    opts.hooks?.onRead?.(feed, 'invalid');
    throw new McpProtocolError(INVALID_PARAMS, 'invalid resource uri');
  }
  const { oldest, last } = journal.bounds();
  const cursorAt = (sequence: number): string =>
    encodeCursor({ controllerId: opts.controllerId, feed, sequence });
  const headCursor = cursorAt(last);
  const oldestAvailableCursor = oldest === null ? headCursor : cursorAt(oldest - 1);

  let events: EventEnvelope[];
  let nextCursor: string;
  let hasMore = false;
  let gap = false;

  if (params.after === undefined) {
    events = journal.listLatest(feed, limit);
    const lastRow = events[events.length - 1];
    nextCursor = lastRow !== undefined ? cursorAt(lastRow.sequence) : headCursor;
  } else {
    let sequence: number;
    try {
      ({ sequence } = decodeCursor(params.after, { controllerId: opts.controllerId, feed, last }));
    } catch (err) {
      if (err instanceof CursorError) {
        opts.hooks?.onRead?.(feed, 'invalid');
        throw new McpProtocolError(INVALID_PARAMS, err.message);
      }
      throw err;
    }
    gap = oldest === null ? sequence < last : sequence < oldest - 1;
    const start = gap ? (oldest ?? last) - 1 : sequence;
    events = journal.listAfter(feed, start, limit);
    const lastRow = events[events.length - 1];
    nextCursor = lastRow !== undefined ? cursorAt(lastRow.sequence) : params.after;
    hasMore = lastRow !== undefined ? journal.hasAfter(feed, lastRow.sequence) : false;
    if (gap) opts.hooks?.onGap?.({ feed, requestedSequence: sequence, oldestSequence: oldest });
  }
  opts.hooks?.onRead?.(feed, gap ? 'gap' : 'ok');

  const producers: ProducerFamilies = {
    active: [...PRODUCER_FAMILIES[feed].active],
    inactive: [...PRODUCER_FAMILIES[feed].inactive],
  };
  if (feed === 'nfs' && opts.hooks?.isRdmaConfigured?.() === false) {
    producers.active = producers.active.filter((f) => f !== 'nfs.rdma');
    producers.inactive.push({ family: 'nfs.rdma', reason: 'not_configured' });
  }

  return {
    schemaVersion: '1',
    feed,
    events,
    nextCursor,
    oldestAvailableCursor,
    headCursor,
    hasMore,
    gap,
    generatedAt: new Date(opts.now()).toISOString(),
    producers,
  };
}

/** The `ResourceProvider` the modern handler registers for the feeds. */
export function feedProvider(
  events: EventsContext,
  deps: { now?: () => number; hooks?: FeedProviderHooks } = {},
): ResourceProvider {
  const now = deps.now ?? Date.now;
  const hooksFor = (ctx: ReadCtx): FeedReadHooks => ({
    onRead: (feed, outcome) => deps.hooks?.onRead?.(feed, outcome),
    onGap: (info) => deps.hooks?.onGap?.(info, ctx),
    isRdmaConfigured: () => deps.hooks?.isRdmaConfigured?.() ?? true,
  });
  return {
    list: () => feedResources(),
    templates: () => feedTemplates(),
    owns: (uri) => uri.startsWith('xinas://events/'),
    subscribable: (uri) => feedOfBaseUri(uri) !== null,
    read(uri: string, ctx: ReadCtx): ReadResourceResult {
      const parts = parseFeedUri(uri);
      const envelope = readFeed(
        events.journal,
        parts.feed,
        {
          ...(parts.after !== undefined ? { after: parts.after } : {}),
          ...(parts.limit !== undefined ? { limit: parts.limit } : {}),
        },
        {
          controllerId: events.engine.controllerId,
          limitDefault: events.subscriptions.read_limit_default,
          limitMax: events.subscriptions.read_limit_max,
          now,
          hooks: hooksFor(ctx),
        },
      );
      return {
        resultType: 'complete',
        contents: [{ uri, mimeType: FEED_MIME, text: JSON.stringify(envelope) }],
        ttlMs: 0,
        cacheScope: 'private',
      };
    },
  };
}
