/**
 * Audit query engine (S9 T6, ADR-0011) — over the api's OWN data.
 *
 * Two paths:
 *  - TAIL FILTERS (kind/principal/client_type/since/until/limit): a
 *    bounded newest-first read of the audit jsonl (read-window cap —
 *    full-history scans are out of scope).
 *  - EXACT LOOKUPS (request_id/operation_id/task_id): drain first
 *    (`drainer.drainNow()`), then resolve `audit_index` offsets into
 *    jsonl reads; rows whose offsets are STILL NULL (drain failure)
 *    are served from `audit_outbox` directly — review P1: no window
 *    where a just-written entry is invisible.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ApiContext } from '../context.js';

export interface AuditQuery {
  request_id?: string;
  operation_id?: string;
  task_id?: string;
  kind?: string;
  principal?: string;
  client_type?: string;
  since?: string;
  until?: string;
  limit: number;
}

export interface AuditRow {
  kind?: string;
  timestamp?: string;
  principal?: string;
  client_type?: string;
  request_id?: string;
  operation_id?: string;
  task_id?: string;
  [k: string]: unknown;
}

/** Read at most the LAST `windowBytes` of the jsonl, split into rows. */
export function readTail(path: string, windowBytes = 8 * 1024 * 1024): AuditRow[] {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return [];
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - windowBytes);
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    // a window cut mid-line: drop the partial first line
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const rows: AuditRow[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        rows.push(JSON.parse(line) as AuditRow);
      } catch {
        /* torn line: skip */
      }
    }
    return rows;
  } finally {
    closeSync(fd);
  }
}

function readAt(path: string, offset: number): AuditRow | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8', 0, n);
    const line = text.split('\n')[0];
    if (line === undefined || line.trim().length === 0) return null;
    return JSON.parse(line) as AuditRow;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function matchesFilters(row: AuditRow, q: AuditQuery): boolean {
  if (q.kind !== undefined && row.kind !== q.kind) return false;
  if (q.principal !== undefined && row.principal !== q.principal) return false;
  if (q.client_type !== undefined && row.client_type !== q.client_type) return false;
  if (q.since !== undefined && typeof row.timestamp === 'string' && row.timestamp < q.since) {
    return false;
  }
  if (q.until !== undefined && typeof row.timestamp === 'string' && row.timestamp > q.until) {
    return false;
  }
  return true;
}

export async function queryAudit(ctx: ApiContext, q: AuditQuery): Promise<AuditRow[]> {
  const jsonlPath = ctx.config.state.auditJsonlPath;

  // ── exact lookups ──
  const exactKey =
    q.request_id !== undefined
      ? (['request_id', q.request_id] as const)
      : q.operation_id !== undefined
        ? (['operation_id', q.operation_id] as const)
        : q.task_id !== undefined
          ? (['task_id', q.task_id] as const)
          : null;

  if (exactKey !== null) {
    // backfill offsets for anything pending (review P1)
    try {
      await ctx.state.drainer.drainNow();
    } catch {
      /* drain failure: the outbox fallback below still answers */
    }
    const [column, value] = exactKey;
    const indexRows = ctx.state.db
      .prepare(
        `SELECT audit_seq, durable_file, durable_offset FROM audit_index WHERE ${column} = ? ORDER BY audit_seq DESC LIMIT ?`,
      )
      .all(value, q.limit) as Array<{
      audit_seq: number;
      durable_file: string | null;
      durable_offset: number | null;
    }>;

    const out: AuditRow[] = [];
    for (const idx of indexRows) {
      if (idx.durable_file !== null && idx.durable_offset !== null) {
        const row = readAt(idx.durable_file, idx.durable_offset);
        if (row !== null) {
          out.push(row);
          continue;
        }
      }
      // outbox fallback: offsets still NULL (or the file moved)
      const pending = ctx.state.db
        .prepare('SELECT entry_json FROM audit_outbox WHERE audit_seq = ?')
        .get(idx.audit_seq) as { entry_json: string } | undefined;
      if (pending !== undefined) {
        try {
          out.push(JSON.parse(pending.entry_json) as AuditRow);
        } catch {
          /* skip torn row */
        }
      }
    }
    return out;
  }

  // ── tail filters ──
  const rows = readTail(jsonlPath);
  const filtered: AuditRow[] = [];
  for (let i = rows.length - 1; i >= 0 && filtered.length < q.limit; i -= 1) {
    const row = rows[i] as AuditRow;
    if (matchesFilters(row, q)) filtered.push(row);
  }
  return filtered;
}
