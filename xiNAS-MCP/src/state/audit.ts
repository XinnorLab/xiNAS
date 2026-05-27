import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Database, Statement } from 'better-sqlite3';
import type { AuditEntry, AuditEntryInput, QueuedAuditEntry } from './types.js';

/**
 * Compute the genesis hash for a node. The first audit entry's prev_hash
 * is this value when the JSONL is empty / the outbox has no rows.
 */
export function genesisHash(node_id: string): Buffer {
  return createHash('sha256').update(`xinas-audit-genesis-v1-${node_id}`).digest();
}

/**
 * JCS-style canonical JSON: recursive key sort + no whitespace + UTF-8.
 * The hash chain must be deterministic across processes; naive
 * Object.keys(entry).sort() loses nesting and silently breaks the chain
 * on payload changes.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Buffer)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

function chainHash(prev_hash: Buffer, entry: AuditEntry): Buffer {
  return createHash('sha256').update(prev_hash).update(canonicalize(entry), 'utf8').digest();
}

interface OutboxTail {
  hash: Buffer;
}

export class AuditAppender {
  private readonly db: Database;
  private readonly node_id: string;
  private readonly insertOutboxStmt: Statement;
  private readonly insertIndexStmt: Statement;
  private readonly tailHashStmt: Statement;
  /**
   * Tail-hash of the durable JSONL, NOT of the outbox. Set only by
   * `reloadTailHash()` (on startup) and by AuditDrainer's
   * `notifyJsonlAdvanced` after each successful drain. Never written
   * from inside `queue()` — that's how rollback-safety is preserved.
   *
   * Used only when the outbox is empty (everything drained);
   * otherwise `tailHashStmt` reads the live outbox tail.
   */
  private jsonlTail: Buffer | null = null;

  constructor(db: Database, node_id: string) {
    this.db = db;
    this.node_id = node_id;
    this.insertOutboxStmt = db.prepare(
      `INSERT INTO audit_outbox (entry_json, prev_hash, hash, queued_at, drain_state)
       VALUES (?, ?, ?, ?, 'pending')`,
    );
    this.insertIndexStmt = db.prepare(
      `INSERT INTO audit_index (request_id, operation_id, task_id, audit_seq, durable_file, durable_offset)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
    );
    this.tailHashStmt = db.prepare('SELECT hash FROM audit_outbox ORDER BY audit_seq DESC LIMIT 1');
  }

  /**
   * Insert an audit entry into the outbox. Caller invokes this inside
   * the transaction that holds the state change being audited; the
   * outbox insert commits with the state change atomically at the
   * SQLite level.
   *
   * Rollback safety: this method does NOT advance any in-memory tail.
   * If the outer transaction rolls back, the outbox row vanishes and
   * `currentTailHash()` returns the actual durable tail on the next
   * call.
   */
  queue(input: AuditEntryInput): QueuedAuditEntry {
    const entry: AuditEntry = {
      ...input,
      timestamp: Date.now(),
      node_id: this.node_id,
    };
    const prev_hash = this.currentTailHash();
    const hash = chainHash(prev_hash, entry);
    const entry_json = Buffer.from(canonicalize(entry), 'utf8');
    const info = this.insertOutboxStmt.run(entry_json, prev_hash, hash, entry.timestamp);
    const audit_seq = Number(info.lastInsertRowid);
    this.insertIndexStmt.run(
      entry.request_id ?? null,
      entry.operation_id ?? null,
      entry.task_id ?? null,
      audit_seq,
    );
    return { audit_seq, prev_hash, hash };
  }

  /**
   * Reads the live outbox tail. After a rollback the offending row is
   * gone, so the next caller sees the actual committed tail. When the
   * outbox is empty we fall back to the JSONL tail.
   */
  private currentTailHash(): Buffer {
    const row = this.tailHashStmt.get() as OutboxTail | undefined;
    if (row) return row.hash;
    return this.jsonlTail ?? genesisHash(this.node_id);
  }

  /**
   * Called by AuditDrainer after each successful batch so the next
   * queue() with an empty outbox sees the correct tail.
   */
  notifyJsonlAdvanced(hash: Buffer): void {
    this.jsonlTail = hash;
  }

  /**
   * Reload the cached JSONL tail from the last line of the file.
   * Called on startup when the outbox is empty (everything was drained
   * before crash) but the chain must continue. Each JSONL line stores
   * its hash explicitly (per AuditDrainer's append format) so we read
   * the value directly — no canonicalize/recompute needed.
   */
  reloadTailHash(jsonlPath: string): void {
    if (!existsSync(jsonlPath)) {
      this.jsonlTail = genesisHash(this.node_id);
      return;
    }
    const content = readFileSync(jsonlPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      this.jsonlTail = genesisHash(this.node_id);
      return;
    }
    const lastLine = lines[lines.length - 1]!;
    const parsed = JSON.parse(lastLine) as { hash?: string };
    if (typeof parsed.hash !== 'string') {
      throw new Error(
        `audit.jsonl last line is missing 'hash' field; refusing to continue (chain integrity at risk)`,
      );
    }
    this.jsonlTail = Buffer.from(parsed.hash, 'hex');
  }
}
