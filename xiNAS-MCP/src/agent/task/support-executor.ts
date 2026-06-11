/**
 * support.bundle executor (S7 T7, ADR-0009 §Bundle).
 *
 * Stages:
 *   preflight — work dir under <bundle_dir>/work-<request marker>.
 *   collect   — journals (scrubbed), config copies (scrubbed; the
 *               /etc/xinas-api|agent trees are REFUSED outright),
 *               xiraid (license PARSED ONLY + raid/pool JSON),
 *               snapshot index, the api staging file
 *               (<bundle_dir>/<task_id>.api.json, folded then deleted),
 *               meta.json.
 *   archive   — tar.gz the work dir → <bundle_dir>/<task_id>.tar.gz
 *               (0640, best-effort group hand-off), remove the work dir.
 *   verify    — extract to a temp dir and scan EVERY file with the
 *               leak detector; any hit fails the task (the archive is
 *               deleted — a leaking bundle must not survive).
 *   prune     — keep the newest `retention` bundles.
 *
 * Rollback removes the work dir and any partial archive.
 */

import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { findSecretLeaks, isForbiddenConfigPath, scrubSecrets } from '../../lib/health/redact.js';
import { parseXicliLicense } from '../../lib/parse/xicli-license.js';
import type { BundleHost } from '../support/bundle-host.js';
import type { Executor, ExecutorContext, ExecutorStage } from './types.js';

const JOURNAL_LINES = 2000;

interface BundleSpec {
  task_id: string;
  bundle_dir: string;
  journal_units: string[];
  config_paths: string[];
  retention: number;
}

function narrowSpec(ctx: ExecutorContext): BundleSpec {
  const s = ctx.spec as Partial<BundleSpec> & { task_id?: string };
  if (typeof s.bundle_dir !== 'string' || typeof s.task_id !== 'string') {
    throw new Error('support.bundle: enriched spec missing bundle_dir/task_id');
  }
  return {
    task_id: s.task_id,
    bundle_dir: s.bundle_dir,
    journal_units: s.journal_units ?? [],
    config_paths: s.config_paths ?? [],
    retention: s.retention ?? 3,
  };
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000 }, (err, _o, stderr) => {
      if (err !== null) reject(new Error(`${file} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(p)));
    else out.push(p);
  }
  return out;
}

export function makeSupportBundleExecutor(opts: { host: BundleHost }): Executor {
  const { host } = opts;

  const workDirOf = (spec: BundleSpec): string => join(spec.bundle_dir, `work-${spec.task_id}`);
  const archiveOf = (spec: BundleSpec): string =>
    join(spec.bundle_dir, `${spec.task_id}.tar.gz`);
  const stagingOf = (spec: BundleSpec): string =>
    join(spec.bundle_dir, `${spec.task_id}.api.json`);

  const stages: ExecutorStage[] = [
    {
      name: 'preflight',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx);
        await mkdir(workDirOf(spec), { recursive: true });
        for (const sub of ['journal', 'configs', 'xiraid', 'api']) {
          await mkdir(join(workDirOf(spec), sub), { recursive: true });
        }
        ctx.emitOutput(`work dir ready: ${workDirOf(spec)}`);
      },
    },
    {
      name: 'collect',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx);
        const work = workDirOf(spec);

        for (const unit of spec.journal_units) {
          const text = await host.journalTail(unit, JOURNAL_LINES);
          await writeFile(join(work, 'journal', `${unit}.log`), scrubSecrets(text), 'utf8');
        }
        ctx.emitOutput(`journals: ${spec.journal_units.length} unit(s)`);

        let copied = 0;
        for (const path of spec.config_paths) {
          if (isForbiddenConfigPath(path)) {
            ctx.emitOutput(`REFUSED forbidden config path: ${path}`);
            continue;
          }
          const content = await host.readHostFile(path);
          if (content === null) continue;
          const name = path.replaceAll('/', '_').replace(/^_/, '');
          await writeFile(join(work, 'configs', name), scrubSecrets(content), 'utf8');
          copied += 1;
        }
        ctx.emitOutput(`configs: ${copied} file(s)`);

        // xiRAID: license PARSED ONLY (the raw text is recoverable
        // license material and stays inside this process).
        const licenseText = await host.xicliLicenseText();
        const license = licenseText === null ? null : parseXicliLicense(licenseText);
        await writeFile(
          join(work, 'xiraid', 'license.json'),
          JSON.stringify(license, null, 2),
          'utf8',
        );
        for (const [file, args] of [
          ['raid-show.json', ['raid', 'show', '-f', 'json']],
          ['pool-show.json', ['pool', 'show', '-f', 'json']],
        ] as const) {
          const out = await host.xicliJson([...args]);
          if (out !== null) await writeFile(join(work, 'xiraid', file), out, 'utf8');
        }

        const snapshots = await host.snapshotIndex();
        await writeFile(
          join(work, 'snapshots.json'),
          JSON.stringify(snapshots ?? [], null, 2),
          'utf8',
        );

        // The api-staged half (tasks/audit/state/health) — written by the
        // route between apply and dispatch; the agent has no DB access.
        try {
          const staged = await readFile(stagingOf(spec), 'utf8');
          await writeFile(join(work, 'api', 'api.json'), scrubSecrets(staged), 'utf8');
        } catch {
          ctx.emitOutput('api staging file absent — bundling host data only');
        }

        await writeFile(
          join(work, 'meta.json'),
          JSON.stringify({ task_id: spec.task_id, created_at: new Date().toISOString() }, null, 2),
          'utf8',
        );
      },
    },
    {
      name: 'archive',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx);
        await run('tar', ['-czf', archiveOf(spec), '-C', workDirOf(spec), '.']);
        await chmod(archiveOf(spec), 0o640);
        await rm(workDirOf(spec), { recursive: true, force: true });
        await rm(stagingOf(spec), { force: true });
        ctx.emitOutput(`archive: ${archiveOf(spec)}`);
      },
    },
    {
      name: 'verify',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx);
        const scratch = await mkdtemp(join(tmpdir(), 'xinas-bundle-verify-'));
        try {
          await run('tar', ['-xzf', archiveOf(spec), '-C', scratch]);
          const leaks: string[] = [];
          for (const file of await walkFiles(scratch)) {
            const found = findSecretLeaks(await readFile(file, 'utf8'));
            if (found.length > 0) leaks.push(`${basename(file)}: ${found.length} leak(s)`);
          }
          if (leaks.length > 0) {
            await unlink(archiveOf(spec));
            throw new Error(`redaction verify failed — archive deleted: ${leaks.join('; ')}`);
          }
          ctx.emitOutput('redaction verify clean');
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'prune',
      async run(ctx: ExecutorContext): Promise<void> {
        const spec = narrowSpec(ctx);
        const entries = (await readdir(spec.bundle_dir)).filter((f) => f.endsWith('.tar.gz'));
        const withTimes = await Promise.all(
          entries.map(async (f) => ({
            f,
            mtime: (await stat(join(spec.bundle_dir, f))).mtimeMs,
          })),
        );
        withTimes.sort((a, b) => b.mtime - a.mtime);
        const stale = withTimes.slice(spec.retention);
        for (const { f } of stale) {
          await rm(join(spec.bundle_dir, f), { force: true });
        }
        ctx.emitOutput(`retention: kept ${Math.min(withTimes.length, spec.retention)}, pruned ${stale.length}`);
      },
    },
  ];

  return {
    operation_kind: 'support.bundle',
    stages,
    async rollback(ctx: ExecutorContext): Promise<void> {
      const spec = narrowSpec(ctx);
      await rm(workDirOf(spec), { recursive: true, force: true });
      await rm(stagingOf(spec), { force: true });
      // a verify failure already deleted the archive; cover earlier failures
      await rm(archiveOf(spec), { force: true }).catch(() => {});
    },
  };
}
