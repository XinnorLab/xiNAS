import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, 'migrations');

/**
 * Apply all migrations under migrations/ in numeric order. Idempotent —
 * a migration whose version already exists in schema_version is skipped.
 *
 * The schema_version table itself is created by 001-initial.sql, so this
 * runner uses a sqlite_master probe to decide whether to read it.
 */
export function runMigrations(db: Database): void {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{3,}-.*\.sql$/.test(f))
    .sort();

  const hasSchemaTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();

  const applied = new Set<number>();
  if (hasSchemaTable) {
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
    for (const r of rows) applied.add(r.version);
  }

  const apply = db.transaction((file: string, version: number) => {
    const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
    db.exec(sql);
    db.prepare(
      'INSERT OR IGNORE INTO schema_version (version, filename, applied_at) VALUES (?, ?, ?)',
    ).run(version, file, Date.now());
  });

  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    apply(file, version);
  }
}
