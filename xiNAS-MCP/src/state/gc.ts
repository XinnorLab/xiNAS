import { mkdirSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { LeaseManager } from './leases.js';

export interface GcOptions {
  taskRetentionDays?: number;   // default 30
  archiveDir?: string;          // default '/var/lib/xinas/state/archive'
  leaseGraceMs?: number;        // additional grace beyond ttl_seconds, default 0
}

export interface GcSweepResult {
  tasks_archived: number;
  tasks_deleted: number;
  leases_removed: number;
  tasks_recovered: number;
}

export class GcSweeper {
  private readonly db: Database;
  private readonly taskRetentionMs: number;
  private readonly archiveDir: string;
  private readonly leases: LeaseManager;

  constructor(db: Database, opts: GcOptions = {}) {
    this.db = db;
    this.taskRetentionMs = (opts.taskRetentionDays ?? 30) * 86400 * 1000;
    this.archiveDir = opts.archiveDir ?? '/var/lib/xinas/state/archive';
    this.leases = new LeaseManager(db);
  }

  /**
   * Per ADR-0003 §Retention, old terminal tasks are archived to
   * compressed JSONL before the rows are pruned. Monthly buckets:
   * tasks-YYYYMM.jsonl.gz under archiveDir.
   */
  async sweepTasks(): Promise<{ archived: number; deleted: number }> {
    const cutoff = Date.now() - this.taskRetentionMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE terminal_at IS NOT NULL AND terminal_at < ?
          ORDER BY terminal_at`,
      )
      .all(cutoff) as Record<string, unknown>[];
    if (rows.length === 0) return { archived: 0, deleted: 0 };

    const archivePath = this.archivePathFor(rows[0]!['terminal_at'] as number);
    mkdirSync(dirname(archivePath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const gz = createGzip();
      const out = createWriteStream(archivePath, { flags: 'a' });
      gz.pipe(out);
      gz.on('error', reject);
      out.on('finish', resolve);
      out.on('error', reject);
      for (const r of rows) {
        gz.write(JSON.stringify(r) + '\n');
      }
      gz.end();
    });

    const ids = rows.map((r) => r['task_id'] as string);
    const placeholders = ids.map(() => '?').join(',');
    const info = this.db
      .prepare(`DELETE FROM tasks WHERE task_id IN (${placeholders})`)
      .run(...ids);
    return { archived: rows.length, deleted: info.changes };
  }

  sweepLeases(): { leases_removed: number; tasks_recovered: number } {
    return this.leases.sweepExpired();
  }

  async sweepAll(): Promise<GcSweepResult> {
    const t = await this.sweepTasks();
    const l = this.sweepLeases();
    return {
      tasks_archived: t.archived,
      tasks_deleted: t.deleted,
      leases_removed: l.leases_removed,
      tasks_recovered: l.tasks_recovered,
    };
  }

  private archivePathFor(epochMs: number): string {
    const d = new Date(epochMs);
    const y = d.getUTCFullYear().toString().padStart(4, '0');
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    return join(this.archiveDir, `tasks-${y}${m}.jsonl.gz`);
  }
}
