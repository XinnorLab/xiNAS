import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HealthBaselineConfig } from '../../../agent/config.js';
import {
  BASELINE_MODULE,
  type BaselineHost,
  type BaselineHostDeps,
  makeBaselineHost,
} from '../../../agent/health/baseline-host.js';

/**
 * S19c T3 — spec §8.3: the engine runs as a capped, sandboxed, read-only
 * subprocess. Every case drives a real child process through a stub
 * "interpreter" (a shell script the config's `python` points at), so the
 * command line, the sanitized environment, the process-group kill and the
 * output caps are observed, not mocked.
 */
describe('BaselineHost', () => {
  let dir: string;
  let profiles: string;
  let quick: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-baseline-'));
    profiles = join(dir, 'profiles');
    mkdirSync(profiles);
    quick = join(profiles, 'quick.yml');
    writeFileSync(quick, 'profile: quick\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A stub interpreter: the script body sees the engine's argv as "$@". */
  const stub = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const host = (
    python: string,
    over: Partial<HealthBaselineConfig> = {},
    deps: BaselineHostDeps = {},
  ): BaselineHost =>
    makeBaselineHost(
      { python, module_root: dir, log_dir: join(dir, 'logs'), profiles_dir: profiles, ...over },
      deps,
    );

  const OK_JSON = '{"metadata":{"profile":"quick"},"overall":"PASS","checks":[]}';

  /** The lines a stub appended to its counter — `[]` when it never ran. */
  const runs = (counter: string): string[] =>
    existsSync(counter)
      ? readFileSync(counter, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
      : [];
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('runs the engine with --json --no-save, cwd module_root, a sanitized env, and returns the report', async () => {
    const argsFile = join(dir, 'args.txt');
    const envFile = join(dir, 'env.txt');
    const cwdFile = join(dir, 'cwd.txt');
    const python = stub(
      'ok.sh',
      `printf '%s\\n' "$@" > ${argsFile}; env > ${envFile}; pwd > ${cwdFile}; printf '%s\\n' '${OK_JSON}'`,
    );
    const r = await host(python).run(quick, 5_000);
    expect(r.status).toBe('success');
    expect(r.report).toEqual(JSON.parse(OK_JSON));
    expect(r.error).toBeUndefined();
    expect(r.engine).toEqual({ module: 'xinas_menu.health.engine', version: null });
    expect(r.collected_at).toMatch(/Z$/);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    // the engine receives the canonical (realpath) profile — the one the allow-list checked
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      '-m',
      BASELINE_MODULE,
      realpathSync(quick),
      join(dir, 'logs'),
      '--json',
      '--no-save',
    ]);
    expect(readFileSync(cwdFile, 'utf8').trim()).toBe(realpathSync(dir));
    const env = Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(env.PYTHONPATH).toBe(dir);
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.PATH).toBeDefined();
    // nothing of the agent's own environment leaks in
    for (const key of ['HOME', 'USER', 'XINAS_AGENT_TOKEN', 'NODE_OPTIONS', 'TMPDIR']) {
      expect(env[key], key).toBeUndefined();
    }
    expect(
      Object.keys(env).filter(
        (k) => !['PATH', 'LANG', 'PYTHONPATH', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(k),
      ),
    ).toEqual([]);
  });

  it('kills the process group with SIGKILL at the timeout and reports the ENGINE timeout', async () => {
    const pidFile = join(dir, 'pid.txt');
    const python = stub('sleep.sh', `echo $$ > ${pidFile}; echo hanging 1>&2; sleep 30 & wait`);
    const started = Date.now();
    const r = await host(python).run(quick, 800);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toMatchObject({ status: 'timeout', report: null, error: { code: 'TIMEOUT' } });
    // The engine's own kill timer fires inside the caller's budget (ENGINE_GRACE_MS),
    // so the ENGINE's typed result reaches the caller — not the queue's bare timeout.
    expect(r.duration_ms).toBeGreaterThan(0);
    expect(r.stderr_tail).toContain('hanging');
    expect(r.error?.message).toMatch(/exceeded .* ms and was killed/);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await delay(100);
    expect(() => process.kill(pid, 0)).toThrow(); // gone, not orphaned
  });

  it('a non-zero exit is error EXIT_<n> with the stderr tail; a missing module is not_supported', async () => {
    const r = await host(stub('exit3.sh', 'echo "boom happened" >&2; exit 3')).run(quick, 5_000);
    expect(r).toMatchObject({ status: 'error', report: null, error: { code: 'EXIT_3' } });
    expect(r.stderr_tail).toContain('boom happened');
    const m = await host(
      stub('nomod.sh', 'echo "/usr/bin/python3: No module named xinas_menu" >&2; exit 1'),
    ).run(quick, 5_000);
    expect(m).toMatchObject({ status: 'not_supported', error: { code: 'MODULE_ABSENT' } });
  });

  it('non-JSON stdout is error PARSE; stdout beyond the cap too', async () => {
    const g = await host(stub('garbage.sh', 'echo not json at all')).run(quick, 5_000);
    expect(g).toMatchObject({ status: 'error', report: null, error: { code: 'PARSE' } });
    const big = await host(
      stub('big.sh', 'head -c 200000 /dev/zero | tr "\\0" x'),
      {},
      {
        stdoutCap: 64 * 1024,
      },
    ).run(quick, 5_000);
    expect(big).toMatchObject({ status: 'error', error: { code: 'PARSE' } });
    expect(big.error?.message).toMatch(/exceeded/);
  });

  it('a missing interpreter is not_supported ENOENT', async () => {
    const r = await host(join(dir, 'no-such-python')).run(quick, 5_000);
    expect(r).toMatchObject({ status: 'not_supported', report: null, error: { code: 'ENOENT' } });
  });

  it('refuses a profile outside profiles_dir — by path or through a symlink — before spawning', async () => {
    const marker = join(dir, 'ran.txt');
    const python = stub('mark.sh', `touch ${marker}; printf '%s\\n' '${OK_JSON}'`);
    const outside = join(dir, 'outside.yml');
    writeFileSync(outside, 'profile: outside\n');
    symlinkSync(outside, join(profiles, 'link.yml'));
    const h = host(python);
    for (const path of [outside, join(profiles, 'link.yml'), join(profiles, '..', 'outside.yml')]) {
      const r = await h.run(path, 5_000);
      expect(r, path).toMatchObject({ status: 'error', error: { code: 'OUTSIDE_PROFILES_DIR' } });
    }
    const missing = await h.run(join(profiles, 'nope.yml'), 5_000);
    expect(missing).toMatchObject({ status: 'error', error: { code: 'PROFILE_NOT_FOUND' } });
    expect(existsSync(marker)).toBe(false);
  });

  it('concurrent callers of the same profile share one run; a different profile is serialized', async () => {
    const counter = join(dir, 'runs.txt');
    const python = stub(
      'slow.sh',
      `echo run >> ${counter}; sleep 0.3; printf '%s\\n' '${OK_JSON}'`,
    );
    const standard = join(profiles, 'standard.yml');
    writeFileSync(standard, 'profile: standard\n');
    const h = host(python);
    const [a, b, c] = await Promise.all([
      h.run(quick, 5_000),
      h.run(quick, 5_000),
      h.run(standard, 5_000),
    ]);
    expect(a).toEqual(b);
    expect(c.status).toBe('success');
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('F10: the result carries the sha256 of the bytes the engine received', async () => {
    const python = stub('echo.sh', 'echo "{}"');
    const h = host(python);
    const first = await h.run(quick, 1_000);
    writeFileSync(quick, 'profile: quick\nexpectations: {net_mtu: 1500}\n');
    const second = await h.run(quick, 1_000);
    expect(first.profile_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.profile_sha256).not.toBe(first.profile_sha256);
  });

  it('sections(): parses the --sections JSON, caches it, and stamps the engine version on later runs', async () => {
    const counter = join(dir, 'sections.txt');
    const python = stub(
      'sections.sh',
      `case "$*" in *--sections*) echo s >> ${counter}; printf '%s\\n' '{"sections":["storage","nfs"],"version":"9.9.9"}';; *) printf '%s\\n' '${OK_JSON}';; esac`,
    );
    const h = host(python);
    const s1 = await h.sections(5_000);
    expect(s1).toMatchObject({ status: 'success', sections: ['storage', 'nfs'], version: '9.9.9' });
    const s2 = await h.sections(5_000);
    expect(s2.sections).toEqual(['storage', 'nfs']);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    const r = await h.run(quick, 5_000);
    expect(r.engine).toEqual({ module: 'xinas_menu.health.engine', version: '9.9.9' });
    const bad = await host(stub('badsec.sh', 'echo "[1,2]"')).sections(5_000);
    expect(bad).toMatchObject({ status: 'error', sections: null, error: { code: 'PARSE' } });
    const none = await host(join(dir, 'no-such-python')).sections(5_000);
    expect(none).toMatchObject({
      status: 'not_supported',
      sections: null,
      error: { code: 'ENOENT' },
    });
  });

  it('F09: a queued caller times out on its own deadline and A-B-A spawns A once', async () => {
    const counter = join(dir, 'runs.txt');
    const b = join(profiles, 'b.yml');
    writeFileSync(b, 'profile: b\n');
    const python = stub(
      'slow.sh',
      `echo run >> ${counter}; sleep 0.2; printf '%s\\n' '${OK_JSON}'`,
    );
    const h = host(python);
    const started = Date.now();
    const p1 = h.run(quick, 1_000);
    const p2 = h.run(b, 50);
    const p3 = h.run(quick, 1_000);
    const r2 = await p2;
    expect(Date.now() - started).toBeLessThan(400);
    expect(r2.status).toBe('timeout');
    expect(r2.error?.code).toBe('TIMEOUT');
    const [r1, r3] = await Promise.all([p1, p3]);
    expect(r1.status).toBe('success');
    expect(r3).toBe(r1);
    // B never spawned: its deadline had passed by the time its turn came.
    expect(runs(counter)).toEqual(['run']);
  });

  it('F09: a joiner keeps its own deadline', async () => {
    const python = stub('slow2.sh', `sleep 0.3; printf '%s\\n' '${OK_JSON}'`);
    const h = host(python);
    const p1 = h.run(quick, 1_000);
    const p2 = h.run(quick, 50);
    expect((await p2).status).toBe('timeout');
    expect((await p1).status).toBe('success');
  });

  it('F09: the queue is bounded', async () => {
    const python = stub('slow3.sh', `sleep 0.2; printf '%s\\n' '${OK_JSON}'`);
    const h = host(python, {}, { maxQueued: 2 });
    const names = ['q1', 'q2', 'q3'].map((n) => {
      const p = join(profiles, `${n}.yml`);
      writeFileSync(p, `profile: ${n}\n`);
      return p;
    });
    const results = await Promise.all([
      h.run(names[0]!, 1_000),
      h.run(names[1]!, 1_000),
      h.run(names[2]!, 1_000),
    ]);
    expect(results.map((r) => r.status)).toEqual(['success', 'success', 'error']);
    expect(results[2]?.error?.code).toBe('QUEUE_FULL');
  });

  it('F09: a joiner with a longer deadline keeps the shared run alive', async () => {
    const counter = join(dir, 'runs.txt');
    const hold = join(profiles, 'hold.yml');
    writeFileSync(hold, 'profile: hold\n');
    // $3 is the profile the engine was handed (argv: -m <module> <profile> …).
    const python = stub(
      'hold.sh',
      `basename "$3" >> ${counter}; sleep 0.3; printf '%s\\n' '${OK_JSON}'`,
    );
    const h = host(python);
    const held = h.run(hold, 5_000); // holds the only engine slot for ~300 ms
    const started = Date.now();
    const short = h.run(quick, 100); // its own deadline passes while queued
    const long = delay(20).then(() => h.run(quick, 2_000)); // joins, with budget to spare
    const rShort = await short;
    expect(Date.now() - started).toBeLessThan(400);
    expect(rShort).toMatchObject({ status: 'timeout', error: { code: 'TIMEOUT' } });
    // The initiator's expired deadline must not cancel the run the joiner still wants.
    expect((await long).status).toBe('success');
    expect((await held).status).toBe('success');
    expect(runs(counter)).toEqual(['hold.yml', 'quick.yml']);
  });

  it('F09: a sequential second run of the same profile spawns again', async () => {
    const counter = join(dir, 'runs.txt');
    const python = stub('twice.sh', `echo run >> ${counter}; printf '%s\\n' '${OK_JSON}'`);
    const h = host(python);
    expect((await h.run(quick, 5_000)).status).toBe('success');
    expect((await h.run(quick, 5_000)).status).toBe('success');
    // The settled run left the pending map: coalescing never outlives a run.
    expect(runs(counter)).toEqual(['run', 'run']);
  });

  it('F09: sections() times out on the caller deadline without spawning', async () => {
    const counter = join(dir, 'sections.txt');
    const python = stub(
      'slowsec.sh',
      `echo s >> ${counter}; sleep 0.5; printf '%s\\n' '{"sections":["storage"],"version":"1.2.3"}'`,
    );
    const started = Date.now();
    const s = await host(python).sections(50);
    expect(Date.now() - started).toBeLessThan(300);
    expect(s).toMatchObject({ status: 'timeout', sections: null, error: { code: 'TIMEOUT' } });
    expect(runs(counter)).toEqual([]);
  });

  it('F09: concurrent sections() callers share one --sections run', async () => {
    const counter = join(dir, 'sections.txt');
    const python = stub(
      'sharedsec.sh',
      `echo s >> ${counter}; sleep 0.2; printf '%s\\n' '{"sections":["storage"],"version":"1.2.3"}'`,
    );
    const h = host(python);
    const [s1, s2] = await Promise.all([h.sections(5_000), h.sections(5_000)]);
    expect(s1).toMatchObject({ status: 'success', sections: ['storage'], version: '1.2.3' });
    expect(s2).toBe(s1);
    expect(runs(counter)).toEqual(['s']);
  });
});
