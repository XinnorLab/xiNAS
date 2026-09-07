import { mkdirSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { Database, Statement } from 'better-sqlite3';
import { LeaseManager } from './leases.js';
import { TERMINAL_CONFIRMATION_STATUSES } from '../api/mcp/confirmation/types.js';

export interface GcOptions {
  taskRetentionDays?: number; // default 30
  archiveDir?: string; // default '/var/lib/xinas/state/archive'
  leaseGraceMs?: number; // additional grace beyond ttl_seconds, default 0
}

export interface GcSweepResult {
  tasks_archived: number;
  tasks_deleted: number;
  leases_removed: number;
  tasks_recovered: number;
  confirmations_deleted: number;
}

export class GcSweeper {
  private readonly db: Database;
  private readonly taskRetentionMs: number;
  private readonly archiveDir: string;
  private readonly leases: LeaseManager;
  private readonly pruneConfirmationsStmt: Statement;

  constructor(db: Database, opts: GcOptions = {}) {
    this.db = db;
    this.taskRetentionMs = (opts.taskRetentionDays ?? 30) * 86400 * 1000;
    this.archiveDir = opts.archiveDir ?? '/var/lib/xinas/state/archive';
    this.leases = new LeaseManager(db);
    // S15 Task 14 — same terminal-status set and retention window as
    // tasks; imports the ReadonlySet ConfirmationStore.pruneTerminal
    // (api/mcp/confirmation/store.ts) already builds its own identical
    // statement from, so the two never drift.
    const terminalStatusList = Array.from(TERMINAL_CONFIRMATION_STATUSES)
      .map((status) => `'${status}'`)
      .join(', ');
    this.pruneConfirmationsStmt = db.prepare(
      `DELETE FROM mcp_confirmations WHERE status IN (${terminalStatusList}) AND created_at < ?`,
    );
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

  /**
   * S15 Task 14 — prune terminal (declined/cancelled/expired/consumed)
   * mcp_confirmations rows past the same task-retention window. A
   * pending/approved row is never a candidate regardless of age — the
   * confirmation-expiry sweep (`mcp/confirmation/sweeper.ts`) is what
   * moves those to a terminal status in the first place; GC only removes
   * rows already at rest.
   */
  sweepConfirmations(): { confirmations_deleted: number } {
    const cutoff = Date.now() - this.taskRetentionMs;
    const info = this.pruneConfirmationsStmt.run(cutoff);
    return { confirmations_deleted: info.changes };
  }

  async sweepAll(): Promise<GcSweepResult> {
    const t = await this.sweepTasks();
    const l = this.sweepLeases();
    const c = this.sweepConfirmations();
    return {
      tasks_archived: t.archived,
      tasks_deleted: t.deleted,
      leases_removed: l.leases_removed,
      tasks_recovered: l.tasks_recovered,
      confirmations_deleted: c.confirmations_deleted,
    };
  }

  private archivePathFor(epochMs: number): string {
    const d = new Date(epochMs);
    const y = d.getUTCFullYear().toString().padStart(4, '0');
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    return join(this.archiveDir, `tasks-${y}${m}.jsonl.gz`);
  }
}
