import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  statSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { basename } from 'node:path';
import type { Database, Statement } from 'better-sqlite3';
import type { AuditAppender } from './audit.js';

export interface AuditDrainerOptions {
  path: string;
  rotateBytes?: number; // default 256 MiB (rotation lands in a later PR)
  drainIntervalMs?: number; // default 500
  /**
   * If set, the drainer calls audit.notifyJsonlAdvanced(lastHash)
   * after each successful batch so AuditAppender's currentTailHash
   * fallback (used when the outbox is empty) sees the latest tail.
   * Optional only for tests; production code MUST wire this.
   */
  audit?: AuditAppender;
}

interface PendingRow {
  audit_seq: number;
  entry_json: Buffer;
  prev_hash: Buffer;
  hash: Buffer;
}

interface JsonlLine extends Record<string, unknown> {
  audit_seq: number;
  prev_hash: string;
  hash: string;
}

export class AuditDrainer {
  private readonly db: Database;
  private readonly path: string;
  private readonly rotateBytes: number;
  private readonly drainIntervalMs: number;
  private readonly audit: AuditAppender | undefined;
  private readonly listPendingStmt: Statement;
  private readonly markDurableStmt: Statement;
  private readonly updateIndexStmt: Statement;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Database, opts: AuditDrainerOptions) {
    this.db = db;
    this.path = opts.path;
    this.rotateBytes = opts.rotateBytes ?? 256 * 1024 * 1024;
    this.drainIntervalMs = opts.drainIntervalMs ?? 500;
    this.audit = opts.audit;
    this.listPendingStmt = db.prepare(
      "SELECT audit_seq, entry_json, prev_hash, hash FROM audit_outbox WHERE drain_state = 'pending' ORDER BY audit_seq",
    );
    this.markDurableStmt = db.prepare(
      `UPDATE audit_outbox SET drain_state = 'durable', durable_at = ?, durable_file = ?, durable_offset = ?
       WHERE audit_seq = ?`,
    );
    this.updateIndexStmt = db.prepare(
      'UPDATE audit_index SET durable_file = ?, durable_offset = ? WHERE audit_seq = ?',
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drainNow().catch(() => {
        /* errors surface via metrics/logs in production */
      });
    }, this.drainIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.drainNow();
  }

  /**
   * Per ADR-0003 §Crash recovery, call this on xinas-api start before
   * accepting any requests. It:
   *   1. Scans the JSONL once to build a Map<audit_seq, byte_offset>
   *      so already-persisted rows get recovered with exact offsets.
   *   2. For pending outbox rows whose audit_seq <= JSONL max, runs
   *      the atomic mark-durable transaction — DO NOT re-append.
   *   3. For pending rows whose audit_seq > JSONL max, appends +
   *      fsyncs + atomically marks.
   *   4. Notifies the AuditAppender of the final tail hash.
   */
  async recover(): Promise<void> {
    const { maxSeq, offsetsBySeq, lastHash } = this.scanPersisted();
    const rows = this.listPendingStmt.all() as PendingRow[];

    if (rows.length === 0) {
      if (lastHash) this.audit?.notifyJsonlAdvanced(lastHash);
      return;
    }

    const fileName = basename(this.path);
    const alreadyPersisted = rows.filter((r) => r.audit_seq <= maxSeq);
    const toAppend = rows.filter((r) => r.audit_seq > maxSeq);

    if (alreadyPersisted.length > 0) {
      const marks: { audit_seq: number; file: string; offset: number }[] = [];
      for (const r of alreadyPersisted) {
        const offset = offsetsBySeq.get(r.audit_seq);
        if (offset === undefined) {
          throw new Error(
            `audit chain corrupt: outbox row audit_seq=${r.audit_seq} claims persisted ` +
              `(max=${maxSeq}) but no JSONL entry found; refusing to start`,
          );
        }
        marks.push({ audit_seq: r.audit_seq, file: fileName, offset });
      }
      this.markBatchDurable(marks);
    }

    let tailHash = lastHash;
    if (toAppend.length > 0) {
      tailHash = await this.appendAndMark(toAppend, fileName);
    } else if (alreadyPersisted.length > 0) {
      tailHash = alreadyPersisted[alreadyPersisted.length - 1]!.hash;
    }
    if (tailHash) this.audit?.notifyJsonlAdvanced(tailHash);
  }

  async drainNow(): Promise<void> {
    const rows = this.listPendingStmt.all() as PendingRow[];
    if (rows.length === 0) return;
    const tailHash = await this.appendAndMark(rows, basename(this.path));
    if (tailHash) this.audit?.notifyJsonlAdvanced(tailHash);
  }

  /**
   * Append rows to JSONL, fsync, then mark durable + update index
   * atomically. Crash-after-fsync-before-mark window: recover()
   * detects this via scanPersisted() and skips re-append.
   */
  private async appendAndMark(rows: PendingRow[], fileName: string): Promise<Buffer | null> {
    if (rows.length === 0) return null;
    const fd = openSync(this.path, 'a');
    const marks: { audit_seq: number; file: string; offset: number }[] = [];
    try {
      for (const row of rows) {
        const offset = statSync(this.path).size;
        const entry = JSON.parse(row.entry_json.toString('utf8')) as Record<string, unknown>;
        const line: JsonlLine = {
          audit_seq: row.audit_seq,
          prev_hash: row.prev_hash.toString('hex'),
          hash: row.hash.toString('hex'),
          ...entry,
        };
        const buf = Buffer.from(JSON.stringify(line) + '\n', 'utf8');
        writeSync(fd, buf, 0, buf.length, null);
        fsyncSync(fd);
        marks.push({ audit_seq: row.audit_seq, file: fileName, offset });
      }
    } finally {
      closeSync(fd);
    }
    this.markBatchDurable(marks);
    return rows[rows.length - 1]!.hash;
  }

  private markBatchDurable(marks: { audit_seq: number; file: string; offset: number }[]): void {
    const now = Date.now();
    const run = this.db.transaction(() => {
      for (const m of marks) {
        this.markDurableStmt.run(now, m.file, m.offset, m.audit_seq);
        this.updateIndexStmt.run(m.file, m.offset, m.audit_seq);
      }
    });
    run();
  }

  private scanPersisted(): {
    maxSeq: number;
    offsetsBySeq: Map<number, number>;
    lastHash: Buffer | null;
  } {
    const offsetsBySeq = new Map<number, number>();
    let maxSeq = 0;
    let lastHash: Buffer | null = null;
    if (!existsSync(this.path)) return { maxSeq, offsetsBySeq, lastHash };

    const content = readFileSync(this.path, 'utf8');
    let cursor = 0;
    for (const line of content.split('\n')) {
      if (!line) {
        cursor += 1;
        continue;
      }
      const parsed = JSON.parse(line) as JsonlLine;
      const seq = Number(parsed.audit_seq);
      offsetsBySeq.set(seq, cursor);
      if (seq > maxSeq) maxSeq = seq;
      lastHash = Buffer.from(parsed.hash, 'hex');
      cursor += Buffer.byteLength(line, 'utf8') + 1;
    }
    return { maxSeq, offsetsBySeq, lastHash };
  }
}
