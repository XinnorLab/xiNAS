import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createFakeBundleHost } from '../../../agent/support/fake-bundle-host.js';
import { makeSupportBundleExecutor } from '../../../agent/task/support-executor.js';
import type { ExecutorContext } from '../../../agent/task/types.js';
import { findSecretLeaks, scrubSecrets } from '../../../lib/health/redact.js';

const root = mkdtempSync(join(tmpdir(), 'xinas-support-exec-'));
const fixtureDir = join(root, 'fixtures');
const bundleDir = join(root, 'bundles');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const RAW_LICENSE = [
  'hwkey: AAAA-RECOVERABLE-KEY-MATERIAL',
  'status: valid',
  'expiration date: 2027-01-01',
  'levels: 5 6',
].join('\n');

function seedFixtures(): void {
  execSync(`mkdir -p ${fixtureDir}`);
  writeFileSync(
    join(fixtureDir, 'journals.json'),
    JSON.stringify({
      'xinas-api.service': 'GET /api/v1/health Authorization: Bearer sk-SUPER-SECRET ok\n',
      'nfs-server.service': 'started\n',
    }),
  );
  writeFileSync(
    join(fixtureDir, 'bundle-configs.json'),
    JSON.stringify({
      '/etc/exports': '/mnt/a *(rw,no_root_squash)\n',
      '/etc/nfs.conf': '[nfsd]\nthreads=64\npassword=hunter2\n',
    }),
  );
  writeFileSync(join(fixtureDir, 'xicli-license.txt'), RAW_LICENSE);
  writeFileSync(join(fixtureDir, 'xicli-raid.json'), '{"arrays": []}');
  writeFileSync(join(fixtureDir, 'snapshots-index.json'), '["snap-1", "snap-2"]');
}

function ctxFor(taskId: string, over: Record<string, unknown> = {}): ExecutorContext {
  return {
    spec: {
      task_id: taskId,
      bundle_dir: bundleDir,
      journal_units: ['xinas-api.service', 'nfs-server.service'],
      config_paths: ['/etc/exports', '/etc/nfs.conf', '/etc/xinas-api/tokens.json'],
      retention: 2,
      ...over,
    },
    emitOutput: () => {},
    isCancelRequested: () => false,
    stash: {},
  };
}

async function runAll(taskId: string): Promise<void> {
  const exec = makeSupportBundleExecutor({ host: createFakeBundleHost(fixtureDir) });
  const ctx = ctxFor(taskId);
  for (const stage of exec.stages) {
    await stage.run(ctx);
  }
}

describe('scrubSecrets / findSecretLeaks', () => {
  it('scrubs bearer + credential assignments; detector agrees', () => {
    const dirty = 'Authorization: Bearer abc123\ntoken=tok-x\npassword: hunter2\nplain line\n';
    const clean = scrubSecrets(dirty);
    expect(clean).not.toContain('abc123');
    expect(clean).not.toContain('tok-x');
    expect(clean).not.toContain('hunter2');
    expect(clean).toContain('plain line');
    expect(findSecretLeaks(dirty).length).toBeGreaterThan(0);
    expect(findSecretLeaks(clean)).toEqual([]);
  });
});

describe('support.bundle executor', () => {
  it('collects, redacts, archives, verifies — parsed-only license, forbidden path refused', async () => {
    seedFixtures();
    // the api-staged half
    execSync(`mkdir -p ${bundleDir}`);
    writeFileSync(
      join(bundleDir, 'task-1.api.json'),
      JSON.stringify({ tasks: [], audit: [], health: { overall: 'ok' } }),
    );

    await runAll('task-1');

    const archive = join(bundleDir, 'task-1.tar.gz');
    expect(existsSync(archive)).toBe(true);
    // work dir + staging file cleaned up
    expect(existsSync(join(bundleDir, 'work-task-1'))).toBe(false);
    expect(existsSync(join(bundleDir, 'task-1.api.json'))).toBe(false);

    const scratch = mkdtempSync(join(root, 'extract-'));
    execSync(`tar -xzf ${archive} -C ${scratch}`);
    const all = execSync(`find ${scratch} -type f`).toString().trim().split('\n');

    // license is PARSED ONLY — the recoverable material appears nowhere
    const licenseJson = readFileSync(join(scratch, 'xiraid', 'license.json'), 'utf8');
    expect(JSON.parse(licenseJson)).toMatchObject({ status: 'active' });
    for (const file of all) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('RECOVERABLE-KEY-MATERIAL');
      expect(text).not.toContain('sk-SUPER-SECRET');
      expect(text).not.toContain('hunter2');
      expect(findSecretLeaks(text)).toEqual([]);
    }
    // the forbidden config path never made it in
    expect(all.some((f) => f.includes('xinas-api_tokens'))).toBe(false);
    // host data present
    expect(readFileSync(join(scratch, 'configs', 'etc_exports'), 'utf8')).toContain('/mnt/a');
    expect(readFileSync(join(scratch, 'journal', 'xinas-api.service.log'), 'utf8')).toContain(
      'Bearer ***',
    );
    expect(JSON.parse(readFileSync(join(scratch, 'snapshots.json'), 'utf8'))).toEqual([
      'snap-1',
      'snap-2',
    ]);
    expect(JSON.parse(readFileSync(join(scratch, 'api', 'api.json'), 'utf8')).health.overall).toBe(
      'ok',
    );
  });

  it('retention prunes oldest beyond the limit', async () => {
    // age the first bundle, add two more (retention: 2)
    utimesSync(join(bundleDir, 'task-1.tar.gz'), new Date(0), new Date(0));
    await runAll('task-2');
    await runAll('task-3');
    expect(existsSync(join(bundleDir, 'task-1.tar.gz'))).toBe(false);
    expect(existsSync(join(bundleDir, 'task-2.tar.gz'))).toBe(true);
    expect(existsSync(join(bundleDir, 'task-3.tar.gz'))).toBe(true);
  });

  it('rollback removes work dir, staging file, and partial archive', async () => {
    const exec = makeSupportBundleExecutor({ host: createFakeBundleHost(fixtureDir) });
    const ctx = ctxFor('task-rb');
    await exec.stages[0]?.run(ctx); // preflight only → work dir exists
    writeFileSync(join(bundleDir, 'task-rb.api.json'), '{}');
    expect(existsSync(join(bundleDir, 'work-task-rb'))).toBe(true);
    await exec.rollback(ctx);
    expect(existsSync(join(bundleDir, 'work-task-rb'))).toBe(false);
    expect(existsSync(join(bundleDir, 'task-rb.api.json'))).toBe(false);
  });
});
